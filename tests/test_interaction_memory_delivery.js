const assert = require('assert');
const Memory = require('../src/GameServer/Social/InteractionMemory');
const Policy = require('../src/GameServer/Social/InteractionMemoryPolicy');
const Queue = require('../src/GameServer/Social/InteractionEventQueue');

(async () => {
    const reads = [];
    let finish;
    const memory = new Memory({ loadMany: ids => {
        reads.push(ids);
        return new Promise(resolve => { finish = () => resolve(ids.map(Policy.empty)); });
    } });
    const first = memory.ensureMany([1, 2]);
    const overlapping = memory.ensureMany([2]);
    const single = memory.load(1);
    finish();
    await Promise.all([first, overlapping]);
    assert.strictEqual((await single).ownerId, 1);
    await memory.ensureMany([1, 2]);
    assert.strictEqual(reads.length, 1, 'hydrate once and coalesce overlapping requests');
    const pageSizes = [];
    const population = new Memory({ loadMany: async ids => { pageSizes.push(ids.length); return ids.map(Policy.empty); } });
    await population.ensureMany(Array.from({ length: 130 }, (_, i) => i + 1));
    assert.deepStrictEqual(pageSizes, [64, 64, 2]);
    let attempts = 0;
    const recovery = new Memory({ loadMany: async ids => {
        if (!attempts++) throw new Error('database unavailable');
        return ids.map(Policy.empty);
    } });
    await assert.rejects(recovery.ensureMany([1]), /unavailable/);
    await recovery.ensureMany([1]);
    assert(recovery.inspect(1).ready);
    const pendingLoads = new Map();
    const raced = new Memory({ loadMany: ids => new Promise((resolve, reject) => pendingLoads.set(ids[0], { resolve, reject })) });
    const failedLoad = assert.rejects(raced.ensureMany([1]), /unavailable/);
    const mixedLoad = assert.rejects(raced.ensureMany([1, 2]), /unavailable/);
    pendingLoads.get(1).reject(new Error('unavailable'));
    await failedLoad;
    pendingLoads.get(2).resolve([Policy.empty(2)]);
    await mixedLoad;
    assert.strictEqual(raced.inspect(1).ready, false, 'a failed overlapping load cannot report readiness');

    const at = Date.now();
    const event = { key: 'episode:retry', sourceId: 1, targetId: 2, type: 'mob_contested', at };
    let busy = true, writes = [];
    const queue = new Queue({ recordBatch: async batch => {
        writes.push(batch);
        return busy ? { ok: false, reason: 'memory_busy' } : { ok: true };
    } });
    queue.enqueue(event);
    event.targetId = 3;
    await queue.flush();
    assert.strictEqual(queue.snapshot().pending, 1);
    busy = false;
    await queue.flush();
    assert.deepStrictEqual(writes[0], writes[1], 'retry must retain original key, time and participants');
    assert.strictEqual(writes[1][0].targetId, 2);
    assert.strictEqual(queue.snapshot().pending, 0);
    for (let i = 0; i < 1024; i++) assert(queue.enqueue({ ...event, key: `capacity:${i}` }));
    assert.strictEqual(queue.enqueue({ ...event, key: 'overflow' }), false);
    const drained = await queue.drain();
    assert(drained.drained);
    assert.strictEqual(queue.enqueue(event), false, 'shutdown fences new episodes');
    const expired = new Queue({ recordBatch: async () => { throw new Error('should not write'); } });
    expired.enqueue({ ...event, at: at - Policy.ACCEPT_WINDOW_MS - 1000 });
    await expired.flush();
    assert.strictEqual(expired.snapshot().expired, 1);
    for (const alreadyRunning of [false, true]) {
        for (const outcome of ['success', 'busy', 'error']) {
            let clock = at, attempts = 0, completeWrite;
            const slow = new Queue({ recordBatch: () => {
                attempts++;
                return new Promise((resolve, reject) => {
                    completeWrite = () => {
                        clock += 11;
                        if (outcome === 'error') reject(new Error('SQLITE_BUSY'));
                        else resolve(outcome === 'success' ? { ok: true } : { ok: false, reason: 'memory_busy' });
                    };
                });
            } }, { now: () => clock });
            for (let i = 0; i < 3; i++) slow.enqueue({ ...event, key: `deadline:${i}` });
            const active = alreadyRunning ? slow.flush() : null;
            const shutdown = slow.drain(10);
            assert.strictEqual(attempts, 1);
            completeWrite();
            const result = await shutdown;
            if (active) await active;
            assert.strictEqual(attempts, 1, `${outcome}, alreadyRunning=${alreadyRunning}: no new write after deadline`);
            assert.strictEqual(result.drained, false);
            assert.strictEqual(result.pending, outcome === 'success' ? 2 : 3, 'unwritten episodes must remain pending');
            assert.strictEqual(slow.running, null, 'drain must await the active write');
            assert.strictEqual(slow.timer, null, 'shutdown must not schedule retries');
        }
    }
    console.log('Interaction memory hydration, bounded delivery, retry and shutdown checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
