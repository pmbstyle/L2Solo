// The one offer query (U20): the best sell offer for a buyer, from the board
// (a BoardIndex) and the caller's other sources (NPC shops, the configured
// city merchants), in the one order of OfferOrder (price plus the trip to the
// offer's town, a player before a bot, an NPC last, a stable id). The main
// thread asks it through MarketOpportunity.bestOffer; the planning workers
// over the index they build from the board table. Static code only.
const { SELL, offerFields } = require('../../AfkTrade/BoardIndex');
const OfferOrder = require('./OfferOrder');

// options: towns (a list; null: every town), excludeOwner (the buyer's own
// records), budget, cost (OfferOrder.tripCost), accept(offer) (the caller's
// own test, such as a minimum price), toOffer(line, town) (the thread's offer
// of a board line; offerFields by default), others (offers of the other
// sources, already in the buyer's towns).
function bestSellOffer(index, selfId, options = {}) {
    const budget = Number.isFinite(Number(options.budget)) ? Number(options.budget) : Infinity;
    const towns = options.towns || null;
    const town = towns?.length === 1 ? towns[0] : null;
    const toOffer = options.toOffer || offerFields;
    const accept = options.accept || null;
    const offers = [];
    // The best line of each town within budget: the lists are in price order,
    // so the trip decides only between towns.
    for (const line of index ? index.heads(selfId, SELL, {
        towns,
        excludeOwner: options.excludeOwner,
        accept: (candidate) => candidate.price <= budget && (!accept || accept(offerFields(candidate, town)))
    }) : []) {
        const offer = toOffer(line, town);
        if (offer) offers.push(offer);
    }
    for (const offer of options.others || []) {
        if (!accept || accept(offer)) offers.push(offer);
    }
    return OfferOrder.best(offers, { budget, cost: options.cost || null });
}

// The other sources a buyer sees in `towns` (null: every town): the
// configured merchants there (or without a town), the NPC shops only in a
// named town.
function othersIn(towns, fixed = [], npc = []) {
    return [
        ...fixed.filter((offer) => !towns || !offer.town || towns.includes(offer.town)),
        ...(towns ? npc.filter((offer) => towns.includes(offer.town)) : [])
    ].filter((offer) => offer.available !== false);
}

module.exports = { bestSellOffer, othersIn };
