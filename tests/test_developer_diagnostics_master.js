'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const Metrics = invoke('GameServer/Bot/Population/PopulationMetrics');
assert.equal(Config.developerDiagnostics, false, 'developer diagnostics default off');
Metrics.startEventLoopMonitor();
assert(Metrics.timer, 'runtime lag sampler stays enabled for governor');
assert.equal(Metrics.delayHistogram, null, 'off creates no optional event-loop histogram');
const counters = JSON.stringify(Metrics.counters);
Metrics.recordResolveDuration(50);
Metrics.recordBackgroundResolve();
assert.equal(JSON.stringify(Metrics.counters), counters);
assert.equal(Metrics.interval.resolveDurationsMs.length, 0);
assert.deepEqual(Metrics.snapshot(), { enabled: false });
Metrics.recordSchedulerProfile({ budgetMs: 12, lagMs: 30 });
assert.equal(Metrics.schedulerState.lagMs, 30, 'runtime pressure remains available');
Metrics.stopEventLoopMonitor();
Config.developerDiagnostics = true;
Metrics.recordBackgroundResolve();
assert.equal(Metrics.counters.backgroundResolves, 1);
Metrics.recordResolveDuration(50);
assert.equal(Metrics.interval.resolveDurationsMs.length, 1);
Config.developerDiagnostics = false;
const { DiagnosticMetricMap } = require('../src/GameServer/Bot/Population/DiagnosticMetricMap');
const map = new DiagnosticMetricMap();
for (let id = 0; id < 100; id++) map.set('reason-' + id, (map.get('reason-' + id) || 0) + 1);
assert.equal(map.size, 64);
assert.equal(map.get('other'), 37, 'overflow preserves total counts in a visible bucket');
const { MajorGcHeap, MAX_SAMPLES, WINDOW_MS } = require('../src/GameServer/Bot/Population/WorkerHeapTelemetry');
const heap = new MajorGcHeap();
for (let index = 0; index < MAX_SAMPLES + 5; index++) heap.record(MAX_SAMPLES + 5 - index, index);
assert(heap.maxima.length - heap.head <= MAX_SAMPLES);
assert.equal(heap.snapshot(MAX_SAMPLES + 6).heapGcDropped, 5);
assert.equal(heap.snapshot(MAX_SAMPLES + 6).heapAfterGcMax10, null, 'overflow cannot fabricate a measured peak');
assert.equal(heap.snapshot(WINDOW_MS + MAX_SAMPLES + 6).heapAfterGcMax10, 0);
const Governor = invoke('GameServer/Bot/Population/BackgroundWorkGovernor');
Governor.reset();
const lease = Governor.admit({ job: 'off-budget', requestedBudgetMs: 20, timestamp: 1000, lagMs: 0, dbPending: 0 });
assert.equal(lease.ok, true);
Governor.complete(lease.lease, { durationMs: 7, timestamp: 1007 });
assert.equal(Governor.snapshot(1007).usedMs, 7, 'off retains actual governor charging');
assert.equal(Governor.snapshot(1007).jobs, undefined, 'off builds no per-job diagnostics');
const { ColdCommitQueue } = require('../src/GameServer/Bot/Population/ColdCommitQueue');
(async () => {
    const acks = [];
    const queue = new ColdCommitQueue({ now: () => 1000, prepare: async p => p.baseState,
        commit: async rows => rows.map(row => ({ ok: true, characterId: row.nextState.characterId })),
        afterCommit: async () => { throw Error('postcommit auxiliary failure'); }, onResults: rows => acks.push(...rows) });
    queue.enqueue({ proposalId: 'master-off', characterId: 91, priority: 'P0',
        token: { ok: true, characterId: 91, ownerId: 'cold', revision: 1, leaseId: 'off', leaseUntil: 30000 },
        baseState: { characterId: 91, phase: 'cold', activity: 'hunting' },
        result: { patch: {}, materialize: { exp: 1, sp: 0, adena: 0, items: [] }, events: [] } });
    await queue.flushDue(true);
    assert.equal(acks[0].ok, true, 'off preserves committed action and its ack despite auxiliary error');
    assert.match(acks[0].afterCommitError, /auxiliary failure/);
    assert.equal(queue.samples.commit.length, 0);
    assert.equal(queue.samples.queue.length, 0);
    assert.equal(queue.stageSamples.prepare.length, 0);
    assert.equal(queue.snapshot().commitP95Ms, undefined);
    assert.equal(queue.snapshot().errors, undefined, 'off does not fabricate zero optional metrics');
    console.log('Developer master gates optional metrics and preserves runtime pressure, queues and postcommit outcomes');
})().catch(error => { console.error(error); process.exitCode = 1; });
