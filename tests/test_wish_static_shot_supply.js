'use strict';
const assert = require('node:assert/strict');
const { useRate } = require('./helpers/progressionRate');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('wish-static-shots');
require('../src/Global');
const Geodata = require('../src/GameServer/Geodata/GeodataEngine');
fixture.assertConfigured(options.default);
useRate('x50');
const fs = require('node:fs'), path = require('node:path'), { Worker } = require('node:worker_threads');
const Data = invoke('GameServer/DataCache'); Data.init();
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
assert.equal(Config.staticShotsDisabled, false, 'configured shot fallback is enabled for all bots by default');
const Evidence = require('../src/GameServer/Bot/Economy/WishPurchaseEvidence');
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
const Offers = invoke('GameServer/Bot/Economy/MarketOpportunity');
const Sources = invoke('GameServer/Bot/Population/ColdOccupationSources'); Sources.initialise();
const trip = town => town === 'Dion' ? 0 : Infinity;
trip.details = town => ({ known: town === 'Dion', hours: 0, fees: 0 });
const state = { characterId: 710071, name: 'ShotBuyer', level: 28, phase: 'cold', activity: 'shopping',
    currentRegion: 'Dion', loc: { locX: 15670, locY: 142910, locZ: -2702 },
    stats: { classId: 50 }, inventory: {}, adena: 1000000, timing: {},
    vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 } };
const empty = new BoardIndex();
const read = (board = empty, cost = trip) => Evidence.reader(state, { board, trip: cost }, {
    npcOffersFor: Sources.npcOffersFor })(1463);
