const ItemTemplateIndex = require('../../Item/ItemTemplateIndex');
const DataCache = invoke('GameServer/DataCache');
const PurchaseFunding = invoke('GameServer/Bot/Economy/PurchaseFunding');
const npcGoal = goal => goal?.plan?.sourceType === 'npc';

function templateFor(selfId) {
    return ItemTemplateIndex.find(DataCache.items, selfId) || null;
}

function bidFor(state, goal, { money = Infinity, ...options } = {}) {
    // The selected goal already has an NPC executor. It cannot re-enter the
    // public projection through a caller's legacy goal fallback.
    if (npcGoal(goal)) return null;
    const selfId = Number(goal?.target?.itemId || 0);
    const template = templateFor(selfId);
    const basePrice = Number(template?.template?.price || 0);
    const adena = Math.max(0, Number(state?.adena || 0));
    if (!selfId || !template || basePrice <= 0 || adena <= 0) return null;
    // Saved goals/watch rows cannot override the loaded quest classification.
    if (invoke('GameServer/Bot/Economy/ItemDisposition').isQuestItem({ selfId }, template)) return null;
    if (goal.type === 'upgrade_gear' && Number(template.etc?.slot || 0) > 0
        && Number(state?.inventory?.[String(selfId)]?.amount || 0) > 0) return null;

    // `state.adena` already holds the order's escrow (callers add it).
    const spendable = Math.min(money, PurchaseFunding.spendable(state, 0,
        goal.plan?.valueRate === undefined ? { itemId: selfId } : { r: goal.plan.valueRate }));
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
    const ctx = invoke('GameServer/Bot/Economy/MarketListingPolicy').traderContext(state, options);
    let worth = goal.intent?.key && ctx.economy.moneyPrice > 0
        ? goal.intent.valueHours / Math.max(1, goal.intent.amount) / ctx.economy.moneyPrice
        : ctx.economy.worth(selfId) ?? requestedPrice;
    if (!(worth > 0)) {
        const belief = PriceBelief.prior(selfId, ctx);
        if (!belief) return null;
        worth = Math.exp(belief.mu);
    }
    const cap = Math.floor(Math.min(worth, spendable));
    const chosen = MarketPricing.bid(selfId, ctx, { units: requestedCount, worth, cap,
        rollKey: ['bid', Number(state.characterId || 0), selfId, Number(goal.createdAt || goal.id || 0)] });
    if (!chosen) return null;
    const price = Math.floor(chosen.price);
    const count = Math.min(requestedCount, Math.floor(spendable / price));
    if (count <= 0) return null;
    return {
        selfId,
        name: goal.target.itemName || template.template?.name || `Item ${selfId}`,
        kind: template.template?.kind || '',
        rank: template.etc?.rank || 'none',
        price,
        count,
        pricing: chosen.pricing
    };
}

function linesFor(state, goal, { money = Infinity, watchList, ...options } = {}) {
    const goals = (watchList || require('../Population/ColdEconomyDecision').economyFor(state).watchList).map(row => ({ type: 'buy_craft_material',
        target: { itemId: row.itemId, amount: row.amount },
        intent: row, plan: { estimatedCost: row.worth, purpose: row.kind, valueRate: row.valueRate } }));
    if (!npcGoal(goal) && !watchList?.some(row => row.key) && goal?.target?.itemId
        && !goals.some(row => row.target.itemId === goal.target.itemId)) goals.unshift(goal);
    const wallet = Number(state.adena || 0);
    const lines = [];
    for (const candidate of goals.slice(0, 3)) {
        const bid = bidFor({ ...state, adena: wallet }, candidate, { money: candidate.intent?.key ? Infinity : money, ...options });
        if (!bid) continue;
        const item = ItemTemplateIndex.find(DataCache.items, bid.selfId);
        lines.push({ selfId: Number(bid.selfId), name: bid.name, count: Number(bid.count), price: Number(bid.price),
            enchant: 0, slot: Number(item?.etc?.slot || 0), stackable: item?.etc?.stackable === true, pricing: bid.pricing,
            ...(candidate.intent?.key ? { intent: { ...candidate.intent, price: bid.price, amount: bid.count } } : {}) });
        // Conditional alternatives hold no cash until a native agreement.
    }
    return lines;
}

module.exports = { bidFor, linesFor };
