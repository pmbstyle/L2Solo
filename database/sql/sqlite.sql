PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    appliedAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS maintenance_tasks (
    name TEXT PRIMARY KEY,
    completedAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
    username TEXT PRIMARY KEY COLLATE NOCASE,
    password TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS characters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL COLLATE NOCASE REFERENCES accounts(username) ON DELETE CASCADE,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    title TEXT NOT NULL DEFAULT '',
    classId INTEGER NOT NULL,
    race INTEGER NOT NULL,
    level INTEGER NOT NULL DEFAULT 1,
    hp REAL NOT NULL DEFAULT 50,
    maxHp REAL NOT NULL,
    mp REAL NOT NULL DEFAULT 25,
    maxMp REAL NOT NULL,
    cp REAL,
    effects TEXT,
    exp INTEGER NOT NULL DEFAULT 0,
    sp INTEGER NOT NULL DEFAULT 0,
    pk INTEGER NOT NULL DEFAULT 0,
    pvp INTEGER NOT NULL DEFAULT 0,
    sex INTEGER NOT NULL,
    face INTEGER NOT NULL,
    hair INTEGER NOT NULL,
    hairColor INTEGER NOT NULL,
    karma INTEGER NOT NULL DEFAULT 0,
    evalScore INTEGER NOT NULL DEFAULT 0,
    recRemain INTEGER NOT NULL DEFAULT 0,
    clanId INTEGER NOT NULL DEFAULT 0,
    clanPrivileges INTEGER NOT NULL DEFAULT 0,
    clanJoinExpiryTime INTEGER NOT NULL DEFAULT 0,
    clanCreateExpiryTime INTEGER NOT NULL DEFAULT 0,
    isGM INTEGER NOT NULL DEFAULT 0,
    isOnline INTEGER NOT NULL DEFAULT 0,
    isActive INTEGER NOT NULL DEFAULT 1,
    locX INTEGER NOT NULL,
    locY INTEGER NOT NULL,
    locZ INTEGER NOT NULL,
    head INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS characters_username ON characters(username);
CREATE INDEX IF NOT EXISTS characters_clanId ON characters(clanId);
CREATE INDEX IF NOT EXISTS characters_clan_level_id ON characters(clanId, level DESC, id ASC);

CREATE TABLE IF NOT EXISTS clans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    level INTEGER NOT NULL DEFAULT 0,
    leaderId INTEGER NOT NULL,
    crestId INTEGER NOT NULL DEFAULT 0,
    crestLargeId INTEGER NOT NULL DEFAULT 0,
    allyId INTEGER NOT NULL DEFAULT 0,
    allyName TEXT NOT NULL DEFAULT '',
    allyCrestId INTEGER NOT NULL DEFAULT 0,
    dissolvingExpiryTime INTEGER NOT NULL DEFAULT 0,
    charPenaltyExpiryTime INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS clans_leaderId ON clans(leaderId);

CREATE TABLE IF NOT EXISTS clan_simulation_clans (
    clanId INTEGER PRIMARY KEY REFERENCES clans(id) ON DELETE CASCADE,
    version INTEGER NOT NULL DEFAULT 1,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL,
    stateJson TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS clan_simulation_clans_updatedAt ON clan_simulation_clans(updatedAt);

CREATE TABLE IF NOT EXISTS clan_contributions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    clanId INTEGER NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
    characterId INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    targetLevel INTEGER NOT NULL,
    amount INTEGER NOT NULL CHECK(amount > 0),
    source TEXT NOT NULL DEFAULT 'adena',
    resolveKey TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    UNIQUE(clanId, characterId, targetLevel, resolveKey)
);
CREATE INDEX IF NOT EXISTS clan_contributions_clan_level ON clan_contributions(clanId, targetLevel, createdAt);

CREATE TABLE IF NOT EXISTS clan_warehouse_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    clanId INTEGER NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
    selfId INTEGER NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT '',
    amount INTEGER NOT NULL DEFAULT 1 CHECK(amount > 0),
    enchant INTEGER NOT NULL DEFAULT 0 CHECK(enchant >= 0),
    petData TEXT,
    reservedAmount INTEGER NOT NULL DEFAULT 0 CHECK(reservedAmount >= 0),
    createdAt INTEGER NOT NULL DEFAULT 0,
    updatedAt INTEGER NOT NULL DEFAULT 0,
    UNIQUE(clanId, selfId, enchant)
);
CREATE INDEX IF NOT EXISTS clan_warehouse_items_clan_self
    ON clan_warehouse_items(clanId, selfId, amount);

