'use strict';

// Temporary current-visit lines; the existing NPC owner commits each real
// seller separately. No saved basket, second wallet, or catalogue scan.
const Funding = require('./PurchaseFunding');
const Economy = require('./EconomyContext');
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
function collect(state, options = {}) {
    const town = options.town || state.currentRegion;
    if (!town) return [];
    let current = { ...state, phase: 'cold', inventory: { ...state.inventory } };
    const baskets = new Map();
    let order = 0;
    const add = (selfId, amount, offer, terms = {}, attribution = {}) => {
        if (order >= LIMIT || !offer || offer.town !== town || !(amount > 0)
            || options.seller && sellerKey(offer) !== sellerKey(options.seller)) return;
        const price = Number(offer.price);
        const funding = { ...terms, itemId: Number(selfId),
            survivalCost: Economy.basics(current).kitCost(selfId, price) };
        const cap = attribution.money == null ? Infinity : Math.max(0, Number(attribution.money));
        const template = require('../../Item/ItemTemplateIndex').find(invoke('GameServer/DataCache').items, Number(selfId));
        const maximum = template?.etc?.stackable ? Number.MAX_SAFE_INTEGER : 10000;
        const count = Math.min(maximum, Math.floor(amount), Math.floor(Math.min(cap,
            Funding.spendable(current, 0, funding)) / price));
        if (!(count > 0)) return;
        const key = sellerKey(offer);
        if (!baskets.has(key)) baskets.set(key, { seller: offer, lines: [] });
        const basket = baskets.get(key);
        let line = basket.lines.find(row => row.selfId === Number(selfId));
        if (line && (line.unitPrice !== price || line.amount + count > maximum
            || !Number.isSafeInteger(line.amount + count))) return;
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
    };
    // Preserve the existing survival ordering: potions, escape scroll, work,
    // then shots. Each next shortage and allowance sees the virtual purchase.
    if (options.potions !== false) {
        const Potions = invoke('GameServer/Bot/AI/HealingPotionStock');
        const potion = Potions.purchasePotionFor(current), offer = quoteFor(potion.selfId, town, null, options.seller);
        if (offer) {
            const plan = Potions.restockPlan(current, { potion, unitPrice: offer.price });
            add(potion.selfId, plan.amount, offer);
        }
    }
    if (options.scrolls !== false) {
        const Scrolls = invoke('GameServer/Bot/Travel/ScrollStock');
        const offer = quoteFor(736, town, null, options.seller);
        if (offer) {
            const plan = Scrolls.restockPlan(current, { unitPrice: offer.price });
            add(736, plan.amount, offer);
        }
    }
    for (const extra of (options.extras || []).slice(0, LIMIT)) {
        const offer = extra.offer || quoteFor(extra.selfId, town, extra.unitPrice ?? null, options.seller);
        add(extra.selfId, extra.amount, offer, extra.funding, extra);
    }
    if (options.shots !== false) {
        const Shot = invoke('GameServer/Inventory/ShotStock');
        const shot = Shot.planForState(current), offer = quoteFor(shot.selfId, town, null, options.seller);
        if (offer) {
            const plan = Shot.restockPlan(current, { plan: shot, unitPrice: offer.price, potionUnitPrice: 0 });
            add(shot.selfId, plan.npcAmount, offer);
        }
    }
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
