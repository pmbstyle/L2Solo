const DEFAULTS = {
    enabled: true,
    staticBuyersDisabled: false,
    // C4: no NPC sells D-S shots (l2hub C4 shops, Lisvus merchant_buylists,
    // Mobius buylists: only the GM shop); crafters make them.
    staticShotsDisabled: true,
    developerDiagnostics: false,
    // The decision trace (Bot/DecisionTrace): its own switch, not under developerDiagnostics.
    decisionTrace: false,
    // Personal knowledge errors and learning by own actions share one switch.
    knowledgeErrorsEnabled: true,
    backgroundResolverEnabled: true,
    backgroundPartyEnabled: true,
    opportunisticRaidsEnabled: true,
    opportunisticRaidIntervalMs: 15 * 60000,
    opportunisticRaidMemberCooldownMs: 30 * 60000,
    opportunisticRaidMaxParties: 2,
    opportunisticRaidAliveFraction: 0.5,
    opportunisticRaidMaxFightSeconds: 720,
    opportunisticRaidShotReserve: 1.3,
    opportunisticRaidExpeditionMs: 45 * 60000,
    phasePolicyEnabled: true,
    summaryIntervalMs: 30000,
    // How often the player-activity and lag signal is published (the cold
    // worker pressure and the background work admissions read it).
    schedulerIntervalMs: 5000,
    // One cooperative main-thread slice of background work.
    schedulerSliceMs: 12,
    coldOwnerResolveTimeoutMs: 10000,
    coldWorkerBatchSize: 64,
    coldWorkerCommitBatchSize: 32,
    // Cold simulation remains alive while a player is online, but its IPC
    // and commit burst must yield the main event loop to player traffic:
    // main commits each half of the window (8 rows) while the other half runs.
    coldWorkerPlayerMaxInFlight: 16,
    coldWorkerLagMaxInFlight: 2,
    // Resolver work is serialized inside the worker. Keep the lease window
    // bounded so a catch-up burst cannot create a large queue of expiring
    // claims while preserving the full candidate throughput on later ticks.
    coldWorkerMaxInFlight: 32,
    coldWorkerOrdinaryFlushMs: 2000,
    coldWorkerOrdinaryHardMaxMs: 5000,
    coldWorkerCriticalFlushMs: 100,
    coldWorkerHeartbeatMs: 1000,
    coldWorkerUnhealthyMs: 5000,
    coldWorkerDeadMs: 10000,
    coldWorkerBootMs: 60000,
    coldWorkerLoopIntervalMs: 20,
    coldWorkerSnapshotRefreshMs: 10000,
    coldWorkerSnapshotPageSize: 48,
    coldWorkerSnapshotPlayerPageSize: 32,
    coldWorkerSnapshotMaxDeferralMs: 5000,
    coldWorkerSnapshotLagThrottleMs: 40,
    coldWorkerSnapshotLagAbortMs: 120,
    coldWorkerQueueMaxEntries: 1024,
    coldWorkerQueueMaxBytes: 4 * 1024 * 1024,
    // A full 1,700-bot world with warm economic caches exceeds 256 MiB
    // after major GC. Leave headroom for transient plan-build and clone allocations.
    coldWorkerHeapMb: 512,
    // The worker's young generation, three semi-spaces. V8's 48 MB let a plan
    // build's short-lived objects reach the old space: a major GC every 3 s
    // (gc-trace 11-01). Restart to apply.
    coldWorkerYoungMb: 192,
    // The clan planning worker (ClanPlanningCoordinator): live heap 59-81 MB at
    // 1,700 bots, but with no cap V8 kept 209 MB committed (memory census
    // 11-05). Young generation at V8's 48 MB. Restart to apply.
    clanWorkerHeapMb: 256,
    clanWorkerYoungMb: 48,
    // Diagnostics: the cold worker writes one heap snapshot per server boot as its heap nears
    // coldWorkerHeapMb (into tmp/heap/ of the server root). Off by default; restart to apply.
    coldWorkerHeapSnapshot: false,
    // Protect the player-facing loop immediately and keep it protected for a
    // short window after disconnect/relog. SimPlayer/BotSession instances do
    // not contribute to this signal.
    playerProtectionGraceMs: 30000,
    // Above this lag, taper background work before the hard stop below. A
    // gradual throttle avoids turning one noisy sample into a long backlog.
    schedulerLagThrottleMs: 40,
    schedulerLagAbortMs: 120,
    backgroundGovernorEnabled: true,
    backgroundJobTickMs: 250,
    backgroundGovernorWindowMs: 1000,
    backgroundGovernorIdleBudgetMs: 250,
    backgroundGovernorPlayerBudgetMs: 80,
    backgroundGovernorIdleDbQueueMax: 8,
    backgroundGovernorPlayerDbQueueMax: 8,
    backgroundGovernorLagAbortMs: 120,
    partyFormationIdleBudgetMs: 3000,
    // With a player online a forming pass starts no new recruit or roster past 25 ms
    // (one party a pass at most) and waits out main's writes (membershipWritesWait).
    partyFormationPlayerBudgetMs: 25,
    partyFormationSliceMs: 12,
    // Existing cold population predates full class progression. Reconcile it
    // in small batches so restart never becomes a database migration spike.
    classProgressionMigrationIntervalMs: 10000,
    classProgressionMigrationBatchSize: 5,
    phasePolicyIntervalMs: 10000,
    // Start with every level-one hunting sector. Waves open every five levels
    // at x1-x10, or every ten levels at x50 and above. This is a cap for
    // generated adventurers only; shop services are not part of it.
    maxPlayingPopulation: 1700,
    starterBotsPerRace: 30,
    // New bots' starting classes by weight (PopulationIntakePolicy.classWeights).
    classMix: 'humanFighter:18,humanMystic:4,elfFighter:16,elfMystic:6,darkFighter:17,darkMystic:6,orcFighter:16,orcMystic:5,dwarf:12',
    generatedColdBatchSize: 50,
    generatedColdSeedDelayMs: 45000,
    // Append-only diagnostics and AI memory have explicit lifecycles. Run a
    // single indexed delete statement per idle tick, delayed after start so it
    // never joins the startup write burst.
    stateRetentionEnabled: true,
    stateRetentionStartDelayMs: 90000,
    stateRetentionIntervalMs: 1000,
    stateRetentionPassPauseMs: 60000,
    // After a pass that removed nothing (not a server without players): a pass is ~12 bounded statements.
    stateRetentionIdlePauseMs: 10 * 60 * 1000,
    stateRetentionBatchSize: 64,
    stateRetentionBudgetMs: 12,
    activityJournalRetentionMs: 30 * 24 * 60 * 60 * 1000,
    activityJournalRowsPerPair: 128,
    activityJournalMaxRows: 100000,
    aiAuditRetentionMs: 30 * 24 * 60 * 60 * 1000,
    toolOutcomeMaxRows: 50000,
    llmTurnMaxRows: 50000,
    staleLlmTurnMs: 7 * 24 * 60 * 60 * 1000,
    compactedConversationRetentionMs: 24 * 60 * 60 * 1000,
    conversationMaxUncompactedRows: 512,
    // Idle formation can fill six parties per pass; live-player protection
    // still caps the same pass at one party in PopulationService.
    partyFormationBatchSize: 6,
    // The spot aggregate's outcomes (SpotContest, EnemyMet) reach main in a
    // frame; main-process actions validate and commit cooperation, resource
    // interruptions and optional bounded PvP.
    coldCompetitionActionsEnabled: true,
    coldCompetitionConflictsEnabled: true,
    coldCompetitionPvpEnabled: true,
    pvpAggression: 0.5,
    partyMinSize: 2,
    partyMaxSize: 5,
    // Dissolved party rows are operational history, not durable state. Keep
    // a short diagnostic window without allowing every rotation to grow the
    // population database forever.
    partyHistoryRetentionMs: 24 * 60 * 60 * 1000,
    partyHistoryCleanupBatchSize: 1000,
    partyHistoryCleanupIntervalMs: 60 * 60 * 1000,
    cooldownGraceMs: 120000,
    cooldownBatchSize: 20,
    // A body cools past cooldownRadius, at least the hysteresis (HOT_HYSTERESIS, keepHotRadius)
    // beyond activationRadius.
    cooldownRadius: 9000,
    // A bot turns into a body within this radius of a player: the client's view (6000) plus
    // one 10 s activation scan of a running player (160 u/s), so a bot is a body before the
    // player sees it. Our choice: C4 characters act whether seen or not; the radii are ours.
    activationRadius: 7600,
    maxActivationsPerScan: 6,
    activationPlacementRadius: 1400,
    activationMinPlayerDistance: 450,
    activationPlacementAttempts: 8,
    // Ambient activation is still selected by the broad XY envelope, but
    // suspicious vertical separation must prove visibility before a cold bot
    // is materialized. Checks are capped per scan and cached by geodata cell.
    activationFloorDirectZ: 1200,
    activationFloorGeoChecksPerScan: 24,
    activationFloorCacheMs: 30000,
    activationFloorCacheLimit: 2048,
    globalChatEnabled: true,
    clanChatEnabled: true,
    clanChatMinIntervalMs: 15000,
    chatReactionsEnabled: true,
    chatReactionChance: 0.45,
    globalChatChance: 0.015,
    globalChatImportantChance: 0.25,
    // Shared traffic budget, including replies, regardless of population size.
    globalChatMinIntervalMs: 18000,
    globalChatTopicIntervalMs: 120000,
    marketTradeChatEnabled: true,
    marketTradeChatIntervalMs: 8 * 60 * 1000,
    marketTradeChatGlobalMinIntervalMs: 100000,
    devLogPlayerChat: true,
    resolveSlowMs: 250,
    resolveSampleLimit: 200,
    eventLoopSampleMs: 1000,
    slowEventLoopLagMs: 75
};

