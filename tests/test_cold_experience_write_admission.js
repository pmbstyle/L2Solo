const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const gameRoot = path.resolve(__dirname, '..');
require(path.join(gameRoot, 'src/Global'));
const Database = invoke('Database');
const Data = invoke('GameServer/DataCache');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Population = invoke('GameServer/Bot/Population/PopulationService');
const Protocol = invoke('GameServer/Bot/Population/ColdSimulationProtocol');
const { ColdSimulationCoordinator } = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const clone = value => JSON.parse(JSON.stringify(value));
const realImmediate = setImmediate;
const turn = () => new Promise(done => realImmediate(done));
function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}
async function wait(promise, label) {
    let timer;
    try {
        return await Promise.race([promise, new Promise((_, reject) => {
            timer = setTimeout(() => reject(Error('timeout: ' + label)), 3000);
        })]);
    } finally { clearTimeout(timer); }
}
let directory, serial = 0;
const failures = [];
function facts(id) {
    const db = new DatabaseSync(options.default.Database.path, { readOnly: true });
    try {
        const result = {};
        for (const table of ['bot_life_state', 'characters', 'skills', 'items', 'warehouse_items', 'afk_trade_shops', 'afk_trade_lines']) {
            result[table] = clone(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
        }
        result.cache = clone(Life.cachedState(id));
        return result;
    } finally { db.close(); }
}
async function seed({ progression = false } = {}) {
    const account = `bot_postrow_xp_${++serial}`;
    await Database.createAccount(account, 'fixture');
    const id = Number((await Database.createCharacter(account, {
        name: `PostRowXP${serial}`, race: 0, classId: 0, sex: 0, face: 0, hair: 0,
        hairColor: 0, maxHp: 100, maxMp: 100, locX: 83000, locY: 148000, locZ: -3400
    })).insertId);
    await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 1000, equipped: false, enchant: 0, slot: 0 });
    const level = progression ? 20 : 7, time = Date.now();
    assert(await Life.upsertState({ characterId: id, accountName: account, name: `PostRowXP${serial}`,
        phase: 'cold', activity: 'resting', level, exp: Number(Data.experience[level - 1]) + 1, sp: 120, adena: 1000,
        inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)),
        loc: { locX: 83000, locY: 148000, locZ: -3400 }, vitals: { hp: 85, maxHp: 100, mp: 70, maxMp: 100 },
        timing: { lastResolvedAt: time - 45000, nextResolveAt: time + 30000 },
        stats: { classId: 0, classProgressionLevel: progression ? 0 : level, classProgressionClassId: 0, restUntil: time + 30000 }
    }, 'postrow_xp_seed'));
    return id;
}
async function run(stage, mode, progression = false) {
    const id = await seed({ progression }), state = Life.snapshot(id), time = Date.now(), expDelta = 13;
    const request = { kind: 'lifecycle', characterId: id, commandId: `postrow-xp:${serial}`,
        commandCheckpoint: Protocol.commandCheckpoint(state), state, context: {},
        precomputedResult: { patch: { activity: 'resting', vitals: { ...state.vitals, hp: 90 }, stats: { restUntil: time + 60000 } },
            events: [], materialize: { exp: expDelta, sp: 0, adena: 0, items: [] }, nextResolveAt: time + 60000 }
    };
    const gate = deferred(), entered = deferred(), writerCalled = deferred(), stopEntered = deferred(), stopGate = deferred();
    const c = new ColdSimulationCoordinator(), sent = [];
    c.ready = true; c.workerEpoch = `postrow-xp:${serial}`;
    const worker = label => ({ postMessage(message) {
        sent.push({ label, message: clone(message) });
        if (message.type === 'fence') realImmediate(() => c.onMessage(Protocol.envelope('fence_ack', message.workerEpoch,
            { characterId: id, proposal: null, token: null }, message.msgId), c.worker, c.workerEpoch));
        if (message.type === 'shutdown') realImmediate(() => c.onMessage(Protocol.envelope('drained', message.workerEpoch,
            { ok: true }, message.msgId), c.worker, c.workerEpoch));
    }, terminate: async () => {} });
    c.worker = worker('A'); const originalWorker = c.worker, originalEpoch = c.workerEpoch;
    let admission, flushCalls = 0, nativeBarrier, stop, experienceEntered = false;
    c.population = { executeWorkerLifecycleCommand(...args) {
        admission = args[2]?.workerAdmission;
        return Population.executeWorkerLifecycleCommand(...args);
    } };
    c.contextIndex = () => ({}); c.contextFor = () => ({});
    const updateExperience = Database.updateCharacterExperience;
    Database.updateCharacterExperience = function (...args) {
        if (args[0] === id) { experienceEntered = true; writerCalled.resolve(); }
        return updateExperience.apply(this, args);
    };
    Database.registerCharacterWriteFlush(async currentId => {
        if (currentId !== id || !experienceEntered || ++flushCalls !== 1) return;
        if (stage === 'flush') { entered.resolve(); await gate.promise; return; }
        let armed = true;
        global.setImmediate = (callback, ...values) => {
            if (armed && new Error().stack.includes('yieldToEventLoop')) {
                armed = false; entered.resolve();
                return realImmediate(async () => { await gate.promise; callback(...values); });
            }
            return realImmediate(callback, ...values);
        };
        nativeBarrier = Database.cooperatively(() => Database.execute([
            'SELECT 1 AS postrow_experience_queue_control', [], { onTiming() {
                const end = Date.now() + 2; while (Date.now() < end) { /* Existing cooperative yield. */ }
            } }
        ], 'postrow:experience-queue-control'), 1);
        // Normal flush completes. The original experience SQL then waits in
        // its real queryTail behind the held completed SELECT/read yield.
    });
    try {
        await c.onMessage(Protocol.envelope('command_request', originalEpoch, { requests: [request] }, `postrow-xp-msg:${serial}`), originalWorker, originalEpoch);
        await wait(entered.promise, 'actual ' + stage + ' boundary');
        await wait(writerCalled.promise, 'original experience writer');
        await turn();
        if (stage === 'queue') assert(Database.stats().pending >= 1, 'experience SQL queued after its completed flush');
        assert(c.commandInflight.has(id));
        assert.equal(admission?.check(), null, 'original cached input checkpoint still current after admitted native ROW');
        const initial = facts(id), character = initial.characters.find(row => row.id === id), life = initial.bot_life_state.find(row => row.characterId === id);
        assert.equal(life.hp, 90, 'own native lifecycle ROW is already durable');
        assert.equal(life.exp, state.exp + expDelta, 'real proposed new XP is already in lifecycle ROW');
        assert.equal(character.hp, 85);
        assert.equal(character.exp, state.exp, 'physical new XP has not been written yet');
        assert.equal(initial.cache.vitals.hp, 85, 'own cached output is not published yet');
        assert(Protocol.sameCommandCheckpoint(request.commandCheckpoint, initial.cache));
        if (progression) {
            assert.notEqual(character.classId, 0, 'real profession prefix has already completed');
            assert(initial.skills.some(row => row.characterId === id), 'real skill prefix is already durable');
            assert.equal(initial.cache.stats.classId, 0, 'original cache input survives own native profession prefix');
        }
        if (mode === 'replace') {
            c.worker = worker('B'); c.workerEpoch = 'postrow-xp:replaced';
            assert.deepEqual(admission.check(), { reason: 'stale_worker_source' });
        }
        if (mode === 'stop') {
            c.started = true; c.competitionActions.stop = async () => { stopEntered.resolve(); await stopGate.promise; };
            stop = c.stop(); await wait(stopEntered.promise, 'actual stop wait'); assert(c.stopping);
        }
        if (mode === 'fence') { assert.equal((await c.fenceBot(id, 10)).ok, true); assert(c.fencedBots.has(id)); }
        if (mode === 'changed') {
            const db = new DatabaseSync(options.default.Database.path);
            try {
                db.prepare('UPDATE bot_life_state SET updatedAt=? WHERE characterId=?').run(Date.now() + 1000, id);
                Life.acceptLifecycleRow(db.prepare('SELECT * FROM bot_life_state WHERE characterId=?').get(id));
            } finally { db.close(); }
            assert(!Protocol.sameCommandCheckpoint(request.commandCheckpoint, Life.cachedState(id)));
        }
        const before = facts(id);
        gate.resolve(); await nativeBarrier; await c.commandTail;
        const after = facts(id), receipts = sent.filter(row => row.message.type === 'command_ack');
        const changed = Object.keys(before).filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
        console.log(JSON.stringify({ stage, mode, progression, flushCalls,
            beforeClass: character.classId, beforeSkills: initial.skills.filter(row => row.characterId === id).length,
            beforeLifeExp: life.exp, afterLifeExp: after.bot_life_state.find(row => row.characterId === id).exp,
            beforeCharacterExp: character.exp, afterCharacterExp: after.characters.find(row => row.id === id).exp,
            beforeLifeHp: life.hp, afterLifeHp: after.bot_life_state.find(row => row.characterId === id).hp,
            beforePhysicalHp: character.hp, afterPhysicalHp: after.characters.find(row => row.id === id).hp,
            originalCacheHp: initial.cache.vitals.hp, beforeCacheHp: before.cache.vitals.hp, afterCacheHp: after.cache.vitals.hp,
            originalCheckpointCurrentBeforeReplacement: true, receipts: receipts.map(row => row.label), changed }));
        assert.equal(c.commandInflight.size, 0);
        if (mode === 'current') {
            assert.equal(after.characters.find(row => row.id === id).exp, state.exp + expDelta);
            assert.equal(after.characters.find(row => row.id === id).hp, 90);
            assert.equal(receipts.length, 1); assert.equal(receipts[0].label, 'A');
            assert.equal(receipts[0].message.payload.results[0].ok, true);
            assert.deepEqual(receipts[0].message.payload.results[0].commandCheckpoint, request.commandCheckpoint);
        } else {
            assert.deepEqual(after, before, 'refusal conserves the held next-writer partial before-image');
            if (mode === 'replace') assert.equal(receipts.length, 0, 'existing source guard suppresses old reply');
            else {
                assert.equal(receipts.length, 1);
                const result = receipts[0].message.payload.results[0];
                assert.equal(result.ok, false); assert.equal(result.retryAfterMs, 1000);
                assert.equal(result.reason, mode === 'stop' ? 'coordinator_stopping' : mode === 'fence' ? 'hot_handoff_fenced' : 'stale_command');
                assert.deepEqual(result.commandCheckpoint, request.commandCheckpoint);
            }
        }
    } finally {
        gate.resolve(); await nativeBarrier?.catch(() => null); await c.commandTail.catch(() => null);
        global.setImmediate = realImmediate; Database.updateCharacterExperience = updateExperience;
        Database.registerCharacterWriteFlush(null); stopGate.resolve(); if (stop) await stop;
    }
}
async function direct(mode) {
    const id = await seed(), old = facts(id).characters.find(row => row.id === id);
    const target = old.exp + 17;
    if (mode === 'manual') {
        const result = await Database.updateCharacterExperience(id, old.level, target, old.sp);
        assert.equal(result.affectedRows, 1); assert.equal(typeof result.insertId, 'number');
        assert.equal(facts(id).characters.find(row => row.id === id).exp, target);
        return;
    }
    if (mode === 'void') {
        let calls = 0;
        const result = await Database.updateCharacterExperience(id, old.level, target, old.sp, { beforeWrite() { calls++; } });
        assert.equal(calls, 1); assert.equal(result.affectedRows, 1);
        assert.equal(facts(id).characters.find(row => row.id === id).exp, target);
        return;
    }
    if (mode === 'error') {
        const ordinary = Error('original_experience_guard_error'), before = facts(id);
        await assert.rejects(Database.updateCharacterExperience(id, old.level, target, old.sp,
            { beforeWrite() { throw ordinary; } }), error => error === ordinary);
        assert.deepEqual(facts(id), before);
        assert.equal((await Database.updateCharacterExperience(id, old.level, target, old.sp)).affectedRows, 1);
        return;
    }
    const entered = deferred(), gate = deferred(); let job, control, calls = 0, lateCalls = 0;
    const bag = { beforeWrite() { calls++; } };
    try {
        if (mode === 'capture_flush') Database.registerCharacterWriteFlush(async currentId => {
            if (currentId === id) { entered.resolve(); await gate.promise; }
        });
        else {
            let armed = true;
            global.setImmediate = (callback, ...values) => {
                if (armed && new Error().stack.includes('yieldToEventLoop')) {
                    armed = false; entered.resolve(); return realImmediate(async () => { await gate.promise; callback(...values); });
                }
                return realImmediate(callback, ...values);
            };
            control = Database.cooperatively(() => Database.execute(['SELECT 1 AS normal_experience_capture_queue', [], { onTiming() {
                const end = Date.now() + 2; while (Date.now() < end) { /* Existing cooperative yield. */ }
            } }], 'postrow:experience-capture-read'), 1);
            await wait(entered.promise, 'actual direct queue');
        }
        job = Database.updateCharacterExperience(id, old.level, target, old.sp, bag);
        if (mode === 'capture_flush') await wait(entered.promise, 'actual direct flush');
        else { await turn(); assert(Database.stats().pending >= 1); }
        assert.equal(facts(id).characters.find(row => row.id === id).exp, old.exp);
        bag.beforeWrite = () => { lateCalls++; throw Error('must_not_adopt_late_experience_guard'); };
        gate.resolve(); await control; assert.equal((await job).affectedRows, 1);
        assert.equal(calls, 1); assert.equal(lateCalls, 0);
        assert.equal(facts(id).characters.find(row => row.id === id).exp, target);
    } finally {
        gate.resolve(); await control?.catch(() => null); await job?.catch(() => null);
        Database.registerCharacterWriteFlush(null); global.setImmediate = realImmediate;
    }
}
async function check(name, work) {
    try { await work(); console.log('PASS', name); }
    catch (error) { failures.push(name); console.error('FAIL', name, error.stack); }
}
(async () => {
    directory = fs.mkdtempSync(path.join(process.cwd(), 'tmp', 'postrow-experience-native-'));
    options.default.Database.path = path.join(directory, 'world.sqlite'); options.default.Database.historyPath = path.join(directory, 'history.sqlite');
    Database.init(); assert(Database.isReady()); Data.init(); await Life.init();
    console.log('source', gameRoot);
    if (process.argv.includes('--progression-control')) {
        await check('healthy real profession and skill prefix before normal experience', () => run('queue', 'current', true));
        if (failures.length) throw Error('progressed normal experience control failed');
        return;
    }
    // Genuine manual and both integrated healthy mutations precede refusals.
    await check('manual genuine normal experience mutation', () => direct('manual'));
    for (const stage of ['flush', 'queue']) await check('current postrow experience ' + stage, () => run(stage, 'current'));
    for (const stage of ['flush', 'queue']) for (const mode of ['replace', 'stop', 'fence', 'changed']) {
        await check('postrow experience ' + stage + ':' + mode, () => run(stage, mode));
    }
    for (const mode of ['void', 'error', 'capture_flush', 'capture_queue']) await check('normal experience API ' + mode, () => direct(mode));
    await check('healthy real profession and skill prefix before normal experience', () => run('queue', 'current', true));
    if (failures.length) throw Error('first normal experience writer contracts failed: ' + failures.join(', '));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    await Database.close(); if (directory) fs.rmSync(directory, { recursive: true, force: true });
});
