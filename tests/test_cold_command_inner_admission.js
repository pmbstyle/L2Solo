const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const gameRoot = process.env.N53_GAME_ROOT || path.resolve(__dirname, '..');
const isolated = require('./helpers/isolatedSocialDatabase')('inner-command-native', gameRoot);
require(path.join(gameRoot, 'src/Global'));
isolated.assertConfigured(options.default);
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
    for (const table of ['bot_life_state', 'characters', 'skills', 'items', 'warehouse_items', 'afk_trade_shops', 'afk_trade_lines']) {
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
        const before = await facts(id), failuresBefore = Database.stats().failures;
        gate.resolve(); await blocker;
        const result = await pending;
        assert.equal(result.ok, false); assert.equal(result.reason, 'apply_failed', 'manual path reaches the retained native ownership write guard');
        assert.deepEqual(await facts(id), before);
        assert.equal(Database.stats().failures, failuresBefore + 1, 'native refusal remains visible in failure accounting');
        assert.equal(Database.isColdTrainingSourceRetired(Error('cold_training_source_retired')), false,
            'an unrelated same-message error cannot enter the native refusal domain');
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
// Native version-family training writes must respect ROW floors.
async function versionedTraining(key, mode, worker = false) {
    const id = await seed();
    if (mode !== 'stale') {
        const initial = Life.snapshot(id);
        assert(await Life.upsertState({ ...initial, stats: { ...initial.stats, [key]: 1 } }, 'versioned_training_fixture'));
    }
    const state = Life.snapshot(id), request = command(state);
    const durableVersion = mode === 'stale' || mode === 'current' ? 1 : 0;
    await Database.execute([`UPDATE bot_life_state SET statsJson=json_set(statsJson, '$.${key}', ?) WHERE characterId=?`,
        [durableVersion, id]]);
    const before = await facts(id), failuresBefore = Database.stats().failures;
    assert(Protocol.sameCommandCheckpoint(request.commandCheckpoint, Life.cachedState(id)),
        'the original real checkpoint/source remains admitted at this version-only mutation');
    let result;
    if (worker) {
        const c = new ColdSimulationCoordinator(), sent = [];
        c.ready = true; c.workerEpoch = `versioned-training:${id}`;
        c.worker = { postMessage(message) { sent.push(clone(message)); }, terminate: async () => {} };
        c.contextIndex = () => ({}); c.contextFor = () => ({}); c.population = Population;
        await c.onMessage(Protocol.envelope('command_request', c.workerEpoch, { requests: [request] }, `versioned-message:${id}`),
            c.worker, c.workerEpoch);
        await c.commandTail;
        assert.equal(c.commandInflight.size, 0);
        const acknowledgements = sent.filter(message => message.type === 'command_ack');
        assert.equal(acknowledgements.length, 1);
        result = acknowledgements[0].payload.results[0];
    } else result = await Population.executeWorkerLifecycleCommand(state, request);
    const after = await facts(id);
    console.log('VERSION_TRAINING', JSON.stringify({ key, mode, worker, result: { ok: result.ok, reason: result.reason },
        spBefore: before.characters.find(row => row.id === id).sp,
        spAfter: after.characters.find(row => row.id === id).sp,
        skillsBefore: before.skills.filter(row => row.characterId === id).length,
        skillsAfter: after.skills.filter(row => row.characterId === id).length,
        failuresDelta: Database.stats().failures - failuresBefore }));
    if (mode === 'stale') {
        assert.equal(result.ok, false);
        assert.equal(result.reason, 'apply_failed');
        assert.deepEqual(after, before, `${key} stale ROW floor refuses before any physical SP/skills/items/cache write`);
        assert.equal(Database.stats().failures, failuresBefore + 1, 'one native training rejection remains accounted');
    } else {
        assert.equal(result.ok, true, `${key} ${mode} must accept the same original ROW <= comparison`);
        const Catalog = invoke('GameServer/Skills/SkillBookCatalog');
        const paid = Catalog.nextTraining(0, 7, 3, 0).sp + Catalog.nextTraining(0, 7, 3, 1).sp;
        assert(paid > 0 && paid <= state.sp);
        assert.equal(after.characters.find(row => row.id === id).sp, state.sp - paid);
        assert(after.skills.filter(row => row.characterId === id).length > 0, 'current/lower training really writes native skills');
        assert.equal(after.characters.find(row => row.id === id).hp, 90);
        assert.equal(after.bot_life_state.find(row => row.characterId === id).sp, state.sp - paid);
        assert.equal(Database.stats().failures, failuresBefore, 'accepted control introduces no failure');
    }
}
async function versionedBookTraining(key, mode) {
    const id = await seed(), Catalog = invoke('GameServer/Skills/SkillBookCatalog');
    const training = Catalog.nextTraining(10, 20, 1184, 0);
    assert(training && training.bookId && training.sp > 0, 'authored first Ice Bolt rank consumes its actual SP/book');
    await Database.updateCharacterClassId(id, 10);
    await Database.setItem(id, { selfId: training.bookId, name: 'Spellbook: Ice Bolt', amount: 1,
        equipped: false, enchant: 0, slot: 0 });
    const initial = Life.snapshot(id);
    assert(await Life.upsertState({ ...initial, level: 20, exp: Number(Data.experience[19]) + 1, sp: training.sp,
        inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)),
        stats: { ...initial.stats, classId: 10, [key]: mode === 'stale' ? 0 : 1 } }, 'authored_book_training_fixture'));
    const state = Life.snapshot(id), beforeWrite = Database.createColdTrainingGuard(state, () => {});
    await Database.execute([`UPDATE bot_life_state SET statsJson=json_set(statsJson, '$.${key}', ?) WHERE characterId=?`,
        [mode === 'lower' ? 0 : 1, id]]);
    const before = await facts(id), failuresBefore = Database.stats().failures;
    if (mode === 'stale') {
        await assert.rejects(Database.learnBotSkill(id, training.skillId, training.level, { beforeWrite }),
            error => Database.isColdTrainingSourceRetired(error));
        assert.deepEqual(await facts(id), before, `${key} rejects before real spellbook/SP/skill transaction`);
        assert.equal(Database.stats().failures, failuresBefore + 1);
    } else {
        const result = await Database.learnBotSkill(id, training.skillId, training.level, { beforeWrite });
        assert.equal(result.learned, true);
        assert.equal(result.spentSp, training.sp);
        assert.equal(result.consumedBooks.length, 1);
        assert.equal(result.consumedBooks[0].selfId, training.bookId);
        const after = await facts(id);
        assert.equal(after.characters.find(row => row.id === id).sp, 0);
        assert.equal(after.items.filter(row => row.characterId === id && row.selfId === training.bookId).length, 0);
        assert.equal(after.skills.find(row => row.characterId === id && row.selfId === training.skillId).level, training.level);
        assert.equal(Database.stats().failures, failuresBefore);
    }
}
async function versionedClassWriter(key, mode) {
    const id = await seed(), initial = Life.snapshot(id);
    assert(await Life.upsertState({ ...initial, level: 20, exp: Number(Data.experience[19]) + 1,
        stats: { ...initial.stats, [key]: mode === 'stale' ? 0 : 1 } }, 'authored_class_training_fixture'));
    const state = Life.snapshot(id), beforeWrite = Database.createColdTrainingGuard(state, () => {});
    const target = invoke('GameServer/Bot/BotClassProgression').plan({ classId: 0, level: 20, seed: id }).classId;
    assert.notEqual(target, 0, 'the real first-profession writer has an authored target');
    await Database.execute([`UPDATE bot_life_state SET statsJson=json_set(statsJson, '$.${key}', ?) WHERE characterId=?`,
        [mode === 'lower' ? 0 : 1, id]]);
    const before = await facts(id), failuresBefore = Database.stats().failures;
    if (mode === 'stale') {
        await assert.rejects(Database.updateCharacterClassId(id, target, { beforeWrite }),
            error => Database.isColdTrainingSourceRetired(error));
        assert.deepEqual(await facts(id), before, `${key} rejects before real first-profession class SQL`);
        assert.equal(Database.stats().failures, failuresBefore + 1);
    } else {
        assert.equal((await Database.updateCharacterClassId(id, target, { beforeWrite })).affectedRows, 1);
        const after = await facts(id);
        assert.equal(after.characters.find(row => row.id === id).classId, target);
        assert.equal(after.characters.find(row => row.id === id).sp, state.sp);
        assert.deepEqual(after.skills, before.skills);
        assert.equal(Database.stats().failures, failuresBefore);
    }
}

