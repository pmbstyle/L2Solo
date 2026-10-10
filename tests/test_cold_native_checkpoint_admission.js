process.env.BOT_DEVELOPER_DIAGNOSTICS = 'true'; // This fixture inspects optional developer metrics.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const gameRoot = process.env.N53_GAME_ROOT || path.resolve(__dirname, '..');
require(path.join(gameRoot, 'tests/helpers/databaseIsolation'));
const isolated = require(path.join(gameRoot, 'tests/helpers/isolatedSocialDatabase'))('native-checkpoint-paid-profile', gameRoot);
// Admission-only authoring explicitly uses native Knowledge OFF, before Global.
fs.writeFileSync(isolated.ini, fs.readFileSync(isolated.ini, 'utf8')
    .replace(/^knowledgeErrorsEnabled\s*=\s*true$/m, 'knowledgeErrorsEnabled = false'));
const { DatabaseSync } = require('node:sqlite');
assert(!fs.existsSync(path.join(process.cwd(), 'config/local.ini')), 'no local override');
require(path.join(gameRoot, 'src/Global'));
isolated.assertConfigured(options.default);
const Database = invoke('Database');
const Data = invoke('GameServer/DataCache');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Population = invoke('GameServer/Bot/Population/PopulationService');
const Progression = invoke('GameServer/Bot/BotClassProgression');
const Protocol = invoke('GameServer/Bot/Population/ColdSimulationProtocol');
const Checkpoint = invoke('GameServer/Bot/Population/NativeWriteCheckpoint');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const { WorkerCommandAdmissionRefusal } = invoke('GameServer/Bot/Population/WorkerCommandAdmission');
const { ColdSimulationCoordinator } = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const realImmediate = setImmediate;
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tables = ['bot_life_state', 'characters', 'skills', 'items', 'warehouse_items',
    'afk_trade_shops', 'afk_trade_lines', 'character_death_experience'];
const targets = ['skill_insert', 'skill_update', 'class', 'row', 'experience', 'death', 'vitals', 'inventory', 'final'];
const failures = [], outcomes = [], healthy = new Set();
let directory = isolated.directory, serial = 0, rowTemplate;

async function wait(promise, label) {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('timeout: ' + label)), 5000);
    })]); } finally { clearTimeout(timer); }
}
function facts(id) {
    const db = new DatabaseSync(options.default.Database.path, { readOnly: true });
    try {
        const image = Object.fromEntries(tables.map(table => [table, clone(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())]));
        image.cache = clone(Life.cachedState(id));
        return image;
    } finally { db.close(); }
}
const physical = (image, id) => image.characters.find(row => row.id === id);
const row = (image, id) => image.bot_life_state.find(value => value.characterId === id);
const stem = (image, id) => image.items.find(value => value.characterId === id && value.selfId === 1869);
const rank = (image, id) => image.skills.find(value => value.characterId === id && value.selfId === 3)?.level;
const point = value => ({ characterId: value.characterId, phase: value.phase, activity: value.activity,
    simulationOwner: value.simulationOwner, simulationRevision: Number(value.simulationRevision || 0),
    simulationLeaseId: value.simulationLeaseId || null, activityStartedAt: Number(value.activityStartedAt || 0),
    nextResolveAt: Number(value.nextResolveAt || 0), lastResolvedAt: Number(value.lastResolvedAt || 0),
    lastHotAt: Number(value.lastHotAt || 0), updatedAt: Number(value.updatedAt || 0) });


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

const preparedProfiles = new Map();
async function prepareNativeProfile(id) {
    const input = Life.snapshot(id), before = facts(id);
    assert.equal(physical(before, id).level, 7);
    assert.equal(physical(before, id).exp, input.exp);
    assert.equal(physical(before, id).sp, 120);
    assert.equal(input.sp, 120);
    assert.deepEqual(skillRows(before, id), []);
    assertAuthoredPaidPlan();
    const beforeWrite = Database.createColdTrainingGuard(input, () => {
        assert.equal(Life.cachedState(id), input);
    });
    const training = await Progression.reconcile({ characterId: id, classId: 0, level: 7, seed: id }, { beforeWrite });
    assert.equal(training.spentSp, 100);
    assert.equal(training.learnedCount, 5);
    assert.deepEqual(training.consumedBooks, []);
    assert.deepEqual(training.transitions, []);
    const returned = await Database.publishColdTraining(id, training, { beforeWrite });
    const accepted = Life.acceptNewerLifecycleRow(returned);
    assert.equal(accepted, Life.cachedState(id));
    assert.equal(accepted.level, 7);
    assert.equal(accepted.exp, input.exp);
    assert.equal(accepted.sp, 20);
    assert.equal(accepted.stats.classId, 0);
    assert.equal(invoke('GameServer/Skills/SkillBookCatalog').needsTraining(accepted), false);
    const after = facts(id);
    assert.deepEqual(skillRanks(after, id), ancestorRanks);
    assert.equal(physical(after, id).sp, 20);
    assert.equal(physical(after, id).exp, physical(before, id).exp);
    assert.equal(physical(after, id).classId, 0);
    assert.equal(accepted.adena, input.adena);
    for (const table of ['items', 'warehouse_items', 'afk_trade_shops', 'afk_trade_lines', 'character_death_experience']) {
        assert.deepEqual(after[table], before[table], 'profile preparation conserves all physical inventory/trade/death facts');
    }
    assert(!Protocol.sameCommandCheckpoint(Protocol.commandCheckpoint(input), accepted),
        'the tested command is authored from the native publication-returned checkpoint');
    preparedProfiles.set(id, clone(skillRows(after, id)));
    console.log('NATIVE_PRETRAIN', JSON.stringify({ id, allocatedSp: 120, training, physicalSp: accepted.sp,
        skills: skillRows(after, id), checkpointBefore: Protocol.commandCheckpoint(input),
        checkpointAfter: Protocol.commandCheckpoint(accepted) }));
}

