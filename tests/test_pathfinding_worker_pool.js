process.env.BOT_DEVELOPER_DIAGNOSTICS = 'true'; // This fixture inspects optional developer metrics.
const assert = require('assert');
const { EventEmitter } = require('events');

require('../src/Global');
invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics = true;

const PoolSingleton = invoke('GameServer/Geodata/PathfindingWorkerPool');
const { BoundedPathfindingWorkerPool } = PoolSingleton;

class FakeWorker extends EventEmitter {
    constructor() {
        super();
        this.messages = [];
        this.terminated = false;
    }

    postMessage(message) {
        this.messages.push(message);
    }

    terminate() {
        this.terminated = true;
        return Promise.resolve(0);
    }
}

async function run() {
    const workers = [];
    const pool = new BoundedPathfindingWorkerPool({
        size: 1,
        queueLimit: 1,
        workerFactory: () => {
            const worker = new FakeWorker();
            workers.push(worker);
            return worker;
        }
    });

    const first = pool.request({ startX: 1 }, { key: 'npc:1', timeoutMs: 5000 });
    const firstId = workers[0].messages[0].id;
    const stale = first.then(
        () => null,
        (error) => error
    );
    const second = pool.request({ startX: 2 }, { key: 'npc:1', timeoutMs: 5000 });
    assert.strictEqual((await stale).code, 'STALE_PATH', 'a newer NPC path must cancel the stale caller immediately');
    assert.strictEqual(Atomics.load(new Int32Array(workers[0].messages[0].cancelBuffer), 0), 1,
        'cancelling a running request must signal the worker, not merely reject its Promise');

    workers[0].emit('message', { id: firstId, ok: true, path: [{ locX: 1 }] });
    const secondMessage = workers[0].messages[1];
    workers[0].emit('message', { id: secondMessage.id, ok: true, path: [{ locX: 2 }] });
    assert.deepStrictEqual(await second, [{ locX: 2 }], 'the latest path result must be delivered in order');

    const third = pool.request({ startX: 3 }, { key: 'npc:2', timeoutMs: 5000 });
    const overflow = pool.request({ startX: 4 }, { key: 'npc:3', timeoutMs: 5000 });
    const rejected = pool.request({ startX: 5 }, { key: 'npc:4', timeoutMs: 5000 }).catch((error) => error);
    assert.strictEqual((await rejected).code, 'QUEUE_FULL', 'bounded path queues must reject excess work');

    await pool.shutdown();
    assert.strictEqual((await third.catch((error) => error)).code, 'POOL_SHUTDOWN', 'shutdown must reject in-flight work');
    assert.strictEqual((await overflow.catch((error) => error)).code, 'POOL_SHUTDOWN', 'shutdown must reject queued work');
    assert.strictEqual(workers[0].terminated, true, 'shutdown must terminate workers');

    const priorityWorkers = [];
    const priorityPool = new BoundedPathfindingWorkerPool({
        size: 1,
        queueLimit: 1,
        workerFactory: () => {
            const worker = new FakeWorker();
            priorityWorkers.push(worker);
            return worker;
        }
    });
    const busy = priorityPool.request({ startX: 10 }, { key: 'npc:10', timeoutMs: 5000 });
    const background = priorityPool.request({ startX: 11 }, { key: 'npc:11', timeoutMs: 5000 }).catch((error) => error);
    const companion = priorityPool.request({ startX: 12 }, { key: 'companion:12', priority: 100, timeoutMs: 5000 });
    assert.strictEqual((await background).code, 'PATH_PREEMPTED', 'interactive companion work must preempt queued background A*');
    assert.strictEqual(priorityPool.stats().companionQueue, 1, 'pool telemetry must expose queued companion work separately');
    priorityWorkers[0].emit('message', { id: priorityWorkers[0].messages[0].id, ok: true, path: [{ locX: 10 }] });
    assert.strictEqual(priorityPool.stats().companionBusy, 1, 'pool telemetry must expose active companion work separately');
    priorityWorkers[0].emit('message', { id: priorityWorkers[0].messages[1].id, ok: true, path: [{ locX: 12 }] });
    await Promise.all([busy, companion]);
    assert.strictEqual(priorityPool.stats().preempted, 1);
    await priorityPool.shutdown();

    // A crashed worker is logged, its slot respawns after the shared worker
    // backoff (1, 2, 5, 10, then 30 s), forever; while no slot is up the pool
    // refuses requests, counted.
    const { mock } = require('node:test');
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
    const warnings = [], infoWarn = utils.infoWarn;
    utils.infoWarn = (prefix, ...params) => warnings.push(require('util').format(...params));
    const recoveryWorkers = [];
    const recoveryPool = new BoundedPathfindingWorkerPool({
        size: 1,
        queueLimit: 2,
        workerFactory: () => {
            const worker = new FakeWorker();
            recoveryWorkers.push(worker);
            return worker;
        }
    });
    try {
        const failed = recoveryPool.request({ startX: 6 }, { key: 'npc:6', timeoutMs: 5000 }).catch((error) => error);
        recoveryWorkers[0].emit('error', new Error('synthetic worker failure'));
        assert.strictEqual((await failed).message, 'synthetic worker failure', 'worker errors must reject the affected request');
        assert.match(warnings[0], /path worker 0 crashed \(Error: synthetic worker failure\); restarting in 1000ms, 1 in a row/);
        assert.match(warnings[0], /at /, 'the first crash of a reason carries its stack');
        const down = await recoveryPool.request({ startX: 7 }, { key: 'npc:7' }).catch((error) => error);
        assert.strictEqual(down.code, 'WORKER_UNAVAILABLE', 'no slot is up during the backoff');
        mock.timers.tick(1000);
        assert.strictEqual(recoveryWorkers.length, 2, 'the slot respawns after the first delay');
        for (const [index, delay] of [[1, 2000], [2, 5000], [3, 10000], [4, 30000], [5, 30000]]) {
            recoveryWorkers[index].emit('exit', 1);
            assert.match(warnings.at(-1), new RegExp(`WORKER_EXIT: path worker exited with code 1\\); restarting in ${delay}ms`));
            mock.timers.tick(delay);
            assert.strictEqual(recoveryWorkers.length, index + 2, 'a crashing slot is never given up');
        }
        assert.strictEqual(warnings.filter((line) => line.includes('\n')).length, 2, 'the stack once per reason');
        const recovered = recoveryPool.request({ startX: 8 }, { key: 'npc:8', timeoutMs: 5000 });
        const recoveredMessage = recoveryWorkers[6].messages[0];
        recoveryWorkers[6].emit('message', { id: recoveredMessage.id, ok: true, path: [{ locX: 8 }] });
        assert.deepStrictEqual(await recovered, [{ locX: 8 }], 'a replacement worker must accept subsequent paths');
        assert.deepStrictEqual([recoveryPool.stats().crashes, recoveryPool.stats().respawns, recoveryPool.stats().refusedDown], [6, 6, 1]);
        mock.timers.tick(30001);
        recoveryWorkers[6].emit('exit', 1);
        assert.match(warnings.at(-1), /restarting in 1000ms, 1 in a row, 7 since start/, 'a slot up 30 s was healthy: back to the first delay');
    } finally {
        await recoveryPool.shutdown();
        utils.infoWarn = infoWarn;
        mock.timers.reset();
    }

    const budgetWorkers = [];
    const budgetPool = new BoundedPathfindingWorkerPool({ size: 1, queueLimit: 4,
        workerFactory: () => { const worker = new FakeWorker(); budgetWorkers.push(worker); return worker; } });
    const townFirst = budgetPool.request({ townCorridor: true }, { key: 'town:1', priority: 50 });
    const townSecond = budgetPool.request({ townCorridor: true }, { key: 'town:2', priority: 50 });
    budgetWorkers[0].emit('message', { id: budgetWorkers[0].messages[0].id, ok: true, path: [], workerMs: 100 });
    await townFirst;
    assert.strictEqual(budgetWorkers[0].messages.length, 1, 'town work must defer when its aggregate worker budget is spent');
    const interactive = budgetPool.request({}, { key: 'companion:urgent', priority: 100 });
    assert.strictEqual(budgetWorkers[0].messages.length, 2, 'player companion work must bypass decorative town admission');
    budgetWorkers[0].emit('message', { id: budgetWorkers[0].messages[1].id, ok: true, path: [] });
    await interactive;
    budgetPool.townWindowAt = Date.now() - 1000;
    budgetPool.dispatch();
    assert.strictEqual(budgetWorkers[0].messages.length, 3, 'deferred town work must resume in the next budget window');
    budgetWorkers[0].emit('message', { id: budgetWorkers[0].messages[2].id, ok: true, path: [] });
    await townSecond;
    await budgetPool.shutdown();

    if (process.env.L2NODE_SKIP_RAW_GEODATA_TESTS !== '1') {
        const realPool = new BoundedPathfindingWorkerPool({ size: 1, queueLimit: 2 });
        const realPath = await realPool.request({
            startX: 53027,
            startY: 102938,
            startZ: -1064,
            endX: 53027,
            endY: 102938,
            endZ: -1064,
            maxNodes: 32
        }, { key: 'integration:1', timeoutMs: 15000 });
        assert.deepStrictEqual(realPath, [{ locX: 53027, locY: 102938, locZ: -1064 }],
            'the real worker boundary must return a structured-clone-safe geodata path');
        await realPool.shutdown();
    }
    console.log('Pathfinding worker pool checks passed');
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