async function hiddenVersionTraining(kind, worker) {
    const id = await seed(), state = Life.snapshot(id);
    if (kind === 'non_enumerable') {
        Object.defineProperty(state.stats, 'clanInventoryRevision', { value: 1, enumerable: false });
    } else state.stats = Object.assign(Object.create({ clanInventoryRevision: 1 }), state.stats);
    assert.equal(state.stats.clanInventoryRevision, 1);
    assert.equal(JSON.parse(JSON.stringify(state.stats)).clanInventoryRevision, undefined,
        'the actual ROW JSON omits inherited/non-enumerable counters');
    const request = command(state);
    await Database.execute(["UPDATE bot_life_state SET statsJson=json_set(statsJson,'$.clanInventoryRevision',1) WHERE characterId=?", [id]]);
    const before = await facts(id), failuresBefore = Database.stats().failures;
    let result;
    if (worker) {
        const c = new ColdSimulationCoordinator(), sent = [];
        c.ready = true; c.workerEpoch = `hidden-training:${id}`;
        c.worker = { postMessage(message) { sent.push(clone(message)); }, terminate: async () => {} };
        c.contextIndex = () => ({}); c.contextFor = () => ({}); c.population = Population;
        await c.onMessage(Protocol.envelope('command_request', c.workerEpoch, { requests: [request] }, `hidden-message:${id}`),
            c.worker, c.workerEpoch);
        await c.commandTail;
        assert.equal(c.commandInflight.size, 0);
        const acknowledgements = sent.filter(message => message.type === 'command_ack');
        assert.equal(acknowledgements.length, 1);
        result = acknowledgements[0].payload.results[0];
    } else result = await Population.executeWorkerLifecycleCommand(state, request);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'apply_failed');
    assert.deepEqual(await facts(id), before, `${kind} floor must match omitted ROW value0 before physical SP/skill debit`);
    assert.equal(Database.stats().failures, failuresBefore + 1);
}

