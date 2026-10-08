const { SELL } = require('../../AfkTrade/BoardIndex');
const Funding = require('../Economy/PurchaseFunding');
const Diagnostics = require('../Economy/EconomyDiagnostics');
const { fnv1a32 } = require('../Fnv1a');
const MAX_BYTES = 768;
const MAX_SHOT_BYTES = 128;
const { COMMAND_HEADER_BYTES, MAX_SHOT_PAYLOAD_BYTES } = require('./ColdEconomyDecision');
const MAX_PLAN_PAYLOAD_BYTES = MAX_BYTES - COMMAND_HEADER_BYTES - 32 - 8;

// A resolve observes only the six native edges; ordinary counts/XP/wallet
// changes do not schedule main-thread economic work.
function edges(before, after, context = {}, timestamp = Date.now(), options = {}) {
    if (!after || ['resting', 'traveling'].includes(after.activity)
        || after.party?.partyId || after.partyId) return 0;
    const oldBag = before?.inventory || {}, bag = after.inventory || {};
    let bits = 0;
    for (const [key, row] of Object.entries(bag)) {
        const id = Number(row.selfId || key);
        if (id !== 57 && Number(row.amount) > 0 && !(Number(oldBag[id]?.amount) > 0)) { bits |= 1; break; }
    }
    const stockFor = options.stockFor || ((state, kind) => require('../Economy/EconomyContext').stockFor(state, kind));
    for (const kind of ['shots', 'potions']) {
        const stock = stockFor(after, kind);
        const id = Number(stock?.itemId), keep = Number(stock?.keep ?? stock?.target);
        if (!(id > 0) || !(keep > 0)) continue;
        if ((Number(oldBag[id]?.amount || 0) >= keep) !== (Number(bag[id]?.amount || 0) >= keep)) bits |= 2;
    }
    if (!Funding.moneyReached(before) && Funding.moneyReached(after)) bits |= 4;
    if (Number(context.goalReviewAt) > Number(before?.timing?.lastResolvedAt || 0)
        && Number(context.goalReviewAt) <= timestamp) bits |= 8;
    if (Number(after.level) > Number(before?.level)) bits |= 16;
    if (after.activity === 'dead' && before?.activity !== 'dead') bits |= 32;
    return bits;
}

