const assert = require('assert');
require('../src/Global');

const Population = invoke('GameServer/Bot/Population/PopulationService');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const Metrics = invoke('GameServer/Bot/Population/PopulationMetrics');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const Governor = invoke('GameServer/Bot/Population/BackgroundWorkGovernor');
const Database = invoke('Database');
const World = invoke('GameServer/World/World');
const flush = () => new Promise(resolve => setImmediate(resolve));

async function main() {
    const restore = [];
    const replace = (target, key, value) => {
        const descriptor = Object.getOwnPropertyDescriptor(target, key);
        restore.push(() => descriptor ? Object.defineProperty(target, key, descriptor) : delete target[key]);
        Object.defineProperty(target, key, { configurable: true, enumerable: true, writable: true, value });
    };
    const populationSnapshot = { ...Population };
    const clocks = new Set();
    let createdClocks = 0;
    let now = 1000;
    let lifeCalls = 0;
    let lifeResolve;
    let boardReady = false;
    let dbPending = 0;
    let lag = 0;
    const boardListeners = new Set();
    const service = { starts: 0, stops: 0, pumps: 0,
        start(providers) {
            this.starts++; this.providers = providers;
            if (this.failNextStart) { this.failNextStart = false; throw new Error('private_start_fault'); }
            return true;
        },
        stop() { this.stops++; }, pump() { this.pumps++; } };
    const originalInvoke = global.invoke;
    replace(global, 'invoke', name => name === 'GameServer/Bot/Economy/HotBoardReviewService'
        ? service : originalInvoke(name));
    replace(Date, 'now', () => now);
    for (const key of ['setInterval', 'setTimeout']) replace(global, key, callback => {
        createdClocks++;
        const clock = { callback, unref() {} };
        clocks.add(clock);
        return clock;
    });
    for (const key of ['clearInterval', 'clearTimeout']) replace(global, key, clock => clocks.delete(clock));
    replace(Life, 'init', () => {
        lifeCalls++;
        return new Promise(resolve => { lifeResolve = resolve; });
    });
    replace(Afk, 'isBoardReady', () => boardReady);
    replace(Afk, 'subscribeBoardChanges', callback => {
        boardListeners.add(callback);
        return () => boardListeners.delete(callback);
    });
    replace(Metrics, 'currentEventLoopLag', () => lag);
    replace(Metrics, 'schedulerState', { mode: 'idle', realPlayers: 0, lagMs: 0 });
    replace(Database, 'stats', () => ({ pending: dbPending }));
    replace(World, 'user', Object.defineProperty({}, 'sessions', {
        get() { throw new Error('hot admission must not scan World sessions'); }
    }));
    for (const name of ['init', 'startEventLoopMonitor', 'stopEventLoopMonitor']) replace(Metrics, name, () => {});
    for (const name of ['BotLifeEvents', 'BackgroundPartyState']) {
        replace(originalInvoke(`GameServer/Bot/Population/${name}`), 'init', () => {});
    }
    const director = originalInvoke('GameServer/Bot/Population/PopulationDirector');
    for (const name of ['init', 'start', 'stop']) replace(director, name, () => {});
    replace(originalInvoke('GameServer/Bot/Population/ColdSimulationCoordinator'), 'stop', () => Promise.resolve());
    replace(originalInvoke('GameServer/Bot/Population/PersistentStateRetention'), 'reset', () => {});
    replace(Population, 'scheduleGeneratedColdSeed', () => {});
    replace(Population, 'schedulePersonaBackfill', () => {});
    const clan = originalInvoke('GameServer/Clan/ClanSimulationConfig');
    replace(clan, 'enabled', false);
    // This readiness fixture isolates hot board attachment from clan startup.
    // Named clan subscriptions have their own native SQLite regression.
    const clanEvents = originalInvoke('GameServer/Clan/ClanReviewEvents');
    replace(clanEvents, 'start', async () => true);
    replace(clanEvents, 'stop', () => {});
    const flags = ['backgroundResolverEnabled', 'warehouseCleanupEnabled', 'stateRetentionEnabled',
        'backgroundPartyEnabled', 'phasePolicyEnabled'];
    for (const flag of flags) replace(Config, flag, false);
    for (const [key, value] of Object.entries({ enabled: true, backgroundGovernorEnabled: true,
        backgroundGovernorWindowMs: 1000, backgroundGovernorIdleBudgetMs: 100,
        backgroundGovernorPlayerBudgetMs: 30, backgroundGovernorIdleDbQueueMax: 8,
        backgroundGovernorPlayerDbQueueMax: 0, backgroundGovernorLagAbortMs: 120, schedulerSliceMs: 12 })) {
        replace(Config, key, value);
    }
    replace(options.default.Database, 'checkpointResetWalBytes', 0);

    function fresh() {
        Population.initialized = false;
        Population.started = false;
        Population.lifeReadyPromise = null;
        Population.backgroundJobRegistry = null;
        boardReady = false;
        Governor.reset();
    }
    function readyBoard() {
        boardReady = true;
        for (const callback of [...boardListeners]) callback({ ready: true });
    }

    try {
        fresh();
        Config.enabled = false;
        Population.init();
        Population.start();
        assert.strictEqual(lifeCalls, 0);
        assert.strictEqual(createdClocks, 0);
        assert.strictEqual(service.starts, 0);
        console.log('Disabled Population startup positive control PASS');
        Config.enabled = true;
        const readiness = Population.init();
        assert(readiness && typeof readiness.then === 'function',
            'Population init must retain the actual LifeState readiness barrier');
        assert.strictEqual(Population.init(), readiness, 'idempotent init shares one readiness barrier');
        assert.strictEqual(lifeCalls, 1);
        Population.start();
        const registry = Population.backgroundJobRegistry;
        const lifecycleClocks = createdClocks;
        assert.strictEqual(service.starts, 0, 'unresolved LifeState cannot start market work');
        lifeResolve(true);
        await readiness;
        await flush();
        assert.strictEqual(service.starts, 0, 'restored board is also a readiness barrier');
        assert.strictEqual(boardListeners.size, 1);
        readyBoard();
        await flush();
        assert.strictEqual(service.starts, 1);
        assert.strictEqual(boardListeners.size, 0);
        assert.strictEqual(createdClocks, lifecycleClocks, 'attachment creates no additional clock');
        assert.strictEqual(registry.snapshot().registered, 0, 'hot continuation adds no timer job');
        await Population.startHotBoardReviews();
        assert.strictEqual(service.starts, 1, 'repeated attachment is idempotent');
        const pumps = service.pumps;
        registry.tick();
        assert.strictEqual(service.pumps, pumps + 1, 'actual empty registry tick pumps cooperatively');
        const oldProviders = service.providers;
        let lease = oldProviders.admit();
        assert(lease, 'actual shared Governor admits idle hot work');
        assert.strictEqual(lease.job, 'hot_market_review');
        assert.strictEqual(lease.resource, 'sqlite-heavy');
        const before = Governor.snapshot().completed;
        oldProviders.complete(lease, { durationMs: 2 });
        assert.strictEqual(Governor.snapshot().completed, before + 1);
        Metrics.schedulerState = { mode: 'player', realPlayers: 1, lagMs: 0 };
        dbPending = 1;
        assert.strictEqual(oldProviders.admit(), null, 'cached player pressure uses stricter DB admission');
        dbPending = 0;
        lag = 120;
        assert.strictEqual(oldProviders.admit(), null, 'current loop lag denies hot work');
        lag = 0;
        Metrics.schedulerState.lagMs = 120;
        assert.strictEqual(oldProviders.admit(), null, 'cached scheduler lag also denies hot work');
        Metrics.schedulerState.lagMs = 0;
        now += 1000;
        lease = oldProviders.admit();
        assert(lease, 'shared Governor recovers in the next window without another clock');
        await Population.stop();
        oldProviders.complete(lease, { durationMs: 1 });
        assert.deepStrictEqual(Governor.snapshot().resources, {}, 'completion after stop still releases admission');
        assert.strictEqual(oldProviders.admit(), null, 'disposed provider cannot admit');
        const stoppedPumps = service.pumps;
        registry.tick();
        assert.strictEqual(service.pumps, stoppedPumps);
        assert.strictEqual(service.stops, 1);
        assert.strictEqual(clocks.size, 0, 'actual Population stop disposes its clocks');
        console.log('Native Population/Registry/Governor attachment and pressure checks PASS');

        fresh();
        Population.start();
        const pending = Population.lifeReadyPromise;
        await Population.stop();
        lifeResolve(true);
        await pending;
        await flush();
        readyBoard();
        assert.strictEqual(service.starts, 1, 'late readiness cannot revive a stopped runtime');
        assert.strictEqual(boardListeners.size, 0);
        console.log('Stop before LifeState readiness generation fence PASS');

        fresh();
        Population.start();
        lifeResolve(true);
        await Population.lifeReadyPromise;
        await flush();
        assert.strictEqual(boardListeners.size, 1);
        await Population.stop();
        readyBoard();
        assert.strictEqual(service.starts, 1, 'late restored board cannot revive stopped runtime');
        assert.strictEqual(boardListeners.size, 0);
        console.log('Stop before board readiness subscription disposal PASS');

        fresh();
        readyBoard();
        Population.start();
        lifeResolve(false);
        await Population.lifeReadyPromise;
        await flush();
        assert.strictEqual(service.starts, 1, 'failed LifeState initialization never starts market work');
        assert.strictEqual(boardListeners.size, 0);
        await Population.stop();
        console.log('Failed initialization keeps hot runtime stopped PASS');

        fresh();
        readyBoard();
        Population.start();
        lifeResolve(true);
        await Population.lifeReadyPromise;
        await flush();
        assert.strictEqual(service.starts, 2, 'fresh successful lifecycle starts exactly once');
        assert.strictEqual(oldProviders.admit(), null, 'old generation stays fenced after restart');
        await Population.stop();
        assert.strictEqual(service.stops, 2);
        assert.strictEqual(clocks.size, 0);
        console.log('Successful restart preserves generation/provider isolation PASS');

        fresh();
        service.failNextStart = true;
        Population.start();
        lifeResolve(true);
        await Population.lifeReadyPromise;
        await flush();
        readyBoard();
        const failedProviders = service.providers;
        assert.strictEqual(service.starts, 3);
        assert.strictEqual(service.stops, 3, 'partially started boundary is disposed');
        assert.strictEqual(failedProviders.admit(), null);
        assert.strictEqual(boardListeners.size, 1, 'failed late startup retains readiness subscription');
        const retryRegistry = Population.backgroundJobRegistry;
        retryRegistry.tick();
        assert.strictEqual(service.starts, 3, 'recovery waits for the existing governor window');
        now += 1000;
        retryRegistry.tick();
        assert.strictEqual(service.starts, 4, 'existing registry tick retries late attachment');
        assert.strictEqual(boardListeners.size, 0);
        assert(Population.hotBoardReviewService);
        assert.strictEqual(failedProviders.admit(), null, 'failed-attempt provider stays fenced after retry');
        const recoveredPumps = service.pumps;
        retryRegistry.tick();
        assert.strictEqual(service.pumps, recoveredPumps + 1);
        await Population.stop();
        assert.strictEqual(clocks.size, 0);
        console.log('Late startup failure cleans up and recovers from the existing clock PASS');
    } finally {
        await Population.stop();
        Object.assign(Population, populationSnapshot);
        for (const undo of restore.reverse()) undo();
        Governor.reset();
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
