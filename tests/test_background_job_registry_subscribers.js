process.env.BOT_DEVELOPER_DIAGNOSTICS = 'true'; // This fixture inspects optional developer metrics.
const assert = require('assert');
const path = require('path');

const registryPath = process.env.BACKGROUND_JOB_REGISTRY_PATH
    || path.join(__dirname, '../src/GameServer/Bot/Population/BackgroundJobRegistry');
const BackgroundJobRegistry = require(registryPath);

const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
    let now = 1000;
    let created = 0;
    let cleared = 0;
    const intervals = [];
    const errors = [];
    const registry = BackgroundJobRegistry.create({
        tickMs: 250,
        now: () => now,
        setInterval(callback, delay) {
            assert.strictEqual(delay, 250, 'subscriptions use the existing registry tick clock');
            created++;
            const timer = { callback, unref() {} };
            intervals.push(timer);
            return timer;
        },
        clearInterval(timer) {
            assert(intervals.includes(timer));
            cleared++;
        },
        onError: (name, error) => errors.push({ name, error })
    });
    return { registry, errors, intervals,
        advance(ms) { now += ms; },
        created: () => created, cleared: () => cleared };
}

async function legacyControls() {
    const f = fixture();
    let runs = 0;
    f.registry.register({ name: 'delayed_control', intervalMs: 1000, offsetMs: 500,
        run() { runs++; } });
    f.registry.start();
    await flush();
    assert.strictEqual(f.created(), 1);
    assert.strictEqual(f.registry.snapshot().ticks, 1, 'start executes one real tick');
    assert.strictEqual(runs, 0, 'not-yet-due job stays untouched');
    f.advance(250);
    f.intervals[0].callback();
    await flush();
    assert.strictEqual(f.registry.snapshot().ticks, 2);
    assert.strictEqual(runs, 0);
    f.advance(250);
    f.intervals[0].callback();
    await flush();
    assert.strictEqual(runs, 1, 'existing due job still runs on its actual deadline');
    const ticks = f.registry.snapshot().ticks;
    f.registry.stop();
    f.advance(1000);
    f.intervals[0].callback();
    f.registry.tick();
    await flush();
    assert.strictEqual(f.registry.snapshot().ticks, ticks, 'stopped tick is inert');
    assert.strictEqual(runs, 1);
    assert.strictEqual(f.cleared(), 1);
    console.log('Legacy registry deadline/one-clock/stopped positive controls PASS');
}

async function emptyAndDisposal() {
    const f = fixture();
    assert.strictEqual(typeof f.registry.subscribeTicks, 'function',
        'feature absent: registry must expose subscribeTicks(listener) -> unsubscribe');
    let pulses = 0;
    const unsubscribe = f.registry.subscribeTicks(() => { pulses++; });
    assert.strictEqual(typeof unsubscribe, 'function');
    assert.strictEqual(pulses, 0, 'subscription itself is not a scheduler tick');
    assert.strictEqual(f.created(), 0, 'subscription creates no clock');
    assert.strictEqual(f.registry.snapshot().registered, 0, 'subscription creates no job');
    f.registry.tick();
    assert.strictEqual(pulses, 0, 'registry not started yet emits no pulse');
    f.registry.start();
    assert.strictEqual(pulses, 1, 'initial actual tick pulses once even with no jobs');
    f.registry.start();
    assert.strictEqual(pulses, 1, 'idempotent start does not synthesize another tick');
    assert.strictEqual(f.created(), 1);
    f.advance(250);
    f.intervals[0].callback();
    assert.strictEqual(pulses, 2, 'actual existing interval ticks once');
    f.registry.tick();
    assert.strictEqual(pulses, 3, 'same-clock actual manual tick also pulses exactly once');
    f.registry.stop();
    f.intervals[0].callback();
    f.registry.tick();
    assert.strictEqual(pulses, 3, 'stopped registry emits no callback');
    unsubscribe();
    unsubscribe();
    f.registry.start();
    f.advance(250);
    f.intervals[1].callback();
    assert.strictEqual(pulses, 3, 'disposed subscription stays removed after registry restart');
    assert.strictEqual(f.registry.snapshot().registered, 0);
    assert.strictEqual(f.created(), 2, 'only the explicit registry restart creates its next clock');
    f.registry.stop();
    console.log('Empty tick, stopped and unsubscribe/disposal controls PASS');
}

