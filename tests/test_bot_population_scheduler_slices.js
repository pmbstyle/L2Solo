process.env.BOT_DEVELOPER_DIAGNOSTICS = 'true'; // This fixture inspects optional developer metrics.
const assert = require('assert');

require('../src/Global');

const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const PopulationService = invoke('GameServer/Bot/Population/PopulationService');
const Metrics = invoke('GameServer/Bot/Population/PopulationMetrics');
const PlayerActivitySignal = invoke('GameServer/Bot/Population/PlayerActivitySignal');
const PersistentStateRetention = invoke('GameServer/Bot/Population/PersistentStateRetention');
const Database = invoke('Database');

const originalRealPlayerSessions = PopulationService.realPlayerSessions;
const originalEventLoopLag = Metrics.currentEventLoopLag;
const originalLagAbort = Config.schedulerLagAbortMs;
const originalActivityProfile = PopulationService.playerActivityProfile;
const originalStateRetention = PersistentStateRetention.runNextBatch;
const originalStateRetentionRunning = PopulationService.stateRetentionRunning;
const originalStateRetentionPassRows = PopulationService.stateRetentionPassRows;
const originalNextStateRetentionAt = PopulationService.nextStateRetentionAt;
const originalPartyFormationPending = PopulationService.partyFormationPending;
const originalDatabasePending = Database.pending;
const originalDatabaseCheckpointSnapshot = Database.checkpointSnapshot;
const originalDatabaseCheckpoint = Database.checkpoint;
const originalWalResetRunning = PopulationService.walResetRunning;
const originalNextWalResetAt = PopulationService.nextWalResetAt;

