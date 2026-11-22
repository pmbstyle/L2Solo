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
assert.equal(Config.staticShotsDisabled, false, 'the reserve switch is open by default');
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
        // No static shot row sells to a bot (the configured shot stores are the
        // players'): an empty market quotes no D soulshots; a crafter's board line is
        // the bot's supply, on main and in the worker alike.
        assert.equal(Sources.npcOffersFor(1463).length, 0, 'D shots have no authored native NPC source');
        assert.deepEqual(Offers.fixedStoreOffers(1463), [], 'no configured D soulshot row for a bot');
        assert.equal(require('../src/GameServer/Bot/Economy/OfferQuery').sourceAllowed({ sourceType: 'configured_store',
            selfId: 1463, sourceName: 'Reanimator' }), false, 'a static shot row is refused to a bot');
        assert.equal(read(), null, 'an empty market quotes no static shot supply');
        const board = new BoardIndex();
        board.put({ id: 1, ownerId: 2, storeType: 1, kind: 'sell_ad', town: 'Dion',
            lines: [{ lineId: 1, selfId: 1463, count: 36, price: 85 }] });
        const live = read(board);
        assert.equal(live.sourceType, 'afk', 'the live line is the offer');
        assert.equal(live.availableUnits, 36, 'finite market stock stays finite');
        assert.equal(live.unitPrice, 85);
        assert.equal(Evidence.reader(state, { board: empty, trip }, { npcOffersFor: () => [] })(1869), null,
            'configured non-shot supply remains retired');
        const native = await workerQuote();
        assert.deepEqual(native.fallbackQuote, null, 'the worker quotes no static shot supply either');
        assert.deepEqual(native.forbidden, [], 'the worker loads no World actor, database or network');
        console.log('PASS no static D shot supply for bots, live market line, source policy and native worker');
    } finally { fs.rmSync(fixture.directory, { recursive: true, force: true }); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
