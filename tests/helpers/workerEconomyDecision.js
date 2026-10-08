'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const root = path.resolve(__dirname, '../..');
const Protocol = require('../../src/GameServer/Bot/Population/ColdSimulationProtocol');

// A test-only observer of the actual cold worker's native economy and capture.
// No supplied activity/wish/material leaf and no main-thread full model.
const observer = String.raw`
module.exports.nativeRecipeEarning = async (id, timestamp) => {
    const entry = kernel.states.get(Number(id));
    const result = await occupationFor(entry.state, timestamp, entry.context, 'action');
    return { ...result, forbiddenLoaded: Object.keys(require.cache).filter(key => /\/(?:Database|Network)\/|\/src\/Database\.js$|\/World\/World\.js$|\/Bot\/BotManager\.js$/.test(key)) };
};
module.exports.nativeEconomyDecision = (id, timestamp) => {
    const state = kernel.states.get(Number(id)).state;
    const economy = invoke('GameServer/Bot/Economy/EconomyContext').forState(state, { timestamp });
    const decision = require('./ColdEconomyDecision').capture(economy, state);
    // Inputs from this worker's own native catalogue and price counters. A
    // test can sum E1 independently; no supplied packet or altered context.
    const reserveInputs = {
        stocks: ['shots', 'potions'].map(kind => {
            const stock = economy.stock(kind);
            return { selfId: stock.itemId, perHour: stock.usePerHour,
                held: Number(state.inventory?.[stock.itemId]?.amount || 0), unitPrice: stock.unitPrice };
        }),
        escape: { held: Number(state.inventory?.[736]?.amount || 0), unitPrice: economy.price(736),
            usable: !invoke('GameServer/Karma').closesTowns(state.stats?.karma) }
    };
    return { decision: { ...decision }, materials: decision.materials, statsPacket: economy.statsPacket, reserveInputs,
        queue: economy.network.queue.map(row => ({ key: row.key, materials: row.object?.materials || [], price: row.price, ratio: row.ratio, valueHours: row.valueHours, funded: row.funded, cumulativePrice: row.cumulativePrice, object: row.object })),
        forbiddenLoaded: Object.keys(require.cache).filter(key => /\/(?:Database|Network)\/|\/src\/Database\.js$|\/World\/World\.js$|\/Bot\/BotManager\.js$/.test(key)) };
};`;
const wrapper = String.raw`
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const { parentPort, workerData } = require('node:worker_threads');
const loaded = new Module(workerData.workerPath, module);
loaded.filename = workerData.workerPath; loaded.paths = Module._nodeModulePaths(path.dirname(workerData.workerPath));
loaded._compile(fs.readFileSync(workerData.workerPath, 'utf8') + workerData.observer, workerData.workerPath);
parentPort.on('message', async message => {
    if (!message.nativeEconomyDecision) return;
    try { parentPort.postMessage({ probeId: message.msgId,
        value: await loaded.exports[message.recipeEarning ? 'nativeRecipeEarning' : 'nativeEconomyDecision'](message.characterId, message.timestamp) }); }
    catch (error) { parentPort.postMessage({ probeId: message.msgId, error: error.stack }); }
});`;

module.exports = async function workerEconomyDecision(state, { context = {}, timestamp = Date.now(),
    boardRows = [], extraStates = [], tablePages = [], tables = [], recipeEarning = false } = {}) {
    const epoch = `native:economy-decision:${state.characterId}`;
    const messages = [];
    const worker = new Worker(wrapper, { eval: true, workerData: { workerEpoch: epoch,
        workerPath: path.join(root, 'src/GameServer/Bot/Population/ColdSimulationWorker.js'), observer } });
    let fault;
    worker.on('message', message => messages.push(message)); worker.on('error', error => { fault = error; });
    const wait = async predicate => {
        const deadline = Date.now() + 60000;
        while (!messages.some(predicate)) {
            if (fault) throw fault;
            const failure = messages.find(message => message.type === 'fault');
            if (failure) throw Error(JSON.stringify(failure));
            if (Date.now() >= deadline) throw Error('native economy decision worker timeout');
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        return messages.find(predicate);
    };
    const send = (type, payload, id) => worker.postMessage(Protocol.envelope(type, epoch, payload, id));
    try {
        await wait(message => message.type === 'ready' && message.payload.phase === 'loaded');
        const catalog = invoke('GameServer/Bot/Population/ColdSimulationCoordinator').npcPlanningCatalogRows();
        for (let at = 0; at < catalog.length; at += Protocol.MAX_BATCH) send('catalog_page', { catalog: 'npc_offers',
            rows: catalog.slice(at, at + Protocol.MAX_BATCH), done: at + Protocol.MAX_BATCH >= catalog.length });
        const spots = invoke('GameServer/Bot/Population/SpotProfiles').ensure();
        for (let at = 0; at < spots.length; at += Protocol.MAX_BATCH) send('catalog_page', { catalog: 'spots',
            rows: spots.slice(at, at + Protocol.MAX_BATCH) });
        send('init', { config: { loopIntervalMs: 1000 } }, 'init');
        await wait(message => message.type === 'ready' && message.payload.phase === 'running');
        send('pause', {}, 'pause');
        // Pre-paged payloads take precedence; legacy full tables use the
        // native channel's bounded pagination. boardRows remains supported.
        const pages = tablePages.length ? tablePages : tables.length
            ? require('../../src/GameServer/Bot/Population/ColdTableChannel').shared.pages(tables).map(page => page.payload)
            : [{ tables: [{ name: 'board', from: null, to: 0, full: true, rows: boardRows, removed: [], last: true }] }];
        for (const page of pages) send('table_page', page);
        send('snapshot_page', { rows: [{ state, context }, ...extraStates], ack: true }, 'state');
        await wait(message => message.type === 'ready' && message.msgId === 'state');
        worker.postMessage({ ...Protocol.envelope('pause', epoch, {}, 'native-economy'), nativeEconomyDecision: true,
            characterId: state.characterId, timestamp, recipeEarning });
        const response = await wait(message => message.probeId === 'native-economy');
        if (response.error) throw Error(response.error);
        assert.deepEqual(response.value.forbiddenLoaded, [], 'native economy worker loads no World actor/network/database implementation');
        return response.value;
    } finally { await worker.terminate(); }
};
