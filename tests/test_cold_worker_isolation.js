const assert = require('assert');
const path = require('path');
const { Worker } = require('worker_threads');

const workerPath = path.resolve(__dirname, '../src/GameServer/Bot/Population/ColdSimulationWorker.js');
const epoch = 'isolation-test';
const worker = new Worker(workerPath, {
    workerData: { workerEpoch: epoch },
    resourceLimits: { maxOldGenerationSizeMb: 256 }
});

function message(type, msgId, payload = {}) {
    return { version: 1, type, msgId, workerEpoch: epoch, sentAt: Date.now(), payload };
}

(async () => {
    const messages = [];
    worker.on('message', (entry) => messages.push(entry));
    const deadline = Date.now() + 15000;
    while (!messages.some((entry) => entry.type === 'ready' && entry.payload.phase === 'loaded')) {
        if (Date.now() > deadline) throw new Error('worker_load_timeout');
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const loaded = messages.find((entry) => entry.payload.phase === 'loaded');
    assert.strictEqual(loaded.payload.forbiddenDependencies, 0, 'worker must not load Database, World, BotManager, or network modules');
    worker.postMessage(message('init', 'init', { config: { heartbeatMs: 100, loopIntervalMs: 10 } }));
    while (!messages.some((entry) => entry.type === 'ready' && entry.payload.phase === 'running')) {
        if (Date.now() > deadline) throw new Error('worker_init_timeout');
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    worker.postMessage(message('shutdown', 'shutdown'));
    while (!messages.some((entry) => entry.type === 'drained')) {
        if (Date.now() > deadline) throw new Error('worker_shutdown_timeout');
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await worker.terminate();
    console.log('Cold worker dependency isolation and graceful drain checks passed');
})().catch(async (error) => {
    console.error(error);
    process.exitCode = 1;
    await worker.terminate().catch(() => null);
});
