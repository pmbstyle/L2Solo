'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
delete process.env.L2NODE_SHARED_CONFIG_FILE;
process.env.L2NODE_CONFIG_FILE = 'config/default.ini';
require('../src/Global');
const Geodata = require('../src/GameServer/Geodata/GeodataEngine');
const path = require('node:path'), { Worker } = require('node:worker_threads');
const Data = invoke('GameServer/DataCache'); Data.init();
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
const { npcPlanningCatalogRows } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');
const spots = invoke('GameServer/Bot/Population/SpotProfiles').ensure();
const now = Date.now(), id = 710071;
const state = { characterId: id, name: 'oONetManaOo', level: 27, exp: Number(Data.experience[26]), sp: 0,
    adena: 1000000, phase: 'cold', activity: 'shopping', currentRegion: 'Giran', spotId: String(spots[0].id), updatedAt: now,
    loc: { locX: 83396, locY: 147904, locZ: -3400 },
    vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 },
    inventory: invoke('GameServer/Bot/Population/BotLifeState').inventorySummaryFromItems([
        { id: 710101, selfId: 167, amount: 1, equipped: 1, slot: 7 },
        { id: 710102, selfId: 1463, amount: 350, equipped: 0, slot: 0 },
        { id: 710103, selfId: 1869, amount: 5, equipped: 0, slot: 0 }]),
    stats: { classId: 50, generatedCold: true, classProgressionClassId: 50, classProgressionLevel: 27 },
    timing: { lastResolvedAt: now - 1000, nextResolveAt: now + 60000 } };
