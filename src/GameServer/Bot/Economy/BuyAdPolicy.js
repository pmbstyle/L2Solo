const ItemTemplateIndex = require('../../Item/ItemTemplateIndex');
const DataCache = invoke('GameServer/DataCache');
const PurchaseFunding = invoke('GameServer/Bot/Economy/PurchaseFunding');
const { isNativeSource, purchaseWorth } = require('./TradeIntent');
const Diagnostics = require('./EconomyDiagnostics');
const BoardRules = require('../../AfkTrade/BoardRules');
const nativeGoal = goal => isNativeSource(goal?.plan?.sourceType);

function templateFor(selfId) {
    return ItemTemplateIndex.find(DataCache.items, selfId) || null;
}

// A survival item's tranche: its kit cost at the bot's own unit price
// (EconomyContext.kitCost; 0 for any other item and without an economy).
// Decided once with the bid: the plan carries it, executePlan and the native
// bid check reuse it, never a second price.
function survivalCost(economy, selfId) {
    return Math.max(0, Math.round(Number(economy?.kitCost?.(selfId)) || 0));
}
// The money a goal's bids may spend: its funding terms and its tranche.
function goalMoney(state, goal, escrow = 0, economy = null) {
    return PurchaseFunding.spendable(state, escrow,
        { ...PurchaseFunding.goalTerms(goal), survivalCost: survivalCost(economy, goal?.target?.itemId) });
}

// Quantity reviews retain the native line's price unless the prepared
// purchase cap requires a fenced reprice. Size the bid at that actual price,
// with the same root priority and survival tranche as native admission.
function retainedLines(state, lines, owned, town) {
    let money = PurchaseFunding.budget(state);
    const result = [];
    for (const line of lines) {
        const previous = owned.find(row => ['buy_ad', 'shop'].includes(row.kind) && row.storeType === 3 && row.town === town
            && Number(row.selfId) === Number(line.selfId) && Number(row.enchant || 0) === Number(line.enchant || 0));
        const price = previous && withinCap(previous.price, line.purchaseCap)
            ? Number(previous.price) : Number(line.price);
        const available = Math.min(line.intent ? Infinity : money, PurchaseFunding.spendable(state, 0,
            { ...(line.intent ? { r: line.intent.valueRate } : { itemId: line.selfId }), survivalCost: line.survivalCost }));
        const count = Math.min(Number(line.count), Math.floor(available / price));
        if (!(count > 0)) continue;
        if (!line.intent) money -= count * price;
        result.push({ ...line, price, count,
            ...(line.intent ? { intent: { ...line.intent, amount: count, price } } : {}) });
    }
    return result;
}

// Preserve still-needed, funded standing craft lines alongside the newly
// prepared wishes, rather than discarding the whole new batch. Each carried
// line keeps its own current project certificate and its accepted price.
function keepRetainedBids(state, owned, wanted, moneyPrice, escrow = 0) {
    const plan = state.stats?.equipmentPlan;
    if (!(Number(moneyPrice) > 0) || !plan || !owned?.length
        || !(plan.inputPreparation || plan.clanGoal || plan.recipeId
            && (plan.strategy === 'craft' || plan.status === 'deferred' && plan.reason === 'wish_focus'))) return wanted;
    const candidates = owned.filter(line => Number(line.storeType) === 3 && Number(line.count) > 0
        && !Number(line.enchant || 0) && (!wanted.some(row => Number(row.selfId) === Number(line.selfId))
            || wanted.some(row => Number(row.selfId) === Number(line.selfId) && Number(row.count) < Number(line.count))));
    if (!candidates.length) return wanted;
    const needs = require('./TradeIntent').retainedProjectIntents(state, { moneyPrice }, () => 1);
    const output = wanted.slice(), limit = BoardRules.BOT_SHOP_LINES + BoardRules.BOT_RECORDS.buy_ad;
    for (const line of candidates) {
        const need = needs.filter(row => Number(row.itemId) === Number(line.selfId))
            .reduce((best, row) => !best || Number(row.amount) > Number(best.amount) ? row : best, null);
        const count = Math.min(Number(line.count), Number(need?.amount || 0)), price = Number(line.price);
        if (!need || !Number.isSafeInteger(count) || count <= 0 || !Number.isSafeInteger(price) || price <= 0
            || !invoke('GameServer/Items/ItemAcquisitionCatalog').hasSource(line.selfId)
            || count * price > PurchaseFunding.spendable(state, escrow, { r: need.valueRate })) continue;
        const existing = output.findIndex(row => Number(row.selfId) === Number(line.selfId));
        if (existing >= 0 && Number(output[existing].count) >= count) continue;
        if (existing < 0 && output.length >= limit) continue;
        const template = templateFor(Number(line.selfId));
        const carried = { selfId: Number(line.selfId), name: line.name || template?.template?.name || `Item ${line.selfId}`,
            count, price, enchant: 0, slot: Number(template?.etc?.slot || 0), stackable: template?.etc?.stackable === true,
            pricing: line.pricing, intent: { ...need, amount: count, price, valueHours: count * price * Number(moneyPrice) } };
        if (existing >= 0) output[existing] = carried; else output.push(carried);
    }
    return output;
}