async function errorsAndDueJobs() {
    const f = fixture();
    let pulses = 0;
    let dueRuns = 0;
    const failure = new Error('synthetic tick subscriber failure');
    const removeFailure = f.registry.subscribeTicks(() => { throw failure; });
    const removeHealthy = f.registry.subscribeTicks(() => { pulses++; });
    f.registry.register({ name: 'due_control', intervalMs: 1000, offsetMs: 500,
        run() { dueRuns++; } });
    try {
        assert.doesNotThrow(() => f.registry.start(), 'subscriber failure is isolated');
        await flush();
        assert.strictEqual(pulses, 1, 'throwing subscriber does not suppress another subscriber');
        assert.strictEqual(dueRuns, 0, 'no extra early due job execution');
        f.advance(250);
        f.intervals[0].callback();
        await flush();
        assert.strictEqual(pulses, 2, 'not-due job does not suppress its registry pulse');
        assert.strictEqual(dueRuns, 0);
        f.advance(250);
        assert.doesNotThrow(() => f.intervals[0].callback());
        await flush();
        assert.strictEqual(pulses, 3);
        assert.strictEqual(dueRuns, 1, 'throwing subscriber does not suppress due job');
        assert.strictEqual(f.errors.length, 3, 'each actual failure uses the existing onError path once');
        assert.strictEqual(f.registry.snapshot().errors, 3, 'subscriber failures use existing error telemetry');
        for (const entry of f.errors) {
            assert.strictEqual(entry.error, failure, 'onError receives the original subscriber error');
            assert.strictEqual(typeof entry.name, 'string');
            assert(entry.name.length > 0, 'onError identifies subscriber work');
        }
        removeFailure();
        f.advance(1000);
        f.intervals[0].callback();
        await flush();
        assert.strictEqual(f.errors.length, 3, 'unsubscribed failing listener is gone');
        assert.strictEqual(pulses, 4);
        assert.strictEqual(dueRuns, 2, 'ordinary due cadence remains intact');
        assert.strictEqual(f.created(), 1);
        assert.strictEqual(f.registry.snapshot().registered, 1, 'subscribers are not registry jobs');
    } finally {
        removeFailure();
        removeHealthy();
        f.registry.stop();
    }
    console.log('Not-due pulses, failure isolation/onError and real due jobs PASS');
}

function stopInsideFirstPulse() {
    const f = fixture();
    let stoppingPulses = 0;
    let laterPulses = 0;
    const unsubscribeStop = f.registry.subscribeTicks(() => {
        stoppingPulses++;
        f.registry.stop();
    });
    const unsubscribeLater = f.registry.subscribeTicks(() => { laterPulses++; });
    f.registry.start();
    assert.strictEqual(stoppingPulses, 1);
    assert.strictEqual(laterPulses, 0, 'stop during a pulse suppresses later subscribers in that tick');
    assert.strictEqual(f.registry.snapshot().running, false);
    assert.strictEqual(f.created(), 0, 'stop during initial pulse must not resurrect an interval');
    f.advance(250);
    f.registry.tick();
    assert.strictEqual(stoppingPulses, 1);
    unsubscribeStop();
    unsubscribeLater();
    console.log('Stop-inside-initial-pulse has no interval resurrection PASS');
}

function pumpOnly() {
    const f = fixture();
    const continuations = [];
    let pumpCalls = 0;
    let looks = 0;
    let applies = 0;
    const pump = () => {
        pumpCalls++;
        const later = () => { looks++; applies++; };
        continuations.push(later);
        return later;
    };
    const dispose = f.registry.subscribeTicks(pump);
    f.registry.start();
    f.advance(250);
    f.intervals[0].callback();
    assert.strictEqual(pumpCalls, 2, 'tick only calls the caller-supplied pump');
    assert.strictEqual(looks, 0, 'registry does not execute returned pricing continuation inline');
    assert.strictEqual(applies, 0);
    assert.strictEqual(f.created(), 1);
    assert.strictEqual(f.registry.snapshot().registered, 0);
    continuations.shift()();
    assert.strictEqual(looks, 1, 'independent continuation remains caller-owned');
    assert.strictEqual(applies, 1);
    dispose();
    f.advance(250);
    f.intervals[0].callback();
    assert.strictEqual(pumpCalls, 2, 'service disposal unsubscribes without stopping other registry work');
    f.registry.stop();
    console.log('Pump-only callback, no inline pricing/job/clock and service disposal PASS');
}

async function main() {
    await legacyControls();
    await emptyAndDisposal();
    await errorsAndDueJobs();
    stopInsideFirstPulse();
    pumpOnly();
    console.log('Background job registry subscriber checks passed');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