const ENV_KEYS = {
    developerDiagnostics: 'BOT_DEVELOPER_DIAGNOSTICS',
    staticBuyersDisabled: 'BOT_STATIC_BUYERS_DISABLED',
    staticShotsDisabled: 'BOT_STATIC_SHOTS_DISABLED',
    knowledgeErrorsEnabled: 'BOT_KNOWLEDGE_ERRORS_ENABLED',
    pvpAggression: 'BOT_PVP_AGGRESSION',
    enabled: 'BOT_POPULATION_ENABLED',
    backgroundResolverEnabled: 'BOT_BACKGROUND_RESOLVER_ENABLED',
    backgroundPartyEnabled: 'BOT_BACKGROUND_PARTY_ENABLED',
    phasePolicyEnabled: 'BOT_POPULATION_PHASE_POLICY_ENABLED',
    maxPlayingPopulation: 'BOT_POPULATION_MAX_PLAYING',
    starterBotsPerRace: 'BOT_POPULATION_STARTER_BOTS_PER_RACE',
    generatedColdBatchSize: 'BOT_POPULATION_BATCH_SIZE',
    generatedColdSeedDelayMs: 'BOT_POPULATION_SEED_DELAY_MS',
    cooldownGraceMs: 'BOT_COOLDOWN_GRACE_MS',
    cooldownRadius: 'BOT_COOLDOWN_RADIUS',
    activationRadius: 'BOT_ACTIVATION_RADIUS',
    maxActivationsPerScan: 'BOT_MAX_ACTIVATIONS_PER_SCAN',
    activationFloorDirectZ: 'BOT_ACTIVATION_FLOOR_DIRECT_Z',
    activationFloorGeoChecksPerScan: 'BOT_ACTIVATION_FLOOR_GEO_CHECKS_PER_SCAN',
    activationFloorCacheMs: 'BOT_ACTIVATION_FLOOR_CACHE_MS',
    activationFloorCacheLimit: 'BOT_ACTIVATION_FLOOR_CACHE_LIMIT',
    schedulerSliceMs: 'BOT_POPULATION_SCHEDULER_SLICE_MS',
    coldOwnerResolveTimeoutMs: 'BOT_POPULATION_COLD_OWNER_TIMEOUT_MS',
    coldWorkerBatchSize: 'BOT_POPULATION_COLD_WORKER_BATCH_SIZE',
    coldWorkerCommitBatchSize: 'BOT_POPULATION_COLD_WORKER_COMMIT_BATCH_SIZE',
    coldWorkerMaxInFlight: 'BOT_POPULATION_COLD_WORKER_MAX_IN_FLIGHT',
    coldWorkerOrdinaryFlushMs: 'BOT_POPULATION_COLD_WORKER_FLUSH_MS',
    coldWorkerOrdinaryHardMaxMs: 'BOT_POPULATION_COLD_WORKER_HARD_MAX_MS',
    coldWorkerCriticalFlushMs: 'BOT_POPULATION_COLD_WORKER_CRITICAL_MS',
    coldWorkerHeartbeatMs: 'BOT_POPULATION_COLD_WORKER_HEARTBEAT_MS',
    coldWorkerUnhealthyMs: 'BOT_POPULATION_COLD_WORKER_UNHEALTHY_MS',
    coldWorkerDeadMs: 'BOT_POPULATION_COLD_WORKER_DEAD_MS',
    coldWorkerBootMs: 'BOT_POPULATION_COLD_WORKER_BOOT_MS',
    coldWorkerLoopIntervalMs: 'BOT_POPULATION_COLD_WORKER_LOOP_MS',
    coldWorkerSnapshotRefreshMs: 'BOT_POPULATION_COLD_WORKER_SNAPSHOT_MS',
    coldWorkerSnapshotPageSize: 'BOT_POPULATION_COLD_WORKER_SNAPSHOT_PAGE_SIZE',
    coldWorkerSnapshotPlayerPageSize: 'BOT_POPULATION_COLD_WORKER_SNAPSHOT_PLAYER_PAGE_SIZE',
    coldWorkerSnapshotMaxDeferralMs: 'BOT_POPULATION_COLD_WORKER_SNAPSHOT_MAX_DEFERRAL_MS',
    coldWorkerSnapshotLagThrottleMs: 'BOT_POPULATION_COLD_WORKER_SNAPSHOT_LAG_THROTTLE_MS',
    coldWorkerSnapshotLagAbortMs: 'BOT_POPULATION_COLD_WORKER_SNAPSHOT_LAG_ABORT_MS',
    coldWorkerQueueMaxEntries: 'BOT_POPULATION_COLD_WORKER_QUEUE_ENTRIES',
    coldWorkerQueueMaxBytes: 'BOT_POPULATION_COLD_WORKER_QUEUE_BYTES',
    coldWorkerHeapMb: 'BOT_POPULATION_COLD_WORKER_HEAP_MB',
    coldWorkerYoungMb: 'BOT_POPULATION_COLD_WORKER_YOUNG_MB',
    clanWorkerHeapMb: 'BOT_POPULATION_CLAN_WORKER_HEAP_MB',
    clanWorkerYoungMb: 'BOT_POPULATION_CLAN_WORKER_YOUNG_MB',
    coldWorkerHeapSnapshot: 'BOT_POPULATION_COLD_WORKER_HEAP_SNAPSHOT',
    playerProtectionGraceMs: 'BOT_POPULATION_PLAYER_PROTECTION_GRACE_MS',
    schedulerLagThrottleMs: 'BOT_POPULATION_SCHEDULER_LAG_THROTTLE_MS',
    schedulerLagAbortMs: 'BOT_POPULATION_SCHEDULER_LAG_ABORT_MS',
    backgroundGovernorEnabled: 'BOT_BACKGROUND_GOVERNOR_ENABLED',
    backgroundJobTickMs: 'BOT_BACKGROUND_JOB_TICK_MS',
    backgroundGovernorWindowMs: 'BOT_BACKGROUND_GOVERNOR_WINDOW_MS',
    backgroundGovernorIdleBudgetMs: 'BOT_BACKGROUND_GOVERNOR_IDLE_BUDGET_MS',
    backgroundGovernorPlayerBudgetMs: 'BOT_BACKGROUND_GOVERNOR_PLAYER_BUDGET_MS',
    backgroundGovernorIdleDbQueueMax: 'BOT_BACKGROUND_GOVERNOR_IDLE_DB_QUEUE_MAX',
    backgroundGovernorPlayerDbQueueMax: 'BOT_BACKGROUND_GOVERNOR_PLAYER_DB_QUEUE_MAX',
    backgroundGovernorLagAbortMs: 'BOT_BACKGROUND_GOVERNOR_LAG_ABORT_MS',
    partyFormationIdleBudgetMs: 'BOT_POPULATION_PARTY_FORMATION_IDLE_BUDGET_MS',
    partyFormationPlayerBudgetMs: 'BOT_POPULATION_PARTY_FORMATION_PLAYER_BUDGET_MS',
    marketTradeChatEnabled: 'BOT_MARKET_TRADE_CHAT_ENABLED',
    marketTradeChatIntervalMs: 'BOT_MARKET_TRADE_CHAT_INTERVAL_MS',
    marketTradeChatGlobalMinIntervalMs: 'BOT_MARKET_TRADE_CHAT_GLOBAL_MIN_INTERVAL_MS',
    partyHistoryRetentionMs: 'BOT_PARTY_HISTORY_RETENTION_MS',
    partyHistoryCleanupBatchSize: 'BOT_PARTY_HISTORY_CLEANUP_BATCH_SIZE',
    partyHistoryCleanupIntervalMs: 'BOT_PARTY_HISTORY_CLEANUP_INTERVAL_MS',
    stateRetentionEnabled: 'BOT_STATE_RETENTION_ENABLED',
    stateRetentionStartDelayMs: 'BOT_STATE_RETENTION_START_DELAY_MS',
    stateRetentionIntervalMs: 'BOT_STATE_RETENTION_INTERVAL_MS',
    stateRetentionPassPauseMs: 'BOT_STATE_RETENTION_PASS_PAUSE_MS',
    stateRetentionIdlePauseMs: 'BOT_STATE_RETENTION_IDLE_PAUSE_MS',
    stateRetentionBatchSize: 'BOT_STATE_RETENTION_BATCH_SIZE',
    stateRetentionBudgetMs: 'BOT_STATE_RETENTION_BUDGET_MS',
    activityJournalRetentionMs: 'BOT_ACTIVITY_JOURNAL_RETENTION_MS',
    activityJournalRowsPerPair: 'BOT_ACTIVITY_JOURNAL_ROWS_PER_PAIR',
    activityJournalMaxRows: 'BOT_ACTIVITY_JOURNAL_MAX_ROWS',
    aiAuditRetentionMs: 'BOT_AI_AUDIT_RETENTION_MS',
    toolOutcomeMaxRows: 'BOT_TOOL_OUTCOME_MAX_ROWS',
    llmTurnMaxRows: 'BOT_LLM_TURN_MAX_ROWS',
    staleLlmTurnMs: 'BOT_STALE_LLM_TURN_MS',
    compactedConversationRetentionMs: 'BOT_COMPACTED_CONVERSATION_RETENTION_MS',
    conversationMaxUncompactedRows: 'BOT_CONVERSATION_MAX_UNCOMPACTED_ROWS',
    devLogPlayerChat: 'BOT_DEV_LOG_PLAYER_CHAT'
};

