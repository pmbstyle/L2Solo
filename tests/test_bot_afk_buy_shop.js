'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('bot-afk-buy-shop');
require('../src/Global');
fixture.assertConfigured(options.default);
const DB = invoke('Database'), Life = invoke('GameServer/Bot/Population/BotLifeState');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const Market = invoke('GameServer/Bot/Economy/BotAfkMarketService');
const BuyShop = invoke('GameServer/Bot/Economy/BotBuyShopService');
const Places = invoke('GameServer/Bot/Economy/ShopPlaces');
const Native = require('./helpers/nativeMarketFixture');
const Plan = require('../src/GameServer/Bot/Population/ColdEconomyPlan');
const Decision = require('../src/GameServer/Bot/Population/ColdEconomyDecision');
const Ready = require('../src/GameServer/Bot/Economy/ReadyTradeChoice');
const POINT = { locX: 83000, locY: 148000, locZ: -3400 };
const REQUESTS = [79, 1864, 1865, 1866, 1867, 1868, 1869, 1870].map((id, at) => [id, at ? 2 : 1, (at + 1) * 100]);
const cost = rows => rows.reduce((sum, row) => sum + row[1] * row[2], 0);
const wallet = async id => Native.amount(await DB.fetchItems(id), 57);
// What a deal owes a far bot waits on the board until its own step commit.
const owed = async (id, selfId) => Number((await DB.execute(['SELECT COALESCE(SUM(amount), 0) AS amount FROM board_settlements WHERE ownerId = ? AND selfId = ?', [id, selfId]]))[0].amount);
const records = id => Afk.ownerRecords(id);
const shop = id => Afk.findOwnerProjection(id)?.shop;
const apply = (id, rows = REQUESTS, priority = Afk.BUY) => Market.executePlan(Life.snapshot(id),
    { buyAds: rows, buyShop: priority }, { reviewGoal: false });

async function bot(id, town = 'Giran', loc = POINT) {
    await Native.character(DB, id, `Buyer${id}`, `bot_buy_shop_${id}`, loc);
    await DB.setItem(id, { selfId: 57, name: 'Adena', amount: 1000000, slot: 0 });
    return Life.upsertState({ characterId: id, accountName: `bot_buy_shop_${id}`, name: `Buyer${id}`,
        phase: 'cold', activity: 'shopping', level: 45, adena: 1000000, inventory: Life.inventorySummaryFromItems(await DB.fetchItems(id)),
        currentRegion: town, loc, vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
        stats: { generatedCold: true, money: [36000, 0, 0, 0] }, timing: {} }, 'buy_shop_fixture');
}

// A no-grade bid in the cold worker, which has no world: its town reads the
// hunting spot through the plan's findSpot.
async function noGradeBidTown() {
    await bot(9113);
    const hunter = await Life.upsertState({ ...Life.snapshot(9113), activity: 'hunting', spotId: 'held-spot',
        stats: { ...Life.snapshot(9113).stats, money: [36000, 1 / 36000, 0, 0] } }, 'buy_shop_hunt');
    const economy = { ...Decision.economyFor(hunter), network: { activity: null },
        watchList: [{ key: 'power:48:9', itemId: 48, amount: 1, worth: 1000, kind: 'gear' }] };
    const Spots = invoke('GameServer/Bot/AI/SpotService'), findById = Spots.findById;
    let worldReads = 0;
    Spots.findById = function (id) { worldReads++; return findById.call(this, id); };
    try {
        Plan.decide(hunter, economy, { board: Afk.boardIndex(), now: Date.now(), decisionPoint: 'no_grade_bid', npcOffersFor: () => [],
            findSpot: () => ({ center: POINT }) });
    } finally { Spots.findById = findById; }
    assert.equal(worldReads, 0, 'the plan reads spots through findSpot, never the world index');
}

