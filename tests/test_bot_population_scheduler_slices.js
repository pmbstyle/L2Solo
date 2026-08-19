const assert = require('assert');

require('../src/Global');

const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const PopulationService = invoke('GameServer/Bot/Population/PopulationService');
const Metrics = invoke('GameServer/Bot/Population/PopulationMetrics');
const PlayerActivitySignal = invoke('GameServer/Bot/Population/PlayerActivitySignal');
const BotWarehouse = invoke('GameServer/Bot/Economy/BotWarehouseService');
const PersistentStateRetention = invoke('GameServer/Bot/Population/PersistentStateRetention');
const Database = invoke('Database');

const originalSliceMs = Config.schedulerSliceMs;
const originalYield = PopulationService.yieldSchedulerSlice;
const originalRealPlayerSessions = PopulationService.realPlayerSessions;
const originalEventLoopLag = Metrics.currentEventLoopLag;
const originalIdleMaxResolves = Config.schedulerIdleMaxResolvesPerTick;
const originalLagAbort = Config.schedulerLagAbortMs;
const originalActivityProfile = PopulationService.playerActivityProfile;
const originalWarehouseCleanup = BotWarehouse.cleanupHistoricalBatch;
const originalWarehouseCleanupRunning = PopulationService.warehouseCleanupRunning;
const originalWarehouseCleanupCursor = PopulationService.warehouseCleanupCursor;
const originalWarehouseCleanupPassUnits = PopulationService.warehouseCleanupPassUnits;
const originalNextWarehouseCleanupAt = PopulationService.nextWarehouseCleanupAt;
const originalStateRetention = PersistentStateRetention.runNextBatch;
const originalStateRetentionRunning = PopulationService.stateRetentionRunning;
const originalStateRetentionPassRows = PopulationService.stateRetentionPassRows;
const originalNextStateRetentionAt = PopulationService.nextStateRetentionAt;
const originalDatabaseStats = Database.stats;
const originalDatabaseCheckpoint = Database.checkpoint;
const originalWalResetRunning = PopulationService.walResetRunning;
const originalNextWalResetAt = PopulationService.nextWalResetAt;
const originalLastWalResetResult = PopulationService.lastWalResetResult;

