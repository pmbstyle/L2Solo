const DEFAULTS = {
    enabled: true,
    backgroundResolverEnabled: true,
    backgroundPartyEnabled: true,
    phasePolicyEnabled: true,
    directorEnabled: true,
    summaryIntervalMs: 30000,
    schedulerIntervalMs: 5000,
    // Cold simulation is invisible to players. Keep its total throughput
    // bounded, while allowing a larger catch-up slice when no real player is
    // online. The player-aware budget remains intentionally conservative.
    schedulerSliceMs: 12,
    schedulerIdleBudgetMs: 2500,
    schedulerPlayerBudgetMs: 100,
    schedulerPartyBudgetMs: 75,
    schedulerIdleMaxResolvesPerTick: 100,
    schedulerPlayerMaxResolvesPerTick: 12,
    // Goal metadata is repaired in short cooperative slices. Keep the
    // player pass bounded, but let a restart backlog converge in minutes
    // instead of leaving thousands of due rows stale for hours.
    goalMetadataReconcileIntervalMs: 10000,
    goalMetadataIdleBatchSize: 32,
    goalMetadataPlayerBatchSize: 16,
    goalMetadataIdleBudgetMs: 1000,
    goalMetadataPlayerBudgetMs: 200,
    coldOwnerLeaseMs: 30000,
    coldOwnerResolveTimeoutMs: 10000,
    coldOwnerRenewalIntervalMs: 5000,
    coldOwnerRecoveryIntervalMs: 5000,
    coldWorkerBatchSize: 64,
    coldWorkerCommitBatchSize: 32,
    // Cold simulation remains alive while a player is online, but its IPC
    // and commit burst must yield the main event loop to player traffic.
    coldWorkerPlayerMaxInFlight: 8,
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
    coldWorkerLoopIntervalMs: 20,
    coldWorkerSnapshotRefreshMs: 10000,
    coldWorkerSnapshotPageSize: 48,
    coldWorkerSnapshotPlayerPageSize: 32,
    coldWorkerSnapshotMaxDeferralMs: 5000,
    coldWorkerSnapshotLagThrottleMs: 40,
    coldWorkerSnapshotLagAbortMs: 120,
    coldWorkerQueueMaxEntries: 1024,
    coldWorkerQueueMaxBytes: 4 * 1024 * 1024,
    coldWorkerHeapMb: 256,
    // Protect the player-facing loop immediately and keep it protected for a
    // short window after disconnect/relog. SimPlayer/BotSession instances do
    // not contribute to this signal.
    playerProtectionGraceMs: 30000,
    // Above this lag, taper background work before the hard stop below. A
    // gradual throttle avoids turning one noisy sample into a long backlog.
    schedulerLagThrottleMs: 40,
    schedulerLagAbortMs: 120,
    partyFormationIdleBudgetMs: 3000,
    partyFormationPlayerBudgetMs: 600,
    partyFormationSliceMs: 12,
    // Existing cold population predates full class progression. Reconcile it
    // in small batches so restart never becomes a database migration spike.
    classProgressionMigrationIntervalMs: 10000,
    classProgressionMigrationBatchSize: 5,
    coldCombatProfileMigrationIntervalMs: 10000,
    coldCombatProfileMigrationBatchSize: 5,
    // One-off migration for stores created before market towns were split.
    // It is deliberately independent from the normal cold-resolve budget.
    marketTownMigrationIntervalMs: 10000,
    marketTownMigrationBatchSize: 10,
    marketExpiryCleanupIntervalMs: 10000,
    marketExpiryCleanupBatchSize: 10,
    partyFormationIntervalMs: 45000,
    // Party requests are orthogonal to activity.  This is the slow safety
    // replan/review cadence, not a period during which the bot is blocked.
    partyWaitReplanMs: 5 * 60 * 1000,
    phasePolicyIntervalMs: 10000,
    directorIntervalMs: 30000,
    // Start with every level-one hunting sector. Waves open every five levels
    // at x1-x10, or every ten levels at x50 and above. This is a cap for
    // generated adventurers only; shop services are not part of it.
    maxPlayingPopulation: 1700,
    starterBotsPerRace: 30,
    generatedColdBatchSize: 50,
    generatedColdSeedDelayMs: 45000,
    // The persistent world is resolved in bounded batches so population
    // expansion never becomes a database spike after a restart.
    maxResolvesPerTick: 25,
    maxPartyResolvesPerTick: 3,
    maxMarketGoalReconcilesPerTick: 8,
    maxWarehouseReleasesPerTick: 8,
    // Historical gear debt is repaired only while the server is player-idle.
    // Each pass advances by owner id and performs at most one tiny atomic
    // transaction per owner, so cleanup cannot become a startup table sweep.
    warehouseCleanupEnabled: true,
    warehouseCleanupStartDelayMs: 60000,
    warehouseCleanupIntervalMs: 500,
    warehouseCleanupPassPauseMs: 60000,
    warehouseCleanupIdlePauseMs: 6 * 60 * 60 * 1000,
    warehouseCleanupOwnersPerTick: 1,
    warehouseCleanupUnitsPerOwner: 32,
    warehouseCleanupBudgetMs: 12,
    // Append-only diagnostics and AI memory have explicit lifecycles. Run a
    // single indexed delete statement per idle tick and stagger it behind the
    // warehouse repair so both jobs never form a startup write burst.
    stateRetentionEnabled: true,
    stateRetentionStartDelayMs: 90000,
    stateRetentionIntervalMs: 1000,
    stateRetentionPassPauseMs: 60000,
    stateRetentionIdlePauseMs: 6 * 60 * 60 * 1000,
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
    partyMinSize: 2,
    partyMaxSize: 5,
    // At roughly one party resolve per 90 seconds, forty parties consume
    // about 27 of the 36 bounded resolves available each minute.  This opens
    // enough party-wait capacity without increasing work in a scheduler tick.
    maxBackgroundParties: 40,
    // A required request is actionable work, not a reason to wait forever.
    // Open a few bounded party slots as soon as several compatible requests
    // accumulate; the old 250-request threshold was unreachable for this
    // population and left persistent parties above the nominal base cap.
    partyBacklogCapacityThreshold: 10,
    partyBacklogCapacityStep: 4,
    partyBacklogCapacityMaxExtra: 16,
    partyRequestMaxAgeMs: 15 * 60 * 1000,
    partyPreferredMaxAgeMs: 5 * 60 * 1000,
    partyRequestCooldownMs: 5 * 60 * 1000,
    partyRequestCleanupIntervalMs: 30000,
    partyRequestCleanupBatchSize: 100,
    // A background party is a time slice, not a permanent ownership claim on
    // its members. Rotate old groups so stale objectives and role gaps can be
    // re-matched without increasing the number of simultaneous groups.
    partySessionMaxMs: 20 * 60 * 1000,
    partyRequirementRefreshMs: 5 * 60 * 1000,
    partyRequirementRefreshBatchSize: 2,
    partySessionJitterMs: 5 * 60 * 1000,
    // Dissolved party rows are operational history, not durable state. Keep
    // a short diagnostic window without allowing every rotation to grow the
    // population database forever.
    partyHistoryRetentionMs: 24 * 60 * 60 * 1000,
    partyHistoryCleanupBatchSize: 1000,
    partyHistoryCleanupIntervalMs: 60 * 60 * 1000,
    cooldownGraceMs: 120000,
    cooldownBatchSize: 20,
    cooldownRadius: 11000,
    activationRadius: 9000,
    activationLevelRange: 5,
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
    directorTargetBandRadius: 2,
    directorMaxCatchUpMultiplier: 1.35,
    directorSlowdownMultiplier: 0.85,
    newbieAnchorMaxLevel: 5,
    newbieAnchorExpMultiplier: 0.2,
    newbieAnchorFloorRatio: 0.12,
    globalChatEnabled: true,
    globalChatChance: 0.015,
    globalChatImportantChance: 0.25,
    globalChatMinIntervalMs: 180000,
    marketTradeChatEnabled: true,
    marketTradeChatIntervalMs: 8 * 60 * 1000,
    marketTradeChatGlobalMinIntervalMs: 60000,
    partyRecruitmentChatEnabled: true,
    partyRecruitmentChatIntervalMs: 12 * 60 * 1000,
    partyRecruitmentChatGlobalMinIntervalMs: 90000,
    partyMarketBreakMinSessionMs: 10 * 60 * 1000,
    partyMarketBreakMinFights: 8,
    partyMarketBreakCooldownMs: 5 * 60 * 1000,
    devLogPlayerChat: true,
    resolveSlowMs: 250,
    resolveSampleLimit: 200,
    eventLoopSampleMs: 1000,
    slowEventLoopLagMs: 75,
    debug: false
};

