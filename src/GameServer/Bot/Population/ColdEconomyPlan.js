const FailureLog = require('../../../FailureLog');
const { SELL } = require('../../AfkTrade/BoardIndex');
const Funding = require('../Economy/PurchaseFunding');
const Packet = require('../Economy/StatsPacket');
const Diagnostics = require('../Economy/EconomyDiagnostics');
const { fnv1a32 } = require('../Fnv1a');
const MAX_BYTES = 768;
const MAX_SHOT_BYTES = 128;
const { COMMAND_HEADER_BYTES, MAX_SHOT_PAYLOAD_BYTES } = require('./ColdEconomyDecision');
const MAX_PLAN_PAYLOAD_BYTES = MAX_BYTES - COMMAND_HEADER_BYTES - 32 - 8;
const BoardRules = require('../../AfkTrade/BoardRules');
const MAX_BUYS = BoardRules.BOT_SHOP_LINES + BoardRules.BOT_RECORDS.buy_ad;
const Listing = require('../Economy/MarketListingPolicy');
const Ready = require('../Economy/ReadyTradeChoice');
const Alternative = require('../Economy/BidPurchaseAlternative');
const NeedsEvaluator = require('../Goals/NeedsEvaluator');
const BuyAds = require('../Economy/BuyAdPolicy');
const TradeIntent = require('../Economy/TradeIntent');
const Shots = require('../Economy/ShotCraftPolicy');
const MarketPricing = require('../Economy/MarketPricing');
const PriceBelief = require('../Economy/PriceBelief');
const Trace = require('../DecisionTrace');