CREATE TABLE IF NOT EXISTS clan_warehouse_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    clanId INTEGER NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
    characterId INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    selfId INTEGER NOT NULL,
    amount INTEGER NOT NULL CHECK(amount > 0),
    operation TEXT NOT NULL,
    resolveKey TEXT NOT NULL,
    warehouseRevision INTEGER NOT NULL DEFAULT 0,
    createdAt INTEGER NOT NULL DEFAULT 0,
    UNIQUE(clanId, characterId, selfId, operation, resolveKey)
);
CREATE INDEX IF NOT EXISTS clan_warehouse_ledger_clan_item
    ON clan_warehouse_ledger(clanId, selfId, createdAt);

CREATE TABLE IF NOT EXISTS clan_warehouse_reservations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    clanId INTEGER NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
    selfId INTEGER NOT NULL,
    amount INTEGER NOT NULL CHECK(amount > 0),
    beneficiaryId INTEGER REFERENCES characters(id) ON DELETE SET NULL,
    goalKey TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'reserved' CHECK(status IN ('reserved', 'released', 'consumed')),
    createdAt INTEGER NOT NULL DEFAULT 0,
    updatedAt INTEGER NOT NULL DEFAULT 0,
    UNIQUE(clanId, selfId, goalKey)
);
CREATE INDEX IF NOT EXISTS clan_warehouse_reservations_active
    ON clan_warehouse_reservations(clanId, selfId, status, updatedAt);

CREATE TABLE IF NOT EXISTS clan_goal_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    clanId INTEGER NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
    eventType TEXT NOT NULL,
    goalType TEXT NOT NULL DEFAULT '',
    plan TEXT NOT NULL DEFAULT '',
    reasonCode TEXT NOT NULL DEFAULT '',
    payloadJson TEXT NOT NULL DEFAULT '{}',
    occurredAt INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS clan_goal_events_clan_recent
    ON clan_goal_events(clanId, occurredAt DESC, id DESC);

CREATE TABLE IF NOT EXISTS clan_market_demands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    clanId INTEGER NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
    itemId INTEGER NOT NULL,
    amount INTEGER NOT NULL CHECK(amount > 0),
    maxPrice INTEGER NOT NULL CHECK(maxPrice > 0),
    goalKey TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'fulfilled', 'cancelled')),
    createdAt INTEGER NOT NULL DEFAULT 0,
    updatedAt INTEGER NOT NULL DEFAULT 0,
    UNIQUE(clanId, itemId, goalKey)
);
CREATE INDEX IF NOT EXISTS clan_market_demands_item_status
    ON clan_market_demands(itemId, status, updatedAt);

CREATE TABLE IF NOT EXISTS clan_operations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    clanId INTEGER NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
    operationKey TEXT NOT NULL UNIQUE,
    operationType TEXT NOT NULL,
    targetNpcId INTEGER NOT NULL DEFAULT 0,
    leaderId INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    memberIdsJson TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'succeeded', 'failed', 'cancelled')),
    wins INTEGER NOT NULL DEFAULT 0,
    deaths INTEGER NOT NULL DEFAULT 0,
    reasonCode TEXT NOT NULL DEFAULT '',
    rewardJson TEXT NOT NULL DEFAULT '[]',
    createdAt INTEGER NOT NULL DEFAULT 0,
    updatedAt INTEGER NOT NULL DEFAULT 0,
    resolvedAt INTEGER
);
CREATE INDEX IF NOT EXISTS clan_operations_clan_status
    ON clan_operations(clanId, status, updatedAt);

CREATE TABLE IF NOT EXISTS clan_operation_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operationId INTEGER NOT NULL REFERENCES clan_operations(id) ON DELETE CASCADE,
    clanId INTEGER NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
    characterId INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'released')),
    reservedAt INTEGER NOT NULL DEFAULT 0,
    releasedAt INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS clan_operation_members_active_character
    ON clan_operation_members(characterId) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS clan_operation_members_operation
    ON clan_operation_members(operationId, status, characterId);