async function seed(target) {
    const account = `bot_native_checkpoint_${++serial}`;
    await Database.createAccount(account, 'fixture');
    const id = Number((await Database.createCharacter(account, { name: `NativePoint${serial}`, race: 0, classId: 0,
        sex: 0, face: 0, hair: 0, hairColor: 0, maxHp: 100, maxMp: 100,
        locX: 83000, locY: 148000, locZ: -3400 })).insertId);
    for (const item of [{ selfId: 57, name: 'Adena', amount: 1000 }, { selfId: 1869, name: 'Stem', amount: 2 }]) {
        await Database.setItem(id, { ...item, equipped: false, enchant: 0, slot: 0 });
    }
    if (target === 'skill_update') {
        await Database.setSkill({ selfId: 3, name: 'Power Strike', passive: false, level: 1 }, id);
    }
    const level = target === 'class' ? 20 : 7, time = Date.now();
    const exp = Number(Data.experience[level - 1]) + Math.floor((Number(Data.experience[level]) - Number(Data.experience[level - 1])) / 2);
    const profileMissing = ['skill_insert', 'skill_update', 'class'].includes(target);
    const save = Database.saveBotLifeState;
    Database.saveBotLifeState = function (...args) {
        if (args[0]?.[1]?.[0] === id) rowTemplate = clone(args[0]);
        return save.apply(this, args);
    };
    try { assert(await Life.upsertState({ characterId: id, accountName: account, name: `NativePoint${serial}`, level, exp, sp: 120,
        adena: 1000, inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)), phase: 'cold', activity: 'resting',
        loc: { locX: 83000, locY: 148000, locZ: -3400 }, vitals: { hp: 85, maxHp: 100, mp: 70, maxMp: 100 },
        timing: { lastResolvedAt: time - 45000, nextResolveAt: time + 30000 },
        stats: { classId: 0, classProgressionLevel: profileMissing ? 0 : level, classProgressionClassId: 0,
            restUntil: time + 30000 } }, 'native_checkpoint_seed'));
    } finally { Database.saveBotLifeState = save; }
    assert.equal(physical(facts(id), id).exp, exp);
    const initial = facts(id);
    assert.equal(physical(initial, id).level, level);
    assert.equal(physical(initial, id).sp, 120);
    assert.equal(physical(initial, id).classId, 0);
    assert.equal(initial.cache.sp, 120);
    assert.equal(initial.cache.adena, 1000);
    assert.deepEqual(skillRanks(initial, id), target === 'skill_update' ? [[3, 1]] : []);
    // Class/learn targets must keep their own first writer inside the command.
    // Only ROW/after-writer scenarios prepare a genuine paid profile outside it.
    if (!profileMissing) await prepareNativeProfile(id);
    return id;
}

function claimRequest(id, image) {
    const current = row(image, id), timestamp = Date.now();
    return { characterId: id, expectedRevision: Number(current.simulationRevision || 0),
        ownerId: 'cold_simulation_owner', leaseId: `native-point:${crypto.randomUUID()}`,
        timestamp, leaseUntil: timestamp + 120000, allowLifecycle: true };
}
async function claim(id) {
    const request = claimRequest(id, facts(id));
    const grant = await Database.claimColdSimulationLease(request);
    assert.equal(grant.ok, true, JSON.stringify(grant));
    assert.equal(grant.revision, request.expectedRevision + 1);
    assert.equal(grant.leaseId, request.leaseId);
    return grant;
}
function queueClaimCycle(id, image) {
    const request = claimRequest(id, image);
    const claimed = Database.claimColdSimulationLease(request);
    // Both original Native jobs are placed ahead of ROW. The release uses
    // the exact authored request tuple; both real receipts are checked below.
    const released = Database.releaseColdSimulationLease({ characterId: id, ownerId: request.ownerId,
        leaseId: request.leaseId, expectedRevision: request.expectedRevision + 1, timestamp: request.timestamp });
    return Promise.all([claimed, released]).then(([grant, release]) => {
        assert.equal(grant.ok, true, JSON.stringify(grant)); assert.equal(release.ok, true, JSON.stringify(release));
        assert.equal(grant.leaseId, request.leaseId); assert.equal(grant.revision, request.expectedRevision + 1);
        assert.equal(release.revision, grant.revision + 1); assert.equal(release.ownerId, 'legacy_main');
        assert.equal(release.leaseId, null);
        return { grant, release };
    });
}
function methodOf(target) {
    return { skill_insert: 'learnBotSkill', skill_update: 'learnBotSkill', class: 'updateCharacterClassId',
        row: 'saveBotLifeState', experience: 'updateCharacterExperience', death: 'applyCharacterDeathExperience',
        vitals: 'updateCharacterVitals', inventory: 'syncInventorySummary', final: 'syncInventorySummary' }[target];
}
function targetId(target, args) {
    return target === 'row' ? args[0]?.[1]?.[0]
        : target === 'death' ? args[0]?.characterId : args[0];
}
function probeValue(target, image, id) {
    if (target === 'skill_insert') return image.skills.filter(value => value.characterId === id).length;
    if (target === 'skill_update') return rank(image, id);
    if (target === 'class') return physical(image, id).classId;
    if (target === 'row') return row(image, id).hp;
    if (target === 'experience' || target === 'death') return physical(image, id).exp;
    if (target === 'vitals') return physical(image, id).hp;
    if (target === 'inventory') return stem(image, id).amount;
    return { hp: image.cache.vitals.hp, items: image.cache.inventory['1869'].amount };
}

