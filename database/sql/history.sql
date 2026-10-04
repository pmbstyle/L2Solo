-- History database (src/HistoryStore.js): finished events and analytics.
-- Written only by the history thread (src/HistoryWorker.js), which moves the
-- world's history_outbox rows here in batches. No foreign keys: the parents
-- (characters, clans, shops) live in the world database.

CREATE TABLE IF NOT EXISTS history_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS market_trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    eventKey TEXT NOT NULL UNIQUE,
    occurredAt INTEGER NOT NULL,
    channel TEXT NOT NULL,
    sourceType TEXT NOT NULL DEFAULT '',
    selfId INTEGER NOT NULL,
    itemName TEXT NOT NULL DEFAULT '',
    quantity INTEGER NOT NULL CHECK(quantity > 0),
    unitPrice INTEGER NOT NULL CHECK(unitPrice >= 0),
    totalPrice INTEGER NOT NULL CHECK(totalPrice >= 0),
    town TEXT,
    sellerCharacterId INTEGER,
    sellerName TEXT,
    buyerCharacterId INTEGER,
    buyerName TEXT
);
CREATE INDEX IF NOT EXISTS market_trades_item_recent
    ON market_trades(selfId, occurredAt DESC, id DESC);
CREATE INDEX IF NOT EXISTS market_trades_recent
    ON market_trades(occurredAt DESC, id DESC);
CREATE INDEX IF NOT EXISTS market_trades_town_recent
    ON market_trades(town, occurredAt DESC, id DESC);

-- The id is the outbox id of the world transaction that made the trade.
CREATE TABLE IF NOT EXISTS afk_trade_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shopId INTEGER,
    ownerId INTEGER NOT NULL,
    counterpartyId INTEGER,
    kind TEXT NOT NULL CHECK(kind IN ('sale', 'purchase')),
    selfId INTEGER NOT NULL,
    itemName TEXT NOT NULL DEFAULT '',
    amount INTEGER NOT NULL CHECK(amount > 0),
    unitPrice INTEGER NOT NULL CHECK(unitPrice >= 0),
    totalPrice INTEGER NOT NULL CHECK(totalPrice >= 0),
    createdAt INTEGER NOT NULL,
    deliveredAt INTEGER
);
CREATE INDEX IF NOT EXISTS afk_trade_events_owner_delivery
    ON afk_trade_events(ownerId, deliveredAt, id);

-- The id is the outbox id of the world transaction that wrote the event.
CREATE TABLE IF NOT EXISTS clan_goal_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    clanId INTEGER NOT NULL,
    eventType TEXT NOT NULL,
    goalType TEXT NOT NULL DEFAULT '',
    plan TEXT NOT NULL DEFAULT '',
    reasonCode TEXT NOT NULL DEFAULT '',
    payloadJson TEXT NOT NULL DEFAULT '{}',
    occurredAt INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS clan_goal_events_clan_recent
    ON clan_goal_events(clanId, occurredAt DESC, id DESC);
CREATE INDEX IF NOT EXISTS clan_goal_events_meaningful_recent
    ON clan_goal_events(clanId, occurredAt DESC, id DESC)
    WHERE eventType != 'action_succeeded';
CREATE INDEX IF NOT EXISTS clan_goal_events_uncompacted_details
    ON clan_goal_events(occurredAt, id)
    WHERE eventType IN ('action_succeeded', 'action_failed', 'action_cancelled')
      AND payloadJson <> '{}';