CREATE TABLE IF NOT EXISTS clan_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    clanId INTEGER NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
    actionKey TEXT NOT NULL UNIQUE,
    actionType TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
    attempt INTEGER NOT NULL DEFAULT 0,
    availableAt INTEGER NOT NULL DEFAULT 0,
    leaseUntil INTEGER,
    payloadJson TEXT NOT NULL DEFAULT '{}',
    resultJson TEXT NOT NULL DEFAULT '{}',
    reasonCode TEXT NOT NULL DEFAULT '',
    createdAt INTEGER NOT NULL DEFAULT 0,
    updatedAt INTEGER NOT NULL DEFAULT 0,
    resolvedAt INTEGER
);
CREATE INDEX IF NOT EXISTS clan_actions_due
    ON clan_actions(status, availableAt, priority DESC, id ASC);
CREATE INDEX IF NOT EXISTS clan_actions_clan_status
    ON clan_actions(clanId, status, updatedAt DESC, id DESC);

CREATE TABLE IF NOT EXISTS clan_crests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    clanId INTEGER NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'pledge',
    data BLOB NOT NULL,
    createdAt INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS clan_crests_clanId ON clan_crests(clanId);

CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    selfId INTEGER NOT NULL,
    name TEXT NOT NULL,
    amount INTEGER NOT NULL DEFAULT 1 CHECK(amount >= 0),
    enchant INTEGER NOT NULL DEFAULT 0 CHECK(enchant >= 0),
    equipped INTEGER NOT NULL DEFAULT 0,
    slot INTEGER NOT NULL DEFAULT 0,
    petData TEXT,
    characterId INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS items_characterId ON items(characterId);
CREATE INDEX IF NOT EXISTS items_characterId_selfId ON items(characterId, selfId);

CREATE TABLE IF NOT EXISTS character_recipes (
    characterId INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    recipeId INTEGER NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('dwarven', 'common')),
    PRIMARY KEY(characterId, recipeId, type)
);

CREATE TABLE IF NOT EXISTS character_quests (
    characterId INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    questId INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'created' CHECK(state IN ('created', 'started', 'completed')),
    variables TEXT,
    PRIMARY KEY(characterId, questId)
);

CREATE TABLE IF NOT EXISTS warehouse_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    selfId INTEGER NOT NULL,
    name TEXT NOT NULL,
    amount INTEGER NOT NULL DEFAULT 1 CHECK(amount >= 0),
    enchant INTEGER NOT NULL DEFAULT 0 CHECK(enchant >= 0),
    petData TEXT,
    characterId INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS warehouse_items_characterId ON warehouse_items(characterId);
CREATE INDEX IF NOT EXISTS warehouse_items_characterId_selfId ON warehouse_items(characterId, selfId);

CREATE TABLE IF NOT EXISTS skills (
    selfId INTEGER NOT NULL,
    name TEXT NOT NULL,
    passive INTEGER NOT NULL,
    level INTEGER NOT NULL,
    characterId INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    PRIMARY KEY(characterId, selfId)
);

CREATE TABLE IF NOT EXISTS shortcuts (
    id INTEGER NOT NULL,
    kind INTEGER NOT NULL,
    slot INTEGER NOT NULL,
    unknown INTEGER NOT NULL,
    characterId INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    PRIMARY KEY(characterId, slot)
);
CREATE INDEX IF NOT EXISTS shortcuts_characterId_kind_id ON shortcuts(characterId, kind, id);

CREATE TABLE IF NOT EXISTS macros (
    characterId INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    id INTEGER NOT NULL,
    icon INTEGER NOT NULL,
    name TEXT NOT NULL,
    descr TEXT NOT NULL,
    acronym TEXT NOT NULL,
    commands TEXT NOT NULL,
    PRIMARY KEY(characterId, id)
);