const observer = String.raw`
module.exports.personalShotProbe = async id => {
    const state = kernel.states.get(id).state, authority = require('../Economy/EconomyCommit').authority(state);
    const record = (selfId, recordId, ownerId = id, storeType = 1) => boardIndex.put({ id: recordId,
        kind: storeType === 1 ? 'sell_ad' : 'buy_ad', storeType, ownerId, botOwned: true, town: 'Giran',
        revision: 1, custodyPolicy: 1, lines: [{ lineId: recordId+1, selfId, enchant: 0, count: 350, price: 188 }] });
    const request = (selfId, adId) => ({ token: 'personal-shot-'+adId, actorA: id, actorB: id+1, seqA: 0, seqB: 0,
        town: 'Giran', point: { locX: 83396, locY: 147904, locZ: -3400 },
        parties: [0,1].map(() => ({ ...authority, sequence: 0, needRevision: authority.revision,
            route: { fee: 0, scroll: false, method: 'walk', durationMs: 0 } })),
        lines: [{ payer: 1, itemId: selfId === 1463 ? 710102 : 710103, selfId, enchant: 0, count: 1,
            price: 188, adId, adRevision: 1, certificate: null }] });
    record(1869, 710080);
    const ordinarySale = await kernel.prepareMeeting(id, request(1869, 710080));
    const rejected = [];
    for (const [recordId, ownerId, side] of [[710082,id,1], [710084,id+1,3]]) {
        record(1463, recordId, ownerId, side);
        try { await kernel.prepareMeeting(id, request(1463, recordId)); rejected.push(null); }
        catch (error) { rejected.push(error.message); }
    }
    // Keeping an old weapon grade must not block legitimate surplus sales.
    delete state.inventory[167];
    state.inventory[228] = { selfId: 228, amount: 1, equipped: true, slot: 7 };
    const oldGradeSale = await kernel.prepareMeeting(id, request(1463, 710082));
    // A seller with a funded goal cannot pay a gatekeeper fare from money
    // protected for that goal. Native acceptance applies that rule even when
    // the seller's physical wallet is ample.
    const entry = kernel.states.get(id);
    entry.state = { ...state, stats: { ...state.stats, money: [1000, .001, 0, 500] } };
    occupationPlanner.cancel(id);
    const distant = request(1869, 710080);
    distant.town = 'Orc Village'; distant.point = { locX: -44600, locY: -112400, locZ: -240 };
    let unfundedFare;
    try { await kernel.prepareMeeting(id, distant); unfundedFare = 'accepted'; }
    catch (error) { unfundedFare = error.message; }
    occupationPlanner.cancel(id);
    const freeFare = await kernel.prepareMeeting(id, request(1869, 710080));
    // A conditional held SELL line may also answer a selected foreign WTB.
    // The fresh worker check must preserve that choice while still reading the
    // current bid and the seller's actual unreserved stack.
    boardIndex.put({ id: 710090, kind: 'buy_ad', storeType: 3, ownerId: id + 1,
        botOwned: true, town: 'Giran', revision: 1, custodyPolicy: 1,
        lines: [{ lineId: 710091, selfId: 1869, enchant: 0, count: 5, price: 10000 }] });
    const selectedSale = request(1869, 710090);
    selectedSale.lines[0].price = 10000;
    const choice = invoke('GameServer/Bot/Economy/PriceDecision'), previousChoice = choice.chooseByValue;
    let heldSale;
    try {
        choice.chooseByValue = options => options.find(row => row.action === 'keep') || null;
        occupationPlanner.cancel(id);
        heldSale = await kernel.prepareMeeting(id, selectedSale);
    } finally { choice.chooseByValue = previousChoice; }
    return { rejected, ordinarySale: ordinarySale.token, oldGradeSale: oldGradeSale.token, unfundedFare, freeFare: freeFare.token,
        heldSale: heldSale.token,
        forbiddenLoaded: Object.keys(require.cache).filter(key => /\/Database\.js$|\/Network\/|\/World\/World\.js$/.test(key)) };
};`;
const wrapper = String.raw`
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const { parentPort, workerData } = require('node:worker_threads');
const loaded = new Module(workerData.workerPath, module);
loaded.filename = workerData.workerPath; loaded.paths = Module._nodeModulePaths(path.dirname(workerData.workerPath));
loaded._compile(fs.readFileSync(workerData.workerPath, 'utf8') + workerData.observer, workerData.workerPath);
parentPort.on('message', message => {
    if (!message.personalShotProbe) return;
    loaded.exports.personalShotProbe(message.personalShotProbe).then(value => parentPort.postMessage({ probeId: message.msgId, value }))
        .catch(error => parentPort.postMessage({ probeId: message.msgId, error: error.stack }));
});`;
(async () => {
    const epoch = 'native:personal-shots', messages = []; let fault;
    const worker = new Worker(wrapper, { eval: true, workerData: { sharedGeodata: Geodata.sharedDescriptor(), workerEpoch: epoch, observer,
        workerPath: path.resolve(__dirname, '../src/GameServer/Bot/Population/ColdSimulationWorker.js') } });
    worker.on('message', message => messages.push(message)); worker.on('error', error => { fault = error; });
    const wait = async predicate => { const deadline = Date.now() + 60000;
        while (!messages.some(predicate)) {
            if (fault) throw fault;
            const rejected = messages.find(message => message.type === 'fault'); if (rejected) throw Error(JSON.stringify(rejected));
            if (Date.now() > deadline) throw Error('personal shot worker timeout');
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        return messages.find(predicate);
    };
    const send = (type, payload, msgId) => worker.postMessage(Protocol.envelope(type, epoch, payload, msgId));
    try {
        await wait(message => message.type === 'ready' && message.payload.phase === 'loaded');
        const catalog = npcPlanningCatalogRows();
        for (let at = 0; at < catalog.length; at += Protocol.MAX_BATCH) send('catalog_page', { catalog: 'npc_offers',
            rows: catalog.slice(at, at + Protocol.MAX_BATCH), done: at + Protocol.MAX_BATCH >= catalog.length });
        for (let at = 0; at < spots.length; at += Protocol.MAX_BATCH) send('catalog_page', { catalog: 'spots',
            rows: spots.slice(at, at + Protocol.MAX_BATCH) });
        send('init', { config: { loopIntervalMs: 1000 } }, 'init');
        await wait(message => message.type === 'ready' && message.payload.phase === 'running'); send('pause', {}, 'pause');
        send('table_page', { tables: [{ name: 'board', from: null, to: 0, full: true,
            rows: [], removed: [], last: true }] });
        send('snapshot_page', { rows: [{ state }], ack: true }, 'state');
        await wait(message => message.type === 'ready' && message.msgId === 'state');
        worker.postMessage({ ...Protocol.envelope('pause', epoch, {}, 'probe'), personalShotProbe: id });
        const response = await wait(message => message.probeId === 'probe'); if (response.error) throw Error(response.error);
        assert.deepEqual(response.value.rejected, ['trade_meeting_protected_stock', 'trade_meeting_protected_stock'],
            'the real Orc worker rejects both an old own SELL quote and a new WTB answer for current D shots');
        assert.equal(response.value.ordinarySale, 'personal-shot-710080');
        assert.equal(response.value.oldGradeSale, 'personal-shot-710082', 'a C weapon releases the old D ammunition');
        assert.equal(response.value.unfundedFare, 'trade_meeting_funding', 'seller preparation applies the same protected-funds rule as native acceptance');
        assert.equal(response.value.freeFare, 'personal-shot-710080', 'a free local meeting remains available');
        assert.equal(response.value.heldSale, 'personal-shot-710090',
            'a previously selected WTB can consume free stock already advertised in a conditional SELL ad');
        assert.deepEqual(response.value.forbiddenLoaded, []);
        console.log('PASS native Orc meeting rejects personal D shots through SELL and WTB, permits materials and old grades');
    } finally { await worker.terminate(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