async function run() {
    const values = [];
    const yields = [];
    Config.schedulerSliceMs = 1;
    PopulationService.yieldSchedulerSlice = async (startedAt) => {
        yields.push(Date.now() - startedAt);
    };

    const results = await PopulationService.runInSchedulerSlices([1, 2, 3], async (value) => {
        await new Promise((resolve) => setTimeout(resolve, 2));
        values.push(value);
        return value * 2;
    });

    assert.deepStrictEqual(values, [1, 2, 3], 'scheduler work must stay ordered');
    assert.deepStrictEqual(results, [2, 4, 6], 'scheduler work results must be retained');
    assert.strictEqual(yields.length, 3, 'each over-budget scheduler slice must yield before more work');

    PopulationService.playerActivityProfile = () => ({ protected: false, activeParty: false, realPlayers: 0, companionCount: 0, mode: 'idle' });
    Metrics.currentEventLoopLag = () => 0;
    Config.schedulerIdleMaxResolvesPerTick = 1000;
    const idleProfile = PopulationService.schedulerProfile();
    assert.strictEqual(idleProfile.idle, true, 'no real players must select the idle scheduler profile');
    assert.strictEqual(idleProfile.budgetMs, Config.schedulerIdleBudgetMs, 'idle scheduler must use the larger background budget');
    assert.strictEqual(idleProfile.maxResolvesPerTick, 100, 'idle scheduler must not exceed the cold query cap');
    assert.strictEqual(PopulationService.partyFormationBudgetMs(), Config.partyFormationIdleBudgetMs, 'idle party formation must use its larger budget');

    PopulationService.playerActivityProfile = () => ({ protected: true, activeParty: false, realPlayers: 1, companionCount: 0, mode: 'player' });
    const playerProfile = PopulationService.schedulerProfile();
    assert.strictEqual(playerProfile.idle, false, 'a real player must select the player scheduler profile');
    assert.strictEqual(playerProfile.budgetMs, Config.schedulerPlayerBudgetMs, 'player scheduler must use the conservative budget');
    assert.strictEqual(playerProfile.maxResolvesPerTick, Config.schedulerPlayerMaxResolvesPerTick, 'player scheduler must use the smaller cold batch cap');
    assert.strictEqual(PopulationService.partyFormationBudgetMs(), Config.partyFormationPlayerBudgetMs,
        'player presence must keep a bounded background party formation budget');

    PopulationService.playerActivityProfile = () => ({ protected: true, activeParty: true, realPlayers: 1, companionCount: 8, mode: 'party' });
    const partyProfile = PopulationService.schedulerProfile();
    assert.strictEqual(partyProfile.budgetMs, Config.schedulerPartyBudgetMs, 'an active player party must receive the strictest background budget');
    assert.strictEqual(partyProfile.allowBackgroundParties, false, 'player party protection must defer background party resolves');
    assert.strictEqual(partyProfile.allowAuxiliaryBackground, false, 'player party protection must defer auxiliary background work');

    PopulationService.playerActivityProfile = () => ({ protected: false, activeParty: false, realPlayers: 0, companionCount: 0, mode: 'idle' });
    Metrics.currentEventLoopLag = () => Config.schedulerLagThrottleMs + 40;
    const throttledProfile = PopulationService.schedulerProfile();
    assert(throttledProfile.budgetMs > 0 && throttledProfile.budgetMs < idleProfile.budgetMs, 'event-loop lag must taper idle work before the hard stop');
    Config.schedulerLagAbortMs = 0;
    const throttleOnlyProfile = PopulationService.schedulerProfile();
    assert(throttleOnlyProfile.budgetMs >= 0 && throttleOnlyProfile.budgetMs < idleProfile.budgetMs,
        'a throttle threshold must still reduce idle work when no abort threshold is configured');
    Config.schedulerLagAbortMs = originalLagAbort;
    Metrics.currentEventLoopLag = () => Config.schedulerLagAbortMs;
    assert.strictEqual(PopulationService.schedulerProfile().budgetMs, 0, 'critical event-loop lag must stop background work');
    assert.strictEqual(PopulationService.partyFormationBudgetMs(), 0, 'critical event-loop lag must stop party formation too');

    const databaseConfig = options.default.Database;
    const originalResetConfig = {
        checkpointResetWalBytes: databaseConfig.checkpointResetWalBytes,
        checkpointResetGrowthBytes: databaseConfig.checkpointResetGrowthBytes,
        checkpointResetCooldownMs: databaseConfig.checkpointResetCooldownMs,
        checkpointResetRetryMs: databaseConfig.checkpointResetRetryMs,
        checkpointResetBusyTimeoutMs: databaseConfig.checkpointResetBusyTimeoutMs
    };
    Object.assign(databaseConfig, {
        checkpointResetWalBytes: 100,
        checkpointResetGrowthBytes: 50,
        checkpointResetCooldownMs: 1000,
        checkpointResetRetryMs: 100,
        checkpointResetBusyTimeoutMs: 10
    });
    let checkpointCalls = 0;
    let checkpointState = {
        pending: 0,
        checkpoint: {
            inFlight: false,
            last: { ok: true, mode: 'passive', busy: 0, afterBytes: 300, logFrames: 20, checkpointedFrames: 20 }
        }
    };
    Database.stats = () => checkpointState;
    Database.checkpoint = async (checkpointOptions) => {
        checkpointCalls += 1;
        assert.strictEqual(checkpointOptions.mode, 'restart');
        assert.strictEqual(checkpointOptions.busyTimeoutMs, 10);
        return { ok: true, mode: 'restart', busy: 0, afterBytes: 300, logFrames: 20, checkpointedFrames: 20 };
    };
    PopulationService.walResetRunning = false;
    PopulationService.nextWalResetAt = 0;
    PopulationService.lastWalResetResult = null;
    PopulationService.resolving = false;
    PopulationService.warehouseCleanupRunning = false;
    PopulationService.stateRetentionRunning = false;
    PopulationService.partyFormationRunning = false;
    PopulationService.playerActivityProfile = () => ({ protected: true, realPlayers: 1, connectingPlayers: 0 });
    assert.strictEqual(await PopulationService.runAdaptiveWalReset(1000), null,
        'a real player must suppress WAL reset before it is requested');
    assert.strictEqual(checkpointCalls, 0);
    PopulationService.playerActivityProfile = () => ({ protected: false, realPlayers: 0, connectingPlayers: 0 });
    const reset = await PopulationService.runAdaptiveWalReset(1000);
    assert.strictEqual(reset.mode, 'restart');
    assert.strictEqual(checkpointCalls, 1, 'idle, drained WAL pressure must request exactly one bounded reset');
    assert(PopulationService.nextWalResetAt > 1000, 'a successful reset must install a cooldown');
    checkpointState = {
        pending: 0,
        checkpoint: {
            inFlight: false,
            last: { ok: true, mode: 'passive', busy: 0, afterBytes: 330, logFrames: 3, checkpointedFrames: 3 },
            lastReset: { ok: true, mode: 'restart', busy: 0, afterBytes: 300, at: 1000 }
        }
    };
    PopulationService.nextWalResetAt = 0;
    assert.strictEqual(await PopulationService.runAdaptiveWalReset(3000), null,
        'a reused WAL below the growth threshold must not reset repeatedly just because its file stays large');
    assert.strictEqual(checkpointCalls, 1);
    checkpointState.checkpoint.last = {
        ok: true,
        mode: 'passive',
        busy: 0,
        afterBytes: 300,
        generationBytes: 60,
        logFrames: 6,
        checkpointedFrames: 6
    };
    PopulationService.nextWalResetAt = 0;
    const reusedGenerationReset = await PopulationService.runAdaptiveWalReset(3500);
    assert.strictEqual(reusedGenerationReset.mode, 'restart',
        'logical generation growth must trigger another reset even while the reused WAL file size is unchanged');
    assert.strictEqual(checkpointCalls, 2);

    let phaseLockedCleanupCalls = 0;
    BotWarehouse.cleanupHistoricalBatch = async () => {
        phaseLockedCleanupCalls += 1;
        return { cursor: 0, exhausted: false };
    };
    checkpointState = {
        pending: 0,
        checkpoint: {
            inFlight: false,
            last: { ok: true, mode: 'passive', busy: 0, afterBytes: 300, logFrames: 20, checkpointedFrames: 20 }
        }
    };
    PopulationService.nextWalResetAt = 0;
    PopulationService.warehouseCleanupRunning = false;
    PopulationService.stateRetentionRunning = false;
    PopulationService.nextWarehouseCleanupAt = 0;
    const maintenanceReset = await PopulationService.runWarehouseCleanup(4000);
    assert.strictEqual(maintenanceReset.mode, 'restart',
        'due WAL pressure must receive the maintenance timer quiet window even when intervals share a phase');
    assert.strictEqual(checkpointCalls, 3);
    assert.strictEqual(phaseLockedCleanupCalls, 0, 'warehouse cleanup must yield before opening a competing transaction');
    BotWarehouse.cleanupHistoricalBatch = originalWarehouseCleanup;
    Database.stats = originalDatabaseStats;
    Database.checkpoint = originalDatabaseCheckpoint;
    Object.assign(databaseConfig, originalResetConfig);

    let cleanupCalls = 0;
    BotWarehouse.cleanupHistoricalBatch = async (options) => {
        cleanupCalls += 1;
        return { cursor: 77, exhausted: false, ownersScanned: 1, ownersCompacted: 1, rowsRemoved: 2, units: 2, payout: 100, options };
    };
    PopulationService.warehouseCleanupRunning = false;
    PopulationService.warehouseCleanupCursor = 0;
    PopulationService.warehouseCleanupPassUnits = 0;
    PopulationService.nextWarehouseCleanupAt = 0;
    PopulationService.playerActivityProfile = () => ({ protected: true, activeParty: false, realPlayers: 1, companionCount: 0, mode: 'player' });
    Metrics.currentEventLoopLag = () => 0;
    assert.strictEqual(await PopulationService.runWarehouseCleanup(1000), null,
        'historical warehouse cleanup must be completely disabled during player protection');
    assert.strictEqual(cleanupCalls, 0);

    PopulationService.playerActivityProfile = () => ({ protected: false, activeParty: false, realPlayers: 0, companionCount: 0, mode: 'idle' });
    const cleanup = await PopulationService.runWarehouseCleanup(2000);
    assert.strictEqual(cleanupCalls, 1, 'idle maintenance may advance one bounded historical cleanup batch');
    assert.strictEqual(cleanup.cursor, 77);
    assert.strictEqual(cleanup.options.ownerLimit, 1, 'one scheduler tick must perform at most one cleanup transaction');
    assert.strictEqual(cleanup.options.maxUnitsPerOwner, 32);
    assert.strictEqual(PopulationService.warehouseCleanupCursor, 77);

    let retentionCalls = 0;
    PersistentStateRetention.runNextBatch = async (options) => {
        retentionCalls += 1;
        return {
            policy: 'activity_pair_cap',
            nextPolicy: 'activity_global_cap',
            rowsRemoved: 4,
            cycleComplete: false,
            options
        };
    };
    PopulationService.stateRetentionRunning = false;
    PopulationService.stateRetentionPassRows = 0;
    PopulationService.nextStateRetentionAt = 0;
    PopulationService.playerActivityProfile = () => ({ protected: true, activeParty: false, realPlayers: 1, companionCount: 0, mode: 'player' });
    assert.strictEqual(await PopulationService.runStateRetention(3000), null,
        'persistent-state retention must be completely disabled during player protection');
    assert.strictEqual(retentionCalls, 0);

    PopulationService.playerActivityProfile = () => ({ protected: false, activeParty: false, realPlayers: 0, companionCount: 0, mode: 'idle' });
    const retention = await PopulationService.runStateRetention(4000);
    assert.strictEqual(retentionCalls, 1, 'idle maintenance may execute one retention statement');
    assert.strictEqual(retention.rowsRemoved, 4);
    assert.strictEqual(retention.options.batchSize, Config.stateRetentionBatchSize);
    assert.strictEqual(PopulationService.stateRetentionPassRows, 4);

    PopulationService.warehouseCleanupRunning = true;
    assert.strictEqual(await PopulationService.runStateRetention(5000), null,
        'retention and warehouse compaction must not enqueue concurrent maintenance writes');
    assert.strictEqual(retentionCalls, 1);
    PopulationService.warehouseCleanupRunning = false;

    PlayerActivitySignal.reset();
    const connecting = PlayerActivitySignal.observe({
        sessions: [{ constructor: { name: 'Session' }, accountId: null, actor: null }],
        now: 500,
        graceMs: 30000
    });
    assert.strictEqual(connecting.mode, 'connecting', 'an unauthenticated real socket must protect the main loop before an actor exists');
    assert.strictEqual(connecting.connectingPlayers, 1);
    assert.strictEqual(connecting.protected, true);
    const player = {
        constructor: { name: 'Session' },
        accountId: 'player_1',
        actor: { fetchIsOnline: () => true }
    };
    const companion = {
        constructor: { name: 'BotSession' },
        accountId: 'bot_companion',
        actor: { fetchIsOnline: () => true },
        partyCompanion: true,
        followPlayerSession: player
    };
    const simulated = {
        constructor: { name: 'SimPlayer' },
        accountId: 'simulated_player',
        actor: { fetchIsOnline: () => true },
        isSimPlayer: true
    };
    const active = PlayerActivitySignal.observe({ sessions: [player, companion, simulated], now: 1000, graceMs: 30000 });
    assert.strictEqual(active.realPlayers, 1, 'SimPlayer and BotSession identities must not count as real players');
    assert.strictEqual(active.activeParty, true, 'a real leader with an attached companion must activate party protection');
    const grace = PlayerActivitySignal.observe({ sessions: [], now: 20000, graceMs: 30000 });
    assert.strictEqual(grace.mode, 'grace', 'hot-path protection must survive a short disconnect/relog window');
    const expired = PlayerActivitySignal.observe({ sessions: [], now: 32000, graceMs: 30000 });
    assert.strictEqual(expired.mode, 'idle', 'idle background capacity must return after the protection window');

    Metrics.recordSkippedResolve('test_missing_spot');
    Metrics.recordSkippedResolve('test_missing_spot');
    Metrics.recordSkippedResolve('test_joined_party');
    const skipped = Metrics.snapshot().skippedResolveReasons;
    assert.deepStrictEqual(skipped, { test_missing_spot: 2, test_joined_party: 1 }, 'scheduler telemetry must retain per-reason skipped resolve counts');
    console.log('Bot population scheduler slice checks passed');
}

