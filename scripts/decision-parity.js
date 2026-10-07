'use strict';
// Read a saved world through a read-only connection; the actual cold worker
// projects its native lifecycle, then main freshly builds exactly that input.
// Usage: L2NODE_CONFIG_FILE=config/default.ini node scripts/decision-parity.js <world-copy.sqlite> [300]
const path = require('node:path'), fs = require('node:fs'), assert = require('node:assert/strict');
const { Worker } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Decision = require('../src/GameServer/Bot/Population/ColdEconomyDecision');
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
const { npcPlanningCatalogRows } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');
const root = path.resolve(__dirname, '..'), workerPath = root + '/src/GameServer/Bot/Population/ColdSimulationWorker.js';
const db = new DatabaseSync(process.argv[2], { readOnly: true });
const rows = db.prepare("SELECT * FROM bot_life_state WHERE phase='cold' ORDER BY characterId LIMIT ?").all(Number(process.argv[3] || 300));
assert(rows.length >= 300, 'parity requires at least 300 native cold states');
const json = raw => JSON.parse(raw || '{}');
const states = rows.map(row => ({ characterId: row.characterId, name: row.characterName, level: row.level, exp: row.exp,
    sp: row.sp, adena: row.adena, phase: row.phase, activity: row.activity, currentRegion: row.currentRegion,
    spotId: row.spotId, updatedAt: row.updatedAt, loc: { locX: row.locX, locY: row.locY, locZ: row.locZ },
    vitals: { hp: row.hp, maxHp: row.maxHp, mp: row.mp, maxMp: row.maxMp },
    timing: { lastResolvedAt: row.lastResolvedAt, nextResolveAt: row.nextResolveAt },
    simulation: { ownerId: 'legacy_main', revision: row.simRevision || 0 },
    party: row.partyId ? { partyId: row.partyId } : null, stats: json(row.statsJson), inventory: json(row.inventorySummary) }));
