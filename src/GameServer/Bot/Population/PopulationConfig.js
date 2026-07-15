const DEFAULTS = {
    enabled: true,
    backgroundResolverEnabled: true,
    backgroundPartyEnabled: true,
    phasePolicyEnabled: true,
    directorEnabled: true,
    summaryIntervalMs: 30000,
    schedulerIntervalMs: 5000,
    partyFormationIntervalMs: 45000,
    phasePolicyIntervalMs: 10000,
    directorIntervalMs: 30000,
    generatedColdTarget: 100,
    generatedColdBatchSize: 25,
    generatedColdSeedDelayMs: 45000,
    maxResolvesPerTick: 10,
    maxPartyResolvesPerTick: 3,
    partyFormationBatchSize: 3,
    partyFormationCandidateLimit: 80,
    partyMinSize: 2,
    partyMaxSize: 5,
    maxBackgroundParties: 20,
    cooldownGraceMs: 120000,
    cooldownBatchSize: 20,
    cooldownRadius: 11000,
    activationRadius: 9000,
    activationLevelRange: 5,
    nearPlayerHotTarget: 12,
    maxActivationsPerScan: 6,
    activationPlacementRadius: 1400,
    activationMinPlayerDistance: 450,
    activationPlacementAttempts: 8,
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
    partyInviteRange: 6000,
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
    generatedColdTarget: 'BOT_POPULATION_TARGET',
    generatedColdBatchSize: 'BOT_POPULATION_BATCH_SIZE',
    generatedColdSeedDelayMs: 'BOT_POPULATION_SEED_DELAY_MS',
    cooldownGraceMs: 'BOT_COOLDOWN_GRACE_MS',
    cooldownRadius: 'BOT_COOLDOWN_RADIUS',
    activationRadius: 'BOT_ACTIVATION_RADIUS',
    activationLevelRange: 'BOT_ACTIVATION_LEVEL_RANGE',
    nearPlayerHotTarget: 'BOT_NEAR_PLAYER_HOT_TARGET',
    maxActivationsPerScan: 'BOT_MAX_ACTIVATIONS_PER_SCAN',
    partyInviteRange: 'BOT_PARTY_INVITE_RANGE',
    marketTradeChatEnabled: 'BOT_MARKET_TRADE_CHAT_ENABLED',
    marketTradeChatIntervalMs: 'BOT_MARKET_TRADE_CHAT_INTERVAL_MS',
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

module.exports = PopulationConfig;