async function nativePurchase(quote) {
    const Database = invoke('Database'), Life = invoke('GameServer/Bot/Population/BotLifeState');
    const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
    const Market = invoke('GameServer/Bot/Economy/ColdMarketService');
    const { character, amount } = require('./helpers/nativeMarketFixture');
    fixture.assertConfigured(options.default);
    await Database.init();
    try {
        await character(Database, state.characterId, state.name, 'bot_shot_fallback', state.loc);
        await Database.setItem(state.characterId, { selfId: 57, name: 'Adena', amount: state.adena });
        await Database.setItem(state.characterId, { selfId: 167, name: 'Scalpel', amount: 1, equipped: true, slot: 7 });
        await Life.init(); await Afk.init();
        const buyer = await Life.upsertState({ ...state,
            inventory: Life.inventorySummaryFromItems(await Database.fetchItems(state.characterId)),
            stats: { ...state.stats, money: [state.adena, 0, 0, 0] } }, 'static_shot_fixture');
        // Quote -> compact transport -> native goal -> physical transaction.
        // The funded shopping leaf is explicit here; this is no live bot override.
        const leaf = require('../src/GameServer/Bot/Population/ColdEconomyDecision').compact({ key: 'fixed-shots',
            activity: { ...quote, rootKey: 'stock:shots', activity: 'shopping', itemId: 1463,
                amount: 25, heldAtDecision: 0, price: 25 * quote.unitPrice } }).activity;
        const goal = invoke('GameServer/Bot/Goals/NeedsEvaluator').evaluate(buyer, { errand: null,
            economy: { inputKey: 'fixed-shots', network: { activity: leaf } } })[0];
        assert.equal(goal.plan.sourceType, 'configured_store');
        assert.equal(goal.plan.marketTown, quote.town);
        assert.equal(goal.target.adena, quote.unitPrice);
        const Remote = invoke('GameServer/Bot/Economy/BotAfkMarketService');
        const Bids = invoke('GameServer/Bot/Economy/ColdMarketBuyStoreService');
        const originalBid = Bids.bidFor;
        Bids.bidFor = () => ({ count: 25, price: quote.unitPrice });
        try {
            assert.equal(Remote.canTradeRemotely({ ...buyer, activity: 'hunting',
                stats: { ...buyer.stats, generatedCold: true } }, goal), false,
                'a configured shopping goal must travel to its seller instead of becoming a remote bid');
        } finally { Bids.bidFor = originalBid; }
        const BuyAds = require('../src/GameServer/Bot/Economy/BuyAdPolicy');
        assert.equal(BuyAds.bidFor(buyer, goal), null,
            'legacy goal publication cannot duplicate the native configured purchase');
        assert.deepEqual(BuyAds.linesFor(buyer, goal, { watchList: [], townFor: () => quote.town }), [],
            'the complete legacy buy batch cannot duplicate the native configured purchase');
        const result = await Market.tryPurchase(buyer, goal);
        assert.equal(result.purchased, true);
        assert.equal(result.units, 25);
        const items = await Database.fetchItems(buyer.characterId);
        assert.equal(amount(items, 1463), 25);
        assert.equal(amount(items, 57), state.adena - 25 * quote.unitPrice);
        assert.equal(Life.cachedState(buyer.characterId).inventory[1463].amount, 25);
        const trades = await Database.readHistory(['SELECT * FROM market_trades WHERE buyerCharacterId=? AND selfId=?',
            [buyer.characterId, 1463]]);
        assert.equal(trades.length, 1);
        assert.equal(trades[0].sourceType, 'configured_store');
        assert.equal(trades[0].sellerName, 'Reanimator');
        assert.equal(trades[0].quantity, 25);
        assert.equal(trades[0].unitPrice, quote.unitPrice);
        assert.equal(trades[0].town, quote.town);
        console.log('PASS selected configured quote reaches physical inventory/wallet and named market history');
    } finally { await Afk._resetForTests(); await Database.close(); }
}
async function workerQuote() {
    const observer = String.raw`
        const fallbackTrip = town => town === 'Dion' ? 0 : Infinity;
        fallbackTrip.details = town => ({ known: town === 'Dion', hours: 0, fees: 0 });
        Config.staticShotsDisabled = false;
        OccupationSources.initialise();
        const quote = require('../Economy/WishPurchaseEvidence').reader({ characterId: 710071 },
            { board: new BoardIndex(), trip: fallbackTrip }, { npcOffersFor: OccupationSources.npcOffersFor })(1463);
        parentPort.postMessage({ fallbackQuote: quote, forbidden: Object.keys(require.cache).filter(key =>
            /\/Database\.js$|\/Network\/|\/World\/World\.js$/.test(key)) });
    `;
    const worker = new Worker(String.raw`
        const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
        const { parentPort, workerData } = require('node:worker_threads');
        const loaded = new Module(workerData.workerPath, module);
        loaded.filename = workerData.workerPath; loaded.paths = Module._nodeModulePaths(path.dirname(workerData.workerPath));
        loaded._compile(fs.readFileSync(workerData.workerPath, 'utf8') + workerData.observer, workerData.workerPath);
    `, { eval: true, workerData: { workerEpoch: 'static-shot-supply', sharedGeodata: Geodata.sharedDescriptor(),
        observer, workerPath: path.resolve(__dirname, '../src/GameServer/Bot/Population/ColdSimulationWorker.js') } });
    try {
        return await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(Error('static shot worker quote timeout')), 30000);
            worker.on('error', error => { clearTimeout(timer); reject(error); });
            worker.on('message', message => {
                if (Object.hasOwn(message, 'fallbackQuote')) { clearTimeout(timer); resolve(message); }
            });
        });
    } finally { await worker.terminate(); }
}
(async () => {
    try {
        assert.equal(Sources.npcOffersFor(1463).length, 0, 'D shots have no authored native NPC source');
        const fixed = Offers.fixedStoreOffers(1463).find(offer => offer.town === 'Dion');
        assert(fixed && fixed.price === 500, 'the real x50 configured merchant is available');
        const fallback = read();
        assert(fallback, 'an empty market retains configured shot supply');
        assert.equal(fallback.sourceType, 'configured_store');
        assert.equal(fallback.availableUnits, Infinity);
        assert.equal(fallback.unitPrice, fixed.price);
        assert.equal(fallback.town, 'Dion');
        const board = new BoardIndex();
        board.put({ id: 1, ownerId: 2, storeType: 1, kind: 'sell_ad', town: 'Dion',
            lines: [{ lineId: 1, selfId: 1463, count: 36, price: 185 }] });
        const live = read(board);
        assert.equal(live.sourceType, 'afk', 'cheaper live supply remains the preferred offer');
        assert.equal(live.availableUnits, 36, 'finite market stock stays finite');
        assert.equal(live.unitPrice, 185);
        assert.equal(read(empty, () => 0), null, 'no quote without a prepared route');
        const unreachable = () => Infinity;
        unreachable.details = () => ({ known: false, hours: NaN, fees: NaN });
        assert.equal(read(empty, unreachable), null, 'configured supply cannot invent a reachable city');
        Config.staticShotsDisabled = true;
        assert.equal(read(), null, 'disabled fixed shot supply stays unavailable');
        Config.staticShotsDisabled = false;
        assert.equal(Evidence.reader(state, { board: empty, trip }, { npcOffersFor: () => [] })(1869), null,
            'configured non-shot supply remains retired');
        const intent = require('../src/GameServer/Bot/Economy/TradeIntent').project({}, {
            quantityPrepared: true, queue: [{ key: 'stock:shots', object: { itemId: 1463 }, valueHours: 1, ratio: 1,
                plan: { missingAmount: 25, requirements: [{ key: 'item:1463', amount: 25,
                    plan: { ...fallback, executable: true, missingAmount: 25, requirements: [] } }] } }]
        }, {}, () => 500);
        assert.deepEqual(intent, [], 'an executable configured purchase retains its native owner');
        const native = await workerQuote();
        assert.deepEqual(native.fallbackQuote, fallback, 'native worker and main share the same configured quote');
        assert.deepEqual(native.forbidden, [], 'the worker loads no World actor, database or network');
        assert.equal(invoke('Database').isReady(), false);
        await nativePurchase(fallback);
        console.log('PASS configured D shot fallback, cheaper finite market, source policy, prepared route and native worker');
    } finally { fs.rmSync(fixture.directory, { recursive: true, force: true }); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
