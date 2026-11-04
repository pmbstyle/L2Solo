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
function takeable(line, { npcPrice = 0, maxPrice = Infinity, excludeOwner = 0 }) {
    const price = Number(line.price);
    return !(excludeOwner && Number(line.ownerId ?? line.sourceId) === Number(excludeOwner))
        && price > 0 && price <= maxPrice && !(npcPrice > 0 && price > npcPrice) && Number(line.count) > 0;
}
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
        if (!takeable(line, { npcPrice, maxPrice, excludeOwner })) continue;
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

let pastDepth = 0;

// The town where a buyer gets `amount` units of an item for the least, its
// trip there included (б5, D1; user Q1 A for shots): in each town the board's
// lines there and the NPC shop there as one more offer (fill), plus the
// buyer's round trip (`cost`, OfferOrder.tripCost; 0 for its own town). A
// town that fills the whole amount comes first, then the least landed price
// a unit. options: towns (null: every town with lines or an NPC), npcOffers
// ([{ town, price }]), money, maxPrice, excludeOwner, cost, quoteDepth (the
// first lines of the item's board list a trader inspects,
// PriceDecision.QUOTE_DEPTH, and on until one town holds the amount: a player
// scrolls the list until the sum is there, decision 11-02; each line in its
// own town). Returns { town,
// lines, npc, npcPrice, units, cost, trip, landed } or null. O(T log n + k)
// over the towns with offers.
function cheapestTown(index, selfId, options = {}) {
    const amount = Math.max(1, Math.floor(Number(options.amount) || 1));
    const view = boardView(index, selfId, options, amount);
    // One pass over the towns, no table: most callers price one amount.
    let best = null;
    for (const town of new Set(options.towns || [...view.listed, ...view.npcPrice.keys()])) {
        if (!town) continue;
        const trip = options.cost ? Number(options.cost(town)) : 0;
        if (!Number.isFinite(trip)) continue;
        best = betterOffer(best, options, amount, town, trip, view.npcPrice.get(town) || 0,
            view.inspected ? view.inspected.get(town) || [] : index ? index.list(selfId, SELL, town) : []);
    }
    if (best?.whole && view.read > options.quoteDepth) pastDepth++;
    return best;
}

// The board part of a query: the cheapest NPC price per town and, under a
// quote cap, the inspected lines by town.
function boardView(index, selfId, options, amount = 0) {
    const npcPrice = new Map();
    for (const offer of options.npcOffers || []) {
        const price = Number(offer.price);
        if (offer.town && price > 0 && (!npcPrice.has(offer.town) || price < npcPrice.get(offer.town))) npcPrice.set(offer.town, price);
    }
    const inspected = options.quoteDepth > 0 ? new Map() : null;
    const board = inspected ? index ? index.list(selfId, SELL) : [] : null;
    // Only a town the query names counts, and an NPC shop there never runs out:
    // it already answers the amount.
    const maxPrice = options.maxPrice ?? Infinity;
    const named = town => town && (!options.towns || options.towns.includes(town))
        && (!options.cost || Number.isFinite(Number(options.cost(town))));
    let met = !amount || [...npcPrice].some(([town, price]) => named(town) && price <= maxPrice), read = 0;
    const held = new Map();
    if (inspected) for (const line of board) {
        if (read >= options.quoteDepth && (met || Number(line.price) > maxPrice)) break;
        read++;
        if (!inspected.has(line.town)) inspected.set(line.town, []);
        inspected.get(line.town).push(line);
        if (met || !named(line.town) || !takeable(line, { maxPrice, excludeOwner: options.excludeOwner })
            || options.accept && !options.accept(line)) continue;
        const before = held.get(line.town) || 0;
        if (options.acceptFill && !options.acceptFill(line, Math.min(Number(line.count), amount - before))) continue;
        const units = before + Number(line.count);
        held.set(line.town, units);
        met = units >= amount;
    }
    return { npcPrice, inspected, board, read, listed: inspected ? inspected.keys() : index ? index.towns(selfId, SELL) : [] };
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

// The dearest unit of a plan, its cap at the purchase: the mean would refuse
// the plan's own dearer lines.
function topPrice(plan) {
    let top = Number(plan?.npc) > 0 ? Number(plan.npcPrice) || 0 : 0;
    for (const { price } of plan?.lines || []) top = Math.max(top, Number(price));
    return top;
}

// The amount-free part of cheapestTown: each town's trip, NPC price and
// lines, in the query's town order. A buyer that prices one item for several
// amounts within one plan (craft batches 1..64 over one board snapshot) reads
// the board and the trips once and fills each amount from this table.
function townTable(index, selfId, options = {}) {
    const view = boardView(index, selfId, options);
    return { index, selfId, options, rows: townRows(index, selfId, options, view),
        board: view.board, depthRead: view.read, lines: view.board?.slice(0, view.read) || [] };
}
function townRows(index, selfId, options, view) {
    const rows = [];
    for (const town of new Set(options.towns || [...view.listed, ...view.npcPrice.keys()])) {
        if (!town) continue;
        const trip = options.cost ? Number(options.cost(town)) : 0;
        if (!Number.isFinite(trip)) continue;
        rows.push({ town, trip, price: view.npcPrice.get(town) || 0,
            lines: view.inspected ? view.inspected.get(town) || [] : index ? index.list(selfId, SELL, town) : [] });
    }
    return rows;
}
// The rows of an amount whose asks had to be read past the depth (cheapestTown's
// read), which only a memo miss pays; null: the table's own rows answer it.
function rowsPastDepth(table, amount) {
    if (!table.board) return null;
    const view = boardView(table.index, table.selfId, table.options, amount);
    if (view.read <= table.depthRead) return null;
    if (view.read > table.lines.length) {
        table.lines = view.board.slice(0, view.read);
        if (table.admitted) table.admitted = table.lines.map(line => !!table.options.accept(line));
    }
    return townRows(table.index, table.selfId, table.options, view);
}

// cheapestTown for `amount` from a townTable.
// ARCH-NOTE: PERF the town loop is memoized per table and amount: a craft search prices one input at the same
// amounts again and again (offline, 100 crafters: 71% of cheapestIn calls repeat a (table, amount)), and the
// loop is a pure function of the rows, the options and the amount. The one input that is read live is
// options.accept (a party trade admission): a call compares accept over the lines the memo read so far with the
// outcomes it was filled under and drops the memo when one differs (the one caller, ColdOccupationSources, passes
// quoteDepth > 0: the lines are the first of the board list). moneyForTown (read per town) is never memoized. Consumers copy `best` and only read its
// lines, so the hits share one result object.
function cheapestIn(table, amount) {
    const options = table.options;
    amount = Math.max(1, Math.floor(Number(amount) || 1));
    let memo = null;
    if (!options.moneyForTown && !options.acceptFill) {
        memo = table.byAmount ||= new Map();
        if (options.accept) {
            const admitted = table.lines.map(line => !!options.accept(line));
            if (table.admitted && table.admitted.some((value, at) => value !== admitted[at])) memo.clear();
            table.admitted = admitted;
        }
    }
    let best = memo?.get(amount);
    if (best === undefined) {
        best = null;
        const deep = rowsPastDepth(table, amount);
        for (const { town, trip, price, lines } of deep || table.rows) best = betterOffer(best, options, amount, town, trip, price, lines);
        if (best?.whole && deep) pastDepth++;
        memo?.set(amount, best);
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

module.exports = { bestSellOffer, cheapestTown, townTable, cheapestIn, fill, topPrice, othersIn, pastDepthCount: () => pastDepth };