const ENV_KEYS = {
    enabled: 'BOT_POPULATION_ENABLED',
    backgroundResolverEnabled: 'BOT_BACKGROUND_RESOLVER_ENABLED',
    backgroundPartyEnabled: 'BOT_BACKGROUND_PARTY_ENABLED',
    phasePolicyEnabled: 'BOT_POPULATION_PHASE_POLICY_ENABLED',
    directorEnabled: 'BOT_POPULATION_DIRECTOR_ENABLED',
    maxPlayingPopulation: 'BOT_POPULATION_MAX_PLAYING',
    starterBotsPerRace: 'BOT_POPULATION_STARTER_BOTS_PER_RACE',
    generatedColdBatchSize: 'BOT_POPULATION_BATCH_SIZE',
    generatedColdSeedDelayMs: 'BOT_POPULATION_SEED_DELAY_MS',
    cooldownGraceMs: 'BOT_COOLDOWN_GRACE_MS',
    cooldownRadius: 'BOT_COOLDOWN_RADIUS',
    activationRadius: 'BOT_ACTIVATION_RADIUS',
    activationLevelRange: 'BOT_ACTIVATION_LEVEL_RANGE',
    maxActivationsPerScan: 'BOT_MAX_ACTIVATIONS_PER_SCAN',
    activationFloorDirectZ: 'BOT_ACTIVATION_FLOOR_DIRECT_Z',
    activationFloorGeoChecksPerScan: 'BOT_ACTIVATION_FLOOR_GEO_CHECKS_PER_SCAN',
    activationFloorCacheMs: 'BOT_ACTIVATION_FLOOR_CACHE_MS',
    activationFloorCacheLimit: 'BOT_ACTIVATION_FLOOR_CACHE_LIMIT',
    schedulerSliceMs: 'BOT_POPULATION_SCHEDULER_SLICE_MS',
    schedulerIdleBudgetMs: 'BOT_POPULATION_SCHEDULER_IDLE_BUDGET_MS',
    schedulerPlayerBudgetMs: 'BOT_POPULATION_SCHEDULER_PLAYER_BUDGET_MS',
    schedulerPartyBudgetMs: 'BOT_POPULATION_SCHEDULER_PARTY_BUDGET_MS',
    schedulerIdleMaxResolvesPerTick: 'BOT_POPULATION_SCHEDULER_IDLE_MAX_RESOLVES',
    schedulerPlayerMaxResolvesPerTick: 'BOT_POPULATION_SCHEDULER_PLAYER_MAX_RESOLVES',
    goalMetadataReconcileIntervalMs: 'BOT_POPULATION_GOAL_METADATA_INTERVAL_MS',
    goalMetadataIdleBatchSize: 'BOT_POPULATION_GOAL_METADATA_IDLE_BATCH',
    goalMetadataPlayerBatchSize: 'BOT_POPULATION_GOAL_METADATA_PLAYER_BATCH',
    goalMetadataIdleBudgetMs: 'BOT_POPULATION_GOAL_METADATA_IDLE_BUDGET_MS',
    goalMetadataPlayerBudgetMs: 'BOT_POPULATION_GOAL_METADATA_PLAYER_BUDGET_MS',
    coldOwnerLeaseMs: 'BOT_POPULATION_COLD_OWNER_LEASE_MS',
    coldOwnerResolveTimeoutMs: 'BOT_POPULATION_COLD_OWNER_TIMEOUT_MS',
    coldOwnerRenewalIntervalMs: 'BOT_POPULATION_COLD_OWNER_RENEWAL_MS',
    coldOwnerRecoveryIntervalMs: 'BOT_POPULATION_COLD_OWNER_RECOVERY_MS',
    coldWorkerBatchSize: 'BOT_POPULATION_COLD_WORKER_BATCH_SIZE',
    coldWorkerCommitBatchSize: 'BOT_POPULATION_COLD_WORKER_COMMIT_BATCH_SIZE',
    coldWorkerMaxInFlight: 'BOT_POPULATION_COLD_WORKER_MAX_IN_FLIGHT',
    coldWorkerOrdinaryFlushMs: 'BOT_POPULATION_COLD_WORKER_FLUSH_MS',
    coldWorkerOrdinaryHardMaxMs: 'BOT_POPULATION_COLD_WORKER_HARD_MAX_MS',
    coldWorkerCriticalFlushMs: 'BOT_POPULATION_COLD_WORKER_CRITICAL_MS',
    coldWorkerHeartbeatMs: 'BOT_POPULATION_COLD_WORKER_HEARTBEAT_MS',
    coldWorkerUnhealthyMs: 'BOT_POPULATION_COLD_WORKER_UNHEALTHY_MS',
    coldWorkerDeadMs: 'BOT_POPULATION_COLD_WORKER_DEAD_MS',
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
    playerProtectionGraceMs: 'BOT_POPULATION_PLAYER_PROTECTION_GRACE_MS',
    schedulerLagThrottleMs: 'BOT_POPULATION_SCHEDULER_LAG_THROTTLE_MS',
    schedulerLagAbortMs: 'BOT_POPULATION_SCHEDULER_LAG_ABORT_MS',
    partyFormationIdleBudgetMs: 'BOT_POPULATION_PARTY_FORMATION_IDLE_BUDGET_MS',
    partyFormationPlayerBudgetMs: 'BOT_POPULATION_PARTY_FORMATION_PLAYER_BUDGET_MS',
    marketTradeChatEnabled: 'BOT_MARKET_TRADE_CHAT_ENABLED',
    marketTradeChatIntervalMs: 'BOT_MARKET_TRADE_CHAT_INTERVAL_MS',
    partyRecruitmentChatEnabled: 'BOT_PARTY_RECRUITMENT_CHAT_ENABLED',
    partyRecruitmentChatIntervalMs: 'BOT_PARTY_RECRUITMENT_CHAT_INTERVAL_MS',
    partyMarketBreakMinSessionMs: 'BOT_PARTY_MARKET_BREAK_MIN_SESSION_MS',
    partyHistoryRetentionMs: 'BOT_PARTY_HISTORY_RETENTION_MS',
    partyHistoryCleanupBatchSize: 'BOT_PARTY_HISTORY_CLEANUP_BATCH_SIZE',
    partyHistoryCleanupIntervalMs: 'BOT_PARTY_HISTORY_CLEANUP_INTERVAL_MS',
    warehouseCleanupEnabled: 'BOT_WAREHOUSE_CLEANUP_ENABLED',
    warehouseCleanupStartDelayMs: 'BOT_WAREHOUSE_CLEANUP_START_DELAY_MS',
    warehouseCleanupIntervalMs: 'BOT_WAREHOUSE_CLEANUP_INTERVAL_MS',
    warehouseCleanupPassPauseMs: 'BOT_WAREHOUSE_CLEANUP_PASS_PAUSE_MS',
    warehouseCleanupIdlePauseMs: 'BOT_WAREHOUSE_CLEANUP_IDLE_PAUSE_MS',
    warehouseCleanupOwnersPerTick: 'BOT_WAREHOUSE_CLEANUP_OWNERS_PER_TICK',
    warehouseCleanupUnitsPerOwner: 'BOT_WAREHOUSE_CLEANUP_UNITS_PER_OWNER',
    warehouseCleanupBudgetMs: 'BOT_WAREHOUSE_CLEANUP_BUDGET_MS',
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
    devLogPlayerChat: 'BOT_DEV_LOG_PLAYER_CHAT',
    debug: 'BOT_POPULATION_DEBUG'
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

module.exports = PopulationConfig;