async function autonomousSale() {
    await bot(9110);
    await apply(9110, [[79, 1, 100], [1864, 5, 100000]]);
    await Life.upsertState({ ...Life.snapshot(9110), activity: 'hunting' }, 'buy_shop_hunt');
    await bot(9111);
    await DB.setItem(9111, { selfId: 1864, name: 'Stem', amount: 12, slot: 0 });
    const refreshed = await Life.refreshInventory(Life.snapshot(9111));
    const seller = await Life.upsertState({ ...refreshed,
        stats: { ...refreshed.stats, money: [36000, 1 / 36000, 0, 0] } }, 'buy_shop_seller_money');
    const economy = { ...Decision.economyFor(seller), network: { activity: null } };
    const plan = Plan.decide(seller, economy, { board: Afk.boardIndex(), now: Date.now(),
        decisionPoint: 'autonomous_buy_shop_sale', npcOffersFor: () => [], findSpot: () => null });
    assert.equal(plan.take?.[0], Afk.BUY, 'the native seller decision must execute a backed buy shop');
    assert.equal(plan.take[3], shop(9110).id);
    assert.equal(plan.take[2], 5);
    const line = Afk.boardIndex().records.get(plan.take[3]).find(row => row.lineId === plan.take[4]);
    assert.equal(Ready.sale([{ line, count: 5 }], { ...seller, currentRegion: 'Dion' }), null,
        'a physical shop cannot be filled remotely from another town');
    assert.equal(Ready.sale([{ line, count: 5 }], { ...seller, loc: { locX: 0, locY: 0, locZ: 0 } }), null,
        'the region label alone does not prove physical arrival');
    const cashBefore = await wallet(9110) + await wallet(9111) + Market.buyOrderEscrow(9110);
    const result = await Market.executePlan(seller, plan, { reviewGoal: false });
    assert.equal(result.pending, undefined);
    assert.equal(Native.amount(await DB.fetchItems(9111), 1864), 7);
    assert.equal(await wallet(9111), 1500000, 'the seller receives exactly five units at the shop price');
    assert.equal(shop(9110).escrowAdena, 100, 'only the unfilled weapon request remains reserved');
    assert.equal(await wallet(9110) + await wallet(9111) + Market.buyOrderEscrow(9110), cashBefore,
        'a native sale transfers Adena without creating or deleting money');
    assert.equal(await owed(9110, 1864), 5, 'the far buyer\'s five items wait on the board for its own commit');
    await Market.executePlan(Life.snapshot(9111), plan, { reviewGoal: false });
    assert.equal(await wallet(9111), 1500000, 'an old quote cannot pay the seller twice');
    await DB.flushJournals(); await DB.flushHistory();
    const trades = await DB.readHistory([`SELECT quantity,totalPrice,sourceType FROM market_trades
        WHERE buyerCharacterId=? AND sellerCharacterId=?`, [9110, 9111]]);
    assert.deepEqual(trades.map(row => [row.quantity, row.totalPrice, row.sourceType]), [[5, 500000, 'afk_bot_buy_store']]);
    const flows = await DB.readHistory([`SELECT selfId,SUM(delta) delta FROM economy_flow_hour
        WHERE operation='afk-trade:sell-to-shop' GROUP BY selfId`, []]);
    assert(flows.every(row => row.delta === 0), 'the transfer journal conserves purchased goods and Adena');
    console.log('PASS autonomous buy-shop sale: native decision, escrow, seller receipt, buyer settlement, replay and conservation');
}

