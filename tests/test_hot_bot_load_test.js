const assert = require('assert');
const { parseArguments, appendTail } = require('../scripts/hot-bot-load-test');
const MixedRuntimeLoadTest = require('../scripts/mixed-runtime-load-test');
const MixedRuntimeSlo = require('../src/GameServer/Bot/LoadTest/MixedRuntimeSlo');

assert.deepStrictEqual(parseArguments([]), {
    counts: [50, 100, 200, 300], durationMs: 60000, tickMs: 1000, spreadMs: 100
});
assert.deepStrictEqual(parseArguments(['--counts=25,100', '--duration=12', '--tick=500', '--spread=50']), {
    counts: [25, 100], durationMs: 12000, tickMs: 500, spreadMs: 50
});
assert.throws(() => parseArguments(['--counts=0']), /counts/);
assert.throws(() => parseArguments(['--duration=2']), /duration/);
assert.throws(() => parseArguments(['--tick=100']), /tick/);
assert.throws(() => parseArguments(['--spread=2000']), /spread/);
assert.strictEqual(appendTail('1234', '5678').length, 8, 'short diagnostic output must remain unchanged');
const diagnosticTail = appendTail('x'.repeat(1024 * 1024), 'tail');
assert.strictEqual(diagnosticTail.length, 1024 * 1024, 'diagnostic output must stay bounded');
assert.ok(diagnosticTail.endsWith('tail'), 'diagnostic output must retain the newest text');

const mixedDefaults = MixedRuntimeLoadTest.parseArguments([]);
assert.deepStrictEqual(mixedDefaults, {
    hot: 50,
    cold: 120,
    durationMs: 30000,
    tickMs: 1000,
    spreadMs: 100,
    playerProbeMs: 50,
    observerProbeMs: 1000,
    thresholds: {
        scheduleP95Ms: 40,
        scheduleP99Ms: 120,
        scheduleMaxMs: 150,
        handlerP95Ms: 25,
        handlerP99Ms: 75,
        observerP95Ms: 250,
        eventLoopMaxMs: 150
    }
});
assert.throws(() => MixedRuntimeLoadTest.parseArguments(['--cold=2']), /cold/);
assert.throws(() => MixedRuntimeLoadTest.parseArguments(['--duration=5']), /duration/);
assert.throws(() => MixedRuntimeLoadTest.parseArguments(['--schedule-p95=0']), /schedule-p95/);
const mixedEnvironment = MixedRuntimeLoadTest.environmentFor(mixedDefaults, 'mixed-probe.ini');
assert.strictEqual(mixedEnvironment.L2NODE_HOT_LOAD_MODE, 'mixed');
assert.strictEqual(mixedEnvironment.BOT_POPULATION_ENABLED, '1');
assert.strictEqual(mixedEnvironment.BOT_POPULATION_MAX_PLAYING, '120');
assert.strictEqual(mixedEnvironment.L2NODE_MIXED_SCHEDULE_P95_MS, '40');
assert.strictEqual(mixedEnvironment.L2NODE_MIXED_EVENT_LOOP_MAX_MS, '150');

const passingSlo = {
    cadenceRatio: 0.95,
    playerSchedule: { p95Ms: 20, p99Ms: 30, maxMs: 50 },
    playerHandler: { p95Ms: 2, p99Ms: 4 },
    observerLatency: { samples: 3, p95Ms: 40 },
    observerBuilds: 3,
    eventLoopMaxMs: 60,
    population: {
        coldMinimum: 120,
        counts: { total: 150 },
        activity: { mode: 'player', realPlayers: 1 },
        delta: { coldOwnerResolved: 8, coldOwnerCommitted: 8, coldOwnerErrors: 0, coldOwnerTimeouts: 0 }
    },
    preparedDue: 8,
    databaseFailures: 0,
    thresholds: mixedDefaults.thresholds
};
assert.deepStrictEqual(MixedRuntimeSlo.evaluate(passingSlo), [], 'healthy mixed runtime must satisfy the gate');
assert.deepStrictEqual(MixedRuntimeSlo.evaluate({
    ...passingSlo,
    cadenceRatio: 0.5,
    eventLoopMaxMs: 300,
    population: {
        ...passingSlo.population,
        delta: { coldOwnerResolved: 0, coldOwnerCommitted: 0, coldOwnerErrors: 1, coldOwnerTimeouts: 0 }
    },
    databaseFailures: 1
}), [
    'player_probe_cadence',
    'event_loop_max',
    'cold_world_stalled',
    'cold_worker_errors',
    'database_failures'
], 'the gate must report each independent runtime failure');
console.log('hot bot load runner argument checks passed');
