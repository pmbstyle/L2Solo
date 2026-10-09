'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
delete process.env.L2NODE_SHARED_CONFIG_FILE;
process.env.L2NODE_CONFIG_FILE = 'config/default.ini';
require('../src/Global');
const path = require('node:path'), { Worker } = require('node:worker_threads');
const Data = invoke('GameServer/DataCache'); Data.init();
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
const { npcPlanningCatalogRows } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');
const spots = invoke('GameServer/Bot/Population/SpotProfiles').ensure();
const now = Date.now(), id = 710071;
const state = { characterId: id, name: 'PagingSeller', level: 20, exp: Number(Data.experience[19]), sp: 0,
    adena: 1000000, phase: 'cold', activity: 'hunting', currentRegion: 'Giran', spotId: String(spots[0].id), updatedAt: now,
    loc: { locX: 83396, locY: 147904, locZ: -3400 },
    vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 },
    inventory: invoke('GameServer/Bot/Population/BotLifeState').inventorySummaryFromItems([
        { id: 710201, selfId: 1, amount: 1, equipped: 1, slot: 7 },
        { id: 710202, selfId: 1869, amount: 1000, equipped: 0, slot: 0 }]),
    stats: { classId: 0, generatedCold: true, classProgressionClassId: 0, classProgressionLevel: 20 },
    timing: { lastResolvedAt: now - 1000, nextResolveAt: now + 60000 } };
// The probe drives the worker's own refresh path with a plan that always
// overflows (d bit set); it counts how often the plan is prepared.
const observer = String.raw`
module.exports.refreshProbe = async id => {
    const Plan = require('./ColdEconomyPlan');
    let calls = 0, progressing = true;
    Plan.prepare = function* () { calls++; return { sell: progressing ? [[1869, calls, 10, 'Giran']] : [[1869, 1, 1, 'Giran']], withdraw: [], buyAds: [], travel: null, d: 2 }; };
    const settle = async () => {
        for (let at = 0; at < 2000; at++) {
            const held = occupationPlanner.slots.get(id) || occupationPlanner.waiting.get(id);
            if (!held || held.done) return;
            await new Promise(resolve => setImmediate(resolve));
        }
        throw Error('refresh_timeout');
    };
    const nextState = () => { const entry = kernel.states.get(id);
        kernel.states.set(id, { ...entry, state: { ...entry.state, updatedAt: entry.state.updatedAt + 1 } }); };
    const counts = [];
    kernel.states.get(id).context.economyPending = 2;
    occupationOwnerChanged(id, true); await settle(); counts.push(calls);
    occupationOwnerChanged(id, true); await settle(); counts.push(calls);
    const held = occupationPlanner.slots.get(id);
    occupationPlanner.publish(id, held.input, null, { stale: true }); await settle(); counts.push(calls);
    nextState(); await settle(); counts.push(calls);
    progressing = false;
    nextState(); await settle(); counts.push(calls);
    nextState(); await settle(); counts.push(calls);
    const pending = kernel.states.get(id).context.economyPending;
    nextState(); await settle(); counts.push(calls);
    return { counts, pending };
};`;
const wrapper = String.raw`
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const { parentPort, workerData } = require('node:worker_threads');
const loaded = new Module(workerData.workerPath, module);
loaded.filename = workerData.workerPath; loaded.paths = Module._nodeModulePaths(path.dirname(workerData.workerPath));
loaded._compile(fs.readFileSync(workerData.workerPath, 'utf8') + workerData.observer, workerData.workerPath);
parentPort.on('message', message => {
    if (!message.refreshProbe) return;
    loaded.exports.refreshProbe(message.refreshProbe).then(value => parentPort.postMessage({ probeId: message.msgId, value }))
        .catch(error => parentPort.postMessage({ probeId: message.msgId, error: error.stack }));
});`;
(async () => {
    const epoch = 'native:refresh-paging', messages = []; let fault;
    const worker = new Worker(wrapper, { eval: true, workerData: { workerEpoch: epoch, observer,
        workerPath: path.resolve(__dirname, '../src/GameServer/Bot/Population/ColdSimulationWorker.js') } });
    worker.on('message', message => messages.push(message)); worker.on('error', error => { fault = error; });
    const wait = async predicate => { const deadline = Date.now() + 60000;
        while (!messages.some(predicate)) { if (fault) throw fault;
            const rejected = messages.find(message => message.type === 'fault'); if (rejected) throw Error(JSON.stringify(rejected));
            if (Date.now() > deadline) throw Error('refresh paging timeout');
            await new Promise(resolve => setTimeout(resolve, 10)); }
        return messages.find(predicate); };
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
        send('table_page', { tables: [{ name: 'board', from: null, to: 0, full: true, rows: [], removed: [], last: true }] });
        send('snapshot_page', { rows: [{ state, context: {} }], ack: true }, 'state');
        await wait(message => message.type === 'ready' && message.msgId === 'state');
        worker.postMessage({ ...Protocol.envelope('pause', epoch, {}, 'probe'), refreshProbe: id });
        const response = await wait(message => message.probeId === 'probe'); if (response.error) throw Error(response.error);
        const ready = messages.filter(message => message.type === 'ready' && message.payload.phase === 'economy_plan_ready');
        // first refresh; same state again; stale result; next state (paging);
        // plan stops progressing: one refresh, then the repeat ends the paging.
        assert.deepEqual(response.value.counts, [1, 1, 1, 2, 3, 4, 4], 'one refresh per native state, no stale loop');
        assert.equal(response.value.pending, 0, 'a refreshed plan equal to the sent one clears the pending paging');
        assert.equal(ready.length, 3, 'a repeated plan is not sent again');
        console.log('PASS overflowing economy plan: one refresh per state, stale result does not re-request, repeated plan ends paging');
    } finally { await worker.terminate(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
