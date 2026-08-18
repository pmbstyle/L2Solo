const assert = require('assert');

require('../src/Global');

const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const PopulationService = invoke('GameServer/Bot/Population/PopulationService');
const Metrics = invoke('GameServer/Bot/Population/PopulationMetrics');
const PlayerActivitySignal = invoke('GameServer/Bot/Population/PlayerActivitySignal');

const originalSliceMs = Config.schedulerSliceMs;
const originalYield = PopulationService.yieldSchedulerSlice;
const originalRealPlayerSessions = PopulationService.realPlayerSessions;
const originalEventLoopLag = Metrics.currentEventLoopLag;
const originalIdleMaxResolves = Config.schedulerIdleMaxResolvesPerTick;
const originalLagAbort = Config.schedulerLagAbortMs;
const originalActivityProfile = PopulationService.playerActivityProfile;

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

    PlayerActivitySignal.reset();
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
        Metrics.currentEventLoopLag = originalEventLoopLag;
        PlayerActivitySignal.reset();
    });
