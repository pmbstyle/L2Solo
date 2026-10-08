'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const gameRoot = process.env.N53_GAME_ROOT || path.resolve(__dirname, '..');
require(path.join(gameRoot, 'tests/helpers/databaseIsolation'));
const isolated = require(path.join(gameRoot, 'tests/helpers/isolatedSocialDatabase'))('command-ordinary-apply-admission-profile', gameRoot);
// This admission-only scenario explicitly requires the native knowledge-OFF mode.
fs.writeFileSync(isolated.ini, fs.readFileSync(isolated.ini, 'utf8')
    .replace(/^knowledgeErrorsEnabled\s*=\s*true$/m, 'knowledgeErrorsEnabled = false'));
const { DatabaseSync } = require('node:sqlite');
require(path.join(gameRoot, 'src/Global'));
isolated.assertConfigured(options.default);
const Database = invoke('Database');
const Data = invoke('GameServer/DataCache');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Population = invoke('GameServer/Bot/Population/PopulationService');
const Protocol = invoke('GameServer/Bot/Population/ColdSimulationProtocol');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const { ColdSimulationCoordinator } = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const { WorkerCommandAdmissionRefusal } = require(path.join(gameRoot, 'src/GameServer/Bot/Population/WorkerCommandAdmission'));
const realImmediate = setImmediate;
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const epoch = 'ordinary-apply-native-baseline';
let directory = isolated.directory, producer, producerError, joined = false, drained = false;
const messages = [], observations = [], failures = [];
const evidence = process.env.N53_EVIDENCE_DIR || null;
async function wait(promise, label) {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error(`timeout: ${label}`)), 15000);
    })]); } finally { clearTimeout(timer); }
}
async function reply(predicate, label) {
    const until = Date.now() + 15000;
    while (!messages.some(predicate)) {
        if (producerError) throw producerError;
        const fault = messages.find(message => message.type === 'fault');
        if (fault) throw Error(`actual Worker fault: ${JSON.stringify(fault.payload)}`);
        if (Date.now() >= until) throw Error(`timeout: ${label}: ${JSON.stringify(messages.map(m => [m.type, m.msgId]))}`);
        await new Promise(done => setTimeout(done, 10));
    }
    return messages.find(predicate);
}
function send(type, payload, msgId) {
    const message = Protocol.envelope(type, epoch, payload, msgId);
    assert.equal(Protocol.validateEnvelope(message, 'main', { workerEpoch: epoch }).ok, true);
    producer.postMessage(message);
}
function facts(id) {
    const db = new DatabaseSync(options.default.Database.path, { readOnly: true });
    try {
        const out = {};
        for (const table of ['bot_life_state', 'characters', 'skills', 'items', 'warehouse_items',
            'afk_trade_shops', 'afk_trade_lines', 'character_death_experience']) {
            out[table] = clone(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
        }
        out.cache = clone(Life.cachedState(id));
        return out;
    } finally { db.close(); }
}
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

async function seed(activity, number) {
    const account = `bot_ordinary_${number}`;
    await Database.createAccount(account, 'fixture');
    const id = Number((await Database.createCharacter(account, { name: `Ordinary${number}`, race: 0,
        classId: 0, sex: 0, face: 0, hair: 0, hairColor: 0, maxHp: 100, maxMp: 100,
        locX: 83000, locY: 148000, locZ: -3400 })).insertId);
    await Database.setItem(id, { selfId: 1887, name: 'Iron', amount: 2, equipped: false, enchant: 0, slot: 0 });
    const level = 7, exp = Number(Data.experience[level - 1]) + 1, time = Date.now();
    await Database.updateCharacterExperience(id, level, exp, 120);
    await Database.updateCharacterVitals(id, 85, 100, 70, 100);
    assert(await Life.upsertState({ characterId: id, accountName: account, name: `Ordinary${number}`,
        phase: 'cold', activity, level, exp, sp: 120, adena: 0, currentRegion: 'Giran', homeRegion: 'Giran',
        inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)),
        loc: { locX: 83000, locY: 148000, locZ: -3400 }, vitals: { hp: 85, maxHp: 100, mp: 70, maxMp: 100 },
        timing: { activityStartedAt: time - 45000, lastResolvedAt: time - 45000, nextResolveAt: time - 1000 },
        stats: { classId: 0, classProgressionLevel: level, classProgressionClassId: 0 }
    }, 'ordinary_apply_seed'));
    await prepareNativeProfile(id);
    return { id, activity, state: Life.snapshot(id) };
}
async function queued(entry, requestMessage, retire) {
    const { id, activity } = entry;
    const request = requestMessage.payload.requests.find(row => row.characterId === id);
    assert(request && request.kind === 'lifecycle' && request.precomputedPlan);
    assert.equal(request.state.activity, activity);
    assert.equal(request.precomputedResult.debug.activity, activity);
    assert.deepEqual(request.precomputedResult.materialize, { exp: 0, sp: 0, adena: 0, items: [] });
    assert(Protocol.sameCommandCheckpoint(request.commandCheckpoint, Life.cachedState(id)));
    const c = new ColdSimulationCoordinator(), receipts = [];
    c.ready = true; c.worker = producer; c.workerEpoch = epoch;
    const gate = deferred(), entered = deferred(), rowQueued = deferred();
    const originalPopulation = Population.executeWorkerLifecycleCommand;
    const originalApply = Life.applyResolve, originalPrepare = Life.prepareResolve, originalSave = Database.saveBotLifeState;
    let admission, operation, nativeBarrier, savePromise, statement, dbBag, applyBag, prepareBag;
    let applyCalls = 0, prepareCalls = 0;
    const post = c.post.bind(c);
    c.post = (...args) => { if (args[0] === 'command_ack') receipts.push(clone(args)); return post(...args); };
    c.population = { executeWorkerLifecycleCommand(...args) {
        admission = args[2]?.workerAdmission; operation = c.commandInflight.get(id);
        assert(operation instanceof Promise); assert.equal(admission?.check(), null);
        return originalPopulation.apply(Population, args);
    } };
    Life.applyResolve = function (...args) {
        if (Number(args[0]?.characterId) === id) { applyCalls++; applyBag = args[2]; }
        return originalApply.apply(this, args);
    };
    Life.prepareResolve = function (...args) {
        if (Number(args[0]?.characterId) === id) {
            prepareCalls++; prepareBag = args[2];
            assert.equal(admission?.check(), null, 'the authored original source is current at inner entry');
            let armed = true;
            global.setImmediate = (callback, ...values) => {
                if (armed && new Error().stack.includes('yieldToEventLoop')) {
                    armed = false; entered.resolve();
                    return realImmediate(async () => { await gate.promise; callback(...values); });
                }
                return realImmediate(callback, ...values);
            };
            nativeBarrier = Database.cooperatively(() => Database.execute(['SELECT 1 AS ordinary_queue_control', [], {
                onTiming() { const end = Date.now() + 2; while (Date.now() < end) { /* Existing cooperative yield. */ } }
            }], 'ordinary-apply:control-read'), 1);
        }
        return originalPrepare.apply(this, args);
    };
    Database.saveBotLifeState = function (...args) {
        if (Number(args[0]?.[1]?.[0]) === id && !statement) {
            statement = clone(args[0]); dbBag = args[1];
            savePromise = originalSave.apply(this, args);
            rowQueued.resolve(); return savePromise;
        }
        return originalSave.apply(this, args);
    };
    const observation = { activity, retire, request: clone(request), initial: facts(id) };
    try {
        await c.onMessage(requestMessage, producer, epoch);
        await wait(entered.promise, 'original queryTail yield'); await wait(rowQueued.promise, 'original first lifecycle ROW queued');
        assert.equal(applyCalls, 1); assert.equal(prepareCalls, 1); assert.equal(c.commandInflight.get(id), operation);
        assert.equal(admission.check(), null); assert(Protocol.sameCommandCheckpoint(request.commandCheckpoint, Life.cachedState(id)));
        const before = facts(id);
        assert.deepEqual(before, observation.initial, 'no native/cache mutation has happened before the held first ROW');
        assert.equal(before.characters.find(row => row.id === id).hp, 85);
        assert.equal(before.bot_life_state.find(row => row.characterId === id).hp, 85);
        observation.statement = statement;
        observation.originalAdmission = { characterId: admission.characterId, commandId: admission.commandId,
            checkpoint: admission.commandCheckpoint, current: admission.check(), ownedPromise: c.commandInflight.get(id) === operation };
        observation.forwarding = { applyHasAdmission: Object.hasOwn(applyBag || {}, 'workerAdmission'),
            prepareHasAdmission: Object.hasOwn(prepareBag || {}, 'workerAdmission'), nativeBeforeWrite: typeof dbBag?.beforeWrite };
        assert.equal(applyBag?.workerAdmission, admission, 'general apply forwards the exact authored capability');
        assert.equal(prepareBag?.workerAdmission, admission, 'shared prepare retains the exact authored capability');
        assert.equal(typeof dbBag?.beforeWrite, 'function');
        if (retire) {
            c.worker = { postMessage() { throw Error('must_not_deliver_old_receipt_to_replacement'); } };
            c.workerEpoch = `${epoch}:replacement:${id}`;
            assert.equal(admission.check()?.reason, 'stale_worker_source');
        }
        observation.before = facts(id);
        assert.deepEqual(observation.before, before, 'retiring only the source does not mutate native/cache input');
        gate.resolve(); await wait(nativeBarrier, 'queue hold joined');
        let rowResult;
        try {
            rowResult = await wait(savePromise, 'original queued lifecycle ROW result');
            observation.nativeRowResult = clone(rowResult);
        } catch (error) {
            if (!retire) throw error;
            assert(error instanceof WorkerCommandAdmissionRefusal, 'only actual typed admission refusal is expected');
            assert.equal(error.code, 'BOT_WORKER_COMMAND_ADMISSION_REFUSED');
            assert.equal(error.message, 'stale_worker_source');
            observation.nativeRowError = { name: error.name, code: error.code, message: error.message };
        }
        await wait(c.commandTail, 'actual entire Main command joined');
        observation.after = facts(id); observation.receipts = receipts;
        observation.changed = Object.keys(observation.before).filter(key => JSON.stringify(observation.before[key]) !== JSON.stringify(observation.after[key]));
        assert.equal(c.commandInflight.size, 0);
        console.log('OBSERVATION', JSON.stringify(observation));
        if (!retire) {
            assert.equal(rowResult.affectedRows, 1);
            assert.notDeepEqual(observation.after.bot_life_state, observation.before.bot_life_state,
                'the untouched real shopping/merchant result produces a changing native lifecycle ROW');
            assert.notDeepEqual(observation.after.cache, observation.before.cache);
            assert.equal(receipts.length, 1); assert.equal(receipts[0][1].results[0].ok, true);
            assert.deepEqual(receipts[0][1].results[0].commandCheckpoint, request.commandCheckpoint);
        } else {
            assert(observation.nativeRowError, 'the original queued first ROW really refuses');
            assert.deepEqual(observation.after, observation.before, 'retired-source original queued apply must preserve native/cache facts');
            assert.equal(receipts.length, 0, 'the existing final receipt fence remains independent');
        }
    } finally {
        gate.resolve(); await nativeBarrier?.catch(() => null); await c.commandTail.catch(() => null);
        global.setImmediate = realImmediate; Life.applyResolve = originalApply; Life.prepareResolve = originalPrepare;
        Database.saveBotLifeState = originalSave;
        observations.push(observation);
    }
}
(async () => {
    assert.equal(Config.knowledgeErrorsEnabled, false);
    Database.init(); assert(Database.isReady()); Data.init(); await Life.init();
    const entries = [];
    for (const [index, activity] of ['shopping', 'merchant', 'shopping', 'merchant'].entries()) entries.push(await seed(activity, index + 1));
    producer = new Worker(path.join(gameRoot, 'src/GameServer/Bot/Population/ColdSimulationWorker.js'), {
        workerData: { workerEpoch: epoch }, resourceLimits: { maxOldGenerationSizeMb: 256 }
    });
    const exited = new Promise(done => producer.once('exit', code => { joined = true; done(code); }));
    producer.on('error', error => { producerError = error; }); producer.on('message', message => messages.push(message));
    const loaded = await reply(m => m.type === 'ready' && m.payload.phase === 'loaded', 'actual Worker loaded');
    assert.equal(loaded.payload.forbiddenDependencies, 0);
    send('init', { config: { loopIntervalMs: 20, heartbeatMs: 250, maxInFlight: 4, maxBatch: 4 } }, 'ordinary-init');
    await reply(m => m.type === 'ready' && m.msgId === 'ordinary-init', 'actual Worker init');
    const projection = new ColdSimulationCoordinator(), index = projection.contextIndex({ compactPartyMembers: true });
    send('snapshot_page', { rows: entries.map(entry => projection.snapshotEntry(entry.state, index)), initial: true, done: true }, 'ordinary-states');
    await reply(m => m.type === 'ready' && m.msgId === 'ordinary-states', 'actual projected states accepted');
    for (const [number, entry] of entries.entries()) {
        const message = await reply(m => m.type === 'command_request'
            && m.payload.requests.some(request => request.characterId === entry.id), `untouched Worker ${entry.activity} command`);
        try { await queued(entry, message, number >= 2); console.log(`PASS ${entry.activity}/${number >= 2 ? 'retired' : 'current'}`); }
        catch (error) {
            failures.push({ activity: entry.activity, retire: number >= 2, error: error.stack });
            console.error(`FAIL ${entry.activity}/${number >= 2 ? 'retired' : 'current'}: ${error.stack}`);
            if (number < 2) throw Error('healthy ordinary command applicability failed; no dependent stale claim');
        }
    }
    send('shutdown', {}, 'ordinary-shutdown');
    await reply(m => m.type === 'drained' && m.msgId === 'ordinary-shutdown', 'actual Worker drained'); drained = true;
    assert.equal(await wait(exited, 'actual Worker exit'), 0);
    if (failures.length) throw Error(`ordinary apply contracts failed: ${failures.map(x => x.activity + '/retired').join(', ')}`);
})().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(async () => {
    if (producer && !joined) {
        try { send('shutdown', {}, 'ordinary-cleanup'); await reply(m => m.type === 'drained', 'cleanup drain'); drained = true; }
        catch (error) { console.error('cleanup drain', error.stack); }
        await producer.terminate(); joined = true;
    }
    await Database.close();
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
    const cleanup = { drained, joined, databaseClosed: !Database.isReady(), directoryRemoved: !!directory && !fs.existsSync(directory),
        generatedWorld: directory && path.join(directory, 'world.sqlite'), generatedHistory: directory && path.join(directory, 'history.sqlite') };
    console.log('CLEANUP', JSON.stringify(cleanup));
    if (evidence) fs.writeFileSync(path.join(evidence, 'actual-observations.json'), JSON.stringify({ gameRoot, observations, failures, cleanup }, null, 2));
});
