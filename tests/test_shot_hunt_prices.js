'use strict';
const assert = require('node:assert/strict');
const { Worker } = require('node:worker_threads');
const path = require('node:path');
require('./helpers/databaseIsolation');
process.env.L2NODE_CONFIG_FILE = 'config/default.ini';
require('../src/Global');
require('./helpers/progressionRate').useRate('x50');
const Data = invoke('GameServer/DataCache'); Data.init({ validate: false });
const Prices = invoke('GameServer/Bot/Economy/StaticMerchantPricing');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const Counters = invoke('GameServer/Bot/Economy/MarketCounters');
const Hunt = invoke('GameServer/Bot/AI/BotHuntEfficiency');
const Shots = invoke('GameServer/Inventory/ShotStock');
const Table = invoke('GameServer/Bot/AI/SpotValueTable');
const { BoardIndex, rowOf } = require('../src/GameServer/AfkTrade/BoardIndex');
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
const Geodata = require('../src/GameServer/Geodata/GeodataEngine');
const board = new BoardIndex(), oldDisabled = Config.staticShotsDisabled;
const oldBest = Table.best;
const ids = [1464, 2511, 3949], quotes = [240, 500, 1200];
const record = { id: 910920, ownerId: 910921, kind: 'shop', storeType: 1, town: 'Giran', revision: 1,
    lines: ids.map((selfId, at) => ({ id: 9109200 + at, lineId: 9109200 + at, selfId, count: 100, price: quotes[at] })) };

async function workerPrices() {
    const worker = new Worker(String.raw`
        const fs = require('node:fs'), Module = require('node:module'), path = require('node:path');
        const { parentPort, workerData } = require('node:worker_threads');
        const loaded = new Module(workerData.workerPath, module);
        loaded.filename = workerData.workerPath; loaded.paths = Module._nodeModulePaths(path.dirname(workerData.workerPath));
        loaded._compile(fs.readFileSync(workerData.workerPath, 'utf8'), workerData.workerPath);
        parentPort.on('message', message => {
            if (!message.probePrices) return;
            const prices = message.ids.map(id => invoke('GameServer/Bot/Economy/StaticMerchantPricing').botBuyPrice(id));
            parentPort.postMessage({ probePrices: prices, forbidden: Object.keys(require.cache).filter(key =>
                /\/src\/Database\.js$|\/Network\/|\/World\/World\.js$/.test(key)) });
        });`, { eval: true, workerData: { workerEpoch: 'shot-hunt-prices', sharedGeodata: Geodata.sharedDescriptor(),
        workerPath: path.resolve(__dirname, '../src/GameServer/Bot/Population/ColdSimulationWorker.js') } });
    try {
        return await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(Error('shot price worker timeout')), 30000);
            worker.on('error', error => { clearTimeout(timer); reject(error); });
            worker.on('message', message => {
                if (message.type === 'ready' && message.payload.phase === 'loaded') {
                    worker.postMessage(Protocol.envelope('table_page', 'shot-hunt-prices', { tables: [
                        { name: 'board', from: null, to: 0, full: true, rows: [[record.id, rowOf(record)]], removed: [], last: true }
                    ] }, 'board'));
                    worker.postMessage({ ...Protocol.envelope('pause', 'shot-hunt-prices', {}, 'prices'), probePrices: true, ids });
                }
                if (message.probePrices) { clearTimeout(timer); resolve(message); }
                if (message.type === 'fault') { clearTimeout(timer); reject(Error(JSON.stringify(message))); }
            });
        });
    } finally { await worker.terminate(); }
}

(async () => {
    Config.staticShotsDisabled = true; Prices.useBoard(() => board); Counters.reset();
    Counters.useSpots(() => invoke('GameServer/Bot/Population/SpotProfiles').ensure());
    for (const id of ids) {
        assert.equal(Prices.botPurchasePrice(id), Infinity, 'a valuation does not enable static suppliers');
        assert.equal(Prices.botBuyPrice(id), Counters.firstPrice(id), 'absent supply uses native craft value');
        assert(Prices.botBuyPrice(id) > Data.items.find(row => row.selfId === id).template.price);
    }
    Counters.deal(1464, 300, 100, Date.now(), 2, 'Giran', 3);
    assert.equal(Prices.botBuyPrice(1464), 300, 'paid evidence replaces the initial estimate');
    board.put(record);
    assert.deepEqual(ids.map(id => Prices.botBuyPrice(id)), quotes, 'current stock replaces historical prices');
    const weapon = Data.items.find(row => row.etc?.rank === 'c' && [7, 14].includes(row.etc?.slot)
        && String(row.template?.kind).startsWith('Weapon.') && row.etc.spiritshot > 0);
    assert(weapon);
    for (const [at, id] of ids.entries()) {
        const state = { level: 40, stats: { classId: id === 1464 ? 1 : 27 },
            inventory: { [weapon.selfId]: { selfId: weapon.selfId, amount: 1, equipped: true, slot: weapon.etc.slot },
                [id]: { selfId: id, amount: id === 1464 ? weapon.etc.soulshot : weapon.etc.spiritshot } } };
        assert.equal(Shots.planForState(state).selfId, id);
        assert.equal(Hunt.consumablePrices(state).shots, quotes[at], 'hunting uses the actual shot replacement value');
    }
    const mirrored = await workerPrices();
    assert.deepEqual(mirrored.probePrices, quotes, 'main and worker value their own public board identically');
    assert.deepEqual(mirrored.forbidden, [], 'the price reader loads no live world or database in the worker');

    Table.best = (role, level, shots) => ({ exp: shots === 2 ? 300 : shots ? 150 : 100,
        shots: 100, adena: 100000, loot: 0 });
    const emptyCaster = { level: 40, stats: { classId: 27 }, inventory: {
        [weapon.selfId]: { selfId: weapon.selfId, amount: 1, equipped: true, slot: weapon.etc.slot } } };
    board.put({ ...record, revision: 2, lines: record.lines.map(line => ({ ...line,
        price: line.selfId === 3949 ? 75 : line.selfId === 2511 ? 50 : line.price })) });
    assert.equal(Shots.planForState(emptyCaster).kind, 'blessedSpiritshot');
    board.put({ ...record, revision: 3, lines: record.lines.map(line => ({ ...line,
        price: line.selfId === 3949 ? 1000 : line.selfId === 2511 ? 50 : line.price })) });
    assert.equal(Shots.planForState(emptyCaster).kind, 'spiritshot', 'a moved market price invalidates the blessed choice');
    assert.equal(Prices.botBuyPrice(1835), Prices.botPurchasePrice(1835), 'no-grade keeps its NPC valuation');
    console.log('PASS shot hunting prices: craft fallback, paid trades, public quotes, worker parity and blessed choice');
})().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(() => {
    Config.staticShotsDisabled = oldDisabled; Prices.useBoard(null); Counters.reset(); Table.best = oldBest;
});