async function boundary(target, mode) {
    if (mode === 'native') assert(healthy.has(target), 'matching changing healthy MUST pass before a claimed RED');
    const id = await seed(target), state = Life.snapshot(id), originalCache = Life.cachedState(id), time = Date.now();
    const result = { patch: { activity: 'resting', vitals: { ...state.vitals, hp: 90 }, stats: { restUntil: time + 60000 } },
        events: [], materialize: { exp: 13, sp: 0, adena: 0, items: [{ selfId: 1869, amount: 3 }] }, nextResolveAt: time + 60000 };
    if (target === 'death') {
        result.patch.activity = 'dead'; result.patch.vitals.hp = 0; result.patch.deathCount = 1;
        result.materialize.exp = 0; result.debug = { died: true, fights: 1, wins: 0 };
    }
    const request = { kind: 'lifecycle', characterId: id, commandId: `native-point:${serial}`,
        commandCheckpoint: Protocol.commandCheckpoint(state), state, context: {}, precomputedResult: result };
    const c = new ColdSimulationCoordinator(), sent = [], publications = [], entered = deferred(), gate = deferred(), called = deferred();
    c.ready = true; c.workerEpoch = `native-point:${serial}`;
    c.worker = { postMessage(message) { sent.push(clone(message)); }, terminate: async () => {} };
    const source = c.worker, epoch = c.workerEpoch;
    let admission, control, producer, targetEntered = false, held = false, armed = false, before, partial;
    const method = methodOf(target), original = Database[method], writerCallbacks = [], trainingReceipts = [];
    const optionAt = { learnBotSkill: 3, setSkill: 2, updateSkillLevel: 3, updateCharacterClassId: 2, saveBotLifeState: 1,
        updateCharacterExperience: 4, applyCharacterDeathExperience: 1, updateCharacterVitals: 5,
        syncInventorySummary: 3, publishBotResolvedState: 1 };
    const observers = new Map();
    const observe = (name, args) => {
        const currentId = name === 'setSkill' ? args[1] : name === 'saveBotLifeState' ? args[0]?.[1]?.[0]
            : name === 'applyCharacterDeathExperience' ? args[0]?.characterId : args[0];
        if (currentId !== id) return;
        writerCallbacks.push({ name, callback: args[optionAt[name]]?.beforeWrite });
        if (name === 'saveBotLifeState' && mode === 'current') rowTemplate = clone(args[0]);
    };
    const observeReceipt = (name, args, pending) => {
        if (name !== 'learnBotSkill' || args[0] !== id) return pending;
        return pending.then(result => {
            trainingReceipts.push({ skillId: args[1], level: args[2], result: clone(result) });
            return result;
        });
    };
    for (const name of Object.keys(optionAt)) {
        if (name === method) continue;
        const native = Database[name]; observers.set(name, native);
        Database[name] = function (...args) { observe(name, args); return observeReceipt(name, args, native.apply(this, args)); };
    }
    const queueTarget = ['skill_insert', 'skill_update', 'row'].includes(target);
    c.population = { executeWorkerLifecycleCommand(...args) {
        admission = args[2]?.workerAdmission; return Population.executeWorkerLifecycleCommand(...args);
    } };
    c.contextIndex = () => ({}); c.contextFor = () => ({});
    const unsubscribe = Life.subscribeChanges((snapshot, reason) => {
        if (snapshot.characterId === id && ['resolve', 'death'].includes(reason)) publications.push(clone(snapshot));
    });
    global.setImmediate = (callback, ...values) => {
        if (armed && new Error().stack.includes('yieldToEventLoop')) {
            armed = false; entered.resolve();
            return realImmediate(async () => { await gate.promise; callback(...values); });
        }
        return realImmediate(callback, ...values);
    };
    Database[method] = function (...args) {
        observe(method, args);
        const paidTarget = !['skill_insert', 'skill_update'].includes(target)
            || (args[1] === 3 && args[2] === (target === 'skill_insert' ? 1 : 2));
        if (targetId(target, args) !== id || held || !paidTarget) {
            return observeReceipt(method, args, original.apply(this, args));
        }
        held = true; targetEntered = true; called.resolve();
        if (queueTarget) {
            const receiver = this;
            return Database.cooperatively(() => {
                if (mode === 'native') {
                    producer = target === 'row' ? queueClaimCycle(id, facts(id)) : claim(id);
                    producer.catch(() => {});
                }
                control = Database.execute(['SELECT 1 AS native_point_queued_control', [], { onTiming() {
                    armed = true; const until = Date.now() + 2; while (Date.now() < until) { /* Existing cooperative slice. */ }
                } }], 'native-point:queue-control');
                control.catch(() => {});
                return observeReceipt(method, args, original.apply(receiver, args));
            }, 1);
        }
        if (target === 'final') {
            const receiver = this;
            return Database.cooperatively(() => {
                armed = true;
                const until = Date.now() + 2;
                while (Date.now() < until) { /* Guarantee the original post-SQL cooperative delivery. */ }
                return original.apply(receiver, args);
            }, 1);
        }
        return observeReceipt(method, args, original.apply(this, args));
    };
    Database.registerCharacterWriteFlush(async currentId => {
        if (currentId !== id || !targetEntered || queueTarget || target === 'final') return;
        entered.resolve(); await gate.promise;
    });
    try {
        await c.onMessage(Protocol.envelope('command_request', epoch, { requests: [request] }, `native-point-message:${serial}`), source, epoch);
        await wait(called.promise, 'original ' + target + ' called');
        await wait(entered.promise, 'actual ' + target + ' queue/flush');
        if (producer) await wait(producer, 'real Native producer ahead of queued writer');
        assert(c.commandInflight.has(id)); assert.equal(admission.check(), null);
        assert.equal(c.worker, source); assert.equal(c.workerEpoch, epoch); assert.equal(c.stopping, false);
        assert.equal(Life.cachedState(id), originalCache);
        assert(Protocol.sameCommandCheckpoint(request.commandCheckpoint, Life.cachedState(id)));
        partial = facts(id);
        assert.equal(physical(partial, id).hp, ['inventory', 'final'].includes(target) ? 90 : 85);
        if (queueTarget || target === 'class') assert.equal(row(partial, id).hp, 85);
        else assert.equal(row(partial, id).hp, target === 'death' ? 0 : 90, 'accepted own ROW is already durable');
        if (target === 'class') {
            assertAuthoredPaidPlan(Progression.plan({ classId: 0, level: 20, seed: id }).classId);
            assert.deepEqual(skillRanks(partial, id), ancestorRanks, 'native paid ancestor prefix completed BEFORE FIRST class SQL');
            assert.equal(physical(partial, id).sp, 20);
        }
        if (preparedProfiles.has(id)) {
            assert.deepEqual(skillRows(partial, id), preparedProfiles.get(id), 'no NEW skill write before held ROW/after writer');
            assert.equal(physical(partial, id).sp, 20);
        }
        if (queueTarget && target !== 'row') assert.equal(physical(partial, id).sp, 120,
            'the held first native learner has not debited physical SP');
        if (target === 'skill_insert') assert.equal(probeValue(target, partial, id), 0);
        if (target === 'skill_update') assert.equal(probeValue(target, partial, id), 1);
        if (target === 'death') assert.equal(partial.character_death_experience.find(value => value.characterId === id), undefined);
        if (target === 'final') {
            assert.equal(stem(partial, id).amount, 5, 'original inventory transaction really committed BEFORE control');
            assert.equal(physical(partial, id).exp, state.exp + 13);
            assert.equal(publications.length, 0);
        } else assert.equal(stem(partial, id).amount, 2);
        if (mode === 'native' && !queueTarget) {
            producer = claim(id); producer.catch(() => {});
            if (target === 'final') {
                // The real claim is appended behind the held original commit.
                // Release its cooperative delivery, then verify the native
                // receipt still precedes the original final publication.
                producer = producer.then(grant => {
                    assert.equal(Life.cachedState(id), originalCache, 'Native claim must precede FINAL, otherwise control is inapplicable');
                    assert.equal(publications.length, 0);
                    assert.equal(admission.check(), null, 'original capability is current at EXACT Native receipt before publication');
                    before = facts(id);
                    console.log('CONTROL_NATIVE_FINAL', JSON.stringify({ id, grant, cachedOriginal: true,
                        capabilityAtReceipt: null, publications: 0, nativeCheckpoint: point(row(before, id)) }));
                    return grant;
                });
                producer.catch(() => {});
                gate.resolve(); await wait(producer, 'real Native FINAL transition');
            } else await wait(producer, 'real Native transition during original flush');
        }
        if (!before) before = facts(id);
        if (mode === 'native') {
            if (target !== 'final') assert.equal(admission.check(), null, 'original cache/source capability stays admitted at Native-only transition');
            assert(!Protocol.sameCommandCheckpoint(point(row(before, id)), request.commandCheckpoint), 'Native authority truly differs');
            if (target === 'row') {
                assert.equal(row(before, id).simulationOwner, 'legacy_main'); assert.equal(row(before, id).simulationLeaseId, null);
                assert.equal(row(before, id).simulationRevision, request.commandCheckpoint.simulationRevision + 2);
            } else assert.equal(row(before, id).simulationOwner, 'cold_simulation_owner');
        }
        gate.resolve(); await control; await wait(c.commandTail, 'real command completion');
        const after = facts(id), receipts = sent.filter(message => message.type === 'command_ack');
        const changed = Object.keys(before).filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
        const observation = { target, mode, id, beforeValue: probeValue(target, before, id), afterValue: probeValue(target, after, id),
            nativeBefore: point(row(before, id)), nativeAfter: point(row(after, id)), originalCheckpoint: request.commandCheckpoint,
            changed, publications: publications.length, receipts: receipts.map(message => message.payload.results[0]),
            beforeImage: before, afterImage: after };
        if (process.env.N53_BASELINE_EVIDENCE_DIR) {
            fs.writeFileSync(path.join(process.env.N53_BASELINE_EVIDENCE_DIR, `${mode}-${target}-${serial}.json`), JSON.stringify(observation, null, 2) + '\n');
        }
        console.log('OBSERVATION', JSON.stringify({ ...observation, beforeImage: undefined, afterImage: undefined }));
        assert.equal(c.commandInflight.size, 0);
        if (mode === 'current') {
            assert.notDeepEqual(probeValue(target, after, id), probeValue(target, before, id), 'healthy SAME target genuinely mutates');
            if (target === 'class') assert.equal(physical(after, id).classId, Progression.plan({ classId: 0, level: 20, seed: id }).classId);
            if (target === 'death') assert.equal(after.character_death_experience.find(value => value.characterId === id).pendingRestoration, 1);
            assert.equal(receipts.length, 1); assert.equal(receipts[0].payload.results[0].ok, true);
            assert.deepEqual(receipts[0].payload.results[0].commandCheckpoint, request.commandCheckpoint);
            assert.equal(publications.length, 1); healthy.add(target);
            assert(writerCallbacks.some(value => value.name === 'saveBotLifeState'));
            assert(writerCallbacks.some(value => value.name === 'publishBotResolvedState'));
            assert(writerCallbacks.every(value => typeof value.callback === 'function'));
            const trainingCallbacks = writerCallbacks.filter(value => ['learnBotSkill', 'updateCharacterClassId'].includes(value.name));
            const afterCallbacks = writerCallbacks.filter(value => !['learnBotSkill', 'updateCharacterClassId'].includes(value.name));
            assert.equal(new Set(afterCallbacks.map(value => value.callback)).size, 1,
                'ROW/physical/FINAL retain ONE untagged advancing native callback');
            if (['skill_insert', 'skill_update', 'class'].includes(target)) {
                assert(trainingCallbacks.length > 0, 'the genuine paid prefix was observed');
                assert.equal(new Set(trainingCallbacks.map(value => value.callback)).size, 1,
                    'all paid skill/class writers share their private training callback');
                assert.notEqual(trainingCallbacks[0].callback, afterCallbacks[0].callback,
                    'private immutable training floors cannot leak into ROW/advance');
            } else assert.deepEqual(trainingCallbacks, [], 'prepared ROW/after profile does not silently train inside this boundary');
            const expectedRanks = target === 'class' ? firstProfessionRanks
                : target === 'skill_update' ? [[3, 3], [194, 1], [1320, 1], [1322, 1]] : ancestorRanks;
            assert.deepEqual(skillRanks(after, id), expectedRanks);
            assert.equal(physical(after, id).sp, 20);
            assert.equal(after.cache.sp, 20);
            assert.equal(after.cache.adena, 1000);
            assert.deepEqual(after.items.filter(item => item.characterId === id && item.selfId === 57),
                before.items.filter(item => item.characterId === id && item.selfId === 57), 'paid skills never invent/debit currency');
            if (preparedProfiles.has(id)) assert.deepEqual(skillRows(after, id), preparedProfiles.get(id),
                'ROW/after targets preserve the exact pre-trained physical rows');
            else {
                const learned = trainingReceipts.filter(receipt => receipt.result.learned);
                assert.equal(learned.length, target === 'class' ? 7 : 5);
                assert.equal(learned.reduce((total, receipt) => total + receipt.result.spentSp, 0), 100);
                assert.deepEqual(learned.flatMap(receipt => receipt.result.consumedBooks), []);
            }
            console.log('SHARED_CALLBACK', JSON.stringify({ target, id, writers: writerCallbacks.map(value => value.name), exactFunctions: new Set(writerCallbacks.map(value => value.callback)).size }));
        } else {
            assert.deepEqual(after, before, 'changed Native authority must conserve the exact accepted partial eight-table/cache image');
            assert.equal(publications.length, 0);
            assert.equal(receipts.length, 1); assert.equal(receipts[0].payload.results[0].ok, false);
        }
    } finally {
        gate.resolve(); await control?.catch(() => null); await producer?.catch(() => null);
        await wait(c.commandTail.catch(() => null), 'cleanup command');
        Database[method] = original; for (const [name, native] of observers) Database[name] = native;
        Database.registerCharacterWriteFlush(null); global.setImmediate = realImmediate; unsubscribe();
    }
}