async function run() {
    PopulationService.playerActivityProfile = () => ({ protected: false, activeParty: false, realPlayers: 0, companionCount: 0, mode: 'idle' });
    Metrics.currentEventLoopLag = () => 0;
    assert.strictEqual(PopulationService.partyFormationBudgetMs(), Config.partyFormationIdleBudgetMs, 'idle party formation must use its larger budget');

    PopulationService.playerActivityProfile = () => ({ protected: true, activeParty: false, realPlayers: 1, companionCount: 0, mode: 'player' });
    assert.strictEqual(PopulationService.partyFormationBudgetMs(), Config.partyFormationPlayerBudgetMs,
        'player presence must keep a bounded background party formation budget');
    PopulationService.resolving = false;
    PopulationService.partyFormationRunning = false;
    PopulationService.partyFormationPending = false;
    assert.deepStrictEqual(await PopulationService.formBackgroundParties(), [],
        'player protection must defer the expensive background party projection');
    assert.strictEqual(PopulationService.partyFormationPending, true,
        'deferred party formation must remain pending for the next idle interval');

    PopulationService.playerActivityProfile = () => ({ protected: false, activeParty: false, realPlayers: 0, companionCount: 0, mode: 'idle' });
    const idleBudget = PopulationService.partyFormationBudgetMs();
    Metrics.currentEventLoopLag = () => Config.schedulerLagThrottleMs + 40;
    const throttledBudget = PopulationService.partyFormationBudgetMs();
    assert(throttledBudget > 0 && throttledBudget < idleBudget, 'event-loop lag must taper idle work before the hard stop');
    Config.schedulerLagAbortMs = 0;
    assert(PopulationService.partyFormationBudgetMs() < idleBudget,
        'a throttle threshold must still reduce idle work when no abort threshold is configured');
    Config.schedulerLagAbortMs = originalLagAbort;
    Metrics.currentEventLoopLag = () => Config.schedulerLagAbortMs;
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
    Database.pending = () => checkpointState.pending;
    Database.checkpointSnapshot = () => checkpointState.checkpoint;
    Database.checkpoint = async (checkpointOptions) => {
        checkpointCalls += 1;
        assert.strictEqual(checkpointOptions.mode, 'truncate');
        assert.strictEqual(checkpointOptions.busyTimeoutMs, 10);
        return { ok: true, mode: 'truncate', busy: 0, afterBytes: 300, logFrames: 20, checkpointedFrames: 20 };
    };
    PopulationService.walResetRunning = false;
    PopulationService.nextWalResetAt = 0;
    PopulationService.resolving = false;
    PopulationService.stateRetentionRunning = false;
    PopulationService.partyFormationRunning = false;
    PopulationService.playerActivityProfile = () => ({ protected: true, realPlayers: 1, connectingPlayers: 0 });
    assert.strictEqual(await PopulationService.runAdaptiveWalReset(1000), null,
        'a real player must suppress WAL reset before it is requested');
    assert.strictEqual(checkpointCalls, 0);
    PopulationService.playerActivityProfile = () => ({ protected: false, realPlayers: 0, connectingPlayers: 0 });
    const reset = await PopulationService.runAdaptiveWalReset(1000);
    assert.strictEqual(reset.mode, 'truncate');
    assert.strictEqual(checkpointCalls, 1, 'idle, drained WAL pressure must request exactly one bounded reset');
    assert(PopulationService.nextWalResetAt > 1000, 'a successful reset must install a cooldown');
    checkpointState = {
        pending: 0,
        checkpoint: {
            inFlight: false,
            last: { ok: true, mode: 'passive', busy: 0, afterBytes: 330, logFrames: 3, checkpointedFrames: 3 },
            lastReset: { ok: true, mode: 'truncate', busy: 0, afterBytes: 300, at: 1000 }
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
    assert.strictEqual(reusedGenerationReset.mode, 'truncate',
        'logical generation growth must trigger another reset even while the reused WAL file size is unchanged');
    assert.strictEqual(checkpointCalls, 2);

    let phaseLockedRetentionCalls = 0;
    PersistentStateRetention.runNextBatch = async () => {
        phaseLockedRetentionCalls += 1;
        return { policy: 'none', nextPolicy: 'none', rowsRemoved: 0, cycleComplete: false };
    };
    checkpointState = {
        pending: 0,
        checkpoint: {
            inFlight: false,
            last: { ok: true, mode: 'passive', busy: 0, afterBytes: 300, logFrames: 20, checkpointedFrames: 20 }
        }
    };
    PopulationService.nextWalResetAt = 0;
    PopulationService.stateRetentionRunning = false;
    PopulationService.nextStateRetentionAt = 0;
    const maintenanceReset = await PopulationService.runStateRetention(4000);
    assert.strictEqual(maintenanceReset.mode, 'truncate',
        'due WAL pressure must receive the maintenance timer quiet window even when intervals share a phase');
    assert.strictEqual(checkpointCalls, 3);
    assert.strictEqual(phaseLockedRetentionCalls, 0, 'state retention must yield before opening a competing transaction');

    // The truncate is tried as each passive checkpoint finishes, not on a poll
    // that can phase-lock with the checkpoint timer and always find it in flight.
    const originalOnCheckpoint = Database.onCheckpoint;
    let checkpointListener = null;
    Database.onCheckpoint = (listener) => { checkpointListener = listener; return () => { checkpointListener = null; }; };
    PopulationService.armWalReset();
    assert.strictEqual(typeof checkpointListener, 'function', 'WAL pressure must be watched from checkpoint results');
    PopulationService.walResetRunning = false;
    PopulationService.nextWalResetAt = 0;
    checkpointListener({ ok: true, mode: 'truncate', busy: 0 });
    checkpointListener({ ok: true, mode: 'passive', skipped: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(checkpointCalls, 3, 'a reset or a skipped checkpoint must not start another reset');
    checkpointListener({ ok: true, mode: 'passive', skipped: false, busy: 0, logFrames: 20, checkpointedFrames: 20 });
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(checkpointCalls, 4, 'a finished passive checkpoint under due WAL pressure must request the truncate');
    PopulationService.walResetUnsubscribe();
    assert.strictEqual(checkpointListener, null);
    PopulationService.walResetUnsubscribe = null;
    Database.onCheckpoint = originalOnCheckpoint;
    Database.pending = originalDatabasePending;
    Database.checkpointSnapshot = originalDatabaseCheckpointSnapshot;
    Database.checkpoint = originalDatabaseCheckpoint;
    Object.assign(databaseConfig, originalResetConfig);

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
    Metrics.currentEventLoopLag = () => 0;
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
        Config.schedulerLagAbortMs = originalLagAbort;
        PopulationService.realPlayerSessions = originalRealPlayerSessions;
        PopulationService.playerActivityProfile = originalActivityProfile;
        PersistentStateRetention.runNextBatch = originalStateRetention;
        PopulationService.stateRetentionRunning = originalStateRetentionRunning;
        PopulationService.stateRetentionPassRows = originalStateRetentionPassRows;
        PopulationService.nextStateRetentionAt = originalNextStateRetentionAt;
        PopulationService.partyFormationPending = originalPartyFormationPending;
        PopulationService.walResetRunning = originalWalResetRunning;
        PopulationService.nextWalResetAt = originalNextWalResetAt;
        Database.pending = originalDatabasePending;
        Database.checkpointSnapshot = originalDatabaseCheckpointSnapshot;
        Database.checkpoint = originalDatabaseCheckpoint;
        Metrics.currentEventLoopLag = originalEventLoopLag;
        PlayerActivitySignal.reset();
    });
