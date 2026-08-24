const assert = require('assert');

require('../src/Global');

const BackgroundJobRegistry = invoke('GameServer/Bot/Population/BackgroundJobRegistry');

async function flush() {
    await new Promise((resolve) => setImmediate(resolve));
}

async function main() {
    let now = 1000;
    let cleared = false;
    const errors = [];
    let actionRuns = 0;
    let goalRuns = 0;
    let releaseFounder;
    const registry = BackgroundJobRegistry.create({
        tickMs: 50,
        now: () => now,
        setInterval: () => ({ unref() {} }),
        clearInterval: () => { cleared = true; },
        onError: (job, error) => errors.push(`${job}:${error.message}`)
    });
    registry.register({
        name: 'clan_actions', intervalMs: 1000, offsetMs: 0,
        run: () => { actionRuns += 1; }
    });
    registry.register({
        name: 'goal_metadata', intervalMs: 1000, offsetMs: 250,
        run: () => { goalRuns += 1; return { skipped: true }; }
    });
    registry.register({
        name: 'clan_founders', intervalMs: 1000, offsetMs: 500,
        run: () => new Promise((resolve) => { releaseFounder = resolve; })
    });
    registry.register({
        name: 'failure_probe', intervalMs: 1000, offsetMs: 750,
        run: () => { throw new Error('synthetic failure'); }
    });

    registry.start(now);
    await flush();
    assert.strictEqual(actionRuns, 1, 'zero-offset work must run on the initial tick');
    assert.strictEqual(goalRuns, 0);

    now = 1250;
    registry.tick(now);
    await flush();
    assert.strictEqual(goalRuns, 1);

    now = 1500;
    registry.tick(now);
    await flush();
    assert.strictEqual(registry.snapshot().jobs.clan_founders.inFlight, true);

    now = 1750;
    registry.tick(now);
    await flush();
    assert.deepStrictEqual(errors, ['failure_probe:synthetic failure']);

    now = 2500;
    registry.tick(now);
    await flush();
    let snapshot = registry.snapshot();
    assert.strictEqual(snapshot.jobs.clan_founders.deferred, 1, 'an in-flight job must not overlap its next due pass');
    assert.strictEqual(snapshot.jobs.clan_founders.started, 1);
    assert.strictEqual(actionRuns, 2);
    assert.strictEqual(goalRuns, 2);
    assert.strictEqual(snapshot.jobs.goal_metadata.skipped, 2);

    releaseFounder();
    await flush();
    snapshot = registry.snapshot();
    assert.strictEqual(snapshot.jobs.clan_founders.completed, 1);
    assert.strictEqual(snapshot.errors, 1);
    assert.strictEqual(snapshot.deferred, 1);

    registry.stop();
    assert.strictEqual(cleared, true);
    assert.strictEqual(registry.snapshot().running, false);
    console.log('Background job registry checks passed');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