CREATE TABLE IF NOT EXISTS bot_life_state (
    characterId INTEGER PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
    accountName TEXT NOT NULL DEFAULT '',
    characterName TEXT NOT NULL DEFAULT '',
    level INTEGER NOT NULL DEFAULT 1,
    exp INTEGER NOT NULL DEFAULT 0,
    sp INTEGER NOT NULL DEFAULT 0,
    adena INTEGER NOT NULL DEFAULT 0,
    homeRegion TEXT,
    currentRegion TEXT,
    spotId TEXT,
    activity TEXT NOT NULL DEFAULT 'hunting',
    phase TEXT NOT NULL DEFAULT 'cold',
    activityStartedAt INTEGER,
    nextResolveAt INTEGER,
    lastResolvedAt INTEGER,
    lastHotAt INTEGER,
    locX INTEGER NOT NULL DEFAULT 0,
    locY INTEGER NOT NULL DEFAULT 0,
    locZ INTEGER NOT NULL DEFAULT 0,
    hp INTEGER NOT NULL DEFAULT 0,
    maxHp INTEGER NOT NULL DEFAULT 0,
    mp INTEGER NOT NULL DEFAULT 0,
    maxMp INTEGER NOT NULL DEFAULT 0,
    targetLevelBand TEXT,
    deathCount INTEGER NOT NULL DEFAULT 0,
    partyId TEXT,
    inventorySummary TEXT,
    statsJson TEXT,
    updatedAt INTEGER NOT NULL DEFAULT 0,
    simulationOwner TEXT NOT NULL DEFAULT 'legacy_main',
    simulationRevision INTEGER NOT NULL DEFAULT 0,
    simulationLeaseId TEXT,
    simulationLeaseUntil INTEGER NOT NULL DEFAULT 0,
    partyRequestStatus TEXT GENERATED ALWAYS AS (
        json_extract(statsJson, '$.partyRequest.status')
    ) VIRTUAL,
    partyRequestPriority TEXT GENERATED ALWAYS AS (
        json_extract(statsJson, '$.partyRequest.priority')
    ) VIRTUAL,
    partyRequestedAt INTEGER GENERATED ALWAYS AS (
        CAST(json_extract(statsJson, '$.partyRequest.requestedAt') AS INTEGER)
    ) VIRTUAL,
    partyObjectiveSpot TEXT GENERATED ALWAYS AS (
        COALESCE(
            json_extract(statsJson, '$.partyRequest.spotId'),
            json_extract(statsJson, '$.equipmentPlan.next.spotId'),
            spotId
        )
    ) VIRTUAL
);
CREATE INDEX IF NOT EXISTS bot_life_state_phase_nextResolveAt ON bot_life_state(phase, nextResolveAt);
CREATE INDEX IF NOT EXISTS bot_life_state_phase_partyId ON bot_life_state(phase, partyId);
CREATE INDEX IF NOT EXISTS bot_life_state_accountName ON bot_life_state(accountName);
CREATE INDEX IF NOT EXISTS bot_life_state_characterName ON bot_life_state(characterName COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS bot_life_state_market_reconcile ON bot_life_state(phase, updatedAt, characterId);
CREATE TABLE IF NOT EXISTS bot_goal_state (
    characterId INTEGER PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
    goalJson TEXT,
    updatedAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bot_personas (
    characterId INTEGER PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
    version INTEGER NOT NULL DEFAULT 1,
    seed TEXT NOT NULL,
    primaryDrive TEXT NOT NULL,
    archetype TEXT NOT NULL,
    traitsJson TEXT NOT NULL,
    textCard TEXT NOT NULL DEFAULT '',
    createdAt INTEGER NOT NULL DEFAULT 0,
    updatedAt INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS bot_personas_primaryDrive ON bot_personas(primaryDrive);
CREATE INDEX IF NOT EXISTS bot_personas_archetype ON bot_personas(archetype);

CREATE TABLE IF NOT EXISTS bot_social_memory (
    playerId INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    botId INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    playerName TEXT NOT NULL DEFAULT '',
    botName TEXT NOT NULL DEFAULT '',
    trust INTEGER NOT NULL DEFAULT 0,
    familiarity INTEGER NOT NULL DEFAULT 0,
    lastGroupedAt INTEGER,
    groupRuns INTEGER NOT NULL DEFAULT 0,
    wipesTogether INTEGER NOT NULL DEFAULT 0,
    helpedInCombat INTEGER NOT NULL DEFAULT 0,
    gaveUsefulLoot INTEGER NOT NULL DEFAULT 0,
    ignoredLootRequests INTEGER NOT NULL DEFAULT 0,
    tradesCompleted INTEGER NOT NULL DEFAULT 0,
    insults INTEGER NOT NULL DEFAULT 0,
    recentlyAbandonedAt INTEGER,
    notes TEXT,
    updatedAt INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(playerId, botId)
);

CREATE TABLE IF NOT EXISTS bot_conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    playerId INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    botId INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    summary TEXT NOT NULL DEFAULT '',
    summaryThroughId INTEGER NOT NULL DEFAULT 0,
    summaryThroughOrdinal INTEGER NOT NULL DEFAULT 0,
    nextTurnOrdinal INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 0,
    createdAt INTEGER NOT NULL DEFAULT 0,
    updatedAt INTEGER NOT NULL DEFAULT 0,
    UNIQUE(playerId, botId)
);
CREATE INDEX IF NOT EXISTS bot_conversations_bot_updated ON bot_conversations(botId, updatedAt DESC);

CREATE TABLE IF NOT EXISTS bot_conversation_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversationId INTEGER NOT NULL REFERENCES bot_conversations(id) ON DELETE CASCADE,
    turnId TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('player', 'bot', 'system')),
    channel TEXT NOT NULL DEFAULT 'local',
    text TEXT NOT NULL DEFAULT '',
    requestId TEXT,
    delivered INTEGER NOT NULL DEFAULT 1,
    createdAt INTEGER NOT NULL DEFAULT 0,
    metaJson TEXT,
    turnOrdinal INTEGER NOT NULL DEFAULT 0,
    messageOrder INTEGER NOT NULL DEFAULT 0,
    compacted INTEGER NOT NULL DEFAULT 0,
    UNIQUE(conversationId, turnId, role)
);
CREATE INDEX IF NOT EXISTS bot_conversation_messages_recent ON bot_conversation_messages(conversationId, id DESC);
CREATE INDEX IF NOT EXISTS bot_conversation_messages_turn ON bot_conversation_messages(conversationId, turnId, role);

