'use strict';

// Temporary current-visit lines; the existing NPC owner commits each real
// seller separately. No saved basket, second wallet, or catalogue scan.
const Funding = require('./PurchaseFunding');
const Economy = require('./EconomyContext');
const Diagnostics = require('./EconomyDiagnostics');
const LIMIT = 12;
const sellerKey = seller => [seller.town, seller.sourceId, seller.locX, seller.locY, seller.locZ].join(':');
function quoteFor(selfId, town, price = null, seller = null) {
    const offers = invoke('GameServer/Bot/Economy/MarketOpportunity').npcOffers(selfId, town);
    let best = null;
    for (const offer of offers) {
        if (!(offer.price > 0) || price !== null && Number(offer.price) !== Number(price)
            || seller && sellerKey(offer) !== sellerKey(seller)) continue;
        if (!best || offer.price < best.price) best = offer;
    }
    return best;
}
function observePlan(state, current, selfId, amount, count, available, offer, attribution, reason) {
    if (!Diagnostics.active()) return;
    const price = Number(offer.price);
    Diagnostics.count('npc_plan', count > 0 ? 'planned' : 'refused', reason);
    if (Diagnostics.enabled(state.characterId)) Diagnostics.push({ owner: Number(state.characterId),
        phase: 'npc_plan', reason, caller: 'NpcRestockPlan', item: Number(selfId),
        requested: amount, planned: count, available, budget: available, wallet: Number(current.adena),
        unitPrice: price, npcId: Number(offer.sourceId), town: offer.town,
        source: attribution.errand?.purpose || attribution.goal?.expectedGoal?.type || 'stock',
        goalRevision: Number(attribution.goal?.updatedAt), errandAt: Number(attribution.errand?.at),
        decisionSeq: Number(state.stats?.decisionSeq), activityLeaf: Number(state.stats?.activityLeaf),
        revision: Number(state.simulation?.revision), wishKey: state.stats?.wishFocus?.[0] });
}
function collect(state, options = {}) {
    const town = options.town || state.currentRegion;
    if (Diagnostics.active()) Diagnostics.count('npc_plan', 'request', 'collect');
    if (!town) return [];
    const started = Diagnostics.active() ? performance.now() : 0;
    let current = { ...state, phase: 'cold', inventory: { ...state.inventory } };
    const Shot = invoke('GameServer/Inventory/ShotStock');
    const Potions = invoke('GameServer/Bot/AI/HealingPotionStock');
    const survivalIds = new Set([736, Shot.planForState(current).selfId, Potions.purchasePotionFor(current).selfId]);
    let preparedState = null, prepared = null;
    const economics = () => {
        if (preparedState !== current) {
            prepared = require('node:worker_threads').isMainThread ? Economy.basics(current) : Economy.forState(current);
            preparedState = current;
        }
        return prepared;
    };
    const baskets = new Map();
    let order = 0;
    const add = (selfId, amount, offer, terms = {}, attribution = {}) => {
        if (order >= LIMIT || !offer || offer.town !== town || !(amount > 0)
            || options.seller && sellerKey(offer) !== sellerKey(options.seller)) return;
        const price = Number(offer.price);
        const funding = { ...terms, itemId: Number(selfId),
            survivalCost: attribution.survivalCost ?? (survivalIds.has(Number(selfId)) ? economics().kitCost(selfId, price) : 0) };
        const cap = attribution.money == null ? Infinity : Math.max(0, Number(attribution.money));
        const template = require('../../Item/ItemTemplateIndex').find(invoke('GameServer/DataCache').items, Number(selfId));
        const maximum = template?.etc?.stackable ? Number.MAX_SAFE_INTEGER : 10000;
        const desired = Math.floor(amount);
        const available = Funding.spendable(current, 0, funding);
        const count = Math.min(maximum, desired, Math.floor(Math.min(cap, available) / price));
        if (!(count > 0)) {
            if (Diagnostics.active()) observePlan(state, current, selfId, amount, 0, available, offer, attribution, 'no_units');
            return;
        }
        const key = sellerKey(offer);
        if (!baskets.has(key)) baskets.set(key, { seller: offer, lines: [] });
        const basket = baskets.get(key);
        let line = basket.lines.find(row => row.selfId === Number(selfId));
        if (line && (line.unitPrice !== price || line.amount + count > maximum
            || !Number.isSafeInteger(line.amount + count))) {
            if (Diagnostics.active()) observePlan(state, current, selfId, amount, 0, available, offer, attribution, 'line_changed');
            return;
        }
        if (Diagnostics.active()) observePlan(state, current, selfId, amount, count, available, offer, attribution,
            count < desired ? 'partial' : 'funded');
        if (!line) {
            line = { selfId: Number(selfId), amount: 0, unitPrice: price, fundingParts: [],
                autoEquip: attribution.autoEquip === true, errands: [] };
            basket.lines.push(line);
        }
        line.amount += count;
        line.fundingParts.push({ amount: count, funding, order: order++ });
        if (attribution.errand) line.errands.push({ errand: attribution.errand, units: count, spent: count * price });
        if (attribution.goal) line.goal = { ...attribution.goal, units: count };
        current.adena = Math.max(0, Number(current.adena || 0) - count * price);
        current.inventory[selfId] = { ...current.inventory[selfId], selfId: Number(selfId),
            amount: Number(current.inventory[selfId]?.amount || 0) + count };
        current.inventory[57] = { ...current.inventory[57], selfId: 57, amount: current.adena };
        current.stats = { ...current.stats, money: Funding.packetAfterPurchase(current.stats?.money, count * price, funding) };
        preparedState = null; prepared = null;
    };
    // Preserve the existing survival ordering: potions, escape scroll, work,
    // then shots. Each next shortage and allowance sees the virtual purchase.
    if (options.potions !== false) {
        const potion = Potions.purchasePotionFor(current), offer = quoteFor(potion.selfId, town, null, options.seller);
        if (offer) {
            const context = economics();
            const plan = Potions.restockPlan(current, { potion, unitPrice: offer.price, context });
            add(potion.selfId, plan.amount, offer, {}, { survivalCost: context.kitCost(potion.selfId, offer.price) });
        }
    }
    if (options.scrolls !== false) {
        const Scrolls = invoke('GameServer/Bot/Travel/ScrollStock');
        const offer = quoteFor(736, town, null, options.seller);
        if (offer) {
            const context = economics();
            const plan = Scrolls.restockPlan(current, { unitPrice: offer.price, context });
            add(736, plan.amount, offer, {}, { survivalCost: context.kitCost(736, offer.price) });
        }
    }
    for (const extra of (options.extras || []).slice(0, LIMIT)) {
        const offer = extra.offer || quoteFor(extra.selfId, town, extra.unitPrice ?? null, options.seller);
        add(extra.selfId, extra.amount, offer, extra.funding, extra);
    }
    if (options.shots !== false) {
        const shot = Shot.planForState(current), offer = quoteFor(shot.selfId, town, null, options.seller);
        if (offer) {
            const context = economics();
            const plan = Shot.restockPlan(current, { plan: shot, unitPrice: offer.price, potionUnitPrice: 0, context });
            add(shot.selfId, plan.npcAmount, offer, {}, { survivalCost: context.kitCost(shot.selfId, offer.price) });
        }
    }
    if (Diagnostics.active()) Diagnostics.duration('npc_plan', performance.now() - started);
    return [...baskets.values()];
}
async function purchase(state, options = {}) {
    let current = state;
    const receipts = [];
    for (const basket of collect(state, options)) {
        const bought = await require('./NpcPurchaseBasket').purchase(current, basket);
        receipts.push(bought);
        current = bought.state || current;
        if (bought.hot) break;
    }
    return { state: current, receipts };
}
async function purchaseForActor(actor, options = {}) {
    const context = Economy.forActor(actor);
    let statsPacket = context.statsPacket;
    const state = Economy.stateForActor(actor);
    state.stats = { ...state.stats, ...context.statsPacket };
    const receipts = [];
    for (const basket of collect(state, options)) {
        const bought = await require('./NpcPurchaseBasket').purchaseForActor(actor, {
            ...basket, statsPacket });
        receipts.push(bought);
        if (bought.state?.stats?.money) statsPacket = { ...statsPacket, money: bought.state.stats.money };
        if (bought.hot === false || !bought.ok || actor.session?.actor !== actor) break;
    }
    return { ok: receipts.every(row => row.ok), receipts,
        units: receipts.reduce((sum, row) => sum + Number(row.units || 0), 0),
        spent: receipts.reduce((sum, row) => sum + Number(row.spent || 0), 0) };
}
module.exports = { LIMIT, sellerKey, quoteFor, collect, purchase, purchaseForActor };