-- Finished clan actions (succeeded, failed, cancelled), keeping their world id.
-- Pending and running actions stay in the world's clan_actions.
CREATE TABLE IF NOT EXISTS clan_actions (
    id INTEGER PRIMARY KEY,
    clanId INTEGER NOT NULL,
    actionKey TEXT NOT NULL UNIQUE,
    actionType TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK(status IN ('succeeded', 'failed', 'cancelled')),
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
CREATE INDEX IF NOT EXISTS clan_actions_clan_recent
    ON clan_actions(clanId, status, updatedAt DESC, id DESC);
CREATE INDEX IF NOT EXISTS clan_actions_uncompacted_details
    ON clan_actions(resolvedAt, id)
    WHERE payloadJson <> '{}' OR resultJson <> '{}';

CREATE TABLE IF NOT EXISTS bot_life_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    characterId INTEGER NOT NULL,
    eventType TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    weight INTEGER NOT NULL DEFAULT 1,
    createdAt INTEGER NOT NULL DEFAULT 0,
    metaJson TEXT
);
CREATE INDEX IF NOT EXISTS bot_life_events_character_weight_created ON bot_life_events(characterId, weight DESC, createdAt DESC);
CREATE INDEX IF NOT EXISTS bot_life_events_recent ON bot_life_events(createdAt DESC, weight DESC);

CREATE TABLE IF NOT EXISTS market_store_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    storeId TEXT NOT NULL,
    characterId INTEGER NOT NULL,
    characterName TEXT NOT NULL,
    storeType INTEGER NOT NULL,
    eventType TEXT NOT NULL CHECK(eventType IN ('opened', 'closed')),
    reason TEXT NOT NULL,
    occurredAt INTEGER NOT NULL,
    openedAt INTEGER NOT NULL,
    town TEXT,
    itemsJson TEXT NOT NULL,
    UNIQUE(storeId, eventType)
);
CREATE INDEX IF NOT EXISTS market_store_events_recent ON market_store_events(occurredAt, id);
CREATE INDEX IF NOT EXISTS market_store_events_owner ON market_store_events(characterId, occurredAt);

-- Economy journal (src/EconomyJournal.js): adena and item changes summed per
-- hour (epoch hours), database operation, store and item.
CREATE TABLE IF NOT EXISTS economy_flow_hour (
    hour INTEGER NOT NULL,
    operation TEXT NOT NULL,
    store TEXT NOT NULL,
    selfId INTEGER NOT NULL,
    delta INTEGER NOT NULL DEFAULT 0,
    events INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (hour, operation, store, selfId)
) WITHOUT ROWID;

-- PvP journal (src/PvpJournal.js): raw conflicts for hours, an hourly summary for days.
CREATE TABLE IF NOT EXISTS pvp_conflicts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    source TEXT NOT NULL,
    conflictKey TEXT,
    action TEXT NOT NULL,
    reason TEXT,
    spotId TEXT,
    npcId INTEGER,
    matchup TEXT,
    outcome TEXT NOT NULL,
    pvp INTEGER NOT NULL DEFAULT 0,
    initiatorId INTEGER NOT NULL,
    initiatorLevel INTEGER NOT NULL DEFAULT 0,
    initiatorArchetype TEXT,
    initiatorKarma INTEGER NOT NULL DEFAULT 0,
    targetId INTEGER NOT NULL,
    targetLevel INTEGER NOT NULL DEFAULT 0,
    targetArchetype TEXT,
    targetKarma INTEGER NOT NULL DEFAULT 0,
    sideSizes TEXT,
    losingSide INTEGER,
    kills INTEGER NOT NULL DEFAULT 0,
    pkKills INTEGER NOT NULL DEFAULT 0,
    durationMs INTEGER NOT NULL DEFAULT 0,
    playerInvolved INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS pvp_conflicts_at ON pvp_conflicts(at);
CREATE TABLE IF NOT EXISTS pvp_conflict_hour (
    hour INTEGER NOT NULL,
    source TEXT NOT NULL,
    action TEXT NOT NULL,
    outcome TEXT NOT NULL,
    conflicts INTEGER NOT NULL DEFAULT 0,
    kills INTEGER NOT NULL DEFAULT 0,
    pkKills INTEGER NOT NULL DEFAULT 0,
    playerInvolved INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (hour, source, action, outcome)
) WITHOUT ROWID;