CREATE TABLE IF NOT EXISTS bot_activity_journal (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    playerId INTEGER REFERENCES characters(id) ON DELETE CASCADE,
    botId INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    eventType TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    weight INTEGER NOT NULL DEFAULT 1,
    dedupeKey TEXT,
    count INTEGER NOT NULL DEFAULT 1,
    createdAt INTEGER NOT NULL DEFAULT 0,
    updatedAt INTEGER NOT NULL DEFAULT 0,
    metaJson TEXT
);
CREATE INDEX IF NOT EXISTS bot_activity_journal_pair_recent ON bot_activity_journal(playerId, botId, updatedAt DESC);
CREATE INDEX IF NOT EXISTS bot_activity_journal_bot_recent ON bot_activity_journal(botId, updatedAt DESC);
CREATE INDEX IF NOT EXISTS bot_activity_journal_coalesce ON bot_activity_journal(playerId, botId, eventType, dedupeKey, updatedAt);
CREATE INDEX IF NOT EXISTS bot_activity_journal_retention_age ON bot_activity_journal(updatedAt, id);
CREATE INDEX IF NOT EXISTS bot_activity_journal_pair_retention ON bot_activity_journal(botId, playerId, updatedAt DESC, id DESC);

CREATE TABLE IF NOT EXISTS bot_tool_outcomes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    playerId INTEGER REFERENCES characters(id) ON DELETE SET NULL,
    botId INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    turnId TEXT,
    toolName TEXT NOT NULL,
    outcome TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    worldRevision TEXT,
    createdAt INTEGER NOT NULL DEFAULT 0,
    metaJson TEXT
);
CREATE INDEX IF NOT EXISTS bot_tool_outcomes_bot_recent ON bot_tool_outcomes(botId, createdAt DESC);
CREATE INDEX IF NOT EXISTS bot_tool_outcomes_turn ON bot_tool_outcomes(botId, turnId, toolName, createdAt DESC);
CREATE INDEX IF NOT EXISTS bot_tool_outcomes_retention_age ON bot_tool_outcomes(createdAt, id);

