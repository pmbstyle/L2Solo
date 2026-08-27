const DEFAULTS = {
    enabled: true,
    founderMinLevel: 20,
    founderQuorum: 5,
    maxBotClans: 40,
    maxBotMemberShare: 0.70,
    founderAmbitionMin: 0.80,
    founderAssertivenessMin: 0.70,
    founderResilienceMin: 0.65,
    founderSociabilityMin: 0.55,
    founderCommitmentMin: 0.45,
    founderMinPartyHistory: 1,
    existingClanSuitabilityThreshold: 0.55,
    levelOneAdenaBase: 650000,
    levelTwoAdenaBase: 2500000,
    adenaRateExponent: 0.59,
    personalAdenaReserveMultiplier: 1,
    contributionMaxFraction: 0.35,
    contributionBatchSize: 8,
    warehouseDepositBatchSize: 8,
    bloodMarkMaxPrice: 2500000,
    marketDemandTimeoutMs: 300000,
    bloodMarkItemId: 1419,
    bloodMarkSourceNpcId: 12079,
    operationMinMembers: 5,
    operationMaxMembers: 9,
    operationMaxTargetLevelGap: 5,
    catastrophicFailureThreshold: 5,
    llmGoalManagementEnabled: false,
    resolveIntervalMs: 60000,
    resolveBatchSize: 16,
    resolveBudgetMs: 80,
    actionPlayerBudgetMs: 20,
    founderResolveBudgetMs: 20,
    founderPlayerBudgetMs: 5,
    actionBatchSize: 8,
    actionLeaseMs: 120000,
    actionRetryMs: 60000
};

