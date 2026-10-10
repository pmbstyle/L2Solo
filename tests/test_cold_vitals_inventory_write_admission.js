process.env.BOT_DEVELOPER_DIAGNOSTICS = 'true'; // This fixture inspects optional developer metrics.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const gameRoot = process.env.N53_GAME_ROOT || path.resolve(__dirname, '..');
require(path.join(gameRoot, 'tests/helpers/databaseIsolation'));
const isolated = require(path.join(gameRoot, 'tests/helpers/isolatedSocialDatabase'))('vitals-inventory-write-admission-profile', gameRoot);
const { DatabaseSync } = require('node:sqlite');
require(path.join(gameRoot, 'src/Global'));
isolated.assertConfigured(options.default);
const Database = invoke('Database');
const Data = invoke('GameServer/DataCache');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Population = invoke('GameServer/Bot/Population/PopulationService');
const Protocol = invoke('GameServer/Bot/Population/ColdSimulationProtocol');
const { ColdSimulationCoordinator } = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const { WorkerCommandAdmissionRefusal } = require(path.join(gameRoot, 'src/GameServer/Bot/Population/WorkerCommandAdmission'));
const clone = value => JSON.parse(JSON.stringify(value));
const realImmediate = setImmediate;
const turn = () => new Promise(done => realImmediate(done));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function wait(promise, label) {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('timeout: ' + label)), 3000); })]); }
    finally { clearTimeout(timer); }
}
let directory = isolated.directory, serial = 0;
const failures = [];
function facts(id) {
    const db = new DatabaseSync(options.default.Database.path, { readOnly: true });
    try {
        const result = {};
        for (const table of ['bot_life_state', 'characters', 'skills', 'items', 'warehouse_items', 'afk_trade_shops', 'afk_trade_lines']) {
            result[table] = clone(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
        }
        result.cache = clone(Life.cachedState(id)); return result;
    } finally { db.close(); }
}
const physical = (image, id) => image.characters.find(row => row.id === id);
const lifeRow = (image, id) => image.bot_life_state.find(row => row.characterId === id);
const material = (image, id) => image.items.filter(row => row.characterId === id && row.selfId === 1869);
const preparedSkills = new Map();
async function prepareNativeProfile(id) {
    const input = Life.snapshot(id);
    const before = facts(id);
    assert.equal(before.characters.find(row => row.id === id).level, 7);
    assert.equal(before.characters.find(row => row.id === id).exp, input.exp);
    assert.equal(before.characters.find(row => row.id === id).sp, 120);
    assert.equal(input.sp, 120);
    const beforeWrite = Database.createColdTrainingGuard(input, () => {
        assert.equal(Life.cachedState(id), input);
    });
    const training = await invoke('GameServer/Bot/BotClassProgression').reconcile({
        characterId: id, classId: 0, level: 7, seed: id,
    }, { beforeWrite });
    // Authored class0 order: Power Strike ranks1/2 cost50 each; remaining20
    // cannot buy rank3. Lucky/CommonCraft/CreateCommon each cost0 at level7.
    assert.equal(training.spentSp, 100);
    assert.equal(training.learnedCount, 5);
    assert.deepEqual(training.consumedBooks, []);
    assert.deepEqual(training.transitions, []);
    const row = await Database.publishColdTraining(id, training, { beforeWrite });
    const accepted = Life.acceptNewerLifecycleRow(row);
    assert.equal(accepted, Life.cachedState(id));
    assert.equal(accepted.level, 7); assert.equal(accepted.exp, input.exp);
    assert.equal(accepted.sp, 20); assert.equal(accepted.stats.classId, 0);
    assert.equal(invoke('GameServer/Skills/SkillBookCatalog').needsTraining(accepted), false);
    const after = facts(id), skills = after.skills.filter(skill => skill.characterId === id);
    assert.deepEqual(skills.map(skill => [skill.selfId, skill.level]).sort((a, b) => a[0] - b[0]),
        [[3, 2], [194, 1], [1320, 1], [1322, 1]]);
    assert.equal(after.characters.find(character => character.id === id).sp, accepted.sp);
    for (const table of ['items', 'warehouse_items', 'afk_trade_shops', 'afk_trade_lines'])
        assert.deepEqual(after[table], before[table], 'native profile preparation never changes physical items/trade');
    assert(!Protocol.sameCommandCheckpoint(Protocol.commandCheckpoint(input), accepted), 'publishColdTraining legitimately rebases the checkpoint');
    preparedSkills.set(id, clone(skills));
    console.log('NATIVE_PRETRAIN', JSON.stringify({ id, allocatedSp: 120, training, physicalSp: accepted.sp,
        skills, checkpointBefore: Protocol.commandCheckpoint(input), checkpointAfter: Protocol.commandCheckpoint(accepted) }));
}

async function seed() {
    const account = `bot_vi_admission_${++serial}`;
    await Database.createAccount(account, 'fixture');
    const id = Number((await Database.createCharacter(account, { name: `VIAdmission${serial}`, race: 0, classId: 0,
        sex: 0, face: 0, hair: 0, hairColor: 0, maxHp: 100, maxMp: 100, locX: 83000, locY: 148000, locZ: -3400 })).insertId);
    for (const item of [{ selfId: 57, name: 'Adena', amount: 1000 }, { selfId: 1869, name: 'Stem', amount: 2 }]) {
        await Database.setItem(id, { ...item, equipped: false, enchant: 0, slot: 0 });
    }
    const level = 7, time = Date.now();
    assert(await Life.upsertState({ characterId: id, accountName: account, name: `VIAdmission${serial}`, level,
        exp: Number(Data.experience[level - 1]) + 1, sp: 120, adena: 1000,
        inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)), phase: 'cold', activity: 'resting',
        loc: { locX: 83000, locY: 148000, locZ: -3400 }, vitals: { hp: 85, maxHp: 100, mp: 70, maxMp: 100 },
        timing: { lastResolvedAt: time - 45000, nextResolveAt: time + 30000 },
        stats: { classId: 0, classProgressionLevel: level, classProgressionClassId: 0, restUntil: time + 30000 } }, 'vi_admission_seed'));
    await prepareNativeProfile(id);
    return id;
}
function holdQueue(entered, gate, label) {
    let armed = true;
    global.setImmediate = (callback, ...values) => {
        if (armed && new Error().stack.includes('yieldToEventLoop')) {
            armed = false; entered.resolve(); return realImmediate(async () => { await gate.promise; callback(...values); });
        }
        return realImmediate(callback, ...values);
    };
    return Database.cooperatively(() => Database.execute(['SELECT 1 AS real_vi_queue', [], { onTiming() {
        const end = Date.now() + 2; while (Date.now() < end) { /* Reach the existing cooperative yield. */ }
    } }], label), 1);
}
async function workerBoundary(writer, stage, mode) {
    const id = await seed(), state = Life.snapshot(id), time = Date.now(), expDelta = 13;
    const request = { kind: 'lifecycle', characterId: id, commandId: `vi:${serial}`, commandCheckpoint: Protocol.commandCheckpoint(state),
        state, context: {}, precomputedResult: { patch: { activity: 'resting', vitals: { ...state.vitals, hp: 90 }, stats: { restUntil: time + 60000 } },
            events: [], materialize: { exp: expDelta, sp: 0, adena: 0, items: [{ selfId: 1869, amount: 3 }] }, nextResolveAt: time + 60000 } };
    const c = new ColdSimulationCoordinator(), sent = [], entered = deferred(), gate = deferred(), called = deferred();
    const stopEntered = deferred(), stopGate = deferred();
    c.ready = true; c.workerEpoch = `vi:${serial}`;
    const worker = label => ({ postMessage(message) { sent.push({ label, message: clone(message) });
        if (message.type === 'fence') realImmediate(() => c.onMessage(Protocol.envelope('fence_ack', message.workerEpoch,
            { characterId: id, proposal: null, token: null }, message.msgId), c.worker, c.workerEpoch));
        if (message.type === 'shutdown') realImmediate(() => c.onMessage(Protocol.envelope('drained', message.workerEpoch,
            { ok: true }, message.msgId), c.worker, c.workerEpoch));
    }, terminate: async () => {} });
    c.worker = worker('A'); const originalWorker = c.worker, originalEpoch = c.workerEpoch;
    let admission, control, stop, targetEntered = false, held = false, targetFlushes = 0, flushCompleted = false;
    c.population = { executeWorkerLifecycleCommand(...args) { admission = args[2]?.workerAdmission;
        return Population.executeWorkerLifecycleCommand(...args); } };
    c.contextIndex = () => ({}); c.contextFor = () => ({});
    const method = writer === 'vitals' ? 'updateCharacterVitals' : 'syncInventorySummary';
    const original = Database[method];
    Database[method] = function (...args) {
        if (args[0] === id) { targetEntered = true; called.resolve(); }
        return original.apply(this, args);
    };
    Database.registerCharacterWriteFlush(async currentId => {
        if (currentId !== id || !targetEntered || held) return;
        held = true; targetFlushes++;
        if (stage === 'flush') { entered.resolve(); await gate.promise; }
        else { control = holdQueue(entered, gate, `vi:${writer}-worker-control-read`); flushCompleted = true; }
    });
    try {
        await c.onMessage(Protocol.envelope('command_request', originalEpoch, { requests: [request] }, `vi-message:${serial}`), originalWorker, originalEpoch);
        await wait(entered.promise, `actual ${writer} ${stage}`); await wait(called.promise, 'original native writer called');
        await turn();
        if (stage === 'queue') { assert(flushCompleted); assert(Database.stats().pending >= 1, 'original write waits in real queryTail after completed flush'); }
        assert(c.commandInflight.has(id)); assert.equal(targetFlushes, 1);
        assert.equal(admission.check(), null, 'original cached checkpoint/source/promise still current after own ROW and EXP');
        const initial = facts(id), oldCharacter = physical(initial, id), oldLife = lifeRow(initial, id), oldMaterial = material(initial, id);
        assert.equal(oldLife.hp, 90); assert.equal(oldLife.exp, state.exp + expDelta);
        assert.equal(JSON.parse(oldLife.inventorySummary)['1869'].amount, 5, 'own ROW already contains the materialized summary');
        assert.equal(oldCharacter.exp, state.exp + expDelta, 'normal physical EXP is already durable');
        assert.equal(oldCharacter.hp, writer === 'vitals' ? 85 : 90, 'partial physical vitals depend on the held writer');
        assert.equal(oldMaterial.length, 1); assert.equal(oldMaterial[0].amount, 2, 'changing inventory proposal not yet synchronized');
        assert.deepEqual(initial.skills.filter(row => row.characterId === id), preparedSkills.get(id),
            'prepared native skill facts stay exact before the held vitals/inventory writer');
        assert.equal(oldCharacter.classId, 0); assert.equal(initial.cache.vitals.hp, 85);
        assert.equal(initial.cache.exp, state.exp); assert.equal(initial.cache.inventory['1869'].amount, 2);
        assert(Protocol.sameCommandCheckpoint(request.commandCheckpoint, initial.cache));
        if (mode === 'replace') {
            c.worker = worker('B'); c.workerEpoch = 'vi:replacement';
            assert.deepEqual(admission.check(), { reason: 'stale_worker_source' });
        }
        if (mode === 'stop') {
            c.started = true; c.competitionActions.stop = async () => { stopEntered.resolve(); await stopGate.promise; };
            stop = c.stop(); await wait(stopEntered.promise, 'actual stop wait'); assert(c.stopping);
            assert.deepEqual(admission.check(), { reason: 'coordinator_stopping' });
        }
        if (mode === 'fence') {
            assert.equal((await c.fenceBot(id, 10)).ok, true); assert(c.fencedBots.has(id));
            assert.deepEqual(admission.check(), { reason: 'hot_handoff_fenced' });
        }
        if (mode === 'changed') {
            const db = new DatabaseSync(options.default.Database.path);
            try {
                db.prepare('UPDATE bot_life_state SET updatedAt=? WHERE characterId=?').run(Date.now() + 1000, id);
                Life.acceptLifecycleRow(db.prepare('SELECT * FROM bot_life_state WHERE characterId=?').get(id));
            } finally { db.close(); }
            assert(!Protocol.sameCommandCheckpoint(request.commandCheckpoint, Life.cachedState(id)));
            assert.deepEqual(admission.check(), { reason: 'stale_command' });
        }
        // This exact partial image is captured AFTER the authority control.
        // ROW/EXP, and inventory-stage vitals, are already committed facts.
        const barrier = facts(id); gate.resolve(); await control; await c.commandTail;
        const after = facts(id), character = physical(after, id), item = material(after, id), acks = sent.filter(row => row.message.type === 'command_ack');
        const changed = Object.keys(barrier).filter(key => JSON.stringify(barrier[key]) !== JSON.stringify(after[key]));
        console.log(JSON.stringify({ writer, stage, mode, targetFlushes, flushCompleted,
            beforeLifeHp: oldLife.hp, afterLifeHp: lifeRow(after, id).hp,
            beforeLifeExp: oldLife.exp, afterLifeExp: lifeRow(after, id).exp,
            beforePhysicalExp: oldCharacter.exp, afterPhysicalExp: character.exp,
            beforePhysicalHp: oldCharacter.hp, afterPhysicalHp: character.hp,
            beforeMaterial: oldMaterial[0].amount, afterMaterial: item[0]?.amount,
            materialIdBefore: oldMaterial[0].id, materialIdAfter: item[0]?.id,
            beforeCacheHp: barrier.cache.vitals.hp, afterCacheHp: after.cache.vitals.hp,
            beforeCacheMaterial: barrier.cache.inventory['1869'].amount, afterCacheMaterial: after.cache.inventory['1869'].amount,
            originalCheckpointCurrentBeforeControl: true, changed,
            receipts: acks.map(row => ({ label: row.label, ok: row.message.payload.results[0]?.ok,
                commandId: row.message.payload.results[0]?.commandId,
                checkpoint: row.message.payload.results[0]?.commandCheckpoint })) }));
        assert.equal(c.commandInflight.size, 0);
        if (mode === 'current') {
            assert.equal(character.hp, 90); assert.equal(character.exp, state.exp + expDelta);
            assert.equal(item.length, 1); assert.equal(item[0].amount, 5); assert.equal(item[0].id, oldMaterial[0].id);
            assert.equal(after.cache.vitals.hp, 90); assert.equal(after.cache.inventory['1869'].amount, 5);
            assert.equal(acks.length, 1); assert.equal(acks[0].label, 'A'); assert.equal(acks[0].message.payload.results[0].ok, true);
            assert.deepEqual(acks[0].message.payload.results[0].commandCheckpoint, request.commandCheckpoint);
        } else {
            if (mode === 'replace') assert.equal(acks.length, 0, 'existing source guard suppresses old receipt');
            else {
                assert.equal(acks.length, 1); const result = acks[0].message.payload.results[0];
                assert.equal(result.ok, false); assert.equal(result.retryAfterMs, 1000);
                assert.equal(result.reason, mode === 'stop' ? 'coordinator_stopping' : mode === 'fence' ? 'hot_handoff_fenced' : 'stale_command');
                assert.deepEqual(result.commandCheckpoint, request.commandCheckpoint);
            }
            if (writer === 'vitals') assert.equal(character.hp, 85, 'retired source cannot execute held genuine HP-changing SQL');
            else assert.equal(item[0].amount, 2, 'retired source cannot execute held genuine item-changing transaction');
            assert.deepEqual(after, barrier, 'refusal conserves all seven tables and cache at this partial barrier');
        }
    } finally {
        gate.resolve(); await control?.catch(() => null); await c.commandTail.catch(() => null);
        global.setImmediate = realImmediate; Database[method] = original; Database.registerCharacterWriteFlush(null);
        stopGate.resolve(); if (stop) await stop;
    }
}
function writeProposal(writer, id, bag) {
    return writer === 'vitals' ? Database.updateCharacterVitals(id, 90, 100, 75, 100, bag)
        : Database.syncInventorySummary(id, { 1869: { selfId: 1869, name: 'Stem', amount: 5 } }, 'vi_domain', bag);
}
function assertProposal(writer, image, id) {
    if (writer === 'vitals') { assert.equal(physical(image, id).hp, 90); assert.equal(physical(image, id).mp, 75); }
    else { assert.equal(material(image, id).length, 1); assert.equal(material(image, id)[0].amount, 5); }
}
function assertResult(writer, result, id) {
    if (writer === 'vitals') {
        assert.equal(result.affectedRows, 1); assert.equal(typeof result.insertId, 'number');
        assert.deepEqual(Object.keys(result).sort(), ['affectedRows', 'insertId']);
    } else assert.deepEqual(result, { characterId: id, entries: 1 });
}
async function manualParity(writer) {
    const id = await seed(), initial = facts(id), label = writer === 'vitals' ? 'character:vitals' : 'inventory:sync-summary:vi_domain';
    let flushes = 0; Database.registerCharacterWriteFlush(async currentId => { assert.equal(currentId, id); flushes++; });
    try {
        const before = Database.stats(), result = await writeProposal(writer, id), after = Database.stats();
        assertResult(writer, result, id); assertProposal(writer, facts(id), id); assert.equal(flushes, 1);
        assert.equal(after.operations[label].count, Number(before.operations[label]?.count || 0) + 1);
        assert.equal(after.writes, before.writes + 1); assert.equal(after.reads, before.reads);
        assert.equal(after.transactions, before.transactions + (writer === 'inventory' ? 1 : 0));
        if (writer === 'inventory') {
            const current = facts(id);
            assert.equal(material(current, id)[0].id, material(initial, id)[0].id);
            assert.deepEqual(current.items.filter(row => row.characterId === id && row.selfId === 57),
                initial.items.filter(row => row.characterId === id && row.selfId === 57), 'omitted inventory key is preserved');
        }
    } finally { Database.registerCharacterWriteFlush(null); }
}
async function callbackDomain(writer) {
    const id = await seed(); let calls = 0, thenCalls = 0;
    const unhandled = [], listener = error => unhandled.push(error);
    process.on('unhandledRejection', listener);
    try {
        const result = await writeProposal(writer, id, { beforeWrite: function () {
            'use strict'; assert.equal(this, undefined, 'opaque capture is never the callback receiver'); calls++;
        } });
        assertResult(writer, result, id); assertProposal(writer, facts(id), id); assert.equal(calls, 1);
        if (writer === 'vitals') await Database.updateCharacterVitals(id, 85, 100, 70, 100);
        else await Database.syncInventorySummary(id, { 1869: { selfId: 1869, amount: 2 } });
        const before = facts(id);
        const accessor = Object.defineProperty({}, 'beforeWrite', { get() { throw Error('must_not_evaluate_accessor'); } });
        const invalid = [null, [], { beforeWrite: undefined }, { beforeWrite: null }, { beforeWrite: 0 }, accessor,
            Object.create({ beforeWrite() { throw Error('must_not_adopt_inherited'); } }),
            { beforeWrite: () => null }, { beforeWrite: () => 0 }, { beforeWrite: () => ({}) },
            { beforeWrite: async () => undefined }, { beforeWrite: () => Promise.reject(Error('native_rejected_vi_guard')) },
            { beforeWrite: () => Promise.reject(new WorkerCommandAdmissionRefusal('stale_command')) },
            { beforeWrite: () => Object.defineProperty({}, 'then', { get() { thenCalls++; throw Error('must_not_read_then'); } }) }];
        for (const bag of invalid) {
            const metrics = Database.stats();
            await assert.rejects(writeProposal(writer, id, bag), error => error instanceof TypeError);
            assert.deepEqual(facts(id), before, 'invalid callback cannot execute the SAME changing HP/item proposal');
            if (writer === 'inventory') assert.equal(Database.stats().transactions, metrics.transactions + 1, 'existing BEGIN precedes work validation');
        }
        for (const error of [Object.assign(Error('plain_same_code'), { code: 'BOT_WORKER_COMMAND_ADMISSION_REFUSED' }),
            new WorkerCommandAdmissionRefusal('stale_command')]) {
            await assert.rejects(writeProposal(writer, id, { beforeWrite() { throw error; } }), found => found === error);
            assert.deepEqual(facts(id), before);
        }
        const reflectionError = Error('original_vi_descriptor_failure');
        await assert.rejects(writeProposal(writer, id, new Proxy({}, { getOwnPropertyDescriptor() { throw reflectionError; } })), error => error === reflectionError);
        assert.deepEqual(facts(id), before); await turn(); assert.deepEqual(unhandled, []); assert.equal(thenCalls, 0);
        assertResult(writer, await writeProposal(writer, id), id); assertProposal(writer, facts(id), id);
    } finally { process.removeListener('unhandledRejection', listener); }
}
async function captureBoundary(writer, stage, mode) {
    const id = await seed(), entered = deferred(), gate = deferred(); let calls = 0, control, job, flushes = 0;
    const bag = mode === 'invalid_replaced' ? { beforeWrite: undefined } : { beforeWrite() { calls++; } };
    Database.registerCharacterWriteFlush(async currentId => {
        assert.equal(currentId, id); flushes++;
        if (stage === 'flush') { entered.resolve(); await gate.promise; }
    });
    try {
        if (stage === 'queue') { control = holdQueue(entered, gate, 'vi:direct-control-read'); await wait(entered.promise, 'actual queued read entered'); }
        job = writeProposal(writer, id, bag); const outcome = job.then(value => ({ value }), error => ({ error }));
        if (stage === 'flush') await wait(entered.promise, 'actual native flush pending');
        else { await turn(); assert(Database.stats().pending >= 1); }
        assert.equal(flushes, 1); const before = facts(id);
        assert.equal(physical(before, id).hp, 85); assert.equal(material(before, id)[0].amount, 2);
        if (mode === 'replaced') bag.beforeWrite = () => { throw Error('must_not_adopt_late_callback'); };
        else bag.beforeWrite = () => undefined;
        gate.resolve(); await control; const result = await outcome;
        if (mode === 'replaced') { assertResult(writer, result.value, id); assert.equal(calls, 1); assertProposal(writer, facts(id), id); }
        else { assert(result.error instanceof TypeError); assert.equal(calls, 0); assert.deepEqual(facts(id), before); }
    } finally {
        gate.resolve(); await control?.catch(() => null); await job?.catch(() => null);
        Database.registerCharacterWriteFlush(null); global.setImmediate = realImmediate;
    }
}
async function ordinaryFailures(writer) {
    const id = await seed(), error = Error('native_vi_flush_error'); let calls = 0;
    Database.registerCharacterWriteFlush(async () => { throw error; }); const before = facts(id);
    try {
        await assert.rejects(writeProposal(writer, id, { beforeWrite() { calls++; } }), found => found === error);
        await assert.rejects(writeProposal(writer, id, { beforeWrite: undefined }), found => found === error);
        assert.equal(calls, 0); assert.deepEqual(facts(id), before);
    } finally { Database.registerCharacterWriteFlush(null); }
    const invalid = writer === 'vitals'
        ? Database.updateCharacterVitals(id, { unsupported: true }, 100, 75, 100, { beforeWrite() { calls++; } })
        : Database.syncInventorySummary(id, { 1870: { selfId: 1870, amount: 1, name: { unsupported: true } } }, null, { beforeWrite() { calls++; } });
    await assert.rejects(invalid, found => !(found instanceof WorkerCommandAdmissionRefusal));
    assert.equal(calls, 1); assert.deepEqual(facts(id), before);
    assertResult(writer, await writeProposal(writer, id), id); assertProposal(writer, facts(id), id);
}
async function inventoryRollback() {
    const id = await seed(), before = facts(id); let calls = 0;
    const proposal = { 1869: { selfId: 1869, amount: 5 }, 1870: { selfId: 1870, amount: 1, name: { unsupported: true } } };
    await assert.rejects(Database.syncInventorySummary(id, proposal, 'vi_rollback', { beforeWrite() { calls++; } }));
    assert.equal(calls, 1); assert.deepEqual(facts(id), before, 'later native binding error rolls back the preceding actual Stem UPDATE');
    proposal[1870].name = 'Coal';
    assert.deepEqual(await Database.syncInventorySummary(id, proposal, 'vi_rollback'), { characterId: id, entries: 2 });
    assert.equal(material(facts(id), id)[0].amount, 5);
    assert(facts(id).items.some(row => row.characterId === id && row.selfId === 1870 && row.amount === 1), 'SAME repaired proposal really mutates both entries');
}
async function shutdownPriority() {
    const id = await seed(); await Database.close(); let calls = 0;
    await assert.rejects(Database.updateCharacterVitals(id, 90, 100, 75, 100, { beforeWrite() { calls++; } }), error => error.message === 'SQLite shutdown is in progress (character:vitals)');
    await assert.rejects(Database.syncInventorySummary(id, {}, null, { beforeWrite() { calls++; } }), error => error.message === 'SQLite shutdown is in progress (inventory:sync-summary)');
    assert.equal(calls, 0, 'original shutdown queue refusal occurs before callback');
}
async function check(name, work) {
    try { await work(); console.log('PASS', name); }
    catch (error) { failures.push(name); console.error('FAIL', name, error.stack); }
}
(async () => {
    Database.init(); assert(Database.isReady()); Data.init(); await Life.init();
    const sourceHashes = {};
    for (const file of ['src/Database.js', 'src/GameServer/Bot/Population/BotLifeState.js',
        'src/GameServer/Bot/Population/ColdSimulationCoordinator.js', 'src/GameServer/Bot/Population/PopulationService.js']) {
        sourceHashes[file] = crypto.createHash('sha256').update(fs.readFileSync(path.join(gameRoot, file))).digest('hex');
    }
    console.log(JSON.stringify({ source: gameRoot, sourceHashes, fixture: __filename, boundary: 'actual Main/native chain; controlled Worker identity, not an OS Worker' }));
    if (process.argv.includes('--shutdown-only')) {
        await check('original shutdown queue refusal precedes admission', shutdownPriority);
        if (failures.length) throw Error('VI shutdown priority control failed');
        return;
    }
    // All genuine current proposals precede any retired-source refusal claim.
    for (const writer of ['vitals', 'inventory']) for (const stage of ['flush', 'queue']) {
        await check(`current ${writer} ${stage}`, () => workerBoundary(writer, stage, 'current'));
    }
    if (failures.length) throw Error('VI healthy baseline invalid: ' + failures.join(', '));
    for (const mode of ['replace', 'stop', 'fence', 'changed']) for (const writer of ['vitals', 'inventory']) for (const stage of ['flush', 'queue']) {
        await check(`${mode} ${writer} ${stage}`, () => workerBoundary(writer, stage, mode));
    }
    for (const writer of ['vitals', 'inventory']) {
        await check(`manual ${writer} genuine mutation / original result / metrics`, () => manualParity(writer));
        await check(`strict ${writer} callback domain / errors / no async admission`, () => callbackDomain(writer));
        for (const stage of ['flush', 'queue']) for (const mode of ['replaced', 'invalid_replaced']) {
            await check(`method-time ${writer} capture ${stage}:${mode}`, () => captureBoundary(writer, stage, mode));
        }
        await check(`ordinary ${writer} flush / native errors / queue cleanup`, () => ordinaryFailures(writer));
    }
    await check('original inventory transaction native partial DML rollback', inventoryRollback);
    await check('original shutdown queue refusal precedes admission', shutdownPriority);
    if (failures.length) throw Error('VI next-writer contracts failed: ' + failures.join(', '));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    await Database.close(); if (directory) fs.rmSync(directory, { recursive: true, force: true });
});
