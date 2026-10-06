const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
require('../src/Global');
const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Population = invoke('GameServer/Bot/Population/PopulationService');
const Protocol = invoke('GameServer/Bot/Population/ColdSimulationProtocol');
const { ColdSimulationCoordinator } = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const World = invoke('GameServer/World/World');
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const clone = value => JSON.parse(JSON.stringify(value));
let directory, serial = 0;
const failures = [];
async function check(name, work) { try { await work(); console.log(`PASS ${name}`); } catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.stack}`); } }
async function facts() {
    const tables = {};
    for (const name of ['bot_life_state', 'characters', 'items', 'warehouse_items', 'afk_trade_shops', 'afk_trade_lines']) {
        tables[name] = await Database.execute([`SELECT * FROM ${name} ORDER BY rowid`]);
    }
    tables.cache = tables.bot_life_state.map(row => [row.characterId, clone(Life.cachedState(row.characterId))]);
    return tables;
}
async function seed() {
    const account = `bot_admission_${++serial}`;
    await Database.createAccount(account, 'fixture');
    const id = Number((await Database.createCharacter(account, { name: `Admission${serial}`, race: 0, classId: 0,
        sex: 0, face: 0, hair: 0, hairColor: 0, maxHp: 100, maxMp: 100,
        locX: 83000, locY: 148000, locZ: -3400 })).insertId);
    await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 1000, equipped: false, enchant: 0, slot: 0 });
    const now = Date.now();
    assert(await Life.upsertState({ characterId: id, accountName: account, name: `Admission${serial}`,
        phase: 'cold', activity: 'resting', level: 7, exp: 12345, sp: 120, adena: 1000,
        inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)),
        loc: { locX: 83000, locY: 148000, locZ: -3400 },
        vitals: { hp: 85, maxHp: 100, mp: 70, maxMp: 100 },
        timing: { lastResolvedAt: now - 45000, nextResolveAt: now + 30000 },
        stats: { classId: 0, classProgressionLevel: 7, classProgressionClassId: 0, restUntil: now + 30000 } }, 'admission_seed'));
    return id;
}
async function heldNative(mode) {
    const id = await seed(), state = clone(Life.snapshot(id)), time = Date.now();
    const request = { characterId: id, kind: 'lifecycle', commandId: `admission:${serial}`,
        commandCheckpoint: Protocol.commandCheckpoint(state), state, context: {},
        precomputedResult: { patch: { activity: 'resting', vitals: { ...state.vitals, hp: 90 },
            stats: { restUntil: time + 60000 } }, events: [], materialize: { exp: 0, sp: 0, adena: 0, items: [] },
            nextResolveAt: time + 60000 } };
    const entered = deferred(), gate = deferred(), stopEntered = deferred(), stopGate = deferred();
    const blocker = Life.serializeClanLevelUp(id, async () => { entered.resolve(); await gate.promise; });
    await entered.promise;
    const coordinator = new ColdSimulationCoordinator(), sent = [], calls = [];
    coordinator.workerEpoch = `native-admission:${serial}`;
    const worker = label => ({ terminate: async () => {}, postMessage(message) {
        sent.push({ label, message: clone(message) });
        if (message.type === 'shutdown') setImmediate(() => coordinator.onMessage(Protocol.envelope('drained',
            message.workerEpoch, { ok: true }, message.msgId), coordinator.worker, message.workerEpoch));
    } });
    coordinator.worker = worker('A');
    const originalWorker = coordinator.worker, originalEpoch = coordinator.workerEpoch;
    // Observe the genuine exported native gateway; no operation is substituted.
    coordinator.population = { executeWorkerLifecycleCommand(current, command) {
        calls.push(current); return Population.executeWorkerLifecycleCommand(current, command);
    } };
    coordinator.contextIndex = () => ({}); coordinator.contextFor = () => ({});
    let stop;
    try {
        await coordinator.onMessage(Protocol.envelope('command_request', originalEpoch,
            { requests: [request] }, `native-message:${serial}`), originalWorker, originalEpoch);
        for (let n = 0; n < 20 && !coordinator.commandInflight.has(id); n++) await new Promise(resolve => setImmediate(resolve));
        assert(coordinator.commandInflight.has(id), 'whole native admission is owned before actual pending wait');
        await new Promise(resolve => setImmediate(resolve));
        if (mode === 'replace') { coordinator.worker = worker('B'); coordinator.workerEpoch = 'replaced-admission'; }
        if (mode === 'fence') coordinator.fencedBots.add(id);
        if (mode === 'changed' || mode === 'hot') {
            await Database.execute(['UPDATE bot_life_state SET updatedAt = ?, phase = ? WHERE characterId = ?',
                [Date.now() + 1000, mode === 'hot' ? 'hot' : 'cold', id]]);
            Life.acceptLifecycleRow((await Database.execute(['SELECT * FROM bot_life_state WHERE characterId = ?', [id]]))[0]);
        }
        if (mode === 'stop') {
            coordinator.started = true;
            coordinator.competitionActions.stop = async () => { stopEntered.resolve(); await stopGate.promise; };
            stop = coordinator.stop(); await stopEntered.promise;
            assert(coordinator.stopping); assert.equal(coordinator.worker, originalWorker);
            assert.equal(coordinator.workerEpoch, originalEpoch, 'actual stop has not replaced the held source');
        }
        const before = await facts();
        gate.resolve(); await blocker; await coordinator.commandTail;
        const after = await facts(), receipts = sent.filter(value => value.message.type === 'command_ack');
        console.log(JSON.stringify({ mode, populationCalls: calls.length,
            hpBefore: before.characters.find(row => row.id === id).hp, hpAfter: after.characters.find(row => row.id === id).hp,
            receiptTargets: receipts.map(value => value.label) }));
        assert.equal(coordinator.commandInflight.size, 0);
        if (mode === 'current') {
            assert.equal(calls.length, 1); assert.equal(receipts.length, 1); assert.equal(receipts[0].label, 'A');
            assert.equal(receipts[0].message.payload.results[0].ok, true);
            assert.equal(after.characters.find(row => row.id === id).hp, 90, 'actual current native transition persists HP');
            assert(after.bot_life_state.find(row => row.characterId === id).lastResolvedAt > state.timing.lastResolvedAt);
        } else {
            assert.equal(calls.length, 0, 'retired/stopped/changed authority is refused before native Population dispatch');
            assert.deepEqual(after, before, 'refusal preserves all physical/lifecycle/cache facts');
            if (mode === 'replace') assert.equal(receipts.length, 0);
            else {
                assert.equal(receipts.length, 1); const result = receipts[0].message.payload.results[0];
                assert.equal(result.ok, false); assert.equal(result.commandId, request.commandId);
                assert.deepEqual(result.commandCheckpoint, request.commandCheckpoint);
                assert.deepEqual(result.state, Life.snapshot(id));
            }
        }
    } finally {
        gate.resolve(); await blocker.catch(() => null); await coordinator.commandTail.catch(() => null);
        stopGate.resolve(); if (stop) await stop;
    }
}
async function run() {
    directory = fs.mkdtempSync(path.join(process.cwd(), 'tmp', 'command-admission-native-'));
    options.default.Database.path = path.join(directory, 'world.sqlite');
    options.default.Database.historyPath = path.join(directory, 'history.sqlite');
    Database.init(); assert(Database.isReady()); DataCache.init();
    World.user = { sessions: [], revision: 0 }; await Life.init();
    await check('actual current source survives existing native pending write and applies once', () => heldNative('current'));
    for (const mode of ['replace', 'changed', 'hot', 'fence', 'stop']) {
        await check(`actual held native ${mode} refuses before Population and preserves facts`, () => heldNative(mode));
    }
    if (failures.length) throw Error(`${failures.length} native admission contracts failed`);
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    await Database.close(); if (directory) fs.rmSync(directory, { recursive: true, force: true });
});
