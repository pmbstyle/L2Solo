'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
const epoch = 'developer-observation-probe';
const workerPath = path.resolve(__dirname, '../src/GameServer/Bot/Population/ColdSimulationWorker.js');
// Execute a real imported producer after native init, then observe the native
// worker transport and heartbeat. A detached test-only collector would miss it.
const wrapper = `
    const {parentPort,workerData}=require('node:worker_threads');
    require(workerData.workerPath);
    parentPort.on('message', message => {
        if (message.type !== 'init') return;
        const root=require('node:path').resolve(require('node:path').dirname(workerData.workerPath),'..');
        const {WishNetwork}=require(root+'/Economy/WishNetwork');
        const engine=new WishNetwork();
        const input={actorKey:'character:17',characterId:17,inputKey:'bag:1',roots:[],nodes:[]};
        engine.build(input);engine.build(input);
    });`;
const worker = new Worker(wrapper, { eval: true,
    workerData: { workerPath, workerEpoch: epoch, developerDiagnostics: true },
    env: { ...process.env, L2NODE_CONFIG_FILE: 'config/default.ini' } });
let nativeRows = [];
const timer = setTimeout(() => {
    worker.terminate(); console.error('observation heartbeat timeout'); process.exitCode = 1;
}, 30000);
worker.on('error', error => { clearTimeout(timer); console.error(error); process.exitCode = 1; });
worker.on('message', async message => {
    try {
        if (message.type === 'fault') throw Error(JSON.stringify(message.payload));
        if (message.type === 'ready' && message.payload.phase === 'loaded') {
            worker.postMessage(Protocol.envelope('init', epoch, { config: {
                developerDiagnostics: true, economyDiagnostics: true,
                economyDiagnosticsBotIds: '17', loopIntervalMs: 1000,
            } }, 'init'));
        }
        if (message.type === 'economy_diagnostics') {
            assert.equal(message.epoch, epoch);
            assert(Buffer.byteLength(JSON.stringify(message)) <= 16384);
            nativeRows.push(...message.records.map(JSON.parse));
            worker.postMessage({ type: 'economy_diagnostics_ack', epoch,
                id: message.id, accepted: message.records.length });
        }
        if (message.type === 'heartbeat') {
            const metrics = message.payload.developerDiagnostics;
            assert.equal(metrics.thread, 'worker');
            assert.equal(metrics.counts['network:request:unknown'], 2);
            assert.equal(metrics.counts['network:build:unknown'], 1);
            assert.equal(metrics.counts['network:hit:same_inputs'], 1);
            assert.equal(metrics.durations.network.count, 1);
            assert(nativeRows.some(row => row.owner === 17 && row.phase === 'wish_activity' && row.thread === 'worker'),
                'real wish records reach the native worker transport');
            assert.equal(metrics.detail.acceptedByMain, nativeRows.length);
            assert.equal(metrics.detail.queued, 0);
            console.log('Native worker shares its producer collector: real wish rows, aggregate counts and admission ACK arrive');
            clearTimeout(timer); await worker.terminate();
        }
    } catch (error) {
        clearTimeout(timer); console.error(error); process.exitCode = 1; await worker.terminate();
    }
});