async function manual(ordinaryCallback) {
    const id = await seed('vitals'), before = facts(id); let calls = 0;
    if (ordinaryCallback) {
        const inventory = clone(before.cache.inventory); inventory['1869'].amount = 5;
        const result = await Database.syncInventorySummary(id, inventory, 'native_point_manual', { beforeWrite: function () {
            'use strict'; assert.equal(this, undefined); assert.equal(arguments.length, 0); calls++;
        } });
        assert.equal(result.characterId, id); assert.equal(calls, 1); assert.equal(stem(facts(id), id).amount, 5);
    } else {
        const result = await Database.updateCharacterVitals(id, 90, 100, 75, 100);
        assert.equal(result.affectedRows, 1); assert.equal(physical(facts(id), id).hp, 90);
    }
    assert.notDeepEqual(facts(id), before);
}
async function renewal() {
    const id = await seed('vitals'), grant = await claim(id), before = facts(id), token = {
        characterId: id, ownerId: grant.ownerId, revision: grant.revision, leaseId: grant.leaseId, leaseUntil: grant.leaseUntil };
    const renewed = await Database.renewColdSimulationLeases([token], { now: Date.now, leaseMs: 180000, canRenew: () => true });
    assert.equal(renewed.length, 1); assert.equal(renewed[0].ok, true, JSON.stringify(renewed));
    const after = facts(id);
    assert.deepEqual(point(row(after, id)), point(row(before, id)));
    assert(row(after, id).simulationLeaseUntil > row(before, id).simulationLeaseUntil);
    console.log('RENEWAL_IDENTITY', JSON.stringify({ id, token, beforeUntil: row(before, id).simulationLeaseUntil,
        afterUntil: row(after, id).simulationLeaseUntil, checkpointUnchanged: true, ordinaryLeasedSaveNotAttempted: true }));
}
async function check(name, work) {
    try { await work(); outcomes.push({ name, status: 'PASS' }); console.log('PASS', name); }
    catch (error) { failures.push(name); outcomes.push({ name, status: 'FAIL', error: error.stack }); console.error('FAIL', name, error.stack); }
}

