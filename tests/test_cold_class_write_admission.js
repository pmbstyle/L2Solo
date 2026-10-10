process.env.BOT_DEVELOPER_DIAGNOSTICS = 'true'; // This fixture inspects optional developer metrics.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const gameRoot = process.env.N53_GAME_ROOT || path.resolve(__dirname, '..');
require(path.join(gameRoot, 'tests/helpers/databaseIsolation'));
const isolated = require(path.join(gameRoot, 'tests/helpers/isolatedSocialDatabase'))('class-write-native-paid-profile', gameRoot);
// Admission-only authoring explicitly uses native Knowledge OFF, before Global.
fs.writeFileSync(isolated.ini, fs.readFileSync(isolated.ini, 'utf8')
    .replace(/^knowledgeErrorsEnabled\s*=\s*true$/m, 'knowledgeErrorsEnabled = false'));
const { DatabaseSync } = require('node:sqlite');
require(path.join(gameRoot, 'src/Global'));
isolated.assertConfigured(options.default);
const Database = invoke('Database');
const Data = invoke('GameServer/DataCache');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Progression = invoke('GameServer/Bot/BotClassProgression');
const Population = invoke('GameServer/Bot/Population/PopulationService');
const Protocol = invoke('GameServer/Bot/Population/ColdSimulationProtocol');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
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

// ARCH-NOTE: FX-E6 retains native SP costs. With the declared 120 SP the
// class0 prefix is two 50-SP ranks plus three free skills, not nine grants.
const ancestorRanks = [[3, 2], [194, 1], [1320, 1], [1322, 1]];
const firstProfessionRanks = [[3, 2], [194, 1], [239, 1], [1320, 2], [1322, 1]];
const skillRows = (image, id) => image.skills.filter(skill => skill.characterId === id);
const skillRanks = (image, id) => skillRows(image, id)
    .map(skill => [skill.selfId, skill.level]).sort((a, b) => a[0] - b[0]);
function assertAuthoredPaidPlan(targetClass = 0) {
    const authoredRank = (classId, skillId, level) => Data.skillTree
        .find(tree => Number(tree.classId) === classId)?.skills
        .find(skill => Number(skill.selfId) === skillId)?.levels
        .find(rank => Number(rank.level) === level);
    for (const [skillId, levels, cost] of [[3, [1, 2, 3], 50], [194, [1], 0],
        [1320, [1], 0], [1322, [1], 0]]) {
        for (const level of levels) {
            const rank = authoredRank(0, skillId, level);
            assert(rank, 'the independently declared class0 rank must be authored');
            assert.equal(Number(rank.sp), cost);
            assert(Number(rank.pLevel) <= 7);
            assert(Data.skills.find(skill => Number(skill.selfId) === skillId)?.levels
                .some(defined => Number(defined.level) === level), 'native skill definition must exist');
        }
        assert.equal(invoke('GameServer/Skills/SkillBookCatalog').bookFor(skillId), null,
            'these declared class0 skills have no authored book prerequisite');
    }
    if (targetClass !== 0) {
        assert([1, 4, 7].includes(targetClass));
        for (const [skillId, level] of [[239, 1], [1320, 2]]) {
            const rank = authoredRank(targetClass, skillId, level);
            assert(rank, 'the selected authored first-profession free rank must exist');
            assert.equal(Number(rank.sp), 0);
            assert.equal(Number(rank.pLevel), 20);
            assert(Data.skills.find(skill => Number(skill.selfId) === skillId)?.levels
                .some(defined => Number(defined.level) === level));
        }
    }
}