// Whether a step's plan is worth a held round: something BotAfkMarketService.executePlan
// carries out for the bot. plan.shop only names the town of plan.sell, buyKit and
// buyCaps go with buyAds; bidLimits ride every proposal and hold nothing.
function acts(plan) {
    return !!plan && !!(plan.take || plan.travel || plan.shot || plan.sell?.length || plan.withdraw?.length || plan.buyAds?.length);
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
// Whether the bot can trade now: its held build is settled, it stands (not dead,
// resting, on a trip or at a workbench), no meeting or delivery is pending and no
// survival floor holds it.
function canAct(state, economy, now) {
    return !economy.intentPending
        && !['dead', 'resting', 'traveling', 'crafting'].includes(state.activity)
        && !state.stats?.tradeMeeting && !state.incomingPending
        && !invoke('GameServer/Bot/Population/SurvivalFloor').forState(state, Number(now) || Date.now());
}
// The start of the held town leaf of a bot in the field, read off its card (no
// market plan is asked): the leaf's own quoted board line through a meeting
// (ReadyTradeChoice.purchase; a clan craft's key input whatever the leaf), else the
// trip to the leaf's town, which main begins from the goal it reads off the same
// card (BotAfkMarketService.executePlan: travel, GoalExecutor.beginMarketTravel).
// The kernel holds one round for it per decision (its occupation round).
const TOWN_LEAVES = new Set(['shopping', 'selling', 'improving']);
function leafStart(state, economy, options = {}) {
    const leaf = economy?.network?.activity;
    const take = canAct(state, economy, options.now)
        ? Ready.purchase(state, economy, options.board) || Ready.clanCraftPurchase(state, economy, options.board) : null;
    if (take) return { take, sell: [], withdraw: [], travel: null };
    if (!TOWN_LEAVES.has(leaf?.activity) || !leaf.rootKey) return null;
    // A purchase whose units all reached the bag has no trip (its goal: none to order).
    const itemId = Number(leaf.itemId || (typeof leaf.object === 'number' ? leaf.object : leaf.object?.itemId) || 0);
    if (leaf.activity === 'shopping' && !(itemId > 0
        && require('./ColdEconomyDecision').remainingToOrder(leaf, state, economy.state || state, itemId) > 0)) return null;
    return { sell: [], withdraw: [], travel: leaf.rootKey };
}
function* prepareNative(state, economy, options) {
    const canTrade = canAct(state, economy, options.now);
    const own = options.board?.ownerLines(Number(state.characterId)) || [];
    const ctx = Listing.traderContext(state, { ...options, economy });
    const limits = [];
    // A selected trade can keep succeeding or retrying for several visits.
    // It must not bypass corrections of the owner's other standing bids.
    const bidCtx = economy.trip?.details ? { ...ctx, travelDetails: economy.trip.details } : ctx;
    for (const line of own.filter(row => row.storeType === 3 && row.count > 0 && row.pricing).slice(0, MAX_BUYS)) {
        const ceiling = Math.min(Alternative.forLine(line, bidCtx), Alternative.cashCap(line, bidCtx));
        if (Number.isSafeInteger(ceiling) && ceiling >= 0 && ceiling < line.price)
            limits.push([line.lineId, line.recordId, line.revision, line.count, line.price, ceiling]);
        yield 'owned';
    }
    const bidLimits = limits.length ? { bidLimits: limits } : {};
    // In the field the held town leaf starts as the card says (leafStart: its board line, else its trip).
    const start = options.visit ? null : leafStart(state, economy, options);
    // A build's plan in the field (options.build) plans its bids and its leaf's start
    // only: what to sell, list or withdraw, to whom, and a craft are the town visit's
    // plan, as a C4 player sells and lists when he stands in town.
    if (options.build && start?.take) return { ...start, ...bidLimits };
    const standingShop = own.find(line => line.kind === 'shop' && line.storeType === SELL);
    const Town = invoke('GameServer/Bot/Economy/MarketTownPolicy');
    let plan, shopTown, showcaseRows = 0;
    if (options.build) {
        shopTown = standingShop?.town || state.stats?.shopTown?.town || null;
        plan = { sell: [], withdraw: [], travel: null, ...bidLimits };
    } else {
        // Main runs the plan's craft (plan.shot) before its sale: the sale keeps
        // that craft's kit, which the craft consumes or holds (productionInputAmounts),
        // on top of the gear plan's reserve (ItemDisposition.saleReservations).
        const saleInput = Listing.ownSaleInputs(state, own, { ...options, economy,
            productionKit: shotKit(state, economy, options) });
        const sale = Listing.evaluate(saleInput.state, saleInput.options);
        // A profitable surplus sale uses a meeting or a backed shop in the town
        // already reached. Leave the selected purchase/focus intact for review.
        const answer = canTrade && !options.visit ? Ready.sale(sale.answers, state) : null;
        if (answer) return { take: answer, sell: [], withdraw: [], travel: null, ...bidLimits };
        // Only native acceptance reserves a quote; rejection keeps the plan.
        if (start?.take) return { ...start, ...bidLimits };
        const townOptions = { context: ctx, tripCost: options.tripCost || ctx.tripCost, timestamp: options.now,
            prepareTrip: options.prepareTrip, findSpot: options.findSpot, onDecision: options.onTownDecision };
        const listings = Listing.prioritizeListings(sale.listings, { board: options.board,
            characterId: state.characterId, timestamp: options.now });
        const visitTown = state.activity === 'shopping' && invoke('GameServer/Bot/Economy/ShopPlaces').hasPlaza(state.currentRegion)
            ? state.currentRegion : null;
        const heldTown = standingShop?.town || state.stats?.shopTown?.town || visitTown;
        shopTown = heldTown || (yield* Town.chooseTown(state, listings.slice(0, 3), townOptions)).town;
        // Field quotes stay available until a real visit. In its chosen town the
        // bot promotes its best quotes; an existing shop can be refreshed remotely.
        const publishShop = !!standingShop || state.activity === 'shopping' && state.currentRegion === shopTown;
        const sell = [];
        let showcaseChanged = false;
        for (let at = 0; at < Math.min(8, listings.length); at++) {
            const row = listings[at];
            const showcase = publishShop && at < 3;
            const enchant = Number(row.enchant || 0);
            const town = showcase ? shopTown : own.find(line => line.storeType === SELL && line.selfId === Number(row.selfId)
                && Number(line.enchant || 0) === enchant)?.town
                || (at < 3 ? shopTown : (yield* Town.chooseTown(state, [row], townOptions)).town);
            const unchanged = own.some(line => line.storeType === SELL && line.selfId === Number(row.selfId)
                && Number(line.enchant || 0) === enchant
                && line.count === Number(row.count) && line.price === Number(row.price) && line.town === town
                && (!publishShop || (showcase ? line.kind === 'shop' : line.kind !== 'shop')));
            if (showcase) { showcaseRows++; showcaseChanged ||= !unchanged; }
            // A shop replacement needs its complete desired stock, including
            // unchanged lines, so it cannot accidentally return the best one.
            if (showcase || town && !unchanged) {
                const sigma = sellSigma(row, ctx);
                sell.push([Number(row.selfId), Number(row.count), Number(row.price), town, enchant, ...(sigma ? [sigma] : [])]);
            }
            yield 'stock';
        }
        if (!showcaseChanged) sell.splice(0, showcaseRows);
        const listed = new Set(sale.listings.map(row => `${row.selfId}:${row.enchant || 0}`));
        const withdraw = own.filter(line => line.storeType === SELL && !listed.has(`${line.selfId}:${line.enchant || 0}`))
            .slice(0, 8).map(line => line.lineId);
        plan = { sell, withdraw, ...(showcaseChanged ? { shop: shopTown } : {}), travel: null, ...bidLimits };
    }
    // The bids (buy ads: the goal's and the build's watch rows, the standing craft bids
    // still needed) are posted on a town visit too, as a C4 player opens a buy store in
    // town; the field plan adds the held leaf's trip.
    let goal, money;
    {
        const needs = NeedsEvaluator.evaluate(state, { ...options, economy, errand: null, now: options.now, saleTown: shopTown });
        goal = needs[0];
        const buyState = { ...state, adena: Funding.budget(state, options.buyOrderEscrow || 0) };
        money = BuyAds.goalMoney(state, goal, options.buyOrderEscrow || 0, economy);
        let lines = BuyAds.linesFor(buyState, goal, { ...options, economy,
            townFor: items => Town.buyAdTown(state, items, own, { findSpot: options.findSpot }),
            watchList: economy.watchList || [], money });
        lines = BuyAds.keepRetainedBids(state, own, lines, economy.network?.moneyPrice, options.buyOrderEscrow || 0);
        // The native activity selected the priority. A buy may replace a sale
        // shop; ordinary surplus listings cannot evict a standing buy shop.
        plan.buyShop = ['upgrade_gear', 'buy_craft_material'].includes(goal?.type) ? BoardRules.BUY
            : goal?.type === 'sell_inventory' ? BoardRules.SELL : 0;
        if (plan.buyShop === BoardRules.BUY && lines.length
            || own.some(line => line.kind === 'shop' && line.storeType === BoardRules.BUY) && plan.buyShop !== BoardRules.SELL)
            delete plan.shop;
        let batch;
        try { batch = buyBatch(lines); }
        // A bug in the buy build, kept apart from a refused line (both leave the buy unprepared).
        catch (error) { FailureLog.note('economy.buy_batch', error); batch = { buyAds: [null] }; }
        Object.assign(plan, batch, { travel: start?.travel || null });
        // A buy part not prepared (the held build's intent pending, or a
        // line buyBatch refused) is absent from the packet, not a page: a
        // refresh on main's next state copy reads the same build, so only
        // the bot's next step, which rebuilds, can prepare it. An incoming
        // delivery still pending is main's: its settlement is a state copy
        // that rebuilds, so it stays a page.
        const unprepared = !economy.intentPending ? (plan.buyAds.some(row => row === null) ? 'buy_error' : null)
            : state.incomingPending ? 'intent_incoming' : 'intent_root';
        if (unprepared) {
            dropBuyBatch(plan);
            if (unprepared === 'intent_incoming') plan.d = 1;
            if (Diagnostics.active()) Diagnostics.count('economy_plan', 'deferred', unprepared);
        }
        // A town visit's plan carries the craft step the visit selected (a crafter crafts
        // in town from what it brought), else the one its held decision prepared.
        const shot = options.build ? null : options.visit && !Object.hasOwn(options, 'preparedCraft') ? heldCraft(economy) && economy.shot
            : decideShot(state, economy, { ...options, ownLines: own });
        if (shot) plan.shot = shot;
    }
    // A complete buy batch is indivisible. Optional work is retained by the
    // existing dirty preparation owner; absent buyAds means not prepared.
    if (Buffer.byteLength(JSON.stringify({ buyAds: plan.buyAds, buyKit: plan.buyKit, buyCaps: plan.buyCaps,
        bidLimits: plan.bidLimits })) > MAX_PLAN_PAYLOAD_BYTES) {
        dropBuyBatch(plan); plan.d = (plan.d || 0) | 1;
        if (Diagnostics.active()) Diagnostics.count('economy_plan', 'deferred', 'bytes');
    }
    fit(plan, showcaseRows);
    if (plan.d > 1 && Diagnostics.active()) Diagnostics.count('economy_plan', 'deferred', `bytes_${plan.d & ~1}`);
    if (Trace.detailed(state.characterId)) {
        const trace = { owner: state.characterId, caller: options.caller || 'cold_plan',
            trigger: options.trigger || 'plan_request', phase: 'plan_compute',
            inputHash: economy.inputHash ?? fnv1a32(economy.inputKey || ''),
            decisionSeq: economy.network?.decisionSeq ?? state.stats?.decisionSeq,
            activityLeaf: economy.network?.activityLeaf ?? state.stats?.activityLeaf,
            wishKey: goal?.plan?.wishKey,
            wallet: state.adena, escrow: options.buyOrderEscrow,
            budget: money, available: money, reserve: Packet.refillReserve(state.stats?.money) };
        Trace.detail({ ...trace, reason: plan.travel ? 'travel_planned' : 'plan_prepared', town: goal?.plan?.marketTown });
        for (const row of plan.buyAds || []) Trace.detail({ ...trace, phase: 'buy_request', reason: 'bid_planned',
            item: row[0], planned: row[1], unitPrice: row[2], source: 'board_bid' });
    }
    return plan;
}
// A sell row is [selfId, count, price, town, enchant, sigma?]: sigma is the
// width of the belief the price was decided with (its line pricing,
// MarketPricing.lineState), in ten-thousandths (5 B a row instead of ~19; a
// review reads it as the noise band, so 1e-4 is far below a price step).
// Main publishes it instead of rebuilding the belief (a first price on a cold
// cache took 300 ms main turns). A kept line was not re-decided: its belief
// is read here, where the first prices are warm. Absent when unknown.
function sellSigma(row, ctx) {
    const known = row.pricing?.sigma > 0 ? row.pricing.sigma : null;
    const belief = known ? null : MarketPricing.beliefFor(row.selfId, ctx, Number(row.enchant || 0));
    const sigma = known ?? (belief ? PriceBelief.sigma(belief) : 0);
    return Number.isFinite(sigma) && sigma > 0 ? Math.max(1, Math.round(sigma * 1e4)) : 0;
}
// The buy batch as the plan carries it: each bid's row and, when any is
// set, the survival tranche each bid was decided with (BuyAdPolicy
// survivalCost) and executable purchase limits. Native publication reuses
// these scalars, never another route or price calculation.
function dropBuyBatch(plan) {
    delete plan.buyAds; delete plan.buyKit; delete plan.buyCaps;
}
function buyBatch(lines) {
    const rows = lines.slice(0, MAX_BUYS);
    const buyAds = rows.map(row => row.intent ? TradeIntent.encode(row.intent) : [row.selfId, row.count, row.price]);
    const buyKit = rows.map(row => Number(row.survivalCost) || 0);
    const buyCaps = rows.map(row => Number.isFinite(row.purchaseCap) ? Math.floor(row.purchaseCap) : null);
    return { buyAds, ...(buyKit.some(Boolean) ? { buyKit } : {}),
        ...(buyCaps.some(cap => cap !== null) ? { buyCaps } : {}) };
}
// One command's room: what can wait leaves, last the buy batch, whole (absent buyAds means
// not prepared): a batch that fit alone can overflow beside the plan's other fields.
function fit(plan, showcaseRows = 0) {
    while (Buffer.byteLength(JSON.stringify(plan)) > MAX_PLAN_PAYLOAD_BYTES) {
        if (plan.sell.length) {
            plan.sell.pop(); plan.d = (plan.d || 0) | 2;
            // A truncated replacement cannot remove unchanged valuable
            // stock. Keep the existing records until the whole showcase fits.
            if (plan.shop && plan.sell.length < showcaseRows) {
                plan.sell = []; delete plan.shop;
            }
        }
        else if (plan.withdraw.length) { plan.withdraw.pop(); plan.d = (plan.d || 0) | 4; }
        else if (plan.travel) { plan.travel = null; plan.d = (plan.d || 0) | 8; }
        else if (plan.shot) { delete plan.shot; plan.d = (plan.d || 0) | 16; }
        else if (plan.buyAds) { dropBuyBatch(plan); plan.d = (plan.d || 0) | 1; }
        else throw Error('economy_plan_payload_overflow');
    }
}
function decide(state, economy, options = {}) {
    const iterator = prepare(state, economy, options);
    let next; do { next = iterator.next(); } while (!next.done);
    return next.value;
}
// The craft step a served decision holds (its card's), none when it prepared none.
const heldCraft = economy => economy?.shot && !economy.shot.unknown ? Shots.unpackStep(economy.shot) : null;
// The inputs of the plan's craft: the one decideShot publishes from the worker's
// selection, or on a visit with none the held decision's.
function shotKit(state, economy, options = {}) {
    const selected = options.visit && !Object.hasOwn(options, 'preparedCraft') ? heldCraft(economy) : options.preparedCraft;
    if (!selected || !invoke('GameServer/Bot/Economy/CraftShopService').isServiceCrafter(state)) return {};
    const action = selected.craft || selected.wealth || (selected.recipeTarget ? selected.recipeRoute : null)
        || (selected.recipeId > 0 ? selected : null);
    return action ? invoke('GameServer/Bot/Economy/ItemDisposition').recipeInputAmounts(action.recipeId, action.batches || 1) : {};
}
function decideShot(state, economy, options = {}) {
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
module.exports = { acts, leafStart, decide, prepare, fit, buyBatch, decideShot, MAX_BYTES, MAX_SHOT_BYTES, MAX_PLAN_PAYLOAD_BYTES, MAX_SHOT_PAYLOAD_BYTES };
