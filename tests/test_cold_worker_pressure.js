process.env.BOT_DEVELOPER_DIAGNOSTICS = 'true'; // Fixture inspects optional developer counters.
const assert = require('assert');

require('../src/Global');

const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const Metrics = invoke('GameServer/Bot/Population/PopulationMetrics');
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
const { ColdSimulationCoordinator } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');

const originalConfig = {
    coldWorkerMaxInFlight: Config.coldWorkerMaxInFlight,
    coldWorkerPlayerMaxInFlight: Config.coldWorkerPlayerMaxInFlight,
    coldWorkerLagMaxInFlight: Config.coldWorkerLagMaxInFlight,
    schedulerLagThrottleMs: Config.schedulerLagThrottleMs,
    schedulerLagAbortMs: Config.schedulerLagAbortMs
};
const originalSchedulerState = Metrics.schedulerState;
const originalEventLoop = { ...Metrics.eventLoop };
const originalLagHistory = [...Metrics.lagHistory];
// The 1 s readings as the event-loop timer records them, newest last.
const readings = (...values) => {
    Metrics.lagHistory = [];
    for (const value of values) { Metrics.eventLoop.lagMs = value; Metrics.recordLagReading(value); }
};

try {
    Config.coldWorkerMaxInFlight = 32;
    Config.coldWorkerPlayerMaxInFlight = 8;
    Config.coldWorkerLagMaxInFlight = 2;
    Config.schedulerLagThrottleMs = 40;
    Config.schedulerLagAbortMs = 120;
    Metrics.schedulerState = { realPlayers: 1, mode: 'player', lagMs: 0 };
    readings(0, 0, 0);

    const coordinator = new ColdSimulationCoordinator();
    coordinator.worker = {};
    coordinator.ready = true;
    coordinator.snapshotsLoaded = true;
    coordinator.lastHeartbeatAt = 10000;
    coordinator.lastWorkerSnapshot = { eventLoopUtilization: .5, eventLoopLagMaxMs: 12 };
    assert.deepStrictEqual(coordinator.raidForecastPressure(11000), { ready: true,
        heartbeatAgeMs: 1000, utilization: .5, lagMs: 12, pendingGoals: 0 });
    assert.equal(coordinator.raidForecastPressure(14000).ready, false, 'old heartbeats cannot admit optional raid forecasts');
    coordinator.partyGoalRequests = 1;
    assert.equal(coordinator.raidForecastPressure(11000).pendingGoals, 1, 'ordinary party goals retain priority');
    coordinator.partyGoalRequests = 0;
    coordinator.pauseReasons.add('fixture');
    assert.equal(coordinator.raidForecastPressure(11000).ready, false);
    coordinator.pauseReasons.clear();
    const envelope = Protocol.envelope('throttle', 'pressure-test', { maxInFlight: 2 });
    assert.strictEqual(Protocol.validateEnvelope(envelope, 'main', { workerEpoch: 'pressure-test' }).ok, true,
        'the worker pressure control message must be admitted by the main-to-worker protocol');
    assert.deepStrictEqual(coordinator.desiredWorkerPressure(), {
        maxInFlight: 8,
        lagMs: 0,
        player: true
    }, 'a live player must reduce cold-worker concurrency without pausing the world');

    readings(0, 0, 130);
    assert.deepStrictEqual(coordinator.desiredWorkerPressure(), { maxInFlight: 8, lagMs: 130, player: true },
        'one late reading (a GC pause or a burst task) must not cut the limit; the raw lag is still reported');

    readings(0, 130, 130);
    assert.strictEqual(coordinator.desiredWorkerPressure().maxInFlight, 2,
        'critical lag in two of the last three readings must reduce cold-worker concurrency to the safety floor');

    readings(60, 0, 60);
    assert.strictEqual(coordinator.desiredWorkerPressure().maxInFlight, 4,
        'sustained throttling lag must halve player-mode cold-worker concurrency');

    Metrics.schedulerState = { realPlayers: 1, mode: 'player', lagMs: 130 };
    readings(0, 0, 0);
    assert.deepStrictEqual(coordinator.desiredWorkerPressure(), { maxInFlight: 8, lagMs: 130, player: true },
        'the 5 s scheduler snapshot of an old reading must not hold the limit down');

    Metrics.schedulerState = { realPlayers: 0, mode: 'idle', lagMs: 0 };
    readings(130, 130, 0, 0, 0);
    assert.deepStrictEqual(Metrics.lagHistory, [0, 0, 0], 'only the last three readings are kept');
    assert.strictEqual(coordinator.desiredWorkerPressure().maxInFlight, 32,
        'idle main must restore the full cold-worker concurrency budget once the lag is over');

    readings(0, 130);
    assert.strictEqual(coordinator.desiredWorkerPressure().maxInFlight, 32,
        'with two readings one late reading is still not sustained');
    readings(130, 130, 0);
    assert.strictEqual(coordinator.desiredWorkerPressure().maxInFlight, 2,
        'an idle loop late in two of three readings must still reach the safety floor');
    readings(0, 0, 0);

    const messages = [];
    coordinator.worker = {};
    coordinator.ready = true;
    coordinator.post = (type, payload) => messages.push({ type, payload });
    Metrics.schedulerState = { realPlayers: 1, mode: 'player', lagMs: 0 };
    coordinator.syncWorkerPressure();
    coordinator.syncWorkerPressure();
    assert.deepStrictEqual(messages.map((message) => message.payload.maxInFlight), [8],
        'pressure sync must not resend an unchanged worker limit every watchdog tick');

    readings(0, 130, 130);
    coordinator.syncWorkerPressure();
    assert.deepStrictEqual(messages.map((message) => message.payload.maxInFlight), [8, 2],
        'pressure sync must send a lower worker limit when the player loop is critical');

    // The player logs out while the lag holds the same limit: the worker still learns it (its batching age follows).
    Metrics.schedulerState = { realPlayers: 0, mode: 'idle', lagMs: 0 };
    coordinator.syncWorkerPressure();
    assert.deepStrictEqual(messages.map((message) => [message.payload.maxInFlight, message.payload.player]),
        [[8, true], [2, true], [2, false]], 'pressure sync must send a player change at an unchanged worker limit');
} finally {
    Object.assign(Config, originalConfig);
    Metrics.schedulerState = originalSchedulerState;
    Object.assign(Metrics.eventLoop, originalEventLoop);
    Metrics.lagHistory = originalLagHistory;
}

(async () => {
    const sampleMs = Config.eventLoopSampleMs;
    try {
        Config.eventLoopSampleMs = 20;
        Metrics.lagHistory.push(130, 130);
        Metrics.startEventLoopMonitor();
        assert.deepStrictEqual(Metrics.lagHistory, [], 'a started monitor must not decide the limit from an earlier run');
        await new Promise((resolve) => setTimeout(resolve, 90));
        assert.ok(Metrics.lagHistory.length >= 1 && Metrics.lagHistory.length <= 3,
            'the event-loop timer must record its readings for the worker limit, at most three');
    } finally {
        Metrics.stopEventLoopMonitor();
        Config.eventLoopSampleMs = sampleMs;
        Metrics.lagHistory = originalLagHistory;
    }
    console.log('Cold worker pressure checks passed');
})().catch((error) => { console.error(error); process.exit(1); });
