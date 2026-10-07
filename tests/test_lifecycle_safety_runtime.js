'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const directory = path.join(os.tmpdir(), `l2solo-safety-runtime-${require('node:crypto').randomUUID()}`);
fs.mkdirSync(directory);
const fixtureConfig = path.join(directory,'fixture.ini'), defaultConfig=fs.readFileSync(path.resolve('config/default.ini'),'utf8');
const otherSections=defaultConfig.indexOf('[AuthServer]');assert(otherSections>0);
fs.writeFileSync(fixtureConfig, `[Database]\npath = ${path.join(directory,'fixture.sqlite')}\nhistoryPath = ${path.join(directory,'history.sqlite')}\n\n${defaultConfig.slice(otherSections)}`);
process.env.L2NODE_CONFIG_FILE=fixtureConfig;delete process.env.L2NODE_SHARED_CONFIG_FILE;
require('../src/Global');

const Database = invoke('Database');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Population = invoke('GameServer/Bot/Population/PopulationService');
const Registry = invoke('GameServer/Bot/Population/BackgroundJobRegistry');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const Metrics = invoke('GameServer/Bot/Population/PopulationMetrics');
const Governor = invoke('GameServer/Bot/Population/BackgroundWorkGovernor');
const World = invoke('GameServer/World/World');
const { ColdSimulationCoordinator } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
Config.knowledgeErrorsEnabled = false;
const paths = { path: options.default.Database.path, historyPath: options.default.Database.historyPath };
let opened = false;
let registry;
let coordinator;
let worldSession;
const execute = Database.execute;
const dateNow = Date.now;
const admit = Governor.admit;
const worldBefore = World.user;
const populationBefore = { started: Population.started, registry: Population.backgroundJobRegistry,
    lifeReady: Population.lifeReadyPromise, sweep: Population.lifecycleSafetySweep };
let clock = dateNow();
const turn = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate, label, turns = 200) {
    for (let attempt = 0; attempt < turns; attempt++) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`timed out: ${label}`);
}