// A visit that buys a root's input at an NPC (a D weapon for a luxury jewel's crystals)
// while the build also watches the root itself and a stock item. The bids hold no money
// the purchase was funded with: no bid for the root while its input is bought, and the
// buyer reads the planner's purse (its own bids' escrow counted, paid from the bag), so
// the higher-ranked stock bid's money is not subtracted twice. A purse short of the
// step's price is refused for money: the visit ends, its item is marked (the build would
// fund it from the bag again at once).
async function heldPurchaseVisit() {
    const Policy = invoke('GameServer/Bot/Economy/BuyAdPolicy');
    const Pricing = invoke('GameServer/Bot/Economy/MarketPricing');
    const ColdMarket = invoke('GameServer/Bot/Economy/ColdMarketService');
    const Events = invoke('GameServer/Bot/AI/DecisionEvents');
    const ROOT = 'power:854:4', INPUT = 90, STOCK = 1867, STOCK_PRICE = 400000, JEWEL_PRICE = 600000;
    const price = Number(invoke('GameServer/Bot/Economy/MarketOpportunity').npcOffers(INPUT, 'Giran')[0].price);
    // The stock root ranks first (its bid's money is its funded row), the root next.
    const packet = [36000, 1e-6, 0, 0, 2, STOCK_PRICE, STOCK, 1, STOCK_PRICE + price + JEWEL_PRICE, 854];
    const goal = { type: 'buy_craft_material', target: { itemId: INPUT, itemName: 'Input', amount: 1, adena: price },
        plan: { wishKey: ROOT, sourceType: 'npc', estimatedCost: price, valueRate: 1, purpose: 'gear',
            expectedBenefit: 'market_buy_craft_material', marketTown: 'Giran' } };
    const watch = [{ itemId: 854, amount: 1, worth: JEWEL_PRICE, key: ROOT, recipeId: 0, valueHours: 1, valueRate: 1 },
        { itemId: STOCK, amount: 1, worth: STOCK_PRICE, key: `resale:${STOCK}`, recipeId: 0, valueHours: 1, valueRate: 2 }];
    const trip = () => 0; trip.details = () => ({ known: true, hours: 0, fees: 0 });
    const Towns = invoke('GameServer/Bot/Economy/MarketTownPolicy');
    const raised = [], raiseOn = Events.raiseOn, previousBid = Pricing.bid, buyAdTown = Towns.buyAdTown;
    // The visit's town: its bids open the buy shop where the bot stands.
    Towns.buyAdTown = () => 'Giran';
    Events.raiseOn = async (who, name, payload) => { raised.push([who, name, payload]); return null; };
    Pricing.bid = selfId => { const unit = selfId === 854 ? JEWEL_PRICE : STOCK_PRICE;
        return { price: unit, count: 1, purchaseCap: unit, pricing: { price: unit } }; };
    const visit = async (id, bag, money = packet, watchList = watch) => {
        await bot(id);
        const cash = (await DB.fetchItems(id)).find(item => Number(item.selfId) === 57);
        await DB.updateItemAmount(id, cash.id, bag);
        const state = await Life.upsertState({ ...await Life.refreshInventory(Life.snapshot(id)), adena: bag,
            stats: { ...Life.snapshot(id).stats, money } }, 'held_purchase_fixture');
        const lines = Policy.linesFor(state, goal, { watchList, board: Afk.boardIndex(), townFor: () => 'Giran',
            npcOffersFor: () => [], economy: { moneyPrice: 1e-6, hourAdena: 36000, worth: () => STOCK_PRICE, trip,
                persona: { traits: {} }, network: { moneyPrice: 1e-6 } } });
        await Market.executePlan(state, { ...Plan.buyBatch(lines), buyShop: Afk.BUY }, { reviewGoal: false });
        return { lines, state: Life.snapshot(id) };
    };
    try {
        // Bag: the stock bid, the input and half the stock bid again: a buyer that
        // subtracts the escrowed stock bid's funded row from the bag it left is short.
        const funded = await visit(9114, price + STOCK_PRICE * 3 / 2);
        assert.deepEqual(funded.lines.map(line => line.selfId), [STOCK], 'no bid for the root while the visit buys its input');
        assert.equal(Market.buyOrderEscrow(9114), STOCK_PRICE, 'only the stock bid holds money');
        const bought = await ColdMarket.tryPurchase(funded.state, goal);
        assert.equal(bought.purchased, true, 'the input is bought in the visit that posted the bids');
        assert.equal(Native.amount(await DB.fetchItems(9114), INPUT), 1);

        // Bot 2001024's visit (traced): the jewel root, a higher tier whose funded row stands first
        // in the queue, buys its input; a lower-tier root that values its own item more per Adena
        // is not funded. Its bid at the visit spent the money the queue held for the input
        // (3,158,709 of a 7,026,224 bag, the input refused for money, its weapon never bought):
        // a root the queue does not fund bids only with what the funded rows leave, and the input
        // is bought in the visit that posted the bids.
        const LOW = 852, LOW_WORTH = price, RESERVE = 570509;
        const tiers = [36000, 1e-6, RESERVE, 0, 1, price, 854];
        const lowTier = [{ itemId: LOW, amount: 1, worth: LOW_WORTH, key: `power:${LOW}:2`, recipeId: 0, valueHours: 2, valueRate: 2 }];
        const Funding = invoke('GameServer/Bot/Economy/PurchaseFunding');
        const traced = { adena: 7026224, stats: { money: [36000, 4.65e-7, RESERVE, 0, 1e-6, 4165614, 854] } };
        assert.equal(Funding.spendable(traced, 0, { r: 1e-6 }), 7026224 - RESERVE, 'fixture: the funded root reads the whole queue');
        assert.equal(Funding.spendable(traced, 0, { r: 2e-6 }), 7026224 - RESERVE - 4165614,
            'a root the queue does not fund reads what the funded row ahead of it leaves');
        Pricing.bid = selfId => { const unit = selfId === LOW ? LOW_WORTH : STOCK_PRICE;
            return { price: unit, count: 1, purchaseCap: unit, pricing: { price: unit } }; };
        const tracedVisit = await visit(9119, price + RESERVE + Math.floor(price / 2), tiers, lowTier);
        assert(await wallet(9119) >= price, 'the lower tier\'s bid leaves the bag the input\'s price');
        const tracedBuy = await ColdMarket.tryPurchase(tracedVisit.state, goal);
        assert.equal(tracedBuy.purchased, true, 'the input is bought in the visit that posted the bids');
        assert.equal(Native.amount(await DB.fetchItems(9119), INPUT), 1);

        // Bots 2000320 and 2001024 (traced): the jewel's other slot, a root of the same value per
        // Adena the queue does not fund, bid for the jewel (2,111,616 of a 5,904,338 bag) while the
        // visit bought the first slot's input: one ratio, so its rank read the funded slot's row as
        // its own, and the input was refused for money and re-taken. Each row names its root: the
        // other slot reads what the funded slot's row leaves, the bag keeps the input's price.
        const Packet = invoke('GameServer/Bot/Economy/StatsPacket');
        const slots = Packet.addFunded(Packet.money({ hourAdena: 36000, moneyPrice: 1e-6, refillReserve: RESERVE, firstUnfundedPrice: 0 }),
            1, price, 854, Packet.MONEY_ROWS, ROOT);
        const sameRank = [{ itemId: 854, amount: 1, worth: price, key: 'power:854:5', recipeId: 0,
            valueHours: 2 * price * 1e-6, valueRate: 1 }];
        const slotBag = price + RESERVE + Math.floor(price / 2);
        assert.equal(Funding.spendable({ adena: slotBag, stats: { money: slots } }, 0, Funding.goalTerms(goal)), slotBag - RESERVE,
            'the funded slot reads its own row');
        Pricing.bid = () => ({ price, count: 1, purchaseCap: price, pricing: { price } });
        const slotVisit = await visit(9120, slotBag, slots, sameRank);
        assert(await wallet(9120) >= price, 'the other slot\'s bid leaves the bag the input\'s price');
        const slotBuy = await ColdMarket.tryPurchase(slotVisit.state, goal);
        assert.equal(slotBuy.purchased, true, 'the input is bought in the visit that posted the bids');
        Pricing.bid = selfId => { const unit = selfId === 854 ? JEWEL_PRICE : STOCK_PRICE;
            return { price: unit, count: 1, purchaseCap: unit, pricing: { price: unit } }; };

        // A bag short of the input: refused for money, the visit ends, the step fails once and
        // marks its quote only, never the item (the build admits no step its bag cannot pay:
        // test_wish_network; the mark keeps the next build off the same step at the same money).
        raised.length = 0;
        const short = await visit(9115, price / 2);
        const refused = await ColdMarket.tryPurchase(short.state, goal);
        assert.equal(refused.purchased, false);
        assert.equal(refused.reason, 'funding_short');
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(raised.map(([, name, payload]) => [name, payload?.kind, payload?.key, !!payload?.town && payload?.price > 0]),
            [['goal_failed', 'gear_errand', INPUT, true]], 'the step fails once and marks its quote');

        // The root ranks above a stock bid whose escrow the purse counts: bag and escrow cover
        // the input, the bag alone does not. The buyer refuses it for money and marks its quote
        // (the build takes no shop step the bag cannot pay: test_wish_network).
        await bot(9116);
        const purse = (await DB.fetchItems(9116)).find(item => Number(item.selfId) === 57);
        await DB.updateItemAmount(9116, purse.id, price + STOCK_PRICE / 2);
        await Life.upsertState({ ...await Life.refreshInventory(Life.snapshot(9116)), adena: price + STOCK_PRICE / 2 }, 'held_purchase_fixture');
        await apply(9116, [[STOCK, 1, STOCK_PRICE]]);
        const escrow16 = Market.buyOrderEscrow(9116), bag16 = await wallet(9116);
        assert.equal(escrow16, STOCK_PRICE);
        assert(bag16 < price && bag16 + escrow16 >= price, 'the bag alone is short of the input');
        const rootFirst = [36000, 1e-6, 0, 0, 1, price + JEWEL_PRICE, 854, 0.5, price + JEWEL_PRICE + STOCK_PRICE, STOCK];
        const held = await Life.upsertState({ ...await Life.refreshInventory(Life.snapshot(9116)), adena: bag16,
            stats: { ...Life.snapshot(9116).stats, money: rootFirst } }, 'held_purchase_fixture');
        raised.length = 0;
        assert.equal((await ColdMarket.tryPurchase(held, goal)).reason, 'funding_short', 'the buyer refuses it for money');
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(raised.map(([, , payload]) => [payload?.key, !!payload?.town]), [[INPUT, true]], 'and marks its quote');
        // The build that took no step for it waits on the bag (bagShort): a bid taken back moves
        // its money from the escrow to the bag, the wallet stays, and that wait wakes the build.
        const Sections = invoke('GameServer/Bot/Economy/DecisionSections');
        const Situations = invoke('GameServer/Bot/Situations');
        const waiting = Life.snapshot(9116);
        const baseline = Sections.snapshot(waiting, { timestamp: Date.now(), statsPacket: {}, network: { bagShort: price }, persona: {} },
            { buyOrderEscrow: Market.buyOrderEscrow(9116) }, {});
        const armed = state => ({ ...state, stats: { ...state.stats, wishSections: baseline } });
        const wakes = (state, escrow) => Situations.detect(armed(waiting), armed(state), { escrow }).includes('goal_affordable:focus');
        assert(!wakes(waiting, Market.buyOrderEscrow(9116)), 'a bag short of the step wakes nothing');
        await Market.withdrawBuyAds(9116, STOCK);
        const paid = Life.snapshot(9116);
        assert(Funding.budget(paid) >= price && Market.buyOrderEscrow(9116) === 0, 'fixture: the bid\'s money is back in the bag');
        assert(wakes(paid, 0), 'a bag that pays the step wakes the build');

        // The visit's bid plan did not run (a sale visit, a plan pending or refused): the bot
        // still holds its bid for the root and the bag alone is short of the input. The step
        // names the root's bid (the card's bids): the buyer takes it back and buys the input in
        // this visit, no funding_short and no visit back for it.
        const ownBid = async id => {
            await bot(id);
            const half = Math.floor(price / 2);
            const purse = (await DB.fetchItems(id)).find(item => Number(item.selfId) === 57);
            await DB.updateItemAmount(id, purse.id, price + half);
            await Life.upsertState({ ...await Life.refreshInventory(Life.snapshot(id)), adena: price + half }, 'held_purchase_fixture');
            await apply(id, [[854, 1, price]]);
            assert.equal(Market.buyOrderEscrow(id), price, 'fixture: the root\'s bid holds the money');
            const held = await Life.upsertState({ ...await Life.refreshInventory(Life.snapshot(id)), adena: await wallet(id),
                stats: { ...Life.snapshot(id).stats, money: rootFirst } }, 'held_purchase_fixture');
            assert(Funding.budget(held) < price, 'fixture: the bag alone is short of the input');
            return held;
        };
        const own = await ColdMarket.tryPurchase(await ownBid(9117), { ...goal, plan: { ...goal.plan, bids: [854] } });
        assert.equal(own.purchased, true, 'the root\'s own bid pays its input');
        assert.equal(Native.amount(await DB.fetchItems(9117), INPUT), 1);
        assert.equal(Market.buyOrderEscrow(9117), 0, 'the bid was taken back to pay');
        // No seller at the card's price in this town: the visit gives up no bid for it.
        const unsold = await ColdMarket.tryPurchase(await ownBid(9118),
            { ...goal, target: { ...goal.target, adena: price - 1 }, plan: { ...goal.plan, bids: [854] } });
        assert.equal(unsold.purchased, false, 'fixture: no seller at the card\'s price');
        assert.equal(Market.buyOrderEscrow(9118), price, 'no seller, the root\'s bid stays on the board');
    } finally { Events.raiseOn = raiseOn; Pricing.bid = previousBid; Towns.buyAdTown = buyAdTown; }
    console.log('PASS held purchase visit: no root bid beside its input buy, a lower tier\'s bid leaves the funded input its money, one purse for planner and buyer, funding_short marks nothing, the bag\'s wait wakes, the root\'s own bid pays its step, no seller takes no bid back, another root of one rank leaves the held step its price');
}