function asBoolean(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;

    const normalized = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return fallback;
}

function asNumber(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function coerceValue(value, fallback) {
    if (typeof fallback === 'boolean') return asBoolean(value, fallback);
    if (typeof fallback === 'number') return asNumber(value, fallback);
    return value === undefined || value === null || value === '' ? fallback : value;
}

function applyOverrides(base, overrides) {
    Object.keys(overrides || {}).forEach((key) => {
        if (!Object.prototype.hasOwnProperty.call(base, key)) return;
        base[key] = coerceValue(overrides[key], base[key]);
    });

    return base;
}

function envOverrides() {
    return Object.keys(ENV_KEYS).reduce((overrides, key) => {
        const value = process.env[ENV_KEYS[key]];
        if (value !== undefined) overrides[key] = value;
        return overrides;
    }, {});
}

const fileOverrides = global.options?.default?.BotPopulation || {};
const PopulationConfig = applyOverrides(
    applyOverrides({ ...DEFAULTS }, fileOverrides),
    envOverrides()
);
PopulationConfig.maxPlayingPopulation = Math.max(0, Math.min(2000, Math.floor(Number(PopulationConfig.maxPlayingPopulation) || 0)));
PopulationConfig.pvpAggression = require('../../Social/PvpAggression').normalize(PopulationConfig.pvpAggression);
// A worker's V8 heap caps (new Worker resourceLimits) from its two keys
// (coldWorkerHeapMb/coldWorkerYoungMb, clanWorkerHeapMb/clanWorkerYoungMb): a
// value that is not a number falls back to the key's default, floors at
// 128 MB old and V8's 48 MB young. Not enumerable: the config stays data.
Object.defineProperty(PopulationConfig, 'workerResourceLimits', {
    value: (heapKey, youngKey) => ({
        maxOldGenerationSizeMb: Math.max(128, Number(PopulationConfig[heapKey]) || DEFAULTS[heapKey]),
        maxYoungGenerationSizeMb: Math.max(48, Number(PopulationConfig[youngKey]) || DEFAULTS[youngKey])
    })
});

// How far a body cools beyond the activation ring at the least, so a body near the ring's edge
// does not flip hot and cold as the player steps (our choice: one scan's run past the view).
const HOT_HYSTERESIS = 1400;

// How far from every player a hot body stays hot and thinks: cooldownRadius, and never closer
// than the hysteresis past activationRadius (the launcher sets activationRadius alone, so a large
// one would otherwise reach the cooldown ring and leave no hysteresis). Read at the call, not
// normalised at load: tests set the radii directly. Not enumerable: the config stays data.
Object.defineProperty(PopulationConfig, 'keepHotRadius', {
    value: (config = PopulationConfig) => Math.max(Number(config.cooldownRadius) || 0, (Number(config.activationRadius) || 0) + HOT_HYSTERESIS)
});

module.exports = PopulationConfig;
