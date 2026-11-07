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
function forecast(selfId, town, { board, ownerId = 0, timestamp = Date.now() } = {}) {
    const history = History.forecast(selfId, town, timestamp);
    const quoted = town ? interest(selfId, town, board, ownerId, timestamp) : null;
    if (!history || !quoted) return history || quoted;
    // Two observations of the same market are alternatives, never added:
    // its historical customers may be the authors of today's public bids.
    return { ...history, origin: 'public_market_demand', alternatives: [history, quoted],
        applicableUnits: Math.max(history.applicableUnits, quoted.applicableUnits), delayHours: 0 };
}
function towns(selfId, board, timestamp = Date.now()) {
    return [...new Set([...History.towns(selfId, timestamp), ...(board?.demandTowns?.(selfId) || [])])];
}
module.exports = { interest, forecast, towns };
