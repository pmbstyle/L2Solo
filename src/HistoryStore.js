'use strict';

// History database: finished events and analytics, kept in a second SQLite
// file next to the world file. The world transaction writes one small row into
// history_outbox; the history thread (HistoryWorker.js) moves the rows here in
// batches. The outbox id of the last moved row is stored here in the same
// transaction as the moved rows, so a crash between moving and deleting the
// outbox rows never moves a row twice.
//
// Plain functions over a node:sqlite connection: used by the history thread,
// by the one-time move of an old world and by tests.

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const Statements = require('./DatabaseStatements');

const SCHEMA_FILE = path.join(__dirname, '..', 'database', 'sql', 'history.sql');
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MARKET_TRADE_RETENTION_MS = 90 * DAY_MS;
const MARKET_STORE_RETENTION_MS = 90 * DAY_MS;
const JOURNAL_RETENTION_HOURS = 14 * 24;
const PVP_RAW_RETENTION_MS = 12 * HOUR_MS;
const CLAN_ACTION_DETAIL_RETENTION_MS = HOUR_MS;
const RETENTION_BATCH = 5000;
const CURSOR_KEY = 'outboxCursor';
const WORLD_TOKEN_KEY = 'worldToken';
const TERMINAL_CLAN_ACTION = "('succeeded', 'failed', 'cancelled')";

const LIFE_EVENT_ROUTINE_TYPES = new Set(['rest', 'hunt']);
const LIFE_EVENT_ROUTINE_WINDOW_MS = 30 * 60 * 1000;
const LIFE_EVENTS_PER_BOT = 20;

const PVP_COLUMNS = ['at', 'source', 'conflictKey', 'action', 'reason', 'spotId', 'npcId', 'matchup', 'outcome', 'pvp',
    'initiatorId', 'initiatorLevel', 'initiatorArchetype', 'initiatorKarma', 'targetId', 'targetLevel', 'targetArchetype',
    'targetKarma', 'sideSizes', 'losingSide', 'kills', 'pkKills', 'durationMs', 'playerInvolved', 'actions'];
const MARKET_TRADE_COLUMNS = ['eventKey', 'occurredAt', 'channel', 'sourceType', 'selfId', 'itemName',
    'quantity', 'unitPrice', 'totalPrice', 'town', 'sellerCharacterId', 'sellerName', 'buyerCharacterId', 'buyerName'];
const AFK_EVENT_COLUMNS = ['shopId', 'ownerId', 'counterpartyId', 'kind', 'selfId', 'itemName', 'amount',
    'unitPrice', 'totalPrice', 'createdAt'];
const CLAN_GOAL_EVENT_COLUMNS = ['clanId', 'eventType', 'goalType', 'plan', 'reasonCode', 'payloadJson', 'occurredAt'];
const CLAN_ACTION_COLUMNS = ['id', 'clanId', 'actionKey', 'actionType', 'priority', 'status', 'attempt', 'availableAt',
    'leaseUntil', 'payloadJson', 'resultJson', 'reasonCode', 'createdAt', 'updatedAt', 'resolvedAt'];
const MARKET_STORE_COLUMNS = ['storeId', 'characterId', 'characterName', 'storeType', 'eventType', 'reason',
    'occurredAt', 'openedAt', 'town', 'itemsJson'];

// Whole tables that used to live in the world file. clan_actions is split by
// status instead (see moveWorldTables).
const MOVED_TABLES = ['market_trades', 'afk_trade_events', 'clan_goal_events', 'bot_life_events',
    'market_store_events', 'economy_flow_hour', 'pvp_conflicts', 'pvp_conflict_hour'];
// Tables whose new ids are outbox ids: the outbox sequence starts above them.
const OUTBOX_ID_TABLES = ['afk_trade_events', 'clan_goal_events'];

// <world>.sqlite -> <world>.history.sqlite unless the config names a file
// (Database.historyPath, relative to `base` like Database.path).
function pathFor(worldPath, configured = '', base = process.cwd()) {
    if (configured) return path.resolve(base, configured);
    const resolved = path.resolve(base, worldPath);
    return resolved.endsWith('.sqlite')
        ? `${resolved.slice(0, -'.sqlite'.length)}.history.sqlite`
        : `${resolved}.history.sqlite`;
}

