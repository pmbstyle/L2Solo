PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    appliedAt INTEGER NOT NULL
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
    updatedAt INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS bot_life_state_phase_nextResolveAt ON bot_life_state(phase, nextResolveAt);
CREATE INDEX IF NOT EXISTS bot_life_state_phase_partyId ON bot_life_state(phase, partyId);
CREATE INDEX IF NOT EXISTS bot_life_state_accountName ON bot_life_state(accountName);
CREATE INDEX IF NOT EXISTS bot_life_state_characterName ON bot_life_state(characterName COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS bot_life_state_party_request_filter
    ON bot_life_state(
        phase,
        partyId,
        activity,
        json_extract(statsJson, '$.partyRequest.status'),
        json_extract(statsJson, '$.partyRequest.priority')
    );
CREATE INDEX IF NOT EXISTS bot_life_state_party_objective_spot
    ON bot_life_state(
        phase,
        partyId,
        activity,
        COALESCE(
            json_extract(statsJson, '$.partyRequest.spotId'),
            json_extract(statsJson, '$.equipmentPlan.next.spotId'),
            spotId
        )
    );

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
CREATE INDEX IF NOT EXISTS bot_background_parties_spotId ON bot_background_parties(spotId);

INSERT OR IGNORE INTO sqlite_sequence(name, seq) VALUES ('characters', 1999999);
UPDATE sqlite_sequence SET seq = MAX(seq, 1999999) WHERE name = 'characters';
INSERT OR IGNORE INTO sqlite_sequence(name, seq) VALUES ('clans', 5999999);
UPDATE sqlite_sequence SET seq = MAX(seq, 5999999) WHERE name = 'clans';
INSERT OR IGNORE INTO sqlite_sequence(name, seq) VALUES ('items', 3999999);
UPDATE sqlite_sequence SET seq = MAX(seq, 3999999) WHERE name = 'items';
