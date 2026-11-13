process.env.BOT_DEVELOPER_DIAGNOSTICS = 'true'; // This fixture inspects optional developer metrics.
const assert = require('assert');
const { EventEmitter } = require('events');
const path = require('path');
const { Worker } = require('worker_threads');

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

    // A crashed worker is logged and its slot respawns forever: at once on the
    // first crash in a row, then after the shared worker backoff (1, 2, 5, 10,
    // then 30 s). Queued work waits for the respawn; only the crashed task fails.
    const { mock } = require('node:test');
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
    let warnings = 0;
    const infoWarn = utils.infoWarn;
    utils.infoWarn = () => { warnings += 1; };
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
    const pathOf = async (index, startX) => {
        const pending = recoveryPool.request({ startX }, { key: `npc:${startX}`, timeoutMs: 60000 });
        const message = recoveryWorkers[index].messages.at(-1);
        recoveryWorkers[index].emit('message', { id: message.id, ok: true, path: [{ locX: startX }] });
        return pending;
    };
    try {
        const failed = recoveryPool.request({ startX: 6 }, { key: 'npc:6', timeoutMs: 60000 }).catch((error) => error);
        const waiting = recoveryPool.request({ startX: 7 }, { key: 'npc:7', timeoutMs: 60000 });
        recoveryWorkers[0].emit('error', new Error('synthetic worker failure'));
        assert.strictEqual((await failed).message, 'synthetic worker failure', 'worker errors must reject the affected request');
        assert.strictEqual(warnings, 1, 'each crash is logged');
        mock.timers.tick(0);
        assert.strictEqual(recoveryWorkers.length, 2, 'the first crash in a row respawns at once');
        const queued = recoveryWorkers[1].messages[0];
        recoveryWorkers[1].emit('message', { id: queued.id, ok: true, path: [{ locX: 7 }] });
        assert.deepStrictEqual(await waiting, [{ locX: 7 }], 'work queued during the respawn runs on the new worker');
        for (const [index, delay] of [[1, 1000], [2, 2000], [3, 5000], [4, 10000], [5, 30000], [6, 30000]]) {
            recoveryWorkers[index].emit('exit', 1);
            mock.timers.tick(delay - 1);
            assert.strictEqual(recoveryWorkers.length, index + 1, `crash ${index + 1} in a row waits ${delay} ms`);
            mock.timers.tick(1);
            assert.strictEqual(recoveryWorkers.length, index + 2, 'a crashing slot is never given up');
        }
        assert.deepStrictEqual(await pathOf(7, 8), [{ locX: 8 }], 'a replacement worker must accept subsequent paths');
        assert.deepStrictEqual([recoveryPool.stats().crashes, recoveryPool.stats().respawns, warnings], [7, 7, 7]);
        mock.timers.tick(30001);
        recoveryWorkers[7].emit('exit', 1);
        mock.timers.tick(0);
        assert.strictEqual(recoveryWorkers.length, 9, 'a slot up 30 s was healthy: its next crash respawns at once');
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

        // A Rune town corridor whose search is several times one 150 ms
        // worker turn: it continues over turns instead of failing.
        const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');
        const giran = { startX: 83384, startY: 149256, startZ: -3400, goalRadius: 64, townCorridor: true };
        const rune = { startX: 38208, startY: -48048, startZ: 896, goalRadius: 64, townCorridor: true };
        const longCorridor = { ...rune, endX: 44704, endY: -47472, endZ: -792, maxNodes: 150000,
            navigationRevision: GeodataEngine.navigationRevision || 0 };
        const workBefore = realPool.stats().workerMs;
        const corridor = await realPool.request(longCorridor, { key: 'town:long', timeoutMs: 15000 }).catch((error) => error);
        const charged = realPool.stats().workerMs - workBefore;
        await realPool.shutdown();
        assert(corridor.path?.length >= 2 && corridor.lanes?.length === 8,
            `a town corridor longer than one worker turn must return its path and every lane (${corridor.code})`);
        assert(charged > 150, 'the pool must be charged the search work of every turn, not only the last');

        // A search cancelled after its first turn. An unreachable goal keeps
        // the search running (maxNodes) far past the moment it is stopped.
        const worker = new Worker(path.join(__dirname, '../src/GameServer/Geodata/PathfindingWorker.js'),
            { workerData: { sharedGeodata: GeodataEngine.sharedDescriptor() } });
        try {
            const replies = [];
            let wake = null;
            worker.on('message', (reply) => { replies.push(reply); wake?.(); });
            const reply = async (id) => {
                for (;;) {
                    const found = replies.find((message) => message.id === id);
                    if (found) return found;
                    await new Promise((resolve) => { wake = resolve; });
                }
            };
            const send = (id, request, cancelFlag = null) => worker.postMessage({ type: 'path', id, request,
                cancelBuffer: cancelFlag?.buffer });
            const unreachable = { ...giran, endX: 117000, endY: 76000, endZ: -2700, maxNodes: 300000, navigationRevision: 1 };
            const local = { ...giran, endX: 83384, endY: 149256, endZ: -3400, maxNodes: 32 };
            send(1, { ...local, navigationRevision: 1 });
            assert.strictEqual((await reply(1)).ok, true, 'the worker must answer once it is up');

            const cancelFlag = new Int32Array(new SharedArrayBuffer(4));
            send(2, unreachable, cancelFlag);
            await new Promise((resolve) => setTimeout(resolve, 250));
            Atomics.store(cancelFlag, 0, 1);
            const cancelled = await reply(2);
            assert.strictEqual(cancelled.code, 'STALE_PATH', 'a search cancelled after its first turn must end as stale');

            assert.deepStrictEqual(replies.map((message) => message.id), [1, 2],
                'each request must be answered once under its own id');
        } finally {
            await worker.terminate();
        }
    }
    console.log('Pathfinding worker pool checks passed');
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