function open(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const connection = new DatabaseSync(file, { timeout: 5000 });
    connection.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
    connection.exec(fs.readFileSync(SCHEMA_FILE, 'utf8'));
    // A history file made before pvp_conflicts had the fight's actions.
    if (!connection.prepare('PRAGMA table_info(pvp_conflicts)').all().some((column) => column.name === 'actions')) {
        connection.exec('ALTER TABLE pvp_conflicts ADD COLUMN actions INTEGER NOT NULL DEFAULT 0');
    }
    return connection;
}

function meta(connection, key) {
    const row = Statements.prepare(connection, 'SELECT value FROM history_meta WHERE key = ?').get(key);
    return row ? String(row.value) : null;
}

function setMeta(connection, key, value) {
    Statements.prepare(connection, `INSERT INTO history_meta (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value));
}

function cursor(connection) {
    return Number(meta(connection, CURSOR_KEY) || 0);
}

function insertSql(table, columns, conflict = 'OR IGNORE') {
    return `INSERT ${conflict} INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
}

function values(row, columns) {
    return columns.map((column) => (row[column] === undefined ? null : row[column]));
}

function pruneLifeEventsByRecency(connection, characterId) {
    Statements.prepare(connection, `DELETE FROM bot_life_events
        WHERE characterId = ?
        AND id NOT IN (
            WITH recent AS (
                SELECT id FROM bot_life_events WHERE characterId = ?
                ORDER BY createdAt DESC, id DESC LIMIT 10
            ), milestones AS (
                SELECT id FROM bot_life_events WHERE characterId = ?
                    AND eventType IN ('equipment_craft', 'dual_sword_combine', 'component_craft',
                        'gear_acquisition_started', 'craft_materials_ready', 'level_up', 'class_change')
                    AND id NOT IN (SELECT id FROM recent)
                ORDER BY createdAt DESC, id DESC LIMIT 5
            ), important AS (
                SELECT id FROM bot_life_events WHERE characterId = ?
                    AND id NOT IN (SELECT id FROM recent UNION SELECT id FROM milestones)
                ORDER BY weight DESC, createdAt DESC, id DESC
                LIMIT (${LIFE_EVENTS_PER_BOT} - (SELECT COUNT(*) FROM recent) - (SELECT COUNT(*) FROM milestones))
            )
            SELECT id FROM recent UNION SELECT id FROM milestones UNION SELECT id FROM important
        )`).run(characterId, characterId, characterId, characterId);
}

function pruneLifeEventsByWeight(connection, characterId) {
    Statements.prepare(connection, `DELETE FROM bot_life_events
        WHERE characterId = ?
        AND id NOT IN (
            SELECT id FROM (
                SELECT id FROM bot_life_events
                WHERE characterId = ?
                ORDER BY weight DESC, createdAt DESC
                LIMIT ${LIFE_EVENTS_PER_BOT}
            ) keep_rows
        )`).run(characterId, characterId);
}

// A routine event (rest, hunt) updates the bot's latest one of the same type
// within 30 minutes instead of adding a row. Returns true when a row was added.
function writeLifeEvent(connection, characterId, event) {
    const createdAt = Number(event.createdAt);
    const metaJson = JSON.stringify(event.meta || {});
    if (event.coalesce && LIFE_EVENT_ROUTINE_TYPES.has(event.eventType)) {
        const updated = Statements.prepare(connection, `UPDATE bot_life_events
            SET summary = ?,
                weight = MAX(weight, ?),
                createdAt = ?,
                metaJson = json_set(
                    ?, '$.coalescedCount',
                    COALESCE(CAST(json_extract(metaJson, '$.coalescedCount') AS INTEGER), 1) + 1
                )
            WHERE id = (
                SELECT id FROM bot_life_events
                WHERE characterId = ? AND eventType = ? AND createdAt >= ?
                ORDER BY createdAt DESC, id DESC
                LIMIT 1
            )`).run(event.summary, event.weight, createdAt, metaJson, characterId, event.eventType,
            createdAt - LIFE_EVENT_ROUTINE_WINDOW_MS);
        if (Number(updated.changes || 0) > 0) return false;
    }
    Statements.prepare(connection, `INSERT INTO bot_life_events
        (characterId, eventType, summary, weight, createdAt, metaJson) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(characterId, event.eventType, event.summary, event.weight, createdAt, metaJson);
    return true;
}

// One function per outbox kind: (connection, payload, outboxId).
const APPLY = {
    market_trade(connection, row) {
        Statements.prepare(connection, insertSql('market_trades', MARKET_TRADE_COLUMNS))
            .run(...values(row, MARKET_TRADE_COLUMNS));
    },
    afk_event(connection, row, id) {
        Statements.prepare(connection, insertSql('afk_trade_events', ['id', ...AFK_EVENT_COLUMNS]))
            .run(id, ...values(row, AFK_EVENT_COLUMNS));
    },
    afk_delivered(connection, { ownerId, ids = [], at }) {
        if (!ids.length) return;
        Statements.prepare(connection, `UPDATE afk_trade_events SET deliveredAt = ?
            WHERE ownerId = ? AND deliveredAt IS NULL AND id IN (${ids.map(() => '?').join(', ')})`)
            .run(at, ownerId, ...ids);
    },
    clan_goal_event(connection, row, id) {
        Statements.prepare(connection, insertSql('clan_goal_events', ['id', ...CLAN_GOAL_EVENT_COLUMNS]))
            .run(id, ...values(row, CLAN_GOAL_EVENT_COLUMNS));
    },
    clan_action(connection, row) {
        Statements.prepare(connection, insertSql('clan_actions', CLAN_ACTION_COLUMNS))
            .run(...values(row, CLAN_ACTION_COLUMNS));
    },
    // { characterId, events: [{ eventType, summary, weight, createdAt, meta, coalesce }], prune: 'recent'|'weight' }
    life_events(connection, { characterId, events = [], prune = 'recent' }) {
        let inserted = false;
        events.forEach((event) => {
            if (writeLifeEvent(connection, characterId, event)) inserted = true;
        });
        if (!inserted) return;
        if (prune === 'weight') pruneLifeEventsByWeight(connection, characterId);
        else pruneLifeEventsByRecency(connection, characterId);
    },
    // Written by the world triggers (market-store-outbox.sql); json_object()
    // embeds a store's item list as JSON, the '[]' fallback as text.
    market_store(connection, row) {
        const itemsJson = typeof row.itemsJson === 'string' ? row.itemsJson : JSON.stringify(row.itemsJson ?? []);
        Statements.prepare(connection, insertSql('market_store_events', MARKET_STORE_COLUMNS))
            .run(...values({ ...row, itemsJson }, MARKET_STORE_COLUMNS));
    },
    // The economy and PvP journals gathered in memory over one flush interval.
    journal(connection, { rows = [], conflicts = [] }) {
        const upsert = Statements.prepare(connection, `INSERT INTO economy_flow_hour
            (hour, operation, store, selfId, delta, events) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(hour, operation, store, selfId) DO UPDATE SET
                delta = delta + excluded.delta, events = events + excluded.events`);
        rows.forEach((row) => upsert.run(row.hour, row.operation, row.store, row.selfId, row.delta, row.events));
        if (!conflicts.length) return;
        const insertConflict = Statements.prepare(connection, insertSql('pvp_conflicts', PVP_COLUMNS, ''));
        const summary = Statements.prepare(connection, `INSERT INTO pvp_conflict_hour
            (hour, source, action, outcome, conflicts, kills, pkKills, playerInvolved) VALUES (?, ?, ?, ?, 1, ?, ?, ?)
            ON CONFLICT(hour, source, action, outcome) DO UPDATE SET conflicts = conflicts + 1,
                kills = kills + excluded.kills, pkKills = pkKills + excluded.pkKills,
                playerInvolved = playerInvolved + excluded.playerInvolved`);
        conflicts.forEach((conflict) => {
            insertConflict.run(...values(conflict, PVP_COLUMNS));
            summary.run(Math.floor(conflict.at / HOUR_MS), conflict.source, conflict.action,
                conflict.outcome, conflict.kills, conflict.pkKills, conflict.playerInvolved);
        });
    }
};

// Moves up to `limit` outbox rows from the world into the history file in one
// history transaction. A row that cannot be applied is skipped and counted;
// it must not block every row behind it. Returns { moved, failed, upTo }.
function transfer(history, world, limit = 1000) {
    const from = cursor(history);
    const rows = Statements.prepare(world, 'SELECT id, kind, payload FROM history_outbox WHERE id > ? ORDER BY id LIMIT ?')
        .all(from, limit);
    if (!rows.length) return { moved: 0, failed: 0, upTo: from, errors: [] };
    const errors = [];
    history.exec('BEGIN IMMEDIATE');
    try {
        rows.forEach((row) => {
            history.exec('SAVEPOINT history_row');
            try {
                const apply = APPLY[row.kind];
                if (!apply) throw new Error(`unknown history kind ${row.kind}`);
                apply(history, JSON.parse(row.payload), Number(row.id));
                history.exec('RELEASE history_row');
            } catch (error) {
                history.exec('ROLLBACK TO history_row');
                history.exec('RELEASE history_row');
                errors.push(`${row.kind}#${row.id}: ${error.message}`);
            }
        });
        const upTo = Number(rows[rows.length - 1].id);
        setMeta(history, CURSOR_KEY, upTo);
        history.exec('COMMIT');
        return { moved: rows.length - errors.length, failed: errors.length, upTo, errors };
    } catch (error) {
        history.exec('ROLLBACK');
        throw error;
    }
}