run()
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => {
        Config.schedulerSliceMs = originalSliceMs;
        Config.schedulerIdleMaxResolvesPerTick = originalIdleMaxResolves;
        Config.schedulerLagAbortMs = originalLagAbort;
        PopulationService.yieldSchedulerSlice = originalYield;
        PopulationService.realPlayerSessions = originalRealPlayerSessions;
        PopulationService.playerActivityProfile = originalActivityProfile;
        BotWarehouse.cleanupHistoricalBatch = originalWarehouseCleanup;
        PopulationService.warehouseCleanupRunning = originalWarehouseCleanupRunning;
        PopulationService.warehouseCleanupCursor = originalWarehouseCleanupCursor;
        PopulationService.warehouseCleanupPassUnits = originalWarehouseCleanupPassUnits;
        PopulationService.nextWarehouseCleanupAt = originalNextWarehouseCleanupAt;
        PersistentStateRetention.runNextBatch = originalStateRetention;
        PopulationService.stateRetentionRunning = originalStateRetentionRunning;
        PopulationService.stateRetentionPassRows = originalStateRetentionPassRows;
        PopulationService.nextStateRetentionAt = originalNextStateRetentionAt;
        PopulationService.walResetRunning = originalWalResetRunning;
        PopulationService.nextWalResetAt = originalNextWalResetAt;
        PopulationService.lastWalResetResult = originalLastWalResetResult;
        Database.stats = originalDatabaseStats;
        Database.checkpoint = originalDatabaseCheckpoint;
        Metrics.currentEventLoopLag = originalEventLoopLag;
        PlayerActivitySignal.reset();
    });
