'use strict';

// Presentation only: the server still reads every INI key normally.
const hiddenFields = {
    BotPopulation: new Set([
        'enabled', 'developerDiagnostics', 'coldWorkerHeapSnapshot', 'economyDiagnostics', 'economyDiagnosticsBotIds',
        'backgroundResolverEnabled', 'backgroundPartyEnabled', 'opportunisticRaidsEnabled', 'opportunisticRaidAliveFraction',
        'opportunisticRaidSearchIntervalMs', 'opportunisticRaidIntervalMs', 'opportunisticRaidMemberCooldownMs',
        'opportunisticRaidMaxParties', 'opportunisticRaidMaxFightSeconds', 'opportunisticRaidShotReserve', 'opportunisticRaidExpeditionMs',
        'phasePolicyEnabled', 'directorEnabled', 'backgroundGovernorEnabled', 'backgroundJobTickMs', 'backgroundGovernorWindowMs',
        'backgroundGovernorIdleBudgetMs', 'backgroundGovernorPlayerBudgetMs', 'backgroundGovernorIdleDbQueueMax',
        'backgroundGovernorPlayerDbQueueMax', 'backgroundGovernorLagAbortMs', 'partyHistoryRetentionMs', 'partyHistoryCleanupBatchSize',
        'activationRadius', 'activationLevelRange', 'maxActivationsPerScan', 'activationFloorDirectZ',
        'activationFloorGeoChecksPerScan', 'activationFloorCacheMs', 'activationFloorCacheLimit'
    ]),
    General: new Set(['protocol']),
    GameServer: new Set(['maxOnline', 'pvp', 'id']),
    AuthServer: new Set(['protocol', 'blowfishKey']),
    Enchant: new Set(['crystalWeaponChance', 'crystalArmorChance', 'crystalAccessoryChance']),
    ClanSimulation: new Set(['maxBotMemberShare', 'bloodMarkItemId', 'bloodMarkSourceNpcId', 'strategyRetryMs', 'actionBatchSize', 'actionLeaseMs', 'actionRetryMs']),
    ClanWars: new Set(['reviewMs', 'intelTtlMs'])
};

const sectionOrder = ['General', 'Progression', 'Enchant', 'BotPopulation', 'ClanSimulation', 'ClanWars', 'AI', 'GameServer', 'AuthServer', 'WorldObserver', 'Database'];
const groups = {
    General: [
        ['Progression', ['maxLevel', 'progressionPreset']],
        ['Experience & skills', ['expRate', 'spRate', 'questExpRate', 'questSpRate']],
        ['Economy & drops', ['adenaRate', 'dropChanceRate', 'spoilRate', 'questRewardRate', 'questAdenaRate']],
        ['Character rules & display', ['newbieRewardPolicy', 'pkDeathDropChance', 'showMonsterLevel']]
    ],
    Enchant: [
        ['Weapons', ['weaponChance', 'blessedWeaponChance', 'maxWeapon']],
        ['Armour', ['armorChance', 'blessedArmorChance', 'maxArmor']],
        ['Jewellery', ['accessoryChance', 'blessedAccessoryChance', 'maxAccessory']],
        ['Safe enchant levels', ['safeMax', 'safeMaxFull']]
    ],
    BotPopulation: [
        ['Population & seeding', ['maxPlayingPopulation', 'starterBotsPerRace', 'generatedColdBatchSize', 'generatedColdSeedDelayMs']],
        ['Behavior & travel', ['pvpAggression', 'knowledgeErrorsEnabled', 'coldHonestTravel']],
        ['Social scenes', ['ambientScenesEnabled', 'ambientSceneCooldownMs', 'ambientPairCooldownMs', 'ambientSceneTtlMs']],
        ['Logging', ['devLogPlayerChat', 'debug']]
    ],
    ClanSimulation: [
        ['Clans & recruitment', ['enabled', 'maxBotClans', 'founderMinLevel', 'founderTopShare', 'founderQuorum', 'founderMinPartyHistory', 'existingClanSuitabilityThreshold']],
        ['Treasury & contributions', ['levelOneAdenaBase', 'levelTwoAdenaBase', 'adenaRateExponent', 'personalAdenaReserveMultiplier', 'contributionMaxFraction']],
        ['Warehouse & market', ['warehouseDepositBatchSize', 'bloodMarkMaxPrice', 'marketDemandTimeoutMs']],
        ['Strategy & goals', ['strategicManagementEnabled', 'llmGoalManagementEnabled', 'llmTitleManagementEnabled', 'catastrophicFailureThreshold', 'strategyMinHoldMs', 'strategyStallMs', 'goalReviewMs']],
        ['Equipment planning', ['equipmentReviewMs', 'equipmentPartyStallMs', 'equipmentHardStallMs', 'equipmentMaxExpectedKills']],
        ['Clan operations', ['operationMinMembers', 'operationMaxMembers', 'operationMaxTargetLevelGap']],
        ['Processing budgets', ['resolveIntervalMs', 'resolveBatchSize', 'resolveBudgetMs', 'actionPlayerBudgetMs', 'founderResolveBudgetMs', 'founderPlayerBudgetMs']]
    ],
    ClanWars: [
        ['Diplomacy', ['enabled', 'hostilityThreshold', 'minHarmEpisodes', 'quietWithdrawMs', 'redeclareCooldownMs']],
        ['Parties & campaigns', ['minMembers', 'maxMembers', 'maxActiveOperations', 'operationMs', 'operationCooldownMs']],
        ['Loss response', ['lossWindowMs', 'counterattackCooldownMs']]
    ],
    AI: [
        ['Provider connection', ['enabled', 'apiUrl', 'apiKey']],
        ['Models', ['model', 'partyRouterModel']],
        ['Model responses', ['temperature', 'reasoningEffort', 'completionLimitParam', 'strictSchema']],
        ['Request limits', ['maxConcurrentRequests']]
    ],
    GameServer: [
        ['Network', ['hostname', 'port', 'advertisedHostname']],
        ['Player storage', ['playerWarehouseSlots']]
    ],
    AuthServer: [
        ['Network', ['hostname', 'port']],
        ['Accounts', ['autoCreate']]
    ],
    WorldObserver: [['Connection', ['enabled', 'hostname', 'port']]],
    Database: [['World data', ['path']]],
    Progression: [['Level cap', ['contentCap']]]
};

function fieldVisible(section, key) {
    return section === 'Database' ? key === 'path' : !hiddenFields[section]?.has(key);
}
function fieldLayout(section, key) {
    let order = 0;
    for (const [group, keys] of groups[section] || []) {
        const index = keys.indexOf(key);
        if (index >= 0) return { group, order: order + index };
        order += keys.length;
    }
    return { group: 'Other options', order: 10000 };
}

module.exports = { sectionOrder, fieldVisible, fieldLayout };