CREATE TABLE IF NOT EXISTS bot_llm_turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    turnId TEXT NOT NULL UNIQUE,
    playerId INTEGER REFERENCES characters(id) ON DELETE SET NULL,
    botId INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    eventType TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT 'queued',
    requestId TEXT,
    traceId TEXT,
    startedAt INTEGER,
    finishedAt INTEGER,
    outcome TEXT,
    model TEXT,
    promptTokens INTEGER NOT NULL DEFAULT 0,
    completionTokens INTEGER NOT NULL DEFAULT 0,
    totalTokens INTEGER NOT NULL DEFAULT 0,
    cost REAL,
    error TEXT NOT NULL DEFAULT '',
    metaJson TEXT
);
CREATE INDEX IF NOT EXISTS bot_llm_turns_bot_recent ON bot_llm_turns(botId, id DESC);
CREATE INDEX IF NOT EXISTS bot_llm_turns_player_recent ON bot_llm_turns(playerId, id DESC);
CREATE INDEX IF NOT EXISTS bot_llm_turns_state_recent ON bot_llm_turns(state, id DESC);
CREATE INDEX IF NOT EXISTS bot_llm_turns_terminal_retention ON bot_llm_turns(state, COALESCE(finishedAt, startedAt, 0), id);
CREATE INDEX IF NOT EXISTS bot_llm_turns_active_retention ON bot_llm_turns(state, startedAt, id);

CREATE TABLE IF NOT EXISTS bot_negotiations (
    id TEXT PRIMARY KEY,
    playerId INTEGER REFERENCES characters(id) ON DELETE SET NULL,
    botId INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    itemObjectId INTEGER NOT NULL,
    itemSelfId INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    referenceUnitPrice INTEGER NOT NULL,
    desiredUnitPrice INTEGER NOT NULL,
    minimumUnitPrice INTEGER NOT NULL,
    maximumUnitPrice INTEGER NOT NULL,
    currentUnitPrice INTEGER NOT NULL,
    agreedTotalPrice INTEGER,
    round INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    expiresAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    metaJson TEXT
);
CREATE INDEX IF NOT EXISTS bot_negotiations_pair_recent ON bot_negotiations(playerId, botId, updatedAt DESC);
CREATE INDEX IF NOT EXISTS bot_negotiations_bot_recent ON bot_negotiations(botId, updatedAt DESC);

CREATE TABLE IF NOT EXISTS bot_friendships (
    playerId INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    botId INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'accepted',
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL,
    PRIMARY KEY (playerId, botId)
);
CREATE INDEX IF NOT EXISTS bot_friendships_player ON bot_friendships(playerId, status);

CREATE TABLE IF NOT EXISTS bot_friend_roster (
    playerId INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    botId INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    selectedAt INTEGER NOT NULL,
    PRIMARY KEY (playerId, botId)
);
CREATE INDEX IF NOT EXISTS bot_friend_roster_player ON bot_friend_roster(playerId, selectedAt);

CREATE TABLE IF NOT EXISTS bot_life_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    characterId INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    eventType TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    weight INTEGER NOT NULL DEFAULT 1,
    createdAt INTEGER NOT NULL DEFAULT 0,
    metaJson TEXT
);
CREATE INDEX IF NOT EXISTS bot_life_events_character_weight_created ON bot_life_events(characterId, weight DESC, createdAt DESC);
CREATE INDEX IF NOT EXISTS bot_life_events_recent ON bot_life_events(createdAt DESC, weight DESC);

CREATE TABLE IF NOT EXISTS bot_background_parties (
    partyId TEXT PRIMARY KEY,
    leaderId INTEGER NOT NULL DEFAULT 0,
    memberIdsJson TEXT,
    spotId TEXT,
    startedAt INTEGER NOT NULL DEFAULT 0,
    nextResolveAt INTEGER,
    cohesion REAL NOT NULL DEFAULT 0.65,
    risk REAL NOT NULL DEFAULT 0.25,
    status TEXT NOT NULL DEFAULT 'active',
    roleCoverageJson TEXT,
    statsJson TEXT,
    updatedAt INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS bot_background_parties_status_nextResolveAt ON bot_background_parties(status, nextResolveAt);
CREATE INDEX IF NOT EXISTS bot_background_parties_status_updatedAt ON bot_background_parties(status, updatedAt);
CREATE INDEX IF NOT EXISTS bot_background_parties_spotId ON bot_background_parties(spotId);

CREATE TABLE IF NOT EXISTS social_entities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    externalKey TEXT NOT NULL,
    displayName TEXT NOT NULL DEFAULT '',
    createdAt INTEGER NOT NULL DEFAULT 0,
    updatedAt INTEGER NOT NULL DEFAULT 0,
    retiredAt INTEGER,
    UNIQUE(kind, externalKey)
);