// These are direct internal-API controls, not substitutes for the real
// Coordinator/Population chain above. Their SQL and returned rows are native.
function session(id, checkAuthority = () => null) {
    const input = Object.freeze({ ...Protocol.commandCheckpoint(Life.snapshot(id)) });
    const options = { workerAdmission: Object.freeze({ characterId: id, commandId: `direct:${id}`,
        commandCheckpoint: input, check: checkAuthority }) };
    return { callback: Checkpoint.create(id, options), options, input };
}
function statementFor(id, hp = 94, extraStats = {}) {
    assert(rowTemplate, 'actual Life-authored ROW SQL captured first');
    const native = row(facts(id), id);
    const fields = ['characterId', 'accountName', 'characterName', 'level', 'exp', 'sp', 'adena', 'homeRegion', 'currentRegion',
        'spotId', 'activity', 'phase', 'activityStartedAt', 'nextResolveAt', 'lastResolvedAt', 'lastHotAt',
        'locX', 'locY', 'locZ', 'hp', 'maxHp', 'mp', 'maxMp', 'targetLevelBand', 'deathCount', 'partyId',
        'inventorySummary', 'statsJson', 'updatedAt'];
    const params = fields.map(key => native[key]);
    params[19] = hp; params[14] = Number(native.lastResolvedAt || 0) + 1; params[28] = native.updatedAt + 1;
    params[27] = JSON.stringify({ ...JSON.parse(native.statsJson), ...extraStats });
    return [rowTemplate[0], params];
}
function boundStatement(id, callback, hp = 94, extraStats) {
    const statement = statementFor(id, hp, extraStats);
    Checkpoint.bindRow(callback, statement, id);
    return statement;
}
const refused = error => error instanceof WorkerCommandAdmissionRefusal && error.code === 'BOT_WORKER_COMMAND_ADMISSION_REFUSED';
async function withFlush(id, work) {
    const entered = deferred(), release = deferred();
    Database.registerCharacterWriteFlush(current => {
        if (current !== id) return;
        entered.resolve(); return release.promise;
    });
    try { return await work(entered.promise, release.resolve); }
    finally { release.resolve(); Database.registerCharacterWriteFlush(null); }
}
async function withTail(work) {
    const entered = deferred(), release = deferred(); let armed = false;
    global.setImmediate = (callback, ...args) => {
        if (armed && new Error().stack.includes('yieldToEventLoop')) {
            armed = false; entered.resolve();
            return realImmediate(async () => { await release.promise; callback(...args); });
        }
        return realImmediate(callback, ...args);
    };
    const control = Database.cooperatively(() => Database.execute(['SELECT 1 AS direct_native_tail', [], { onTiming() {
        armed = true; const until = Date.now() + 2; while (Date.now() < until) { /* Original cooperative queue. */ }
    } }], 'native-point:direct-tail'), 1);
    try { await wait(entered.promise, 'direct real SQL tail'); return await work(release.resolve); }
    finally { release.resolve(); await control; global.setImmediate = realImmediate; }
}