async function seed() {
    const account = `bot_class_admission_${++serial}`;
    await Database.createAccount(account, 'fixture');
    const id = Number((await Database.createCharacter(account, { name: `ClassAdmission${serial}`, race: 0, classId: 0,
        sex: 0, face: 0, hair: 0, hairColor: 0, maxHp: 100, maxMp: 100, locX: 83000, locY: 148000, locZ: -3400 })).insertId);
    const level = 20, time = Date.now();
    assert(await Life.upsertState({ characterId: id, accountName: account, name: `ClassAdmission${serial}`, level,
        exp: Number(Data.experience[level - 1]) + 1, sp: 120, adena: 0, inventory: {}, phase: 'cold', activity: 'resting',
        loc: { locX: 83000, locY: 148000, locZ: -3400 }, vitals: { hp: 85, maxHp: 100, mp: 70, maxMp: 100 },
        timing: { lastResolvedAt: time - 45000, nextResolveAt: time + 30000 },
        stats: { classId: 0, classProgressionLevel: 0, classProgressionClassId: 0, restUntil: time + 30000 } }, 'class_admission_seed'));
    const initial = facts(id), character = initial.characters.find(row => row.id === id);
    assert.equal(character.level, level);
    assert.equal(character.exp, Number(Data.experience[level - 1]) + 1);
    assert.equal(character.sp, 120);
    assert.equal(character.classId, 0);
    assert.deepEqual(skillRows(initial, id), []);
    assert.deepEqual(initial.items.filter(item => item.characterId === id), []);
    assert.equal(initial.cache.sp, 120);
    assert.equal(initial.cache.adena, 0);
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
    return Database.cooperatively(() => Database.execute(['SELECT 1 AS real_class_queue', [], { onTiming() {
        const end = Date.now() + 2; while (Date.now() < end) { /* Reach the existing cooperative yield. */ }
    } }], label), 1);
}
async function workerBoundary(stage, mode) {
    const id = await seed(), state = Life.snapshot(id), time = Date.now();
    const request = { kind: 'lifecycle', characterId: id, commandId: `class:${serial}`, commandCheckpoint: Protocol.commandCheckpoint(state),
        state, context: {}, precomputedResult: { patch: { activity: 'resting', vitals: { ...state.vitals, hp: 90 }, stats: { restUntil: time + 60000 } },
            events: [], materialize: { exp: 0, sp: 0, adena: 0, items: [] }, nextResolveAt: time + 60000 } };
    const c = new ColdSimulationCoordinator(), sent = [], entered = deferred(), gate = deferred(), called = deferred();
    const stopEntered = deferred(), stopGate = deferred();
    c.ready = true; c.workerEpoch = `class:${serial}`;
    const worker = label => ({ postMessage(message) { sent.push({ label, message: clone(message) });
        if (message.type === 'fence') realImmediate(() => c.onMessage(Protocol.envelope('fence_ack', message.workerEpoch,
            { characterId: id, proposal: null, token: null }, message.msgId), c.worker, c.workerEpoch));
        if (message.type === 'shutdown') realImmediate(() => c.onMessage(Protocol.envelope('drained', message.workerEpoch,
            { ok: true }, message.msgId), c.worker, c.workerEpoch));
    }, terminate: async () => {} });
    c.worker = worker('A'); const originalWorker = c.worker, originalEpoch = c.workerEpoch;
    let admission, control, stop, flushes = 0, flushCompleted = false, targetEntered = false;
    const trainingReceipts = [];
    c.population = { executeWorkerLifecycleCommand(...args) { admission = args[2]?.workerAdmission;
        return Population.executeWorkerLifecycleCommand(...args); } };
    c.contextIndex = () => ({}); c.contextFor = () => ({});
    const updateClass = Database.updateCharacterClassId;
    Database.updateCharacterClassId = function (...args) {
        if (args[0] === id) { targetEntered = true; called.resolve(); }
        return updateClass.apply(this, args);
    };
    const learnSkill = Database.learnBotSkill;
    Database.learnBotSkill = function (...args) {
        return learnSkill.apply(this, args).then(result => {
            if (args[0] === id) trainingReceipts.push({ skillId: args[1], level: args[2], result: clone(result) });
            return result;
        });
    };
    // Earlier native skill reads/payments remain real and finish before the
    // intended FIRST class DAO; the generic first flush used to trap those.
    Database.registerCharacterWriteFlush(async currentId => {
        if (currentId !== id || !targetEntered || ++flushes !== 1) return;
        if (stage === 'flush') { entered.resolve(); await gate.promise; }
        else { control = holdQueue(entered, gate, 'class:worker-control-read'); flushCompleted = true; }
    });
    try {
        await c.onMessage(Protocol.envelope('command_request', originalEpoch, { requests: [request] }, `class-message:${serial}`), originalWorker, originalEpoch);
        await wait(entered.promise, 'actual class ' + stage); await wait(called.promise, 'actual class method invoked');
        if (stage === 'queue') { await turn(); assert(flushCompleted); assert(Database.stats().pending >= 1, 'actual UPDATE pending after completed flush'); }
        assert(c.commandInflight.has(id)); assert.equal(admission.check(), null, 'real original source is admitted before replacement');
        const before = facts(id), oldCharacter = before.characters.find(row => row.id === id);
        assert.equal(oldCharacter.classId, 0); assert.equal(oldCharacter.hp, 85);
        assert.equal(before.bot_life_state.find(row => row.characterId === id).hp, 85);
        assertAuthoredPaidPlan(Progression.plan({ classId: 0, level: 20, seed: id }).classId);
        assert.deepEqual(skillRanks(before, id), ancestorRanks, 'the genuinely paid ancestor prefix is durable');
        assert.equal(oldCharacter.sp, 20, 'only the authored 100 SP has been spent before FIRST class SQL');
        assert.equal(oldCharacter.exp, state.exp);
        assert.equal(before.cache.sp, 120, 'the original cache is unpublished at the held class writer');
        const prefixReceipts = trainingReceipts.filter(receipt => receipt.result.learned);
        assert.equal(prefixReceipts.length, 5);
        assert.equal(prefixReceipts.reduce((total, receipt) => total + receipt.result.spentSp, 0), 100);
        assert.deepEqual(prefixReceipts.flatMap(receipt => receipt.result.consumedBooks), []);
        assert.deepEqual(before.items.filter(item => item.characterId === id), []);
        if (mode === 'replace') { c.worker = worker('B'); c.workerEpoch = 'class:replacement'; }
        if (mode === 'stop') { c.started = true; c.competitionActions.stop = async () => { stopEntered.resolve(); await stopGate.promise; };
            stop = c.stop(); await wait(stopEntered.promise, 'actual stop wait'); assert(c.stopping); }
        if (mode === 'fence') { assert.equal((await c.fenceBot(id, 10)).ok, true); assert(c.fencedBots.has(id)); }
        if (mode === 'changed') {
            const db = new DatabaseSync(options.default.Database.path);
            try { db.prepare('UPDATE bot_life_state SET updatedAt=? WHERE characterId=?').run(Date.now() + 1000, id);
                Life.acceptLifecycleRow(db.prepare('SELECT * FROM bot_life_state WHERE characterId=?').get(id)); } finally { db.close(); }
            assert(!Protocol.sameCommandCheckpoint(request.commandCheckpoint, Life.cachedState(id)));
        }
        const barrier = facts(id); gate.resolve(); await control; await c.commandTail;
        const after = facts(id), character = after.characters.find(row => row.id === id), acks = sent.filter(row => row.message.type === 'command_ack');
        console.log(JSON.stringify({ stage, mode, classBefore: oldCharacter.classId, classAfter: character.classId,
            skillsBefore: before.skills.filter(row => row.characterId === id).length, skillsAfter: after.skills.filter(row => row.characterId === id).length,
            changed: Object.keys(barrier).filter(key => JSON.stringify(barrier[key]) !== JSON.stringify(after[key])),
            receipts: acks.map(row => [row.label, row.message.payload.results[0]?.reason]), flushCompleted }));
        assert.equal(c.commandInflight.size, 0);
        if (mode === 'current') {
            assert.equal(character.classId, Progression.plan({ classId: 0, level: 20, seed: id }).classId);
            assert.notEqual(character.classId, 0); assert.deepEqual(skillRanks(after, id), firstProfessionRanks, 'free 239/1 and 1320/2 add one distinct row');
            assert.equal(character.sp, 20);
            assert.equal(character.exp, state.exp);
            assert.equal(after.cache.sp, 20);
            assert.equal(after.cache.adena, 0);
            const paid = trainingReceipts.filter(receipt => receipt.result.learned);
            assert.equal(paid.length, 7);
            assert.equal(paid.reduce((total, receipt) => total + receipt.result.spentSp, 0), 100);
            assert.deepEqual(paid.flatMap(receipt => receipt.result.consumedBooks), []);
            assert.deepEqual(after.items.filter(item => item.characterId === id), []);
            assert.equal(character.hp, 90); assert.equal(after.bot_life_state.find(row => row.characterId === id).hp, 90);
            assert.equal(acks.length, 1); assert.equal(acks[0].label, 'A'); assert.equal(acks[0].message.payload.results[0].ok, true);
            assert.deepEqual(acks[0].message.payload.results[0].commandCheckpoint, request.commandCheckpoint);
        } else {
            if (mode === 'replace') assert.equal(acks.length, 0);
            else { assert.equal(acks.length, 1); const result = acks[0].message.payload.results[0]; assert.equal(result.ok, false);
                assert.equal(result.reason, mode === 'stop' ? 'coordinator_stopping' : mode === 'fence' ? 'hot_handoff_fenced' : 'stale_command');
                assert.equal(result.retryAfterMs, 1000); assert.deepEqual(result.commandCheckpoint, request.commandCheckpoint); }
            assert.equal(character.classId, 0, 'retired source cannot execute held FIRST class SQL');
            assert.deepEqual(after, barrier, 'all facts at the partial barrier stay conserved');
        }
    } finally {
        gate.resolve(); await control?.catch(() => null); await c.commandTail.catch(() => null);
        global.setImmediate = realImmediate; Database.updateCharacterClassId = updateClass;
        Database.learnBotSkill = learnSkill; Database.registerCharacterWriteFlush(null);
        stopGate.resolve(); if (stop) await stop;
    }
}
async function manualMutation() {
    const id = await seed(); let flushes = 0;
    Database.registerCharacterWriteFlush(async currentId => { assert.equal(currentId, id); flushes++; });
    try {
        const before = Database.stats(), result = await Database.updateCharacterClassId(id, 4), after = Database.stats();
        assert.equal(result.affectedRows, 1); assert.equal(typeof result.insertId, 'number');
        assert.deepEqual(Object.keys(result).sort(), ['affectedRows', 'insertId']); assert.equal(flushes, 1);
        assert.equal(after.operations['character:class'].count, Number(before.operations['character:class']?.count || 0) + 1);
        assert.equal(after.writes, before.writes + 1); assert.equal(after.reads, before.reads);
        assert.equal(facts(id).characters.find(row => row.id === id).classId, 4, 'same class proposal genuinely mutates native SQL');
    } finally { Database.registerCharacterWriteFlush(null); }
}
async function callbackDomain() {
    const id = await seed(); let calls = 0, thenCalls = 0; const unhandled = [], listener = error => unhandled.push(error);
    process.on('unhandledRejection', listener);
    try {
        assert.equal((await Database.updateCharacterClassId(id, 4, { beforeWrite: function () {
            'use strict'; assert.equal(this, undefined, 'opaque admission is never exposed as callback receiver'); calls++;
        } })).affectedRows, 1);
        assert.equal(facts(id).characters.find(row => row.id === id).classId, 4); assert.equal(calls, 1);
        await Database.updateCharacterClassId(id, 0); const before = facts(id);
        const accessor = Object.defineProperty({}, 'beforeWrite', { get() { throw Error('must_not_evaluate_accessor'); } });
        const invalid = [null, [], { beforeWrite: undefined }, { beforeWrite: null }, { beforeWrite: 0 }, accessor,
            Object.create({ beforeWrite() { throw Error('must_not_adopt_inherited'); } }),
            { beforeWrite: () => null }, { beforeWrite: () => 0 }, { beforeWrite: () => ({}) },
            { beforeWrite: async () => undefined }, { beforeWrite: () => Promise.reject(Error('native_rejected_class_guard')) },
            { beforeWrite: () => Promise.reject(new WorkerCommandAdmissionRefusal('stale_command')) },
            { beforeWrite: () => Object.defineProperty({}, 'then', { get() { thenCalls++; throw Error('must_not_read_then'); } }) }];
        for (const bag of invalid) {
            await assert.rejects(Database.updateCharacterClassId(id, 4, bag), error => error instanceof TypeError);
            assert.deepEqual(facts(id), before, 'invalid callback cannot execute the genuinely changing class proposal');
        }
        for (const error of [Object.assign(Error('plain_same_code'), { code: 'BOT_WORKER_COMMAND_ADMISSION_REFUSED' }),
            new WorkerCommandAdmissionRefusal('stale_command')]) {
            await assert.rejects(Database.updateCharacterClassId(id, 4, { beforeWrite() { throw error; } }), found => found === error);
            assert.deepEqual(facts(id), before);
        }
        const reflectionError = Error('original_class_descriptor_failure');
        await assert.rejects(Database.updateCharacterClassId(id, 4, new Proxy({}, { getOwnPropertyDescriptor() { throw reflectionError; } })), error => error === reflectionError);
        assert.deepEqual(facts(id), before); await turn(); assert.deepEqual(unhandled, []); assert.equal(thenCalls, 0);
    } finally { process.removeListener('unhandledRejection', listener); }
}
async function captureBoundary(stage, mode) {
    const id = await seed(), entered = deferred(), gate = deferred(); let calls = 0, active = true, control, job, flushes = 0;
    const bag = mode === 'invalid_replaced' ? { beforeWrite: undefined } : { beforeWrite() {
        calls++; if (!active) throw new WorkerCommandAdmissionRefusal('stale_command');
    } };
    Database.registerCharacterWriteFlush(async currentId => { assert.equal(currentId, id); flushes++;
        if (stage === 'flush') { entered.resolve(); await gate.promise; } });
    try {
        if (stage === 'queue') { control = holdQueue(entered, gate, 'class:direct-control-read'); await wait(entered.promise, 'actual queued read entered'); }
        job = Database.updateCharacterClassId(id, 4, bag); const outcome = job.then(value => ({ value }), error => ({ error }));
        if (stage === 'flush') await wait(entered.promise, 'actual native class flush pending'); else await turn();
        assert.equal(flushes, 1); const before = facts(id); assert.equal(before.characters.find(row => row.id === id).classId, 0);
        if (mode === 'stale') active = false;
        if (mode === 'replaced') bag.beforeWrite = () => { throw Error('must_not_adopt_late_callback'); };
        if (mode === 'invalid_replaced') bag.beforeWrite = () => undefined;
        gate.resolve(); await control; const result = await outcome;
        console.log(JSON.stringify({ directStage: stage, mode, classBefore: 0, classAfter: facts(id).characters.find(row => row.id === id).classId, calls }));
        if (mode === 'replaced') { assert.equal(result.value?.affectedRows, 1); assert.equal(calls, 1); }
        else { assert(result.error instanceof (mode === 'stale' ? WorkerCommandAdmissionRefusal : TypeError)); assert.deepEqual(facts(id), before); }
    } finally { gate.resolve(); await control?.catch(() => null); await job?.catch(() => null);
        Database.registerCharacterWriteFlush(null); global.setImmediate = realImmediate; }
}
async function ordinaryFailures() {
    const id = await seed(), error = Error('native_class_flush_error'); let calls = 0;
    Database.registerCharacterWriteFlush(async () => { throw error; }); const before = facts(id);
    try {
        await assert.rejects(Database.updateCharacterClassId(id, 4, { beforeWrite() { calls++; } }), found => found === error);
        await assert.rejects(Database.updateCharacterClassId(id, 4, { beforeWrite: undefined }), found => found === error);
        assert.equal(calls, 0); assert.deepEqual(facts(id), before);
    } finally { Database.registerCharacterWriteFlush(null); }
    await assert.rejects(Database.updateCharacterClassId(id, { unsupported: true }, { beforeWrite() { calls++; } }), found => !(found instanceof WorkerCommandAdmissionRefusal));
    assert.equal(calls, 1); assert.deepEqual(facts(id), before);
    assert.equal((await Database.updateCharacterClassId(id, 4)).affectedRows, 1, 'queue and flush recover after ordinary rejection');
}
async function check(name, work) { try { await work(); console.log('PASS', name); }
    catch (error) { failures.push(name); console.error('FAIL', name, error.stack); } }