const ENV_KEYS = {
    enabled: 'CLAN_SIMULATION_ENABLED',
    founderMinLevel: 'CLAN_SIMULATION_FOUNDER_MIN_LEVEL',
    founderQuorum: 'CLAN_SIMULATION_FOUNDER_QUORUM',
    maxBotClans: 'CLAN_SIMULATION_MAX_BOT_CLANS',
    maxBotMemberShare: 'CLAN_SIMULATION_MAX_BOT_MEMBER_SHARE',
    founderAmbitionMin: 'CLAN_SIMULATION_FOUNDER_AMBITION_MIN',
    founderAssertivenessMin: 'CLAN_SIMULATION_FOUNDER_ASSERTIVENESS_MIN',
    founderResilienceMin: 'CLAN_SIMULATION_FOUNDER_RESILIENCE_MIN',
    founderSociabilityMin: 'CLAN_SIMULATION_FOUNDER_SOCIABILITY_MIN',
    founderCommitmentMin: 'CLAN_SIMULATION_FOUNDER_COMMITMENT_MIN',
    founderMinPartyHistory: 'CLAN_SIMULATION_FOUNDER_MIN_PARTY_HISTORY',
    existingClanSuitabilityThreshold: 'CLAN_SIMULATION_EXISTING_CLAN_THRESHOLD',
    levelOneAdenaBase: 'CLAN_SIMULATION_LEVEL_ONE_ADENA',
    levelTwoAdenaBase: 'CLAN_SIMULATION_LEVEL_TWO_ADENA',
    adenaRateExponent: 'CLAN_SIMULATION_ADENA_RATE_EXPONENT',
    personalAdenaReserveMultiplier: 'CLAN_SIMULATION_PERSONAL_ADENA_RESERVE_MULTIPLIER',
    contributionMaxFraction: 'CLAN_SIMULATION_CONTRIBUTION_MAX_FRACTION',
    contributionBatchSize: 'CLAN_SIMULATION_CONTRIBUTION_BATCH_SIZE',
    warehouseDepositBatchSize: 'CLAN_SIMULATION_WAREHOUSE_DEPOSIT_BATCH_SIZE',
    bloodMarkMaxPrice: 'CLAN_SIMULATION_BLOOD_MARK_MAX_PRICE',
    marketDemandTimeoutMs: 'CLAN_SIMULATION_MARKET_DEMAND_TIMEOUT_MS',
    bloodMarkItemId: 'CLAN_SIMULATION_BLOOD_MARK_ITEM_ID',
    bloodMarkSourceNpcId: 'CLAN_SIMULATION_BLOOD_MARK_SOURCE_NPC_ID',
    operationMinMembers: 'CLAN_SIMULATION_OPERATION_MIN_MEMBERS',
    operationMaxMembers: 'CLAN_SIMULATION_OPERATION_MAX_MEMBERS',
    operationMaxTargetLevelGap: 'CLAN_SIMULATION_OPERATION_MAX_TARGET_LEVEL_GAP',
    catastrophicFailureThreshold: 'CLAN_SIMULATION_CATASTROPHIC_FAILURE_THRESHOLD',
    llmGoalManagementEnabled: 'CLAN_SIMULATION_LLM_GOALS_ENABLED',
    resolveIntervalMs: 'CLAN_SIMULATION_RESOLVE_INTERVAL_MS',
    resolveBatchSize: 'CLAN_SIMULATION_RESOLVE_BATCH_SIZE',
    resolveBudgetMs: 'CLAN_SIMULATION_RESOLVE_BUDGET_MS',
    actionPlayerBudgetMs: 'CLAN_SIMULATION_ACTION_PLAYER_BUDGET_MS',
    founderResolveBudgetMs: 'CLAN_SIMULATION_FOUNDER_RESOLVE_BUDGET_MS',
    founderPlayerBudgetMs: 'CLAN_SIMULATION_FOUNDER_PLAYER_BUDGET_MS',
    actionBatchSize: 'CLAN_SIMULATION_ACTION_BATCH_SIZE',
    actionLeaseMs: 'CLAN_SIMULATION_ACTION_LEASE_MS',
    actionRetryMs: 'CLAN_SIMULATION_ACTION_RETRY_MS'
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

function applyOverrides(base, overrides = {}) {
    Object.keys(ENV_KEYS).forEach((key) => {
        if (overrides[key] === undefined) return;
        base[key] = typeof DEFAULTS[key] === 'boolean'
            ? asBoolean(overrides[key], DEFAULTS[key])
            : asNumber(overrides[key], DEFAULTS[key]);
    });
    return base;
}

function envOverrides() {
    return Object.keys(ENV_KEYS).reduce((result, key) => {
        const value = process.env[ENV_KEYS[key]];
        if (value !== undefined) result[key] = value;
        return result;
    }, {});
}

const config = applyOverrides(
    applyOverrides({ ...DEFAULTS }, global.options?.default?.ClanSimulation),
    envOverrides()
);

config.founderMinLevel = Math.max(1, Math.floor(config.founderMinLevel));
config.founderQuorum = Math.max(5, Math.floor(config.founderQuorum));
config.maxBotClans = Math.max(0, Math.floor(config.maxBotClans));
config.maxBotMemberShare = Math.max(0, Math.min(1, config.maxBotMemberShare));
config.existingClanSuitabilityThreshold = Math.max(0, Math.min(1, config.existingClanSuitabilityThreshold));
config.personalAdenaReserveMultiplier = Math.max(0, config.personalAdenaReserveMultiplier);
config.contributionMaxFraction = Math.max(0, Math.min(1, config.contributionMaxFraction));
config.contributionBatchSize = Math.max(1, Math.floor(config.contributionBatchSize));
config.warehouseDepositBatchSize = Math.max(1, Math.floor(config.warehouseDepositBatchSize));
config.bloodMarkMaxPrice = Math.max(1, Math.floor(config.bloodMarkMaxPrice));
config.marketDemandTimeoutMs = Math.max(1000, Math.floor(config.marketDemandTimeoutMs));
config.operationMinMembers = Math.max(2, Math.min(9, Math.floor(config.operationMinMembers)));
config.operationMaxMembers = Math.max(
    config.operationMinMembers,
    Math.min(9, Math.floor(config.operationMaxMembers))
);
config.operationMaxTargetLevelGap = Math.max(0, Math.floor(config.operationMaxTargetLevelGap));
config.catastrophicFailureThreshold = Math.max(1, Math.floor(config.catastrophicFailureThreshold));
config.resolveIntervalMs = Math.max(1000, Math.floor(config.resolveIntervalMs));
config.resolveBatchSize = Math.max(1, Math.floor(config.resolveBatchSize));
config.resolveBudgetMs = Math.max(1, Math.floor(config.resolveBudgetMs));
config.actionPlayerBudgetMs = Math.max(1, Math.min(config.resolveBudgetMs, Math.floor(config.actionPlayerBudgetMs)));
config.founderResolveBudgetMs = Math.max(1, Math.floor(config.founderResolveBudgetMs));
config.founderPlayerBudgetMs = Math.max(1, Math.min(config.founderResolveBudgetMs, Math.floor(config.founderPlayerBudgetMs)));
config.actionBatchSize = Math.max(1, Math.floor(config.actionBatchSize));
config.actionLeaseMs = Math.max(1000, Math.floor(config.actionLeaseMs));
config.actionRetryMs = Math.max(1000, Math.floor(config.actionRetryMs));

module.exports = config;
