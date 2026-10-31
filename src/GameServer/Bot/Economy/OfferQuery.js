// The one offer query (U20): the best sell offer for a buyer, from the board
// (a BoardIndex) and the caller's other sources (NPC shops, the configured
// city merchants), in the one order of OfferOrder (price plus the trip to the
// offer's town, a player before a bot, an NPC last, a stable id). The main
// thread asks it through MarketOpportunity.bestOffer; the planning workers
// over the index they build from the board table. Static code only.
const { SELL, offerFields } = require('../../AfkTrade/BoardIndex');
const OfferOrder = require('./OfferOrder');
const Diagnostics = require('./EconomyDiagnostics');

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
        maxInspected: options.maxInspected,
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
function fill(lines, amount, { npcPrice = 0, money = Infinity, maxPrice = Infinity, excludeOwner = 0,
    accept = null, acceptFill = null } = {}) {
    let left = Math.max(0, Math.floor(Number(amount) || 0));
    let budget = Math.max(0, Number(money));
    const taken = [];
    let cost = 0;
    for (const line of lines || []) {
        if (left <= 0) break;
        const price = Number(line.price);
        if (accept && !accept(line)) continue;
        if (excludeOwner && Number(line.ownerId ?? line.sourceId) === Number(excludeOwner)) continue;
        if (!(price > 0) || price > maxPrice || (npcPrice > 0 && price > npcPrice) || !(Number(line.count) > 0)) continue;
        const count = Math.min(left, Number(line.count), Math.floor(budget / price));
        if (count <= 0) break;
        // Some admission evidence covers this exact fill, not the whole
        // quoted stack or a different remainder after earlier lines.
        if (acceptFill && !acceptFill(line, count)) continue;
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

let shortCalls = 0;
// E303: the quote depth cap of 5 (cheapestTown quoteDepth). Counts the check, and the cut with the lines it
// dropped; returns whether it cut. cap:quotes:short (cheapestTown) is a cut call whose result is not whole;
// of the short calls of callers with pure callbacks (options.sampleWhole: the sample runs accept, cost and
// moneyForTown over every town), one in 64 (`sampled`) is priced again over the whole list, `lost` counts
// those it fills. Developer diagnostics only; its route reads warm the caller's trip cache.
function noteQuoteCut(length, depth) {
    if (!Diagnostics.active()) return false;
    Diagnostics.count('cap', 'quotes', 'check');
    if (length <= depth) return false;
    Diagnostics.count('cap', 'quotes', 'cut');
    Diagnostics.count('cap', 'quotes', 'dropped', length - depth);
    return true;
}

// The town where a buyer gets `amount` units of an item for the least, its
// trip there included (б5, D1; user Q1 A for shots): in each town the board's
// lines there and the NPC shop there as one more offer (fill), plus the
// buyer's round trip (`cost`, OfferOrder.tripCost; 0 for its own town). A
// town that fills the whole amount comes first, then the least landed price
// a unit. options: towns (null: every town with lines or an NPC), npcOffers
// ([{ town, price }]), money, maxPrice, excludeOwner, cost, quoteDepth (only
// the first lines of the item's board list, the ones a trader inspects,
// PriceDecision.QUOTE_DEPTH; each in its own town). Returns { town,
// lines, npc, npcPrice, units, cost, trip, landed } or null. O(T log n + k)
// over the towns with offers.
function cheapestTown(index, selfId, options = {}) {
    const amount = Math.max(1, Math.floor(Number(options.amount) || 1));
    const view = boardView(index, selfId, options);
    const cut = view.inspected ? noteQuoteCut(view.board.length, options.quoteDepth) : false;
    // One pass over the towns, no table: most callers price one amount.
    let best = null;
    for (const town of new Set(options.towns || [...view.listed, ...view.npcPrice.keys()])) {
        if (!town) continue;
        const trip = options.cost ? Number(options.cost(town)) : 0;
        if (!Number.isFinite(trip)) continue;
        best = betterOffer(best, options, amount, town, trip, view.npcPrice.get(town) || 0,
            view.inspected ? view.inspected.get(town) || [] : index ? index.list(selfId, SELL, town) : []);
    }
    return noteShort(index, selfId, options, amount, cut, best);
}

// The board part of a query: the cheapest NPC price per town and, under a
// quote cap, the inspected lines by town. The cap is counted by the pricing
// call (cheapestTown, cheapestIn), once per amount, never by a table build.
function boardView(index, selfId, options) {
    const npcPrice = new Map();
    for (const offer of options.npcOffers || []) {
        const price = Number(offer.price);
        if (offer.town && price > 0 && (!npcPrice.has(offer.town) || price < npcPrice.get(offer.town))) npcPrice.set(offer.town, price);
    }
    const inspected = options.quoteDepth > 0 ? new Map() : null;
    const board = inspected ? index ? index.list(selfId, SELL) : [] : null;
    if (inspected) for (const line of board.slice(0, options.quoteDepth)) {
        if (!inspected.has(line.town)) inspected.set(line.town, []);
        inspected.get(line.town).push(line);
    }
    return { npcPrice, inspected, board, listed: inspected ? inspected.keys() : index ? index.towns(selfId, SELL) : [] };
}

// One town's fill for `amount` against the best so far: a whole fill first,
// then the least landed price a unit, then the town name.
function betterOffer(best, options, amount, town, trip, price, lines) {
    const money = options.moneyForTown ? options.moneyForTown(town, price, lines) : options.money ?? Infinity;
    const filled = fill(lines, amount, {
        npcPrice: price, money, maxPrice: options.maxPrice ?? Infinity,
        excludeOwner: options.excludeOwner, accept: options.accept, acceptFill: options.acceptFill
    });
    if (!filled.units) return best;
    const landed = filled.cost + trip;
    const whole = filled.units >= amount;
    const better = !best || (whole !== best.whole ? whole
        : landed / filled.units < best.landed / best.units || (landed / filled.units === best.landed / best.units
            && String(town).localeCompare(best.town) < 0));
    return better ? { town, ...filled, npcPrice: price, trip, landed, whole, spendBudget: money } : best;
}

function noteShort(index, selfId, options, amount, cut, best) {
    if (cut && !best?.whole) {
        Diagnostics.count('cap', 'quotes', 'short');
        if (options.sampleWhole && Diagnostics.active() && (++shortCalls & 63) === 0) {
            Diagnostics.count('cap', 'quotes', 'sampled');
            if (cheapestTown(index, selfId, { ...options, amount, quoteDepth: 0, sampleWhole: false })?.whole) Diagnostics.count('cap', 'quotes', 'lost');
        }
    }
    return best;
}

// The amount-free part of cheapestTown: each town's trip, NPC price and
// lines, in the query's town order. A buyer that prices one item for several
// amounts within one plan (craft batches 1..64 over one board snapshot) reads
// the board and the trips once and fills each amount from this table.
function townTable(index, selfId, options = {}) {
    const view = boardView(index, selfId, options);
    const rows = [];
    for (const town of new Set(options.towns || [...view.listed, ...view.npcPrice.keys()])) {
        if (!town) continue;
        const trip = options.cost ? Number(options.cost(town)) : 0;
        if (!Number.isFinite(trip)) continue;
        rows.push({ town, trip, price: view.npcPrice.get(town) || 0,
            lines: view.inspected ? view.inspected.get(town) || [] : index ? index.list(selfId, SELL, town) : [] });
    }
    return { index, selfId, options, listed: view.board ? view.board.length : 0, rows };
}

// cheapestTown for `amount` from a townTable. The quote cap is counted per
// call, as one cheapestTown call counts it.
// ARCH-NOTE: PERF the town loop is memoized per table and amount: a craft search prices one input at the same
// amounts again and again (offline, 100 crafters: 71% of cheapestIn calls repeat a (table, amount)), and the
// loop is a pure function of the rows, the options and the amount. The one input that is read live is
// options.accept (a party trade admission): a call compares accept over the table's lines with the outcomes the
// memo was filled under and drops the memo when one differs (the lines are at most the quote depth only because
// the one caller, ColdOccupationSources, passes quoteDepth > 0). The noteQuoteCut and noteShort counts run on every
// call, in the same order. moneyForTown (read per town) is never memoized. Consumers copy `best` and only read its
// lines, so the hits share one result object.
function cheapestIn(table, amount) {
    const options = table.options;
    amount = Math.max(1, Math.floor(Number(amount) || 1));
    const cut = options.quoteDepth > 0 ? noteQuoteCut(table.listed, options.quoteDepth) : false;
    let memo = null;
    if (!options.moneyForTown && !options.acceptFill) {
        memo = table.byAmount ||= new Map();
        if (options.accept) {
            const lines = table.acceptLines ||= table.rows.flatMap(row => row.lines);
            const admitted = lines.map(line => !!options.accept(line));
            if (table.admitted && admitted.some((value, at) => value !== table.admitted[at])) memo.clear();
            table.admitted = admitted;
        }
    }
    let best = memo?.get(amount);
    if (best === undefined) {
        best = null;
        for (const { town, trip, price, lines } of table.rows) best = betterOffer(best, options, amount, town, trip, price, lines);
        memo?.set(amount, best);
    }
    return noteShort(table.index, table.selfId, options, amount, cut, best);
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

module.exports = { bestSellOffer, cheapestTown, townTable, cheapestIn, fill, othersIn };