// Bot 2001088 (traced): in town its builds and its served steps (no situation, the card
// serves) alternated about once a second. The build bids its wants by their roots; the
// card names the same wants without them, so each served step bid another set and
// replaced the held ads: 14 board writes in 50 s, the set flipping back and forth. Bids
// are the build's: a served step's visit plan carries none, the held ads stand, and the
// next build bids again.
async function servedStepHoldsBids() {
    const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
    const Warehouse = invoke('GameServer/Bot/Economy/PersonalWarehouseIndex');
    const Generation = require('../src/GameServer/Bot/Population/RecomputeGeneration');
    const Pricing = invoke('GameServer/Bot/Economy/MarketPricing');
    const Towns = invoke('GameServer/Bot/Economy/MarketTownPolicy');
    const kept = Generation.metadata(), previousBid = Pricing.bid, buyAdTown = Towns.buyAdTown;
    // A build holds only by its event proof, which needs the warehouse rows and a recompute generation.
    Warehouse.useRowSource(() => null, () => true);
    Generation.configure({ code: '1'.repeat(40), config: '2'.repeat(64) });
    const ASK = { 1864: 40, 1865: 300, 1866: 400 };
    Towns.buyAdTown = () => 'Giran';
    Pricing.bid = (selfId, ctx, { cap }) => cap >= ASK[selfId]
        ? { price: ASK[selfId], count: 1, purchaseCap: ASK[selfId], pricing: { price: ASK[selfId] } } : null;
    try {
        await bot(9121);
        const T = Date.now(), deps = { timestamp: T, board: Afk.boardIndex(), sourceReady: true, caller: 'step', decide: true };
        const built = Economy.forState(Life.snapshot(9121), deps);
        const wants = ids => ids.map(itemId => ({ itemId, amount: 1, worth: 5000, key: `resale:${itemId}`, recipeId: 0,
            valueHours: 5000 * built.network.moneyPrice, valueRate: 1 }));
        built.watchList = wants([1864, 1865, 1866]);
        const state = await Life.upsertState({ ...Life.snapshot(9121), stats: { ...Life.snapshot(9121).stats, ...built.statsPacket } },
            'served_step_fixture');
        const visit = economy => Plan.decide(state, economy, { visit: true, board: Afk.boardIndex(), now: T,
            npcOffersFor: () => [], findSpot: () => null, tripCost: economy.trip });
        const posted = () => records(9121).map(record => [record.id, record.revision, record.lines.map(line => line.selfId)]);
        const plan = visit(built);
        assert.deepEqual(plan.buyAds.map(row => row[0]), [1864, 1865, 1866], 'the build bids its wants');
        await Market.executePlan(Life.snapshot(9121), plan, { reviewGoal: false });
        const held = posted();
        assert.deepEqual(held.flatMap(row => row[2]).sort((a, b) => a - b), [1864, 1865, 1866], 'fixture: the build\'s bids stand');
        // The next step, on the same state, takes no build: its card serves.
        const served = Decision.refreshAdvisory(state, Decision.advisory(built, state), deps);
        assert(served, 'fixture: the card serves the step');
        const servedPlan = visit(served.economy);
        assert.equal(Object.hasOwn(servedPlan, 'buyAds'), false, 'a served step prepares no bids');
        await Market.executePlan(Life.snapshot(9121), servedPlan, { reviewGoal: false });
        assert.deepEqual(posted(), held, 'the held ads stand: no board write on a served step');
        // A build (a want of it dropped) bids again.
        built.watchList = wants([1864, 1865]);
        const rebuilt = visit(built);
        assert.deepEqual(rebuilt.buyAds.map(row => row[0]), [1864, 1865]);
        await Market.executePlan(Life.snapshot(9121), rebuilt, { reviewGoal: false });
        assert.deepEqual(posted().flatMap(row => row[2]).sort((a, b) => a - b), [1864, 1865], 'the next build changes its bids');
    } finally {
        Pricing.bid = previousBid; Towns.buyAdTown = buyAdTown;
        Generation.configure(kept); Warehouse.useRowSource(null);
    }
    console.log('PASS served step holds bids: the build bids, a served step prepares none and writes no board, the next build bids again');
}

