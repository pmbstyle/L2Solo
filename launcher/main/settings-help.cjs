'use strict';

const help = {
    Database: {
        path: 'World database file containing accounts, characters and their progress. Relative paths start in the server folder; choosing another file switches the world used on the next start.',
        historyPath: 'History database for this world, including past events and analytics. Leave empty to use a matching .history.sqlite file next to the world database.',
        checkpointIntervalMs: 'Interval between background SQLite checkpoints, in milliseconds. A checkpoint moves committed changes from the write-ahead log into the database file.',
        checkpointMinWalBytes: 'Minimum write-ahead log size, in bytes, before a routine checkpoint does work. Smaller thresholds cause more frequent disk activity.',
        checkpointResetWalBytes: 'Log size in bytes that makes an idle-time log reset eligible. 0 disables resets; resets still wait for an idle database and no real or connecting players.',
        checkpointResetGrowthBytes: 'Additional log growth in bytes required after the previous successful reset before another reset is eligible.',
        checkpointResetIntervalMs: 'How often the server checks whether an idle-time database log reset is needed, in milliseconds.',
        checkpointResetCooldownMs: 'Minimum wait after a successful database log reset, in milliseconds. Limits how often this maintenance can run.',
        checkpointResetRetryMs: 'Wait before retrying a log reset that could not proceed, in milliseconds.',
        checkpointResetBusyTimeoutMs: 'Maximum time a log-reset attempt waits for a database lock, in milliseconds. The runtime limits this wait to 250 ms to protect gameplay.'
    },
    AuthServer: {
        hostname: 'Address on which the login server listens. 0.0.0.0 accepts connections on all IPv4 interfaces; 127.0.0.1 allows this computer only.',
        port: 'TCP port used by the game client to log in. The Chronicle 4 default is 2106; remote players must be able to reach this port.',
        protocol: 'Protocol identifier sent in the login handshake. Keep the Chronicle 4 value unless you are deliberately adapting a different client.',
        blowfishKey: 'Encryption key used for login packets. Changing it can prevent compatible clients from logging in; keep the supplied value for the standard client.',
        autoCreate: 'Automatically creates an account when a player logs in with a new username and password. Disable to allow existing accounts only.'
    },
    GameServer: {
        hostname: 'Address on which the game server listens after login. 0.0.0.0 accepts all IPv4 interfaces; 127.0.0.1 restricts access to this computer.',
        advertisedHostname: 'IPv4 address sent to clients after login and shown by the launcher. Set a reachable LAN, VPN or public address for remote play; leave empty for automatic address detection.',
        port: 'TCP port used by clients to enter and play in the world after login. The default is 7777.',
        id: 'Server identifier sent in the client server list. Keep it stable for this world; it does not change the world database.',
        maxOnline: 'Player capacity advertised in the client server list. It is separate from the dynamic-bot target and does not enlarge the launcher bot-population bar.',
        pvp: 'PvP flag advertised for this server in the client server list. This flag is not a control for autonomous bot aggression.',
        playerWarehouseSlots: 'Number of personal warehouse slots shared by characters on one player account, from 1 to 1000. Bot warehouses remain separate.'
    },
    General: {
        protocol: 'Game-client protocol version accepted by the server. Chronicle 4 uses 656; a mismatching client cannot enter the world.',
        maxLevel: 'Highest character level supported by this world, from 1 to 78. An optional progression content cap can impose a lower active limit.',
        progressionPreset: 'Multiplies experience, skill points, adena, drops, spoil and quest rewards by x1, x10 or x50. Individual rate values multiply this preset again.',
        expRate: 'Base experience multiplier before the progression preset. For example, 2 with x10 gives an effective experience rate of x20.',
        spRate: 'Base skill-point multiplier before the progression preset. When this key is absent, it follows the experience multiplier.',
        adenaRate: 'Base multiplier for adena drops before the progression preset. It changes currency income, not shop prices.',
        dropChanceRate: 'Base multiplier for ordinary monster drops before the progression preset. Scaling can increase drop quantity when the resulting chance exceeds 100%.',
        spoilRate: 'Base multiplier for spoil rewards before the progression preset. When this key is absent, it follows the ordinary drop multiplier.',
        pkDeathDropChance: 'Chance that the next item drops when a red character with at least 6 PKs dies. Enter a fraction from 0 to 1: 0.4 means 40%.',
        showMonsterLevel: 'Adds monster levels to the information shown to the game client.',
        newbieRewardPolicy: 'Beginner-shot eligibility: strict requires recorded beginner status; grant also accepts old characters with unknown status; always treats every character as eligible. Reward receipt limits still apply.',
        questRewardRate: 'Base multiplier for quest currency, experience and skill-point rewards before the progression preset. Quest objective-item quantities stay unchanged.',
        questAdenaRate: 'Quest adena multiplier before the progression preset. If omitted, follows the common quest reward multiplier.',
        questExpRate: 'Quest experience multiplier before the progression preset. If omitted, follows the common quest reward multiplier.',
        questSpRate: 'Quest skill-point multiplier before the progression preset. If omitted, follows the common quest reward multiplier.'
    },
    Progression: {
        contentCap: 'Active progression level cap for staged world content. It cannot exceed Maximum level; if omitted, the active cap follows Maximum level.'
    },
    AI: {
        enabled: 'Enables model-based bot inference when an endpoint and model are configured. Disable to use the deterministic behavior available without AI requests.',
        apiUrl: 'Full OpenAI-compatible Chat Completions endpoint, including its API path. Supports OpenRouter and local servers, for example http://127.0.0.1:1234/v1/chat/completions.',
        apiKey: 'Authentication key for the selected model provider. Stored in the selected server\'s local configuration; a local provider may accept a placeholder or no key.',
        model: 'Exact model identifier accepted by the endpoint. Use the provider\'s model ID, not a display name.',
        partyRouterModel: 'Model used to interpret and route ambiguous party-chat messages. Leave empty to use the main model.',
        maxConcurrentRequests: 'Maximum number of AI requests allowed in flight by the shared inference budget. Larger values increase provider load and possible API costs.',
        temperature: 'Sampling temperature sent to the provider. Higher values allow more varied answers; leave empty to omit this parameter for models that do not support it.',
        reasoningEffort: 'Reasoning effort requested from the model: off, low, medium or high. More effort can increase response time and token use; support depends on the model.',
        completionLimitParam: 'Name of the API parameter used to limit generated tokens: max_tokens or max_completion_tokens. Choose the one supported by your endpoint.',
        strictSchema: 'Adds strict JSON-schema requirements to structured AI responses. Disable if your provider does not support strict structured output.'
    },
    BotPopulation: {
        enabled: 'Enables the persistent dynamic-bot population and its simulation. Permanent service characters are separate from this population.',
        maxPlayingPopulation: 'Target number of dynamic bots across live and background simulation, excluding static services. The runtime caps this at 2000; a larger target uses more memory and CPU.',
        knowledgeErrorsEnabled: 'Lets bots make personal estimation errors and learn from their own actions. Disable for unbiased estimates and no new personal learning points; public evidence still affects decisions.',
        pvpAggression: 'Autonomous aggression from 0 to 1: 0 stops initiation, 0.5 is balanced, and 1 maximizes eligible escalation. Self-defense remains; higher values also make bots accept more risk.',
        coldHonestTravel: 'Uses scroll-cast, gatekeeper-hop and running time for background travel. Disabled uses simplified 25-second trips; travel fees and scrolls are paid in both modes.',
        ambientScenesEnabled: 'Allows bots to stage short social scenes and interactions that make towns and parties feel active.',
        ambientSceneCooldownMs: 'Minimum gap between ambient scenes, in milliseconds. Larger values make these social interactions less frequent.',
        ambientPairCooldownMs: 'Minimum wait before the same pair of bots can take part in another ambient scene, in milliseconds.',
        ambientSceneTtlMs: 'Lifetime of an ambient scene before it expires, in milliseconds.',
        backgroundResolverEnabled: 'Simulates distant bots without keeping their full live actors active. Disabling it stops their normal background progression.',
        backgroundPartyEnabled: 'Allows distant bots to assemble and simulate parties, including coordinated hunting and raid preparation.',
        opportunisticRaidsEnabled: 'Allows compatible free bots to form a party and attempt a suitable live raid boss without a scheduled clan campaign.',
        opportunisticRaidAliveFraction: 'Minimum fraction of bots in each ten-level band left outside an opportunistic raid. Enter 0 to 1; 0.5 keeps at least half available for the rest of the world.',
        opportunisticRaidSearchIntervalMs: 'Interval between searches for suitable opportunistic raid opportunities, in milliseconds.',
        opportunisticRaidIntervalMs: 'Minimum spacing between opportunistic raid admissions, in milliseconds.',
        opportunisticRaidMemberCooldownMs: 'Wait before a bot can join another opportunistic raid after participation, in milliseconds.',
        opportunisticRaidMaxParties: 'Maximum number of opportunistic raid parties allowed at the same time.',
        opportunisticRaidMaxFightSeconds: 'Maximum predicted boss-fight duration accepted when admitting an opportunistic raid, in seconds. Parties also need supplies for this forecast.',
        opportunisticRaidShotReserve: 'Multiplier applied to the predicted soulshot requirement for a raid. 1.3 means a 30% supply reserve above the estimate.',
        opportunisticRaidExpeditionMs: 'Time allowed for an opportunistic raid expedition before its plan expires, in milliseconds.',
        phasePolicyEnabled: 'Automatically moves eligible bots between detailed live simulation and cheaper background simulation as their circumstances change.',
        directorEnabled: 'Uses active player levels to guide bot progression pressure. Disable for neutral progression without player-level scaling.',
        backgroundGovernorEnabled: 'Limits background jobs using shared time budgets, database pressure and event-loop lag to protect interactive gameplay.',
        backgroundJobTickMs: 'How often the background-job scheduler checks for due work, in milliseconds. Shorter ticks react faster but add scheduling overhead.',
        backgroundGovernorWindowMs: 'Length of the shared background-work accounting window, in milliseconds. Idle and player budgets are measured within this window.',
        backgroundGovernorIdleBudgetMs: 'Background work-time allowance per accounting window when no player is protected, in milliseconds.',
        backgroundGovernorPlayerBudgetMs: 'Background work-time allowance per window while players are active or protected, in milliseconds. Lower values reserve more responsiveness for players.',
        backgroundGovernorIdleDbQueueMax: 'Largest pending database queue that still admits background jobs while idle. Jobs wait when the queue exceeds this count.',
        backgroundGovernorPlayerDbQueueMax: 'Largest pending database queue that admits background jobs while players are protected. 0 waits whenever any database work is queued.',
        backgroundGovernorLagAbortMs: 'Event-loop delay at which new governed background work is deferred, in milliseconds.',
        starterBotsPerRace: 'Number of authored starter bots seeded per race before filling the remaining dynamic-population target.',
        generatedColdBatchSize: 'Maximum generated background bots considered in one population-seeding batch. Larger batches fill a new world faster but create more startup work.',
        generatedColdSeedDelayMs: 'Delay between generated population-seeding waves, in milliseconds. Controls how quickly a new world fills toward the bot target.',
        partyHistoryRetentionMs: 'How long background-party history is retained before old records are cleaned up, in milliseconds.',
        partyHistoryCleanupBatchSize: 'Maximum number of old background-party history records removed in one cleanup batch.',
        activationRadius: 'Horizontal distance from a real player within which background bots may be activated as live actors, in game-world coordinate units.',
        activationLevelRange: 'Legacy level-range option retained for configuration compatibility. The current nearby-bot activation code does not read this value.',
        maxActivationsPerScan: 'Maximum number of background bots activated during one nearby-player scan. Limits sudden actor creation work.',
        activationFloorDirectZ: 'Vertical separation in world units below which a nearby bot passes the direct height check. Larger differences require additional geodata visibility checks.',
        activationFloorGeoChecksPerScan: 'Maximum extra geodata visibility checks for floor-separated activation candidates in one scan. Remaining candidates are deferred.',
        activationFloorCacheMs: 'How long floor-visibility results are reused for nearby-bot activation checks, in milliseconds.',
        activationFloorCacheLimit: 'Maximum number of cached floor-visibility results kept for activation checks.',
        developerDiagnostics: 'Developer-only master switch for optional counters, timing measurements, logs and diagnostic IPC. Other diagnostic switches require this to be enabled.',
        coldWorkerHeapSnapshot: 'Developer-only memory dump of the background worker near its heap limit, at most once per server boot. The dump can be large and pauses that worker while being written.',
        economyDiagnostics: 'Developer-only bounded economy event journal. Requires developer diagnostics and adds history-writing work.',
        economyDiagnosticsBotIds: 'Comma-separated character IDs to trace in the developer economy journal. Empty selects up to sixteen bots observed by the journal.',
        devLogPlayerChat: 'Developer option for recording player chat in diagnostic logs. Keep privacy in mind when sharing those logs.',
        debug: 'Additional bot-population debug output. Optional diagnostic output is also controlled by the developer-diagnostics master switch.'
    },
    ClanSimulation: {
        enabled: 'Enables autonomous bot clan founding, recruitment, shared goals and economic coordination.',
        founderMinLevel: 'Minimum character level for a bot clan founder. The bot must also meet profession, personality, history and group requirements.',
        founderQuorum: 'Minimum compatible founding group, including the leader. The runtime requires at least 5 members.',
        maxBotClans: 'Maximum number of autonomous bot clans the simulation may found.',
        maxBotMemberShare: 'Maximum share of the dynamic-bot population admitted to simulated clans. Enter 0 to 1; 0.7 means 70%.',
        founderTopShare: 'Share of the strongest leadership candidates eligible to found a clan within each personality drive. 0.05 selects roughly the top 5%.',
        founderMinPartyHistory: 'Minimum recorded party-history runs required for a prospective clan founder.',
        existingClanSuitabilityThreshold: 'Minimum compatibility score for joining an existing clan, from 0 to 1. Higher values make recruitment more selective.',
        levelOneAdenaBase: 'Base treasury funding target for advancing a clan from level 0 to 1, before adena-rate scaling. This is the planning target, not an override of the official upgrade price.',
        levelTwoAdenaBase: 'Base treasury funding target for advancing a level-1 clan toward level 2, before adena-rate scaling.',
        adenaRateExponent: 'How strongly clan treasury funding targets scale with the effective adena rate. Target = base amount × adena rate raised to this exponent.',
        personalAdenaReserveMultiplier: 'Multiplier on the operating-money reserve a member keeps before contributing to the clan. Larger values leave members more money for their own needs.',
        contributionMaxFraction: 'Upper bound on the fraction of a member\'s earnings or eligible funds requested for clan contributions. 0.35 means at most 35%, subject to other contribution rules.',
        warehouseDepositBatchSize: 'Maximum number of inventory rows handled in one clan-warehouse deposit batch.',
        bloodMarkMaxPrice: 'Highest unit price the clan planner is willing to pay for the configured Blood Mark item, in adena.',
        marketDemandTimeoutMs: 'Time before a clan market-demand request expires, in milliseconds.',
        bloodMarkItemId: 'Item-template ID used as the Blood Mark requirement for clan advancement. The default 1419 is Blood Mark.',
        bloodMarkSourceNpcId: 'NPC-template ID used to locate a farming source for Blood Marks. Change only when adapting the server datapack.',
        catastrophicFailureThreshold: 'Recorded goal-replanning failure count after which clan planning avoids repeating the same kind of acquisition plan.',
        llmGoalManagementEnabled: 'Allows a configured AI model to help select clan goals. Disable to use deterministic goal selection.',
        strategicManagementEnabled: 'Keeps a persistent high-level clan strategy across reviews and restarts, so ordinary item and market changes do not constantly replace the plan.',
        strategyMinHoldMs: 'Minimum time an accepted clan strategy is kept before an ordinary reconsideration, in milliseconds. Completed, blocked or invalid strategies can trigger other review rules.',
        strategyStallMs: 'Time without strategy progress before a normal stall review becomes eligible, in milliseconds.',
        strategyRetryMs: 'Wait before retrying or reviewing a strategy whose execution is blocked, in milliseconds.',
        llmTitleManagementEnabled: 'Allows AI-assisted clan title generation when inference is configured. This can add model requests.',
        goalReviewMs: 'Interval between autonomous clan-goal reviews, in milliseconds.',
        equipmentReviewMs: 'Interval between clan equipment-planning reviews, in milliseconds. The runtime keeps this at least as long as the goal-review interval.',
        equipmentPartyStallMs: 'Time without equipment progress before party-based acquisition is considered stalled, in milliseconds.',
        equipmentHardStallMs: 'Time without equipment progress used for a hard-stall reassessment of the acquisition plan, in milliseconds.',
        equipmentMaxExpectedKills: 'Largest estimated monster-kill count accepted by clan equipment planning for a farming option. Higher values allow longer grinds.',
        resolveIntervalMs: 'Interval between general clan-simulation passes, in milliseconds.',
        resolveBatchSize: 'Maximum clans handled in one simulation batch.',
        resolveBudgetMs: 'Time budget for a normal clan-action processing pass, in milliseconds.',
        actionPlayerBudgetMs: 'Reduced clan-action time budget while players are protected, in milliseconds. Cannot exceed the normal action budget.',
        founderResolveBudgetMs: 'Time budget for a clan-founder search pass when the world is idle, in milliseconds.',
        founderPlayerBudgetMs: 'Reduced founder-search time budget while players are protected, in milliseconds.',
        actionBatchSize: 'Maximum queued clan actions claimed in one batch.',
        actionLeaseMs: 'How long a claimed clan action stays reserved before an abandoned claim can be recovered, in milliseconds.',
        actionRetryMs: 'Delay before retrying a deferred or recoverable clan action, in milliseconds.',
        operationMinMembers: 'Minimum participants required for an autonomous clan operation. The runtime constrains this to 2–9.',
        operationMaxMembers: 'Maximum participants in an autonomous clan operation, up to 9 and never below its minimum.',
        operationMaxTargetLevelGap: 'Maximum target-level difference accepted when evaluating autonomous clan-operation candidates.'
    },
    WorldObserver: {
        enabled: 'Starts the browser-based World Observer for inspecting the running world. Launcher population reporting works independently of this switch.',
        hostname: 'Address on which World Observer listens. 127.0.0.1 allows this computer only; 0.0.0.0 exposes it on reachable network interfaces.',
        port: 'HTTP port for World Observer. With the default 8088, its local address is http://127.0.0.1:8088/observer/.'
    },
    ClanWars: {
        enabled: 'Enables autonomous bot-clan diplomacy and war operations. Player clans still require mutual war declarations for a war to be active.',
        hostilityThreshold: 'Base hostility score needed to consider a war, adjusted by clan-leader personality. Higher values require stronger grievances; the runtime keeps the base between 20 and 90.',
        minHarmEpisodes: 'Minimum number of distinct harmful incidents needed before a clan considers declaring war.',
        reviewMs: 'Interval between clan diplomacy and war-planning reviews, in milliseconds.',
        intelTtlMs: 'How long sightings of enemy clans remain usable as intelligence, in milliseconds.',
        operationMs: 'Planned duration of a clan war operation, in milliseconds.',
        operationCooldownMs: 'Minimum wait between ordinary clan war operations, in milliseconds.',
        quietWithdrawMs: 'Quiet period without relevant conflict before a clan considers withdrawing from war, in milliseconds.',
        redeclareCooldownMs: 'Cooldown after a ceasefire before the same conflict can be declared again, in milliseconds.',
        lossWindowMs: 'Time window in which recent losses can influence clan war responses, in milliseconds.',
        counterattackCooldownMs: 'Shorter delay used for a counterattack responding to recent losses, in milliseconds.',
        minMembers: 'Minimum party size for a clan war operation. The runtime requires at least 3 members.',
        maxMembers: 'Maximum party size for a clan war operation, up to 9 and never below its minimum.',
        maxActiveOperations: 'Maximum number of simultaneous clan war operations.'
    }
};

