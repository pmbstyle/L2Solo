'use strict';

const assert = require('node:assert/strict');
const Telemetry = require('../src/GameServer/Bot/Population/WorkerHeapTelemetry');

(async () => {
    // One major-GC observer per isolate, a handle per owner (PopulationMetrics, the cold worker, the perf
    // live recorder): closing one handle keeps the window the others read; the last one closes it.
    // heapRecord() carries afterGc while a window is open, and not at all once none is.
    assert.equal('afterGc' in Telemetry.heapRecord(), false, 'no handle: no window');
    const metrics = Telemetry.observe();
    const recorder = Telemetry.observe();
    assert.equal(metrics.window, recorder.window, 'both read the one window');
    assert.equal('afterGc' in Telemetry.heapRecord(), true);
    metrics.close();
    metrics.close();
    assert.equal('afterGc' in Telemetry.heapRecord(), true, 'the recorder keeps the window after the metrics handle closed (twice)');
    recorder.close();
    assert.equal('afterGc' in Telemetry.heapRecord(), false, 'the last handle closed the observer');
    const again = Telemetry.observe();
    assert.notEqual(again.window, metrics.window, 'a new observe after all closed starts a new window');
    // GC pauses by kind are summed only for a handle that asks for them (the perf recorder), cumulative.
    assert.equal(again.pauses(), null, 'a handle without pauses reads none');
    const garbage = () => { let kept = null; for (let i = 0; i < 200000; i++) kept = { i, text: `garbage ${i}` }; return kept; };
    garbage();
    await new Promise(resolve => setTimeout(resolve, 20));
    const pauses = Telemetry.observe({ pauses: true });
    assert.deepEqual(pauses.pauses(), {}, 'counted from the first pauses handle, not before');
    garbage();
    await new Promise(resolve => setTimeout(resolve, 20));
    const first = pauses.pauses();
    assert.ok(first.minor?.count > 0, `scavenges counted: ${JSON.stringify(first)}`);
    again.close();
    garbage();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(pauses.pauses().minor.count > first.minor.count, 'cumulative, and kept when another handle closes');
    pauses.close();
    console.log('test_worker_heap_telemetry_handles passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
