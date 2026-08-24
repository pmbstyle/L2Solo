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

try {
    Config.coldWorkerMaxInFlight = 32;
    Config.coldWorkerPlayerMaxInFlight = 8;
    Config.coldWorkerLagMaxInFlight = 2;
    Config.schedulerLagThrottleMs = 40;
    Config.schedulerLagAbortMs = 120;
    Metrics.schedulerState = { realPlayers: 1, mode: 'player', lagMs: 0 };
    Metrics.eventLoop.lagMs = 0;

    const coordinator = new ColdSimulationCoordinator();
    const envelope = Protocol.envelope('throttle', 'pressure-test', { maxInFlight: 2 });
    assert.strictEqual(Protocol.validateEnvelope(envelope, 'main', { workerEpoch: 'pressure-test' }).ok, true,
        'the worker pressure control message must be admitted by the main-to-worker protocol');
    assert.deepStrictEqual(coordinator.desiredWorkerPressure(), {
        maxInFlight: 8,
        lagMs: 0,
        player: true
    }, 'a live player must reduce cold-worker concurrency without pausing the world');

    Metrics.eventLoop.lagMs = 130;
    assert.strictEqual(coordinator.desiredWorkerPressure().maxInFlight, 2,
        'critical main-loop lag must reduce cold-worker concurrency to the safety floor');

    Metrics.eventLoop.lagMs = 60;
    assert.strictEqual(coordinator.desiredWorkerPressure().maxInFlight, 4,
        'throttling lag must halve player-mode cold-worker concurrency');

    Metrics.schedulerState = { realPlayers: 0, mode: 'idle', lagMs: 0 };
    Metrics.eventLoop.lagMs = 0;
    assert.strictEqual(coordinator.desiredWorkerPressure().maxInFlight, 32,
        'idle main must restore the full cold-worker concurrency budget');

    const messages = [];
    coordinator.worker = {};
    coordinator.ready = true;
    coordinator.post = (type, payload) => messages.push({ type, payload });
    Metrics.schedulerState = { realPlayers: 1, mode: 'player', lagMs: 0 };
    coordinator.syncWorkerPressure();
    coordinator.syncWorkerPressure();
    assert.deepStrictEqual(messages.map((message) => message.payload.maxInFlight), [8],
        'pressure sync must not resend an unchanged worker limit every watchdog tick');

    Metrics.eventLoop.lagMs = 130;
    coordinator.syncWorkerPressure();
    assert.deepStrictEqual(messages.map((message) => message.payload.maxInFlight), [8, 2],
        'pressure sync must send a lower worker limit when the player loop is critical');
} finally {
    Object.assign(Config, originalConfig);
    Metrics.schedulerState = originalSchedulerState;
    Object.assign(Metrics.eventLoop, originalEventLoop);
}

console.log('Cold worker pressure checks passed');