// Bot 2001600 (traced): its build bid 1463 x1310 in Dion; a cold town step that bought
// nothing, with no build, then posted 1463 x1530 and 1458 x10 in Gludio, bids main read
// from its card. Such a step reviews the bot's ads on main: it leaves the build's bids as
// posted, and still takes them back when the goal is a purchase at an NPC (the trip pays
// from the wallet).
async function townStepKeepsBids() {
    const Population = invoke('GameServer/Bot/Population/PopulationService');
    const Needs = invoke('GameServer/Bot/Goals/NeedsEvaluator');
    const Town = invoke('GameServer/Bot/Economy/ColdMarketService');
    const Pricing = invoke('GameServer/Bot/Economy/MarketPricing');
    const needs = Needs.needs, errands = Town.finishTownErrands, previousBid = Pricing.bid;
    const goal = { type: 'buy_craft_material', status: 'active', target: { itemId: 1866, amount: 3 },
        plan: { expectedBenefit: 'market_buy_craft_material', estimatedCost: 5000, wishKey: 'power:101:7' } };
    let after = goal;
    Needs.needs = () => [after];
    Town.finishTownErrands = async state => state;
    // The card's view would bid the goal's item: one ask the bot's worth covers.
    Pricing.bid = (selfId, ctx, { cap }) => cap >= 100 ? { price: 100, count: 3, purchaseCap: 100,
        pricing: Pricing.lineState(selfId, ctx, { price: 100, storeType: Afk.BUY, enchant: 0, count: 3 }) } : null;
    try {
        await bot(9122);
        await apply(9122, [[1864, 2, 100], [1865, 2, 200]], 0);
        const posted = () => records(9122).map(record => [record.id, record.revision,
            record.lines.map(line => [line.selfId, line.count, line.price])]);
        const held = posted();
        assert.deepEqual(held.flatMap(row => row[2].map(line => line[0])).sort((a, b) => a - b), [1864, 1865],
            'fixture: the build\'s bids stand');
        assert(Market.canTradeRemotely(Life.snapshot(9122), goal), 'fixture: a goal the bot could bid on');
        const step = () => {
            const state = Life.snapshot(9122);
            return Population.finishColdMarketStep(state, null, false, { state, closed: true },
                { state, purchased: false }, after);
        };
        await step();
        assert.deepEqual(posted(), held, 'a town step without a purchase leaves the build\'s bids as posted');
        after = { ...goal, plan: { ...goal.plan, sourceType: 'npc' } };
        await step();
        assert.deepEqual(posted(), [], 'a purchase at an NPC takes the bids back');
        assert.equal(await wallet(9122), 1000000, 'their escrow is back in the bag');
    } finally {
        Needs.needs = needs; Town.finishTownErrands = errands; Pricing.bid = previousBid;
    }
    console.log('PASS town step keeps bids: a cold town step without a purchase changes no bid; an NPC purchase takes them back');
}

