'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
if (!process.argv.includes('--gc-child')) {
    const result = spawnSync(process.execPath, [...process.execArgv, '--expose-gc', __filename, '--gc-child'],
        { env: { ...process.env, L2NODE_CONFIG_FILE: 'config/default.ini', L2NODE_SHARED_CONFIG_FILE: '' }, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    process.stdout.write(result.stdout);
} else {
    const { Worker } = require('node:worker_threads');
    const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
    const Telemetry = require('../src/GameServer/Bot/Population/WorkerHeapTelemetry');
    const window = new Telemetry.MajorGcHeap();
    window.record(300, 0); window.record(100, 1000); window.record(200, 2000);
    assert.deepEqual(window.snapshot(5000), { heapAfterGc: 200, heapAfterGcMax10: 300 });
    assert.deepEqual(window.snapshot(Telemetry.WINDOW_MS + 1), { heapAfterGc: 200, heapAfterGcMax10: 200 });
    assert.deepEqual(window.snapshot(Telemetry.WINDOW_MS + 2001), { heapAfterGc: 200, heapAfterGcMax10: 0 });
    const workerPath = path.resolve(__dirname, '../src/GameServer/Bot/Population/ColdSimulationWorker.js');
    const wrapper = `const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
      const {parentPort,workerData}=require('node:worker_threads');
      const loaded=new Module(workerData.workerPath,module);loaded.filename=workerData.workerPath;
      loaded.paths=Module._nodeModulePaths(path.dirname(workerData.workerPath));
      loaded._compile(fs.readFileSync(workerData.workerPath,'utf8')+'\\nmodule.exports.forceHeapProbe=()=>global.gc();',workerData.workerPath);
      parentPort.on('message', message=>{if(message.heapProbe){loaded.exports.forceHeapProbe();parentPort.postMessage({probeDone:true});}});`;
    const epoch = 'heap-gc-native';
    const worker = new Worker(wrapper, { eval: true, workerData: { workerPath, workerEpoch: epoch } });
    let requested = false, probed = false;
    const timer = setTimeout(() => { console.error('native GC heartbeat timeout'); worker.terminate(); process.exitCode = 1; }, 20000);
    worker.on('error', error => { clearTimeout(timer); console.error(error); process.exitCode = 1; });
    worker.on('message', message => {
        if (message.type === 'ready' && message.payload.phase === 'loaded') {
            worker.postMessage(Protocol.envelope('init', epoch, { config: { loopIntervalMs: 1000 } }, 'init'));
        }
        if (message.type === 'ready' && message.payload.phase === 'running' && !requested) {
            requested = true; worker.postMessage({ ...Protocol.envelope('pause', epoch, {}, 'probe'), heapProbe: true });
        }
        if (message.probeDone) probed = true;
        if (message.type === 'heartbeat' && probed && message.payload.heapAfterGc > 0) {
            try {
                assert(Number.isFinite(message.payload.heapAfterGc));
                assert(message.payload.heapAfterGcMax10 >= message.payload.heapAfterGc);
                console.log('Actual cold-worker heartbeat carries major-GC heap and ten-minute maximum');
            } finally { clearTimeout(timer); worker.terminate(); }
        }
    });
}