// Age cleanup, the same rules as when these tables lived in the world.
function retention(history, timestamp = Date.now()) {
    const hour = Math.floor(timestamp / HOUR_MS);
    const detailCutoff = timestamp - CLAN_ACTION_DETAIL_RETENTION_MS;
    const statements = [
        [`DELETE FROM market_trades WHERE id IN (SELECT id FROM market_trades
            WHERE occurredAt < ? ORDER BY occurredAt LIMIT ${RETENTION_BATCH})`, [timestamp - MARKET_TRADE_RETENTION_MS]],
        [`DELETE FROM market_store_events WHERE id IN (SELECT id FROM market_store_events
            WHERE occurredAt < ? ORDER BY occurredAt, id LIMIT ${RETENTION_BATCH})`, [timestamp - MARKET_STORE_RETENTION_MS]],
        ['DELETE FROM economy_flow_hour WHERE hour < ?', [hour - JOURNAL_RETENTION_HOURS]],
        ['DELETE FROM pvp_conflict_hour WHERE hour < ?', [hour - JOURNAL_RETENTION_HOURS]],
        [`DELETE FROM pvp_conflicts WHERE id IN (SELECT id FROM pvp_conflicts
            WHERE at < ? ORDER BY at LIMIT ${RETENTION_BATCH})`, [timestamp - PVP_RAW_RETENTION_MS]],
        // Finished clan actions and their events keep their details for an hour.
        [`UPDATE clan_actions SET payloadJson = '{}', resultJson = '{}'
            WHERE id IN (SELECT id FROM clan_actions INDEXED BY clan_actions_uncompacted_details
                WHERE resolvedAt IS NOT NULL AND resolvedAt < ?
                  AND (payloadJson <> '{}' OR resultJson <> '{}')
                ORDER BY resolvedAt, id LIMIT ${RETENTION_BATCH})`, [detailCutoff]],
        [`UPDATE clan_goal_events SET payloadJson = '{}'
            WHERE id IN (SELECT id FROM clan_goal_events INDEXED BY clan_goal_events_uncompacted_details
                WHERE eventType IN ('action_succeeded', 'action_failed', 'action_cancelled')
                  AND occurredAt < ? AND payloadJson <> '{}'
                ORDER BY occurredAt, id LIMIT ${RETENTION_BATCH})`, [detailCutoff]]
    ];
    let changed = 0;
    statements.forEach(([sql, params]) => {
        changed += Number(Statements.prepare(history, sql).run(...params).changes || 0);
    });
    return changed;
}