async function run() {
    DB.init(); invoke('GameServer/DataCache').init(); await Life.init();
    await heldPurchaseVisit();
    await servedStepHoldsBids();
    await townStepKeepsBids();
    await bot(9101);
    await apply(9101);
    assert.equal(shop(9101)?.storeType, Afk.BUY);
    assert.equal(shop(9101).custodyPolicy, 0);
    assert.deepEqual(shop(9101).lines.map(line => line.selfId), REQUESTS.slice(0, 3).map(row => row[0]), 'highest priority requests own the shop');
    assert.deepEqual(records(9101).filter(row => row.kind === 'buy_ad').map(row => row.lines[0].selfId), REQUESTS.slice(3).map(row => row[0]), 'five remaining requests use meetings');
    assert.equal(Afk.findOwnerProjection(9101).actor.fetchPrivateStoreType(), Afk.BUY);
    assert.equal(shop(9101).escrowAdena, cost(REQUESTS.slice(0, 3)));
    assert.equal(await wallet(9101) + shop(9101).escrowAdena, 1000000);
    const original = shop(9101);
    await apply(9101);
    assert.equal(shop(9101).id, original.id, 'unchanged requests retain the physical shop and line identities');
    assert.deepEqual(shop(9101).lines.map(row => row.id), original.lines.map(row => row.id));
    assert.equal(await wallet(9101) + Market.buyOrderEscrow(9101), 1000000, 'repeated publication cannot reserve twice');
    Afk._resetForTests();
    await Afk.init();
    assert.equal(shop(9101).id, original.id, 'restart restores the purchase projection and its reserved money');

    // A player sells into the visible purchase shop without a meeting.
    await Native.character(DB, 9201, 'Supplier', 'buy_shop_supplier', POINT);
    const source = Number((await DB.setItem(9201, { selfId: 1864, name: 'Stem', amount: 1, slot: 0 })).insertId);
    const sale = await Afk.sellToShop(9201, Afk.recordStore(shop(9101).id), 1864, 1, { objectId: source });
    assert.equal(sale.pending, undefined);
    assert.equal(await wallet(9201), 200);
    assert.equal(await owed(9101, 1864), 1, 'the far buyer\'s stem waits on the board for its own commit');
    assert.equal(shop(9101).lines.find(row => row.selfId === 1864).count, 1);
    const remaining = REQUESTS.map(row => row[0] === 1864 ? [1864, 1, row[2]] : row);
    await apply(9101, remaining);
    assert.equal(await wallet(9101) + Market.buyOrderEscrow(9101), 1000000 - 200);

    await Market.withdrawBuyAds(9101, 79);
    assert(shop(9101), 'fulfilling one item keeps other purchase lines open');
    assert.equal(shop(9101).lines.filter(row => row.count > 0).length, 2);
    await apply(9101, remaining.slice(1));
    assert.deepEqual(shop(9101).lines.map(row => row.selfId), [1864, 1865, 1866], 'a free line promotes the next meeting request');
    assert(!records(9101).filter(row => row.kind === 'buy_ad').some(row => row.lines[0].selfId === 1866), 'promotion retires the duplicate meeting offer atomically');
    await apply(9101, []);
    assert.equal(records(9101).length, 0);
    assert.equal(await wallet(9101), 1000000 - 200, 'closing refunds every remaining purchase reservation');

    // A full square leaves all affordable requests as meeting adverts.
    await bot(9102);
    const take = Places.take;
    try {
        Places.take = () => null;
        await apply(9102, REQUESTS.slice(0, 5));
    } finally { Places.take = take; }
    assert.equal(shop(9102), undefined);
    assert.equal(records(9102).length, 5);
    assert(records(9102).every(row => row.kind === 'buy_ad' && row.custodyPolicy === 1));
    assert.equal(await wallet(9102), 1000000);
    await apply(9102, REQUESTS.slice(0, 5));
    assert.equal(shop(9102).lines.length, 3, 'the next decision promotes requests when a place becomes available');

    // A more important purchase replaces a sale at the same reserved place.
    await bot(9103);
    const stock = Number((await DB.setItem(9103, { selfId: 1871, name: 'Charcoal', amount: 20, slot: 0 })).insertId);
    const place = Places.take('Giran', Places.afkOwner(9103));
    await Afk.publishBot(9103, { storeType: Afk.SELL, town: 'Giran', ...place,
        lines: [{ objectId: stock, selfId: 1871, count: 20, price: 150, stackable: true }] });
    await apply(9103, REQUESTS.slice(0, 2), 0);
    assert.equal(shop(9103).storeType, Afk.SELL, 'secondary wishes cannot evict the sale shop');
    await apply(9103, REQUESTS.slice(0, 2), Afk.BUY);
    assert.equal(shop(9103).storeType, Afk.BUY);
    assert.deepEqual([shop(9103).locX, shop(9103).locY], [place.locX, place.locY]);
    assert.equal(Native.amount(await DB.fetchItems(9103), 1871), 20, 'displaced sale stock returns to its owner');
    const before = await DB.fetchItems(9103), beforeShop = shop(9103);
    await assert.rejects(DB.replaceBoardRecords(9103, 'buy_ad', [], { expected: {}, buyShop: {
        expected: { id: beforeShop.id, revision: beforeShop.revision - 1 }, config: null
    } }), /afk_trade_shop_changed/);
    assert.deepEqual(await DB.fetchItems(9103), before, 'a stale shop decision changes no custody');
    assert.equal(shop(9103).id, beforeShop.id);
    await Market.executePlan(Life.snapshot(9103), { sell: [[1871, 20, 150, 'Giran', 0]],
        shop: 'Giran', buyShop: Afk.SELL }, { reviewGoal: false });
    assert.equal(shop(9103).storeType, Afk.SELL, 'a newly selected sale priority can recover the shop');
    assert.equal(Market.buyOrderEscrow(9103), 0, 'sale priority refunds the purchase reservation');

    // Failure after withdrawing a sale must roll back both its stock and the old ads.
    await bot(9104);
    const itemId = Number((await DB.setItem(9104, { selfId: 1871, name: 'Charcoal', amount: 20, slot: 0 })).insertId);
    await Afk.publishBot(9104, { storeType: Afk.SELL, town: 'Giran', ...Places.take('Giran', Places.afkOwner(9104)),
        lines: [{ objectId: itemId, selfId: 1871, count: 20, price: 150, stackable: true }] });
    const old = shop(9104), oldBag = await DB.fetchItems(9104);
    await assert.rejects(DB.replaceBoardRecords(9104, 'buy_ad', [], { expected: {}, buyShop: {
        expected: { id: old.id, revision: old.revision },
        config: { ...old, storeType: Afk.BUY,
            lines: [{ selfId: 79, count: 1, price: 2000000 }] }
    } }), /not_enough_adena|economy_funding_changed/);
    assert.equal(shop(9104).id, old.id);
    assert.deepEqual(await DB.fetchItems(9104), oldBag);

    await bot(9105);
    const alternatives = REQUESTS.slice(0, 3).map(([selfId, count, price]) =>
        [selfId, count, price, 1, 79, 7, 0, 100, 1]);
    await Market.executePlan(Life.snapshot(9105), { buyAds: alternatives, buyShop: Afk.BUY }, { reviewGoal: false });
    assert.equal(shop(9105).lines.length, 1, 'alternatives for one root cannot reserve both product and materials');
    assert.equal(records(9105).filter(row => row.kind === 'buy_ad').length, 2);

    // A kept purchase shop's escrow stays locked: it cannot back a new meeting bid.
    await bot(9106);
    await apply(9106, REQUESTS.slice(0, 3));
    const kept = shop(9106);
    assert.equal(records(9106).length, 1);
    const cash = (await DB.fetchItems(9106)).find(item => Number(item.selfId) === 57);
    await DB.updateItemAmount(9106, cash.id, 1000);
    const keptLines = kept.lines.map(line => ({ selfId: line.selfId, enchant: line.enchant, count: line.count,
        price: line.price, name: line.name }));
    await assert.rejects(DB.replaceBoardRecords(9106, 'buy_ad', [{ storeType: Afk.BUY, title: 'WTB', town: 'Giran', ...POINT,
        lines: [{ selfId: 1867, count: 1, price: 1500, name: 'Item 1867' }] }], { expected: {}, buyShop: {
        expected: { id: kept.id, revision: kept.revision },
        config: { storeType: Afk.BUY, title: kept.title, town: kept.town, locX: kept.locX, locY: kept.locY, locZ: kept.locZ, lines: keptLines }
    } }), /not_enough_adena/, 'the free wallet (1000) cannot back a 1500 bid while 1100 stays in the kept shop');
    assert.equal(shop(9106).id, kept.id);
    assert.equal(shop(9106).escrowAdena, kept.escrowAdena);
    assert.equal(records(9106).length, 1);

    // An unchanged order keeps its records as they stand: a cheaper quote
    // within the prepared cap keeps the held bids, no record is rewritten.
    await bot(9107);
    await apply(9107);
    const standing = shop(9107);
    const standingAds = records(9107).filter(row => row.kind === 'buy_ad').map(row => [row.id, row.revision]);
    const quoted = REQUESTS.map(([selfId, count, price]) => ({ selfId, count, price: price - 50, purchaseCap: price,
        enchant: 0, name: `Item ${selfId}` }));
    const published = await BuyShop.publish(Life.snapshot(9107), quoted, 'Giran', { priority: Afk.BUY, appearance: async () => ({}) });
    assert.equal(published.changed, false);
    assert.equal(published.shop?.id, standing.id);
    assert.equal(shop(9107).id, standing.id, 'the standing purchase shop is kept');
    assert.equal(shop(9107).revision, standing.revision);
    assert.deepEqual(shop(9107).lines.map(line => line.price), standing.lines.map(line => line.price), 'held bids keep their price');
    assert.deepEqual(records(9107).filter(row => row.kind === 'buy_ad').map(row => [row.id, row.revision]), standingAds);
    assert.equal(await wallet(9107) + Market.buyOrderEscrow(9107), 1000000);

    const batch = Plan.buyBatch(REQUESTS.map(([selfId, count, price]) => ({ selfId, count, price })));
    assert.equal(batch.buyAds.length, 8, 'worker transport carries the shop and meeting slots');
    const captured = Decision.capture({ inputKey: 'eight-purchase-requests', network: {
        activity: { activity: 'shopping', kind: 'buy', rootKey: 'power:79:7', itemId: 79, amount: 1, price: 100 },
        queue: [{ key: 'power:79:7', object: { itemId: 79 }, price: 100 }]
    }, watchList: REQUESTS.map(([itemId, amount, worth]) => ({ itemId, amount, worth, kind: 'improvement' })) }, Life.snapshot(9104));
    assert.equal(captured.watch.length, 8, 'hot/cold decision cards retain the overflow needs');
    assert.equal(captured.activity.itemId, 79, 'the extended watch does not corrupt activity offsets');
    assert(captured.data.byteLength < Decision.MAX_BYTES);
    await noGradeBidTown();
    await bot(9112);
    const Policy = invoke('GameServer/Bot/Economy/BuyAdPolicy');
    const Pricing = invoke('GameServer/Bot/Economy/MarketPricing');
    const previousBid = Pricing.bid;
    const trip = () => 0; trip.details = () => ({ known: true, hours: 0, fees: 0 });
    const watch = [1864, 1864, 1865, 1866, 1867].map((itemId, at) => ({ itemId, amount: 1, worth: 100,
        key: at === 0 ? 'power:79:7' : at === 1 ? 'power:80:7' : `resale:${itemId}`,
        recipeId: 0, valueHours: 1, valueRate: 1 }));
    let planned;
    try {
        Pricing.bid = () => ({ price: 100, count: 1, purchaseCap: 100, pricing: { price: 100 } });
        planned = Policy.linesFor(Life.snapshot(9112), null, { watchList: watch, board: Afk.boardIndex(),
            townFor: () => 'Giran', npcOffersFor: () => [], economy: { moneyPrice: .001, hourAdena: 1000,
                worth: () => 100, trip, persona: { traits: {} }, network: { moneyPrice: .001 } } });
    } finally { Pricing.bid = previousBid; }
    assert.deepEqual(planned.map(row => row.selfId), [1864, 1865, 1866, 1867]);
    const deduplicatedPlan = { ...Plan.buyBatch(planned), buyShop: Afk.BUY };
    await Market.executePlan(Life.snapshot(9112), deduplicatedPlan, { reviewGoal: false });
    const once = records(9112).flatMap(record => record.lines.map(line => line.selfId));
    assert.deepEqual(once.sort((a, b) => a - b), [1864, 1865, 1866, 1867],
        'the real transaction publishes each physical item once');
    await Market.executePlan(Life.snapshot(9112), deduplicatedPlan, { reviewGoal: false });
    assert.deepEqual(records(9112).flatMap(record => record.lines.map(line => line.selfId)).sort((a, b) => a - b), once,
        'replaying the prepared unique batch does not create duplicate ads');
    await autonomousSale();
    console.log('PASS bot AFK buy shops: priority, escrow, overflow, fill, refund, promotion, full square and atomic replacement');
}
run().then(async () => { Afk._resetForTests(); await DB.close(); fs.rmSync(fixture.directory, { recursive: true, force: true }); })
    .catch(async error => { console.error(error); await DB.close(); process.exitCode = 1; });
