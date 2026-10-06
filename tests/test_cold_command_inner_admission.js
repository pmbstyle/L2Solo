const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const gameRoot = process.env.N53_GAME_ROOT || path.resolve(__dirname, '..');
require(path.join(gameRoot, 'src/Global'));
const Database = invoke('Database');
const Data = invoke('GameServer/DataCache');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Population = invoke('GameServer/Bot/Population/PopulationService');
const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const Protocol = invoke('GameServer/Bot/Population/ColdSimulationProtocol');
const { ColdSimulationCoordinator } = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const clone = value => JSON.parse(JSON.stringify(value));
const failures = [];
let serial = 0, directory;
async function facts(id) {
    const found = {};
    for (const table of ['bot_life_state', 'characters', 'items', 'warehouse_items', 'afk_trade_shops', 'afk_trade_lines']) {
        found[table] = await Database.execute([`SELECT * FROM ${table} ORDER BY rowid`]);
    }
    found.cache = clone(Life.cachedState(id));
    return found;
}
async function seed() {
    const account = `bot_inner_admission_${++serial}`;
    await Database.createAccount(account, 'fixture');
    const id = Number((await Database.createCharacter(account, { name: `InnerAdmission${serial}`, race: 0,
        classId: 0, sex: 0, face: 0, hair: 0, hairColor: 0, maxHp: 100, maxMp: 100,
        locX: 83000, locY: 148000, locZ: -3400 })).insertId);
    await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 1000, equipped: false, enchant: 0, slot: 0 });
    const time = Date.now();
    assert(await Life.upsertState({ characterId: id, accountName: account, name: `InnerAdmission${serial}`,
        phase: 'cold', activity: 'resting', level: 7, exp: 12345, sp: 120, adena: 1000,
        inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)),
        loc: { locX: 83000, locY: 148000, locZ: -3400 },
        vitals: { hp: 85, maxHp: 100, mp: 70, maxMp: 100 },
        timing: { lastResolvedAt: time - 45000, nextResolveAt: time + 30000 },
        stats: { classId: 0, classProgressionLevel: 7, classProgressionClassId: 0,
            restUntil: time + 30000 } }, 'inner_admission_seed'));
    return id;
}
async function inner(mode) {
    const id = await seed(), state = clone(Life.snapshot(id)), time = Date.now();
    const request = { kind: 'lifecycle', characterId: id, commandId: `inner:${serial}`,
        commandCheckpoint: Protocol.commandCheckpoint(state), state, context: {},
        precomputedResult: { patch: { activity: 'resting', vitals: { ...state.vitals, hp: 90 },
            stats: { restUntil: time + 60000 } }, events: [],
            materialize: { exp: 0, sp: 0, adena: 0, items: [] }, nextResolveAt: time + 60000 } };
    const originalCheckpoint = clone(request.commandCheckpoint);
    // Request extras cannot supply or disable the internal Main capability.
    request.workerAdmission = null;
    const firstEntered = deferred(), firstGate = deferred(), secondEntered = deferred(), secondGate = deferred();
    const populationEntered = deferred(), stopEntered = deferred(), stopGate = deferred();
    const first = Life.serializeClanLevelUp(id, async () => { firstEntered.resolve(); await firstGate.promise; });
    await firstEntered.promise;
    const c = new ColdSimulationCoordinator(), sent = [], calls = [], admissions = [];
    c.workerEpoch = `inner-native:${serial}`; c.ready = true;
    const worker = label => ({ terminate: async () => {}, postMessage(message) {
        sent.push({ label, message: clone(message) });
        if (message.type === 'fence') setImmediate(() => c.onMessage(Protocol.envelope('fence_ack',
            message.workerEpoch, { characterId: id, proposal: null, token: null }, message.msgId), c.worker, c.workerEpoch));
        if (message.type === 'shutdown') setImmediate(() => c.onMessage(Protocol.envelope('drained',
            message.workerEpoch, { ok: true }, message.msgId), c.worker, c.workerEpoch));
    } });
    c.worker = worker('A');
    const originalWorker = c.worker, originalEpoch = c.workerEpoch;
    c.contextIndex = () => ({}); c.contextFor = () => ({});
    c.population = { executeWorkerLifecycleCommand(...args) {
        calls.push(args[0]); admissions.push(args[2]?.workerAdmission);
        const work = Population.executeWorkerLifecycleCommand(...args);
        populationEntered.resolve(); return work;
    } };
    let second, stop;
    try {
        await c.onMessage(Protocol.envelope('command_request', originalEpoch,
            { requests: [request] }, `inner-message:${serial}`), originalWorker, originalEpoch);
        for (let n = 0; n < 20 && !c.commandInflight.has(id); n++) await new Promise(done => setImmediate(done));
        assert(c.commandInflight.has(id), 'actual Main owns the whole original snapshot-settle admission');
        assert.equal(calls.length, 0, 'first genuine pending writer is still held before Main dispatch');
        // The real Main helper already captured first. Its snapshot wait does
        // not include this later queue job; native applyResolve will include it.
        second = Life.serializeClanLevelUp(id, async () => { secondEntered.resolve(); await secondGate.promise; });
        firstGate.resolve(); await first; await secondEntered.promise; await populationEntered.promise;
        assert.equal(calls.length, 1, 'Main current source genuinely dispatched Population after first snapshot settled');
        assert.equal(calls[0], Life.cachedState(id), 'native gateway receives the actual authoritative cache row');
        assert(admissions[0], 'Main authors its own internal capability');
        assert(Object.isFrozen(admissions[0])); assert(Object.isFrozen(admissions[0].commandCheckpoint));
        assert.notEqual(admissions[0].commandCheckpoint, request.commandCheckpoint, 'immutable authority is a copy of the original checkpoint');
        assert(c.commandInflight.has(id), 'inner native apply is owned and outstanding behind second held writer');
        assert.equal((await facts(id)).characters.find(row => row.id === id).hp, 85, 'no application before inner entry');
        if (mode === 'replace') { c.worker = worker('B'); c.workerEpoch = 'inner-replacement'; }
        if (mode === 'changed') {
            // A generated durable checkpoint mutation, normalized through the
            // actual cache reader; no fake activity/hot phase or runnable row.
            await Database.execute(['UPDATE bot_life_state SET updatedAt = ? WHERE characterId = ?', [Date.now() + 1000, id]]);
            Life.acceptLifecycleRow((await Database.execute(['SELECT * FROM bot_life_state WHERE characterId = ?', [id]]))[0]);
            assert.equal(Protocol.sameCommandCheckpoint(request.commandCheckpoint, Life.cachedState(id)), false);
        }
        if (mode === 'deadline_metadata') {
            // Same native tuple, deadline-only metadata: this proves admission
            // parity, not a worker-owned legacy apply or native grant renewal.
            await Database.execute(['UPDATE bot_life_state SET simulationLeaseUntil = ? WHERE characterId = ?', [Date.now() + 120000, id]]);
            Life.acceptLifecycleRow((await Database.execute(['SELECT * FROM bot_life_state WHERE characterId = ?', [id]]))[0]);
            assert(Protocol.sameCommandCheckpoint(request.commandCheckpoint, Life.cachedState(id)));
            assert.equal(admissions[0].check(), null, 'same11 cached deadline-only metadata admits synchronously before prepareResolve');
        }
        if (mode === 'owned_replaced') c.commandInflight.set(id, Promise.resolve());
        if (mode === 'request_changed') {
            request.commandCheckpoint.updatedAt += 1000;
            assert.deepEqual(admissions[0].commandCheckpoint, originalCheckpoint,
                'a later request mutation cannot replace the captured original authority');
        }
        if (mode === 'claimed') {
            const grant = await Owner.claimBatch([Life.snapshot(id)], { allowLifecycle: true, leaseMs: 120000 });
            assert.equal(grant.grants.length, 1, JSON.stringify(grant.rejected));
            assert(Life.cachedState(id).simulation.leaseId, 'existing native lease CAS boundary is exercised');
        }
        if (mode === 'fence') {
            const fenced = await c.fenceBot(id, 10);
            assert.equal(fenced.ok, true, JSON.stringify(fenced));
            assert(c.fencedBots.has(id), 'actual fence ACK and bounded in-flight wait retain the fence');
        }
        if (mode === 'stop') {
            c.started = true;
            c.competitionActions.stop = async () => { stopEntered.resolve(); await stopGate.promise; };
            stop = c.stop(); await stopEntered.promise;
            assert(c.stopping); assert.equal(c.worker, originalWorker); assert.equal(c.workerEpoch, originalEpoch);
        }
        const before = await facts(id);
        secondGate.resolve(); await second; await c.commandTail;
        const after = await facts(id), receipts = sent.filter(row => row.message.type === 'command_ack');
        console.log(JSON.stringify({ mode, dispatches: calls.length,
            hpBefore: before.characters.find(row => row.id === id).hp, hpAfter: after.characters.find(row => row.id === id).hp,
            checkpointBefore: before.cache.updatedAt, checkpointAfter: after.cache.updatedAt,
            receipts: receipts.map(row => [row.label, row.message.payload.results[0]?.reason]) }));
        if (mode === 'owned_replaced') c.commandInflight.delete(id);
        assert.equal(c.commandInflight.size, 0);
        if (mode === 'current' || mode === 'deadline_metadata' || mode === 'request_changed') {
            assert.equal(after.characters.find(row => row.id === id).hp, 90, 'current genuine native transition persists');
            assert(after.cache.timing.lastResolvedAt > state.timing.lastResolvedAt);
            assert.equal(receipts.length, 1); assert.equal(receipts[0].message.payload.results[0].ok, true);
            assert.equal(receipts[0].label, 'A');
            assert.deepEqual(receipts[0].message.payload.results[0].commandCheckpoint, originalCheckpoint,
                'successful own progression still echoes original input checkpoint');
        } else {
            assert.deepEqual(after, before, 'refused inner admission must conserve all native/cache facts before first writer');
            if (mode === 'replace') assert.equal(receipts.length, 0);
            else {
                assert.equal(receipts.length, 1); const receipt = receipts[0].message.payload.results[0];
                assert.equal(receipt.ok, false); assert.deepEqual(receipt.commandCheckpoint, request.commandCheckpoint);
                assert.equal(receipt.commandId, request.commandId);
                assert.equal(receipt.reason, mode === 'stop' ? 'coordinator_stopping'
                    : mode === 'fence' ? 'hot_handoff_fenced' : 'stale_command');
            }
        }
    } finally {
        firstGate.resolve(); secondGate.resolve(); await first.catch(() => null); await second?.catch(() => null);
        await c.commandTail.catch(() => null); stopGate.resolve(); if (stop) await stop;
    }
}
function command(state) {
    return { characterId: state.characterId, kind: 'lifecycle', commandId: `manual:${++serial}`,
        commandCheckpoint: Protocol.commandCheckpoint(state), state, context: {},
        precomputedResult: { patch: { activity: 'resting', vitals: { ...state.vitals, hp: 90 },
            stats: { restUntil: Date.now() + 60000 } }, events: [],
            materialize: { exp: 0, sp: 0, adena: 0, items: [] }, nextResolveAt: Date.now() + 60000 } };
}
function capability(state, check = () => null) {
    return { characterId: state.characterId, commandId: 'internal:fixture',
        commandCheckpoint: Protocol.commandCheckpoint(state), check };
}
async function manualCurrent() {
    const id = await seed(), state = Life.snapshot(id), request = command(state);
    const result = await Population.executeWorkerLifecycleCommand(state, request);
    assert.equal(result.ok, true); assert.equal((await facts(id)).characters.find(row => row.id === id).hp, 90);
}
async function manualOwnerCas() {
    const id = await seed(), state = Life.snapshot(id), request = command(state);
    const entered = deferred(), gate = deferred();
    const blocker = Life.serializeClanLevelUp(id, async () => { entered.resolve(); await gate.promise; });
    await entered.promise;
    const pending = Population.executeWorkerLifecycleCommand(state, request); // truly optional-absent
    try {
        const grant = await Owner.claimBatch([Life.snapshot(id)], { allowLifecycle: true, leaseMs: 120000 });
        assert.equal(grant.grants.length, 1, JSON.stringify(grant.rejected));
        const before = await facts(id); gate.resolve(); await blocker;
        const result = await pending;
        assert.equal(result.ok, false); assert.equal(result.reason, 'apply_failed', 'manual path reaches the retained native ownership write guard');
        assert.deepEqual(await facts(id), before);
    } finally { gate.resolve(); await blocker; await pending; }
}
async function malformedOptions() {
    const id = await seed(), state = Life.snapshot(id), request = command(state), good = capability(state);
    const options = [null, [],
        { workerAdmission: undefined }, { workerAdmission: null }, { workerAdmission: [] },
        { workerAdmission: { ...good, characterId: id + 1 } },
        { workerAdmission: { ...good, commandId: '' } },
        { workerAdmission: { ...good, commandCheckpoint: { ...good.commandCheckpoint, updatedAt: undefined } } },
        { workerAdmission: { ...good, check: undefined } },
        { workerAdmission: { ...good, check: () => undefined } },
        { workerAdmission: { ...good, check: () => false } },
        { workerAdmission: { ...good, check: () => ({ reason: 'not_an_admission_reason' }) } },
        { workerAdmission: { ...good, check: () => { throw new Error('check_broke'); } } },
        { workerAdmission: { ...good, check: async () => null } },
        { workerAdmission: { ...good, check: () => Promise.reject(new Error('async_check_broke')) } },
        { workerAdmission: { ...good, check: () => ({ then() {}, reason: 'stale_command' }) } }
    ];
    const before = await facts(id);
    for (let index = 0; index < options.length; index++) {
        const result = await Population.executeWorkerLifecycleCommand(state, request, options[index]);
        assert.equal(result.ok, false, `malformed option ${index} fails closed`);
        assert.equal(result.reason, 'invalid_worker_admission');
        assert.equal(result.retryAfterMs, 1000);
        assert.deepEqual(result.state, Life.cachedState(id));
        assert.deepEqual(await facts(id), before, `malformed option ${index} cannot start native work`);
    }
}
async function malformedQueued() {
    const id = await seed(), state = Life.snapshot(id), request = command(state), gate = deferred(), entered = deferred();
    const blocker = Life.serializeClanLevelUp(id, async () => { entered.resolve(); await gate.promise; });
    await entered.promise;
    const cap = capability(state); let calls = 0;
    cap.check = () => ++calls === 1 ? null : Promise.resolve(null);
    const before = await facts(id), pending = Population.executeWorkerLifecycleCommand(state, request, { workerAdmission: cap });
    try {
        gate.resolve(); await blocker;
        const result = await pending;
        assert.equal(calls, 2, 'the same capability is checked at initial gateway and actual inner entry');
        assert.equal(result.ok, false); assert.equal(result.reason, 'invalid_worker_admission');
        assert.deepEqual(await facts(id), before, 'async inner verdict cannot call prepareResolve');
        await Life.settleWrites([id]);
        assert.equal((await Population.executeWorkerLifecycleCommand(Life.snapshot(id), command(Life.snapshot(id)))).ok, true,
            'exact queued refusal cleans up and later manual work progresses');
    } finally { gate.resolve(); await blocker; await pending; }
}
async function plannedStateAndFailure() {
    const id = await seed(), state = Life.snapshot(id), request = command(state), before = await facts(id);
    const original = Life.prepareResolve, ordinary = new Error('ordinary_native_error');
    ordinary.code = 'BOT_WORKER_COMMAND_ADMISSION_REFUSED'; // code alone must never brand it
    Life.prepareResolve = function(...args) { assert.equal(args[0].characterId, id); throw ordinary; };
    try {
        await assert.rejects(Population.executeWorkerLifecycleCommand(state, request,
            { workerAdmission: capability(state) }), error => error === ordinary,
        'the gateway does not swallow an unrelated native error with a copied code');
        assert.deepEqual(await facts(id), before); await Life.settleWrites([id]);
    } finally { Life.prepareResolve = original; }
    const effective = { ...state, activity: 'hunting' }; // planned activity is not immutable original CP
    const saved = await Life.applyResolve(effective, request.precomputedResult, { workerAdmission: capability(state) });
    assert(saved); assert.equal((await facts(id)).characters.find(row => row.id === id).hp, 90);
}
async function unregisteredPromise() {
    const id = await seed(), state = Life.snapshot(id), request = command(state);
    const c = new ColdSimulationCoordinator(), before = await facts(id);
    c.population = Population;
    const result = await c.executeLifecycleCommand(request,
        { characterId: id, commandId: request.commandId, commandCheckpoint: request.commandCheckpoint }, () => true);
    assert.equal(result.ok, false); assert.equal(result.reason, 'stale_command');
    assert.deepEqual(await facts(id), before, 'undefined command ownership is never an authority capability');
}
async function check(name, work) {
    try { await work(); console.log(`PASS ${name}`); }
    catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.stack}`); }
}
(async () => {
    directory = fs.mkdtempSync(path.join(process.cwd(), 'tmp', 'inner-command-native-'));
    options.default.Database.path = path.join(directory, 'world.sqlite');
    options.default.Database.historyPath = path.join(directory, 'history.sqlite');
    Database.init(); assert(Database.isReady()); Data.init(); await Life.init();
    for (const mode of ['current', 'replace', 'stop', 'changed', 'fence', 'claimed', 'deadline_metadata', 'owned_replaced', 'request_changed']) {
        await check(`native inner ${mode}`, () => inner(mode));
    }
    await check('optional-absent current manual native transition', manualCurrent);
    await check('optional-absent claimed manual keeps genuine native SQL owner guard', manualOwnerCas);
    await check('strict malformed optional capabilities cannot start work', malformedOptions);
    await check('actual queued check is synchronous and refused work cleans up', malformedQueued);
    await check('unrelated error identity preserved and planned activity accepted', plannedStateAndFailure);
    await check('a missing registered whole promise is never authority', unregisteredPromise);
    if (failures.length) throw Error(`Inner native admission contracts failed: ${failures.join(', ')}`);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    await Database.close(); if (directory) fs.rmSync(directory, { recursive: true, force: true });
});