function tableColumns(connection, schema, table) {
    return connection.prepare(`PRAGMA ${schema}.table_info(${table})`).all().map((column) => String(column.name));
}

function tableExists(connection, schema, table) {
    return !!connection.prepare(`SELECT 1 FROM ${schema}.sqlite_master WHERE type = 'table' AND name = ?`).get(table);
}

// Every row the old world kept in its own file once: copied into the history
// file (ids kept, a repeated copy is ignored), then dropped from the world.
// Each table is copied and dropped in its own steps, so an interrupted move
// resumes at the next start without duplicates. Runs before the history
// thread starts. Returns the number of rows copied per table.
function moveWorldTables(world, historyPath) {
    const pending = MOVED_TABLES.filter((table) => tableExists(world, 'main', table));
    const terminalActions = tableExists(world, 'main', 'clan_actions')
        && !!world.prepare(`SELECT 1 FROM main.clan_actions WHERE status IN ${TERMINAL_CLAN_ACTION} LIMIT 1`).get();
    if (!pending.length && !terminalActions) return {};
    const copied = {};
    world.prepare('ATTACH DATABASE ? AS history').run(historyPath);
    try {
        if (pending.includes('market_trades') && pending.includes('afk_trade_events')) {
            // The world schema re-added AFK events to market_trades at every
            // start; do it a last time before the tables leave the world.
            world.exec(`INSERT OR IGNORE INTO main.market_trades (
                    eventKey, occurredAt, channel, sourceType, selfId, itemName,
                    quantity, unitPrice, totalPrice, town,
                    sellerCharacterId, sellerName, buyerCharacterId, buyerName
                )
                SELECT 'afk:' || events.id, events.createdAt,
                    CASE events.kind WHEN 'purchase' THEN 'wtb' ELSE 'player_wts' END,
                    CASE events.kind WHEN 'purchase' THEN 'afk_player_buy_store' ELSE 'afk_player_store' END,
                    events.selfId, events.itemName, events.amount, events.unitPrice, events.totalPrice,
                    shops.town,
                    CASE events.kind WHEN 'purchase' THEN events.counterpartyId ELSE events.ownerId END,
                    CASE events.kind WHEN 'purchase' THEN counterparty.name ELSE owner.name END,
                    CASE events.kind WHEN 'purchase' THEN events.ownerId ELSE events.counterpartyId END,
                    CASE events.kind WHEN 'purchase' THEN owner.name ELSE counterparty.name END
                FROM main.afk_trade_events events
                LEFT JOIN main.afk_trade_shops shops ON shops.id = events.shopId
                LEFT JOIN main.characters owner ON owner.id = events.ownerId
                LEFT JOIN main.characters counterparty ON counterparty.id = events.counterpartyId`);
        }
        pending.forEach((table) => {
            const worldColumns = new Set(tableColumns(world, 'main', table));
            const columns = tableColumns(world, 'history', table).filter((column) => worldColumns.has(column));
            const list = columns.join(', ');
            copied[table] = Number(world.prepare(`INSERT OR IGNORE INTO history.${table} (${list})
                SELECT ${list} FROM main.${table}`).run().changes || 0);
            world.exec('BEGIN IMMEDIATE');
            try {
                if (OUTBOX_ID_TABLES.includes(table)) {
                    const maximum = Number(world.prepare(`SELECT MAX(id) AS id FROM main.${table}`).get()?.id || 0);
                    world.prepare("INSERT OR IGNORE INTO main.sqlite_sequence(name, seq) VALUES ('history_outbox', 0)").run();
                    world.prepare("UPDATE main.sqlite_sequence SET seq = MAX(seq, ?) WHERE name = 'history_outbox'").run(maximum);
                }
                world.exec(`DROP TABLE main.${table}`);
                world.exec('COMMIT');
            } catch (error) {
                world.exec('ROLLBACK');
                throw error;
            }
        });
        if (terminalActions) {
            copied.clan_actions = Number(world.prepare(`INSERT OR IGNORE INTO history.clan_actions (${CLAN_ACTION_COLUMNS.join(', ')})
                SELECT ${CLAN_ACTION_COLUMNS.join(', ')} FROM main.clan_actions WHERE status IN ${TERMINAL_CLAN_ACTION}`).run().changes || 0);
            world.exec(`DELETE FROM main.clan_actions WHERE status IN ${TERMINAL_CLAN_ACTION}`);
        }
    } finally {
        world.exec('DETACH DATABASE history');
    }
    return copied;
}

module.exports = {
    APPLY,
    CLAN_ACTION_COLUMNS,
    CURSOR_KEY,
    HOUR_MS,
    MARKET_TRADE_RETENTION_MS,
    MOVED_TABLES,
    PVP_COLUMNS,
    WORLD_TOKEN_KEY,
    cursor,
    meta,
    moveWorldTables,
    open,
    pathFor,
    retention,
    setMeta,
    transfer
};
