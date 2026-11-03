'use strict';

const assert = require('node:assert/strict');
const Telemetry = require('../src/GameServer/Bot/Population/WorkerHeapTelemetry');

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
again.close();
console.log('test_worker_heap_telemetry_handles passed');