db.close();
const spots = invoke('GameServer/Bot/Population/SpotProfiles').ensure(), catalog = npcPlanningCatalogRows();
const board = new (invoke('GameServer/AfkTrade/BoardIndex').BoardIndex)();
invoke('GameServer/Bot/Economy/MarketCounters').useSpots(() => spots);
invoke('GameServer/Bot/Economy/BotMarketPricing').useNpcOfferSnapshot(catalog);
Economy.configure({ board: () => board, spots: () => spots, memory: () => null });
const epoch = 'decision-parity';
const observer = String.raw`
module.exports.decisionOracle = async ids => {
    const assert = require('node:assert/strict');
    const Economy = invoke('GameServer/Bot/Economy/EconomyContext'), original = Economy.forState;
    const result = [];
    for (const id of ids) {
        const entry = kernel.states.get(id), state = entry.state, timestamp = Number(state.updatedAt || 1e12) + 1;
        let seen, built, cost;
        Economy.forState = (value, deps) => { seen = structuredClone(value); const start = performance.now();
            const context = original(value, deps); cost = performance.now() - start; return context; };
        try {
            const projected = await LifeStateProjector.prepareResolve(state, { patch: {}, materialize: { exp: 0, sp: 0, adena: 0, items: [] },
                debug: {}, events: [], nextResolveAt: timestamp + 60000 }, {
                persist: false, timestamp, projectClassProgression: true,
                economyDeps: { board: boardIndex, spots: planningSpots, memory: null, workshop: entry.context.workshop },
                onEconomy: context => { built = context; }
            });
            const start = performance.now(), decision = ColdEconomyDecision.capture(built, projected, seen);
            const paritySeen = seen, parityBuilt = built;
            let commandKeys = null, commandPacket = null;
            if (id === workerData.contractId) {
                const plan = await kernel.planLifecycle({ state, context: entry.context, timestamp });
                commandKeys = Object.keys(plan.statsPacket); commandPacket = plan.statsPacket;
                assert.deepEqual(commandKeys.sort(), Object.keys(parityBuilt.statsPacket).sort());
                assert(plan.economyDecision && plan.activityPick, 'actual planLifecycle sends complete packet, pick and decision');
            }
            result.push({ id, seen: paritySeen, timestamp, decision, fullKeys: Object.keys(parityBuilt.statsPacket), commandKeys, commandPacket,
                captureMs: performance.now() - start, buildMs: cost });
        } finally { Economy.forState = original; }
    }
    return result;
};`;
const wrapper = String.raw`
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const { parentPort, workerData } = require('node:worker_threads');
const loaded = new Module(workerData.workerPath, module);
loaded.filename = workerData.workerPath; loaded.paths = Module._nodeModulePaths(path.dirname(workerData.workerPath));
loaded._compile(fs.readFileSync(workerData.workerPath, 'utf8') + workerData.observer, workerData.workerPath);
parentPort.on('message', message => {
    if (!message.decisionOracle) return;
    loaded.exports.decisionOracle(message.decisionOracle).then(value => parentPort.postMessage({ oracleId: message.msgId, value }))
        .catch(error => parentPort.postMessage({ oracleId: message.msgId, error: error.stack }));
});`;
(async () => {
    const worker = new Worker(wrapper, { eval: true, workerData: { workerPath, observer, workerEpoch: epoch, contractId: states[0].characterId } });
    const messages = []; let fault;
    worker.on('message', message => messages.push(message)); worker.on('error', error => { fault = error; });
    const wait = async predicate => { const deadline = Date.now() + 60000;
        while (!messages.some(predicate)) { if (fault) throw fault; const rejected = messages.find(message => message.type === 'fault'); if (rejected) throw Error(JSON.stringify(rejected)); if (Date.now() > deadline) throw Error('native parity worker timeout');
            await new Promise(resolve => setTimeout(resolve, 10)); } return messages.find(predicate); };
    const send = (type, payload, msgId) => worker.postMessage(Protocol.envelope(type, epoch, payload, msgId));
    let leafEqual = 0, watchEqual = 0, usefulEqual = 0, captureMs = [], buildMs = [], crafters = 0;
    const mismatches = []; let commandContracts = 0;
    try {
        await wait(message => message.type === 'ready' && message.payload.phase === 'loaded');
        for (let at = 0; at < catalog.length; at += Protocol.MAX_BATCH) send('catalog_page', { catalog: 'npc_offers',
            rows: catalog.slice(at, at + Protocol.MAX_BATCH), done: at + Protocol.MAX_BATCH >= catalog.length });
        for (let at = 0; at < spots.length; at += Protocol.MAX_BATCH) send('catalog_page', { catalog: 'spots', rows: spots.slice(at, at + Protocol.MAX_BATCH) });
        send('init', { config: { loopIntervalMs: 1000 } }, 'init');
        await wait(message => message.type === 'ready' && message.payload.phase === 'running'); send('pause', {}, 'pause');
        const contexts = new Map(states.map(state => [state.characterId, { workshop: state.stats?.workshop?.entries?.length
            ? Economy.craftIncome(state, { hourAdena: Economy.basics(state).hunt.perHour, worth: Economy.basics(state).price, timestamp: Number(state.updatedAt) + 1 }) : null }]));
        for (let at = 0; at < states.length; at += 4) send('snapshot_page', { rows: states.slice(at, at + 4)
            .map(state => ({ state, context: contexts.get(state.characterId) })), ack: true }, 'state-' + at);
        await wait(message => message.type === 'ready' && message.msgId === 'state-' + (Math.floor((states.length - 1) / 4) * 4));
        console.log('native states loaded', states.length);
        for (let at = 0; at < states.length; at += 20) {
            const msgId = 'oracle-' + at;
            worker.postMessage({ ...Protocol.envelope('pause', epoch, {}, msgId), decisionOracle: states.slice(at, at + 20).map(state => state.characterId) });
            const response = await wait(message => message.oracleId === msgId); if (response.error) throw Error(response.error);
            for (const row of response.value) {
                if (row.commandKeys) { assert.deepEqual(row.commandKeys.sort(), row.fullKeys.sort()); commandContracts++; }
                const workerDecision = Decision.compact(row.decision), fresh = Economy.forState(row.seen, { timestamp: row.timestamp,
                    board, spots, memory: null, workshop: contexts.get(row.id).workshop, caller: 'parity' });
                const mainDecision = Decision.capture(fresh, row.seen);
                const leaf = value => [value?.activity ?? null, value?.spotId ?? null, value?.npcId ?? null];
                const checks = [JSON.stringify(leaf(workerDecision.activity)) === JSON.stringify(leaf(mainDecision.activity)),
                    JSON.stringify(workerDecision.watch) === JSON.stringify(mainDecision.watch),
                    JSON.stringify([...workerDecision.usefulness]) === JSON.stringify([...mainDecision.usefulness])];
                leafEqual += +checks[0]; watchEqual += +checks[1]; usefulEqual += +checks[2];
                if (row.seen.stats?.workshop?.entries?.length) crafters++;
                captureMs.push(row.captureMs); buildMs.push(row.buildMs);
                if (!checks.every(Boolean)) mismatches.push({ id: row.id, checks, worker: leaf(workerDecision.activity), main: leaf(mainDecision.activity),
                    workerWatch: workerDecision.watch, mainWatch: mainDecision.watch });
            }
        }
        const p95 = rows => rows.sort((a, b) => a - b)[Math.floor(rows.length * .95)];
        console.log(JSON.stringify({ bots: states.length, nativeCrafters: crafters, leafEqual, watchEqual, usefulEqual,
            commandContracts, captureP95Ms: p95(captureMs), buildP95Ms: p95(buildMs), mismatches: mismatches.slice(0, 10),
            inputs: 'native saved states, native NPC/spot catalogs, same empty board and counter mirrors' }, null, 2));
        assert.equal(commandContracts, 1); assert.equal(leafEqual, states.length); assert.equal(watchEqual, states.length); assert.equal(usefulEqual, states.length);
    } finally { await worker.terminate(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
