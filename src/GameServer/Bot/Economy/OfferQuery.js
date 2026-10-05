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

// What `amount` units cost from sell lines (best first, the board's order)
// at or under `maxPrice` and no dearer than the NPC (its stock never runs
// out: a dearer line is never taken), then the NPC at `npcPrice` for the
// rest, within `money`: { lines: [{ line, count, price }], npc (units from the NPC),
// units, cost }. One rule for the purchase of a stack (a shot restock,
// materials): ShotStock.restockPlan and cheapestTown.
function fill(lines, amount, { npcPrice = 0, money = Infinity, maxPrice = Infinity, excludeOwner = 0 } = {}) {
    let left = Math.max(0, Math.floor(Number(amount) || 0));
    let budget = Math.max(0, Number(money));
    const taken = [];
    let cost = 0;
    for (const line of lines || []) {
        if (left <= 0) break;
        const price = Number(line.price);
        if (excludeOwner && Number(line.ownerId ?? line.sourceId) === Number(excludeOwner)) continue;
        if (!(price > 0) || price > maxPrice || (npcPrice > 0 && price > npcPrice) || !(Number(line.count) > 0)) continue;
        const count = Math.min(left, Number(line.count), Math.floor(budget / price));
        if (count <= 0) break;
        taken.push({ line, count, price });
        left -= count;
        budget -= count * price;
        cost += count * price;
    }
    const npc = npcPrice > 0 && npcPrice <= maxPrice ? Math.max(0, Math.min(left, Math.floor(budget / npcPrice))) : 0;
    cost += npc * npcPrice;
    let units = npc;
    for (const entry of taken) units += entry.count;
    return { lines: taken, npc, units, cost };
}

// The town where a buyer gets `amount` units of an item for the least, its
// trip there included (б5, D1; user Q1 A for shots): in each town the board's
// lines there and the NPC shop there as one more offer (fill), plus the
// buyer's round trip (`cost`, OfferOrder.tripCost; 0 for its own town). A
// town that fills the whole amount comes first, then the least landed price
// a unit. options: towns (null: every town with lines or an NPC), npcOffers
// ([{ town, price }]), money, maxPrice, excludeOwner, cost. Returns { town,
// lines, npc, npcPrice, units, cost, trip, landed } or null. O(T log n + k)
// over the towns with offers.
function cheapestTown(index, selfId, options = {}) {
    const amount = Math.max(1, Math.floor(Number(options.amount) || 1));
    const npcPrice = new Map();
    for (const offer of options.npcOffers || []) {
        const price = Number(offer.price);
        if (offer.town && price > 0 && (!npcPrice.has(offer.town) || price < npcPrice.get(offer.town))) npcPrice.set(offer.town, price);
    }
    const towns = new Set(options.towns || [...(index ? index.towns(selfId, SELL) : []), ...npcPrice.keys()]);
    let best = null;
    for (const town of towns) {
        if (!town) continue;
        const trip = options.cost ? Number(options.cost(town)) : 0;
        if (!Number.isFinite(trip)) continue;
        const price = npcPrice.get(town) || 0;
        const filled = fill(index ? index.list(selfId, SELL, town) : [], amount, {
            npcPrice: price, money: options.money ?? Infinity, maxPrice: options.maxPrice ?? Infinity,
            excludeOwner: options.excludeOwner
        });
        if (!filled.units) continue;
        const landed = filled.cost + trip;
        const whole = filled.units >= amount;
        const better = !best || (whole !== best.whole ? whole
            : landed / filled.units < best.landed / best.units || (landed / filled.units === best.landed / best.units
                && String(town).localeCompare(best.town) < 0));
        if (better) best = { town, ...filled, npcPrice: price, trip, landed, whole };
    }
    return best;
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

module.exports = { bestSellOffer, cheapestTown, fill, othersIn };