const enchantTargets = { Weapon: 'weapon', Armor: 'armor', Accessory: 'jewellery' };
help.Enchant = {};
for (const [suffix, target] of Object.entries(enchantTargets)) {
    for (const [prefix, scroll] of [['', 'ordinary'], ['blessed', 'blessed'], ['crystal', 'crystal']]) {
        const key = `${prefix}${prefix ? suffix : suffix[0].toLowerCase() + suffix.slice(1)}Chance`;
        help.Enchant[key] = `Success chance for ${scroll} ${target} enchant scrolls outside the safe range, as a percentage from 0 to 100.`;
    }
    help.Enchant[`max${suffix}`] = `Maximum allowed ${target} enchant level. 0 leaves the level uncapped by this setting.`;
}
help.Enchant.safeMax = 'Highest guaranteed-safe enchant level for ordinary equipment. With 3, enchanting to +3 is safe; attempts above it use the configured success chance.';
help.Enchant.safeMaxFull = 'Highest guaranteed-safe enchant level for full-body armour. With 4, enchanting a full-body piece to +4 is safe.';

function settingHelp(section, key, comment = '') {
    const description = help[section]?.[key] || comment
        || 'Custom setting supplied by this server installation. Its behavior is defined by that server version; keep the existing value unless you know the intended effect.';
    const unit = /Ms$/.test(key) ? 'ms' : /Bytes$/.test(key) ? 'bytes' : /Seconds$/.test(key) ? 'seconds' : null;
    return { description, unit };
}

module.exports = { help, settingHelp };
