process.env.BOT_DEVELOPER_DIAGNOSTICS = 'true'; // This fixture inspects optional developer metrics.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const gameRoot = process.env.N53_GAME_ROOT || path.resolve(__dirname, '..');
require(path.join(gameRoot, 'src/Global'));
const Database = invoke('Database');
const Data = invoke('GameServer/DataCache');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Population = invoke('GameServer/Bot/Population/PopulationService');
const Protocol = invoke('GameServer/Bot/Population/ColdSimulationProtocol');
const { ColdSimulationCoordinator } = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const DeathExperience = invoke('GameServer/Progression/DeathExperience');
const Policy = invoke('GameServer/Bot/Population/ColdKarmaPolicy');
const Resolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const SpotService = invoke('GameServer/Bot/AI/SpotService');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const World = invoke('GameServer/World/World');
const NpcModel = invoke('GameServer/Model/Npc');
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
let directory, serial = 0, field;
const failures = [];
const only = process.argv.find(value => value.startsWith('--only='))?.slice(7);
let executed = 0;
const tables = ['bot_life_state', 'characters', 'skills', 'items', 'warehouse_items', 'afk_trade_shops', 'afk_trade_lines', 'character_death_experience'];
function facts(id) {
    const db = new DatabaseSync(options.default.Database.path, { readOnly: true });
    try {
        const result = {};
        for (const table of tables) result[table] = clone(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
        result.cache = clone(Life.cachedState(id)); return result;
    } finally { db.close(); }
}
const physical = (image, id) => image.characters.find(row => row.id === id);
const ownRow = (image, id) => image.bot_life_state.find(row => row.characterId === id);
const entitlement = (image, id) => image.character_death_experience.find(row => row.characterId === id);
function shippedField() {
    const group = Data.npcSpawns.find(row => row.selfId === 't21_21_049'); assert(group);
    const point = { locX: Math.round(group.bounds.reduce((sum, row) => sum + row.locX, 0) / group.bounds.length),
        locY: Math.round(group.bounds.reduce((sum, row) => sum + row.locY, 0) / group.bounds.length), locZ: group.bounds[0].maxZ };
    // The three real models sample one shipped polygon at its interior mean.
    // This is a disposable representative field, without World.init or NPC AI.
    World.npc = { spawns: group.spawns.flatMap(row => Array.from({ length: row.total }, () =>
        new NpcModel({ ...utils.crushOb(Data.npcs.find(npc => npc.selfId === row.selfId)), ...point }))) };
    SpotService.spots = null; SpotProfiles.reset();
    const spot = SpotProfiles.ensure().find(row => row.npcSelfIds.includes(204));
    assert(spot); assert.equal(spot.id, '6_17'); assert.equal(spot.density, 3);
    assert.equal(utils.isInPeaceZone(point.locX, point.locY), false);
    return { point, spot, group: group.selfId };
}
async function seed(branch) {
    const account = `bot_exp_tail_${++serial}`, karma = branch === 'karma', level = karma ? 28 : 7, classId = karma ? 1 : 0;
    const loc = karma ? field.point : { locX: 83000, locY: 148000, locZ: -3400 };
    const id = Number((await Database.createAccount(account, 'fixture').then(() => Database.createCharacter(account,
        { name: `ExpTail${serial}`, race: 0, classId, sex: 0, face: 0, hair: 0, hairColor: 0,
            maxHp: 100, maxMp: 100, ...loc }))).insertId);
    const gear = karma ? [2499, 352, 2378, 2411, 50, 40] : [];
    for (const selfId of [57, 1869, ...gear]) {
        const template = Data.items.find(item => item.selfId === selfId); assert(template);
        await Database.setItem(id, { selfId, name: template.template.name, amount: selfId === 57 ? 1000 : selfId === 1869 ? 2 : 1,
            equipped: gear.includes(selfId), enchant: 0, slot: gear.includes(selfId) ? template.etc.slot : 0 });
    }
    const time = Date.now(), interval = Number(Data.experience[level]) - Number(Data.experience[level - 1]);
    let exp = Number(Data.experience[level - 1]) + Math.floor(interval / 2), death = null;
    if (['restore', 'clear', 'clear_fallback'].includes(branch)) {
        const loss = DeathExperience.calculateLoss({ level, exp, skills: [] });
        assert(loss.expLost > 0);
        death = await Database.applyCharacterDeathExperience({ characterId: id, level, expBeforeDeath: exp,
            expLost: loss.expLost, expAfterDeath: loss.expAfterDeath, deathContext: { cold: true }, penaltyAppliedAt: time - 1000, sp: 120, karma: 0 });
        exp = loss.expAfterDeath;
    }
    let state = { characterId: id, accountName: account, name: `ExpTail${serial}`, level, exp, sp: 120, adena: 1000,
        inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)), phase: 'cold', activity: karma ? 'hunting' : 'resting',
        spotId: karma ? field.spot.id : null, loc, vitals: { hp: 85, maxHp: 100, mp: 70, maxMp: 100 },
        timing: { lastResolvedAt: time - 60000, nextResolveAt: time + 30000 },
        stats: { karma: karma ? 45 : 0, classId, classProgressionLevel: level, classProgressionClassId: classId,
            restUntil: karma ? null : time + 30000, deaths: death ? 1 : 0,
            ...(death ? { deathExperience: { ...death, pendingRestoration: true } } : {}) } };
    if (karma) {
        const profile = Profile.profileFor(state, time);
        state.vitals = { hp: Math.round(profile.maxHp), maxHp: Math.round(profile.maxHp), mp: Math.round(profile.maxMp), maxMp: Math.round(profile.maxMp) };
    }
    assert(await Life.upsertState(state, 'exp_tail_seed'));
    if (karma) await Database.updateCharacterPvpPkKarma(id, 0, 0, 45);
    assert.equal(physical(facts(id), id).exp, exp);
    if (death) assert.equal(entitlement(facts(id), id).pendingRestoration, 1);
    return id;
}
function workerResult(branch, state, timestamp) {
    if (branch === 'karma') {
        const plan = Policy.plan(state, SpotProfiles.ensure(), timestamp);
        assert.equal(plan.plannedState.activity, 'hunting'); assert.equal(plan.targetNpcId, 204);
        // Required Worker field is actual resolver output. The early Main
        // karma path ignores it and performs its own authored resolve again.
        return Resolver.resolveSolo({ state: plan.plannedState, spot: plan.spot, targetNpcId: plan.targetNpcId, elapsedMs: 60000, timestamp });
    }
    if (['clear', 'clear_fallback'].includes(branch)) {
        // The original recovery resolver supplies its real clear patch; no
        // synthetic EXP award is added to its idempotent fallback statement.
        return Resolver.resolveDeathRecovery(state, timestamp);
    }
    const result = { patch: { activity: 'resting', vitals: { ...state.vitals, hp: 90 }, stats: { restUntil: timestamp + 60000 } },
        events: [], materialize: { exp: branch === 'restore_fallback' ? 13 : 0, sp: 0, adena: 0, items: [] }, nextResolveAt: timestamp + 60000 };
    if (branch === 'death') {
        result.patch.activity = 'dead'; result.patch.vitals.hp = 0; result.patch.deathCount = 1;
        result.debug = { died: true, fights: 1, wins: 0 };
    } else result.patch.restoreExpPercent = 40;
    return result;
}
function holdQueue(entered, gate, label) {
    let armed = true;
    global.setImmediate = (callback, ...values) => {
        if (armed && new Error().stack.includes('yieldToEventLoop')) {
            armed = false; entered.resolve(); return realImmediate(async () => { await gate.promise; callback(...values); });
        }
        return realImmediate(callback, ...values);
    };
    return Database.cooperatively(() => Database.execute(['SELECT 1 AS real_exp_tail_queue', [], { onTiming() {
        const end = Date.now() + 2; while (Date.now() < end) { /* Reach the existing cooperative yield. */ }
    } }], label), 1);
}
async function boundary(branch, stage, mode) {
    const id = await seed(branch), state = Life.snapshot(id), time = Date.now();
    const request = { kind: 'lifecycle', characterId: id, commandId: `exp-tail:${serial}`,
        commandCheckpoint: Protocol.commandCheckpoint(state), state, context: {}, precomputedResult: workerResult(branch, state, time) };
    const c = new ColdSimulationCoordinator(), sent = [], entered = deferred(), gate = deferred(), called = deferred();
    const stopEntered = deferred(), stopGate = deferred();
    c.ready = true; c.workerEpoch = `exp-tail:${serial}`;
    const worker = label => ({ postMessage(message) { sent.push({ label, message: clone(message) });
        if (message.type === 'fence') realImmediate(() => c.onMessage(Protocol.envelope('fence_ack', message.workerEpoch,
            { characterId: id, proposal: null, token: null }, message.msgId), c.worker, c.workerEpoch));
        if (message.type === 'shutdown') realImmediate(() => c.onMessage(Protocol.envelope('drained', message.workerEpoch,
            { ok: true }, message.msgId), c.worker, c.workerEpoch));
    }, terminate: async () => {} });
    c.worker = worker('A'); const origin = c.worker, epoch = c.workerEpoch;
    let admission, control, stop, held = false, targetEntered = false, flushCompleted = false, targetFlushes = 0, mainResult, inputBag;
    c.population = { executeWorkerLifecycleCommand(...args) { admission = args[2]?.workerAdmission; return Population.executeWorkerLifecycleCommand(...args); } };
    c.contextIndex = () => ({}); c.contextFor = () => ({});
    const method = { karma: 'updateColdCharacterExperience', death: 'applyCharacterDeathExperience', restore: 'restoreCharacterDeathExperience',
        clear: 'clearCharacterDeathExperience', restore_fallback: 'updateCharacterExperience', clear_fallback: 'updateCharacterExperience' }[branch];
    const original = Database[method], originalResolver = Resolver.resolveSolo;
    Database[method] = function (...args) {
        const target = branch === 'death' ? args[0]?.characterId : args[0];
        if (target === id) { targetEntered = true; called.resolve(); inputBag = args[branch === 'death' ? 1 : ['karma', 'restore_fallback', 'clear_fallback'].includes(branch) ? 4 : 3]; }
        return original.apply(this, args);
    };
    Resolver.resolveSolo = function (...args) { const result = originalResolver.apply(this, args); if (args[0]?.state.characterId === id) mainResult = result; return result; };
    Database.registerCharacterWriteFlush(async currentId => {
        if (currentId !== id || !targetEntered || held) return;
        held = true; targetFlushes++;
        if (stage === 'flush') { entered.resolve(); await gate.promise; }
        else { control = holdQueue(entered, gate, `exp-tail:${branch}-control-read`); flushCompleted = true; }
    });
    try {
        await c.onMessage(Protocol.envelope('command_request', epoch, { requests: [request] }, `exp-tail-message:${serial}`), origin, epoch);
        await wait(entered.promise, `real ${branch} ${stage}`); await wait(called.promise, 'real writer called'); await turn();
        assert.equal(targetFlushes, 1); assert(c.commandInflight.has(id)); assert.equal(admission.check(), null);
        if (stage === 'queue') { assert(flushCompleted); assert(Database.stats().pending >= 1); }
        const initial = facts(id), before = physical(initial, id), row = ownRow(initial, id), deathBefore = entitlement(initial, id);
        assert(Protocol.sameCommandCheckpoint(request.commandCheckpoint, initial.cache));
        assert.equal(initial.cache.exp, state.exp); assert.equal(before.exp, state.exp, 'held primary/fallback still awaits physical EXP');
        if (branch === 'karma') {
            assert(mainResult && mainResult !== request.precomputedResult, 'Main performs its own actual resolver work');
            assert(mainResult.materialize.exp >= 260); assert(mainResult.debug.wins > 0); assert.equal(mainResult.debug.died, false);
            assert.equal(row.exp, state.exp + mainResult.materialize.exp); assert.equal(before.karma, 45);
            assert.equal(JSON.parse(row.statsJson).karma, 45 - Math.floor(mainResult.materialize.exp / 260));
        }
        if (branch === 'death') { assert(row.exp < state.exp); assert.equal(deathBefore, undefined); }
        if (branch === 'restore') { assert(row.exp > state.exp); assert.equal(deathBefore.pendingRestoration, 1); }
        if (branch === 'clear') { assert.equal(row.exp, state.exp); assert.equal(deathBefore.pendingRestoration, 1); }
        if (branch === 'restore_fallback') { assert.equal(row.exp, state.exp + 13); assert.equal(deathBefore, undefined); }
        if (branch === 'clear_fallback') { assert.equal(row.exp, state.exp); assert.equal(deathBefore.pendingRestoration, 0, 'earlier real clear is already accepted'); }
        if (mode === 'replace') { c.worker = worker('B'); c.workerEpoch = 'exp-tail:replacement'; assert.deepEqual(admission.check(), { reason: 'stale_worker_source' }); }
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
        const barrier = facts(id); gate.resolve(); await control; await c.commandTail;
        const after = facts(id), character = physical(after, id), deathAfter = entitlement(after, id), acks = sent.filter(row => row.message.type === 'command_ack');
        const changed = Object.keys(barrier).filter(key => JSON.stringify(barrier[key]) !== JSON.stringify(after[key]));
        console.log(JSON.stringify({ branch, stage, mode, targetFlushes, flushCompleted, method,
            award: mainResult?.materialize.exp, mainDebug: mainResult?.debug,
            beforePhysicalExp: before.exp, afterPhysicalExp: character.exp, ownRowExp: row.exp,
            beforeKarma: before.karma, afterKarma: character.karma, beforePending: deathBefore?.pendingRestoration, afterPending: deathAfter?.pendingRestoration,
            beforeCacheExp: barrier.cache.exp, afterCacheExp: after.cache.exp, nativeInputHasBeforeWrite: typeof inputBag?.beforeWrite === 'function', changed,
            receipts: acks.map(row => ({ label: row.label, ok: row.message.payload.results[0]?.ok, reason: row.message.payload.results[0]?.reason,
                commandId: row.message.payload.results[0]?.commandId, checkpoint: row.message.payload.results[0]?.commandCheckpoint })) }));
        assert.equal(c.commandInflight.size, 0);
        if (mode === 'current') {
            assert.equal(character.exp, row.exp); assert.equal(after.cache.exp, row.exp);
            if (branch === 'karma') { assert(character.exp > state.exp); assert.equal(character.karma, 45 - Math.floor((character.exp - state.exp) / 260)); }
            if (branch === 'death') { assert(character.exp < state.exp); assert.equal(deathAfter.pendingRestoration, 1); assert.equal(deathAfter.expAfterDeath, character.exp); }
            if (['restore', 'clear', 'clear_fallback'].includes(branch)) assert.equal(deathAfter.pendingRestoration, 0);
            if (branch === 'restore') assert(character.exp > state.exp);
            if (branch === 'restore_fallback') assert.equal(character.exp, state.exp + 13);
            assert.equal(acks.length, 1); assert.equal(acks[0].label, 'A'); assert.equal(acks[0].message.payload.results[0].ok, true);
            assert.deepEqual(acks[0].message.payload.results[0].commandCheckpoint, request.commandCheckpoint);
        } else {
            if (mode === 'replace') assert.equal(acks.length, 0, 'retired source cannot publish its receipt');
            else {
                assert.equal(acks.length, 1); const result = acks[0].message.payload.results[0];
                assert.equal(result.ok, false); assert.equal(result.retryAfterMs, 1000);
                assert.equal(result.reason, mode === 'stop' ? 'coordinator_stopping' : mode === 'fence' ? 'hot_handoff_fenced' : 'stale_command');
                assert.deepEqual(result.commandCheckpoint, request.commandCheckpoint);
            }
            if (branch === 'clear_fallback') {
                assert.equal(typeof inputBag?.beforeWrite, 'function', 'idempotent post-clear fallback needs its own admission bag; this is not an EXP mutation RED');
            }
            assert.deepEqual(after, barrier, 'held next writer must conserve all eight tables and original cache AFTER authority control');
        }
    } finally {
        gate.resolve(); await control?.catch(() => null); await c.commandTail.catch(() => null);
        global.setImmediate = realImmediate; Database[method] = original; Resolver.resolveSolo = originalResolver; Database.registerCharacterWriteFlush(null);
        stopGate.resolve(); if (stop) await stop;
    }
}
function proposal(branch, id, bag) {
    const state = Life.snapshot(id), time = Date.now();
    if (branch === 'karma') return Database.updateColdCharacterExperience(id, state.level, state.exp + 520, state.sp + 5, bag);
    if (branch === 'death') {
        const loss = DeathExperience.calculateLoss(state);
        return Database.applyCharacterDeathExperience({ characterId: id, level: state.level, expBeforeDeath: state.exp,
            expLost: loss.expLost, expAfterDeath: loss.expAfterDeath, deathContext: { cold: true }, penaltyAppliedAt: time, sp: state.sp, karma: 0 }, bag);
    }
    if (branch === 'restore') return Database.restoreCharacterDeathExperience(id, 40, time, bag);
    return Database.clearCharacterDeathExperience(id, 'exp_tail_direct', time, bag);
}
function assertDirectMutation(branch, id, before, after) {
    const previous = physical(before, id), current = physical(after, id);
    if (branch === 'karma') { assert.equal(current.exp, previous.exp + 520); assert.equal(current.karma, Math.max(0, previous.karma - 2)); }
    if (branch === 'death') { assert(current.exp < previous.exp); assert.equal(entitlement(after, id).pendingRestoration, 1); }
    if (branch === 'restore') { assert(current.exp > previous.exp); assert.equal(entitlement(after, id).pendingRestoration, 0); }
    if (branch === 'clear') { assert.equal(current.exp, previous.exp); assert.equal(entitlement(after, id).pendingRestoration, 0); }
}
async function manualPolicy(branch) {
    const id = await seed(branch), before = facts(id), metricsBefore = Database.stats();
    const result = await proposal(branch, id), after = facts(id), metricsAfter = Database.stats();
    assertDirectMutation(branch, id, before, after);
    assert.equal(metricsAfter.reads, metricsBefore.reads); assert.equal(metricsAfter.writes, metricsBefore.writes + 1);
    assert.equal(metricsAfter.transactions, metricsBefore.transactions + (['death', 'restore'].includes(branch) ? 1 : 0));
    const operation = { karma: 'character:cold-experience', death: 'character:death-exp-apply', restore: 'character:death-exp-restore', clear: 'character:death-exp-clear' }[branch];
    assert.equal(metricsAfter.operations[operation].count, Number(metricsBefore.operations[operation]?.count || 0) + 1);
    if (branch === 'karma') {
        assert.deepEqual(Object.keys(result).sort(), ['affectedRows', 'insertId']); assert.equal(result.affectedRows, 1);
        const character = physical(after, id);
        await Database.updateColdCharacterExperience(id, character.level, character.exp, character.sp);
        assert.equal(physical(facts(id), id).karma, character.karma, 'same physical EXP is not washed twice');
        await Database.updateColdCharacterExperience(id, character.level, character.exp - 1, character.sp);
        assert.equal(physical(facts(id), id).karma, character.karma, 'negative EXP delta does not wash/add karma');
        assert.equal(physical(facts(id), id).pk, physical(before, id).pk);
    }
    if (branch === 'death') {
        assert.equal(result.duplicate, false); assert.equal(result.deathSequence, 1);
        const immutable = facts(id);
        const duplicate = await Database.applyCharacterDeathExperience({ ...result, expAfterDeath: result.expAfterDeath - 10, sp: 999, karma: 99 });
        assert.equal(duplicate.duplicate, true); assert.deepEqual(facts(id), immutable, 'duplicate native death cannot replace SP/karma/sequence');
    }
    if (branch === 'restore') {
        assert.equal(result.restorePercent, 40); assert.equal(result.restoredExp, Math.round(entitlement(before, id).expLost * 0.4));
        assert.equal(result.totalExp, physical(after, id).exp); assert.equal(result.pendingRestoration, 0);
        assert.equal(physical(after, id).sp, physical(before, id).sp);
        assert.equal(await Database.restoreCharacterDeathExperience(id, 100), null, 'restoration is one-use');
        const capped = await seed('restore'), capBefore = facts(capped);
        const full = await Database.restoreCharacterDeathExperience(capped, 200, 1700);
        assert.equal(full.restorePercent, 100); assert.equal(full.totalExp, entitlement(capBefore, capped).expBeforeDeath);
        assert.equal(entitlement(facts(capped), capped).resolvedAt, 1700);
        const zero = await seed('restore'), zeroBefore = facts(zero);
        const nothing = await Database.restoreCharacterDeathExperience(zero, -40, 1800);
        assert.equal(nothing.restorePercent, 0); assert.equal(nothing.restoredExp, 0);
        assert.equal(physical(facts(zero), zero).exp, physical(zeroBefore, zero).exp);
        assert.equal(entitlement(facts(zero), zero).pendingRestoration, 0, 'zero restore still consumes pending entitlement');
    }
    if (branch === 'clear') {
        assert.deepEqual(Object.keys(result).sort(), ['affectedRows', 'insertId']); assert.equal(result.affectedRows, 1);
        assert.equal(entitlement(after, id).resolutionReason, 'exp_tail_direct');
        const repeat = await Database.clearCharacterDeathExperience(id, 'must_not_replace');
        assert.equal(repeat.affectedRows, 0); assert.deepEqual(facts(id), after, 'conditional repeat preserves native reason/time');
    }
    assert.deepEqual(after.cache, before.cache, 'manual Database API does not publish lifecycle cache');
}
async function captureBoundary(branch, stage) {
    const id = await seed(branch), before = facts(id), entered = deferred(), gate = deferred(); let calls = 0, control;
    const bag = { beforeWrite: function () { 'use strict'; assert.equal(this, undefined); calls++; } };
    Database.registerCharacterWriteFlush(async currentId => {
        assert.equal(currentId, id);
        if (stage === 'flush') { entered.resolve(); await gate.promise; }
        else control = holdQueue(entered, gate, `exp-tail:${branch}-direct-control`);
    });
    try {
        const pending = proposal(branch, id, bag); await wait(entered.promise, 'method-time capture'); await turn();
        const snapshot = facts(id); assert.deepEqual(snapshot, before);
        bag.beforeWrite = () => { throw Error('late replacement must not be adopted'); };
        gate.resolve(); await control; await pending;
        assert.equal(calls, 1); assertDirectMutation(branch, id, before, facts(id));
    } finally { gate.resolve(); await control?.catch(() => null); global.setImmediate = realImmediate; Database.registerCharacterWriteFlush(null); }
}
async function capturedMalformed() {
    const id = await seed('death'), before = facts(id), entered = deferred(), gate = deferred();
    const bag = { beforeWrite: null }; let calls = 0;
    Database.registerCharacterWriteFlush(async () => { entered.resolve(); await gate.promise; });
    try {
        const pending = proposal('death', id, bag); await wait(entered.promise, 'captured malformed tx callback');
        bag.beforeWrite = () => { calls++; }; gate.resolve();
        await assert.rejects(pending, error => error instanceof TypeError && error.message === 'invalid_character_experience_before_write');
        assert.equal(calls, 0); assert.deepEqual(facts(id), before);
    } finally { gate.resolve(); Database.registerCharacterWriteFlush(null); }
}
async function representativeDomain(branch) {
    const id = await seed(branch), before = facts(id), ordinary = Error('ordinary_exp_tail_callback');
    const copied = Object.assign(Error('stale_command'), { code: 'BOT_WORKER_COMMAND_ADMISSION_REFUSED' });
    const branded = new WorkerCommandAdmissionRefusal('stale_command');
    for (const error of [ordinary, copied, branded]) {
        await assert.rejects(proposal(branch, id, { beforeWrite() { throw error; } }), value => value === error);
        assert.deepEqual(facts(id), before, 'throwing callback cannot start native fact mutation');
    }
    let thenCalls = 0; const unhandled = [], listener = error => unhandled.push(error); process.on('unhandledRejection', listener);
    try {
        for (const bag of [{ beforeWrite: () => null }, { beforeWrite: () => Promise.reject(Error('actual_rejected_exp_guard')) },
            { beforeWrite: () => Object.defineProperty({}, 'then', { get() { thenCalls++; throw Error('must_not_assimilate'); } }) }]) {
            await assert.rejects(proposal(branch, id, bag), error => error instanceof TypeError && error.message === 'invalid_character_experience_before_write');
            assert.deepEqual(facts(id), before);
        }
        await turn(); assert.equal(thenCalls, 0); assert.deepEqual(unhandled, []);
        await proposal(branch, id, { beforeWrite() {} }); assertDirectMutation(branch, id, before, facts(id));
    } finally { process.removeListener('unhandledRejection', listener); }
}
async function ordinaryFlushFailure(branch) {
    const id = await seed(branch), before = facts(id), error = Error('original_exp_tail_flush_failure'); let calls = 0;
    Database.registerCharacterWriteFlush(async () => { throw error; });
    try {
        await assert.rejects(proposal(branch, id, { beforeWrite() { calls++; } }), value => value === error);
        assert.equal(calls, 0); assert.deepEqual(facts(id), before);
    } finally { Database.registerCharacterWriteFlush(null); }
    await proposal(branch, id); assertDirectMutation(branch, id, before, facts(id));
}
async function deathRollback() {
    const id = await seed('death'), state = Life.snapshot(id), before = facts(id), loss = DeathExperience.calculateLoss(state);
    const cyclic = {}; cyclic.self = cyclic;
    const record = { characterId: id, level: state.level, expBeforeDeath: state.exp, expLost: loss.expLost, expAfterDeath: loss.expAfterDeath,
        deathContext: cyclic, penaltyAppliedAt: Date.now(), sp: 125, karma: 3 }; let calls = 0;
    await assert.rejects(Database.applyCharacterDeathExperience(record, { beforeWrite() { calls++; } }), error => error instanceof TypeError);
    assert.equal(calls, 1); assert.deepEqual(facts(id), before, 'original transaction rolls back earlier physical EXP/SP/karma DML on ordinary JSON failure');
    record.deathContext = { cold: true };
    const result = await Database.applyCharacterDeathExperience(record); assert.equal(result.duplicate, false);
    assertDirectMutation('death', id, before, facts(id)); assert.equal(physical(facts(id), id).sp, 125);
}
async function shutdownPriority() {
    const karma = await seed('karma'), death = await seed('death'); await Database.close(); let calls = 0;
    await assert.rejects(proposal('karma', karma, { beforeWrite() { calls++; } }), error => error.message === 'SQLite shutdown is in progress (character:cold-experience)');
    await assert.rejects(proposal('death', death, { beforeWrite() { calls++; } }), error => error.message === 'SQLite shutdown is in progress (character:death-exp-apply)');
    assert.equal(calls, 0, 'original queued shutdown refusal precedes admission and BEGIN');
}
async function check(name, work) {
    if (only && !name.includes(only)) return;
    executed++;
    try { await work(); console.log('PASS', name); }
    catch (error) { failures.push(name); console.error('FAIL', name, error.stack); }
}
(async () => {
    directory = fs.mkdtempSync(path.join(process.cwd(), 'tmp', 'exp-tail-native-'));
    options.default.Database.path = path.join(directory, 'world.sqlite'); options.default.Database.historyPath = path.join(directory, 'history.sqlite');
    Database.init(); assert(Database.isReady()); Data.init(); await Life.init(); field = shippedField();
    const sourceHashes = {};
    for (const file of ['src/Database.js', 'src/GameServer/Bot/Population/BotLifeState.js', 'src/GameServer/Bot/Population/PopulationService.js',
        'src/GameServer/Bot/Population/ColdSimulationCoordinator.js', 'src/GameServer/Bot/Population/BackgroundResolver.js', 'src/GameServer/Bot/Population/ColdKarmaPolicy.js']) {
        sourceHashes[file] = crypto.createHash('sha256').update(fs.readFileSync(path.join(gameRoot, file))).digest('hex');
    }
    console.log(JSON.stringify({ source: gameRoot, sourceHashes, fixtureSha256: crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),
        boundary: 'actual Main/native chain; controlled Worker identity, not an OS Worker; actual karma Policy/Resolver; other Worker-issued branch patches', field }));
    const branches = ['karma', 'death', 'restore', 'clear', 'restore_fallback', 'clear_fallback'];
    for (const branch of branches) for (const stage of ['flush', 'queue']) await check(`current ${branch} ${stage}`, () => boundary(branch, stage, 'current'));
    if (failures.length) throw Error('EXP-tail healthy fixture is not applicable: ' + failures.join(', '));
    for (const mode of ['replace', 'stop', 'fence', 'changed']) for (const branch of branches) for (const stage of ['flush', 'queue']) {
        await check(`${mode} ${branch} ${stage}`, () => boundary(branch, stage, mode));
    }
    for (const branch of ['karma', 'death', 'restore', 'clear']) {
        await check(`manual ${branch} original policy/results/metrics`, () => manualPolicy(branch));
        for (const stage of ['flush', 'queue']) await check(`method-time ${branch} capture ${stage}`, () => captureBoundary(branch, stage));
    }
    await check('captured malformed tx bag cannot be repaired during flush', capturedMalformed);
    for (const branch of ['karma', 'death']) {
        await check(`representative ${branch} strict void/error/native Promise domain`, () => representativeDomain(branch));
        await check(`original ${branch} flush error/cleanup`, () => ordinaryFlushFailure(branch));
    }
    await check('original death transaction rolls back partial ordinary DML', deathRollback);
    await check('original shutdown precedence single/transaction', shutdownPriority);
    assert(executed > 0, 'requested fixture subset must execute a real control');
    if (failures.length) throw Error('EXP-tail next-writer contracts failed: ' + failures.join(', '));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    await Database.close(); if (directory) fs.rmSync(directory, { recursive: true, force: true });
});