CREATE TABLE IF NOT EXISTS social_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    eventKey TEXT NOT NULL UNIQUE,
    sourceEntityId INTEGER NOT NULL REFERENCES social_entities(id) ON DELETE CASCADE,
    targetEntityId INTEGER NOT NULL REFERENCES social_entities(id) ON DELETE CASCADE,
    contextEntityId INTEGER REFERENCES social_entities(id) ON DELETE SET NULL,
    eventType TEXT NOT NULL,
    magnitude INTEGER NOT NULL DEFAULT 1,
    salience INTEGER NOT NULL DEFAULT 1 CHECK(salience BETWEEN 1 AND 10),
    affinityDelta INTEGER NOT NULL DEFAULT 0,
    trustDelta INTEGER NOT NULL DEFAULT 0,
    respectDelta INTEGER NOT NULL DEFAULT 0,
    fearDelta INTEGER NOT NULL DEFAULT 0,
    hostilityDelta INTEGER NOT NULL DEFAULT 0,
    familiarityDelta INTEGER NOT NULL DEFAULT 0,
    occurredAt INTEGER NOT NULL DEFAULT 0,
    payloadJson TEXT
);
CREATE INDEX IF NOT EXISTS social_events_source_recent ON social_events(sourceEntityId, occurredAt DESC, id DESC);
CREATE INDEX IF NOT EXISTS social_events_target_recent ON social_events(targetEntityId, occurredAt DESC, id DESC);
CREATE INDEX IF NOT EXISTS social_events_context_recent ON social_events(contextEntityId, occurredAt DESC, id DESC);
CREATE INDEX IF NOT EXISTS social_events_retention ON social_events(occurredAt, id);

CREATE TABLE IF NOT EXISTS social_relations (
    sourceEntityId INTEGER NOT NULL REFERENCES social_entities(id) ON DELETE CASCADE,
    targetEntityId INTEGER NOT NULL REFERENCES social_entities(id) ON DELETE CASCADE,
    affinity INTEGER NOT NULL DEFAULT 0 CHECK(affinity BETWEEN -100 AND 100),
    trust INTEGER NOT NULL DEFAULT 0 CHECK(trust BETWEEN -100 AND 100),
    respect INTEGER NOT NULL DEFAULT 0 CHECK(respect BETWEEN -100 AND 100),
    fear INTEGER NOT NULL DEFAULT 0 CHECK(fear BETWEEN -100 AND 100),
    hostility INTEGER NOT NULL DEFAULT 0 CHECK(hostility BETWEEN -100 AND 100),
    familiarity INTEGER NOT NULL DEFAULT 0 CHECK(familiarity >= 0),
    evidenceCount INTEGER NOT NULL DEFAULT 0 CHECK(evidenceCount >= 0),
    lastEventId INTEGER REFERENCES social_events(id) ON DELETE SET NULL,
    lastInteractionAt INTEGER,
    updatedAt INTEGER NOT NULL DEFAULT 0,
    revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
    metaJson TEXT,
    PRIMARY KEY(sourceEntityId, targetEntityId),
    CHECK(sourceEntityId <> targetEntityId)
);
CREATE INDEX IF NOT EXISTS social_relations_source_updated ON social_relations(sourceEntityId, updatedAt DESC, targetEntityId);
CREATE INDEX IF NOT EXISTS social_relations_target_updated ON social_relations(targetEntityId, updatedAt DESC, sourceEntityId);

CREATE TABLE IF NOT EXISTS social_projection_cursors (
    consumer TEXT PRIMARY KEY,
    lastEventId INTEGER NOT NULL DEFAULT 0 CHECK(lastEventId >= 0),
    updatedAt INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO sqlite_sequence(name, seq) VALUES ('characters', 1999999);
UPDATE sqlite_sequence SET seq = MAX(seq, 1999999) WHERE name = 'characters';
INSERT OR IGNORE INTO sqlite_sequence(name, seq) VALUES ('clans', 5999999);
UPDATE sqlite_sequence SET seq = MAX(seq, 5999999) WHERE name = 'clans';
INSERT OR IGNORE INTO sqlite_sequence(name, seq) VALUES ('items', 3999999);
UPDATE sqlite_sequence SET seq = MAX(seq, 3999999) WHERE name = 'items';
