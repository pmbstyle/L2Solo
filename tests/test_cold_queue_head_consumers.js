const assert = require('node:assert/strict');
require('../src/Global');
const Database = invoke('Database');
const Status = invoke('GameServer/Bot/Population/PopulationStatus');
const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const LoadTest = invoke('GameServer/Bot/LoadTest/HotBotLoadTest');
const Observer = invoke('WorldObserver/WorldObserverServer');
const { ColdSimulationCoordinator } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');
const { format } = require('node:util');
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
const original = { snapshot: Coordinator.snapshot, json: Observer.snapshotJson,
    cache: Observer.snapshotCacheStats, finish: LoadTest.finish, player: LoadTest.playerSession,
    interval: global.setInterval, timeout: global.setTimeout,
    clearInterval: global.clearInterval, clearTimeout: global.clearTimeout,
    infoSuccess: utils.infoSuccess };
const failures = [];
let sample;
Coordinator.snapshot = () => ({ ready: true, worker: sample,
    queue: {}, snapshots: { dirty: 7, oldestMs: 11 } });
async function check(name, work) {
    try { await work(); console.log(`${name}: PASS`); }
    catch (error) { failures.push(name); console.error(`${name}: FAIL ${error.stack}`); }
}
async function measured(head) {
    const timers = [], completed = [];
    sample = { states: 13, ...(head === undefined ? {} : { queueHead: head }) };
    global.setInterval = (work, delay) => { const timer = { work, delay }; timers.push(timer); return timer; };
    global.setTimeout = (work, delay) => { const timer = { work, delay, timeout: true, unref() {} }; timers.push(timer); return timer; };
    global.clearInterval = () => {}; global.clearTimeout = () => {};
    Observer.snapshotJson = async () => '{}'; Observer.snapshotCacheStats = () => ({ builds: 1 });
    LoadTest.playerSession = { packetCount: 0, packetBytes: 0 };
    LoadTest.finish = result => { completed.push(result); };
    LoadTest.measureReady({ count: 0, durationMs: 5000, tickMs: 1000, spreadMs: 25,
        runStartedAt: Date.now(), mode: 'mixed', coldMin: 0, preparedDue: 0, itemByCharacter: new Map() });
    const observer = timers.find(timer => !timer.timeout && timer.delay === 1000);
    assert(observer, 'actual measurement registered its observer timer');
    observer.work(); await new Promise(resolve => setImmediate(resolve));
    const finish = timers.find(timer => timer.timeout && timer.delay === 5000);
    assert(finish, 'actual measurement registered bounded finish');
    finish.work(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(completed.length, 1);
    assert.equal(completed[0].reason, undefined, JSON.stringify(completed[0]));
    const result = completed[0].population.coldBacklog;
    assert.equal(result.length, 1);
    assert.equal(result[0].states, 13); assert.equal(result[0].snapshots, 7); assert.equal(result[0].snapshotAgeMs, 11);
    return result[0];
}
(async () => {
    try {
        assert.equal(Database.isReady(), false);
        await check('actual status preserves Worker metadata and ordinary pressure fields', () => {
            sample = { states: 13, queueHead: { kind: 'normal', dueAt: 123, overdue: true, ageMs: 5000, current: true } };
            const result = Status.summary();
            assert.equal(result.coldWorker.worker, sample); assert.match(result.line, /snapshot=7/);
            assert.match(result.line, /workerQueueHead=normal\/current\/overdue\/5s/);
            assert.doesNotMatch(result.line, /workerDue=/);
        });
        await check('actual status distinguishes stale alarm, empty and unknown', () => {
            sample = { queueHead: { kind: 'alarm', dueAt: 123, overdue: true, ageMs: 7000, current: false } };
            assert.match(Status.summary().line, /workerQueueHead=alarm\/stale\/overdue\/7s/);
            sample = { queueHead: { kind: 'empty', dueAt: null, overdue: false, ageMs: 0, current: false } };
            assert.match(Status.summary().line, /workerQueueHead=empty(?:\s|$)/);
            sample = {};
            assert.match(Status.summary().line, /workerQueueHead=unknown(?:\s|$)/);
            assert.doesNotMatch(Status.summary().line, /workerDue=/);
        });
        await check('actual load report retains exact queue head and snapshot pressure', async () => {
            const head = { kind: 'alarm', dueAt: 123, overdue: true, ageMs: 7000, current: false };
            const row = await measured(head);
            assert.equal(row.queueHead, head);
            assert.equal(Object.hasOwn(row, 'scheduled'), false); assert.equal(Object.hasOwn(row, 'dueAgeMs'), false);
        });
        await check('actual load report keeps absent head explicitly unknown', async () => {
            const row = await measured(); assert.equal(row.queueHead, null);
            assert.equal(Object.hasOwn(row, 'scheduled'), false); assert.equal(Object.hasOwn(row, 'dueAgeMs'), false);
        });
        await check('actual readiness log names queue kind and unknown without a due count', async () => {
            const coordinator = new ColdSimulationCoordinator(), logs = [];
            coordinator.worker = {}; coordinator.workerEpoch = 'queue-head-reader';
            utils.infoSuccess = (channel, ...args) => { logs.push({ channel, text: format(...args) }); };
            for (const head of [{ kind: 'alarm', dueAt: 123, overdue: true, ageMs: 7000, current: false }, undefined]) {
                const payload = { phase: 'snapshots_loaded', states: 13,
                    ...(head === undefined ? {} : { queueHead: head }) };
                await coordinator.onMessage(Protocol.envelope('ready', coordinator.workerEpoch, payload),
                    coordinator.worker, coordinator.workerEpoch);
                assert.equal(coordinator.snapshotsLoaded, true);
                assert.equal(coordinator.lastWorkerSnapshot, payload);
                assert.equal(logs.at(-1).channel, 'ColdWorker');
                assert.match(logs.at(-1).text, /states=13/);
                assert.match(logs.at(-1).text, head ? /queueHead=alarm/ : /queueHead=unknown/);
                assert.doesNotMatch(logs.at(-1).text, /due=/);
            }
        });
        assert.equal(Database.isReady(), false);
        assert.equal(failures.length, 0, failures.join(', '));
        console.log('Cold queue-head consumer contracts: PASS');
    } finally {
        Coordinator.snapshot = original.snapshot; Observer.snapshotJson = original.json;
        Observer.snapshotCacheStats = original.cache; LoadTest.finish = original.finish;
        LoadTest.playerSession = original.player;
        utils.infoSuccess = original.infoSuccess;
        global.setInterval = original.interval; global.setTimeout = original.timeout;
        global.clearInterval = original.clearInterval; global.clearTimeout = original.clearTimeout;
        Coordinator.setPauseReason('mixed_load_warmup', false);
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
