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
// A populated database can satisfy the bot-count gate before its cold worker
// has loaded the initial snapshot. Exercise the actual warmup timer ordering.
const originalInvoke = global.invoke;
const originalSetInterval = global.setInterval;
const originalClearInterval = global.clearInterval;
const originalNow = Date.now;
const savedEnvironment = { ...process.env };
try {
    let now = 0;
    let poll;
    const coordinator = { ready: false, snapshotsLoaded: false };
    const stubs = {
        Database: {},
        'GameServer/Bot/BotManager': {
            sessions: [
                { accountId: 'bot_load_0001', actor: {} },
                { accountId: 'load_player', actor: {} }
            ],
            provisionAndSpawn() {}
        },
        'GameServer/Bot/BotAI': {},
        'GameServer/Bot/AI/HotAiDispatcher': {},
        'GameServer/Persistence/CharacterWriteQueue': {},
        'GameServer/Bot/Population/BotLifeState': { counts: () => ({ cold: 120, total: 122 }) },
        'GameServer/Bot/Population/GeneratedColdSeeder': { running: false },
        'GameServer/Bot/Population/ColdSimulationCoordinator': coordinator
    };
    global.invoke = (name) => {
        assert(name in stubs, `unexpected warmup dependency: ${name}`);
        return stubs[name];
    };
    global.setInterval = (callback) => { poll = callback; return 1; };
    global.clearInterval = () => {};
    Date.now = () => now;
    Object.assign(process.env, {
        L2NODE_HOT_LOAD_MODE: 'mixed',
        L2NODE_HOT_LOAD_COUNT: '1',
        L2NODE_MIXED_LOAD_COLD_MIN: '120',
        L2NODE_MIXED_WARMUP_STABLE_MS: '500'
    });
    const load = require('../src/GameServer/Bot/LoadTest/HotBotLoadTest');
    let measurements = 0;
    load.playerSession = {};
    load.measure = () => { measurements += 1; };
    load.start();
    poll();
    now = 1000;
    poll();
    assert.strictEqual(measurements, 0, 'bot counts alone must not start a cold runtime measurement');
    coordinator.ready = true;
    now = 1100;
    poll();
    assert.strictEqual(measurements, 0, 'a ready worker must also finish loading the initial snapshot');
    coordinator.snapshotsLoaded = true;
    now = 1200;
    poll();
    assert.strictEqual(measurements, 0, 'worker startup must still pass the stability window');
    now = 1800;
    poll();
    assert.strictEqual(measurements, 1, 'the fully ready mixed world must enter measurement');
} finally {
    global.invoke = originalInvoke;
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
    Date.now = originalNow;
    for (const name of Object.keys(process.env)) if (!(name in savedEnvironment)) delete process.env[name];
    Object.assign(process.env, savedEnvironment);
}
console.log('hot bot load runner arguments, SLO, and worker warmup checks passed');
