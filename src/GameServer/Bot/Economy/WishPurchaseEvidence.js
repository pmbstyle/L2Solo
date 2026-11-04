'use strict';
// An observed acquisition, including permitted authored unlimited supply.
// Existing quote order, static source authority and marginal route are reused.
const Query = require('./OfferQuery');
const Production = require('./ProductionPolicy');
const FixedShots = require('./FixedShotOffers');
const ArrowStock = require('../../Inventory/ArrowStock');
const unlimited = offer => offer.sourceType === 'npc' || offer.sourceType === 'configured_store';
function reader(state, ctx, deps, { npcOnly = false, town = null } = {}) {
    // Preparation belongs to the existing worker. A reader cannot synchronously
    // expand geometry or treat an unprepared trip as free.
    const cost = deps.tripCost || ctx.trip;
    return id => {
        // Every wish purchase is sized here: a leaf buys at most these units (Agenda.nextSeller).
        const capacity = ArrowStock.admitted(state, id, Infinity);
        if (!(capacity > 0)) return null;
        if (typeof cost !== 'function' || typeof cost.details !== 'function') return null;
        const others = Production.allowsNpcShot(id) ? (deps.npcOffersFor?.(id) || [])
            .filter(offer => (!npcOnly || offer.sourceType === 'npc') && (!town || offer.town === town)).slice(0, 17) : [];
        if (!npcOnly && Production.allowsFixedShot(id)) others.push(...FixedShots.offers(id));
        // The context's watched board records an absent item as an input too.
        const board = npcOnly ? null : ctx.board || deps.board;
        const offer = Query.bestSellOffer(board?.heads ? board : null, id, {
            ...(town ? { towns: [town] } : {}),
            excludeOwner: state.characterId, maxInspected: 20, cost, others,
            accept: row => Number(row.price) > 0 && !Number(row.enchant || 0)
                && (unlimited(row) || Number.isSafeInteger(Number(row.count)) && Number(row.count) > 0)
                && row.available !== false && Number.isFinite(cost(row.town))
        });
        if (!offer) return null;
        const route = cost.details?.(offer.town);
        if (!route?.known || !Number.isFinite(route.hours) || !Number.isFinite(route.fees)) return null;
        return { price: Number(offer.price), unitPrice: Number(offer.price), availableUnits: Math.min(capacity, unlimited(offer) ? Infinity : Number(offer.count)),
            town: offer.town, sourceType: unlimited(offer) ? offer.sourceType : 'afk', quoted: true,
            tripHours: route?.hours || 0, tripFees: route?.fees || 0 };
    };
}
module.exports = { reader };