const directCases = [
    ['method-time callback capture and borrowed actual target', async () => {
        const id = await seed('vitals'), other = await seed('vitals'), authority = session(id);
        const options = { beforeWrite: authority.callback };
        await withFlush(id, async (entered, release) => {
            const write = Database.updateCharacterVitals(id, 94, 100, 75, 100, options);
            await entered;
            options.beforeWrite = () => { throw Error('replacement callback must not be adopted'); };
            authority.options.workerAdmission = { check: () => { throw Error('replacement capability must not be adopted'); } };
            release(); assert.equal((await write).affectedRows, 1);
        });
        assert.equal(physical(facts(id), id).hp, 94);
        const before = facts(other);
        await assert.rejects(Database.updateCharacterVitals(other, 95, 100, 75, 100, { beforeWrite: authority.callback }), refused);
        const inventory = clone(before.cache.inventory); inventory['1869'].amount = 7;
        await assert.rejects(Database.syncInventorySummary(other, inventory, null, { beforeWrite: authority.callback }), refused);
        assert.deepEqual(facts(other), before, 'borrowing id A authority cannot write id B');
    }],
    ['private per-method expected copy and same-job own ROW advance', async () => {
        const id = await seed('vitals'), { callback } = session(id), before = facts(id);
        await withFlush(id, async (entered, release) => {
            const old = Database.updateCharacterVitals(id, 94, 100, 75, 100, { beforeWrite: callback }); old.catch(() => {});
            await entered;
            const output = await Database.saveBotLifeState(boundStatement(id, callback), { beforeWrite: callback });
            assert.equal(output.affectedRows, 1); assert.equal(row(facts(id), id).hp, 94);
            assert.equal(physical(facts(id), id).hp, 85, 'ROW is a distinct, really changing durable output');
            output.statsJson = JSON.stringify({ foreign: true }); output.updatedAt = 0; output.characterId = id + 1;
            const afterOwn = facts(id);
            release(); await assert.rejects(old, refused);
            assert.deepEqual(facts(id), afterOwn, 'pending old method cannot adopt the later session checkpoint');
        });
        assert.deepEqual(Life.cachedState(id), before.cache, 'private own-output advance never publishes Main cache');
        assert.equal((await Database.updateCharacterVitals(id, 94, 100, 75, 100, { beforeWrite: callback })).affectedRows, 1);
        assert.equal(physical(facts(id), id).hp, 94, 'next method copies the exact successful queued RETURNING');
    }],
    ['ROW exact statement binding and live queued SQL/PK', async () => {
        const id = await seed('vitals'), other = await seed('vitals'), a = session(id), b = session(other);
        let before = facts(id);
        await assert.rejects(Database.saveBotLifeState(statementFor(id), { beforeWrite: a.callback }), refused);
        await assert.rejects(Database.saveBotLifeState(boundStatement(other, b.callback), { beforeWrite: a.callback }), refused);
        assert.deepEqual(facts(id), before);
        for (const mutation of ['target', 'sql']) {
            const statement = boundStatement(id, a.callback);
            before = facts(id);
            await withTail(async release => {
                const pending = Database.saveBotLifeState(statement, { beforeWrite: a.callback }); pending.catch(() => {});
                if (mutation === 'target') statement[1][0] = other;
                else statement[0] = statement[0].replace('characterName = excluded.characterName', 'characterName = excluded.accountName');
                release(); await assert.rejects(pending, refused);
            });
            assert.deepEqual(facts(id), before, 'actual queued statement mutation cannot borrow the earlier proof');
        }
        assert.equal((await Database.saveBotLifeState(boundStatement(id, a.callback), { beforeWrite: a.callback })).affectedRows, 1);
        assert.equal(row(facts(id), id).hp, 94, 'same genuine proposed mutation is accepted with its exact authored binding');
    }],
    ['affected0 and protected market stats never fake own-output advance', async () => {
        const id = await seed('vitals'), { callback } = session(id), original = facts(id);
        const stats = { ...JSON.parse(row(original, id).statsJson), clanInventoryRevision: 5,
            marketTrades: { material: { D: 7 } } };
        await Database.execute(['UPDATE bot_life_state SET statsJson = ? WHERE characterId = ?', [JSON.stringify(stats), id]]);
        await Database.execute(['INSERT INTO bot_market_counts(characterId,counter,deals) VALUES(?,?,7)', [id, 'gear d']]);
        const statement = boundStatement(id, callback, 94, { clanInventoryRevision: 4, marketTrades: { malicious: 999 } });
        const before = facts(id), rejected = await Database.saveBotLifeState(statement, { beforeWrite: callback });
        assert.equal(rejected.affectedRows, 0); assert.deepEqual(facts(id), before);
        await Database.updateCharacterVitals(id, 94, 100, 75, 100, { beforeWrite: callback });
        assert.equal(physical(facts(id), id).hp, 94, 'affected0 did not adopt proposed updatedAt/timing');
        const accepted = await Database.saveBotLifeState(boundStatement(id, callback, 95, { clanInventoryRevision: 5,
            marketTrades: { malicious: 999 }, priceBeliefs: { legacy: 1 } }), { beforeWrite: callback });
        assert.equal(accepted.affectedRows, 1);
        assert.equal(JSON.parse(accepted.statsJson).marketTrades, undefined);
        assert.equal((await Database.execute(['SELECT deals FROM bot_market_counts WHERE characterId=? AND counter=?', [id, 'gear d']]))[0].deals, 7);
        assert.equal(JSON.parse(accepted.statsJson).priceBeliefs, undefined);
        await Database.updateCharacterVitals(id, 95, 100, 75, 100, { beforeWrite: callback });
        assert.equal(physical(facts(id), id).hp, 95);
    }],
    ['method call cannot adopt a foreign Native row or planned option', async () => {
        const id = await seed('vitals'), { callback } = session(id);
        const cycle = await queueClaimCycle(id, facts(id)); assert(cycle.release.ok);
        const before = facts(id), foreign = clone(row(before, id));
        assert.equal(Life.snapshot(id).simulation.revision, foreign.simulationRevision - 2);
        await assert.rejects(Database.updateCharacterVitals(id, 94, 100, 75, 100,
            { beforeWrite: callback, expected: foreign, plannedState: foreign, nativeRow: foreign }), refused);
        await assert.rejects(Database.saveBotLifeState(boundStatement(id, callback),
            { beforeWrite: callback, expected: foreign }), refused);
        assert.deepEqual(facts(id), before);
    }],
    ['FINAL original queue checks before one synchronous publication', async () => {
        const id = await seed('vitals'), { callback } = session(id); let calls = 0;
        await Database.updateCharacterVitals(id, 94, 100, 75, 100, { beforeWrite: callback });
        const before = facts(id), token = {};
        const published = await Database.publishBotResolvedState(id, { beforeWrite: callback }, () => {
            assert.equal(physical(facts(id), id).hp, 94); calls++; return token;
        });
        assert.equal(published, token); assert.equal(calls, 1); assert.deepEqual(facts(id), before);
        await withTail(async release => {
            const producer = claim(id), pending = Database.publishBotResolvedState(id, { beforeWrite: callback }, () => { calls++; });
            pending.catch(() => {}); release(); await producer;
            const afterGrant = facts(id); await assert.rejects(pending, refused);
            assert.equal(calls, 1); assert.deepEqual(facts(id), afterGrant);
        });
        const op = Database.stats().operations['bot-life:resolve-publication'];
        assert(op && op.count >= 2);
    }],
    ['FINAL queued expected is copied before own ROW advances', async () => {
        const id = await seed('vitals'), { callback } = session(id); let calls = 0;
        await withTail(async release => {
            const own = Database.saveBotLifeState(boundStatement(id, callback), { beforeWrite: callback });
            const publication = Database.publishBotResolvedState(id, { beforeWrite: callback }, () => { calls++; });
            publication.catch(() => {}); release(); assert.equal((await own).affectedRows, 1);
            const before = facts(id); await assert.rejects(publication, refused);
            assert.equal(calls, 0); assert.deepEqual(facts(id), before);
        });
        const value = await Database.publishBotResolvedState(id, { beforeWrite: callback }, () => { calls++; return id; });
        assert.equal(value, id); assert.equal(calls, 1, 'fresh method proof follows successful own queued row');
    }],
    ['ordinary errors and actual branded refusals preserve identity', async () => {
        const id = await seed('vitals'), before = facts(id), ordinary = Object.assign(Error('ordinary callback'),
            { code: 'BOT_WORKER_COMMAND_ADMISSION_REFUSED' });
        await assert.rejects(Database.updateCharacterVitals(id, 94, 100, 75, 100, { beforeWrite() { throw ordinary; } }), error => error === ordinary);
        const inventory = clone(before.cache.inventory); inventory['1869'].amount = 7;
        await assert.rejects(Database.syncInventorySummary(id, inventory, null, { beforeWrite() { throw ordinary; } }), error => error === ordinary);
        assert.deepEqual(facts(id), before, 'single write/transaction preserve ordinary error and all physical facts');
        let reason = null; const { callback } = session(id, () => reason);
        reason = { reason: 'coordinator_stopping' };
        await assert.rejects(Database.updateCharacterVitals(id, 94, 100, 75, 100, { beforeWrite: callback }),
            error => refused(error) && error.message === 'coordinator_stopping');
        assert.deepEqual(facts(id), before);
        reason = null; const publishError = Error('publish ordinary');
        await assert.rejects(Database.publishBotResolvedState(id, { beforeWrite: callback }, () => { throw publishError; }), error => error === publishError);
        assert.equal(await Database.publishBotResolvedState(id, { beforeWrite: callback }, () => 'after-error'), 'after-error');
    }],
    ['manual ROW late params and native owner CAS remain unchanged', async () => {
        const id = await seed('vitals'), other = await seed('vitals'), statement = statementFor(other);
        statement[1][0] = id;
        const before = facts(id);
        await withTail(async release => {
            const pending = Database.saveBotLifeState(statement);
            statement[1][0] = other; release(); assert.equal((await pending).affectedRows, 1);
        });
        const after = facts(id);
        assert.deepEqual(row(after, id), row(before, id)); assert.equal(row(after, other).hp, 94);
        assert.equal(physical(after, other).hp, 85);
        await claim(other); const leased = facts(other);
        assert.equal((await Database.saveBotLifeState(statementFor(other, 95))).affectedRows, 0);
        assert.deepEqual(facts(other), leased, 'manual original SQL legacy-only permission is still enforced');
    }],
    ['publication promises fail closed without arbitrary thenable execution', async () => {
        const id = await seed('vitals'), { callback } = session(id), before = facts(id);
        const unhandled = []; const listener = error => unhandled.push(error); process.on('unhandledRejection', listener);
        let reads = 0;
        try {
            await assert.rejects(Database.publishBotResolvedState(id, { beforeWrite: callback }, () => Promise.reject(Error('async publish'))), TypeError);
            const thenable = Object.defineProperty({}, 'then', { get() { reads++; throw Error('must not assimilate'); } });
            await assert.rejects(Database.publishBotResolvedState(id, { beforeWrite: callback }, () => thenable), TypeError);
            await new Promise(done => realImmediate(done)); assert.equal(reads, 0); assert.deepEqual(unhandled, []);
            assert.deepEqual(facts(id), before);
            assert.equal(await Database.publishBotResolvedState(id, { beforeWrite: callback }, () => 'recovered'), 'recovered');
        } finally { process.removeListener('unhandledRejection', listener); }
    }]
];

