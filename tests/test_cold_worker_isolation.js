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
    worker.postMessage(message('init', 'init', { config: { heartbeatMs: 100, loopIntervalMs: 10, pvpAggression: 0 } }));
    while (!messages.some((entry) => entry.type === 'ready' && entry.payload.phase === 'running')) {
        if (Date.now() > deadline) throw new Error('worker_init_timeout');
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.strictEqual(messages.find(entry => entry.type === 'ready' && entry.payload.phase === 'running').payload.pvpAggression,
        0, 'the main process override must reach the real worker, including zero');
    worker.postMessage(message('shutdown', 'shutdown'));
    while (!messages.some((entry) => entry.type === 'drained')) {
        if (Date.now() > deadline) throw new Error('worker_shutdown_timeout');
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await worker.terminate();
    // The worker's EffectStore is a stub: every member the cold rules call
    // must be on it (T136: PetHealRule.choose called impairments, a live fault).
    const fs = require('fs');
    const src = path.resolve(__dirname, '../src/GameServer');
    const callers = [path.join(src, 'Bot/AI/PetHealRule.js'),
        ...fs.readdirSync(path.join(src, 'Bot/Population')).map(file => path.join(src, 'Bot/Population', file))];
    const workerSource = fs.readFileSync(workerPath, 'utf8');
    const stub = workerSource.slice(workerSource.indexOf("['GameServer/Effects/EffectStore'"), workerSource.indexOf("['GameServer/Skills/ChargeLifecycle'"));
    for (const file of callers.filter(file => file.endsWith('.js') && file !== workerPath)) {
        const text = fs.readFileSync(file, 'utf8');
        const local = text.match(/const (\w+)\s*=\s*invoke\('GameServer\/Effects\/EffectStore'\)/)?.[1];
        if (!local) continue;
        for (const [, member] of text.matchAll(new RegExp(`\\b${local}\\.(\\w+)`, 'g')))
            assert(new RegExp(`\\b${member}\\s*:`).test(stub), `the worker's EffectStore stub lacks ${member} (${path.basename(file)})`);
    }
    console.log('Cold worker dependency isolation and graceful drain checks passed');
})().catch(async (error) => {
    console.error(error);
    process.exitCode = 1;
    await worker.terminate().catch(() => null);
});
