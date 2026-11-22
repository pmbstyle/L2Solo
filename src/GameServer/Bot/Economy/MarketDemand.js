'use strict';
const History = require('./MarketTradeDemand');
const { quantities } = require('../../AfkTrade/BuyInterestIndex');

// Frozen public price curves, never foreign wallets, bags or intentions.
// The callback captures only its scalar snapshot, not a bot/economy graph.
function interest(selfId, town, board, excludeOwner, timestamp = Date.now()) {
    const view = board?.demandSnapshot?.(selfId, town, excludeOwner);
    const total = quantities(view, 1);
    if (!total) return null;
    const forecast = { known: true, selfId: Number(selfId), enchant: 0, town,
        origin: 'public_buy_interest', authority: { selfId: Number(selfId), revision: view.revision },
        ...total, delayHours: 0,
        observedAt: timestamp, availability: { from: timestamp, until: timestamp },
        guaranteed: false, repeatable: false };
    Object.defineProperty(forecast, 'atPrice', { value: price => quantities(view, price) });
    return forecast;
}
// plans: a reader (selfId, town) => units of the bots' funded purchase plans in town
// (PlanDemand.units on main; only the crafter restock passes it, so every other
// reader on either thread sees the public market alone).
function forecast(selfId, town, { board, ownerId = 0, timestamp = Date.now(), plans = null } = {}) {
    const history = History.forecast(selfId, town, timestamp);
    const quoted = town ? interest(selfId, town, board, ownerId, timestamp) : null;
    const market = !history || !quoted ? history || quoted
        // Two observations of the same market are alternatives, never added:
        // its historical customers may be the authors of today's public bids.
        : { ...history, origin: 'public_market_demand', alternatives: [history, quoted],
            applicableUnits: Math.max(history.applicableUnits, quoted.applicableUnits), delayHours: 0 };
    const planned = town && plans ? Math.floor(Number(plans(selfId, town)) || 0) : 0;
    if (!(planned > 0)) return market;
    // The planning bots may be the same customers (their bids, their next deals):
    // an alternative as well, never added.
    const own = { known: true, selfId: Number(selfId), enchant: 0, town, origin: 'funded_plans',
        applicableUnits: planned, delayHours: 0, observedAt: timestamp,
        availability: { from: timestamp, until: timestamp }, guaranteed: false, repeatable: false };
    if (!market) return own;
    return { ...market, alternatives: [...(market.alternatives || [market]), own],
        applicableUnits: Math.max(market.applicableUnits, planned), delayHours: 0 };
}
function towns(selfId, board, timestamp = Date.now()) {
    return [...new Set([...History.towns(selfId, timestamp), ...(board?.demandTowns?.(selfId) || [])])];
}
module.exports = { interest, forecast, towns };
