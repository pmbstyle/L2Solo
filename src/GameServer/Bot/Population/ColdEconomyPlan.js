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
const EconomyContext = require('../Economy/EconomyContext');
const Listing = require('../Economy/MarketListingPolicy');
const Ready = require('../Economy/ReadyTradeChoice');
const Alternative = require('../Economy/BidPurchaseAlternative');
const NeedsEvaluator = require('../Goals/NeedsEvaluator');
const BuyAds = require('../Economy/BuyAdPolicy');
const TradeIntent = require('../Economy/TradeIntent');
const Shots = require('../Economy/ShotCraftPolicy');
const MarketPricing = require('../Economy/MarketPricing');
const PriceBelief = require('../Economy/PriceBelief');
const Craft = require('../Economy/WealthCraftPolicy');

// Arrival and recovery are natural decision points; ordinary counts/XP/wallet
// changes do not schedule main-thread economic work. options.buyOrderEscrow:
// the adena the bot's buy orders hold (the worker's board sum). edges reads
// a round's two states (the hunt window's end); edgesSince reads the facts of
// the bot's last action ask (actionBaseline) against the step's projection.
function edges(before, after, options = {}) {
    const oldBag = before?.inventory || {};
    const bits = factEdges({ amount: id => Number(oldBag[id]?.amount || 0), money: Funding.moneyReached(before, options.buyOrderEscrow),
        arrived: () => before?.activity === 'traveling', level: Number(before?.level), dead: before?.activity === 'dead' }, after, options);
    // Rest blocks actions, so stock/loot changes may have passed without
    // preparation. Reconsider them once the bot can act again. A goal change
    // is the decision point's (ColdEconomyDecision.refusal 'goal').
    return bits >= 0 && after.activity === 'hunting' && before?.activity === 'resting' ? bits | 8 : Math.max(0, bits);
}
// The edges both readers share; -1: none can fire (a rest, a trip, a party member).
function factEdges(was, after, options) {
    if (!after || ['resting', 'traveling'].includes(after.activity)
        || after.party?.partyId || after.partyId) return -1;
    const bag = after.inventory || {};
    let bits = 0;
    for (const [key, row] of Object.entries(bag)) {
        const id = Number(row.selfId || key);
        if (id !== 57 && Number(row.amount) > 0 && !(was.amount(id) > 0)) { bits |= 1; break; }
    }
    const stockFor = options.stockFor || EconomyContext.stockFor;
    for (const kind of ['shots', 'potions']) {
        const stock = stockFor(after, kind);
        const id = Number(stock?.itemId), keep = Number(stock?.keep ?? stock?.target);
        if (!(id > 0) || !(keep > 0)) continue;
        if ((was.amount(id) >= keep) !== (Number(bag[id]?.amount || 0) >= keep)) bits |= 2;
    }
    if (!was.money && Funding.moneyReached(after, options.buyOrderEscrow)) bits |= 4;
    if (after.activity === 'shopping' && was.arrived(after)) bits |= 8;
    if (Number(after.level) > was.level) bits |= 16;
    if (after.activity === 'dead' && !was.dead) bits |= 32;
    return bits;
}
// The facts of the bot's action ask that its plan reads and that have an
// event: each bag item's amount, whether the money reached the first unfunded
// wish, the town it shops in, its level, a death, its MP (as the band its
// craft checks answer alike on, WealthCraftPolicy.craftMpBand) and the trades
// on its own board lines (each line's fills). Not in it: the clock (the plan
// reads it directly: SurvivalFloor's cooldowns and sale retry, the errands'
// expiry, price beliefs), the quotes of others on what it reads (their item
// revisions move nearly every step), a mana bot's MP (SurvivalFloor's cast
// costs follow the cooldowns) and an own line sold out (it leaves the board,
// as one the plan withdrew): heard at the bot's next edge or decision.
// Compact: sorted [id, amount] and [lineId, fills] pairs.
function actionBaseline(state, { buyOrderEscrow = 0, ownLines = [] } = {}) {
    const bag = [];
    for (const [key, row] of Object.entries(state.inventory || {})) {
        const id = Number(row.selfId || key), amount = Number(row.amount) || 0;
        if (id !== 57 && amount > 0) bag.push([id, amount]);
    }
    return { bag: pairsOf(bag), money: Funding.moneyReached(state, buyOrderEscrow),
        shop: state.activity === 'shopping' ? String(state.currentRegion) : null, level: Number(state.level),
        dead: state.activity === 'dead', mp: Number(state.vitals?.mp) || 0,
        fills: pairsOf(ownLines.map(line => [Number(line.lineId), Number(line.fills) || 0])) };
}
function pairsOf(rows) {
    rows.sort((a, b) => a[0] - b[0]);
    const out = new Float64Array(rows.length * 2);
    rows.forEach(([id, value], at) => { out[2 * at] = id; out[2 * at + 1] = value; });
    return out;
}
// The pair's value for id, undefined when it has none.
function pairValue(pairs, id) {
    let low = 0, high = pairs.length / 2 - 1;
    while (low <= high) {
        const mid = (low + high) >> 1, at = pairs[2 * mid];
        if (at === id) return pairs[2 * mid + 1];
        if (at < id) low = mid + 1; else high = mid - 1;
    }
    return undefined;
}
// The bits of the facts that moved since the baseline: 1 new loot, 2 a kit
// stock threshold, 4 the money reached, 8 a shopping town reached, 16 a level,
// 32 a death, 64 the craft MP band, 128 a trade on an own line.
// options.ownLines: the bot's board lines now.
function edgesSince(baseline, after, options = {}) {
    let bits = factEdges({ amount: id => pairValue(baseline.bag, Number(id)) || 0, money: baseline.money,
        arrived: now => baseline.shop !== String(now.currentRegion), level: baseline.level, dead: baseline.dead }, after, options);
    if (bits < 0) return 0;
    if (!Craft.sameCraftMp(invoke('GameServer/Bot/Economy/CraftEligibility').craftLevelFor(after), baseline.mp, after.vitals?.mp)) bits |= 64;
    // A line posted since the ask counts its fills from none.
    for (const line of options.ownLines || []) {
        if ((Number(line.fills) || 0) > (pairValue(baseline.fills, Number(line.lineId)) ?? 0)) { bits |= 128; break; }
    }
    return bits;
}

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
function* prepareNative(state, economy, options) {
    const canAct = !economy.intentPending
        && !['dead', 'resting', 'traveling', 'crafting'].includes(state.activity)
        && !state.stats?.tradeMeeting && !state.incomingPending
        && !invoke('GameServer/Bot/Population/SurvivalFloor').forState(state, Number(options.now) || Date.now());
    const own = options.board?.ownerLines(Number(state.characterId)) || [];
    const ctx = Listing.traderContext(state, { ...options, economy });
    const limits = [];
    // A selected trade can keep succeeding or retrying for several visits.
    // It must not bypass corrections of the owner's other standing bids.
    if (!options.showcaseOnly) {
        const bidCtx = economy.trip?.details ? { ...ctx, travelDetails: economy.trip.details } : ctx;
        for (const line of own.filter(row => row.storeType === 3 && row.count > 0 && row.pricing).slice(0, MAX_BUYS)) {
            const ceiling = Math.min(Alternative.forLine(line, bidCtx), Alternative.cashCap(line, bidCtx));
            if (Number.isSafeInteger(ceiling) && ceiling >= 0 && ceiling < line.price)
                limits.push([line.lineId, line.recordId, line.revision, line.count, line.price, ceiling]);
            yield 'owned';
        }
    }
    const bidLimits = limits.length ? { bidLimits: limits } : {};
    const purchase = canAct && !options.showcaseOnly
        ? Ready.purchase(state, economy, options.board) || Ready.clanCraftPurchase(state, economy, options.board) : null;
    // Main runs the plan's craft (plan.shot) before its sale: the sale keeps
    // that craft's kit, which the craft consumes or holds (productionInputAmounts),
    // on top of the gear plan's reserve (ItemDisposition.saleReservations).
    const saleInput = Listing.ownSaleInputs(state, own, { ...options, economy,
        productionKit: shotKit(state, options) });
    const sale = Listing.evaluate(saleInput.state, saleInput.options);
    // A profitable surplus sale uses a meeting or a backed shop in the town
    // already reached. Leave the selected purchase/focus intact for review.
    const answer = canAct && !options.showcaseOnly ? Ready.sale(sale.answers, state) : null;
    if (answer) return { take: answer, sell: [], withdraw: [], travel: null, ...bidLimits };
    // Only native acceptance reserves a quote; rejection keeps the plan.
    if (purchase) return { take: purchase, sell: [], withdraw: [], travel: null, ...bidLimits };
    const Town = invoke('GameServer/Bot/Economy/MarketTownPolicy');
    const townOptions = { context: ctx, tripCost: options.tripCost || ctx.tripCost, timestamp: options.now,
        prepareTrip: options.prepareTrip, findSpot: options.findSpot, onDecision: options.onTownDecision };
    const listings = Listing.prioritizeListings(sale.listings, { board: options.board,
        characterId: state.characterId, timestamp: options.now });
    const standingShop = own.find(line => line.kind === 'shop' && line.storeType === SELL);
    const visitTown = state.activity === 'shopping' && invoke('GameServer/Bot/Economy/ShopPlaces').hasPlaza(state.currentRegion)
        ? state.currentRegion : null;
    const heldTown = standingShop?.town || state.stats?.shopTown?.town || visitTown;
    const shopTown = heldTown || (yield* Town.chooseTown(state, listings.slice(0, 3), townOptions)).town;
    // Field quotes stay available until a real visit. In its chosen town the
    // bot promotes its best quotes; an existing shop can be refreshed remotely.
    const publishShop = !!standingShop || state.activity === 'shopping' && state.currentRegion === shopTown;
    const sell = [];
    let showcaseChanged = false;
    let showcaseRows = 0;
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
    const plan = { sell, withdraw, ...(showcaseChanged ? { shop: shopTown } : {}), travel: null, ...bidLimits };
    let goal, money, recipeBidId = 0;
    if (!options.showcaseOnly) {
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
        Object.assign(plan, batch, { travel: goal?.plan?.marketTown ? goal.plan.wishKey || null : null });
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
        // A prepared recipe bid already performs this seek. Rewriting its
        // durable series first would move the native revision and discard
        // the same command's publication every time the batch count changes.
        recipeBidId = lines.find(line => line.intent?.shotRecipeInvestment === true
            && Number(line.intent.recipeId) === Number(options.preparedCraft?.recipeTarget)
            && Number(line.selfId) === Number(state.stats?.shotRecipeDemand?.itemId))?.selfId || 0;
        const shot = decideShot(state, economy, { ...options, ownLines: own });
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
    if (recipeBidId && plan.buyAds?.some(row => row[0] === recipeBidId)) delete plan.shot;
    if (plan.d > 1 && Diagnostics.active()) Diagnostics.count('economy_plan', 'deferred', `bytes_${plan.d & ~1}`);
    if (Diagnostics.active() && Diagnostics.enabled(state.characterId)) {
        const trace = { owner: state.characterId, caller: options.caller || 'cold_plan',
            trigger: options.trigger || 'plan_request', phase: 'plan_compute',
            inputHash: economy.inputHash ?? fnv1a32(economy.inputKey || ''),
            decisionSeq: economy.network?.decisionSeq ?? state.stats?.decisionSeq,
            activityLeaf: economy.network?.activityLeaf ?? state.stats?.activityLeaf,
            wishKey: goal?.plan?.wishKey,
            wallet: state.adena, escrow: options.buyOrderEscrow,
            budget: money, available: money, reserve: Packet.survivalReserve(state.stats?.money) };
        Diagnostics.push({ ...trace, reason: plan.travel ? 'travel_planned' : 'plan_prepared', town: goal?.plan?.marketTown });
        for (const row of plan.buyAds || []) Diagnostics.push({ ...trace, phase: 'buy_request', reason: 'bid_planned',
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
// The inputs of the craft decideShot publishes from the worker's selection.
function shotKit(state, options = {}) {
    if (options.showcaseOnly || !options.preparedCraft
        || !invoke('GameServer/Bot/Economy/CraftShopService').isServiceCrafter(state)) return {};
    const selected = options.preparedCraft;
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
module.exports = { edges, edgesSince, actionBaseline, acts, decide, prepare, fit, buyBatch, decideShot, MAX_BYTES, MAX_SHOT_BYTES, MAX_PLAN_PAYLOAD_BYTES, MAX_SHOT_PAYLOAD_BYTES };