(async () => {
    assert.equal(Config.knowledgeErrorsEnabled, false);
    isolated.assertConfigured(options.default);
    console.log('DISPOSABLE', JSON.stringify({ gameRoot, directory, world: options.default.Database.path, history: options.default.Database.historyPath }));
    Database.init(); assert(Database.isReady()); Data.init(); await Life.init();
    const directFilter = process.argv.find(value => value.startsWith('--direct-case='))?.slice('--direct-case='.length);
    const directOnly = process.argv.includes('--direct-only') || !!directFilter;
    const finalOnly = process.argv.includes('--final-only');
    const selected = directOnly ? [] : process.argv.includes('--remaining') || finalOnly ? ['final'] : targets;
    for (const target of selected) await check('changing current ' + target, () => boundary(target, 'current'));
    if (!directOnly && !process.argv.includes('--remaining') && !finalOnly) {
        await check('changing manual omitted options', () => manual(false));
        await check('changing manual ordinary callback', () => manual(true));
    }
    if (!directOnly && !finalOnly) await check('actual Native renewal identity only', renewal);
    for (const target of selected) await check('Native-only freshness ' + target, () => boundary(target, 'native'));
    if (!process.argv.includes('--remaining') && !finalOnly) {
        for (const [name, work] of directCases) if (!directFilter || name === directFilter) await check('direct ' + name, work);
    }
    console.log('RESULTS', JSON.stringify({ count: outcomes.length, outcomes }));
    if (failures.length) throw Error('Native checkpoint contracts failed: ' + failures.join(', '));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    global.setImmediate = realImmediate; Database.registerCharacterWriteFlush(null);
    await Database.close();
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
    console.log('CLEANUP', JSON.stringify({ directory, exists: directory ? fs.existsSync(directory) : false }));
});
