'use strict';
// A finite observed acquisition, never a positive-price supply forecast.
// Existing quote order, static NPC authority and marginal route are reused.
const Query = require('./OfferQuery');
const Production = require('./ProductionPolicy');
function reader(state, ctx, deps) {
    // Preparation belongs to the existing worker. A reader cannot synchronously
    // expand geometry or treat an unprepared trip as free.
    const cost = deps.tripCost || ctx.trip;
    return id => {
        if (typeof cost !== 'function' || typeof cost.details !== 'function') return null;
        const others = Production.allowsNpcShot(id) ? (deps.npcOffersFor?.(id) || []).slice(0, 17) : [];
        // The context's watched board records an absent item as an input too.
        const board = ctx.board || deps.board;
        const offer = Query.bestSellOffer(board?.heads ? board : null, id, {
            excludeOwner: state.characterId, maxInspected: 20, cost, others,
            accept: row => Number(row.price) > 0 && !Number(row.enchant || 0)
                && (row.sourceType === 'npc' || Number.isSafeInteger(Number(row.count)) && Number(row.count) > 0)
                && row.available !== false && Number.isFinite(cost(row.town))
        });
        if (!offer) return null;
        const route = cost.details?.(offer.town);
        if (!route?.known || !Number.isFinite(route.hours) || !Number.isFinite(route.fees)) return null;
        return { price: Number(offer.price), unitPrice: Number(offer.price), availableUnits: offer.sourceType === 'npc' ? Infinity : Number(offer.count),
            town: offer.town, sourceType: offer.sourceType === 'npc' ? 'npc' : 'afk', quoted: true,
            tripHours: route?.hours || 0, tripFees: route?.fees || 0 };
    };
}
module.exports = { reader };