// Same native sale/bid policies as a town/remote review, with the worker's
// mirrors supplied explicitly. No warehouse or life-state/database reader.
function prepare(state, economy, options = {}) {
    // Off returns the native iterator directly. On accumulates compute slices
    // only: waiting between generator yields is not planning CPU time.
    const iterator = prepareNative(state, economy, options);
    return Diagnostics.active() ? measured(iterator) : iterator;
}
function* measured(iterator) {
    if (Diagnostics.active()) Diagnostics.count('plan_compute', 'request');
    let elapsed = 0, next;
    try {
        do {
            const diagnostic = Diagnostics.active(), started = diagnostic ? performance.now() : 0;
            next = iterator.next();
            if (diagnostic && Diagnostics.active()) elapsed += performance.now() - started;
            if (!next.done) yield next.value;
        } while (!next.done);
        if (Diagnostics.active()) {
            Diagnostics.count('plan_compute', 'build');
            Diagnostics.duration('plan_compute', elapsed);
        }
        return next.value;
    } finally {
        if (!next?.done) iterator.return();
    }
}
function* prepareNative(state, economy, options) {
    const Listing = require('../Economy/MarketListingPolicy');
    const own = options.board?.ownerLines(Number(state.characterId)) || [];
    const kept = new Map(own.filter(line => line.storeType === SELL)
        .map(line => [`${line.selfId}:${line.enchant || 0}`, line.price]));
    const inventory = { ...state.inventory };
    for (const line of own) {
        if (line.storeType !== SELL || line.custodyPolicy === 1) continue;
        const row = inventory[line.selfId] || { selfId: line.selfId, amount: 0 };
        inventory[line.selfId] = { ...row, amount: Number(row.amount || 0) + line.count,
            instances: [...(row.instances || []), { id: -line.lineId, amount: line.count, enchant: line.enchant, equipped: false }] };
    }
    const saleState = { ...state, inventory };
    const sale = Listing.evaluate(saleState, { ...options, economy, slots: Listing.BOARD_SLOTS, kept, stored: new Map() });
    const Town = invoke('GameServer/Bot/Economy/MarketTownPolicy');
    const ctx = Listing.traderContext(state, { ...options, economy });
    const townOptions = { context: ctx, tripCost: options.tripCost || ctx.tripCost, timestamp: options.now,
        prepareTrip: options.prepareTrip, findSpot: options.findSpot, onDecision: options.onTownDecision };
    const heldTown = own.find(line => line.kind === 'shop' && line.storeType === SELL)?.town || state.stats?.shopTown?.town;
    const shopTown = heldTown || (yield* Town.chooseTown(state, sale.listings.slice(0, 3), townOptions)).town;
    const sell = [];
    for (let at = 0; at < Math.min(8, sale.listings.length); at++) {
        const row = sale.listings[at];
        const town = own.find(line => line.storeType === SELL && line.selfId === row.selfId)?.town
            || (at < 3 ? shopTown : (yield* Town.chooseTown(state, [row], townOptions)).town);
        const unchanged = own.some(line => line.storeType === SELL && line.selfId === Number(row.selfId)
            && line.count === Number(row.count) && line.price === Number(row.price) && line.town === town);
        if (town && !unchanged) sell.push([Number(row.selfId), Number(row.count), Number(row.price), town]);
        yield 'stock';
    }
    const listed = new Set(sale.listings.map(row => `${row.selfId}:${row.enchant || 0}`));
    const withdraw = own.filter(line => line.storeType === SELL && !listed.has(`${line.selfId}:${line.enchant || 0}`))
        .slice(0, 8).map(line => line.lineId);
    const needs = require('../Goals/NeedsEvaluator').evaluate(state, { ...options, economy, errand: null, now: options.now, saleTown: shopTown });
    const goal = needs[0];
    const buyState = { ...state, adena: Funding.budget(state, options.buyOrderEscrow || 0) };
    const money = Funding.spendable(state, options.buyOrderEscrow || 0,
        goal?.plan?.valueRate === undefined ? { itemId: goal?.target?.itemId } : { r: goal.plan.valueRate });
    const lines = require('../Economy/BuyAdPolicy').linesFor(buyState, goal, { ...options, economy,
        watchList: economy.watchList || [], money });
    let buyAds;
    try { buyAds = lines.slice(0, 3).map(row => row.intent ? require('../Economy/TradeIntent').encode(row.intent) : [row.selfId, row.count, row.price]); }
    catch (_) { buyAds = [null]; }
    const plan = { sell, withdraw, buyAds,
        travel: goal?.plan?.marketTown ? goal.plan.wishKey || null : null };
    if (economy.intentPending || plan.buyAds.some(row => row === null)) { delete plan.buyAds; plan.d = 1; }
    const shot = decideShot(state, economy, { ...options, ownLines: own });
    if (shot) plan.shot = shot;
    // A complete buy batch is indivisible. Optional work is retained by the
    // existing dirty preparation owner; absent buyAds means not prepared.
    if (Buffer.byteLength(JSON.stringify({ buyAds: plan.buyAds })) > MAX_PLAN_PAYLOAD_BYTES) {
        delete plan.buyAds; plan.d = (plan.d || 0) | 1;
    }
    while (Buffer.byteLength(JSON.stringify(plan)) > MAX_PLAN_PAYLOAD_BYTES) {
        if (plan.sell.length) { plan.sell.pop(); plan.d = (plan.d || 0) | 2; }
        else if (plan.withdraw.length) { plan.withdraw.pop(); plan.d = (plan.d || 0) | 4; }
        else if (plan.travel) { plan.travel = null; plan.d = (plan.d || 0) | 8; }
        else if (plan.shot) { delete plan.shot; plan.d = (plan.d || 0) | 16; }
        else throw Error('economy_plan_payload_overflow');
    }
    if (Diagnostics.active() && Diagnostics.enabled(state.characterId)) {
        const trace = { owner: state.characterId, caller: options.caller || 'cold_plan',
            trigger: options.trigger || 'plan_request', phase: 'plan_compute',
            inputHash: economy.inputHash ?? fnv1a32(economy.inputKey || ''),
            decisionSeq: economy.network?.decisionSeq ?? state.stats?.decisionSeq,
            activityLeaf: economy.network?.activityLeaf ?? state.stats?.activityLeaf,
            goalRevision: goal?.revision, wishKey: goal?.plan?.wishKey,
            wallet: state.adena, escrow: options.buyOrderEscrow,
            budget: money, available: money, reserve: state.stats?.money?.[2] };
        Diagnostics.push({ ...trace, reason: plan.travel ? 'travel_planned' : 'plan_prepared', town: goal?.plan?.marketTown });
        for (const row of plan.buyAds || []) Diagnostics.push({ ...trace, phase: 'buy_request', reason: 'bid_planned',
            item: row[0], planned: row[1], unitPrice: row[2], source: 'board_bid' });
    }
    return plan;
}
function decide(state, economy, options = {}) {
    const iterator = prepare(state, economy, options);
    let next; do { next = iterator.next(); } while (!next.done);
    return next.value;
}
function decideShot(state, economy, options = {}) {
    const Shots = require('../Economy/ShotCraftPolicy');
    if (!invoke('GameServer/Bot/Economy/CraftShopService').isServiceCrafter(state)) return null;
    if (Object.hasOwn(options, 'preparedCraft')) {
        // The worker has already streamed every recipe/input/exit/batch unit.
        // Main receives only the native step; it rechecks current physical rows.
        const selected = options.preparedCraft;
        const step = selected?.craft || selected?.wealth || selected?.recipeTarget ? Shots.packStep(selected)
            : selected?.recipeId > 0 ? Shots.packStep({ wealth: { ...selected,
                recipeId: Number(selected.recipeId), batches: Number(selected.batches || 1) } }) : null;
        return step && Buffer.byteLength(JSON.stringify(step)) > MAX_SHOT_PAYLOAD_BYTES ? { unknown: true } : step;
    }
    // Missing worker preparation is explicit unknown. No caller can trigger
    // a recipe/gear/quote scan by falling through this publication adapter.
    return { unknown: true };
}
module.exports = { edges, decide, prepare, decideShot, MAX_BYTES, MAX_SHOT_BYTES, MAX_PLAN_PAYLOAD_BYTES, MAX_SHOT_PAYLOAD_BYTES };
