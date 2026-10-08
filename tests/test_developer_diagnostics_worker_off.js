'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
const epoch = 'developer-off-probe';
const workerPath = path.resolve(__dirname, '../src/GameServer/Bot/Population/ColdSimulationWorker.js');
const wrapper = `const hooks = require('node:perf_hooks');
    hooks.monitorEventLoopDelay = () => { throw Error('off created delay histogram'); };
    hooks.PerformanceObserver = class { constructor() { throw Error('off created GC observer'); } };
    require(require('node:worker_threads').workerData.workerPath);`;
const worker = new Worker(wrapper, { eval: true, workerData: { workerPath, workerEpoch: epoch, developerDiagnostics: false },
    env: { ...process.env, BOT_DEVELOPER_DIAGNOSTICS: 'true', L2NODE_CONFIG_FILE: 'config/default.ini' } });
const timer = setTimeout(() => { worker.terminate(); console.error('off heartbeat timeout'); process.exitCode = 1; }, 30000);
worker.on('error', error => { clearTimeout(timer); console.error(error); process.exitCode = 1; });
worker.on('message', async message => {
    try {
        assert.notEqual(message.type, 'economy_diagnostics', 'off starts no diagnostic IPC');
        if (message.type === 'fault') throw Error(JSON.stringify(message.payload));
        if (message.type === 'ready' && message.payload.phase === 'loaded') {
            worker.postMessage(Protocol.envelope('init', epoch, { config: { developerDiagnostics: false,
                economyDiagnostics: true, loopIntervalMs: 1000 } }, 'init'));
        }
        if (message.type === 'heartbeat') {
            assert.equal(message.payload.paused, false, 'runtime kernel remains alive');
            for (const key of ['heapUsed','rss','heapAfterGc','eventLoopUtilization','eventLoopLagP95Ms','tables','occupationPlanning','developerDiagnostics']) {
                assert.equal(message.payload[key], undefined, `${key} absent while disabled`);
            }
            assert.equal(message.payload.diagnosticsEnabled, false);
            console.log('Native off worker preserves runtime heartbeat without observers, diagnostic IPC or false measurements');
            clearTimeout(timer); await worker.terminate();
        }
    } catch (error) { clearTimeout(timer); console.error(error); process.exitCode = 1; await worker.terminate(); }
});
