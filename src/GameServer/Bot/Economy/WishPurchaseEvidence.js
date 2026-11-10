'use strict';
// An observed acquisition, including permitted authored unlimited supply.
// Existing quote order, static source authority and marginal route are reused.
const Query = require('./OfferQuery');
const Production = require('./ProductionPolicy');
const FixedShots = require('./FixedShotOffers');
const ArrowStock = require('../../Inventory/ArrowStock');
const GearMarks = require('../AI/GearMarks');
const unlimited = offer => offer.sourceType === 'npc' || offer.sourceType === 'configured_store';
function reader(state, ctx, deps, { npcOnly = false, town = null } = {}) {
    // Preparation belongs to the existing worker. A reader cannot synchronously
    // expand geometry or treat an unprepared trip as free.
    const cost = deps.tripCost || ctx.trip;
    return id => {
        // A gear errand the bot failed to buy (GearMarks) is no purchase while its mark lasts
        // (until its source changed): no power root or material leaf takes the same buy again.
        if (GearMarks.marked(state.stats, id)) return null;
        // Every wish purchase is sized here: a leaf buys at most these units (Agenda.nextSeller).
        const capacity = ArrowStock.admitted(state, id, Infinity);
        if (!(capacity > 0)) return null;
        if (typeof cost !== 'function' || typeof cost.details !== 'function') return null;
        const others = Production.allowsNpcShot(id) ? (deps.npcOffersFor?.(id) || [])
            .filter(offer => (!npcOnly || offer.sourceType === 'npc') && (!town || offer.town === town)).slice(0, 17) : [];
        if (!npcOnly && Production.allowsFixedShot(id)) others.push(...FixedShots.offers(id));
        // The context's watched board records an absent item as an input too.
        const board = npcOnly ? null : ctx.board || deps.board;
        // A plain item with a known trip, that this bot's buyer takes (OfferQuery.admits).
        const offer = Query.bestSellOffer(board?.heads ? board : null, id, {
            ...(town ? { towns: [town] } : {}),
            excludeOwner: state.characterId, maxInspected: 20, cost, others,
            accept: row => Number(row.price) > 0 && !Number(row.enchant || 0) && row.available !== false
                && Number.isFinite(cost(row.town)) && Query.admits(row, state)
        });
        if (!offer) return null;
        const route = cost.details?.(offer.town);
        if (!route?.known || !Number.isFinite(route.hours) || !Number.isFinite(route.fees)) return null;
        return { price: Number(offer.price), unitPrice: Number(offer.price),
            availableUnits: Math.min(capacity, unlimited(offer) ? Infinity : Query.takeableUnits(offer, state)),
            town: offer.town, sourceType: unlimited(offer) ? offer.sourceType : 'afk', quoted: true,
            tripHours: route?.hours || 0, tripFees: route?.fees || 0 };
    };
}
module.exports = { reader };