function bidFor(state, goal, { money = Infinity, ...options } = {}) {
    // The selected goal already has a native store executor. It cannot re-enter the
    // public projection through a caller's legacy goal fallback.
    if (nativeGoal(goal)) return null;
    const selfId = Number(goal?.target?.itemId || 0);
    const template = templateFor(selfId);
    const basePrice = Number(template?.template?.price || 0);
    const adena = Math.max(0, Number(state?.adena || 0));
    if (!selfId || !template || basePrice <= 0 || adena <= 0
        || !invoke('GameServer/Items/ItemAcquisitionCatalog').hasSource(selfId)) return null;
    // Saved goals/watch rows cannot override the loaded quest classification.
    if (invoke('GameServer/Bot/Economy/ItemDisposition').isQuestItem({ selfId }, template)) return null;
    if (goal.type === 'upgrade_gear' && Number(template.etc?.slot || 0) > 0
        && Number(state?.inventory?.[String(selfId)]?.amount || 0) > 0) return null;

    // `state.adena` already holds the order's escrow (callers add it).
    // A survival item may spend its kit cost from the survival reserve.
    const kit = survivalCost(options.economy, selfId);
    const spendable = Math.min(money, PurchaseFunding.spendable(state, 0,
        { ...PurchaseFunding.goalTerms(goal, selfId), survivalCost: kit }));
    // Older generic equipment goals stored the unscaled template value as
    // their budget: like a reference estimate, it says nothing of the price.
    const legacyEstimate = goal.type === 'upgrade_gear' && !goal.plan?.priceSource
        && !goal.plan?.marketTown && Number(goal.target.adena) === basePrice
        && Number(goal.plan?.estimatedCost) === basePrice;
    const referenceEstimate = goal.plan?.priceSource === 'reference' || legacyEstimate;
    const requestedPrice = referenceEstimate ? 0 : Math.max(0, Number(goal.target.adena || goal.plan?.estimatedCost || 0));
    const requestedCount = goal.type === 'buy_craft_material'
        ? Math.max(1, Math.floor(Number(goal.target.amount) || 1))
        : 1;
    // The bid (group E): the bot's belief of the item and the mirror of its
    // ask; the item is worth its plan's price to it, or its own belief's
    // centre when the plan only estimated; never more than it can spend on
    // one unit: a bot short of the whole amount asks for fewer units.
    const MarketPricing = invoke('GameServer/Bot/Economy/MarketPricing');
    const PriceBelief = invoke('GameServer/Bot/Economy/PriceBelief');
    // Production preparation may pass only the towns used by its recipe.
    // WTB compares all purchases over the wish's completed route table.
    const ctx = invoke('GameServer/Bot/Economy/MarketListingPolicy').traderContext(state, {
        ...options, tripCost: options.economy?.trip || options.tripCost
    });
    let worth = goal.intent?.key && ctx.economy.moneyPrice > 0
        ? purchaseWorth(goal.intent, ctx.economy.moneyPrice)
        : ctx.economy.worth(selfId) ?? requestedPrice;
    if (!(worth > 0)) {
        const belief = PriceBelief.prior(selfId, ctx);
        if (!belief) return null;
        worth = Math.exp(belief.mu);
    }
    const cap = Math.floor(Math.min(worth, spendable));
    const town = options.town || invoke('GameServer/Bot/Economy/MarketTownPolicy').targetTownForItems(state, [{ selfId }]);
    const chosen = MarketPricing.bid(selfId, ctx, { units: requestedCount, worth, cap,
        preferProvidedWorth: goal.intent?.retainedProject === true,
        money: spendable, town,
        rollKey: ['bid', Number(state.characterId || 0), selfId, Number(goal.createdAt || goal.id || 0)] });
    if (!chosen) return null;
    const price = Math.floor(chosen.price);
    const count = Math.min(requestedCount, chosen.count ?? requestedCount, Math.floor(spendable / price));
    if (count <= 0) return null;
    return {
        selfId,
        name: goal.target.itemName || template.template?.name || `Item ${selfId}`,
        kind: template.template?.kind || '',
        rank: template.etc?.rank || 'none',
        price,
        count,
        purchaseCap: Math.min(cap, chosen.purchaseCap ?? Infinity),
        survivalCost: kit,
        pricing: chosen.pricing
    };
}

