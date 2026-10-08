process.env.BOT_DEVELOPER_DIAGNOSTICS = 'true'; // Fixture inspects optional developer counters.
const assert = require('assert');
require('../src/Global');
const Metrics = invoke('GameServer/Bot/Population/PopulationMetrics');
const { ColdSimulationKernel } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');

const counterKeys = ['missedEventsRecovered', 'coldSafetyStateRepairs', 'coldSafetyQueueRepairs'];
const totals = (stateRepairs = 0, coverageRepairs = 0) => ({ stateRepairs, coverageRepairs, orphanRepairs: 0 });

function recoveredKernel() {
    let timestamp = 1000000;
    const kernel = new ColdSimulationKernel({ now: () => timestamp, resolveSolo: () => ({}), emit: () => {} });
    kernel.pause();
    assert(kernel.upsert({ state: { characterId: 1, phase: 'cold', activity: 'hunting', inventory: {}, stats: {},
        timing: { nextResolveAt: timestamp + 3 * 1800000 }, simulation: { ownerId: 'legacy_main', revision: 1 } },
    context: { spot: { id: 'generated' } } }));
    const deadline = kernel.heap.values.find(entry => entry.kind !== 'alarm' && entry.characterId === 1);
    assert(deadline && kernel.heap.remove(deadline));
    kernel.consumeHeapEntry(deadline);
    timestamp += 1800000;
    assert.equal(kernel.ensureScheduled(1), true);
    kernel.stats.orphanRecoveries++;
    assert.strictEqual(kernel.stats.orphanRecoveries, 1, 'actual missing local deadline was accepted once');
    assert(kernel.scheduleTokens.has(1));
    timestamp += 1800000;
    kernel.tick();
    assert.strictEqual(kernel.stats.orphanRecoveries, 1, 'healthy repeat does not count a missed edge');
    kernel.shutdown();
    return kernel.stats.orphanRecoveries;
}

const descriptor = Object.getOwnPropertyDescriptor(Metrics, 'coldSafetySource');
const saved = { counters: Metrics.counters, lastSummaryCounters: Metrics.lastSummaryCounters, startedAt: Metrics.startedAt };
try {
    const coverage = recoveredKernel();
    assert.strictEqual(typeof Metrics.beginColdSafetyEpoch, 'function', 'accepted metrics epoch API is implemented');
    assert.strictEqual(typeof Metrics.recordColdSafetyTotals, 'function');
    assert.strictEqual(typeof Metrics.clearColdSafetyEpoch, 'function');
    Metrics.counters = { ...Metrics.counters };
    Metrics.lastSummaryCounters = { ...Metrics.lastSummaryCounters };
    for (const key of counterKeys) {
        assert.strictEqual(Metrics.counters[key], 0, `new counter ${key} initialized`);
        Metrics.lastSummaryCounters[key] = 0;
    }

    assert.strictEqual(Metrics.recordColdSafetyTotals('epoch-a', totals(0, coverage)), 0);
    assert.strictEqual(Metrics.beginColdSafetyEpoch('epoch-a'), true);
    assert.strictEqual(Metrics.recordColdSafetyTotals('epoch-a', totals(0, coverage)), 1);
    assert.strictEqual(Metrics.recordColdSafetyTotals('epoch-a', totals(0, coverage)), 0);
    console.log('actual local recovery and repeated cumulative receipt: pass');

    // Simulate losing the earlier receipt: the later cumulative report closes
    // exactly the gap. State/board values here test transport accounting only.
    assert.strictEqual(Metrics.recordColdSafetyTotals('epoch-a', totals(3, 1)), 3);
    assert.strictEqual(Metrics.recordColdSafetyTotals('epoch-a', totals(1, 0)), 0);
    assert.strictEqual(Metrics.recordColdSafetyTotals('epoch-a', totals(2, 2)), 1);
    assert.deepStrictEqual(counterKeys.map(key => Metrics.counters[key]), [5, 3, 2]);
    console.log('lost receipt, source separation and out-of-order high water: pass');

    Metrics.init();
    let summary = Metrics.snapshot();
    assert.deepStrictEqual(counterKeys.map(key => summary.delta[key]), [5, 3, 2]);
    assert.strictEqual(Metrics.beginColdSafetyEpoch('epoch-a'), true);
    assert.strictEqual(Metrics.recordColdSafetyTotals('epoch-a', totals(3, 2)), 0);
    summary = Metrics.snapshot();
    assert.deepStrictEqual(counterKeys.map(key => summary.delta[key]), [0, 0, 0]);
    console.log('same epoch, init and summary preserve watermarks: pass');

    assert.strictEqual(Metrics.beginColdSafetyEpoch('epoch-b'), true);
    assert.strictEqual(Metrics.recordColdSafetyTotals('epoch-a', totals(100, 100, 100)), 0);
    assert.strictEqual(Metrics.clearColdSafetyEpoch('epoch-a'), false);
    assert.strictEqual(Metrics.recordColdSafetyTotals('epoch-b', totals(1, 0)), 1);
    assert.deepStrictEqual(counterKeys.map(key => Metrics.counters[key]), [6, 4, 2]);
    console.log('replacement epoch preserves lifetime counters and rejects stale reports/retirement: pass');

    for (const invalid of ['', null, 12, 'x'.repeat(161)]) assert.strictEqual(Metrics.beginColdSafetyEpoch(invalid), false);
    for (const malformed of [null, [], {}, totals('5', 0, 0), totals(-1, 0, 0), totals(0.5, 0, 0),
        totals(Infinity, 0, 0), totals(NaN, 0, 0), totals(Number.MAX_SAFE_INTEGER + 1, 0, 0)]) {
        assert.strictEqual(Metrics.recordColdSafetyTotals('epoch-b', malformed), 0);
    }
    assert.strictEqual(Metrics.recordColdSafetyTotals('epoch-b', totals(2, 0)), 1);
    assert.strictEqual(Metrics.recordColdSafetyTotals('epoch-b', totals(Number.MAX_SAFE_INTEGER, 1, 0)), 0,
        'unsafe aggregate addition is rejected atomically');
    assert.strictEqual(Metrics.recordColdSafetyTotals('epoch-b', totals(3, 0)), 1,
        'invalid report cannot poison source high water');
    console.log('strict payloads and overflow rejection preserve the current source: pass');

    assert.strictEqual(Metrics.clearColdSafetyEpoch('epoch-b'), true);
    assert.strictEqual(Metrics.recordColdSafetyTotals('epoch-b', totals(50, 50, 50)), 0);
    assert.strictEqual(Metrics.clearColdSafetyEpoch('epoch-b'), false);
    assert.strictEqual(Metrics.counters.missedEventsRecovered,
        Metrics.counters.coldSafetyStateRepairs + Metrics.counters.coldSafetyQueueRepairs);
    console.log('retired current source is inert: pass');
    console.log('N53 accepted metrics: PASS');
} finally {
    Object.assign(Metrics, saved);
    if (descriptor) Object.defineProperty(Metrics, 'coldSafetySource', descriptor);
    else delete Metrics.coldSafetySource;
}