async function versionScalarValidation() {
    const id = await seed(), state = Life.snapshot(id), before = await facts(id);
    let toJsonCalls = 0, getterCalls = 0;
    const object = { toJSON() { toJsonCalls++; throw Error('must_not_serialize_counter_object'); } };
    for (const value of [{}, object, 1n, () => {}, Symbol('version')]) {
        assert.throws(() => Database.createColdTrainingGuard({ ...state,
            stats: { ...state.stats, clanInventoryRevision: value } }, () => {}),
        error => error instanceof TypeError && error.message === 'invalid_cold_training_version');
    }
    const stats = { ...state.stats };
    Object.defineProperty(stats, 'clanInventoryRevision', { enumerable: true,
        get() { getterCalls++; throw Error('must_not_read_counter_accessor'); } });
    assert.throws(() => Database.createColdTrainingGuard({ ...state, stats }, () => {}),
        error => error instanceof TypeError && error.message === 'invalid_cold_training_version');
    const hidden = { ...state.stats };
    Object.defineProperty(hidden, 'clanInventoryRevision', { enumerable: false,
        get() { getterCalls++; throw Error('must_not_read_omitted_accessor'); } });
    assert.equal(typeof Database.createColdTrainingGuard({ ...state, stats: hidden }, () => {}), 'function');
    const inherited = Object.assign(Object.create({ clanInventoryRevision: object }), state.stats);
    assert.equal(typeof Database.createColdTrainingGuard({ ...state, stats: inherited }, () => {}), 'function');
    assert.equal(toJsonCalls, 0);
    assert.equal(getterCalls, 0);
    assert.deepEqual(await facts(id), before, 'invalid scalar metadata cannot create native work or persist facts');
    const mutable = { ...state, stats: { ...state.stats } };
    const beforeWrite = Database.createColdTrainingGuard(mutable, () => {});
    mutable.stats.clanInventoryRevision = 1;
    await Database.execute(["UPDATE bot_life_state SET statsJson=json_set(statsJson,'$.clanInventoryRevision',1) WHERE characterId=?", [id]]);
    const barrier = await facts(id);
    await assert.rejects(Database.learnBotSkill(id, 3, 1, { beforeWrite }),
        error => Database.isColdTrainingSourceRetired(error));
    assert.deepEqual(await facts(id), barrier, 'a later input mutation never replaces captured original version floors');
}