function linesFor(state, goal, { money = Infinity, watchList, ...options } = {}) {
    const goals = (watchList || require('../Population/ColdEconomyDecision').economyFor(state).watchList).map(row => ({ type: 'buy_craft_material',
        target: { itemId: row.itemId, amount: row.amount },
        intent: row, plan: { estimatedCost: row.worth, purpose: row.kind, valueRate: row.valueRate } }));
    if (!nativeGoal(goal) && !watchList?.some(row => row.key) && goal?.target?.itemId
        && !goals.some(row => row.target.itemId === goal.target.itemId)) goals.unshift(goal);
    const wallet = Number(state.adena || 0);
    // E303: the buy ads cap (shop lines + buy ads) is cut here; the later slices (ColdEconomyPlan.buyBatch, BotAfkMarketService) see at most that.
    const limit = BoardRules.BOT_SHOP_LINES + BoardRules.BOT_RECORDS.buy_ad;
    if (Diagnostics.active()) {
        Diagnostics.count('cap', 'buy_ads', 'check');
        if (goals.length > limit) {
            Diagnostics.count('cap', 'buy_ads', 'cut');
            Diagnostics.count('cap', 'buy_ads', 'dropped', goals.length - limit);
        }
    }
    const owned = options.board?.ownerLines?.(Number(state.characterId)) || [];
    // Distinct wishes can need the same physical item, but the native board
    // allows only one bid per item. Keep their priority and try the next
    // wish only if an earlier one cannot make a bid; duplicates do not use
    // another slot or combine unrelated consent certificates.
    const candidates = [], byItem = new Map();
    for (const goal of goals) {
        const id = Number(goal.target?.itemId);
        if (!(id > 0)) continue;
        let group = byItem.get(id);
        if (!group && candidates.length < limit) {
            group = []; byItem.set(id, group); candidates.push(group);
        }
        if (group) group.push(goal);
    }
    const townFor = options.townFor || (items => invoke('GameServer/Bot/Economy/MarketTownPolicy').targetTownForItems(state, items));
    let town = townFor(candidates.map(group => ({ selfId: Number(group[0].target.itemId) })));
    // Rejected lines can change the grade/town of a mixed order. Price the
    // final town too, before publication; this loop only removes candidates.
    for (let pass = 0; pass <= limit; pass++) {
        const lines = [];
        for (const group of candidates) {
            for (const candidate of group) {
                const bid = bidFor({ ...state, adena: wallet }, candidate, { money: candidate.intent?.key ? Infinity : money, ...options, town });
                if (!bid) continue;
                const item = ItemTemplateIndex.find(DataCache.items, bid.selfId);
                lines.push({ selfId: Number(bid.selfId), name: bid.name, count: Number(bid.count), price: Number(bid.price),
                    enchant: 0, slot: Number(item?.etc?.slot || 0), stackable: item?.etc?.stackable === true, pricing: bid.pricing,
                    purchaseCap: bid.purchaseCap,
                    ...(bid.survivalCost ? { survivalCost: bid.survivalCost } : {}),
                    ...(candidate.intent?.key ? { intent: { ...candidate.intent, price: bid.price, amount: bid.count } } : {}) });
                // Conditional alternatives hold no cash until a native agreement.
                break;
            }
        }
        const retained = retainedLines(state, lines, owned, town);
        if (!retained.length || townFor(retained) === town) return retained;
        const ids = new Set(retained.map(line => line.selfId));
        for (let at = candidates.length - 1; at >= 0; at--) if (!ids.has(Number(candidates[at][0].target.itemId))) candidates.splice(at, 1);
        town = townFor(retained);
    }
    return [];
}

// A held bid price stays while within the prepared purchase cap (no cap = any).
function withinCap(price, cap) {
    return !Number.isFinite(cap) || Number(price) <= cap;
}

module.exports = { survivalCost, goalMoney, bidFor, linesFor, retainedLines, keepRetainedBids, withinCap };