(async () => {
    try {
        assert.equal(options.default.Database.path,path.join(directory,'fixture.sqlite'));
        assert.equal(options.default.Database.historyPath,path.join(directory,'history.sqlite'));
        assert(path.isAbsolute(options.default.Database.path)&&path.isAbsolute(options.default.Database.historyPath));
        console.log('Isolated native safety paths:',options.default.Database.path,options.default.Database.historyPath);
        await new Promise(resolve => Database.init(resolve));
        opened = true;
        await Database.createAccount('bot_safety_runtime_fixture', 'fixture');
        await Database.createCharacter('bot_safety_runtime_fixture', { name: 'SafetyRuntimeFixture',
            race: 0, classId: 0, maxHp: 100, maxMp: 100, sex: 0, face: 0, hair: 0, hairColor: 0,
            locX: 1, locY: 1, locZ: 0 });
        const characterId = Number((await Database.fetchCharacters('bot_safety_runtime_fixture'))[0].id);
        await Database.execute([`INSERT INTO bot_life_state
            (characterId, accountName, characterName, phase, activity, simulationOwner,
             simulationRevision, simulationLeaseUntil, activityStartedAt, nextResolveAt,
             lastResolvedAt, updatedAt, statsJson, inventorySummary, hp, maxHp, mp, maxMp)
            VALUES (?, 'bot_safety_runtime_fixture', 'SafetyRuntimeFixture', 'cold', 'resting',
                'legacy_main', 4, 0, 100, 9999999999999, 100, 1234, '{}', '{}', 100, 100, 100, 100)`, [characterId]]);
        const page = await Life.safetyPage({ limit: 64 });
        assert.equal(page.rows.length, 1);
        assert.equal(page.rows[0].characterId, characterId);
        const native = (await Database.execute(['SELECT * FROM bot_life_state WHERE characterId = ?', [characterId]]))[0];
        const state = Life.acceptLifecycleRow(native);
        assert.equal(Life.cachedState(characterId), state);
        assert.equal(state.simulation.revision, 4);
        let timers = 0, pulses = 0;
        registry = Registry.create({ setInterval: () => { timers++; return { unref() {} }; }, clearInterval() {} });
        registry.start();
        const unsubscribe = registry.subscribeTicks(() => { pulses++; });
        registry.tick();
        unsubscribe();
        assert.equal(timers, 1, 'one existing Registry clock positive control');
        assert.equal(pulses, 1, 'actual Registry subscription positive control');
        console.log('PASS disposable native page/cache and actual Registry pulse controls');
        assert.equal(typeof Population.startLifecycleSafetySweep, 'function', 'missing actual Population lifecycle safety runtime adapter');
        const { createLifecycleSafetyRuntime } = require('../src/GameServer/Bot/Population/LifecycleSafetyRuntime');
        assert.equal(await Life.init(), true, 'actual Life readiness positive control');
        Population.started = true;
        Population.backgroundJobRegistry = registry;
        let releaseReady;
        Population.lifeReadyPromise = new Promise(resolve => { releaseReady = resolve; });
        const lateStart = Population.startLifecycleSafetySweep();
        await turn();
        assert.equal(registry.tickSubscribers.size, 0, 'no subscription before actual Life readiness');
        Population.stopLifecycleSafetySweep();
        releaseReady(true);
        assert.equal(await lateStart, false, 'late readiness from stopped generation cannot attach');
        Population.lifeReadyPromise = Promise.resolve(false);
        assert.equal(await Population.startLifecycleSafetySweep(), false, 'failed readiness remains closed');
        Population.lifeReadyPromise = Promise.resolve(true);
        Date.now = () => clock;
        assert.equal(await Population.startLifecycleSafetySweep(), true);
        const runtime = Population.lifecycleSafetySweep;
        assert.equal(runtime.nextAt, clock + 30 * 60000);
        assert.equal(registry.tickSubscribers.size, 1);
        assert.equal(timers, 1, 'safety adds no clock');
        let sqlReads = 0;
        Database.execute = async function(statement, operation) {
            if (operation?.startsWith('bot-life:safety')) sqlReads++;
            return execute.call(this, statement, operation);
        };
        registry.tick(clock + 30 * 60000 - 1);
        await turn();
        assert.equal(sqlReads, 0, 'first pass is delayed30minutes');
        const pressures = [];
        Governor.admit = input => { pressures.push(input); return admit(input); };
        Metrics.schedulerState = { realPlayers: 1, mode: 'player', lagMs: 120 };
        clock = runtime.nextAt;
        registry.tick(clock);
        await turn();
        assert.equal(sqlReads, 0, 'actual Governor rejects protected high-lag safety work');
        assert.equal(pressures[0].playerProtected, true);
        assert.equal(pressures[0].lagMs, 120);
        assert.equal(pressures[0].resource, 'sqlite-heavy');
        Metrics.schedulerState = { realPlayers: 0, mode: 'idle', lagMs: 0 };
        Population.stopLifecycleSafetySweep();
        assert.equal(await Population.startLifecycleSafetySweep(), true);
        assert.equal(Population.lifecycleSafetySweep, runtime, 'restart retains in-flight read exclusion token');
        Population.stopLifecycleSafetySweep();

        // The actual Worker bootstraps a healthy owner. A later real producer
        // prepares a second cold row whose snapshot delivery is intentionally lost.
        invoke('GameServer/DataCache').init();
        World.user = { sessions: [], revision: 0 };
        worldSession = { actor: null, fetchAccountId: () => 'bot_safety_index_fixture' };
        World.insertUser(worldSession);
        coordinator = new ColdSimulationCoordinator();
        await coordinator.start({ realPlayerSessionsNear: World.realPlayerSessionsNear.bind(World),
            executeWorkerLifecycleCommand() { throw new Error('future resting owner must not execute a lifecycle command'); } });
        await until(() => coordinator.ready && coordinator.snapshotsLoaded, 'actual Worker bootstrap', 2500);
        // Advancing the main fixture clock by30minutes must not simulate a
        // missed heartbeat for the independently ticking native thread.
        clearInterval(coordinator.watchdogTimer);
        coordinator.watchdogTimer = null;
        assert(coordinator.worker instanceof Worker);
        assert.equal(Metrics.coldSafetySource.epoch, coordinator.workerEpoch, 'epoch begins at actual unique Worker creation');
        assert.equal(coordinator.projectedEntryFor(characterId).ok, true, 'actual initial producer retained valid healthy context');
        const healthy = Protocol.safetyCheckpoint(Life.cachedState(characterId));
        const healthyReceipt = await coordinator.requestSafety('presence', [healthy], coordinator.safetyCurrent());
        assert.equal(healthyReceipt.ok, true);
        assert.equal(healthyReceipt.results[0].normal.status, 'covered', 'actual native Worker presence positive control');

        await Database.createCharacter('bot_safety_runtime_fixture', { name: 'SafetyLostFixture', race: 0,
            classId: 0, maxHp: 100, maxMp: 100, sex: 0, face: 0, hair: 0, hairColor: 0, locX: 1, locY: 1, locZ: 0 });
        const lostId = Number((await Database.fetchCharacters('bot_safety_runtime_fixture')).find(row => row.name === 'SafetyLostFixture').id);
        await execute.call(Database, [`INSERT INTO bot_life_state
            (characterId, accountName, characterName, phase, activity, simulationOwner,
             simulationRevision, simulationLeaseUntil, activityStartedAt, nextResolveAt,
             lastResolvedAt, updatedAt, statsJson, inventorySummary, hp, maxHp, mp, maxMp)
            VALUES (?, 'bot_safety_runtime_fixture', 'SafetyLostFixture', 'cold', 'resting',
                'legacy_main', 4, 0, 100, 9999999999999, 100, 1234, '{}', '{}', 100, 100, 100, 100)`, [lostId]]);
        const lostNative = (await execute.call(Database, ['SELECT * FROM bot_life_state WHERE characterId = ?', [lostId]]))[0];
        const lostState = Life.acceptLifecycleRow(lostNative);
        await invoke('GameServer/Social/InteractionMemoryRuntime').ensureMany([lostId]);
        const prepared = coordinator.snapshotEntry(lostState);
        const workerPost = coordinator.worker.postMessage;
        try {
            coordinator.worker.postMessage = message => {
                assert.equal(message.type, 'snapshot_page');
            };
            assert.equal(await coordinator.sendSnapshotPage([prepared]), true);
        } finally { coordinator.worker.postMessage = workerPost; }
        assert.equal(coordinator.projectedEntryFor(lostId).entry, prepared);
        const lostCheckpoint = Protocol.safetyCheckpoint(lostState);
        assert.equal(coordinator.canRepairSafety(lostCheckpoint), true);
        for (const name of ['fencedBots', 'economyBots', 'commandInflight']) {
            const collection = coordinator[name];
            if (collection instanceof Map) collection.set(lostId, {}); else collection.add(lostId);
            assert.equal(coordinator.safetyExcluded(lostId), true, `${name} cheap exclusion`);
            assert.equal(coordinator.canRepairSafety(lostCheckpoint), false);
            collection.delete(lostId);
        }
        coordinator.snapshotQueue.mark(lostState);
        assert.equal(coordinator.safetyExcluded(lostId), true, 'dirty delivery already has its ordinary producer');
        coordinator.snapshotQueue.complete(coordinator.snapshotQueue.dirty.get(lostId));
        const currentVisibility = coordinator.population.realPlayerSessionsNear;
        coordinator.population.realPlayerSessionsNear = () => { throw new Error('unknown indexed visibility'); };
        assert.equal(coordinator.canRepairSafety(lostCheckpoint), false, 'unknown visibility fails closed');
        coordinator.population.realPlayerSessionsNear = currentVisibility;
        coordinator.snapshotInFlightInitial = true;
        assert.equal(coordinator.safetyExcluded(lostId), true, 'full bootstrap excludes replay');
        coordinator.snapshotInFlightInitial = false;
        const missing = await coordinator.requestSafety('presence', [lostCheckpoint], coordinator.safetyCurrent());
        assert.equal(missing.ok, true);
        assert.equal(missing.results[0].normal.status, 'uncovered');
        assert.equal(missing.results[0].normal.reason, 'missing_state', 'actual lost delivery, not a context stub');

        Population.lifecycleSafetySweep = createLifecycleSafetyRuntime(Population, coordinator);
        assert.equal(await Population.startLifecycleSafetySweep(), true);
        const nativeRuntime = Population.lifecycleSafetySweep;
        const targeted = [];
        Database.execute = async function(statement, operation) {
            if (operation === 'bot-life:safety-current') targeted.push({ statement, count: 0 });
            const rows = await execute.call(this, statement, operation);
            if (operation === 'bot-life:safety-current') targeted[targeted.length - 1].count = rows.length;
            return rows;
        };
        clock = nativeRuntime.nextAt;
        for (let i = 0; i < 100 && !nativeRuntime.metrics.completedCycles; i++) {
            registry.tick(clock);
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(nativeRuntime.metrics.completedCycles, 1, JSON.stringify({ safety: nativeRuntime.snapshot(), governor: Governor.snapshot() }));
        assert.equal(targeted.length, 1, 'healthy owner adds no targeted native SQL');
        assert.deepEqual(targeted[0].statement[1], [lostId]);
        assert.equal(targeted[0].count, 1);
        assert(/WHERE characterId = \? LIMIT 1/.test(targeted[0].statement[0]));
        assert(!/SELECT \*|json_|OFFSET/.test(targeted[0].statement[0]));
        const restored = await coordinator.requestSafety('presence', [lostCheckpoint], coordinator.safetyCurrent());
        assert.equal(restored.results[0].normal.status, 'covered');
        assert.equal(Metrics.coldSafetySource.stateRepairs, 1, 'matched native ACK records exactly one accepted restoration');
        const recovered = Metrics.counters.missedEventsRecovered;
        const oldWorker = coordinator.worker, oldEpoch = coordinator.workerEpoch;
        const pending = coordinator.requestSafety('presence', [healthy], coordinator.safetyCurrent());
        assert.equal((await coordinator.requestSafety('presence', [healthy], coordinator.safetyCurrent())).reason, 'busy', 'only one request on attachment');
        coordinator.cancelSafety();
        assert.equal((await pending).ok, false, 'cancel settles pending attachment');
        assert.equal(coordinator.safetyCurrent().epoch, oldEpoch, 'same Worker reattachment retains epoch');
        assert.equal(Metrics.coldSafetySource.stateRepairs, 1, 'same Worker reattachment does not reset watermark');
        const competitionStop = coordinator.competitionActions.stop;
        const shutdownReleases = [];
        coordinator.competitionActions.stop = async function() {
            await new Promise(resolve => shutdownReleases.push(resolve));
            return competitionStop.call(this);
        };
        const firstStop = coordinator.stop();
        const secondStop = coordinator.stop();
        try {
            await until(() => shutdownReleases.length > 0, 'actual shutdown boundary');
            await turn();
            assert.equal(shutdownReleases.length, 1, 'concurrent callers share one actual Worker shutdown');
            shutdownReleases[0]();
            await firstStop;
        } finally {
            shutdownReleases.forEach(release => release());
            await Promise.all([firstStop, secondStop]);
            coordinator.competitionActions.stop = competitionStop;
        }
        assert.equal(Metrics.coldSafetySource, null, 'actual stopped Worker retires its metrics source');
        assert.equal(await coordinator.start(), true);
        await until(() => coordinator.ready && coordinator.snapshotsLoaded, 'replacement actual Worker bootstrap', 2500);
        clearInterval(coordinator.watchdogTimer);
        coordinator.watchdogTimer = null;
        const replacement = coordinator.worker, replacementEpoch = coordinator.workerEpoch;
        await secondStop;
        assert.equal(coordinator.worker, replacement, 'late completion of a repeated stop cannot retire replacement');
        assert.equal(Metrics.coldSafetySource.epoch, replacementEpoch);
        assert.notEqual(replacementEpoch, oldEpoch);
        const beforeLate = coordinator.projectedEntryFor(characterId).entry;
        oldWorker.emit('message', Protocol.envelope('heartbeat', replacementEpoch,
            { safety: { stateRepairs: 999, coverageRepairs: 999, orphanRepairs: 999 } }));
        oldWorker.emit('exit', 0);
        assert.equal(coordinator.worker, replacement, 'late old exit cannot retire replacement');
        assert.equal(coordinator.projectedEntryFor(characterId).entry, beforeLate, 'late old exit cannot clear new projection');
        assert.equal(Metrics.coldSafetySource.epoch, replacementEpoch);
        assert.equal(Metrics.counters.missedEventsRecovered, recovered, 'wrong old Worker cannot report replacement totals');
        Population.stopLifecycleSafetySweep();

        // A native page fault leaves the cursor unchanged and retries through
        // the existing pulse. No validation or database result is substituted.
        assert.equal(await Population.startLifecycleSafetySweep(), true);
        const errors = nativeRuntime.metrics.errors;
        let nativeFault;
        Database.execute = async function(statement, operation) {
            if (operation === 'bot-life:safety-page') {
                try { return await execute.call(this, ['SELECT safety_fixture_missing_column FROM bot_life_state', []], operation); }
                catch (error) { nativeFault = error; throw error; }
            }
            return execute.call(this, statement, operation);
        };
        clock = nativeRuntime.nextAt;
        registry.tick(clock);
        await until(() => nativeRuntime.metrics.errors > errors, 'native safety page fault');
        assert(nativeFault && /no such column/.test(nativeFault.message));
        assert.deepEqual(nativeRuntime.cycle.cursor, { afterId: 0 }, 'rejected read cannot advance cursor');
        assert.equal(nativeRuntime.cycle.phase, 'read');
        Population.stopLifecycleSafetySweep();
        Database.execute = execute;

        await Database.createCharacter('bot_safety_runtime_fixture', { name: 'SafetyAwaitFixture', race: 0,
            classId: 0, maxHp: 100, maxMp: 100, sex: 0, face: 0, hair: 0, hairColor: 0, locX: 1, locY: 1, locZ: 0 });
        const awaitId = Number((await Database.fetchCharacters('bot_safety_runtime_fixture')).find(row => row.name === 'SafetyAwaitFixture').id);
        await execute.call(Database, [`INSERT INTO bot_life_state
            (characterId, accountName, characterName, phase, activity, simulationOwner,
             simulationRevision, simulationLeaseUntil, activityStartedAt, nextResolveAt,
             lastResolvedAt, updatedAt, statsJson, inventorySummary, hp, maxHp, mp, maxMp)
            SELECT ?, accountName, 'SafetyAwaitFixture', phase, activity, simulationOwner,
                simulationRevision, simulationLeaseUntil, activityStartedAt, nextResolveAt,
                lastResolvedAt, updatedAt, statsJson, inventorySummary, hp, maxHp, mp, maxMp
            FROM bot_life_state WHERE characterId = ?`, [awaitId, characterId]]);
        const awaitNative = (await execute.call(Database, ['SELECT * FROM bot_life_state WHERE characterId = ?', [awaitId]]))[0];
        const awaitState = Life.acceptLifecycleRow(awaitNative);
        await invoke('GameServer/Social/InteractionMemoryRuntime').ensureMany([awaitId]);
        const awaitEntry = coordinator.snapshotEntry(awaitState);
        const replacementPost = replacement.postMessage;
        try {
            replacement.postMessage = message => { assert.equal(message.type, 'snapshot_page'); };
            await coordinator.sendSnapshotPage([awaitEntry]);
        } finally { replacement.postMessage = replacementPost; }
        let readEntered = false, releaseRead;
        const readGate = new Promise(resolve => { releaseRead = resolve; });
        let heldReads = 0;
        Database.execute = async function(statement, operation) {
            if (operation === 'bot-life:safety-current') {
                heldReads++;
                assert.deepEqual(statement[1], [awaitId]);
                readEntered = true;
                await readGate;
            }
            return execute.call(this, statement, operation);
        };
        assert.equal(await Population.startLifecycleSafetySweep(), true);
        clock = nativeRuntime.nextAt;
        for (let i = 0; i < 100 && !readEntered; i++) { registry.tick(clock); await new Promise(resolve => setTimeout(resolve, 10)); }
        assert.equal(readEntered, true, 'proven uncovered owner reaches the actual targeted native read');
        const token = nativeRuntime.inFlight;
        Population.stopLifecycleSafetySweep();
        assert.equal(await Population.startLifecycleSafetySweep(), true);
        assert.equal(Population.lifecycleSafetySweep, nativeRuntime);
        clock = nativeRuntime.nextAt;
        registry.tick(clock);
        await turn();
        assert.equal(nativeRuntime.inFlight, token, 'restart cannot overlap the previous native await');
        assert.equal(heldReads, 1);
        await execute.call(Database, ["UPDATE bot_life_state SET phase = 'hot' WHERE characterId = ?", [awaitId]]);
        assert.equal(Life.cachedState(awaitId), awaitState, 'durable phase change precedes cache refresh');
        releaseRead();
        await until(() => !nativeRuntime.inFlight, 'old native await completion');
        assert.equal(Metrics.coldSafetySource.stateRepairs, 0, 'late old generation cannot replay after native phase drift');
        assert.equal(Metrics.counters.missedEventsRecovered, recovered);
        Population.stopLifecycleSafetySweep();
        console.log('Lifecycle safety runtime integration tests passed');
    } finally {
        Date.now = dateNow;
        Governor.admit = admit;
        Database.execute = execute;
        Population.stopLifecycleSafetySweep?.();
        if (coordinator) await coordinator.stop();
        if (worldSession) World.removeUser(worldSession);
        World.user = worldBefore;
        Population.started = populationBefore.started;
        Population.backgroundJobRegistry = populationBefore.registry;
        Population.lifeReadyPromise = populationBefore.lifeReady;
        Population.lifecycleSafetySweep = populationBefore.sweep;
        registry?.stop();
        if (opened) await Database.close();
        options.default.Database.path = paths.path;
        options.default.Database.historyPath = paths.historyPath;
        fs.rmSync(directory, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