(async () => {
    assert.equal(Config.knowledgeErrorsEnabled, false);
    isolated.assertConfigured(options.default);
    Database.init(); assert(Database.isReady()); Data.init(); await Life.init(); console.log('source', gameRoot);
    // Both real integrated healthy admissions come before any feature RED.
    for (const stage of ['flush', 'queue']) await check(`actual native class ${stage}:current`, () => workerBoundary(stage, 'current'));
    for (const mode of (process.argv.includes('--baseline') ? ['replace'] : ['replace', 'stop', 'fence', 'changed'])) {
        for (const stage of ['flush', 'queue']) await check(`actual native class ${stage}:${mode}`, () => workerBoundary(stage, mode));
    }
    await check('manual native class mutation / original result and metrics', manualMutation);
    await check('strict own callback / native errors / no async admission', callbackDomain);
    for (const stage of ['flush', 'queue']) for (const mode of ['replaced', 'invalid_replaced', 'stale']) {
        await check(`method-time class capture ${stage}:${mode}`, () => captureBoundary(stage, mode));
    }
    await check('ordinary flush / native SQL errors preserve cleanup', ordinaryFailures);
    if (failures.length) throw Error('class admission contracts failed: ' + failures.join(', '));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    await Database.close(); if (directory) fs.rmSync(directory, { recursive: true, force: true });
});