async function versionScalarSemantics() {
    const { DatabaseSync } = require('node:sqlite');
    const sql = new DatabaseSync(':memory:');
    try {
        const values = [undefined, null, 0, 1, 2, -1, 0.5, '1', '0', true, false];
        for (const incoming of values) for (const durable of values) {
            const stored = JSON.stringify({ clanInventoryRevision: durable });
            const rowInput = JSON.stringify({ clanInventoryRevision: incoming });
            const captured = JSON.stringify(incoming ?? null);
            const row = sql.prepare(`SELECT COALESCE(json_extract(?, '$.clanInventoryRevision'),0)
                <= COALESCE(json_extract(?, '$.clanInventoryRevision'),0) AS admitted`).get(stored, rowInput).admitted;
            const guard = sql.prepare(`SELECT COALESCE(json_extract(?, '$.clanInventoryRevision'),0)
                <= COALESCE(json_extract(?, '$'),0) AS admitted`).get(stored, captured).admitted;
            assert.equal(guard, row, 'captured JSON scalar preserves native SQLite type ordering and null coalescing');
        }
    } finally { sql.close(); }
}

async function check(name, work) {
    try { await work(); console.log(`PASS ${name}`); }
    catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.stack}`); }
}
(async () => {
    directory = isolated.directory;
    options.default.Database.path = path.join(directory, 'world.sqlite');
    options.default.Database.historyPath = path.join(directory, 'history.sqlite');
    Database.init(); assert(Database.isReady()); Data.init(); await Life.init();
    for (const mode of ['current', 'replace', 'stop', 'changed', 'fence', 'claimed', 'deadline_metadata', 'owned_replaced', 'request_changed']) {
        await check(`native inner ${mode}`, () => inner(mode));
    }
    for (const key of ['clanInventoryRevision', 'clanLevelSpVersion', 'clanMembershipVersion']) {
        for (const mode of ['stale', 'current', 'lower']) await check(`manual versioned ${key}:${mode}`,
            () => versionedTraining(key, mode));
        for (const mode of ['stale', 'current', 'lower']) {
            await check(`worker versioned ${key}:${mode}`, () => versionedTraining(key, mode, true));
        }
        for (const mode of ['stale', 'current', 'lower']) {
            await check(`real book transaction ${key}:${mode}`, () => versionedBookTraining(key, mode));
            await check(`real class writer ${key}:${mode}`, () => versionedClassWriter(key, mode));
        }
    }
    await check('native ROW JSON scalar <= semantics', versionScalarSemantics);
    await check('own scalar validation and immutable original floor', versionScalarValidation);
    for (const kind of ['non_enumerable', 'inherited']) for (const worker of [false, true]) {
        await check(`hidden version ${kind}:${worker ? 'worker' : 'manual'}`, () => hiddenVersionTraining(kind, worker));
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
