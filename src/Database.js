const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const CheckpointCoordinator = require('./DatabaseCheckpointCoordinator');

let connection;
let queryTail = Promise.resolve();
let shuttingDown = false;
let closePromise = null;
let databasePath;
let flushPendingCharacterWrites = null;
const cooperative = {
    depth: 0,
    sliceStartedAt: 0,
    sliceMs: 0
};

const metrics = {
    pending: 0,
    total: 0,
    reads: 0,
    writes: 0,
    transactions: 0,
    failures: 0,
    waitMs: 0,
    runMs: 0,
    maxPending: 0,
    byOperation: new Map()
};

function now() {
    return Date.now();
}

function yieldToEventLoop() {
    return new Promise((resolve) => setImmediate(resolve));
}

function normalizeValue(value) {
    if (typeof value === 'bigint') return Number(value);
    if (Buffer.isBuffer(value)) return value;
    return value;
}

function normalizeRow(row) {
    if (!row || typeof row !== 'object') return row;
    return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, normalizeValue(value)]));
}

function normalizeRows(rows) {
    return (rows || []).map(normalizeRow);
}

const CLAN_ACTION_RESULT_MAX_BYTES = 16 * 1024;
const CLAN_ACTION_RESULT_MAX_DEPTH = 3;
const CLAN_ACTION_RESULT_MAX_KEYS = 32;
const CLAN_ACTION_RESULT_MAX_STRING = 512;
const CLAN_ACTION_RESULT_MAX_PRIMITIVES = 32;

function compactClanActionValue(value, depth = 0) {
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string') return value.slice(0, CLAN_ACTION_RESULT_MAX_STRING);
    if (typeof value === 'bigint') return Number(value);
    if (depth >= CLAN_ACTION_RESULT_MAX_DEPTH || !value || typeof value !== 'object') return undefined;
    if (Array.isArray(value)) {
        const primitive = value.every((entry) => (
            entry === null || ['boolean', 'number', 'string', 'bigint'].includes(typeof entry)
        ));
        if (!primitive) return { count: value.length };
        return value.slice(0, CLAN_ACTION_RESULT_MAX_PRIMITIVES)
            .map((entry) => compactClanActionValue(entry, depth + 1));
    }
    const summary = {};
    for (const [key, entry] of Object.entries(value).slice(0, CLAN_ACTION_RESULT_MAX_KEYS)) {
        const compacted = compactClanActionValue(entry, depth + 1);
        if (compacted !== undefined) summary[key] = compacted;
    }
    return summary;
}

function compactClanActionResult(result) {
    const source = result && typeof result === 'object' ? result : {};
    const compacted = compactClanActionValue(source) || {};
    const serialized = JSON.stringify(compacted);
    if (Buffer.byteLength(serialized, 'utf8') <= CLAN_ACTION_RESULT_MAX_BYTES) return compacted;
    let fallback = { truncated: true };
    for (const [key, value] of Object.entries(source).slice(0, CLAN_ACTION_RESULT_MAX_KEYS)) {
        let compactedValue;
        if (value === null || ['boolean', 'number', 'string', 'bigint'].includes(typeof value)) {
            compactedValue = compactClanActionValue(value);
        } else if (Array.isArray(value)) {
            compactedValue = { count: value.length };
        }
        if (compactedValue === undefined) continue;
        const candidate = { ...fallback, [key]: compactedValue };
        if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') <= CLAN_ACTION_RESULT_MAX_BYTES) {
            fallback = candidate;
        }
    }
    return fallback;
}

function escapeIdentifier(value) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
        throw new Error(`invalid SQL identifier: ${value}`);
    }
    return `"${value}"`;
}

function databaseFile() {
    const configured = options.default.Database?.path || 'tmp/nodel2.sqlite';
    return path.resolve(process.cwd(), configured);
}

function isReadStatement(sql) {
    return /^\s*(SELECT|EXPLAIN|PRAGMA\s+[^=]+$)/i.test(String(sql || ''));
}

function operationName(sql, fallback = 'raw') {
    const match = String(sql || '').trim().match(/^([A-Za-z]+)/);
    return match ? `${fallback}:${match[1].toLowerCase()}` : fallback;
}

function record(operation, wait, run, read, failed = false) {
    metrics.total += 1;
    metrics.waitMs += wait;
    metrics.runMs += run;
    if (read) metrics.reads += 1;
    else metrics.writes += 1;
    if (failed) metrics.failures += 1;
    const entry = metrics.byOperation.get(operation) || { count: 0, waitMs: 0, runMs: 0, failures: 0 };
    entry.count += 1;
    entry.waitMs += wait;
    entry.runMs += run;
    if (failed) entry.failures += 1;
    metrics.byOperation.set(operation, entry);
}

function enqueue(work, { operation = 'raw', read = false } = {}) {
    if (shuttingDown) {
        return Promise.reject(new Error(`SQLite shutdown is in progress (${operation})`));
    }
    const queuedAt = now();
    metrics.pending += 1;
    metrics.maxPending = Math.max(metrics.maxPending, metrics.pending);
    const execute = () => {
        const startedAt = now();
        const wait = startedAt - queuedAt;
        try {
            const result = work();
            record(operation, wait, now() - startedAt, read);
            return result;
        } catch (error) {
            record(operation, wait, now() - startedAt, read, true);
            throw error;
        } finally {
            metrics.pending -= 1;
        }
    };
    const queued = queryTail.then(execute, execute);
    const cooperativeQueue = cooperative.depth > 0;
    const result = cooperativeQueue
        ? queued.then((value) => {
            if (cooperative.depth <= 0 || now() - cooperative.sliceStartedAt < cooperative.sliceMs) return value;
            return yieldToEventLoop().then(() => {
                cooperative.sliceStartedAt = now();
                return value;
            });
        })
        : queued;
    queryTail = result.catch(() => null);
    return result;
}

function run(sql, params = [], operation, readOverride = null) {
    const read = readOverride === null ? isReadStatement(sql) : !!readOverride;
    return enqueue(() => {
        if (!connection) throw new Error(`SQLite is not initialized (${operation || operationName(sql)})`);
        const statement = connection.prepare(sql);
        if (read) return normalizeRows(statement.all(...params));
        const result = statement.run(...params);
        return {
            affectedRows: Number(result.changes || 0),
            insertId: Number(result.lastInsertRowid || 0)
        };
    }, { operation: operation || operationName(sql), read });
}

function insert(table, values, operation) {
    const columns = Object.keys(values || {});
    if (!columns.length) throw new Error(`cannot insert empty ${table}`);
    const sql = `INSERT INTO ${escapeIdentifier(table)} (${columns.map(escapeIdentifier).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
    return run(sql, columns.map((key) => values[key]), operation || `insert:${table}`);
}

function update(table, values, where, params = [], operation) {
    const columns = Object.keys(values || {});
    if (!columns.length) return Promise.resolve({ affectedRows: 0, insertId: 0 });
    const sql = `UPDATE ${escapeIdentifier(table)} SET ${columns.map((key) => `${escapeIdentifier(key)} = ?`).join(', ')}${where ? ` WHERE ${where}` : ''}`;
    return run(sql, [...columns.map((key) => values[key]), ...params], operation || `update:${table}`);
}

function remove(table, where, params = [], operation) {
    return run(`DELETE FROM ${escapeIdentifier(table)}${where ? ` WHERE ${where}` : ''}`, params, operation || `delete:${table}`);
}

function select(table, columns = ['*'], where = '', params = [], operation) {
    const selected = columns.length === 1 && columns[0] === '*'
        ? '*'
        : columns.map(escapeIdentifier).join(', ');
    return run(`SELECT ${selected} FROM ${escapeIdentifier(table)}${where ? ` WHERE ${where}` : ''}`, params, operation || `select:${table}`);
}

function selectOne(table, columns, where, params, operation) {
    return select(table, columns, `${where} LIMIT 1`, params, operation);
}

function cleanZeroAmountItems() {
    return run('DELETE FROM items WHERE amount <= 0', [], 'maintenance:zero-items');
}

async function inTransaction(work, operation = 'transaction') {
    return enqueue(() => {
        metrics.transactions += 1;
        connection.exec('BEGIN IMMEDIATE');
        try {
            const result = work();
            connection.exec('COMMIT');
            return result;
        } catch (error) {
            connection.exec('ROLLBACK');
            throw error;
        }
    }, { operation, read: false });
}

function withCharacterFlush(characterId, work) {
    if (!flushPendingCharacterWrites || !Number(characterId)) return work();
    return Promise.resolve(flushPendingCharacterWrites(Number(characterId))).then(work);
}

function withCharacterFlushes(characterIds, work) {
    if (!flushPendingCharacterWrites) return work();
    const ids = [...new Set((characterIds || []).map(Number).filter(Boolean))];
    return ids.reduce(
        (pending, characterId) => pending.then(() => flushPendingCharacterWrites(characterId)),
        Promise.resolve()
    ).then(work);
}

function applySchemaMigrations() {
    const migrations = [
        [1, () => {}],
        [2, () => connection.exec(`
            CREATE UNIQUE INDEX IF NOT EXISTS accounts_username_nocase ON accounts(username COLLATE NOCASE);
            CREATE INDEX IF NOT EXISTS characters_username_nocase ON characters(username COLLATE NOCASE);
        `)],
        [3, () => connection.exec(`
            CREATE INDEX IF NOT EXISTS bot_conversations_bot_updated ON bot_conversations(botId, updatedAt DESC);
            CREATE INDEX IF NOT EXISTS bot_conversation_messages_recent ON bot_conversation_messages(conversationId, id DESC);
            CREATE INDEX IF NOT EXISTS bot_conversation_messages_turn ON bot_conversation_messages(conversationId, turnId, role);
        `)],
        [4, () => connection.exec(`
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
        `)],
        [5, () => connection.exec(`
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
        `)],
        [6, () => connection.exec(`
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
        `)],
        [7, () => connection.exec(`
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
        `)],
        [8, () => {
            const addColumn = (table, name, definition) => {
                const columns = connection.prepare(`PRAGMA table_info(${table})`).all();
                if (!columns.some((column) => column.name === name)) {
                    connection.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
                }
            };
            addColumn('bot_conversations', 'summaryThroughOrdinal', 'INTEGER NOT NULL DEFAULT 0');
            addColumn('bot_conversations', 'nextTurnOrdinal', 'INTEGER NOT NULL DEFAULT 0');
            addColumn('bot_conversation_messages', 'turnOrdinal', 'INTEGER NOT NULL DEFAULT 0');
            addColumn('bot_conversation_messages', 'messageOrder', 'INTEGER NOT NULL DEFAULT 0');
            addColumn('bot_conversation_messages', 'compacted', 'INTEGER NOT NULL DEFAULT 0');
            connection.exec(`
                UPDATE bot_conversation_messages
                SET turnOrdinal = COALESCE((
                    SELECT MIN(first.id)
                    FROM bot_conversation_messages first
                    WHERE first.conversationId = bot_conversation_messages.conversationId
                      AND first.turnId = bot_conversation_messages.turnId
                ), id)
                WHERE turnOrdinal = 0;
                UPDATE bot_conversation_messages
                SET messageOrder = CASE role WHEN 'player' THEN 0 WHEN 'bot' THEN 1 ELSE 2 END;
                UPDATE bot_conversations
                SET nextTurnOrdinal = COALESCE((
                    SELECT MAX(turnOrdinal)
                    FROM bot_conversation_messages
                    WHERE conversationId = bot_conversations.id
                ), 0)
                WHERE nextTurnOrdinal = 0;
                UPDATE bot_conversations
                SET summaryThroughOrdinal = COALESCE((
                    SELECT MAX(turnOrdinal)
                    FROM bot_conversation_messages
                    WHERE conversationId = bot_conversations.id
                      AND id <= bot_conversations.summaryThroughId
                ), 0)
                WHERE summaryThroughOrdinal = 0 AND summaryThroughId > 0;
                CREATE INDEX IF NOT EXISTS bot_conversation_messages_order
                    ON bot_conversation_messages(conversationId, compacted, turnOrdinal, messageOrder, id);
            `);
        }],
        [9, () => connection.exec(`
            CREATE TABLE IF NOT EXISTS raid_boss_state (
                npcId INTEGER PRIMARY KEY,
                respawnTime INTEGER NOT NULL DEFAULT 0,
                hp REAL,
                mp REAL,
                updatedAt INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS raid_boss_state_respawnTime ON raid_boss_state(respawnTime);
        `)],
        [10, () => {
            const addColumn = (table, name, definition) => {
                const columns = connection.prepare(`PRAGMA table_info(${table})`).all();
                if (!columns.some((column) => column.name === name)) {
                    connection.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
                }
            };
            addColumn('bot_life_state', 'simulationOwner', "TEXT NOT NULL DEFAULT 'legacy_main'");
            addColumn('bot_life_state', 'simulationRevision', 'INTEGER NOT NULL DEFAULT 0');
            addColumn('bot_life_state', 'simulationLeaseId', 'TEXT');
            addColumn('bot_life_state', 'simulationLeaseUntil', 'INTEGER NOT NULL DEFAULT 0');
            connection.exec(`
                UPDATE bot_life_state
                SET simulationOwner = 'legacy_main',
                    simulationRevision = COALESCE(simulationRevision, 0),
                    simulationLeaseId = NULL,
                    simulationLeaseUntil = 0
                WHERE simulationOwner IS NULL OR simulationOwner = '';
                CREATE INDEX IF NOT EXISTS bot_life_state_simulation_owner_lease
                    ON bot_life_state(simulationOwner, simulationLeaseUntil, phase, activity);
            `);
        }],
        [11, () => {
            const columns = connection.prepare('PRAGMA table_info(items)').all();
            if (!columns.some((column) => column.name === 'enchant')) {
                connection.exec('ALTER TABLE items ADD COLUMN enchant INTEGER NOT NULL DEFAULT 0 CHECK(enchant >= 0)');
            }
        }],
        [12, () => {
            const warehouseColumns = connection.prepare('PRAGMA table_info(warehouse_items)').all();
            if (!warehouseColumns.some((column) => column.name === 'enchant')) {
                connection.exec('ALTER TABLE warehouse_items ADD COLUMN enchant INTEGER NOT NULL DEFAULT 0 CHECK(enchant >= 0)');
            }
        }],
        [13, () => {
            connection.exec(`
                CREATE INDEX IF NOT EXISTS bot_life_state_party_owner_filter
                    ON bot_life_state(simulationOwner, phase, partyId, activity, spotId, updatedAt);
            `);
        }],
        [14, () => {
            const columns = connection.prepare('PRAGMA table_xinfo(bot_life_state)').all();
            const names = new Set(columns.map((column) => String(column.name)));
            if (!names.has('partyRequestStatus')) {
                connection.exec(`ALTER TABLE bot_life_state ADD COLUMN partyRequestStatus TEXT
                    GENERATED ALWAYS AS (json_extract(statsJson, '$.partyRequest.status')) VIRTUAL`);
            }
            if (!names.has('partyRequestPriority')) {
                connection.exec(`ALTER TABLE bot_life_state ADD COLUMN partyRequestPriority TEXT
                    GENERATED ALWAYS AS (json_extract(statsJson, '$.partyRequest.priority')) VIRTUAL`);
            }
            if (!names.has('partyObjectiveSpot')) {
                connection.exec(`ALTER TABLE bot_life_state ADD COLUMN partyObjectiveSpot TEXT
                    GENERATED ALWAYS AS (COALESCE(
                        json_extract(statsJson, '$.partyRequest.spotId'),
                        json_extract(statsJson, '$.equipmentPlan.next.spotId'),
                        spotId
                    )) VIRTUAL`);
            }
            connection.exec(`
                DROP INDEX IF EXISTS bot_life_state_party_request_filter;
                DROP INDEX IF EXISTS bot_life_state_party_objective_spot;
                CREATE INDEX IF NOT EXISTS bot_life_state_party_candidate_projection
                    ON bot_life_state(
                        simulationOwner, phase, partyId, activity, partyObjectiveSpot,
                        partyRequestStatus, partyRequestPriority, updatedAt, level
                    );
            `);
        }],
        [15, () => {
            const columns = connection.prepare('PRAGMA table_xinfo(bot_life_state)').all();
            const names = new Set(columns.map((column) => String(column.name)));
            if (!names.has('partyRequestedAt')) {
                connection.exec(`ALTER TABLE bot_life_state ADD COLUMN partyRequestedAt INTEGER
                    GENERATED ALWAYS AS (
                        CAST(json_extract(statsJson, '$.partyRequest.requestedAt') AS INTEGER)
                    ) VIRTUAL`);
            }
            connection.exec(`
                CREATE INDEX IF NOT EXISTS bot_life_state_party_request_expiry
                    ON bot_life_state(
                        simulationOwner, phase, partyRequestStatus,
                        partyRequestedAt, partyRequestPriority
                    );
            `);
        }],
        [16, () => {
            // Retention is deliberately incremental. These indexes keep each
            // idle-only delete batch on a narrow age/group range instead of
            // turning maintenance into a main-thread table scan.
            connection.exec(`
                CREATE INDEX IF NOT EXISTS bot_conversation_messages_compacted_age
                    ON bot_conversation_messages(compacted, createdAt, id);
                CREATE INDEX IF NOT EXISTS bot_conversation_messages_uncompacted_group
                    ON bot_conversation_messages(compacted, conversationId, id DESC);
                CREATE INDEX IF NOT EXISTS bot_activity_journal_retention_age
                    ON bot_activity_journal(updatedAt, id);
                CREATE INDEX IF NOT EXISTS bot_activity_journal_pair_retention
                    ON bot_activity_journal(botId, playerId, updatedAt DESC, id DESC);
                CREATE INDEX IF NOT EXISTS bot_tool_outcomes_retention_age
                    ON bot_tool_outcomes(createdAt, id);
                CREATE INDEX IF NOT EXISTS bot_llm_turns_terminal_retention
                    ON bot_llm_turns(state, COALESCE(finishedAt, startedAt, 0), id);
                CREATE INDEX IF NOT EXISTS bot_llm_turns_active_retention
                    ON bot_llm_turns(state, startedAt, id);
            `);
        }],
        [17, () => {
            const rows = connection.prepare(`SELECT characterId, inventorySummary, statsJson
                FROM bot_life_state`).all();
            const updateState = connection.prepare(`UPDATE bot_life_state
                SET inventorySummary = ?, statsJson = ?
                WHERE characterId = ?`);
            let statesCompacted = 0;
            let inventoryEntriesRemoved = 0;
            let targetMapsRemoved = 0;

            rows.forEach((row) => {
                let inventory;
                let stats;
                try { inventory = JSON.parse(row.inventorySummary || '{}'); } catch (_) { inventory = null; }
                try { stats = JSON.parse(row.statsJson || '{}'); } catch (_) { stats = null; }
                let inventoryChanged = false;
                let statsChanged = false;

                if (inventory && typeof inventory === 'object' && !Array.isArray(inventory)) {
                    Object.entries(inventory).forEach(([key, item]) => {
                        if (item && Number.isFinite(Number(item.amount)) && Number(item.amount) > 0) return;
                        delete inventory[key];
                        inventoryEntriesRemoved += 1;
                        inventoryChanged = true;
                    });
                }
                if (stats?.targetCombat && Object.prototype.hasOwnProperty.call(stats.targetCombat, 'targets')) {
                    delete stats.targetCombat.targets;
                    targetMapsRemoved += 1;
                    statsChanged = true;
                }
                if (!inventoryChanged && !statsChanged) return;
                updateState.run(
                    inventoryChanged ? JSON.stringify(inventory) : row.inventorySummary,
                    statsChanged ? JSON.stringify(stats) : row.statsJson,
                    row.characterId
                );
                statesCompacted += 1;
            });

            const routineEventsRemoved = Number(connection.prepare(`DELETE FROM bot_life_events
                WHERE eventType IN ('rest', 'hunt')
                  AND id NOT IN (
                      SELECT id FROM (
                          SELECT id,
                              ROW_NUMBER() OVER (
                                  PARTITION BY characterId, eventType
                                  ORDER BY createdAt DESC, id DESC
                              ) AS retainedRank
                          FROM bot_life_events
                          WHERE eventType IN ('rest', 'hunt')
                      ) ranked
                      WHERE retainedRank = 1
                  )`).run().changes || 0);

            if (statesCompacted || routineEventsRemoved) {
                console.info(
                    'Database :: compacted bot state rows=%d inventoryEntries=%d targetMaps=%d routineEvents=%d',
                    statesCompacted,
                    inventoryEntriesRemoved,
                    targetMapsRemoved,
                    routineEventsRemoved
                );
            }
        }],
        [18, () => connection.exec(`
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
            CREATE INDEX IF NOT EXISTS social_events_source_recent
                ON social_events(sourceEntityId, occurredAt DESC, id DESC);
            CREATE INDEX IF NOT EXISTS social_events_target_recent
                ON social_events(targetEntityId, occurredAt DESC, id DESC);
            CREATE INDEX IF NOT EXISTS social_events_context_recent
                ON social_events(contextEntityId, occurredAt DESC, id DESC);
            CREATE INDEX IF NOT EXISTS social_events_retention
                ON social_events(occurredAt, id);

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
            CREATE INDEX IF NOT EXISTS social_relations_source_updated
                ON social_relations(sourceEntityId, updatedAt DESC, targetEntityId);
            CREATE INDEX IF NOT EXISTS social_relations_target_updated
                ON social_relations(targetEntityId, updatedAt DESC, sourceEntityId);

            CREATE TABLE IF NOT EXISTS social_projection_cursors (
                consumer TEXT PRIMARY KEY,
                lastEventId INTEGER NOT NULL DEFAULT 0 CHECK(lastEventId >= 0),
                updatedAt INTEGER NOT NULL DEFAULT 0
            );
        `)],
        [19, () => connection.exec(`
            CREATE TABLE IF NOT EXISTS clan_simulation_clans (
                clanId INTEGER PRIMARY KEY REFERENCES clans(id) ON DELETE CASCADE,
                version INTEGER NOT NULL DEFAULT 1,
                createdAt INTEGER NOT NULL,
                updatedAt INTEGER NOT NULL,
                stateJson TEXT NOT NULL DEFAULT '{}'
            );
            CREATE INDEX IF NOT EXISTS clan_simulation_clans_updatedAt
                ON clan_simulation_clans(updatedAt);
        `)],
        [20, () => connection.exec(`
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
            CREATE INDEX IF NOT EXISTS clan_contributions_clan_level
                ON clan_contributions(clanId, targetLevel, createdAt);
        `)],
        [21, () => connection.exec(`
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
        `)],
        [22, () => connection.exec(`
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
        `)],
        [23, () => connection.exec(`
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
        `)],
        [24, () => connection.exec(`
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
        `)],
        [25, () => connection.exec(`
            CREATE INDEX IF NOT EXISTS bot_life_state_market_reconcile
                ON bot_life_state(phase, updatedAt, characterId);
        `)],
        [26, () => {
            const columns = connection.prepare('PRAGMA table_info(clan_simulation_clans)').all();
            if (!columns.some((column) => column.name === 'mode')) {
                connection.exec("ALTER TABLE clan_simulation_clans ADD COLUMN mode TEXT NOT NULL DEFAULT 'autonomous'");
            }
            connection.exec(`
                UPDATE clan_simulation_clans
                SET mode = 'autonomous'
                WHERE mode IS NULL OR mode = '';
                CREATE INDEX IF NOT EXISTS clan_simulation_clans_mode_updatedAt
                    ON clan_simulation_clans(mode, updatedAt);
            `);
        }],
        [27, () => connection.exec(`
            CREATE TABLE IF NOT EXISTS clan_orders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                clanId INTEGER NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
                revision INTEGER NOT NULL DEFAULT 1,
                kind TEXT NOT NULL CHECK(kind IN ('gather_item')),
                status TEXT NOT NULL DEFAULT 'active'
                    CHECK(status IN ('active', 'paused', 'completed', 'cancelled', 'blocked')),
                itemId INTEGER NOT NULL,
                itemName TEXT NOT NULL DEFAULT '',
                amount INTEGER NOT NULL CHECK(amount > 0),
                strategy TEXT NOT NULL DEFAULT 'auto' CHECK(strategy IN ('auto', 'farm', 'market', 'craft')),
                maxUnitPrice INTEGER NOT NULL DEFAULT 0 CHECK(maxUnitPrice >= 0),
                budget INTEGER NOT NULL DEFAULT 0 CHECK(budget >= 0),
                spent INTEGER NOT NULL DEFAULT 0 CHECK(spent >= 0),
                memberIdsJson TEXT NOT NULL DEFAULT '[]',
                planJson TEXT NOT NULL DEFAULT '{}',
                reasonCode TEXT NOT NULL DEFAULT '',
                createdAt INTEGER NOT NULL DEFAULT 0,
                updatedAt INTEGER NOT NULL DEFAULT 0,
                resolvedAt INTEGER,
                UNIQUE(clanId, revision)
            );
            CREATE UNIQUE INDEX IF NOT EXISTS clan_orders_current
                ON clan_orders(clanId) WHERE status IN ('active', 'paused', 'blocked');
            CREATE INDEX IF NOT EXISTS clan_orders_clan_recent
                ON clan_orders(clanId, updatedAt DESC, id DESC);
        `)],
        [28, () => connection.exec(`
            -- Older warehouse transfers serialized the already-serialized
            -- empty pet payload again on every round trip. Ordinary items can
            -- therefore carry exponentially escaped variants of {}. Real pet
            -- payloads are non-empty JSON objects and contain a key separator.
            UPDATE items
            SET petData = NULL
            WHERE petData IS NOT NULL
              AND (length(petData) > 1048576 OR instr(petData, ':') = 0);
            UPDATE warehouse_items
            SET petData = NULL
            WHERE petData IS NOT NULL
              AND (length(petData) > 1048576 OR instr(petData, ':') = 0);
        `)],
        [29, () => connection.exec(`
            CREATE INDEX IF NOT EXISTS clan_actions_terminal_retention
                ON clan_actions(resolvedAt, id)
                WHERE status IN ('succeeded', 'failed', 'cancelled');
            CREATE INDEX IF NOT EXISTS clan_goal_events_action_retention
                ON clan_goal_events(occurredAt, id)
                WHERE eventType IN ('action_succeeded', 'action_failed', 'action_cancelled');
        `)],
        [30, () => {
            const table = connection.prepare(`SELECT sql FROM sqlite_master
                WHERE type = 'table' AND name = 'clan_warehouse_items'`).get();
            const legacyUniqueKey = /UNIQUE\s*\(\s*clanId\s*,\s*selfId\s*,\s*enchant\s*\)/i.test(String(table?.sql || ''));
            if (!legacyUniqueKey) {
                connection.exec(`CREATE INDEX IF NOT EXISTS clan_warehouse_items_clan_self
                    ON clan_warehouse_items(clanId, selfId, amount)`);
                return;
            }

            const rows = connection.prepare('SELECT * FROM clan_warehouse_items ORDER BY id').all();
            connection.exec(`
                ALTER TABLE clan_warehouse_items RENAME TO clan_warehouse_items_legacy_unique;
                CREATE TABLE clan_warehouse_items (
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
                    updatedAt INTEGER NOT NULL DEFAULT 0
                );
            `);
            const insertOriginal = connection.prepare(`INSERT INTO clan_warehouse_items
                (id, clanId, selfId, name, kind, amount, enchant, petData, reservedAmount, createdAt, updatedAt)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
            const insertCopy = connection.prepare(`INSERT INTO clan_warehouse_items
                (clanId, selfId, name, kind, amount, enchant, petData, reservedAmount, createdAt, updatedAt)
                VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`);

            rows.forEach((row) => {
                const amount = Math.max(1, Math.floor(Number(row.amount) || 1));
                const reserved = Math.max(0, Math.floor(Number(row.reservedAmount) || 0));
                if (reserved > amount) throw new Error(`invalid clan warehouse reservation for row ${row.id}`);
                const wearable = /^(Armor|Weapon)\./.test(String(row.kind || ''));
                insertOriginal.run(
                    row.id, row.clanId, row.selfId, row.name, row.kind, wearable ? 1 : amount,
                    row.enchant, row.petData, wearable && reserved > 0 ? 1 : reserved, row.createdAt, row.updatedAt
                );
            });
            rows.forEach((row) => {
                const amount = Math.max(1, Math.floor(Number(row.amount) || 1));
                const reserved = Math.max(0, Math.floor(Number(row.reservedAmount) || 0));
                if (!/^(Armor|Weapon)\./.test(String(row.kind || ''))) return;
                for (let index = 1; index < amount; index += 1) {
                    insertCopy.run(
                        row.clanId, row.selfId, row.name, row.kind, row.enchant, row.petData,
                        index < reserved ? 1 : 0, row.createdAt, row.updatedAt
                    );
                }
            });
            connection.exec(`
                DROP TABLE clan_warehouse_items_legacy_unique;
                CREATE INDEX clan_warehouse_items_clan_self
                    ON clan_warehouse_items(clanId, selfId, amount);
            `);
        }]
    ];
    const applied = new Set(connection.prepare('SELECT version FROM schema_migrations').all().map((row) => Number(row.version)));
    migrations.forEach(([version, apply]) => {
        if (applied.has(version)) return;
        connection.exec('BEGIN IMMEDIATE');
        try {
            apply();
            connection.prepare('INSERT INTO schema_migrations(version, appliedAt) VALUES (?, ?)').run(version, now());
            connection.exec('COMMIT');
        } catch (error) {
            try {
                connection.exec('ROLLBACK');
            } catch (_) {
                // Preserve the migration error; initialization will close the
                // failed connection before returning to the caller.
            }
            throw error;
        }
    });
}

function one(sql, params = []) {
    return normalizeRow(connection.prepare(sql).get(...params));
}

function all(sql, params = []) {
    return normalizeRows(connection.prepare(sql).all(...params));
}

function write(sql, params = []) {
    const result = connection.prepare(sql).run(...params);
    return { affectedRows: Number(result.changes || 0), insertId: Number(result.lastInsertRowid || 0) };
}

const GENERATED_BOT_FILTER = `(
    c.username LIKE 'bot_pop_%'
    OR c.username LIKE 'bot_scale_%'
    OR life.accountName LIKE 'bot_pop_%'
    OR life.accountName LIKE 'bot_scale_%'
    OR json_extract(CASE WHEN json_valid(COALESCE(life.statsJson, '{}')) THEN life.statsJson ELSE '{}' END, '$.generatedCold') = 1
)
AND c.username NOT LIKE 'bot_craft_%'
AND COALESCE(life.accountName, '') NOT LIKE 'bot_craft_%'
AND COALESCE(json_extract(CASE WHEN json_valid(COALESCE(life.statsJson, '{}')) THEN life.statsJson ELSE '{}' END, '$.craftStationId'), '') = ''
AND COALESCE(json_extract(CASE WHEN json_valid(COALESCE(life.statsJson, '{}')) THEN life.statsJson ELSE '{}' END, '$.craftShop'), '') = ''`;

function jsonObject(raw) {
    if (!raw) return {};
    if (typeof raw === 'object' && !Array.isArray(raw)) return { ...raw };
    try {
        const value = JSON.parse(raw);
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch (_) {
        return {};
    }
}

function jsonArray(raw) {
    if (Array.isArray(raw)) return raw;
    try {
        const value = JSON.parse(raw || '[]');
        return Array.isArray(value) ? value : [];
    } catch (_) {
        return [];
    }
}

function generatedBotRow(row = {}) {
    const stats = jsonObject(row.statsJson);
    const accountName = String(row.accountName || row.lifeAccountName || '');
    const username = String(row.username || '');
    const staticService = Boolean(stats.craftStationId || stats.craftShop)
        || /^bot_craft_/i.test(accountName)
        || /^bot_craft_/i.test(username);
    const generated = /^bot_(pop|scale)_/i.test(accountName)
        || /^bot_(pop|scale)_/i.test(username)
        || stats.generatedCold === true
        || Number(stats.generatedCold) === 1;
    return generated && !staticService;
}

function botPopulationUnsafe() {
    return one(`SELECT
        COUNT(DISTINCT c.id) AS population,
        COUNT(DISTINCT CASE WHEN c.clanId != 0 THEN c.id END) AS botMembers
        FROM characters c
        LEFT JOIN bot_life_state life ON life.characterId = c.id
        WHERE ${GENERATED_BOT_FILTER}`);
}

function executeReadAutonomousBotMember(characterId, clanId) {
    return selectOne(`characters`, ['id'], `id = ? AND clanId = ? AND EXISTS (
        SELECT 1 FROM clan_simulation_clans simulated
        WHERE simulated.clanId = characters.clanId AND simulated.mode = 'autonomous'
    ) AND (
        username LIKE 'bot_pop_%'
        OR username LIKE 'bot_scale_%'
        OR EXISTS (
            SELECT 1 FROM bot_life_state life
            WHERE life.characterId = characters.id
              AND (
                  life.accountName LIKE 'bot_pop_%'
                  OR life.accountName LIKE 'bot_scale_%'
                  OR json_extract(CASE WHEN json_valid(COALESCE(life.statsJson, '{}')) THEN life.statsJson ELSE '{}' END, '$.generatedCold') = 1
              )
              AND COALESCE(life.accountName, '') NOT LIKE 'bot_craft_%'
              AND COALESCE(json_extract(CASE WHEN json_valid(COALESCE(life.statsJson, '{}')) THEN life.statsJson ELSE '{}' END, '$.craftStationId'), '') = ''
              AND COALESCE(json_extract(CASE WHEN json_valid(COALESCE(life.statsJson, '{}')) THEN life.statsJson ELSE '{}' END, '$.craftShop'), '') = ''
        )
    )`, [Number(characterId), Number(clanId)], 'clan-simulation:bot-member')
        .then((rows) => !!rows[0]);
}

function simulationState(raw, clanId, leaderId, memberIds, timestamp) {
    const value = jsonObject(raw);
    return {
        ...value,
        version: 1,
        mode: value.mode === 'player_managed' ? 'player_managed' : 'autonomous',
        clanId: Number(clanId),
        leaderId: Number(leaderId),
        level: Math.max(0, Math.min(3, Number(value.level) || 0)),
        memberIds: [...new Set(memberIds.map(Number).filter(Boolean))].sort((a, b) => a - b),
        goal: value.goal || null,
        contributionLedgerVersion: Math.max(0, Number(value.contributionLedgerVersion) || 0),
        warehouseRevision: Math.max(0, Number(value.warehouseRevision) || 0),
        updatedAt: Number(timestamp) || now()
    };
}

function playerManagedOrderRow(row) {
    if (!row) return null;
    return {
        ...row,
        id: Number(row.id),
        clanId: Number(row.clanId),
        revision: Number(row.revision),
        itemId: Number(row.itemId),
        amount: Number(row.amount),
        maxUnitPrice: Number(row.maxUnitPrice),
        budget: Number(row.budget),
        spent: Number(row.spent),
        memberIds: jsonArray(row.memberIdsJson).map(Number).filter(Boolean),
        plan: jsonObject(row.planJson)
    };
}

function cancelPlayerManagedClanWorkUnsafe(clanId, reasonCode, timestamp = now()) {
    const clan = Number(clanId);
    const reason = String(reasonCode || 'player_order_replaced');
    write(`UPDATE clan_actions
        SET status = 'cancelled', leaseUntil = NULL, reasonCode = ?, updatedAt = ?, resolvedAt = ?
        WHERE clanId = ? AND status IN ('pending', 'running')`, [reason, timestamp, timestamp, clan]);
    write(`UPDATE clan_market_demands SET status = 'cancelled', updatedAt = ?
        WHERE clanId = ? AND status = 'open'`, [timestamp, clan]);
    write(`UPDATE clan_warehouse_reservations SET status = 'released', updatedAt = ?
        WHERE clanId = ? AND status = 'reserved'`, [timestamp, clan]);
    const activeOperations = all("SELECT id FROM clan_operations WHERE clanId = ? AND status = 'active'", [clan]);
    activeOperations.forEach((operation) => {
        write(`UPDATE clan_operation_members SET status = 'released', releasedAt = ?
            WHERE operationId = ? AND status = 'active'`, [timestamp, operation.id]);
    });
    write(`UPDATE clan_operations
        SET status = 'cancelled', reasonCode = ?, updatedAt = ?, resolvedAt = ?
        WHERE clanId = ? AND status = 'active'`, [reason, timestamp, timestamp, clan]);
}

function syncPlayerManagedClanUnsafe(clanId) {
    const clan = one(`SELECT clans.id, clans.level, clans.leaderId,
            leader.username, leaderLife.accountName, leaderLife.statsJson
        FROM clans
        JOIN characters leader ON leader.id = clans.leaderId
        LEFT JOIN bot_life_state leaderLife ON leaderLife.characterId = leader.id
        WHERE clans.id = ?`, [Number(clanId)]);
    if (!clan || generatedBotRow(clan)) {
        return { ok: true, skipped: true, code: clan ? 'leader_not_player' : 'clan_missing' };
    }

    const members = all(`SELECT members.id, members.username, life.accountName, life.statsJson
        FROM characters members
        LEFT JOIN bot_life_state life ON life.characterId = members.id
        WHERE members.clanId = ?
        ORDER BY members.id ASC`, [Number(clanId)]);
    const botMemberIds = members.filter(generatedBotRow).map((member) => Number(member.id));
    const simulation = one('SELECT clanId, mode, stateJson, updatedAt FROM clan_simulation_clans WHERE clanId = ?', [Number(clanId)]);
    if (simulation && String(simulation.mode || 'autonomous') === 'autonomous') {
        return { ok: true, skipped: true, code: 'autonomous_clan', mode: 'autonomous' };
    }

    const timestamp = now();
    if (!botMemberIds.length) {
        if (!simulation) return { ok: true, skipped: true, code: 'no_bot_members' };
        cancelPlayerManagedClanWorkUnsafe(clanId, 'player_managed_disabled', timestamp);
        write(`UPDATE clan_orders SET status = 'cancelled', reasonCode = 'player_managed_disabled',
                updatedAt = ?, resolvedAt = ?
            WHERE clanId = ? AND status IN ('active', 'paused', 'blocked')`, [timestamp, timestamp, Number(clanId)]);
        write('DELETE FROM clan_simulation_clans WHERE clanId = ? AND mode = ?', [Number(clanId), 'player_managed']);
        return { ok: true, disabled: true, clanId: Number(clanId), mode: 'player_managed' };
    }

    const previousState = jsonObject(simulation?.stateJson);
    const previousIds = Array.isArray(previousState.memberIds)
        ? [...new Set(previousState.memberIds.map(Number).filter(Boolean))].sort((left, right) => left - right)
        : [];
    const membershipChanged = JSON.stringify(previousIds) !== JSON.stringify(botMemberIds);
    const currentOrder = one(`SELECT id, revision, status FROM clan_orders
        WHERE clanId = ? AND status IN ('active', 'paused', 'blocked') ORDER BY id DESC LIMIT 1`, [Number(clanId)]);
    const legacyGoal = previousState.goal && (
        String(previousState.goal.controlledBy || '') !== 'player'
        || !Number(previousState.goal.orderId)
    );
    if (simulation && !membershipChanged && !legacyGoal) {
        return { ok: true, created: false, changed: false, clanId: Number(clanId), mode: 'player_managed', memberIds: botMemberIds };
    }

    const state = simulationState({ ...previousState, mode: 'player_managed' }, clanId, clan.leaderId, botMemberIds, timestamp);
    state.mode = 'player_managed';
    state.level = Math.max(0, Math.min(3, Number(clan.level) || 0));
    if (legacyGoal && !currentOrder) {
        cancelPlayerManagedClanWorkUnsafe(clanId, 'player_managed_legacy_goal_cleared', timestamp);
        state.goal = null;
    }
    if (simulation) {
        write(`UPDATE clan_simulation_clans
            SET mode = 'player_managed', updatedAt = ?, stateJson = ?
            WHERE clanId = ?`, [timestamp, JSON.stringify(state), Number(clanId)]);
    } else {
        write(`INSERT INTO clan_simulation_clans (clanId, version, mode, createdAt, updatedAt, stateJson)
            VALUES (?, 1, 'player_managed', ?, ?, ?)`, [Number(clanId), timestamp, timestamp, JSON.stringify(state)]);
    }
    const activeOrder = currentOrder && String(currentOrder.status) !== 'paused' ? currentOrder : null;
    if (activeOrder) {
        write(`INSERT OR IGNORE INTO clan_actions
            (clanId, actionKey, actionType, priority, status, attempt, availableAt,
             payloadJson, resultJson, reasonCode, createdAt, updatedAt)
            VALUES (?, ?, 'goal_plan', 100, 'pending', 0, ?, ?, '{}', 'player_managed_sync', ?, ?)`, [
            Number(clanId),
            `clan:${Number(clanId)}:player-managed:${timestamp}`,
            timestamp,
            JSON.stringify({
                reason: simulation ? 'player_managed_membership_changed' : 'player_managed_enabled',
                clanId: Number(clanId),
                orderId: Number(activeOrder.id),
                orderRevision: Number(activeOrder.revision)
            }),
            timestamp,
            timestamp
        ]);
    }
    return {
        ok: true,
        created: !simulation,
        changed: true,
        clanId: Number(clanId),
        mode: 'player_managed',
        memberIds: botMemberIds
    };
}

function syncAdenaSnapshotUnsafe(characterId, amount, event = null) {
    const row = one('SELECT inventorySummary, statsJson FROM bot_life_state WHERE characterId = ?', [Number(characterId)]);
    if (!row) return false;
    const inventory = jsonObject(row.inventorySummary);
    inventory['57'] = {
        ...(inventory['57'] || {}),
        selfId: 57,
        name: 'Adena',
        amount: Math.max(0, Number(amount) || 0)
    };
    const stats = jsonObject(row.statsJson);
    if (event) stats.lastClanContribution = { ...event };
    write(`UPDATE bot_life_state SET adena = ?, inventorySummary = ?, statsJson = ?, updatedAt = ?
        WHERE characterId = ?`, [
        Math.max(0, Number(amount) || 0),
        JSON.stringify(inventory),
        JSON.stringify(stats),
        now(),
        Number(characterId)
    ]);
    return true;
}

function updateColdInventorySnapshotUnsafe(characterId, selfId, event = null, expectedRevision = null) {
    const id = Number(characterId);
    const itemId = Number(selfId);
    const row = one(`SELECT phase, simulationOwner, simulationRevision, partyId,
            inventorySummary, statsJson
        FROM bot_life_state WHERE characterId = ?`, [id]);
    if (!row) return { ok: false, code: 'missing_state' };
    if (String(row.phase || '') !== 'cold'
        || String(row.simulationOwner || LEGACY_SIMULATION_OWNER) !== LEGACY_SIMULATION_OWNER
        || String(row.partyId || '') !== '') {
        return { ok: false, code: 'stale_snapshot' };
    }
    const currentRevision = Number(row.simulationRevision || 0);
    if (expectedRevision !== null && Number(expectedRevision) !== currentRevision) {
        return { ok: false, code: 'stale_snapshot', simulationRevision: currentRevision };
    }
    const inventory = jsonObject(row.inventorySummary);
    const physical = Number(one(`SELECT COALESCE(SUM(amount), 0) AS amount
        FROM items WHERE characterId = ? AND selfId = ? AND amount > 0`, [id, itemId]).amount || 0);
    const previous = inventory[String(itemId)] || {};
    inventory[String(itemId)] = {
        ...previous,
        selfId: itemId,
        name: previous.name || (itemId === 57 ? 'Adena' : `Item ${itemId}`),
        amount: physical
    };
    const stats = jsonObject(row.statsJson);
    if (event) stats.lastClanWarehouseTransfer = { ...event };
    const nextRevision = currentRevision + 1;
    const updated = write(`UPDATE bot_life_state
        SET inventorySummary = ?, statsJson = ?, simulationRevision = ?, updatedAt = ?
        WHERE characterId = ? AND phase = 'cold'
          AND simulationOwner = ? AND simulationRevision = ?
          AND (partyId IS NULL OR partyId = '')`, [
        JSON.stringify(inventory),
        JSON.stringify(stats),
        nextRevision,
        now(),
        id,
        LEGACY_SIMULATION_OWNER,
        currentRevision
    ]);
    if (Number(updated.affectedRows || 0) !== 1) {
        return { ok: false, code: 'stale_snapshot', simulationRevision: currentRevision };
    }
    return { ok: true, simulationRevision: nextRevision, amount: physical };
}

function applyBufferedCharacterStateUnsafe(characterId, state = {}) {
    const character = state.character || {};
    const fields = Object.entries(character).filter(([, value]) => value !== undefined);
    if (fields.length) {
        const sql = `UPDATE characters SET ${fields.map(([key]) => `${escapeIdentifier(key)} = ?`).join(', ')} WHERE id = ?`;
        write(sql, [...fields.map(([, value]) => value), characterId]);
    }
    Object.values(state.items || {}).forEach((item) => {
        if (item.delete || Number(item.amount) <= 0) {
            write('DELETE FROM items WHERE id = ? AND characterId = ?', [item.id, characterId]);
        } else {
            write('UPDATE items SET amount = ? WHERE id = ? AND characterId = ?', [item.amount, item.id, characterId]);
        }
    });
    return { characterId, fields: fields.length, items: Object.keys(state.items || {}).length };
}

const UPSERT_CHARACTER_QUEST = `INSERT INTO character_quests (characterId, questId, state, variables)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(characterId, questId) DO UPDATE SET state = excluded.state, variables = excluded.variables`;
const UPSERT_RECIPE = `INSERT INTO character_recipes (characterId, recipeId, type) VALUES (?, ?, ?)
    ON CONFLICT(characterId, recipeId, type) DO NOTHING`;
const UPSERT_MACRO = `INSERT INTO macros (characterId, id, icon, name, descr, acronym, commands)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(characterId, id) DO UPDATE SET icon = excluded.icon, name = excluded.name,
        descr = excluded.descr, acronym = excluded.acronym, commands = excluded.commands`;

const LEGACY_SIMULATION_OWNER = 'legacy_main';
const COLD_SIMULATION_OWNER = 'cold_simulation_owner';
const SIMPLE_COLD_ACTIVITIES = new Set(['hunting', 'resting', 'traveling', 'dead']);
const COLD_SIMULATION_PATCH_COLUMNS = new Set([
    'level', 'exp', 'sp', 'adena', 'homeRegion', 'currentRegion', 'spotId',
    'activity', 'phase', 'activityStartedAt', 'nextResolveAt', 'lastResolvedAt',
    'lastHotAt', 'locX', 'locY', 'locZ', 'hp', 'maxHp', 'mp', 'maxMp',
    'targetLevelBand', 'deathCount', 'partyId', 'inventorySummary', 'statsJson', 'updatedAt'
]);

function parsedObject(raw) {
    if (!raw) return {};
    if (typeof raw === 'object') return raw;
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) {
        return null;
    }
}

function preserveVersionedAppearanceStats(currentRaw, proposedRaw) {
    const current = parsedObject(currentRaw);
    const proposed = parsedObject(proposedRaw);
    if (!current || !proposed) return proposedRaw;

    const currentVersion = Math.max(0, Number(current.appearanceVersion || 0));
    const proposedVersion = Math.max(0, Number(proposed.appearanceVersion || 0));
    if (currentVersion <= proposedVersion) return proposedRaw;

    const merged = { ...proposed, appearanceVersion: currentVersion };
    if (Object.prototype.hasOwnProperty.call(current, 'sex')) merged.sex = current.sex;
    return JSON.stringify(merged);
}

function preserveColdVersionedStats(row, patch = {}) {
    const next = { ...patch };
    if (Object.prototype.hasOwnProperty.call(next, 'statsJson')) {
        next.statsJson = preserveVersionedAppearanceStats(row?.statsJson, next.statsJson);
    }
    return next;
}

function syncInventorySummaryUnsafe(characterId, inventory = {}) {
    const existing = all('SELECT id, selfId, amount, enchant, equipped, slot FROM items WHERE characterId = ? ORDER BY id', [characterId]);
    const bySelfId = new Map();
    const byId = new Map();
    existing.forEach((row) => {
        const key = Number(row.selfId);
        if (!bySelfId.has(key)) bySelfId.set(key, []);
        bySelfId.get(key).push(row);
        byId.set(Number(row.id), row);
    });
    Object.values(inventory).forEach((item) => {
        const selfId = Number(item.selfId || 0);
        const amount = Number(item.amount || 0);
        if (!selfId) return;
        const rows = bySelfId.get(selfId) || [];
        if (amount <= 0) {
            rows.forEach((row) => write('DELETE FROM items WHERE id = ? AND characterId = ?', [row.id, characterId]));
            return;
        }
        const baseSlot = Number(item.slot || rows[0]?.slot || 0);
        const hasEnchant = item.enchant !== null && item.enchant !== undefined;
        const enchant = hasEnchant ? Math.max(0, Number(item.enchant || 0) || 0) : null;
        const nonStackable = baseSlot > 0 || item.stackable === false;
        if (!nonStackable) {
            const current = rows[0];
            const equipped = item.equipped ? 1 : 0;
            if (current) {
                if (hasEnchant && (Number(current.amount) !== amount || Number(current.enchant || 0) !== enchant || Number(current.equipped) !== equipped || Number(current.slot) !== baseSlot)) {
                    write('UPDATE items SET amount = ?, enchant = ?, equipped = ?, slot = ? WHERE id = ? AND characterId = ?', [amount, enchant, equipped, baseSlot, current.id, characterId]);
                } else if (!hasEnchant && (Number(current.amount) !== amount || Number(current.equipped) !== equipped || Number(current.slot) !== baseSlot)) {
                    write('UPDATE items SET amount = ?, equipped = ?, slot = ? WHERE id = ? AND characterId = ?', [amount, equipped, baseSlot, current.id, characterId]);
                }
            } else {
                write('INSERT INTO items (selfId, name, amount, enchant, equipped, slot, characterId) VALUES (?, ?, ?, ?, ?, ?, ?)', [selfId, item.name || `Item ${selfId}`, amount, enchant || 0, equipped, baseSlot, characterId]);
            }
            rows.slice(1).forEach((row) => write('DELETE FROM items WHERE id = ? AND characterId = ?', [row.id, characterId]));
            return;
        }

        if (Array.isArray(item.instances)) {
            const desiredIds = new Set();
            item.instances.slice(0, amount).forEach((instance, index) => {
                const instanceId = Number(instance?.id || 0);
                const identified = instanceId > 0 ? byId.get(instanceId) : null;
                const current = identified && Number(identified.selfId) === selfId ? identified : (!instanceId ? rows[index] : null);
                const instanceEnchant = Math.max(0, Number(instance?.enchant ?? (hasEnchant ? enchant : 0)) || 0);
                const equipped = instance?.equipped ? 1 : 0;
                const slot = Number(instance?.slot || 0);
                if (current) {
                    desiredIds.add(Number(current.id));
                    if (Number(current.amount) !== 1 || Number(current.enchant || 0) !== instanceEnchant
                        || Number(current.equipped) !== equipped || Number(current.slot) !== slot) {
                        write('UPDATE items SET amount = 1, enchant = ?, equipped = ?, slot = ? WHERE id = ? AND characterId = ?', [instanceEnchant, equipped, slot, current.id, characterId]);
                    }
                } else {
                    write('INSERT INTO items (selfId, name, amount, enchant, equipped, slot, characterId) VALUES (?, ?, 1, ?, ?, ?, ?)', [selfId, item.name || `Item ${selfId}`, instanceEnchant, equipped, slot, characterId]);
                }
            });
            rows.filter((row) => !desiredIds.has(Number(row.id)))
                .forEach((row) => write('DELETE FROM items WHERE id = ? AND characterId = ?', [row.id, characterId]));
            return;
        }

        const equippedSlots = Array.isArray(item.equippedSlots)
            ? [...new Set(item.equippedSlots.map(Number).filter((slot) => slot > 0))].slice(0, amount)
            : item.equipped ? [baseSlot] : [];
        const desired = [
            ...equippedSlots.map((slot) => ({ equipped: 1, slot })),
            ...Array.from({ length: Math.max(0, amount - equippedSlots.length) }, () => ({ equipped: 0, slot: 0 }))
        ];
        desired.forEach((entry, index) => {
            const current = rows[index];
            if (current) {
                if (hasEnchant && (Number(current.amount) !== 1 || Number(current.enchant || 0) !== enchant || Number(current.equipped) !== entry.equipped || Number(current.slot) !== entry.slot)) {
                    write('UPDATE items SET amount = 1, enchant = ?, equipped = ?, slot = ? WHERE id = ? AND characterId = ?', [enchant, entry.equipped, entry.slot, current.id, characterId]);
                } else if (!hasEnchant && (Number(current.amount) !== 1 || Number(current.equipped) !== entry.equipped || Number(current.slot) !== entry.slot)) {
                    write('UPDATE items SET amount = 1, equipped = ?, slot = ? WHERE id = ? AND characterId = ?', [entry.equipped, entry.slot, current.id, characterId]);
                }
            } else {
                write('INSERT INTO items (selfId, name, amount, enchant, equipped, slot, characterId) VALUES (?, ?, 1, ?, ?, ?, ?)', [selfId, item.name || `Item ${selfId}`, enchant || 0, entry.equipped, entry.slot, characterId]);
            }
        });
        rows.slice(desired.length).forEach((row) => write('DELETE FROM items WHERE id = ? AND characterId = ?', [row.id, characterId]));
    });
    return { characterId, entries: Object.keys(inventory).length };
}

function applyColdPhysicalStateUnsafe(characterId, physical = {}) {
    write(`UPDATE characters SET level = ?, exp = ?, sp = ?, hp = ?, maxHp = ?, mp = ?, maxMp = ?${
        Number.isFinite(Number(physical.classId)) ? ', classId = ?' : ''
    } WHERE id = ?`, [
        Number(physical.level || 1), Number(physical.exp || 0), Number(physical.sp || 0),
        Number(physical.hp || 0), Number(physical.maxHp || 0),
        Number(physical.mp || 0), Number(physical.maxMp || 0),
        ...(Number.isFinite(Number(physical.classId)) ? [Number(physical.classId)] : []), characterId
    ]);
    (physical.skills || []).forEach((skill) => {
        const selfId = Number(skill.selfId || 0);
        const level = Number(skill.level || 0);
        if (!selfId || !level) return;
        write(`INSERT INTO skills (selfId, name, passive, level, characterId) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(characterId, selfId) DO UPDATE SET name = excluded.name, passive = excluded.passive, level = excluded.level`, [
            selfId, String(skill.name || `Skill ${selfId}`), skill.passive ? 1 : 0, level, characterId
        ]);
    });
    if (physical.inventory) syncInventorySummaryUnsafe(characterId, physical.inventory);
}

function coldSimulationPartition(row, options = {}) {
    if (!row) return { ok: false, reason: 'missing_state' };
    if (row.phase !== 'cold') return { ok: false, reason: 'not_cold' };
    if (!SIMPLE_COLD_ACTIVITIES.has(String(row.activity || '')) && options.allowLifecycle !== true) {
        return { ok: false, reason: 'legacy_activity' };
    }
    if (row.partyId && options.allowParty !== true) return { ok: false, reason: 'background_party' };
    const stats = parsedObject(row.statsJson);
    if (!stats) return { ok: false, reason: 'invalid_stats' };
    if (options.allowLifecycle === true) {
        return { ok: true, reason: row.partyId ? 'background_party_cold' : 'trusted_cold_lifecycle' };
    }
    if (stats.warehouseWorkflow || stats.warehouseErrand) return { ok: false, reason: 'warehouse_state' };
    if (stats.marketStore || stats.marketReturn) return { ok: false, reason: 'market_state' };
    if (stats.craftShop || stats.craftStationId || stats.craftReturn) return { ok: false, reason: 'craft_state' };
    if (stats.supplyErrand) return { ok: false, reason: 'player_workflow' };
    return { ok: true, reason: row.partyId ? 'background_party_cold' : 'simple_solo_cold' };
}

function coldSimulationRow(characterId) {
    return one('SELECT * FROM bot_life_state WHERE characterId = ?', [Number(characterId)]);
}

function coldSimulationConflict(row, request, timestamp) {
    if (!row) return 'missing_state';
    if (Number(row.simulationRevision || 0) !== Number(request.expectedRevision)) return 'stale_revision';
    if (String(row.simulationOwner || LEGACY_SIMULATION_OWNER) !== String(request.ownerId || COLD_SIMULATION_OWNER)) return 'owner_changed';
    if (String(row.simulationLeaseId || '') !== String(request.leaseId || '')) return 'lease_changed';
    if (Number(row.simulationLeaseUntil || 0) <= timestamp) return 'lease_expired';
    return 'cas_failed';
}

function ensureSocialEntityUnsafe(entity, timestamp) {
    write(`INSERT INTO social_entities(kind, externalKey, displayName, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(kind, externalKey) DO UPDATE SET
            displayName = CASE
                WHEN excluded.displayName <> '' THEN excluded.displayName
                ELSE social_entities.displayName
            END,
            updatedAt = MAX(social_entities.updatedAt, excluded.updatedAt)`, [
        entity.kind,
        entity.externalKey,
        entity.displayName || '',
        timestamp,
        timestamp
    ]);
    return one('SELECT * FROM social_entities WHERE kind = ? AND externalKey = ?', [entity.kind, entity.externalKey]);
}

function socialRelationUnsafe(sourceEntityId, targetEntityId) {
    return one(`SELECT * FROM social_relations
        WHERE sourceEntityId = ? AND targetEntityId = ?`, [sourceEntityId, targetEntityId]);
}

function socialEventUnsafe(eventKey) {
    return one(`SELECT event.*,
            source.id sourceId, source.kind sourceKind,
            source.externalKey sourceKey, source.displayName sourceName,
            target.id targetId, target.kind targetKind,
            target.externalKey targetKey, target.displayName targetName,
            context.id contextId, context.kind contextKind,
            context.externalKey contextKey, context.displayName contextName
        FROM social_events event
        INNER JOIN social_entities source ON source.id = event.sourceEntityId
        INNER JOIN social_entities target ON target.id = event.targetEntityId
        LEFT JOIN social_entities context ON context.id = event.contextEntityId
        WHERE event.eventKey = ?`, [eventKey]);
}

function commitSocialGraphEventUnsafe(input) {
    const existing = socialEventUnsafe(input.eventKey);
    if (existing) {
        const sameIdentity = existing.sourceKind === input.source.kind &&
            existing.sourceKey === input.source.externalKey &&
            existing.targetKind === input.target.kind &&
            existing.targetKey === input.target.externalKey &&
            existing.eventType === input.eventType;
        if (!sameIdentity) throw new Error(`social event key collision: ${input.eventKey}`);
        return {
            inserted: false,
            event: existing,
            relation: socialRelationUnsafe(existing.sourceEntityId, existing.targetEntityId)
        };
    }

    const committedAt = now();
    const source = ensureSocialEntityUnsafe(input.source, committedAt);
    const target = ensureSocialEntityUnsafe(input.target, committedAt);
    if (Number(source.id) === Number(target.id)) {
        throw new Error('social relation source and target must differ');
    }
    const context = input.context ? ensureSocialEntityUnsafe(input.context, committedAt) : null;
    const delta = input.delta;
    const eventResult = write(`INSERT INTO social_events(
            eventKey, sourceEntityId, targetEntityId, contextEntityId, eventType,
            magnitude, salience, affinityDelta, trustDelta, respectDelta,
            fearDelta, hostilityDelta, familiarityDelta, occurredAt, payloadJson
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        input.eventKey,
        source.id,
        target.id,
        context?.id || null,
        input.eventType,
        input.magnitude,
        input.salience,
        delta.affinity,
        delta.trust,
        delta.respect,
        delta.fear,
        delta.hostility,
        delta.familiarity,
        input.occurredAt,
        input.payloadJson
    ]);
    const eventId = Number(eventResult.insertId);

    write(`INSERT INTO social_relations(
            sourceEntityId, targetEntityId, affinity, trust, respect, fear,
            hostility, familiarity, evidenceCount, lastEventId,
            lastInteractionAt, updatedAt, revision, metaJson
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 1, ?)
        ON CONFLICT(sourceEntityId, targetEntityId) DO UPDATE SET
            affinity = MAX(-100, MIN(100, social_relations.affinity + excluded.affinity)),
            trust = MAX(-100, MIN(100, social_relations.trust + excluded.trust)),
            respect = MAX(-100, MIN(100, social_relations.respect + excluded.respect)),
            fear = MAX(-100, MIN(100, social_relations.fear + excluded.fear)),
            hostility = MAX(-100, MIN(100, social_relations.hostility + excluded.hostility)),
            familiarity = MAX(0, social_relations.familiarity + ?),
            evidenceCount = social_relations.evidenceCount + 1,
            lastEventId = excluded.lastEventId,
            lastInteractionAt = MAX(COALESCE(social_relations.lastInteractionAt, 0), excluded.lastInteractionAt),
            updatedAt = excluded.updatedAt,
            revision = social_relations.revision + 1,
            metaJson = COALESCE(excluded.metaJson, social_relations.metaJson)`, [
        source.id,
        target.id,
        delta.affinity,
        delta.trust,
        delta.respect,
        delta.fear,
        delta.hostility,
        Math.max(0, delta.familiarity),
        eventId,
        input.occurredAt,
        committedAt,
        input.relationMetaJson,
        delta.familiarity
    ]);

    return {
        inserted: true,
        event: socialEventUnsafe(input.eventKey),
        relation: socialRelationUnsafe(source.id, target.id)
    };
}

const Database = {
    init(callback = () => {}) {
        try {
            shuttingDown = false;
            closePromise = null;
            databasePath = databaseFile();
            fs.mkdirSync(path.dirname(databasePath), { recursive: true });
            connection = new DatabaseSync(databasePath, { timeout: 5000 });
            // SQLite's built-in auto-checkpoint runs synchronously inside the
            // unlucky gameplay write that crosses its frame threshold. Keep
            // WAL durability, but move checkpoint I/O to a dedicated worker.
            connection.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA temp_store = MEMORY; PRAGMA wal_autocheckpoint = 0;');
            connection.exec(fs.readFileSync(path.join(process.cwd(), 'database', 'sql', 'sqlite.sql'), 'utf8'));
            applySchemaMigrations();
            CheckpointCoordinator.start(databasePath, {
                intervalMs: Number(options.default.Database?.checkpointIntervalMs) || 5000,
                minWalBytes: Number(options.default.Database?.checkpointMinWalBytes) || (4 * 1024 * 1024)
            });
            cleanZeroAmountItems().catch((error) => utils.infoWarn('DB', 'failed to clean zero amount items: %s', error.message));
            utils.infoSuccess('DB', 'SQLite connected %s', databasePath);
            callback();
        } catch (error) {
            if (connection) {
                try {
                    connection.close();
                } catch (_) {
                    // Keep the original initialization failure in the log.
                }
                connection = null;
            }
            process.exitCode = 1;
            utils.infoFail('DB', 'SQLite initialization failed -> %s', error.message);
        }
    },

    execute(statement, operation = 'raw') {
        return run(statement[0], statement[1] || [], operation, statement[2]?.read ?? null);
    },

    upsertBotGoalStates(entries = []) {
        const batch = (entries || []).map((entry) => ({
            characterId: Number(entry?.characterId || 0),
            goalJson: String(entry?.goalJson || ''),
            updatedAt: Number(entry?.updatedAt || now())
        })).filter((entry) => Number.isSafeInteger(entry.characterId) && entry.characterId > 0 && entry.goalJson);
        if (!batch.length) return Promise.resolve(0);
        return inTransaction(() => {
            const values = batch.map(() => '(?, ?, ?)').join(', ');
            const params = batch.flatMap((entry) => [entry.characterId, entry.goalJson, entry.updatedAt]);
            write(`INSERT INTO bot_goal_state (characterId, goalJson, updatedAt)
                VALUES ${values}
                ON CONFLICT(characterId) DO UPDATE SET
                    goalJson = excluded.goalJson,
                    updatedAt = excluded.updatedAt`, params);
            return batch.length;
        }, 'bot-goals:batch-save');
    },

    ensureSocialEntity(entity) {
        return inTransaction(() => ensureSocialEntityUnsafe(entity, now()), 'social:entity-upsert');
    },

    commitSocialGraphEvent(input) {
        return inTransaction(() => commitSocialGraphEventUnsafe(input), 'social:event-commit');
    },

    commitBackgroundPartyMembership({ party, members = [], event = null } = {}) {
        const batch = Array.isArray(members) ? members.slice(0, 40) : [];
        const characterIds = [...new Set(batch.map((entry) => Number(entry?.row?.characterId)).filter((id) => (
            Number.isSafeInteger(id) && id > 0
        )))];
        if (!party?.partyId || !characterIds.length || characterIds.length !== batch.length) {
            return Promise.resolve({ ok: false, reason: 'invalid_party_membership' });
        }

        return inTransaction(() => {
            const placeholders = characterIds.map(() => '?').join(', ');
            const currentRows = all(`SELECT characterId, phase, simulationOwner, partyId, updatedAt
                FROM bot_life_state WHERE characterId IN (${placeholders})`, characterIds);
            const currentById = new Map(currentRows.map((row) => [Number(row.characterId), row]));
            const conflicts = batch.filter((entry) => {
                const row = entry.row;
                const current = currentById.get(Number(row.characterId));
                return !current
                    || current.phase !== 'cold'
                    || String(current.simulationOwner || LEGACY_SIMULATION_OWNER) !== LEGACY_SIMULATION_OWNER
                    || String(current.partyId || '') !== String(entry.expectedPartyId || '')
                    || Number(current.updatedAt || 0) !== Number(entry.expectedUpdatedAt || 0);
            }).map((entry) => Number(entry.row.characterId));
            if (conflicts.length) return { ok: false, reason: 'membership_conflict', conflicts };

            const reserved = all(`SELECT characterId FROM clan_operation_members
                WHERE characterId IN (${placeholders}) AND status = 'active'`, characterIds)
                .map((row) => Number(row.characterId));
            if (reserved.length) return { ok: false, reason: 'clan_operation_reserved', conflicts: reserved };

            write(`INSERT INTO bot_background_parties (
                partyId, leaderId, memberIdsJson, spotId, startedAt, nextResolveAt,
                cohesion, risk, status, roleCoverageJson, statsJson, updatedAt
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(partyId) DO UPDATE SET
                leaderId = excluded.leaderId,
                memberIdsJson = excluded.memberIdsJson,
                spotId = excluded.spotId,
                nextResolveAt = excluded.nextResolveAt,
                cohesion = excluded.cohesion,
                risk = excluded.risk,
                status = excluded.status,
                roleCoverageJson = excluded.roleCoverageJson,
                statsJson = excluded.statsJson,
                updatedAt = excluded.updatedAt`, [
                party.partyId, party.leaderId, party.memberIdsJson, party.spotId,
                party.startedAt, party.nextResolveAt, party.cohesion, party.risk,
                party.status, party.roleCoverageJson, party.statsJson, party.updatedAt
            ]);

            for (const entry of batch) {
                const row = entry.row;
                const result = write(`UPDATE bot_life_state
                    SET activity = ?, activityStartedAt = ?, nextResolveAt = ?,
                        partyId = ?, statsJson = ?, updatedAt = ?
                    WHERE characterId = ?
                    AND phase = 'cold'
                    AND simulationOwner = ?
                    AND COALESCE(partyId, '') = ?
                    AND updatedAt = ?`, [
                    row.activity, row.activityStartedAt, row.nextResolveAt,
                    row.partyId, row.statsJson, row.updatedAt,
                    row.characterId, LEGACY_SIMULATION_OWNER,
                    String(entry.expectedPartyId || ''), Number(entry.expectedUpdatedAt || 0)
                ]);
                if (result.affectedRows !== 1) {
                    const error = new Error(`background party membership conflict for ${row.characterId}`);
                    error.code = 'BOT_PARTY_MEMBERSHIP_CONFLICT';
                    throw error;
                }
            }

            const eventCharacterId = Number(event?.characterId || 0);
            const eventType = String(event?.eventType || '');
            const eventSummary = String(event?.summary || '').slice(0, 255);
            if (eventCharacterId > 0 && eventType && eventSummary) {
                write(`INSERT INTO bot_life_events
                    (characterId, eventType, summary, weight, createdAt, metaJson)
                    VALUES (?, ?, ?, ?, ?, ?)`, [
                    eventCharacterId,
                    eventType,
                    eventSummary,
                    Math.max(1, Number(event?.weight || 1)),
                    Number(event?.createdAt || Date.now()),
                    JSON.stringify(event?.meta || {})
                ]);
                write(`DELETE FROM bot_life_events
                    WHERE characterId = ?
                    AND id NOT IN (
                        SELECT id FROM (
                            SELECT id FROM bot_life_events
                            WHERE characterId = ?
                            ORDER BY weight DESC, createdAt DESC
                            LIMIT 20
                        ) keep_rows
                    )`, [eventCharacterId, eventCharacterId]);
            }

            return { ok: true, partyId: party.partyId, characterIds };
        }, 'bot-party:commit-membership');
    },

    fetchRaidBossStates() {
        return select('raid_boss_state', ['npcId', 'respawnTime', 'hp', 'mp', 'updatedAt'], '', [], 'raid-boss:states');
    },

    upsertRaidBossState(npcId, respawnTime, hp = null, mp = null) {
        return run(`INSERT INTO raid_boss_state (npcId, respawnTime, hp, mp, updatedAt)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(npcId) DO UPDATE SET respawnTime = excluded.respawnTime,
                hp = excluded.hp, mp = excluded.mp, updatedAt = excluded.updatedAt`,
        [Number(npcId), Number(respawnTime), hp === null ? null : Number(hp), mp === null ? null : Number(mp), now()],
        'raid-boss:upsert');
    },

    claimColdSimulationLease(request = {}) {
        const characterId = Number(request.characterId);
        const expectedRevision = Number(request.expectedRevision);
        const ownerId = String(request.ownerId || COLD_SIMULATION_OWNER);
        const leaseId = String(request.leaseId || '');
        const timestamp = Number(request.timestamp || now());
        const leaseUntil = Number(request.leaseUntil || 0);
        if (!Number.isSafeInteger(characterId) || characterId <= 0) return Promise.resolve({ ok: false, reason: 'invalid_character' });
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return Promise.resolve({ ok: false, reason: 'invalid_revision' });
        if (ownerId !== COLD_SIMULATION_OWNER || !leaseId || leaseUntil <= timestamp) return Promise.resolve({ ok: false, reason: 'invalid_lease' });

        return inTransaction(() => {
            const row = coldSimulationRow(characterId);
            const partition = coldSimulationPartition(row, request);
            if (!partition.ok) return partition;
            if (Number(row.simulationRevision || 0) !== expectedRevision) return { ok: false, reason: 'stale_revision' };
            const currentOwner = String(row.simulationOwner || LEGACY_SIMULATION_OWNER);
            const currentLeaseUntil = Number(row.simulationLeaseUntil || 0);
            if (currentOwner !== LEGACY_SIMULATION_OWNER && currentLeaseUntil > timestamp) {
                return { ok: false, reason: 'lease_active' };
            }
            if (![LEGACY_SIMULATION_OWNER, COLD_SIMULATION_OWNER].includes(currentOwner)) {
                return { ok: false, reason: 'owner_changed' };
            }
            const revision = expectedRevision + 1;
            const result = write(`UPDATE bot_life_state
                SET simulationOwner = ?, simulationRevision = ?, simulationLeaseId = ?, simulationLeaseUntil = ?
                WHERE characterId = ? AND simulationRevision = ? AND simulationOwner = ?`, [
                ownerId, revision, leaseId, leaseUntil, characterId, expectedRevision, currentOwner
            ]);
            if (result.affectedRows !== 1) return { ok: false, reason: 'cas_failed' };
            return { ok: true, characterId, ownerId, leaseId, revision, leaseUntil, reason: 'claimed' };
        }, 'bot-life:cold-owner-claim');
    },

    claimColdSimulationLeases(requests = []) {
        const batch = Array.isArray(requests) ? requests.slice(0, 64) : [];
        if (!batch.length) return Promise.resolve([]);
        return inTransaction(() => batch.map((request) => {
            const characterId = Number(request.characterId);
            const expectedRevision = Number(request.expectedRevision);
            const ownerId = String(request.ownerId || COLD_SIMULATION_OWNER);
            const leaseId = String(request.leaseId || '');
            const timestamp = Number(request.timestamp || now());
            const leaseUntil = Number(request.leaseUntil || 0);
            if (!Number.isSafeInteger(characterId) || characterId <= 0) return { ok: false, characterId, reason: 'invalid_character' };
            if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return { ok: false, characterId, reason: 'invalid_revision' };
            if (ownerId !== COLD_SIMULATION_OWNER || !leaseId || leaseUntil <= timestamp) {
                return { ok: false, characterId, reason: 'invalid_lease' };
            }
            const row = coldSimulationRow(characterId);
            const partition = coldSimulationPartition(row, request);
            if (!partition.ok) return { ...partition, characterId };
            if (Number(row.simulationRevision || 0) !== expectedRevision) {
                return {
                    ok: false,
                    characterId,
                    reason: 'stale_revision',
                    expectedRevision,
                    actualRevision: Number(row.simulationRevision || 0),
                    actualOwner: String(row.simulationOwner || LEGACY_SIMULATION_OWNER),
                    actualLeaseUntil: Number(row.simulationLeaseUntil || 0)
                };
            }
            const currentOwner = String(row.simulationOwner || LEGACY_SIMULATION_OWNER);
            const currentLeaseUntil = Number(row.simulationLeaseUntil || 0);
            if (currentOwner !== LEGACY_SIMULATION_OWNER && currentLeaseUntil > timestamp) {
                return { ok: false, characterId, reason: 'lease_active' };
            }
            if (![LEGACY_SIMULATION_OWNER, COLD_SIMULATION_OWNER].includes(currentOwner)) {
                return { ok: false, characterId, reason: 'owner_changed' };
            }
            const revision = expectedRevision + 1;
            const result = write(`UPDATE bot_life_state
                SET simulationOwner = ?, simulationRevision = ?, simulationLeaseId = ?, simulationLeaseUntil = ?
                WHERE characterId = ? AND simulationRevision = ? AND simulationOwner = ?`, [
                ownerId, revision, leaseId, leaseUntil, characterId, expectedRevision, currentOwner
            ]);
            if (result.affectedRows !== 1) {
                const actual = coldSimulationRow(characterId);
                return {
                    ok: false,
                    characterId,
                    reason: 'cas_failed',
                    expectedRevision,
                    actualRevision: Number(actual?.simulationRevision || 0),
                    actualOwner: String(actual?.simulationOwner || LEGACY_SIMULATION_OWNER),
                    actualLeaseUntil: Number(actual?.simulationLeaseUntil || 0)
                };
            }
            return { ok: true, characterId, ownerId, leaseId, revision, leaseUntil, reason: 'claimed' };
        }), 'bot-life:cold-owner-claim-batch');
    },

    commitColdSimulationLease(request = {}) {
        const characterId = Number(request.characterId);
        const expectedRevision = Number(request.expectedRevision);
        const ownerId = String(request.ownerId || COLD_SIMULATION_OWNER);
        const leaseId = String(request.leaseId || '');
        const timestamp = Number(request.timestamp || now());
        const leaseUntil = Number(request.leaseUntil || 0);
        const requestedPatch = { ...(request.patch || {}) };
        const invalidColumn = Object.keys(requestedPatch).find((column) => !COLD_SIMULATION_PATCH_COLUMNS.has(column));
        if (!Number.isSafeInteger(characterId) || characterId <= 0) return Promise.resolve({ ok: false, reason: 'invalid_character' });
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return Promise.resolve({ ok: false, reason: 'invalid_revision' });
        if (ownerId !== COLD_SIMULATION_OWNER || !leaseId || leaseUntil <= timestamp) return Promise.resolve({ ok: false, reason: 'invalid_lease' });
        if (invalidColumn) return Promise.resolve({ ok: false, reason: 'invalid_patch', column: invalidColumn });

        return inTransaction(() => {
            const row = coldSimulationRow(characterId);
            const conflict = coldSimulationConflict(row, { expectedRevision, ownerId, leaseId }, timestamp);
            if (conflict !== 'cas_failed') return { ok: false, reason: conflict };
            const patch = preserveColdVersionedStats(row, requestedPatch);
            const proposed = { ...row, ...patch, phase: patch.phase || row.phase, activity: patch.activity || row.activity };
            const partition = coldSimulationPartition(proposed, request);
            if (!partition.ok) return { ok: false, reason: 'partition_rejected', detail: partition.reason };
            const entries = Object.entries({ ...patch, updatedAt: patch.updatedAt ?? timestamp });
            const revision = expectedRevision + 1;
            const assignments = entries.map(([column]) => `${escapeIdentifier(column)} = ?`);
            assignments.push('simulationRevision = ?', 'simulationLeaseUntil = ?');
            const params = [
                ...entries.map(([, value]) => value), revision, leaseUntil,
                characterId, ownerId, expectedRevision, leaseId, timestamp
            ];
            const result = write(`UPDATE bot_life_state SET ${assignments.join(', ')}
                WHERE characterId = ? AND simulationOwner = ? AND simulationRevision = ?
                  AND simulationLeaseId = ? AND simulationLeaseUntil > ?`, params);
            if (result.affectedRows !== 1) {
                return { ok: false, reason: coldSimulationConflict(coldSimulationRow(characterId), { expectedRevision, ownerId, leaseId }, timestamp) };
            }
            return {
                ok: true,
                characterId,
                ownerId,
                leaseId,
                revision,
                leaseUntil,
                reason: 'committed',
                row: coldSimulationRow(characterId)
            };
        }, 'bot-life:cold-owner-commit');
    },

    commitAndReleaseColdSimulationLeases(requests = []) {
        const batch = Array.isArray(requests) ? requests.slice(0, 32) : [];
        if (!batch.length) return Promise.resolve([]);
        const atomicGroupFailures = new Map();
        const atomicGroups = new Map();
        batch.forEach((request) => {
            const groupId = request.atomicGroup?.id ? String(request.atomicGroup.id) : null;
            if (!groupId) return;
            const group = atomicGroups.get(groupId) || [];
            group.push(request);
            atomicGroups.set(groupId, group);
        });
        atomicGroups.forEach((group, groupId) => {
            const expectedIds = new Set((group[0]?.atomicGroup?.memberIds || []).map(Number).filter(Boolean));
            const presentIds = new Set(group.map((request) => Number(request.characterId)).filter(Boolean));
            let failure = expectedIds.size === 0
                || expectedIds.size !== presentIds.size
                || [...expectedIds].some((id) => !presentIds.has(id));
            let reason = failure ? 'party_group_incomplete' : null;
            if (!failure) {
                for (const request of group) {
                    const characterId = Number(request.characterId);
                    const expectedRevision = Number(request.expectedRevision);
                    const ownerId = String(request.ownerId || COLD_SIMULATION_OWNER);
                    const leaseId = String(request.leaseId || '');
                    const timestamp = Number(request.timestamp || now());
                    const requestedPatch = { ...(request.patch || {}) };
                    const invalidColumn = Object.keys(requestedPatch)
                        .find((column) => !COLD_SIMULATION_PATCH_COLUMNS.has(column));
                    const row = coldSimulationRow(characterId);
                    const conflict = coldSimulationConflict(row, { expectedRevision, ownerId, leaseId }, timestamp);
                    const patch = preserveColdVersionedStats(row, requestedPatch);
                    const proposed = { ...row, ...patch, phase: patch.phase || row?.phase, activity: patch.activity || row?.activity };
                    const partition = coldSimulationPartition(proposed, request);
                    if (!Number.isSafeInteger(characterId) || characterId <= 0
                        || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0
                        || ownerId !== COLD_SIMULATION_OWNER || !leaseId
                        || invalidColumn || conflict !== 'cas_failed' || !partition.ok) {
                        failure = true;
                        reason = conflict !== 'cas_failed'
                            ? conflict
                            : invalidColumn || !partition.ok ? 'party_group_invalid' : 'party_group_invalid';
                        break;
                    }
                }
            }
            if (failure) atomicGroupFailures.set(groupId, reason || 'party_group_aborted');
        });
        return inTransaction(() => batch.map((request) => {
            const groupId = request.atomicGroup?.id ? String(request.atomicGroup.id) : null;
            if (groupId && atomicGroupFailures.has(groupId)) {
                return {
                    ok: false,
                    characterId: Number(request.characterId),
                    reason: 'party_group_aborted',
                    detail: atomicGroupFailures.get(groupId)
                };
            }
            const characterId = Number(request.characterId);
            const expectedRevision = Number(request.expectedRevision);
            const ownerId = String(request.ownerId || COLD_SIMULATION_OWNER);
            const leaseId = String(request.leaseId || '');
            const timestamp = Number(request.timestamp || now());
            const requestedPatch = { ...(request.patch || {}) };
            const invalidColumn = Object.keys(requestedPatch).find((column) => !COLD_SIMULATION_PATCH_COLUMNS.has(column));
            if (!Number.isSafeInteger(characterId) || characterId <= 0) return { ok: false, characterId, reason: 'invalid_character' };
            if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return { ok: false, characterId, reason: 'invalid_revision' };
            if (ownerId !== COLD_SIMULATION_OWNER || !leaseId) return { ok: false, characterId, reason: 'invalid_lease' };
            if (invalidColumn) return { ok: false, characterId, reason: 'invalid_patch', column: invalidColumn };
            const row = coldSimulationRow(characterId);
            const conflict = coldSimulationConflict(row, { expectedRevision, ownerId, leaseId }, timestamp);
            if (conflict !== 'cas_failed') return { ok: false, characterId, reason: conflict };
            const patch = preserveColdVersionedStats(row, requestedPatch);
            const proposed = { ...row, ...patch, phase: patch.phase || row.phase, activity: patch.activity || row.activity };
            const partition = coldSimulationPartition(proposed, request);
            if (!partition.ok) return { ok: false, characterId, reason: 'partition_rejected', detail: partition.reason };
            const entries = Object.entries({ ...patch, updatedAt: patch.updatedAt ?? timestamp });
            const revision = expectedRevision + 1;
            const assignments = entries.map(([column]) => `${escapeIdentifier(column)} = ?`);
            assignments.push(
                'simulationOwner = ?',
                'simulationRevision = ?',
                'simulationLeaseId = NULL',
                'simulationLeaseUntil = 0'
            );
            const params = [
                ...entries.map(([, value]) => value), LEGACY_SIMULATION_OWNER, revision,
                characterId, ownerId, expectedRevision, leaseId, timestamp
            ];
            const result = write(`UPDATE bot_life_state SET ${assignments.join(', ')}
                WHERE characterId = ? AND simulationOwner = ? AND simulationRevision = ?
                  AND simulationLeaseId = ? AND simulationLeaseUntil > ?`, params);
            if (result.affectedRows !== 1) {
                return {
                    ok: false,
                    characterId,
                    reason: coldSimulationConflict(coldSimulationRow(characterId), { expectedRevision, ownerId, leaseId }, timestamp)
                };
            }
            const physical = request.physical || null;
            if (physical) applyColdPhysicalStateUnsafe(characterId, physical);
            return {
                ok: true,
                characterId,
                ownerId: LEGACY_SIMULATION_OWNER,
                leaseId: null,
                revision,
                leaseUntil: 0,
                reason: 'committed_released',
                row: coldSimulationRow(characterId)
            };
        }), 'bot-life:cold-owner-commit-release-batch');
    },

    releaseColdSimulationLeases(requests = []) {
        const batch = Array.isArray(requests) ? requests.slice(0, 64) : [];
        if (!batch.length) return Promise.resolve([]);
        return inTransaction(() => batch.map((request) => {
            const characterId = Number(request.characterId);
            const expectedRevision = Number(request.expectedRevision);
            const ownerId = String(request.ownerId || COLD_SIMULATION_OWNER);
            const leaseId = String(request.leaseId || '');
            const timestamp = Number(request.timestamp || now());
            const row = coldSimulationRow(characterId);
            const conflict = coldSimulationConflict(row, { expectedRevision, ownerId, leaseId }, timestamp);
            if (conflict !== 'cas_failed') return { ok: false, characterId, reason: conflict };
            const revision = expectedRevision + 1;
            const result = write(`UPDATE bot_life_state
                SET simulationOwner = ?, simulationRevision = ?, simulationLeaseId = NULL, simulationLeaseUntil = 0
                WHERE characterId = ? AND simulationOwner = ? AND simulationRevision = ? AND simulationLeaseId = ?`, [
                LEGACY_SIMULATION_OWNER, revision, characterId, ownerId, expectedRevision, leaseId
            ]);
            if (result.affectedRows !== 1) return { ok: false, characterId, reason: 'cas_failed' };
            return { ok: true, characterId, ownerId: LEGACY_SIMULATION_OWNER, leaseId: null, revision, leaseUntil: 0, reason: 'released' };
        }), 'bot-life:cold-owner-release-batch');
    },

    releaseColdSimulationLease(request = {}) {
        const characterId = Number(request.characterId);
        const expectedRevision = Number(request.expectedRevision);
        const ownerId = String(request.ownerId || COLD_SIMULATION_OWNER);
        const leaseId = String(request.leaseId || '');
        const timestamp = Number(request.timestamp || now());
        return inTransaction(() => {
            const row = coldSimulationRow(characterId);
            const conflict = coldSimulationConflict(row, { expectedRevision, ownerId, leaseId }, timestamp);
            if (conflict !== 'cas_failed') return { ok: false, reason: conflict };
            const revision = expectedRevision + 1;
            const result = write(`UPDATE bot_life_state
                SET simulationOwner = ?, simulationRevision = ?, simulationLeaseId = NULL, simulationLeaseUntil = 0
                WHERE characterId = ? AND simulationOwner = ? AND simulationRevision = ? AND simulationLeaseId = ?`, [
                LEGACY_SIMULATION_OWNER, revision, characterId, ownerId, expectedRevision, leaseId
            ]);
            if (result.affectedRows !== 1) return { ok: false, reason: 'cas_failed' };
            return { ok: true, characterId, ownerId: LEGACY_SIMULATION_OWNER, leaseId: null, revision, leaseUntil: 0, reason: 'released' };
        }, 'bot-life:cold-owner-release');
    },

    renewColdSimulationLeases({
        timestamp = now(),
        leaseMs = 30000,
        ownerId = COLD_SIMULATION_OWNER
    } = {}) {
        const cutoff = Number(timestamp);
        const duration = Math.max(1000, Number(leaseMs) || 30000);
        const owner = String(ownerId || COLD_SIMULATION_OWNER);
        if (owner !== COLD_SIMULATION_OWNER || !Number.isFinite(cutoff)) return Promise.resolve([]);

        return inTransaction(() => {
            const candidates = all(`SELECT characterId, simulationRevision, simulationLeaseId, simulationLeaseUntil
                FROM bot_life_state
                WHERE simulationOwner = ?
                  AND simulationLeaseId IS NOT NULL
                  AND simulationLeaseUntil > ?`, [owner, cutoff]);
            return candidates.map((candidate) => {
                const leaseUntil = Math.max(
                    Number(candidate.simulationLeaseUntil || 0),
                    cutoff + duration
                );
                const result = write(`UPDATE bot_life_state
                    SET simulationLeaseUntil = ?
                    WHERE characterId = ? AND simulationOwner = ?
                      AND simulationRevision = ? AND simulationLeaseId = ?
                      AND simulationLeaseUntil > ?`, [
                    leaseUntil,
                    Number(candidate.characterId),
                    owner,
                    Number(candidate.simulationRevision),
                    candidate.simulationLeaseId,
                    cutoff
                ]);
                if (result.affectedRows !== 1) {
                    return {
                        ok: false,
                        characterId: Number(candidate.characterId),
                        ownerId: owner,
                        revision: Number(candidate.simulationRevision),
                        leaseId: candidate.simulationLeaseId,
                        reason: 'renewal_cas_failed'
                    };
                }
                return {
                    ok: true,
                    characterId: Number(candidate.characterId),
                    ownerId: owner,
                    revision: Number(candidate.simulationRevision),
                    leaseId: candidate.simulationLeaseId,
                    leaseUntil,
                    reason: 'renewed'
                };
            });
        }, 'bot-life:cold-owner-renew-batch');
    },

    handoffColdSimulationToMain(request = {}) {
        const characterId = Number(request.characterId);
        const expectedRevision = request.expectedRevision === null || request.expectedRevision === undefined
            ? null
            : Number(request.expectedRevision);
        const patch = { ...(request.patch || {}) };
        const invalidColumn = Object.keys(patch).find((column) => !COLD_SIMULATION_PATCH_COLUMNS.has(column));
        if (invalidColumn) return Promise.resolve({ ok: false, reason: 'invalid_patch', column: invalidColumn });
        return inTransaction(() => {
            const row = coldSimulationRow(characterId);
            if (!row) return { ok: false, reason: 'missing_state' };
            const revision = Number(row.simulationRevision || 0);
            if (expectedRevision !== null && revision !== expectedRevision) return { ok: false, reason: 'stale_revision' };
            const ownerId = String(row.simulationOwner || LEGACY_SIMULATION_OWNER);
            if (!Object.keys(patch).length && ownerId === LEGACY_SIMULATION_OWNER) {
                return { ok: true, characterId, ownerId, leaseId: null, revision, leaseUntil: 0, reason: 'already_main' };
            }
            if (![LEGACY_SIMULATION_OWNER, COLD_SIMULATION_OWNER].includes(ownerId)) return { ok: false, reason: 'owner_changed' };
            if (Object.keys(patch).length) {
                const proposed = { ...row, ...patch, phase: patch.phase || row.phase, activity: patch.activity || row.activity };
                const partition = coldSimulationPartition(proposed, request);
                if (!partition.ok) return { ok: false, reason: 'partition_rejected', detail: partition.reason };
            }
            const nextRevision = revision + 1;
            const entries = Object.entries({ ...patch, updatedAt: patch.updatedAt ?? request.timestamp ?? now() });
            const assignments = entries.map(([column]) => `${escapeIdentifier(column)} = ?`);
            assignments.push(
                'simulationOwner = ?',
                'simulationRevision = ?',
                'simulationLeaseId = NULL',
                'simulationLeaseUntil = 0'
            );
            const result = write(`UPDATE bot_life_state
                SET ${assignments.join(', ')}
                WHERE characterId = ? AND simulationOwner = ? AND simulationRevision = ?`, [
                ...entries.map(([, value]) => value),
                LEGACY_SIMULATION_OWNER, nextRevision, characterId, ownerId, revision
            ]);
            if (result.affectedRows !== 1) return { ok: false, reason: 'cas_failed' };
            return {
                ok: true,
                characterId,
                ownerId: LEGACY_SIMULATION_OWNER,
                leaseId: null,
                revision: nextRevision,
                leaseUntil: 0,
                reason: Object.keys(patch).length ? 'main_transition' : 'hot_handoff',
                row: coldSimulationRow(characterId)
            };
        }, 'bot-life:hot-owner-handoff');
    },

    recoverColdSimulationLeases({ timestamp = now(), includeActive = false } = {}) {
        const cutoff = Number(timestamp);
        return inTransaction(() => {
            const where = `simulationOwner = ?${includeActive ? '' : ' AND simulationLeaseUntil <= ?'}`;
            const selectParams = includeActive ? [COLD_SIMULATION_OWNER] : [COLD_SIMULATION_OWNER, cutoff];
            const candidates = all(`SELECT characterId FROM bot_life_state WHERE ${where}`, selectParams);
            const result = write(`UPDATE bot_life_state
                SET simulationOwner = ?, simulationRevision = simulationRevision + 1,
                    simulationLeaseId = NULL, simulationLeaseUntil = 0
                WHERE ${where}`, [LEGACY_SIMULATION_OWNER, ...selectParams]);
            const rows = candidates.length
                ? all(`SELECT characterId, simulationOwner, simulationRevision, simulationLeaseId, simulationLeaseUntil
                    FROM bot_life_state WHERE characterId IN (${candidates.map(() => '?').join(', ')})`, candidates.map((row) => row.characterId))
                : [];
            return { ...result, rows };
        }, includeActive ? 'bot-life:cold-owner-startup-recovery' : 'bot-life:cold-owner-expired-recovery');
    },

    clearRaidBossState(npcId) {
        return remove('raid_boss_state', 'npcId = ?', [Number(npcId)], 'raid-boss:clear');
    },

    isReady() { return !!connection; },

    close() {
        if (closePromise) return closePromise;
        shuttingDown = true;
        const pending = queryTail;
        closePromise = pending.then(async () => {
            if (!connection) {
                await CheckpointCoordinator.stop({ final: true });
                return false;
            }
            const openConnection = connection;
            connection = null;
            openConnection.close();
            queryTail = Promise.resolve();
            await CheckpointCoordinator.stop({ final: true });
            return true;
        });
        return closePromise;
    },

    registerCharacterWriteFlush(flush) {
        flushPendingCharacterWrites = typeof flush === 'function' ? flush : null;
    },

    cooperatively(work, sliceMs = 12) {
        const outermost = cooperative.depth === 0;
        if (outermost) {
            cooperative.sliceStartedAt = now();
            cooperative.sliceMs = Math.max(1, Number(sliceMs) || 12);
        }
        cooperative.depth += 1;
        return Promise.resolve().then(work).finally(() => {
            cooperative.depth -= 1;
            if (cooperative.depth === 0) {
                cooperative.sliceStartedAt = 0;
                cooperative.sliceMs = 0;
            }
        });
    },

    stats({ resetPeak = false } = {}) {
        const operations = Object.fromEntries(Array.from(metrics.byOperation.entries()).map(([key, value]) => [key, { ...value }]));
        const snapshot = {
            path: databasePath || null,
            pending: metrics.pending,
            maxPending: metrics.maxPending,
            total: metrics.total,
            reads: metrics.reads,
            writes: metrics.writes,
            transactions: metrics.transactions,
            failures: metrics.failures,
            avgWaitMs: metrics.total ? Math.round(metrics.waitMs / metrics.total) : 0,
            avgRunMs: metrics.total ? Math.round(metrics.runMs / metrics.total) : 0,
            operations,
            checkpoint: CheckpointCoordinator.snapshot()
        };
        if (resetPeak) metrics.maxPending = metrics.pending;
        return snapshot;
    },

    checkpoint(options = {}) {
        if (shuttingDown) return Promise.reject(new Error('SQLite shutdown is in progress (maintenance:checkpoint)'));
        if (!connection) return Promise.reject(new Error('SQLite is not initialized (maintenance:checkpoint)'));
        return CheckpointCoordinator.request({
            force: true,
            mode: options.mode === 'truncate'
                ? 'truncate'
                : options.mode === 'restart' ? 'restart' : 'passive',
            minWalBytes: 0,
            busyTimeoutMs: options.busyTimeoutMs
        });
    },

    applyBufferedCharacterState(characterId, state = {}) {
        return inTransaction(() => applyBufferedCharacterStateUnsafe(characterId, state), 'buffered-character:flush');
    },

    applyBufferedCharacterStates(entries = []) {
        return inTransaction(() => entries.map(([characterId, state]) => applyBufferedCharacterStateUnsafe(Number(characterId), state)), 'buffered-character:flush-batch');
    },

    syncInventorySummary(characterId, inventory = {}) {
        return withCharacterFlush(characterId, () => inTransaction(
            () => syncInventorySummaryUnsafe(characterId, inventory),
            'inventory:sync-summary'
        ));
    },

    compactStackableInventory(selfIds = [], taskName = 'compact-stackable-inventory-v1') {
        const ids = [...new Set((selfIds || []).map(Number).filter((selfId) => selfId > 0))];
        if (!ids.length) return Promise.resolve({ skipped: true, reason: 'no_stackable_items', rowsRemoved: 0, groups: 0 });
        return inTransaction(() => {
            const completed = one('SELECT completedAt FROM maintenance_tasks WHERE name = ?', [taskName]);
            if (completed) return { skipped: true, reason: 'already_completed', completedAt: Number(completed.completedAt), rowsRemoved: 0, groups: 0 };

            connection.exec(`
                DROP TABLE IF EXISTS temp.stackable_item_ids;
                DROP TABLE IF EXISTS temp.stackable_inventory_compaction;
                CREATE TEMP TABLE stackable_item_ids (selfId INTEGER PRIMARY KEY);
            `);
            const insertId = connection.prepare('INSERT OR IGNORE INTO stackable_item_ids(selfId) VALUES (?)');
            ids.forEach((selfId) => insertId.run(selfId));
            connection.exec(`
                CREATE TEMP TABLE stackable_inventory_compaction AS
                SELECT items.characterId,
                       items.selfId,
                       MIN(items.id) AS keeperId,
                       SUM(items.amount) AS totalAmount,
                       COUNT(*) AS rowCount
                FROM items
                INNER JOIN stackable_item_ids ON stackable_item_ids.selfId = items.selfId
                WHERE items.equipped = 0
                  AND items.slot = 0
                  AND items.petData IS NULL
                  AND items.amount > 0
                GROUP BY items.characterId, items.selfId
                HAVING COUNT(*) > 1;
            `);
            const summary = one(`SELECT COUNT(*) AS groups,
                COALESCE(SUM(rowCount - 1), 0) AS duplicateRows
                FROM stackable_inventory_compaction`);
            write(`UPDATE items
                SET amount = (
                    SELECT totalAmount
                    FROM stackable_inventory_compaction compact
                    WHERE compact.keeperId = items.id
                )
                WHERE id IN (SELECT keeperId FROM stackable_inventory_compaction)`);
            const removed = write(`DELETE FROM items
                WHERE EXISTS (
                    SELECT 1
                    FROM stackable_inventory_compaction compact
                    WHERE compact.characterId = items.characterId
                      AND compact.selfId = items.selfId
                      AND items.id <> compact.keeperId
                      AND items.equipped = 0
                      AND items.slot = 0
                      AND items.petData IS NULL
                )`);
            const completedAt = now();
            write('INSERT INTO maintenance_tasks(name, completedAt) VALUES (?, ?)', [taskName, completedAt]);
            connection.exec(`
                DROP TABLE stackable_inventory_compaction;
                DROP TABLE stackable_item_ids;
            `);
            return {
                skipped: false,
                completedAt,
                rowsRemoved: Number(removed.affectedRows || 0),
                groups: Number(summary?.groups || 0),
                expectedRowsRemoved: Number(summary?.duplicateRows || 0)
            };
        }, 'maintenance:compact-stackable-inventory');
    },

    reclaimUnusedSpace({ minFreePages = 1000, minFreeRatio = 0.25 } = {}) {
        return enqueue(() => {
            const pageCount = Number(one('PRAGMA page_count')?.page_count || 0);
            const freePages = Number(one('PRAGMA freelist_count')?.freelist_count || 0);
            const pageSize = Number(one('PRAGMA page_size')?.page_size || 0);
            const freeRatio = pageCount > 0 ? freePages / pageCount : 0;
            if (freePages < Math.max(0, Number(minFreePages) || 0)
                || freeRatio < Math.max(0, Number(minFreeRatio) || 0)) {
                return { reclaimed: false, pageCount, freePages, pageSize, freeRatio };
            }
            connection.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM;');
            const nextPageCount = Number(one('PRAGMA page_count')?.page_count || 0);
            const nextFreePages = Number(one('PRAGMA freelist_count')?.freelist_count || 0);
            return {
                reclaimed: true,
                pageCount,
                freePages,
                pageSize,
                freeRatio,
                nextPageCount,
                nextFreePages,
                reclaimedBytes: Math.max(0, (pageCount - nextPageCount) * pageSize)
            };
        }, { operation: 'maintenance:reclaim-unused-space', read: false });
    },

    transferInventoryBetweenCharacters(transfers = []) {
        const entries = (transfers || []).map((transfer) => ({
            fromCharacterId: Number(transfer.fromCharacterId),
            toCharacterId: Number(transfer.toCharacterId),
            sourceItemId: Number(transfer.sourceItemId),
            selfId: Number(transfer.selfId),
            amount: Math.floor(Number(transfer.amount)),
            stackable: transfer.stackable ? 1 : 0,
            name: transfer.name || '',
            slot: Number(transfer.slot || 0),
            petData: transfer.petData
                ? (typeof transfer.petData === 'string' ? transfer.petData : JSON.stringify(transfer.petData))
                : null
        }));
        const characterIds = entries.flatMap((entry) => [entry.fromCharacterId, entry.toCharacterId]);
        return withCharacterFlushes(characterIds, () => inTransaction(() => {
            if (!entries.length) throw new Error('empty inventory transfer');

            const sources = entries.map((entry) => {
                if (!entry.fromCharacterId || !entry.toCharacterId || !entry.sourceItemId || !entry.selfId || entry.amount <= 0) {
                    throw new Error('invalid inventory transfer');
                }
                const source = one('SELECT id, selfId, name, amount, enchant, equipped, slot, petData FROM items WHERE id = ? AND characterId = ?', [entry.sourceItemId, entry.fromCharacterId]);
                if (!source || Number(source.selfId) !== entry.selfId || Number(source.amount) < entry.amount || Number(source.equipped) !== 0) {
                    throw new Error('inventory item changed');
                }
                return { entry, source };
            });

            const moved = [];
            sources.forEach(({ entry, source }) => {
                const remaining = Number(source.amount) - entry.amount;
                if (remaining <= 0) write('DELETE FROM items WHERE id = ? AND characterId = ?', [entry.sourceItemId, entry.fromCharacterId]);
                else write('UPDATE items SET amount = ? WHERE id = ? AND characterId = ?', [remaining, entry.sourceItemId, entry.fromCharacterId]);

                let target = null;
                if (entry.stackable) {
                    target = one('SELECT id, amount FROM items WHERE characterId = ? AND selfId = ? ORDER BY id LIMIT 1', [entry.toCharacterId, entry.selfId]);
                }
                let targetItemId;
                if (target) {
                    targetItemId = Number(target.id);
                    write('UPDATE items SET amount = ? WHERE id = ? AND characterId = ?', [Number(target.amount) + entry.amount, targetItemId, entry.toCharacterId]);
                } else {
                    targetItemId = write(
                        'INSERT INTO items (selfId, name, amount, enchant, equipped, slot, petData, characterId) VALUES (?, ?, ?, ?, 0, ?, ?, ?)',
                        [entry.selfId, entry.name || source.name || `Item ${entry.selfId}`, entry.amount, Number(source.enchant || 0), entry.slot, entry.petData || source.petData || null, entry.toCharacterId]
                    ).insertId;
                }
                moved.push({
                    ...entry,
                    targetItemId: Number(targetItemId),
                    remaining
                });
            });
            return moved;
        }, 'trade:inventory-transfer'));
    },

    createAccount(username, password) {
        return insert('accounts', { username, password }, 'account:create');
    },
    fetchUserPassword(username) {
        return selectOne('accounts', ['username', 'password'], 'username = ? COLLATE NOCASE', [username], 'account:password');
    },
    fetchCharacters(username) {
        return select('characters', ['*'], 'username = ? COLLATE NOCASE', [username], 'character:by-account');
    },
    fetchClanCharacters() {
        return select('characters', ['*'], 'clanId != 0', [], 'character:clan-members');
    },
    fetchCharacterName(name) {
        return selectOne('characters', ['*'], 'name = ? COLLATE NOCASE', [name], 'character:by-name');
    },
    createCharacter(username, data) {
        return selectOne('accounts', ['username'], 'username = ? COLLATE NOCASE', [username], 'account:canonical-name')
            .then((accounts) => {
                if (!accounts[0]) throw new Error('account does not exist');
                return insert('characters', {
                    username: accounts[0].username, name: data.name, race: data.race, classId: data.classId,
                    maxHp: data.maxHp, maxMp: data.maxMp, sex: data.sex, face: data.face,
                    hair: data.hair, hairColor: data.hairColor, locX: data.locX, locY: data.locY, locZ: data.locZ
                }, 'character:create');
            });
    },
    deleteCharacter(username, name) {
        return remove('characters', 'username = ? COLLATE NOCASE AND name = ? COLLATE NOCASE', [username, name], 'character:delete');
    },
    fetchSkills(characterId) {
        return select('skills', ['*'], 'characterId = ?', [characterId], 'skill:list');
    },
    fetchSkill(characterId, skillSelfId) {
        return selectOne('skills', ['*'], 'characterId = ? AND selfId = ?', [characterId, skillSelfId], 'skill:one');
    },
    deleteSkills(characterId) {
        return remove('skills', 'characterId = ?', [characterId], 'skill:delete-all');
    },
    setSkill(skill, characterId) {
        return run(`INSERT INTO skills (selfId, name, passive, level, characterId) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(characterId, selfId) DO UPDATE SET name = excluded.name, passive = excluded.passive, level = excluded.level`,
        [skill.selfId, skill.name, skill.passive ? 1 : 0, skill.level, characterId], 'skill:upsert');
    },
    updateSkillLevel(characterId, skillSelfId, skillLevel) {
        return update('skills', { level: skillLevel }, 'selfId = ? AND characterId = ?', [skillSelfId, characterId], 'skill:level');
    },
    setItem(characterId, item) {
        const values = { selfId: item.selfId, name: item.name ?? '', amount: item.amount ?? 1, enchant: Math.max(0, Number(item.enchant ?? 0) || 0), equipped: item.equipped ? 1 : 0, slot: item.slot ?? 0, characterId };
        if (item.petData) values.petData = typeof item.petData === 'string' ? item.petData : JSON.stringify(item.petData);
        return withCharacterFlush(characterId, () => insert('items', values, 'item:insert'));
    },
    fetchItems(characterId) {
        return withCharacterFlush(characterId, () => select('items', ['*'], 'characterId = ? AND amount > 0', [characterId], 'item:list'));
    },
    updateItemAmount(characterId, id, amount) {
        return withCharacterFlush(characterId, () => {
            if (Number(amount) <= 0) return remove('items', 'id = ? AND characterId = ?', [id, characterId], 'item:delete-empty');
            return update('items', { amount }, 'id = ? AND characterId = ?', [id, characterId], 'item:amount');
        });
    },
    updateItemEquipState(characterId, id, equipped, slot) {
        return withCharacterFlush(characterId, () => update('items', { equipped: equipped ? 1 : 0, slot }, 'id = ? AND characterId = ?', [id, characterId], 'item:equip'));
    },
    updateItemEnchantLevel(characterId, id, enchant) {
        return withCharacterFlush(characterId, () => update('items', { enchant: Math.max(0, Number(enchant) || 0) }, 'id = ? AND characterId = ?', [id, characterId], 'item:enchant'));
    },
    deleteItem(characterId, id) {
        return withCharacterFlush(characterId, () => remove('items', 'id = ? AND characterId = ?', [id, characterId], 'item:delete'));
    },
    deleteItems(characterId) {
        return withCharacterFlush(characterId, () => remove('items', 'characterId = ?', [characterId], 'item:delete-all'));
    },
    fetchWarehouseItems(characterId) {
        return select('warehouse_items', ['*'], 'characterId = ? AND amount > 0', [characterId], 'warehouse:list');
    },
    setWarehouseItem(characterId, item) {
        const values = { selfId: item.selfId, name: item.name ?? '', amount: item.amount ?? 1, enchant: Math.max(0, Number(item.enchant ?? 0) || 0), characterId };
        if (item.petData) values.petData = typeof item.petData === 'string' ? item.petData : JSON.stringify(item.petData);
        return insert('warehouse_items', values, 'warehouse:insert');
    },
    updateWarehouseItemAmount(characterId, id, amount) {
        if (Number(amount) <= 0) return remove('warehouse_items', 'id = ? AND characterId = ?', [id, characterId], 'warehouse:delete-empty');
        return update('warehouse_items', { amount }, 'id = ? AND characterId = ?', [id, characterId], 'warehouse:amount');
    },
    deleteWarehouseItem(characterId, id) {
        return remove('warehouse_items', 'id = ? AND characterId = ?', [id, characterId], 'warehouse:delete');
    },

    liquidateWarehouseGear(characterId, selections = [], options = {}) {
        const id = Number(characterId);
        const selected = (selections || []).map((item) => ({
            id: Number(item?.id || 0),
            selfId: Number(item?.selfId || 0),
            amount: Math.max(0, Number(item?.amount || 0)),
            enchant: Math.max(0, Number(item?.enchant || 0)),
            npcPrice: Math.max(0, Number(item?.npcPrice || 0))
        }));
        const selectedIds = new Set(selected.map((item) => item.id));
        if (!Number.isSafeInteger(id) || id <= 0 || !selected.length || selected.length > 64
            || selectedIds.size !== selected.length
            || selected.some((item) => !item.id || !item.selfId || item.amount <= 0 || item.npcPrice <= 0)) {
            return Promise.reject(new Error('invalid warehouse gear liquidation request'));
        }

        return withCharacterFlush(id, () => inTransaction(() => {
            const state = one('SELECT * FROM bot_life_state WHERE characterId = ?', [id]);
            if (!state) return { ok: false, reason: 'missing_state', characterId: id };
            if (String(state.simulationOwner || LEGACY_SIMULATION_OWNER) !== LEGACY_SIMULATION_OWNER) {
                return { ok: false, reason: 'owner_changed', characterId: id };
            }
            const partition = coldSimulationPartition(state);
            if (!partition.ok) return { ok: false, reason: partition.reason, characterId: id };
            if (!['hunting', 'resting'].includes(String(state.activity || ''))) {
                return { ok: false, reason: 'active_lifecycle', characterId: id };
            }

            const stats = parsedObject(state.statsJson);
            if (!stats) return { ok: false, reason: 'invalid_stats', characterId: id };
            if (stats.backgroundPartyId) return { ok: false, reason: 'background_party', characterId: id };

            const sources = selected.map((item) => {
                const source = one(`SELECT id, selfId, amount, enchant
                    FROM warehouse_items WHERE id = ? AND characterId = ?`, [item.id, id]);
                if (!source || Number(source.selfId) !== item.selfId
                    || Number(source.amount || 0) < item.amount
                    || Math.max(0, Number(source.enchant || 0)) !== item.enchant) {
                    const error = new Error(`warehouse gear changed for ${id}:${item.id}`);
                    error.code = 'WAREHOUSE_GEAR_CHANGED';
                    throw error;
                }
                return { ...item, remaining: Number(source.amount) - item.amount };
            });

            let rowsRemoved = 0;
            sources.forEach((source) => {
                if (source.remaining <= 0) {
                    write('DELETE FROM warehouse_items WHERE id = ? AND characterId = ?', [source.id, id]);
                    rowsRemoved += 1;
                } else {
                    write('UPDATE warehouse_items SET amount = ? WHERE id = ? AND characterId = ?', [source.remaining, source.id, id]);
                }
            });

            const inventory = parsedObject(state.inventorySummary);
            if (!inventory) throw new Error(`invalid inventory summary for ${id}`);
            const adenaRows = all(`SELECT id, amount FROM items
                WHERE characterId = ? AND selfId = 57 ORDER BY id`, [id]);
            const physicalAdena = adenaRows.reduce((sum, item) => sum + Math.max(0, Number(item.amount || 0)), 0);
            const payout = sources.reduce((sum, item) => sum + (item.amount * item.npcPrice), 0);
            const currentAdena = Math.max(
                0,
                Number(state.adena || 0),
                Number(inventory['57']?.amount || 0),
                physicalAdena
            );
            const nextAdena = currentAdena + payout;
            inventory['57'] = {
                ...(inventory['57'] || {}),
                selfId: 57,
                name: 'Adena',
                amount: nextAdena
            };

            const soldByItem = new Map();
            sources.forEach((item) => {
                const key = `${item.selfId}:${item.npcPrice}`;
                const previous = soldByItem.get(key) || { selfId: item.selfId, amount: 0, price: item.npcPrice };
                previous.amount += item.amount;
                soldByItem.set(key, previous);
            });
            const timestamp = now();
            const units = sources.reduce((sum, item) => sum + item.amount, 0);
            const nextStats = {
                ...stats,
                lastWarehouseCompaction: {
                    source: String(options.source || 'historical_gear_retention'),
                    payout,
                    units,
                    rowsRemoved,
                    sold: [...soldByItem.values()].slice(0, 8),
                    at: timestamp
                }
            };

            const adenaRow = adenaRows[0];
            if (adenaRow) {
                write('UPDATE items SET name = ?, amount = ? WHERE id = ? AND characterId = ?', ['Adena', nextAdena, adenaRow.id, id]);
                adenaRows.slice(1).forEach((row) => write('DELETE FROM items WHERE id = ? AND characterId = ?', [row.id, id]));
            } else {
                write(`INSERT INTO items (selfId, name, amount, enchant, equipped, slot, characterId)
                    VALUES (57, 'Adena', ?, 0, 0, 0, ?)`, [nextAdena, id]);
            }

            const updated = write(`UPDATE bot_life_state
                SET adena = ?, inventorySummary = ?, statsJson = ?, updatedAt = ?
                WHERE characterId = ?
                  AND simulationOwner = ?
                  AND simulationRevision = ?
                  AND phase = 'cold'
                  AND (partyId IS NULL OR partyId = '')
                  AND activity IN ('hunting', 'resting')`, [
                nextAdena,
                JSON.stringify(inventory),
                JSON.stringify(nextStats),
                timestamp,
                id,
                LEGACY_SIMULATION_OWNER,
                Number(state.simulationRevision || 0)
            ]);
            if (Number(updated.affectedRows || 0) !== 1) {
                const error = new Error(`warehouse cleanup ownership changed for ${id}`);
                error.code = 'WAREHOUSE_CLEANUP_FENCE';
                throw error;
            }

            return {
                ok: true,
                reason: 'compacted',
                characterId: id,
                rowsRemoved,
                units,
                payout,
                state: normalizeRow(one('SELECT * FROM bot_life_state WHERE characterId = ?', [id]))
            };
        }, 'warehouse:cleanup-gear'));
    },

    transferInventoryToWarehouse(characterId, item) {
        return withCharacterFlush(characterId, () => inTransaction(() => {
            const source = one('SELECT id, amount, enchant FROM items WHERE id = ? AND characterId = ?', [item.id, characterId]);
            if (!source || Number(source.amount) < Number(item.amount)) throw new Error('inventory item changed');
            const sourceEnchant = Math.max(0, Number(source.enchant) || 0);
            const target = item.stackable ? one('SELECT id, amount FROM warehouse_items WHERE characterId = ? AND selfId = ? ORDER BY id LIMIT 1', [characterId, item.selfId]) : null;
            const warehouseAmount = Number(target?.amount || 0) + Number(item.amount);
            const petData = item.petData
                ? (typeof item.petData === 'string' ? item.petData : JSON.stringify(item.petData))
                : null;
            const warehouseId = target ? target.id : write('INSERT INTO warehouse_items (selfId, name, amount, enchant, petData, characterId) VALUES (?, ?, ?, ?, ?, ?)', [item.selfId, item.name || '', item.amount, sourceEnchant, petData, characterId]).insertId;
            if (target) write('UPDATE warehouse_items SET amount = ? WHERE id = ? AND characterId = ?', [warehouseAmount, warehouseId, characterId]);
            const inventoryAmount = Number(source.amount) - Number(item.amount);
            if (inventoryAmount <= 0) write('DELETE FROM items WHERE id = ? AND characterId = ?', [item.id, characterId]);
            else write('UPDATE items SET amount = ? WHERE id = ? AND characterId = ?', [inventoryAmount, item.id, characterId]);
            return { warehouseId: Number(warehouseId), warehouseAmount, inventoryAmount, enchant: sourceEnchant };
        }, 'warehouse:deposit'));
    },

    transferWarehouseToInventory(characterId, item) {
        return withCharacterFlush(characterId, () => inTransaction(() => {
            const source = one('SELECT id, amount, enchant, petData FROM warehouse_items WHERE id = ? AND characterId = ?', [item.id, characterId]);
            if (!source || Number(source.amount) < Number(item.amount)) throw new Error('warehouse item changed');
            const sourceEnchant = Math.max(0, Number(source.enchant) || 0);
            const target = item.stackable ? one('SELECT id, amount FROM items WHERE characterId = ? AND selfId = ? ORDER BY id LIMIT 1', [characterId, item.selfId]) : null;
            const inventoryAmount = Number(target?.amount || 0) + Number(item.amount);
            const inventoryId = target ? target.id : write('INSERT INTO items (selfId, name, amount, enchant, equipped, slot, petData, characterId) VALUES (?, ?, ?, ?, 0, 0, ?, ?)', [item.selfId, item.name || '', item.amount, sourceEnchant, source.petData, characterId]).insertId;
            if (target) write('UPDATE items SET amount = ? WHERE id = ? AND characterId = ?', [inventoryAmount, inventoryId, characterId]);
            const warehouseAmount = Number(source.amount) - Number(item.amount);
            if (warehouseAmount <= 0) write('DELETE FROM warehouse_items WHERE id = ? AND characterId = ?', [item.id, characterId]);
            else write('UPDATE warehouse_items SET amount = ? WHERE id = ? AND characterId = ?', [warehouseAmount, item.id, characterId]);
            return { inventoryId: Number(inventoryId), inventoryAmount, warehouseAmount, petData: source.petData, enchant: sourceEnchant };
        }, 'warehouse:withdraw'));
    },

    transferPlayerInventoryBatchToClanWarehouse({ clanId, characterId, transfers = [] } = {}) {
        const clan = Number(clanId);
        const character = Number(characterId);
        const normalized = (transfers || []).map((transfer) => ({
            item: transfer?.item || {},
            sourceItemId: Number(transfer?.item?.id || 0),
            selfId: Number(transfer?.item?.selfId || 0),
            requested: Math.floor(Number(transfer?.amount) || 0),
            key: String(transfer?.resolveKey || '').trim()
        }));
        const sourceIds = new Set(normalized.map((transfer) => transfer.sourceItemId));
        const resolveKeys = new Set(normalized.map((transfer) => transfer.key));
        if (!clan || !character || !normalized.length
            || normalized.some((transfer) => (
                !transfer.sourceItemId || !transfer.selfId || transfer.requested <= 0 || !transfer.key
            ))
            || sourceIds.size !== normalized.length || resolveKeys.size !== normalized.length) {
            return Promise.reject(new Error('invalid clan warehouse deposit'));
        }
        return withCharacterFlush(character, () => inTransaction(() => {
            const clanRow = one('SELECT id, leaderId FROM clans WHERE id = ?', [clan]);
            const member = one('SELECT id, clanId FROM characters WHERE id = ?', [character]);
            if (!clanRow || !member || Number(member.clanId) !== clan) throw new Error('character is no longer in this clan');
            const prepared = normalized.map((transfer) => {
                const source = one(`SELECT id, selfId, name, amount, enchant, petData
                    FROM items WHERE id = ? AND characterId = ?`, [transfer.sourceItemId, character]);
                if (!source || Number(source.selfId) !== transfer.selfId || Number(source.amount) < transfer.requested) {
                    throw new Error('inventory item changed');
                }
                return { ...transfer, source };
            });
            const simulation = one('SELECT stateJson FROM clan_simulation_clans WHERE clanId = ?', [clan]);
            const previousState = jsonObject(simulation?.stateJson);
            let warehouseRevision = simulation
                ? Math.max(0, Number(previousState.warehouseRevision) || 0)
                : Number(one('SELECT COALESCE(MAX(warehouseRevision), 0) AS revision FROM clan_warehouse_ledger WHERE clanId = ?', [clan]).revision || 0);
            const timestamp = now();
            const results = prepared.map(({ item, sourceItemId, selfId, requested, key, source }) => {
                const sourceEnchant = Math.max(0, Number(source.enchant) || 0);
                const stackable = item.stackable === true;
                const target = stackable ? one(`SELECT id, amount FROM clan_warehouse_items
                    WHERE clanId = ? AND selfId = ? AND enchant = ? ORDER BY id LIMIT 1`, [clan, selfId, sourceEnchant]) : null;
                const warehouseIds = [];
                let warehouseAmount = 1;
                if (target) {
                    warehouseIds.push(Number(target.id));
                    warehouseAmount = Number(target.amount || 0) + requested;
                    write('UPDATE clan_warehouse_items SET amount = ?, updatedAt = ? WHERE id = ? AND clanId = ?', [
                        warehouseAmount, timestamp, target.id, clan
                    ]);
                } else {
                    const rows = stackable ? 1 : requested;
                    const rowAmount = stackable ? requested : 1;
                    for (let index = 0; index < rows; index += 1) {
                        warehouseIds.push(Number(write(`INSERT INTO clan_warehouse_items
                            (clanId, selfId, name, kind, amount, enchant, petData, createdAt, updatedAt)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
                            clan, selfId, String(item.name || source.name || `Item ${selfId}`), String(item.kind || ''), rowAmount,
                            sourceEnchant, source.petData || null, timestamp, timestamp
                        ]).insertId));
                    }
                    warehouseAmount = rowAmount;
                }
                const inventoryAmount = Number(source.amount) - requested;
                if (inventoryAmount <= 0) write('DELETE FROM items WHERE id = ? AND characterId = ?', [sourceItemId, character]);
                else write('UPDATE items SET amount = ? WHERE id = ? AND characterId = ?', [inventoryAmount, sourceItemId, character]);
                warehouseRevision += 1;
                const ledger = write(`INSERT INTO clan_warehouse_ledger
                    (clanId, characterId, selfId, amount, operation, resolveKey, warehouseRevision, createdAt)
                    VALUES (?, ?, ?, ?, 'deposit', ?, ?, ?)`, [clan, character, selfId, requested, key, warehouseRevision, timestamp]);
                return {
                    sourceItemId, warehouseId: warehouseIds[0], warehouseIds, warehouseAmount, inventoryAmount, enchant: sourceEnchant,
                    petData: source.petData, warehouseRevision, ledgerId: Number(ledger.insertId)
                };
            });
            if (simulation) {
                const state = simulationState(previousState, clan, clanRow.leaderId, previousState.memberIds || [], timestamp);
                state.warehouseRevision = warehouseRevision;
                write('UPDATE clan_simulation_clans SET updatedAt = ?, stateJson = ? WHERE clanId = ?', [timestamp, JSON.stringify(state), clan]);
            }
            return results;
        }, 'clan-warehouse:player-deposit'));
    },

    transferPlayerInventoryToClanWarehouse({ clanId, characterId, item = {}, amount, resolveKey } = {}) {
        return Database.transferPlayerInventoryBatchToClanWarehouse({
            clanId,
            characterId,
            transfers: [{ item, amount, resolveKey }]
        }).then((results) => results[0]);
    },

    transferClanWarehouseToPlayerInventory({ clanId, characterId, item = {}, amount, resolveKey } = {}) {
        const clan = Number(clanId);
        const character = Number(characterId);
        const warehouseItemId = Number(item.id || 0);
        const selfId = Number(item.selfId || 0);
        const requested = Math.floor(Number(amount) || 0);
        const key = String(resolveKey || '').trim();
        if (!clan || !character || !warehouseItemId || !selfId || requested <= 0 || !key) {
            return Promise.reject(new Error('invalid clan warehouse withdrawal'));
        }
        return withCharacterFlush(character, () => inTransaction(() => {
            const clanRow = one('SELECT id, leaderId FROM clans WHERE id = ?', [clan]);
            const member = one('SELECT id, clanId FROM characters WHERE id = ?', [character]);
            if (!clanRow || !member || Number(member.clanId) !== clan) throw new Error('character is no longer in this clan');
            if (Number(clanRow.leaderId) !== character) throw new Error('only the clan leader may withdraw');
            const source = one(`SELECT id, selfId, name, kind, amount, enchant, petData, reservedAmount
                FROM clan_warehouse_items WHERE id = ? AND clanId = ?`, [warehouseItemId, clan]);
            const available = source ? Math.max(0, Number(source.amount) - Number(source.reservedAmount || 0)) : 0;
            if (!source || Number(source.selfId) !== selfId || available < requested) {
                throw new Error('clan warehouse item changed or is reserved');
            }
            const simulation = one('SELECT stateJson FROM clan_simulation_clans WHERE clanId = ?', [clan]);
            const previousState = jsonObject(simulation?.stateJson);
            const currentRevision = simulation
                ? Math.max(0, Number(previousState.warehouseRevision) || 0)
                : Number(one('SELECT COALESCE(MAX(warehouseRevision), 0) AS revision FROM clan_warehouse_ledger WHERE clanId = ?', [clan]).revision || 0);
            const sourceEnchant = Math.max(0, Number(source.enchant) || 0);
            const target = item.stackable !== false ? one(`SELECT id, amount FROM items
                WHERE characterId = ? AND selfId = ? AND enchant = ? ORDER BY id LIMIT 1`, [character, selfId, sourceEnchant]) : null;
            const inventoryAmount = Number(target?.amount || 0) + requested;
            const inventoryId = target ? Number(target.id) : Number(write(`INSERT INTO items
                (selfId, name, amount, enchant, equipped, slot, petData, characterId)
                VALUES (?, ?, ?, ?, 0, 0, ?, ?)`, [
                selfId, String(source.name || item.name || `Item ${selfId}`), requested, sourceEnchant, source.petData || null, character
            ]).insertId);
            if (target) write('UPDATE items SET amount = ? WHERE id = ? AND characterId = ?', [inventoryAmount, inventoryId, character]);
            const timestamp = now();
            const warehouseAmount = Number(source.amount) - requested;
            if (warehouseAmount <= 0 && Number(source.reservedAmount || 0) <= 0) {
                write('DELETE FROM clan_warehouse_items WHERE id = ? AND clanId = ?', [warehouseItemId, clan]);
            } else {
                write('UPDATE clan_warehouse_items SET amount = ?, updatedAt = ? WHERE id = ? AND clanId = ?', [warehouseAmount, timestamp, warehouseItemId, clan]);
            }
            const nextRevision = currentRevision + 1;
            if (simulation) {
                const state = simulationState(previousState, clan, clanRow.leaderId, previousState.memberIds || [], timestamp);
                state.warehouseRevision = nextRevision;
                write('UPDATE clan_simulation_clans SET updatedAt = ?, stateJson = ? WHERE clanId = ?', [timestamp, JSON.stringify(state), clan]);
            }
            const ledger = write(`INSERT INTO clan_warehouse_ledger
                (clanId, characterId, selfId, amount, operation, resolveKey, warehouseRevision, createdAt)
                VALUES (?, ?, ?, ?, 'withdraw', ?, ?, ?)`, [clan, character, selfId, requested, key, nextRevision, timestamp]);
            return {
                inventoryId, inventoryAmount, warehouseAmount, enchant: sourceEnchant,
                petData: source.petData, warehouseRevision: nextRevision, ledgerId: Number(ledger.insertId)
            };
        }, 'clan-warehouse:player-withdraw'));
    },

    fetchCharacterQuests(characterId) { return select('character_quests', ['*'], 'characterId = ?', [characterId], 'quest:list'); },
    setCharacterQuest(characterId, questId, state, variables) { return run(UPSERT_CHARACTER_QUEST, [characterId, questId, state, JSON.stringify(variables || {})], 'quest:upsert'); },
    deleteCharacterQuest(characterId, questId) { return remove('character_quests', 'characterId = ? AND questId = ?', [characterId, questId], 'quest:delete'); },
    fetchCharacterRecipes(characterId) { return run('SELECT recipeId, type FROM character_recipes WHERE characterId = ?', [characterId], 'recipe:list'); },
    setCharacterRecipe(characterId, recipeId, type) { return run(UPSERT_RECIPE, [characterId, recipeId, type], 'recipe:upsert'); },

    craftInventoryItems(characterId, { materials, product, mp }) {
        return withCharacterFlush(characterId, () => inTransaction(() => {
            const sources = [];
            for (const material of [...materials].sort((left, right) => Number(left.id) - Number(right.id))) {
                const source = one('SELECT id, selfId, amount FROM items WHERE id = ? AND characterId = ?', [material.id, characterId]);
                if (!source || Number(source.selfId) !== Number(material.selfId) || Number(source.amount) < Number(material.amount)) throw new Error('craft material changed');
                sources.push({ id: Number(source.id), amount: Number(source.amount) - Number(material.amount) });
            }
            const target = product?.stackable ? one('SELECT id, amount FROM items WHERE characterId = ? AND selfId = ? ORDER BY id LIMIT 1', [characterId, product.selfId]) : null;
            let productId = Number(target?.id || 0);
            const productAmount = Number(target?.amount || 0) + Number(product?.amount || 0);
            sources.forEach((source) => source.amount <= 0 ? write('DELETE FROM items WHERE id = ? AND characterId = ?', [source.id, characterId]) : write('UPDATE items SET amount = ? WHERE id = ? AND characterId = ?', [source.amount, source.id, characterId]));
            if (target) write('UPDATE items SET amount = ? WHERE id = ? AND characterId = ?', [productAmount, productId, characterId]);
            else if (product) productId = write('INSERT INTO items (selfId, name, amount, equipped, slot, characterId) VALUES (?, ?, ?, 0, ?, ?)', [product.selfId, product.name || '', product.amount, product.slot || 0, characterId]).insertId;
            write('UPDATE characters SET mp = ? WHERE id = ?', [mp, characterId]);
            return { sources, product: product ? { id: productId, amount: productAmount } : null };
        }, 'craft:self'));
    },

    combineInventoryItems(characterId, { ingredients, product }) {
        return withCharacterFlush(characterId, () => inTransaction(() => {
            const required = new Map();
            (ingredients || []).forEach((ingredient) => {
                const selfId = Number(ingredient.selfId || 0);
                const amount = Number(ingredient.amount || 0);
                if (selfId > 0 && amount > 0) required.set(selfId, Number(required.get(selfId) || 0) + amount);
            });
            if (!required.size || !Number(product?.selfId || 0)) throw new Error('invalid item combination');

            const sources = [];
            for (const [selfId, amount] of required) {
                const rows = all(`SELECT id, selfId, amount, equipped, slot
                    FROM items
                    WHERE characterId = ? AND selfId = ? AND amount > 0
                    ORDER BY equipped ASC, id`, [characterId, selfId]);
                if (rows.reduce((sum, row) => sum + Number(row.amount || 0), 0) < amount) {
                    throw new Error('combination ingredient changed');
                }
                let remaining = amount;
                for (const row of rows) {
                    if (remaining <= 0) break;
                    const consumed = Math.min(remaining, Number(row.amount || 0));
                    sources.push({
                        id: Number(row.id),
                        selfId,
                        amount: consumed,
                        remaining: Number(row.amount || 0) - consumed
                    });
                    remaining -= consumed;
                }
            }

            sources.forEach((source) => source.remaining <= 0
                ? write('DELETE FROM items WHERE id = ? AND characterId = ?', [source.id, characterId])
                : write('UPDATE items SET amount = ? WHERE id = ? AND characterId = ?', [source.remaining, source.id, characterId]));
            const productId = write(`INSERT INTO items (selfId, name, amount, equipped, slot, characterId)
                VALUES (?, ?, ?, 0, ?, ?)`, [
                Number(product.selfId),
                product.name || '',
                Math.max(1, Number(product.amount || 1)),
                Number(product.slot || 0),
                characterId
            ]).insertId;
            return {
                sources,
                product: { id: Number(productId), selfId: Number(product.selfId), amount: Math.max(1, Number(product.amount || 1)) }
            };
        }, 'item:combine'));
    },

    crystallizeInventoryItem(characterId, { sourceId, sourceSelfId, crystalId, crystalName, crystalAmount }) {
        return withCharacterFlush(characterId, () => inTransaction(() => {
            const source = one('SELECT id, selfId, amount, equipped FROM items WHERE id = ? AND characterId = ?', [sourceId, characterId]);
            if (!source || Number(source.selfId) !== Number(sourceSelfId) || Number(source.amount) !== 1 || Number(source.equipped) !== 0) throw new Error('crystallize source changed');
            const target = one('SELECT id, amount FROM items WHERE characterId = ? AND selfId = ? ORDER BY id LIMIT 1', [characterId, crystalId]);
            const amount = Number(target?.amount || 0) + Number(crystalAmount);
            let id = Number(target?.id || 0);
            write('DELETE FROM items WHERE id = ? AND characterId = ?', [sourceId, characterId]);
            if (target) write('UPDATE items SET amount = ? WHERE id = ? AND characterId = ?', [amount, id, characterId]);
            else id = write('INSERT INTO items (selfId, name, amount, equipped, slot, characterId) VALUES (?, ?, ?, 0, 0, ?)', [crystalId, crystalName || '', crystalAmount, characterId]).insertId;
            return { crystalId, id, amount };
        }, 'crystalize'));
    },

    enchantInventoryItem(characterId, {
        scrollId,
        scrollSelfId,
        targetId,
        targetSelfId,
        expectedEnchant,
        result,
        enchantLevel,
        crystalId,
        crystalName,
        crystalAmount
    }) {
        return withCharacterFlush(characterId, () => inTransaction(() => {
            const normalizedEnchantLevel = Math.max(0, Number(enchantLevel) || 0);
            const scroll = one('SELECT id, selfId, amount FROM items WHERE id = ? AND characterId = ?', [scrollId, characterId]);
            if (!scroll || Number(scroll.selfId) !== Number(scrollSelfId) || Number(scroll.amount) < 1) {
                throw new Error('enchant scroll changed');
            }

            const target = one('SELECT id, selfId, amount, enchant, equipped, slot FROM items WHERE id = ? AND characterId = ?', [targetId, characterId]);
            if (!target || Number(target.selfId) !== Number(targetSelfId) || Number(target.amount) !== 1
                || Number(target.enchant || 0) !== Number(expectedEnchant || 0)) {
                throw new Error('enchant target changed');
            }

            const remainingScrolls = Number(scroll.amount) - 1;
            if (remainingScrolls > 0) {
                write('UPDATE items SET amount = ? WHERE id = ? AND characterId = ?', [remainingScrolls, scrollId, characterId]);
            } else {
                write('DELETE FROM items WHERE id = ? AND characterId = ?', [scrollId, characterId]);
            }

            if (result === 'success' || result === 'blessed-fail') {
                write('UPDATE items SET enchant = ? WHERE id = ? AND characterId = ?', [normalizedEnchantLevel, targetId, characterId]);
                return { result, scrollId: Number(scrollId), scrollAmount: remainingScrolls, targetId: Number(targetId), enchant: normalizedEnchantLevel };
            }

            if (result !== 'break') throw new Error('invalid enchant result');

            write('DELETE FROM items WHERE id = ? AND characterId = ?', [targetId, characterId]);
            const crystal = one('SELECT id, amount FROM items WHERE characterId = ? AND selfId = ? ORDER BY id LIMIT 1', [characterId, crystalId]);
            const amount = Number(crystal?.amount || 0) + Number(crystalAmount || 0);
            let crystalItemId = Number(crystal?.id || 0);
            if (crystal) {
                write('UPDATE items SET amount = ? WHERE id = ? AND characterId = ?', [amount, crystalItemId, characterId]);
            } else {
                crystalItemId = write('INSERT INTO items (selfId, name, amount, enchant, equipped, slot, characterId) VALUES (?, ?, ?, 0, 0, 0, ?)', [crystalId, crystalName || `Crystal ${crystalId}`, crystalAmount, characterId]).insertId;
            }
            return {
                result,
                scrollId: Number(scrollId),
                scrollAmount: remainingScrolls,
                targetId: Number(targetId),
                crystalId: Number(crystalId),
                crystalItemId,
                crystalAmount: Number(crystalAmount || 0),
                crystalTotal: amount,
                targetEquipped: !!target.equipped,
                targetSlot: Number(target.slot || 0)
            };
        }, 'item:enchant'));
    },

    enchantColdInventoryItems(characterId, operations = []) {
        const batch = Array.isArray(operations) ? operations.slice(0, 64) : [];
        if (!batch.length) return Promise.resolve({ operations: [] });
        return withCharacterFlush(characterId, () => inTransaction(() => {
            const completed = [];
            for (const operation of batch) {
                const scrollId = Number(operation.scrollId || 0);
                const scrollSelfId = Number(operation.scrollSelfId || 0);
                const targetId = Number(operation.targetId || 0);
                const targetSelfId = Number(operation.targetSelfId || 0);
                const expectedEnchant = Math.max(0, Number(operation.expectedEnchant || 0));
                const enchantLevel = Math.max(0, Number(operation.enchantLevel || 0));
                if (!scrollId || !scrollSelfId || !targetId || !targetSelfId
                    || enchantLevel !== expectedEnchant + 1) throw new Error('invalid cold safe enchant operation');

                const scroll = one('SELECT id, selfId, amount FROM items WHERE id = ? AND characterId = ?', [scrollId, characterId]);
                if (!scroll || Number(scroll.selfId) !== scrollSelfId || Number(scroll.amount) < 1) {
                    throw new Error('cold enchant scroll changed');
                }
                const target = one(`SELECT id, selfId, amount, enchant, equipped
                    FROM items WHERE id = ? AND characterId = ?`, [targetId, characterId]);
                if (!target || Number(target.selfId) !== targetSelfId || Number(target.amount) !== 1
                    || Number(target.equipped) !== 1 || Number(target.enchant || 0) !== expectedEnchant) {
                    throw new Error('cold enchant target changed');
                }

                const remainingScrolls = Number(scroll.amount) - 1;
                if (remainingScrolls > 0) {
                    write('UPDATE items SET amount = ? WHERE id = ? AND characterId = ?', [remainingScrolls, scrollId, characterId]);
                } else {
                    write('DELETE FROM items WHERE id = ? AND characterId = ?', [scrollId, characterId]);
                }
                write('UPDATE items SET enchant = ? WHERE id = ? AND characterId = ?', [enchantLevel, targetId, characterId]);
                completed.push({
                    scrollId,
                    scrollSelfId,
                    targetId,
                    targetSelfId,
                    expectedEnchant,
                    enchantLevel,
                    scrollAmount: remainingScrolls
                });
            }
            return { operations: completed };
        }, 'item:cold-safe-enchant'));
    },

    craftForCustomer(crafterId, customerId, { materials, product, crafterMp, price, adena }) {
        return withCharacterFlushes([crafterId, customerId], () => inTransaction(() => {
            const sources = [];
            for (const material of [...materials].sort((left, right) => Number(left.id) - Number(right.id))) {
                const source = one('SELECT id, selfId, amount FROM items WHERE id = ? AND characterId = ?', [material.id, customerId]);
                if (!source || Number(source.selfId) !== Number(material.selfId) || Number(source.amount) < Number(material.amount)) throw new Error('customer craft material changed');
                sources.push({ id: Number(source.id), amount: Number(source.amount) - Number(material.amount) });
            }
            const fee = Number(price) || 0;
            const customerAdena = fee > 0 ? one('SELECT id, amount FROM items WHERE characterId = ? AND selfId = 57 ORDER BY id LIMIT 1', [customerId]) : null;
            if (fee > 0 && (!customerAdena || Number(customerAdena.amount) < fee)) throw new Error('customer adena changed');
            let crafterAdena = fee > 0 ? one('SELECT id, amount FROM items WHERE characterId = ? AND selfId = 57 ORDER BY id LIMIT 1', [crafterId]) : null;
            const target = product?.stackable ? one('SELECT id, amount FROM items WHERE characterId = ? AND selfId = ? ORDER BY id LIMIT 1', [customerId, product.selfId]) : null;
            let productId = Number(target?.id || 0);
            const productAmount = Number(target?.amount || 0) + Number(product?.amount || 0);
            sources.forEach((source) => source.amount <= 0 ? write('DELETE FROM items WHERE id = ? AND characterId = ?', [source.id, customerId]) : write('UPDATE items SET amount = ? WHERE id = ? AND characterId = ?', [source.amount, source.id, customerId]));
            if (target) write('UPDATE items SET amount = ? WHERE id = ? AND characterId = ?', [productAmount, productId, customerId]);
            else if (product) productId = write('INSERT INTO items (selfId, name, amount, equipped, slot, characterId) VALUES (?, ?, ?, 0, ?, ?)', [product.selfId, product.name || '', product.amount, product.slot || 0, customerId]).insertId;
            let nextCrafterAdena = null;
            if (fee > 0) {
                write('UPDATE items SET amount = ? WHERE id = ? AND characterId = ?', [Number(customerAdena.amount) - fee, customerAdena.id, customerId]);
                if (crafterAdena) {
                    nextCrafterAdena = Number(crafterAdena.amount) + fee;
                    write('UPDATE items SET amount = ? WHERE id = ? AND characterId = ?', [nextCrafterAdena, crafterAdena.id, crafterId]);
                } else {
                    const id = write('INSERT INTO items (selfId, name, amount, equipped, slot, characterId) VALUES (57, ?, ?, 0, 0, ?)', [adena?.name || 'Adena', fee, crafterId]).insertId;
                    nextCrafterAdena = fee;
                    crafterAdena = { id, amount: 0 };
                }
            }
            write('UPDATE characters SET mp = ? WHERE id = ?', [crafterMp, crafterId]);
            return { sources, product: product ? { id: productId, amount: productAmount } : null, customerAdena: fee > 0 ? { id: Number(customerAdena.id), amount: Number(customerAdena.amount) - fee } : null, crafterAdena: fee > 0 ? { id: Number(crafterAdena.id), amount: nextCrafterAdena } : null };
        }, 'craft:customer'));
    },

    updateItemPetData(characterId, id, petData) { return withCharacterFlush(characterId, () => update('items', { petData: JSON.stringify(petData || {}) }, 'id = ? AND characterId = ?', [id, characterId], 'item:pet')); },
    fetchClans() { return select('clans', ['*'], '', [], 'clan:list'); },
    fetchClanSimulationClans() {
        return select('clan_simulation_clans', ['*'], '', [], 'clan-simulation:list')
            .then((rows) => rows.map((row) => ({
                ...row,
                state: jsonObject(row.stateJson)
            })));
    },
    syncPlayerManagedClan(clanId) {
        return inTransaction(() => syncPlayerManagedClanUnsafe(clanId), 'clan-simulation:player-managed-sync');
    },
    ensurePlayerManagedClans(limit = 500) {
        const safeLimit = Math.max(1, Math.min(2000, Math.floor(Number(limit) || 500)));
        return run(`SELECT clans.id
            FROM clans
            LEFT JOIN clan_simulation_clans simulated ON simulated.clanId = clans.id
            WHERE simulated.mode = 'player_managed'
               OR (simulated.clanId IS NULL AND EXISTS (
                    SELECT 1
                    FROM characters c
                    LEFT JOIN bot_life_state life ON life.characterId = c.id
                    WHERE c.clanId = clans.id AND ${GENERATED_BOT_FILTER}
               ))
            ORDER BY clans.id ASC
            LIMIT ${safeLimit}`, [], 'clan-simulation:player-managed-candidates').then(async (rows) => {
            const summary = { attempted: rows.length, created: 0, changed: 0, disabled: 0 };
            for (const row of rows) {
                const result = await inTransaction(
                    () => syncPlayerManagedClanUnsafe(row.id),
                    'clan-simulation:player-managed-sync'
                );
                if (result.created) summary.created += 1;
                if (result.changed) summary.changed += 1;
                if (result.disabled) summary.disabled += 1;
            }
            return summary;
        });
    },
    fetchPlayerManagedClanOrderDeliveries({ clanId, orderId, itemId } = {}) {
        const clan = Number(clanId);
        const order = Number(orderId);
        const item = Number(itemId);
        if (!clan || !order || !item) return Promise.resolve([]);
        return run(`SELECT ledger.id, ledger.characterId, characters.name AS characterName,
                           ledger.selfId, ledger.amount, ledger.resolveKey, ledger.createdAt
                    FROM clan_warehouse_ledger ledger
                    LEFT JOIN characters ON characters.id = ledger.characterId
                    WHERE ledger.clanId = ? AND ledger.selfId = ? AND ledger.operation = 'withdraw'
                      AND ledger.resolveKey LIKE ?
                    ORDER BY ledger.id ASC`, [clan, item, `player-order:${order}:delivery:%`], 'clan-order:deliveries');
    },
    fetchPlayerManagedClanOrders({ clanId, status = null, limit = 20 } = {}) {
        const clan = Number(clanId);
        const safeLimit = Math.max(1, Math.min(100, Math.floor(Number(limit) || 20)));
        if (!clan) return Promise.resolve([]);
        const statuses = Array.isArray(status) ? status.map(String).filter(Boolean) : status ? [String(status)] : [];
        const placeholders = statuses.map(() => '?').join(', ');
        return run(`SELECT * FROM clan_orders WHERE clanId = ?${statuses.length ? ` AND status IN (${placeholders})` : ''}
            ORDER BY updatedAt DESC, id DESC LIMIT ${safeLimit}`, [clan, ...statuses], 'clan-order:list')
            .then((rows) => rows.map(playerManagedOrderRow));
    },
    createPlayerManagedClanOrder({
        clanId,
        kind = 'gather_item',
        itemId,
        itemName = '',
        amount,
        strategy = 'auto',
        maxUnitPrice = 0,
        budget = 0,
        memberIds = [],
        goal = null,
        actionType = null
    } = {}) {
        const clan = Number(clanId);
        const item = Number(itemId);
        const required = Math.floor(Number(amount) || 0);
        const normalizedMembers = [...new Set((memberIds || []).map(Number).filter(Boolean))].sort((left, right) => left - right);
        if (!clan || !item || required <= 0 || String(kind) !== 'gather_item') {
            return Promise.resolve({ ok: false, code: 'invalid_clan_order' });
        }
        return inTransaction(() => {
            const simulation = one(`SELECT simulated.stateJson, simulated.mode, clans.leaderId
                FROM clan_simulation_clans simulated
                JOIN clans ON clans.id = simulated.clanId
                WHERE simulated.clanId = ?`, [clan]);
            if (!simulation || String(simulation.mode) !== 'player_managed') {
                return { ok: false, code: 'target_not_player_managed' };
            }
            if (normalizedMembers.length) {
                const placeholders = normalizedMembers.map(() => '?').join(', ');
                const members = all(`SELECT c.id, c.clanId, c.username, life.accountName, life.statsJson
                    FROM characters c
                    LEFT JOIN bot_life_state life ON life.characterId = c.id
                    WHERE c.id IN (${placeholders})`, normalizedMembers);
                if (members.length !== normalizedMembers.length || members.some((member) => (
                    Number(member.clanId) !== clan || !generatedBotRow(member)
                ))) return { ok: false, code: 'invalid_clan_order_members' };
            }

            const timestamp = now();
            cancelPlayerManagedClanWorkUnsafe(clan, 'player_order_replaced', timestamp);
            write(`UPDATE clan_orders SET status = 'cancelled', reasonCode = 'player_order_replaced',
                    updatedAt = ?, resolvedAt = ?
                WHERE clanId = ? AND status IN ('active', 'paused', 'blocked')`, [timestamp, timestamp, clan]);
            const latest = one('SELECT MAX(revision) AS revision FROM clan_orders WHERE clanId = ?', [clan]);
            const revision = Math.max(1, Number(latest?.revision || 0) + 1);
            const orderStatus = goal?.status === 'completed' ? 'completed' : goal?.status === 'blocked' ? 'blocked' : 'active';
            const inserted = write(`INSERT INTO clan_orders
                (clanId, revision, kind, status, itemId, itemName, amount, strategy,
                 maxUnitPrice, budget, spent, memberIdsJson, planJson, reasonCode, createdAt, updatedAt, resolvedAt)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`, [
                clan, revision, String(kind), orderStatus, item, String(itemName), required, String(strategy),
                Math.max(0, Math.floor(Number(maxUnitPrice) || 0)), Math.max(0, Math.floor(Number(budget) || 0)),
                JSON.stringify(normalizedMembers), JSON.stringify(goal?.plan || {}), String(goal?.plan?.reasonCode || ''),
                timestamp, timestamp, orderStatus === 'completed' ? timestamp : null
            ]);
            const orderId = Number(inserted.insertId);
            const previousState = jsonObject(simulation.stateJson);
            const nextGoal = goal ? { ...goal, orderId, orderRevision: revision, controlledBy: 'player', updatedAt: timestamp } : null;
            const state = simulationState(previousState, clan, simulation.leaderId, previousState.memberIds || [], timestamp);
            state.goal = nextGoal;
            state.updatedAt = timestamp;
            write('UPDATE clan_simulation_clans SET updatedAt = ?, stateJson = ? WHERE clanId = ?', [timestamp, JSON.stringify(state), clan]);
            if (actionType && orderStatus === 'active') {
                write(`INSERT INTO clan_actions
                    (clanId, actionKey, actionType, priority, status, attempt, availableAt,
                     payloadJson, resultJson, reasonCode, createdAt, updatedAt)
                    VALUES (?, ?, ?, 100, 'pending', 0, ?, ?, '{}', 'player_order_created', ?, ?)`, [
                    clan, `clan:${clan}:order:${orderId}:r${revision}:${String(actionType)}`, String(actionType), timestamp,
                    JSON.stringify({ orderId, orderRevision: revision, reason: 'player_order_created' }), timestamp, timestamp
                ]);
            }
            write(`INSERT INTO clan_goal_events
                (clanId, eventType, goalType, plan, reasonCode, payloadJson, occurredAt)
                VALUES (?, 'player_order_created', 'item', ?, ?, ?, ?)`, [
                clan, String(nextGoal?.plan?.kind || ''), String(nextGoal?.plan?.reasonCode || ''),
                JSON.stringify({ orderId, revision, itemId: item, itemName: String(itemName), amount: required, strategy: String(strategy) }), timestamp
            ]);
            return {
                ok: true,
                order: playerManagedOrderRow(one('SELECT * FROM clan_orders WHERE id = ?', [orderId])),
                goal: nextGoal
            };
        }, 'clan-order:create');
    },
    transitionPlayerManagedClanOrder({
        clanId,
        orderId,
        expectedRevision = null,
        transition,
        goal = null,
        actionType = null,
        reasonCode = ''
    } = {}) {
        const clan = Number(clanId);
        const id = Number(orderId);
        const action = String(transition || '');
        if (!clan || !id || !['pause', 'resume', 'replan', 'cancel'].includes(action)) {
            return Promise.resolve({ ok: false, code: 'invalid_clan_order_transition' });
        }
        return inTransaction(() => {
            const simulation = one(`SELECT simulated.stateJson, simulated.mode, clans.leaderId
                FROM clan_simulation_clans simulated
                JOIN clans ON clans.id = simulated.clanId
                WHERE simulated.clanId = ?`, [clan]);
            const order = one('SELECT * FROM clan_orders WHERE id = ? AND clanId = ?', [id, clan]);
            if (!simulation || String(simulation.mode) !== 'player_managed') return { ok: false, code: 'target_not_player_managed' };
            if (!order || !['active', 'paused', 'blocked'].includes(String(order.status))) return { ok: false, code: 'clan_order_not_active' };
            if (expectedRevision !== null && Number(order.revision) !== Number(expectedRevision)) {
                return { ok: false, code: 'clan_order_revision_conflict', revision: Number(order.revision) };
            }
            if (action === 'pause' && String(order.status) === 'paused') {
                return { ok: true, idempotent: true, order: playerManagedOrderRow(order) };
            }
            const timestamp = now();
            cancelPlayerManagedClanWorkUnsafe(clan, `player_order_${action}`, timestamp);
            const revision = Number(order.revision) + 1;
            const previousState = jsonObject(simulation.stateJson);
            const state = simulationState(previousState, clan, simulation.leaderId, previousState.memberIds || [], timestamp);
            let status;
            let nextGoal;
            if (action === 'cancel') {
                status = 'cancelled';
                nextGoal = null;
            } else if (action === 'pause') {
                status = 'paused';
                nextGoal = { ...(previousState.goal || goal || {}), status: 'paused', orderId: id, orderRevision: revision, updatedAt: timestamp };
            } else {
                nextGoal = { ...(goal || previousState.goal || {}), orderId: id, orderRevision: revision, controlledBy: 'player', updatedAt: timestamp };
                status = nextGoal.status === 'completed' ? 'completed' : nextGoal.status === 'blocked' ? 'blocked' : 'active';
            }
            state.goal = nextGoal;
            state.updatedAt = timestamp;
            write('UPDATE clan_simulation_clans SET updatedAt = ?, stateJson = ? WHERE clanId = ?', [timestamp, JSON.stringify(state), clan]);
            write(`UPDATE clan_orders SET revision = ?, status = ?, planJson = ?, reasonCode = ?,
                    updatedAt = ?, resolvedAt = ? WHERE id = ? AND clanId = ?`, [
                revision, status, JSON.stringify(nextGoal?.plan || {}), String(reasonCode || nextGoal?.plan?.reasonCode || ''),
                timestamp, ['completed', 'cancelled'].includes(status) ? timestamp : null, id, clan
            ]);
            if (actionType && status === 'active') {
                write(`INSERT INTO clan_actions
                    (clanId, actionKey, actionType, priority, status, attempt, availableAt,
                     payloadJson, resultJson, reasonCode, createdAt, updatedAt)
                    VALUES (?, ?, ?, 100, 'pending', 0, ?, ?, '{}', ?, ?, ?)`, [
                    clan, `clan:${clan}:order:${id}:r${revision}:${String(actionType)}`, String(actionType), timestamp,
                    JSON.stringify({ orderId: id, orderRevision: revision, reason: `player_order_${action}` }),
                    `player_order_${action}`, timestamp, timestamp
                ]);
            }
            write(`INSERT INTO clan_goal_events
                (clanId, eventType, goalType, plan, reasonCode, payloadJson, occurredAt)
                VALUES (?, ?, 'item', ?, ?, ?, ?)`, [
                clan, `player_order_${action}`, String(nextGoal?.plan?.kind || ''), String(reasonCode || `player_order_${action}`),
                JSON.stringify({ orderId: id, revision, status }), timestamp
            ]);
            return { ok: true, order: playerManagedOrderRow(one('SELECT * FROM clan_orders WHERE id = ?', [id])), goal: nextGoal };
        }, `clan-order:${action}`);
    },
    updatePlayerManagedClanOrderProgress({ clanId, orderId, goal, spentDelta = 0, reasonCode = '' } = {}) {
        const clan = Number(clanId);
        const id = Number(orderId);
        if (!clan || !id || !goal) return Promise.resolve({ ok: false, code: 'invalid_clan_order' });
        return inTransaction(() => {
            const simulation = one(`SELECT simulated.stateJson, simulated.mode, clans.leaderId
                FROM clan_simulation_clans simulated
                JOIN clans ON clans.id = simulated.clanId
                WHERE simulated.clanId = ?`, [clan]);
            const order = one('SELECT * FROM clan_orders WHERE id = ? AND clanId = ?', [id, clan]);
            if (!simulation || String(simulation.mode) !== 'player_managed') return { ok: false, code: 'target_not_player_managed' };
            if (!order || !['active', 'blocked'].includes(String(order.status))) return { ok: false, code: 'clan_order_not_active' };
            const timestamp = now();
            const revision = Number(order.revision) + 1;
            const nextGoal = { ...goal, orderId: id, orderRevision: revision, controlledBy: 'player', updatedAt: timestamp };
            const completed = nextGoal.status === 'completed';
            const previousState = jsonObject(simulation.stateJson);
            const state = simulationState(previousState, clan, simulation.leaderId, previousState.memberIds || [], timestamp);
            state.goal = nextGoal;
            state.updatedAt = timestamp;
            write('UPDATE clan_simulation_clans SET updatedAt = ?, stateJson = ? WHERE clanId = ?', [timestamp, JSON.stringify(state), clan]);
            write(`UPDATE clan_orders SET revision = ?, status = ?, spent = spent + ?, planJson = ?, reasonCode = ?,
                    updatedAt = ?, resolvedAt = ? WHERE id = ? AND clanId = ?`, [
                revision, completed ? 'completed' : nextGoal.status === 'blocked' ? 'blocked' : 'active',
                Math.max(0, Math.floor(Number(spentDelta) || 0)), JSON.stringify(nextGoal.plan || {}), String(reasonCode || ''),
                timestamp, completed ? timestamp : null, id, clan
            ]);
            if (completed) {
                write(`UPDATE clan_actions SET status = 'cancelled', reasonCode = 'player_order_completed',
                        updatedAt = ?, resolvedAt = ?
                    WHERE clanId = ? AND status = 'pending'`, [timestamp, timestamp, clan]);
                write(`UPDATE clan_market_demands SET status = 'fulfilled', updatedAt = ?
                    WHERE clanId = ? AND status = 'open'`, [timestamp, clan]);
            }
            if (completed || reasonCode) {
                write(`INSERT INTO clan_goal_events
                    (clanId, eventType, goalType, plan, reasonCode, payloadJson, occurredAt)
                    VALUES (?, ?, 'item', ?, ?, ?, ?)`, [
                    clan, completed ? 'player_order_completed' : 'player_order_progress', String(nextGoal.plan?.kind || ''),
                    String(reasonCode || (completed ? 'goal_completed' : 'goal_progress')),
                    JSON.stringify({ orderId: id, revision, progress: Number(nextGoal.progress), required: Number(nextGoal.required) }), timestamp
                ]);
            }
            return { ok: true, order: playerManagedOrderRow(one('SELECT * FROM clan_orders WHERE id = ?', [id])), goal: nextGoal };
        }, 'clan-order:progress');
    },
    enqueueClanAction({
        clanId,
        actionKey,
        actionType,
        priority = 0,
        availableAt = null,
        payload = {}
    } = {}) {
        const clan = Number(clanId);
        const key = String(actionKey || '').trim();
        const type = String(actionType || '').trim();
        if (!clan || !key || !type) return Promise.resolve({ ok: false, code: 'invalid_clan_action' });
        return inTransaction(() => {
            const existing = one('SELECT * FROM clan_actions WHERE actionKey = ?', [key]);
            if (existing) {
                return {
                    ok: true,
                    created: false,
                    idempotent: true,
                    actionId: Number(existing.id),
                    action: existing
                };
            }
            if (!one('SELECT clanId FROM clan_simulation_clans WHERE clanId = ?', [clan])) {
                return { ok: false, code: 'target_not_autonomous' };
            }
            const timestamp = now();
            const dueAt = availableAt !== null && availableAt !== undefined && Number.isFinite(Number(availableAt))
                ? Math.max(0, Number(availableAt))
                : timestamp;
            const inserted = write(`INSERT INTO clan_actions
                (clanId, actionKey, actionType, priority, status, attempt, availableAt,
                 payloadJson, resultJson, reasonCode, createdAt, updatedAt)
                VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, '{}', '', ?, ?)`, [
                clan,
                key,
                type,
                Math.floor(Number(priority) || 0),
                dueAt,
                JSON.stringify(payload && typeof payload === 'object' ? payload : {}),
                timestamp,
                timestamp
            ]);
            const action = one('SELECT * FROM clan_actions WHERE id = ?', [Number(inserted.insertId)]);
            return { ok: true, created: true, actionId: Number(inserted.insertId), action };
        }, 'clan-action:enqueue');
    },
    claimClanActions({ limit = 8, at = null, leaseMs = 120000 } = {}) {
        // Compatibility wrapper intentionally admits a single action. Claiming a
        // batch before the caller has execution capacity strands the remainder
        // in `running` until their leases expire.
        void limit;
        return Database.claimClanAction({ at, leaseMs }).then((claim) => claim.action ? [claim.action] : []);
    },
    claimClanAction({ at = null, leaseMs = 120000 } = {}) {
        return inTransaction(() => {
            const timestamp = at !== null && at !== undefined && Number.isFinite(Number(at))
                ? Number(at)
                : now();
            const leaseUntil = timestamp + Math.max(1000, Math.floor(Number(leaseMs) || 120000));
            const recovery = write(`UPDATE clan_actions SET status = 'pending', leaseUntil = NULL, updatedAt = ?
                WHERE status = 'running' AND leaseUntil IS NOT NULL AND leaseUntil <= ?`, [timestamp, timestamp]);
            const pending = one(`SELECT * FROM clan_actions
                WHERE status = 'pending' AND availableAt <= ?
                ORDER BY priority DESC, availableAt ASC, id ASC LIMIT 1`, [timestamp]);
            if (!pending) {
                return {
                    action: null,
                    recovered: Number(recovery.affectedRows || 0)
                };
            }
            const updated = write(`UPDATE clan_actions
                SET status = 'running', attempt = attempt + 1, leaseUntil = ?, updatedAt = ?
                WHERE id = ? AND status = 'pending'`, [leaseUntil, timestamp, Number(pending.id)]);
            return {
                action: Number(updated.affectedRows || 0) === 1
                    ? one('SELECT * FROM clan_actions WHERE id = ?', [Number(pending.id)])
                    : null,
                recovered: Number(recovery.affectedRows || 0)
            };
        }, 'clan-action:claim-one');
    },
    releaseClanAction({ actionId, availableAt = null, expectedAttempt = null, expectedLeaseUntil = null } = {}) {
        const id = Number(actionId);
        if (!id) return Promise.resolve({ ok: false, code: 'invalid_clan_action' });
        return inTransaction(() => {
            const action = one('SELECT * FROM clan_actions WHERE id = ?', [id]);
            if (!action) return { ok: false, code: 'clan_action_missing' };
            if (String(action.status) === 'pending') {
                return { ok: true, idempotent: true, actionId: id, status: 'pending', action };
            }
            if (String(action.status) !== 'running') {
                return { ok: false, code: 'clan_action_not_running', actionId: id, status: String(action.status) };
            }
            const timestamp = now();
            const dueAt = availableAt !== null && availableAt !== undefined && Number.isFinite(Number(availableAt))
                ? Math.max(0, Number(availableAt))
                : Number(action.availableAt || timestamp);
            const expectedAttemptValue = expectedAttempt !== null && expectedAttempt !== undefined
                ? Number(expectedAttempt)
                : Number(action.attempt);
            const expectedLeaseValue = expectedLeaseUntil !== null && expectedLeaseUntil !== undefined
                ? Number(expectedLeaseUntil)
                : Number(action.leaseUntil);
            const updated = write(`UPDATE clan_actions
                SET status = 'pending', leaseUntil = NULL, availableAt = ?, updatedAt = ?
                WHERE id = ? AND status = 'running' AND attempt = ? AND leaseUntil = ?`, [
                dueAt, timestamp, id, expectedAttemptValue, expectedLeaseValue
            ]);
            if (Number(updated.affectedRows || 0) !== 1) return { ok: false, code: 'ownership_conflict', actionId: id };
            return {
                ok: true,
                actionId: id,
                status: 'pending',
                action: one('SELECT * FROM clan_actions WHERE id = ?', [id])
            };
        }, 'clan-action:release');
    },
    resolveClanAction({ actionId, status = 'succeeded', result = {}, reasonCode = '' } = {}) {
        const id = Number(actionId);
        const nextStatus = ['succeeded', 'failed', 'cancelled'].includes(String(status))
            ? String(status)
            : 'failed';
        if (!id) return Promise.resolve({ ok: false, code: 'invalid_clan_action' });
        return inTransaction(() => {
            const action = one('SELECT * FROM clan_actions WHERE id = ?', [id]);
            if (!action) return { ok: false, code: 'clan_action_missing' };
            if (['succeeded', 'failed', 'cancelled'].includes(String(action.status))) {
                return {
                    ok: true,
                    idempotent: true,
                    actionId: id,
                    status: String(action.status),
                    action
                };
            }
            const timestamp = now();
            const safeResult = compactClanActionResult(result);
            const updated = write(`UPDATE clan_actions
                SET status = ?, leaseUntil = NULL, resultJson = ?, reasonCode = ?, updatedAt = ?, resolvedAt = ?
                WHERE id = ? AND status IN ('pending', 'running')`, [
                nextStatus,
                JSON.stringify(safeResult),
                String(reasonCode || ''),
                timestamp,
                timestamp,
                id
            ]);
            if (Number(updated.affectedRows || 0) !== 1) return { ok: false, code: 'ownership_conflict' };
            write(`INSERT INTO clan_goal_events
                (clanId, eventType, goalType, plan, reasonCode, payloadJson, occurredAt)
                VALUES (?, ?, '', ?, ?, ?, ?)`, [
                Number(action.clanId),
                `action_${nextStatus}`,
                String(action.actionType || ''),
                String(reasonCode || ''),
                JSON.stringify({ actionId: id, actionKey: action.actionKey, result: safeResult }),
                timestamp
            ]);
            return {
                ok: true,
                actionId: id,
                status: nextStatus,
                action: one('SELECT * FROM clan_actions WHERE id = ?', [id])
            };
        }, 'clan-action:resolve');
    },
    fetchClanActions({ clanId = null, status = null, limit = 50 } = {}) {
        const clauses = [];
        const params = [];
        if (clanId !== null && clanId !== undefined) { clauses.push('clanId = ?'); params.push(Number(clanId)); }
        if (status !== null && status !== undefined) { clauses.push('status = ?'); params.push(String(status)); }
        const safeLimit = Math.max(1, Math.min(200, Math.floor(Number(limit) || 50)));
        return run(`SELECT * FROM clan_actions${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''}
            ORDER BY updatedAt DESC, id DESC LIMIT ${safeLimit}`, params, 'clan-action:list');
    },
    fetchClanActionQueueStats({ at = null } = {}) {
        const timestamp = at !== null && at !== undefined && Number.isFinite(Number(at))
            ? Number(at)
            : now();
        return run(`SELECT
                COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
                COALESCE(SUM(CASE WHEN status = 'pending' AND availableAt <= ? THEN 1 ELSE 0 END), 0) AS ready,
                COALESCE(SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END), 0) AS running,
                COALESCE(SUM(CASE WHEN status = 'running' AND leaseUntil IS NOT NULL AND leaseUntil <= ? THEN 1 ELSE 0 END), 0) AS expiredRunning,
                MIN(CASE WHEN status = 'pending' THEN createdAt END) AS oldestPendingAt,
                MIN(CASE WHEN status = 'pending' AND availableAt <= ? THEN createdAt END) AS oldestReadyAt,
                MIN(CASE WHEN status = 'running' THEN updatedAt END) AS oldestRunningAt,
                COALESCE(MAX(CASE WHEN status IN ('pending', 'running') THEN attempt ELSE 0 END), 0) AS maxAttempt
            FROM clan_actions`, [timestamp, timestamp, timestamp], 'clan-action:queue-stats').then((rows) => {
            const row = rows[0] || {};
            const oldestPendingAt = Number(row.oldestPendingAt || 0);
            const oldestReadyAt = Number(row.oldestReadyAt || 0);
            const oldestRunningAt = Number(row.oldestRunningAt || 0);
            return {
                pending: Number(row.pending || 0),
                ready: Number(row.ready || 0),
                running: Number(row.running || 0),
                expiredRunning: Number(row.expiredRunning || 0),
                oldestPendingAt,
                oldestPendingAgeMs: oldestPendingAt > 0 ? Math.max(0, timestamp - oldestPendingAt) : 0,
                oldestReadyAt,
                oldestReadyAgeMs: oldestReadyAt > 0 ? Math.max(0, timestamp - oldestReadyAt) : 0,
                oldestRunningAt,
                oldestRunningAgeMs: oldestRunningAt > 0 ? Math.max(0, timestamp - oldestRunningAt) : 0,
                maxAttempt: Number(row.maxAttempt || 0),
                observedAt: timestamp
            };
        });
    },
    fetchClansNeedingAction(limit = 64) {
        const safeLimit = Math.max(1, Math.min(500, Math.floor(Number(limit) || 64)));
        return run(`SELECT simulated.clanId, simulated.stateJson, simulated.updatedAt
            FROM clan_simulation_clans simulated
            WHERE (simulated.mode = 'autonomous' OR EXISTS (
                SELECT 1 FROM clan_orders orders
                WHERE orders.clanId = simulated.clanId AND orders.status IN ('active', 'blocked')
            )) AND NOT EXISTS (
                SELECT 1 FROM clan_actions actions
                WHERE actions.clanId = simulated.clanId
                  AND actions.status IN ('pending', 'running')
            )
            ORDER BY simulated.updatedAt ASC, simulated.clanId ASC
            LIMIT ${safeLimit}`, [], 'clan-action:bootstrap');
    },
    fetchAutonomousClansNeedingTitles(limit = 64) {
        const safeLimit = Math.max(1, Math.min(500, Math.floor(Number(limit) || 64)));
        return run(`SELECT simulated.clanId,
                           COUNT(members.id) AS memberCount,
                           SUM(CASE WHEN TRIM(COALESCE(members.title, '')) = '' THEN 1 ELSE 0 END) AS untitledCount,
                           COALESCE(SUM(members.id), 0) AS memberIdSum,
                           COALESCE(MAX(members.id), 0) AS maxMemberId
                    FROM clan_simulation_clans simulated
                    JOIN clans ON clans.id = simulated.clanId
                    JOIN characters members ON members.clanId = simulated.clanId
                    WHERE simulated.mode = 'autonomous' AND clans.level >= 3
                    GROUP BY simulated.clanId
                    HAVING untitledCount > 0
                    ORDER BY simulated.updatedAt ASC, simulated.clanId ASC
                    LIMIT ${safeLimit}`, [], 'clan-title:bootstrap');
    },
    isAutonomousClan(clanId) {
        return selectOne('clan_simulation_clans', ['clanId'], 'clanId = ? AND mode = ?', [Number(clanId), 'autonomous'], 'clan-simulation:membership')
            .then((rows) => !!rows[0]);
    },
    isAutonomousBotMember(characterId, clanId) {
        return executeReadAutonomousBotMember(characterId, clanId);
    },
    createAutonomousClan({
        name,
        leaderId,
        memberIds = [],
        stateJson = {},
        maxBotClans = 40,
        maxBotMemberShare = 0.70,
        founderQuorum = 5
    } = {}) {
        const uniqueMemberIds = [...new Set(memberIds.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))]
            .sort((left, right) => left - right);
        return inTransaction(() => {
            if (!String(name || '').trim() || !Number(leaderId) || uniqueMemberIds.length < Number(founderQuorum || 5)) {
                return { ok: false, code: 'founder_no_quorum' };
            }
            if (!uniqueMemberIds.includes(Number(leaderId))) {
                return { ok: false, code: 'founder_no_quorum' };
            }

            const autonomousCount = Number(one("SELECT COUNT(*) AS count FROM clan_simulation_clans WHERE mode = 'autonomous'").count || 0);
            if (autonomousCount >= Math.max(0, Number(maxBotClans) || 0)) {
                return { ok: false, code: 'founder_clan_limit' };
            }

            const placeholders = uniqueMemberIds.map(() => '?').join(', ');
            const members = all(`SELECT c.id, c.username, c.clanId, life.accountName, life.statsJson
                FROM characters c
                LEFT JOIN bot_life_state life ON life.characterId = c.id
                WHERE c.id IN (${placeholders})`, uniqueMemberIds);
            if (members.length !== uniqueMemberIds.length) {
                return { ok: false, code: 'founder_no_quorum' };
            }
            if (members.some((member) => Number(member.clanId) !== 0 || !generatedBotRow(member))) {
                return { ok: false, code: 'founder_population_limit' };
            }

            const population = botPopulationUnsafe();
            const maxMembers = Math.floor(Math.max(0, Number(population.population) || 0) * Math.max(0, Math.min(1, Number(maxBotMemberShare) || 0)));
            const nextBotMembers = Number(population.botMembers) + uniqueMemberIds.length;
            if (nextBotMembers > maxMembers) {
                return { ok: false, code: 'founder_population_limit', population: Number(population.population), maxBotMembers: maxMembers };
            }

            const inserted = write('INSERT INTO clans (name, leaderId) VALUES (?, ?)', [String(name).trim(), Number(leaderId)]);
            const clanId = Number(inserted.insertId);
            const update = write(`UPDATE characters
                SET clanId = ?,
                    clanPrivileges = CASE WHEN id = ? THEN 2047 ELSE 0 END,
                    clanJoinExpiryTime = 0,
                    clanCreateExpiryTime = 0
                WHERE id IN (${placeholders}) AND clanId = 0`, [clanId, Number(leaderId), ...uniqueMemberIds]);
            if (update.affectedRows !== uniqueMemberIds.length) throw new Error('autonomous clan member reservation changed');

            const timestamp = now();
            const state = simulationState(stateJson, clanId, leaderId, uniqueMemberIds, timestamp);
            write(`INSERT INTO clan_simulation_clans (clanId, version, mode, createdAt, updatedAt, stateJson)
                VALUES (?, ?, 'autonomous', ?, ?, ?)`, [clanId, 1, timestamp, timestamp, JSON.stringify(state)]);
            write(`INSERT INTO clan_actions
                (clanId, actionKey, actionType, priority, status, attempt, availableAt,
                 payloadJson, resultJson, reasonCode, createdAt, updatedAt)
                VALUES (?, ?, 'goal_plan', 100, 'pending', 0, ?, ?, '{}', 'clan_created', ?, ?)`, [
                clanId,
                `clan:${clanId}:bootstrap:${timestamp}`,
                timestamp,
                JSON.stringify({ reason: 'clan_created', clanId }),
                timestamp,
                timestamp
            ]);
            return {
                ok: true,
                clanId,
                memberIds: uniqueMemberIds,
                population: Number(population.population) || 0,
                botMembers: nextBotMembers,
                maxBotMembers: maxMembers
            };
        }, 'clan-simulation:create').catch((error) => {
            if (/UNIQUE constraint failed: clans\.name/i.test(String(error.message || ''))) {
                return { ok: false, code: 'name_exists' };
            }
            throw error;
        });
    },
    joinAutonomousClan({
        clanId,
        characterId,
        memberLimit = 10,
        maxBotMemberShare = 0.70
    } = {}) {
        const id = Number(characterId);
        const targetClanId = Number(clanId);
        return inTransaction(() => {
            const simulation = one("SELECT clanId, stateJson FROM clan_simulation_clans WHERE clanId = ? AND mode = 'autonomous'", [targetClanId]);
            if (!simulation) return { ok: false, code: 'target_not_autonomous' };

            const memberCount = Number(one('SELECT COUNT(*) AS count FROM characters WHERE clanId = ?', [targetClanId]).count || 0);
            if (memberCount >= Math.max(1, Number(memberLimit) || 10)) {
                return { ok: false, code: 'join_clan_full' };
            }

            const candidate = one(`SELECT c.id, c.username, c.clanId, life.accountName, life.statsJson
                FROM characters c
                LEFT JOIN bot_life_state life ON life.characterId = c.id
                WHERE c.id = ?`, [id]);
            if (!candidate || Number(candidate.clanId) !== 0) return { ok: false, code: 'target_has_clan' };
            if (!generatedBotRow(candidate)) return { ok: false, code: 'join_static_service_conflict' };

            const population = botPopulationUnsafe();
            const maxMembers = Math.floor(Math.max(0, Number(population.population) || 0) * Math.max(0, Math.min(1, Number(maxBotMemberShare) || 0)));
            const nextBotMembers = Number(population.botMembers) + 1;
            if (nextBotMembers > maxMembers) {
                return { ok: false, code: 'join_population_limit', population: Number(population.population), maxBotMembers: maxMembers };
            }

            const updated = write('UPDATE characters SET clanId = ?, clanPrivileges = 0, clanJoinExpiryTime = 0 WHERE id = ? AND clanId = 0', [targetClanId, id]);
            if (updated.affectedRows !== 1) return { ok: false, code: 'target_has_clan' };

            const timestamp = now();
            const previousState = jsonObject(simulation.stateJson);
            const state = simulationState(simulation.stateJson, targetClanId, previousState.leaderId, previousState.memberIds || [], timestamp);
            state.memberIds = [...new Set([...state.memberIds, id])].sort((left, right) => left - right);
            write('UPDATE clan_simulation_clans SET updatedAt = ?, stateJson = ? WHERE clanId = ?', [timestamp, JSON.stringify(state), targetClanId]);
            return {
                ok: true,
                clanId: targetClanId,
                characterId: id,
                population: Number(population.population) || 0,
                botMembers: nextBotMembers,
                maxBotMembers: maxMembers
            };
        }, 'clan-simulation:join');
    },
    fetchClanContributionSummary(clanId, targetLevel = null) {
        const params = [Number(clanId)];
        const levelClause = targetLevel === null || targetLevel === undefined ? '' : ' AND targetLevel = ?';
        if (levelClause) params.push(Number(targetLevel));
        return run(`SELECT clanId, targetLevel, COUNT(*) AS entries, COALESCE(SUM(amount), 0) AS amount
            FROM clan_contributions WHERE clanId = ?${levelClause}
            GROUP BY clanId, targetLevel ORDER BY targetLevel`, params, 'clan-simulation:contributions')
            .then((rows) => rows.map((row) => ({
                clanId: Number(row.clanId),
                targetLevel: Number(row.targetLevel),
                entries: Number(row.entries),
                amount: Number(row.amount)
            })));
    },
    transferClanAdena({
        clanId,
        characterId,
        leaderId,
        targetLevel = 0,
        amount,
        reserve = 0,
        maxContributionFraction = 0.35,
        resolveKey,
        source = 'adena'
    } = {}) {
        const clan = Number(clanId);
        const contributor = Number(characterId);
        const leader = Number(leaderId);
        const requested = Math.floor(Number(amount) || 0);
        const key = String(resolveKey || '').trim();
        if (!clan || !contributor || !leader || contributor === leader || requested <= 0 || !key) {
            return Promise.resolve({ ok: false, code: 'contribution_no_disposable_adena' });
        }

        return withCharacterFlushes([contributor, leader], () => inTransaction(() => {
            const simulation = one('SELECT clanId FROM clan_simulation_clans WHERE clanId = ?', [clan]);
            if (!simulation) return { ok: false, code: 'target_not_autonomous' };
            const clanRow = one('SELECT id, level, leaderId FROM clans WHERE id = ?', [clan]);
            if (!clanRow || Number(clanRow.level) !== Number(targetLevel) || Number(clanRow.leaderId) !== leader) {
                return { ok: false, code: 'stale_snapshot' };
            }
            const members = all(`SELECT id, clanId FROM characters WHERE id IN (?, ?)`, [contributor, leader]);
            if (members.length !== 2 || members.some((member) => Number(member.clanId) !== clan)) {
                return { ok: false, code: 'stale_snapshot' };
            }

            const existing = one(`SELECT id, amount FROM clan_contributions
                WHERE clanId = ? AND characterId = ? AND targetLevel = ? AND resolveKey = ?`,
            [clan, contributor, Number(targetLevel), key]);
            if (existing) {
                return {
                    ok: false,
                    code: 'contribution_already_applied',
                    amount: Number(existing.amount),
                    ledgerId: Number(existing.id)
                };
            }

            const sourceRows = all(`SELECT id, amount FROM items WHERE characterId = ? AND selfId = 57 ORDER BY id`, [contributor]);
            const sourceBefore = sourceRows.reduce((sum, row) => sum + Math.max(0, Number(row.amount) || 0), 0);
            const disposable = Math.max(0, sourceBefore - Math.max(0, Math.floor(Number(reserve) || 0)));
            if (disposable <= 0) return { ok: false, code: 'contribution_no_disposable_adena', sourceBefore, disposable };
            const fraction = Math.max(0, Math.min(1, Number(maxContributionFraction) || 0));
            const maxAllowed = Math.min(disposable, Math.floor(disposable * fraction));
            if (requested > maxAllowed) {
                return { ok: false, code: 'contribution_reserved', sourceBefore, disposable, maxAllowed };
            }

            let remaining = requested;
            sourceRows.forEach((row) => {
                if (remaining <= 0) return;
                const current = Math.max(0, Number(row.amount) || 0);
                const deduction = Math.min(current, remaining);
                const next = current - deduction;
                if (next <= 0) write('DELETE FROM items WHERE id = ? AND characterId = ?', [row.id, contributor]);
                else write('UPDATE items SET amount = ? WHERE id = ? AND characterId = ?', [next, row.id, contributor]);
                remaining -= deduction;
            });
            if (remaining > 0) throw new Error('clan contribution source changed');

            const leaderRows = all(`SELECT id, amount FROM items WHERE characterId = ? AND selfId = 57 ORDER BY id`, [leader]);
            const leaderBefore = leaderRows.reduce((sum, row) => sum + Math.max(0, Number(row.amount) || 0), 0);
            const leaderAfter = leaderBefore + requested;
            if (leaderRows.length) {
                write('UPDATE items SET name = ?, amount = ? WHERE id = ? AND characterId = ?', ['Adena', leaderAfter, leaderRows[0].id, leader]);
                leaderRows.slice(1).forEach((row) => write('DELETE FROM items WHERE id = ? AND characterId = ?', [row.id, leader]));
            } else {
                write(`INSERT INTO items (selfId, name, amount, enchant, equipped, slot, characterId)
                    VALUES (57, 'Adena', ?, 0, 0, 0, ?)`, [leaderAfter, leader]);
            }

            const timestamp = now();
            const ledger = write(`INSERT INTO clan_contributions
                (clanId, characterId, targetLevel, amount, source, resolveKey, createdAt)
                VALUES (?, ?, ?, ?, ?, ?, ?)`, [clan, contributor, Number(targetLevel), requested, String(source), key, timestamp]);
            syncAdenaSnapshotUnsafe(contributor, sourceBefore - requested, {
                clanId: clan, targetLevel: Number(targetLevel), amount: -requested, at: timestamp
            });
            syncAdenaSnapshotUnsafe(leader, leaderAfter, {
                clanId: clan, targetLevel: Number(targetLevel), amount: requested, at: timestamp
            });
            return {
                ok: true,
                code: 'contribution_applied',
                clanId: clan,
                characterId: contributor,
                leaderId: leader,
                targetLevel: Number(targetLevel),
                amount: requested,
                sourceBefore,
                sourceAfter: sourceBefore - requested,
                leaderBefore,
                leaderAfter,
                ledgerId: Number(ledger.insertId)
            };
        }, 'clan-simulation:contribution'));
    },
    fetchClanWarehouseItems(clanId) {
        return select('clan_warehouse_items', ['*'], 'clanId = ? AND amount > 0', [Number(clanId)], 'clan-warehouse:list');
    },
    updateAutonomousClanGoal({
        clanId,
        goal = null,
        expectedUpdatedAt = null,
        eventType = 'goal_updated',
        reasonCode = ''
    } = {}) {
        const clan = Number(clanId);
        if (!clan) return Promise.resolve({ ok: false, code: 'target_not_autonomous' });
        return inTransaction(() => {
            const simulation = one('SELECT clanId, stateJson FROM clan_simulation_clans WHERE clanId = ?', [clan]);
            const clanRow = one('SELECT leaderId FROM clans WHERE id = ?', [clan]);
            if (!simulation || !clanRow) return { ok: false, code: 'target_not_autonomous' };
            const previousState = jsonObject(simulation.stateJson);
            const currentUpdatedAt = Number(previousState.updatedAt || 0);
            if (expectedUpdatedAt !== null && currentUpdatedAt !== Number(expectedUpdatedAt)) {
                return { ok: false, code: 'ownership_conflict', updatedAt: currentUpdatedAt };
            }
            const timestamp = now();
            const state = simulationState(simulation.stateJson, clan, clanRow.leaderId, previousState.memberIds || [], timestamp);
            state.goal = goal || null;
            state.updatedAt = timestamp;
            const updated = write(`UPDATE clan_simulation_clans
                SET updatedAt = ?, stateJson = ? WHERE clanId = ?`, [timestamp, JSON.stringify(state), clan]);
            if (Number(updated.affectedRows || 0) !== 1) return { ok: false, code: 'ownership_conflict' };
            if (eventType) {
                write(`INSERT INTO clan_goal_events
                    (clanId, eventType, goalType, plan, reasonCode, payloadJson, occurredAt)
                    VALUES (?, ?, ?, ?, ?, ?, ?)`, [
                    clan,
                    String(eventType),
                    String(goal?.type || ''),
                    String(goal?.plan?.kind || ''),
                    String(reasonCode || ''),
                    JSON.stringify(goal || {}),
                    timestamp
                ]);
            }
            return { ok: true, clanId: clan, goal: state.goal, updatedAt: timestamp };
        }, 'clan-goal:update');
    },
    recordClanGoalEvent({ clanId, eventType, goalType = '', plan = '', reasonCode = '', payload = {} } = {}) {
        if (!Number(clanId) || !String(eventType || '').trim()) return Promise.resolve({ ok: false, code: 'invalid_goal_event' });
        return insert('clan_goal_events', {
            clanId: Number(clanId),
            eventType: String(eventType),
            goalType: String(goalType || ''),
            plan: String(plan || ''),
            reasonCode: String(reasonCode || ''),
            payloadJson: JSON.stringify(payload || {}),
            occurredAt: now()
        }, 'clan-goal:event').then((result) => ({ ok: true, eventId: Number(result.insertId) }));
    },
    fetchClanGoalEvents(clanId, limit = 50) {
        const safeLimit = Math.max(1, Math.min(200, Math.floor(Number(limit) || 50)));
        return run(`SELECT * FROM clan_goal_events WHERE clanId = ?
            ORDER BY occurredAt DESC, id DESC LIMIT ${safeLimit}`, [Number(clanId)], 'clan-goal:events');
    },
    upsertClanMarketDemand({ clanId, itemId, amount, maxPrice, goalKey, status = 'open' } = {}) {
        const clan = Number(clanId);
        const item = Number(itemId);
        const requested = Math.floor(Number(amount) || 0);
        const price = Math.floor(Number(maxPrice) || 0);
        const key = String(goalKey || '').trim();
        if (!clan || !item || requested <= 0 || price <= 0 || !key) {
            return Promise.resolve({ ok: false, code: 'invalid_market_demand' });
        }
        return inTransaction(() => {
            const timestamp = now();
            const existing = one(`SELECT * FROM clan_market_demands
                WHERE clanId = ? AND itemId = ? AND goalKey = ?`, [clan, item, key]);
            if (existing) {
                write(`UPDATE clan_market_demands SET amount = ?, maxPrice = ?, status = ?, updatedAt = ?
                    WHERE id = ? AND clanId = ?`, [requested, price, String(status), timestamp, existing.id, clan]);
                return { ok: true, demandId: Number(existing.id), created: false, status: String(status) };
            }
            const inserted = write(`INSERT INTO clan_market_demands
                (clanId, itemId, amount, maxPrice, goalKey, status, createdAt, updatedAt)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [clan, item, requested, price, key, String(status), timestamp, timestamp]);
            return { ok: true, demandId: Number(inserted.insertId), created: true, status: String(status) };
        }, 'clan-market:demand');
    },
    syncClanMarketDemandSignal({ clanId, itemId, amount, maxPrice, goalKey, status = 'open' } = {}) {
        const clan = Number(clanId);
        const selfId = Number(itemId);
        const key = String(goalKey || '').trim();
        if (!clan || !selfId || !key) return Promise.resolve({ ok: false, code: 'invalid_market_demand' });
        return inTransaction(() => {
            const clanRow = one('SELECT leaderId FROM clans WHERE id = ?', [clan]);
            if (!clanRow) return { ok: false, code: 'target_not_autonomous' };
            const leader = one(`SELECT characterId, statsJson FROM bot_life_state
                WHERE characterId = ?`, [Number(clanRow.leaderId)]);
            if (!leader) return { ok: false, code: 'market_signal_owner_missing' };
            const stats = jsonObject(leader.statsJson);
            const activeSignal = stats.clanMarketDemand;
            if (String(status) === 'open') {
                if (!activeSignal || String(activeSignal.goalKey || '') !== key) {
                    stats.clanMarketPreviousWanted = stats.marketWanted || null;
                }
                stats.clanMarketDemand = {
                    clanId: clan,
                    itemId: selfId,
                    amount: Math.max(1, Math.floor(Number(amount) || 1)),
                    maxPrice: Math.max(1, Math.floor(Number(maxPrice) || 1)),
                    goalKey: key,
                    updatedAt: now()
                };
                stats.marketWanted = {
                    itemId: selfId,
                    itemName: selfId === 1419 ? 'Blood Mark' : `Item ${selfId}`,
                    lastMissingAt: now(),
                    clanId: clan
                };
            } else if (activeSignal && String(activeSignal.goalKey || '') === key) {
                stats.marketWanted = stats.clanMarketPreviousWanted || null;
                delete stats.clanMarketPreviousWanted;
                delete stats.clanMarketDemand;
            } else {
                return { ok: true, characterId: Number(leader.characterId), unchanged: true };
            }
            write('UPDATE bot_life_state SET statsJson = ?, updatedAt = ? WHERE characterId = ?', [
                JSON.stringify(stats), now(), Number(leader.characterId)
            ]);
            return { ok: true, characterId: Number(leader.characterId), itemId: selfId, status: String(status) };
        }, 'clan-market:signal');
    },
    fetchClanMarketDemands({ clanId = null, itemId = null, status = 'open', limit = 100 } = {}) {
        const clauses = [];
        const params = [];
        if (clanId !== null && clanId !== undefined) { clauses.push('clanId = ?'); params.push(Number(clanId)); }
        if (itemId !== null && itemId !== undefined) { clauses.push('itemId = ?'); params.push(Number(itemId)); }
        if (status !== null && status !== undefined) { clauses.push('status = ?'); params.push(String(status)); }
        const safeLimit = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));
        return run(`SELECT * FROM clan_market_demands${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''}
            ORDER BY updatedAt ASC, id ASC LIMIT ${safeLimit}`, params, 'clan-market:demands');
    },
    fetchActiveAutonomousClanOperation(clanId) {
        return selectOne('clan_operations', ['*'], "clanId = ? AND status = 'active'", [Number(clanId)], 'clan-party:active-operation')
            .then((rows) => rows[0] || null);
    },
    fetchAutonomousClanOperation(operationId) {
        return selectOne('clan_operations', ['*'], 'id = ?', [Number(operationId)], 'clan-party:operation')
            .then((rows) => rows[0] || null);
    },
    startAutonomousClanOperation({
        clanId,
        operationKey,
        operationType = 'farm',
        targetNpcId = 0,
        leaderId = 0,
        memberIds = [],
        guestMemberIds = [],
        expectedGoalUpdatedAt = null
    } = {}) {
        const clan = Number(clanId);
        const key = String(operationKey || '').trim();
        const members = [...new Set((memberIds || []).map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))]
            .sort((left, right) => left - right);
        const clanMembers = new Set(members);
        const guests = [...new Set((guestMemberIds || []).map(Number).filter((id) => (
            Number.isSafeInteger(id) && id > 0 && !clanMembers.has(id)
        )))].sort((left, right) => left - right);
        const allMembers = [...members, ...guests].sort((left, right) => left - right);
        const guestSet = new Set(guests);
        if (!clan || !key || allMembers.length < 2) return Promise.resolve({ ok: false, code: 'party_not_ready' });

        return inTransaction(() => {
            const existingByKey = one('SELECT * FROM clan_operations WHERE operationKey = ?', [key]);
            if (existingByKey) {
                return {
                    ok: true,
                    idempotent: true,
                    code: existingByKey.status === 'active' ? 'party_operation_active' : 'party_operation_replay',
                    operationId: Number(existingByKey.id),
                    status: String(existingByKey.status),
                    operation: existingByKey
                };
            }
            const simulation = one('SELECT clanId, stateJson FROM clan_simulation_clans WHERE clanId = ?', [clan]);
            const clanRow = one('SELECT id, level, leaderId FROM clans WHERE id = ?', [clan]);
            if (!simulation || !clanRow) return { ok: false, code: 'target_not_autonomous' };

            const previousState = jsonObject(simulation.stateJson);
            const goal = jsonObject(previousState.goal);
            const currentGoalUpdatedAt = Number(previousState.updatedAt || 0);
            if (expectedGoalUpdatedAt !== null
                && currentGoalUpdatedAt !== Number(expectedGoalUpdatedAt)) {
                return { ok: false, code: 'ownership_conflict', updatedAt: currentGoalUpdatedAt };
            }
            if (!goal || String(goal.plan?.kind || '') !== String(operationType)
                || String(goal.partyId || '') !== '') {
                return { ok: false, code: 'party_goal_changed' };
            }
            const selectedIds = new Set((goal.assignedMemberIds || []).map(Number));
            if (members.some((id) => !selectedIds.has(id))) return { ok: false, code: 'party_goal_changed' };

            const placeholders = allMembers.map(() => '?').join(', ');
            const rows = all(`SELECT c.id, c.clanId, c.username, life.accountName, life.statsJson,
                    life.phase, life.simulationOwner, life.simulationRevision, life.partyId
                FROM characters c
                LEFT JOIN bot_life_state life ON life.characterId = c.id
                WHERE c.id IN (${placeholders})`, allMembers);
            if (rows.length !== allMembers.length || rows.some((row) => (
                (!guestSet.has(Number(row.id)) && Number(row.clanId) !== clan)
                || !generatedBotRow(row)
                || String(row.phase || '') !== 'cold'
                || String(row.simulationOwner || LEGACY_SIMULATION_OWNER) !== LEGACY_SIMULATION_OWNER
                || String(row.partyId || '') !== ''
            ))) return { ok: false, code: 'party_not_ready' };

            const activeMember = one(`SELECT characterId FROM clan_operation_members
                WHERE characterId IN (${placeholders}) AND status = 'active' LIMIT 1`, allMembers);
            if (activeMember) {
                return { ok: false, code: 'party_member_reservation_conflict', characterId: Number(activeMember.characterId) };
            }
            const activeClan = one("SELECT id FROM clan_operations WHERE clanId = ? AND status = 'active' LIMIT 1", [clan]);
            if (activeClan) return { ok: false, code: 'party_operation_active', operationId: Number(activeClan.id) };

            const timestamp = now();
            const resolvedLeader = Number(leaderId) || Number(goal.plan?.beneficiaryId) || Number(clanRow.leaderId);
            const nextGoal = {
                ...goal,
                partyId: key,
                status: 'executing',
                updatedAt: timestamp
            };
            const state = simulationState(simulation.stateJson, clan, clanRow.leaderId, previousState.memberIds || [], timestamp);
            state.goal = nextGoal;
            state.updatedAt = timestamp;
            const updated = write(`UPDATE clan_simulation_clans SET updatedAt = ?, stateJson = ?
                WHERE clanId = ? AND updatedAt = ?`, [timestamp, JSON.stringify(state), clan, currentGoalUpdatedAt]);
            if (Number(updated.affectedRows || 0) !== 1) return { ok: false, code: 'ownership_conflict' };

            const inserted = write(`INSERT INTO clan_operations
                (clanId, operationKey, operationType, targetNpcId, leaderId, memberIdsJson, status, createdAt, updatedAt)
                VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`, [
                clan,
                key,
                String(operationType),
                Math.max(0, Number(targetNpcId) || 0),
                resolvedLeader,
                JSON.stringify(allMembers),
                timestamp,
                timestamp
            ]);
            allMembers.forEach((characterId) => write(`INSERT INTO clan_operation_members
                (operationId, clanId, characterId, status, reservedAt)
                VALUES (?, ?, ?, 'active', ?)`, [Number(inserted.insertId), clan, characterId, timestamp]));
            write(`INSERT INTO clan_goal_events
                (clanId, eventType, goalType, plan, reasonCode, payloadJson, occurredAt)
                VALUES (?, 'party_operation_started', ?, ?, 'party_operation_started', ?, ?)`, [
                clan,
                String(goal.type || ''),
                String(operationType),
                JSON.stringify({
                    operationKey: key,
                    operationId: Number(inserted.insertId),
                    memberIds: allMembers,
                    guestMemberIds: guests
                }),
                timestamp
            ]);
            return {
                ok: true,
                code: 'party_operation_started',
                operationId: Number(inserted.insertId),
                operationKey: key,
                memberIds: allMembers,
                guestMemberIds: guests,
                updatedAt: timestamp
            };
        }, 'clan-party:start');
    },
    completeAutonomousClanOperation({ operationId, success = false, drops = [], reasonCode = '' } = {}) {
        const id = Number(operationId);
        if (!id) return Promise.resolve({ ok: false, code: 'operation_missing' });
        return inTransaction(() => {
            const operation = one('SELECT * FROM clan_operations WHERE id = ?', [id]);
            if (!operation) return { ok: false, code: 'operation_missing' };
            if (String(operation.status) !== 'active') {
                return {
                    ok: true,
                    idempotent: true,
                    code: 'operation_already_resolved',
                    operationId: id,
                    status: String(operation.status),
                    reward: jsonArray(operation.rewardJson)
                };
            }
            const clan = Number(operation.clanId);
            const simulation = one('SELECT clanId, stateJson FROM clan_simulation_clans WHERE clanId = ?', [clan]);
            const clanRow = one('SELECT id, leaderId FROM clans WHERE id = ?', [clan]);
            if (!simulation || !clanRow) return { ok: false, code: 'target_not_autonomous' };
            const timestamp = now();
            const normalizedDrops = (Array.isArray(drops) ? drops : []).reduce((result, drop) => {
                const selfId = Number(drop?.selfId || 0);
                const amount = Math.floor(Number(drop?.amount) || 0);
                if (!selfId || amount <= 0) return result;
                const enchant = Math.max(0, Number(drop?.enchant) || 0);
                const key = `${selfId}:${enchant}`;
                const existing = result.get(key) || {
                    selfId,
                    amount: 0,
                    enchant,
                    name: String(drop?.name || `Item ${selfId}`),
                    kind: String(drop?.kind || ''),
                    stackable: drop?.stackable !== false,
                    petData: drop?.petData || null
                };
                existing.amount += amount;
                result.set(key, existing);
                return result;
            }, new Map());
            const reward = [...normalizedDrops.values()];
            let warehouseRevision = Math.max(0, Number(jsonObject(simulation.stateJson).warehouseRevision) || 0);
            if (success) {
                reward.forEach((drop) => {
                    const wearable = /^(Armor|Weapon)\./.test(String(drop.kind || ''));
                    const stackable = drop.stackable !== false && !wearable;
                    const warehouse = stackable ? one(`SELECT id, amount FROM clan_warehouse_items
                        WHERE clanId = ? AND selfId = ? AND enchant = ? LIMIT 1`, [clan, drop.selfId, drop.enchant]) : null;
                    if (warehouse) {
                        write(`UPDATE clan_warehouse_items SET amount = amount + ?, updatedAt = ?
                            WHERE id = ? AND clanId = ?`, [drop.amount, timestamp, warehouse.id, clan]);
                    } else {
                        const rows = stackable ? 1 : drop.amount;
                        const rowAmount = stackable ? drop.amount : 1;
                        for (let index = 0; index < rows; index += 1) {
                            write(`INSERT INTO clan_warehouse_items
                                (clanId, selfId, name, kind, amount, enchant, petData, createdAt, updatedAt)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
                                clan, drop.selfId, drop.name, drop.kind, rowAmount, drop.enchant,
                                drop.petData ? JSON.stringify(drop.petData) : null, timestamp, timestamp
                            ]);
                        }
                    }
                    write(`INSERT INTO clan_warehouse_ledger
                        (clanId, characterId, selfId, amount, operation, resolveKey, warehouseRevision, createdAt)
                        VALUES (?, ?, ?, ?, 'party_reward', ?, ?, ?)`, [
                        clan,
                        Number(operation.leaderId),
                        drop.selfId,
                        drop.amount,
                        String(operation.operationKey),
                        warehouseRevision + 1,
                        timestamp
                    ]);
                    warehouseRevision += 1;
                });
            }

            const previousState = jsonObject(simulation.stateJson);
            const state = simulationState(simulation.stateJson, clan, clanRow.leaderId, previousState.memberIds || [], timestamp);
            const goal = jsonObject(previousState.goal);
            if (Object.keys(goal).length) {
                const progress = reward
                    .filter((drop) => Number(drop.selfId) === Number(goal.target?.itemId))
                    .reduce((sum, drop) => sum + drop.amount, Number(goal.progress) || 0);
                state.goal = {
                    ...goal,
                    partyId: null,
                    progress: Math.min(Number(goal.required) || progress, progress),
                    status: progress >= Number(goal.required || 0) ? 'completed' : 'executing',
                    reasonCodes: [...new Set([...(goal.reasonCodes || []), success ? 'party_reward_applied' : String(reasonCode || 'party_operation_failed')])].slice(-8),
                    updatedAt: timestamp
                };
            } else {
                state.goal = null;
            }
            if (success && reward.length) state.warehouseRevision = warehouseRevision;
            state.updatedAt = timestamp;
            write(`UPDATE clan_simulation_clans SET updatedAt = ?, stateJson = ? WHERE clanId = ?`, [
                timestamp, JSON.stringify(state), clan
            ]);
            write(`UPDATE clan_operation_members SET status = 'released', releasedAt = ?
                WHERE operationId = ? AND status = 'active'`, [timestamp, id]);
            const status = success ? 'succeeded' : 'failed';
            write(`UPDATE clan_operations SET status = ?, wins = ?, deaths = ?, reasonCode = ?, rewardJson = ?,
                    updatedAt = ?, resolvedAt = ? WHERE id = ? AND status = 'active'`, [
                status,
                success ? 1 : 0,
                success ? 0 : 1,
                String(reasonCode || (success ? 'party_operation_succeeded' : 'party_operation_failed')),
                JSON.stringify(reward),
                timestamp,
                timestamp,
                id
            ]);
            write(`INSERT INTO clan_goal_events
                (clanId, eventType, goalType, plan, reasonCode, payloadJson, occurredAt)
                VALUES (?, ?, ?, 'farm', ?, ?, ?)`, [
                clan,
                success ? 'party_operation_succeeded' : 'party_operation_failed',
                String(goal.type || 'item'),
                String(reasonCode || (success ? 'party_operation_succeeded' : 'party_operation_failed')),
                JSON.stringify({ operationId: id, operationKey: operation.operationKey, reward }),
                timestamp
            ]);
            return {
                ok: true,
                code: success ? 'party_operation_succeeded' : 'party_operation_failed',
                operationId: id,
                status,
                reward,
                warehouseRevision,
                goal: state.goal
            };
        }, 'clan-party:complete');
    },
    transferInventoryToClanWarehouse({
        clanId,
        characterId,
        item = {},
        amount,
        resolveKey,
        expectedWarehouseRevision = null,
        expectedSimulationRevision = null
    } = {}) {
        const clan = Number(clanId);
        const character = Number(characterId);
        const selfId = Number(item.selfId || 0);
        const sourceItemId = Number(item.id || 0);
        const requested = Math.floor(Number(amount) || 0);
        const key = String(resolveKey || '').trim();
        if (!clan || !character || !selfId || !sourceItemId || requested <= 0 || !key) {
            return Promise.resolve({ ok: false, code: 'warehouse_transfer_failed' });
        }

        return withCharacterFlush(character, () => inTransaction(() => {
            const simulation = one('SELECT clanId, stateJson FROM clan_simulation_clans WHERE clanId = ?', [clan]);
            const clanRow = one('SELECT id, level FROM clans WHERE id = ?', [clan]);
            const member = one('SELECT id, clanId FROM characters WHERE id = ?', [character]);
            const life = one(`SELECT phase, simulationOwner, simulationRevision, partyId
                FROM bot_life_state WHERE characterId = ?`, [character]);
            if (!simulation || !clanRow || !member || Number(member.clanId) !== clan) {
                return { ok: false, code: 'warehouse_transfer_failed' };
            }
            if (!life || String(life.phase || '') !== 'cold'
                || String(life.simulationOwner || LEGACY_SIMULATION_OWNER) !== LEGACY_SIMULATION_OWNER
                || String(life.partyId || '') !== '') {
                return { ok: false, code: 'stale_snapshot' };
            }
            if (expectedSimulationRevision !== null
                && Number(life.simulationRevision || 0) !== Number(expectedSimulationRevision)) {
                return { ok: false, code: 'stale_snapshot', simulationRevision: Number(life.simulationRevision || 0) };
            }

            const previousState = jsonObject(simulation.stateJson);
            const currentWarehouseRevision = Math.max(0, Number(previousState.warehouseRevision) || 0);
            if (expectedWarehouseRevision !== null
                && currentWarehouseRevision !== Number(expectedWarehouseRevision)) {
                return { ok: false, code: 'ownership_conflict', warehouseRevision: currentWarehouseRevision };
            }

            const existingLedger = one(`SELECT id, amount, warehouseRevision
                FROM clan_warehouse_ledger
                WHERE clanId = ? AND characterId = ? AND selfId = ?
                  AND operation = 'deposit' AND resolveKey = ?`, [clan, character, selfId, key]);
            if (existingLedger) {
                return {
                    ok: false,
                    code: 'warehouse_transfer_already_applied',
                    amount: Number(existingLedger.amount),
                    ledgerId: Number(existingLedger.id),
                    warehouseRevision: Number(existingLedger.warehouseRevision)
                };
            }

            const source = one(`SELECT id, selfId, name, amount, enchant, petData
                FROM items WHERE id = ? AND characterId = ?`, [sourceItemId, character]);
            if (!source || Number(source.selfId) !== selfId || Number(source.amount || 0) < requested) {
                return { ok: false, code: 'warehouse_transfer_failed' };
            }

            const kind = String(item.kind || '');
            const recipe = kind.startsWith('Other.Recipe');
            const recipeTarget = recipe
                ? one(`SELECT id, amount, reservedAmount FROM clan_warehouse_items
                    WHERE clanId = ? AND selfId = ? AND amount > 0 LIMIT 1`, [clan, selfId])
                : null;
            if (recipeTarget) {
                return { ok: false, code: 'warehouse_duplicate_recipe' };
            }

            const stackable = item.stackable !== false && !recipe;
            const target = stackable
                ? one(`SELECT id, amount, reservedAmount FROM clan_warehouse_items
                    WHERE clanId = ? AND selfId = ? AND enchant = ? LIMIT 1`, [clan, selfId, Number(source.enchant || 0)])
                : null;
            const timestamp = now();
            let warehouseId;
            let warehouseAmount;
            if (target) {
                warehouseId = Number(target.id);
                warehouseAmount = Number(target.amount || 0) + requested;
                write(`UPDATE clan_warehouse_items
                    SET amount = ?, updatedAt = ? WHERE id = ? AND clanId = ?`, [warehouseAmount, timestamp, warehouseId, clan]);
            } else {
                warehouseAmount = requested;
                warehouseId = Number(write(`INSERT INTO clan_warehouse_items
                    (clanId, selfId, name, kind, amount, enchant, petData, createdAt, updatedAt)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
                    clan,
                    selfId,
                    String(item.name || source.name || `Item ${selfId}`),
                    kind,
                    requested,
                    Math.max(0, Number(source.enchant || 0)),
                    source.petData || null,
                    timestamp,
                    timestamp
                ]).insertId);
            }

            const sourceAfter = Number(source.amount || 0) - requested;
            if (sourceAfter <= 0) write('DELETE FROM items WHERE id = ? AND characterId = ?', [source.id, character]);
            else write('UPDATE items SET amount = ? WHERE id = ? AND characterId = ?', [sourceAfter, source.id, character]);

            const lifeUpdate = updateColdInventorySnapshotUnsafe(character, selfId, {
                clanId: clan,
                selfId,
                amount: -requested,
                warehouseId,
                at: timestamp
            }, expectedSimulationRevision === null ? Number(life.simulationRevision || 0) : Number(expectedSimulationRevision));
            if (!lifeUpdate.ok) return lifeUpdate;

            const nextWarehouseRevision = currentWarehouseRevision + 1;
            const state = simulationState(simulation.stateJson, clan, previousState.leaderId, previousState.memberIds || [], timestamp);
            state.warehouseRevision = nextWarehouseRevision;
            write(`UPDATE clan_simulation_clans SET updatedAt = ?, stateJson = ?
                WHERE clanId = ? AND json_extract(stateJson, '$.warehouseRevision') = ?`, [
                timestamp, JSON.stringify(state), clan, currentWarehouseRevision
            ]);
            const ledger = write(`INSERT INTO clan_warehouse_ledger
                (clanId, characterId, selfId, amount, operation, resolveKey, warehouseRevision, createdAt)
                VALUES (?, ?, ?, ?, 'deposit', ?, ?, ?)`, [
                clan, character, selfId, requested, key, nextWarehouseRevision, timestamp
            ]);
            return {
                ok: true,
                code: 'warehouse_deposit_applied',
                clanId: clan,
                characterId: character,
                selfId,
                amount: requested,
                warehouseId,
                warehouseAmount,
                warehouseRevision: nextWarehouseRevision,
                simulationRevision: lifeUpdate.simulationRevision,
                ledgerId: Number(ledger.insertId)
            };
        }, 'clan-warehouse:deposit'));
    },
    transferClanWarehouseToMember({
        clanId,
        characterId,
        selfId,
        amount,
        goalKey,
        expectedWarehouseRevision = null,
        expectedSimulationRevision = null
    } = {}) {
        const clan = Number(clanId);
        const beneficiary = Number(characterId);
        const itemId = Number(selfId || 0);
        const requested = Math.floor(Number(amount) || 0);
        const key = String(goalKey || '').trim();
        if (!clan || !beneficiary || !itemId || requested <= 0 || !key) {
            return Promise.resolve({ ok: false, code: 'warehouse_transfer_failed' });
        }

        return withCharacterFlush(beneficiary, () => inTransaction(() => {
            const simulation = one('SELECT clanId, stateJson FROM clan_simulation_clans WHERE clanId = ?', [clan]);
            const member = one('SELECT id, clanId FROM characters WHERE id = ?', [beneficiary]);
            const life = one(`SELECT phase, simulationOwner, simulationRevision, partyId
                FROM bot_life_state WHERE characterId = ?`, [beneficiary]);
            if (!simulation || !member || Number(member.clanId) !== clan || !life) {
                return { ok: false, code: 'warehouse_transfer_failed' };
            }
            if (String(life.phase || '') !== 'cold'
                || String(life.simulationOwner || LEGACY_SIMULATION_OWNER) !== LEGACY_SIMULATION_OWNER
                || String(life.partyId || '') !== '') {
                return { ok: false, code: 'stale_snapshot' };
            }
            if (expectedSimulationRevision !== null
                && Number(life.simulationRevision || 0) !== Number(expectedSimulationRevision)) {
                return { ok: false, code: 'stale_snapshot', simulationRevision: Number(life.simulationRevision || 0) };
            }

            const previousState = jsonObject(simulation.stateJson);
            const currentWarehouseRevision = Math.max(0, Number(previousState.warehouseRevision) || 0);
            if (expectedWarehouseRevision !== null
                && currentWarehouseRevision !== Number(expectedWarehouseRevision)) {
                return { ok: false, code: 'ownership_conflict', warehouseRevision: currentWarehouseRevision };
            }

            const existingLedger = one(`SELECT id, amount, warehouseRevision
                FROM clan_warehouse_ledger
                WHERE clanId = ? AND characterId = ? AND selfId = ?
                  AND operation = 'withdraw' AND resolveKey = ?`, [clan, beneficiary, itemId, key]);
            if (existingLedger) {
                return {
                    ok: true,
                    code: 'warehouse_withdraw_already_applied',
                    amount: Number(existingLedger.amount),
                    warehouseRevision: Number(existingLedger.warehouseRevision),
                    ledgerId: Number(existingLedger.id)
                };
            }

            const reservation = one(`SELECT id, amount, status
                FROM clan_warehouse_reservations
                WHERE clanId = ? AND selfId = ? AND goalKey = ?`, [clan, itemId, key]);
            if (reservation?.status === 'reserved') {
                return { ok: false, code: 'warehouse_item_reserved', available: 0 };
            }
            if (reservation?.status === 'consumed') {
                return { ok: false, code: 'warehouse_transfer_failed' };
            }

            const stockRows = all(`SELECT id, selfId, name, kind, amount, enchant, petData, reservedAmount
                FROM clan_warehouse_items
                WHERE clanId = ? AND selfId = ? AND amount > 0
                ORDER BY id`, [clan, itemId]);
            const available = stockRows.reduce((sum, row) => sum + Math.max(
                0,
                Number(row.amount || 0) - Number(row.reservedAmount || 0)
            ), 0);
            if (available < requested) {
                return { ok: false, code: 'warehouse_no_stock', available };
            }

            const timestamp = now();
            let remaining = requested;
            const consumedRows = [];
            for (const stock of stockRows) {
                if (remaining <= 0) break;
                const stockAmount = Math.max(0, Number(stock.amount || 0));
                const reservedAmount = Math.max(0, Number(stock.reservedAmount || 0));
                const take = Math.min(remaining, Math.max(0, stockAmount - reservedAmount));
                if (take <= 0) continue;

                const nextAmount = stockAmount - take;
                if (nextAmount <= 0 && reservedAmount <= 0) {
                    write('DELETE FROM clan_warehouse_items WHERE id = ? AND clanId = ?', [stock.id, clan]);
                } else {
                    write(`UPDATE clan_warehouse_items
                        SET amount = ?, updatedAt = ? WHERE id = ? AND clanId = ?`, [nextAmount, timestamp, stock.id, clan]);
                }

                const targetItem = one(`SELECT id, amount FROM items
                    WHERE characterId = ? AND selfId = ? AND enchant = ? AND equipped = 0
                    ORDER BY id LIMIT 1`, [beneficiary, itemId, Number(stock.enchant || 0)]);
                if (targetItem) {
                    write('UPDATE items SET amount = ? WHERE id = ? AND characterId = ?', [
                        Number(targetItem.amount || 0) + take,
                        targetItem.id,
                        beneficiary
                    ]);
                } else {
                    write(`INSERT INTO items
                        (selfId, name, amount, enchant, equipped, slot, petData, characterId)
                        VALUES (?, ?, ?, ?, 0, 0, ?, ?)`, [
                        itemId,
                        String(stock.name || `Item ${itemId}`),
                        take,
                        Math.max(0, Number(stock.enchant || 0)),
                        stock.petData || null,
                        beneficiary
                    ]);
                }
                consumedRows.push({ warehouseId: Number(stock.id), amount: take });
                remaining -= take;
            }
            if (remaining > 0) throw new Error('clan warehouse handoff source changed');

            const lifeUpdate = updateColdInventorySnapshotUnsafe(beneficiary, itemId, {
                clanId: clan,
                selfId: itemId,
                amount: requested,
                warehouseId: consumedRows[0]?.warehouseId || null,
                at: timestamp,
                operation: 'withdraw'
            }, expectedSimulationRevision === null
                ? Number(life.simulationRevision || 0)
                : Number(expectedSimulationRevision));
            if (!lifeUpdate.ok) throw new Error(`clan warehouse handoff rejected: ${lifeUpdate.code}`);

            const nextWarehouseRevision = currentWarehouseRevision + 1;
            const state = simulationState(simulation.stateJson, clan, previousState.leaderId, previousState.memberIds || [], timestamp);
            state.warehouseRevision = nextWarehouseRevision;
            const stateUpdate = write(`UPDATE clan_simulation_clans
                SET updatedAt = ?, stateJson = ?
                WHERE clanId = ? AND json_extract(stateJson, '$.warehouseRevision') = ?`, [
                timestamp,
                JSON.stringify(state),
                clan,
                currentWarehouseRevision
            ]);
            if (Number(stateUpdate.affectedRows || 0) !== 1) throw new Error('clan warehouse revision changed');

            const reservationResult = reservation
                ? write(`UPDATE clan_warehouse_reservations
                    SET amount = ?, beneficiaryId = ?, status = 'consumed', updatedAt = ?
                    WHERE id = ? AND clanId = ?`, [requested, beneficiary, timestamp, reservation.id, clan])
                : write(`INSERT INTO clan_warehouse_reservations
                    (clanId, selfId, amount, beneficiaryId, goalKey, status, createdAt, updatedAt)
                    VALUES (?, ?, ?, ?, ?, 'consumed', ?, ?)`, [
                    clan, itemId, requested, beneficiary, key, timestamp, timestamp
                ]);
            const ledger = write(`INSERT INTO clan_warehouse_ledger
                (clanId, characterId, selfId, amount, operation, resolveKey, warehouseRevision, createdAt)
                VALUES (?, ?, ?, ?, 'withdraw', ?, ?, ?)`, [
                clan, beneficiary, itemId, requested, key, nextWarehouseRevision, timestamp
            ]);
            return {
                ok: true,
                code: 'warehouse_withdraw_applied',
                clanId: clan,
                characterId: beneficiary,
                selfId: itemId,
                amount: requested,
                warehouseRevision: nextWarehouseRevision,
                simulationRevision: lifeUpdate.simulationRevision,
                reservationId: Number(reservation?.id || reservationResult.insertId || 0),
                ledgerId: Number(ledger.insertId)
            };
        }, 'clan-warehouse:withdraw'));
    },
    transferClanAdenaToWarehouse({
        clanId,
        characterId,
        targetLevel = 1,
        amount,
        reserve = 0,
        maxContributionFraction = 0.35,
        resolveKey,
        expectedWarehouseRevision = null,
        expectedSimulationRevision = null,
        source = 'adena'
    } = {}) {
        const clan = Number(clanId);
        const contributor = Number(characterId);
        const requested = Math.floor(Number(amount) || 0);
        const key = String(resolveKey || '').trim();
        if (!clan || !contributor || requested <= 0 || !key) {
            return Promise.resolve({ ok: false, code: 'contribution_no_disposable_adena' });
        }

        return withCharacterFlush(contributor, () => inTransaction(() => {
            const simulation = one('SELECT clanId, stateJson FROM clan_simulation_clans WHERE clanId = ?', [clan]);
            const clanRow = one('SELECT id, level, leaderId FROM clans WHERE id = ?', [clan]);
            const member = one('SELECT id, clanId FROM characters WHERE id = ?', [contributor]);
            const life = one(`SELECT phase, simulationOwner, simulationRevision, partyId
                FROM bot_life_state WHERE characterId = ?`, [contributor]);
            if (!simulation || !clanRow || Number(clanRow.level) !== Number(targetLevel)
                || !member || Number(member.clanId) !== clan || !life) {
                return { ok: false, code: 'stale_snapshot' };
            }
            if (String(life.phase || '') !== 'cold'
                || String(life.simulationOwner || LEGACY_SIMULATION_OWNER) !== LEGACY_SIMULATION_OWNER
                || String(life.partyId || '') !== '') return { ok: false, code: 'stale_snapshot' };
            if (expectedSimulationRevision !== null
                && Number(life.simulationRevision || 0) !== Number(expectedSimulationRevision)) {
                return { ok: false, code: 'stale_snapshot', simulationRevision: Number(life.simulationRevision || 0) };
            }

            const previousState = jsonObject(simulation.stateJson);
            const currentWarehouseRevision = Math.max(0, Number(previousState.warehouseRevision) || 0);
            if (expectedWarehouseRevision !== null
                && currentWarehouseRevision !== Number(expectedWarehouseRevision)) {
                return { ok: false, code: 'ownership_conflict', warehouseRevision: currentWarehouseRevision };
            }
            const existingLedger = one(`SELECT id, amount, warehouseRevision
                FROM clan_warehouse_ledger
                WHERE clanId = ? AND characterId = ? AND selfId = 57
                  AND operation = 'adena_contribution' AND resolveKey = ?`, [clan, contributor, key]);
            if (existingLedger) {
                return {
                    ok: false,
                    code: 'contribution_already_applied',
                    amount: Number(existingLedger.amount),
                    ledgerId: Number(existingLedger.id),
                    warehouseRevision: Number(existingLedger.warehouseRevision)
                };
            }

            const sourceRows = all(`SELECT id, amount FROM items
                WHERE characterId = ? AND selfId = 57 ORDER BY id`, [contributor]);
            const sourceBefore = sourceRows.reduce((sum, row) => sum + Math.max(0, Number(row.amount) || 0), 0);
            const disposable = Math.max(0, sourceBefore - Math.max(0, Math.floor(Number(reserve) || 0)));
            if (disposable <= 0) return { ok: false, code: 'contribution_no_disposable_adena', sourceBefore, disposable };
            const fraction = Math.max(0, Math.min(1, Number(maxContributionFraction) || 0));
            const maxAllowed = Math.min(disposable, Math.floor(disposable * fraction));
            if (requested > maxAllowed) {
                return { ok: false, code: 'contribution_reserved', sourceBefore, disposable, maxAllowed };
            }

            let remaining = requested;
            sourceRows.forEach((row) => {
                if (remaining <= 0) return;
                const current = Math.max(0, Number(row.amount) || 0);
                const deduction = Math.min(current, remaining);
                const next = current - deduction;
                if (next <= 0) write('DELETE FROM items WHERE id = ? AND characterId = ?', [row.id, contributor]);
                else write('UPDATE items SET amount = ? WHERE id = ? AND characterId = ?', [next, row.id, contributor]);
                remaining -= deduction;
            });
            if (remaining > 0) throw new Error('clan warehouse contribution source changed');

            const warehouse = one(`SELECT id, amount, reservedAmount FROM clan_warehouse_items
                WHERE clanId = ? AND selfId = 57 AND enchant = 0 LIMIT 1`, [clan]);
            const timestamp = now();
            const warehouseAmount = Number(warehouse?.amount || 0) + requested;
            const warehouseId = warehouse
                ? Number(warehouse.id)
                : Number(write(`INSERT INTO clan_warehouse_items
                    (clanId, selfId, name, kind, amount, enchant, createdAt, updatedAt)
                    VALUES (?, 57, 'Adena', 'Other.Currency', ?, 0, ?, ?)`, [clan, requested, timestamp, timestamp]).insertId);
            if (warehouse) write(`UPDATE clan_warehouse_items SET amount = ?, updatedAt = ?
                WHERE id = ? AND clanId = ?`, [warehouseAmount, timestamp, warehouseId, clan]);

            const lifeUpdate = updateColdInventorySnapshotUnsafe(contributor, 57, {
                clanId: clan,
                selfId: 57,
                amount: -requested,
                warehouseId,
                at: timestamp
            }, expectedSimulationRevision === null ? Number(life.simulationRevision || 0) : Number(expectedSimulationRevision));
            if (!lifeUpdate.ok) return lifeUpdate;

            const nextWarehouseRevision = currentWarehouseRevision + 1;
            const state = simulationState(simulation.stateJson, clan, previousState.leaderId, previousState.memberIds || [], timestamp);
            state.warehouseRevision = nextWarehouseRevision;
            write(`UPDATE clan_simulation_clans SET updatedAt = ?, stateJson = ?
                WHERE clanId = ? AND json_extract(stateJson, '$.warehouseRevision') = ?`, [
                timestamp, JSON.stringify(state), clan, currentWarehouseRevision
            ]);
            const contribution = write(`INSERT INTO clan_contributions
                (clanId, characterId, targetLevel, amount, source, resolveKey, createdAt)
                VALUES (?, ?, ?, ?, ?, ?, ?)`, [clan, contributor, Number(targetLevel), requested, source, key, timestamp]);
            const ledger = write(`INSERT INTO clan_warehouse_ledger
                (clanId, characterId, selfId, amount, operation, resolveKey, warehouseRevision, createdAt)
                VALUES (?, ?, 57, ?, 'adena_contribution', ?, ?, ?)`, [
                clan, contributor, requested, key, nextWarehouseRevision, timestamp
            ]);
            return {
                ok: true,
                code: 'contribution_applied',
                clanId: clan,
                characterId: contributor,
                targetLevel: Number(targetLevel),
                amount: requested,
                sourceBefore,
                sourceAfter: sourceBefore - requested,
                warehouseId,
                warehouseAmount,
                warehouseRevision: nextWarehouseRevision,
                simulationRevision: lifeUpdate.simulationRevision,
                contributionId: Number(contribution.insertId),
                ledgerId: Number(ledger.insertId)
            };
        }, 'clan-warehouse:adena-contribution'));
    },
    reserveClanWarehouseItem({
        clanId,
        selfId,
        amount,
        goalKey,
        beneficiaryId = null,
        expectedWarehouseRevision = null
    } = {}) {
        const clan = Number(clanId);
        const itemId = Number(selfId);
        const requested = Math.floor(Number(amount) || 0);
        const key = String(goalKey || '').trim();
        if (!clan || !itemId || requested <= 0 || !key) {
            return Promise.resolve({ ok: false, code: 'warehouse_transfer_failed' });
        }
        return inTransaction(() => {
            const simulation = one('SELECT clanId, stateJson FROM clan_simulation_clans WHERE clanId = ?', [clan]);
            if (!simulation) return { ok: false, code: 'warehouse_transfer_failed' };
            const previousState = jsonObject(simulation.stateJson);
            const currentRevision = Math.max(0, Number(previousState.warehouseRevision) || 0);
            if (expectedWarehouseRevision !== null && currentRevision !== Number(expectedWarehouseRevision)) {
                return { ok: false, code: 'ownership_conflict', warehouseRevision: currentRevision };
            }
            const existing = one(`SELECT id, amount, status FROM clan_warehouse_reservations
                WHERE clanId = ? AND selfId = ? AND goalKey = ?`, [clan, itemId, key]);
            if (existing?.status === 'reserved') {
                return { ok: false, code: 'warehouse_reservation_exists', reservationId: Number(existing.id) };
            }
            const stock = one(`SELECT id, amount, reservedAmount FROM clan_warehouse_items
                WHERE clanId = ? AND selfId = ? AND amount > 0 ORDER BY id LIMIT 1`, [clan, itemId]);
            if (!stock) return { ok: false, code: 'warehouse_no_stock' };
            const available = Math.max(0, Number(stock.amount) - Number(stock.reservedAmount || 0));
            if (available < requested) return { ok: false, code: 'warehouse_item_reserved', available };
            const timestamp = now();
            const reservation = write(`INSERT INTO clan_warehouse_reservations
                (clanId, selfId, amount, beneficiaryId, goalKey, status, createdAt, updatedAt)
                VALUES (?, ?, ?, ?, ?, 'reserved', ?, ?)`, [clan, itemId, requested, beneficiaryId ? Number(beneficiaryId) : null, key, timestamp, timestamp]);
            write(`UPDATE clan_warehouse_items SET reservedAmount = reservedAmount + ?, updatedAt = ?
                WHERE id = ? AND clanId = ?`, [requested, timestamp, stock.id, clan]);
            const nextRevision = currentRevision + 1;
            const state = simulationState(simulation.stateJson, clan, previousState.leaderId, previousState.memberIds || [], timestamp);
            state.warehouseRevision = nextRevision;
            write('UPDATE clan_simulation_clans SET updatedAt = ?, stateJson = ? WHERE clanId = ?', [timestamp, JSON.stringify(state), clan]);
            return { ok: true, code: 'warehouse_item_reserved', reservationId: Number(reservation.insertId), warehouseRevision: nextRevision };
        }, 'clan-warehouse:reserve');
    },
    releaseClanWarehouseReservation({ clanId, selfId, goalKey, expectedWarehouseRevision = null } = {}) {
        const clan = Number(clanId);
        const itemId = Number(selfId);
        const key = String(goalKey || '').trim();
        if (!clan || !itemId || !key) return Promise.resolve({ ok: false, code: 'warehouse_transfer_failed' });
        return inTransaction(() => {
            const simulation = one('SELECT clanId, stateJson FROM clan_simulation_clans WHERE clanId = ?', [clan]);
            const reservation = one(`SELECT id, amount, status FROM clan_warehouse_reservations
                WHERE clanId = ? AND selfId = ? AND goalKey = ?`, [clan, itemId, key]);
            if (!simulation || !reservation) return { ok: false, code: 'warehouse_transfer_failed' };
            if (reservation.status !== 'reserved') return { ok: true, code: 'warehouse_reservation_released' };
            const previousState = jsonObject(simulation.stateJson);
            const currentRevision = Math.max(0, Number(previousState.warehouseRevision) || 0);
            if (expectedWarehouseRevision !== null && currentRevision !== Number(expectedWarehouseRevision)) {
                return { ok: false, code: 'ownership_conflict', warehouseRevision: currentRevision };
            }
            const stock = one(`SELECT id, reservedAmount FROM clan_warehouse_items
                WHERE clanId = ? AND selfId = ? AND amount > 0 ORDER BY id LIMIT 1`, [clan, itemId]);
            const timestamp = now();
            if (stock) write(`UPDATE clan_warehouse_items SET reservedAmount = MAX(0, reservedAmount - ?), updatedAt = ?
                WHERE id = ? AND clanId = ?`, [Number(reservation.amount), timestamp, stock.id, clan]);
            write(`UPDATE clan_warehouse_reservations SET status = 'released', updatedAt = ? WHERE id = ?`, [timestamp, reservation.id]);
            const nextRevision = currentRevision + 1;
            const state = simulationState(simulation.stateJson, clan, previousState.leaderId, previousState.memberIds || [], timestamp);
            state.warehouseRevision = nextRevision;
            write('UPDATE clan_simulation_clans SET updatedAt = ?, stateJson = ? WHERE clanId = ?', [timestamp, JSON.stringify(state), clan]);
            return { ok: true, code: 'warehouse_reservation_released', warehouseRevision: nextRevision };
        }, 'clan-warehouse:release');
    },
    advanceAutonomousClanLevel({
        clanId,
        fromLevel = 0,
        toLevel = 1,
        requiredAmount = 0,
        requiredItemId = 0,
        requiredItemAmount = requiredAmount
    } = {}) {
        const clan = Number(clanId);
        return inTransaction(() => {
            const simulation = one('SELECT clanId, stateJson FROM clan_simulation_clans WHERE clanId = ?', [clan]);
            const clanRow = one('SELECT id, level, leaderId FROM clans WHERE id = ?', [clan]);
            if (!simulation || !clanRow) return { ok: false, code: 'target_not_autonomous' };
            if (Number(clanRow.level) !== Number(fromLevel)) return { ok: false, code: 'level_already_advanced', level: Number(clanRow.level) };

            const itemId = Math.max(0, Number(requiredItemId) || 0);
            const required = Math.max(0, Math.floor(Number(itemId ? requiredItemAmount : requiredAmount) || 0));
            let contributed = 0;
            let warehouseAmount = 0;
            if (itemId > 0) {
                warehouseAmount = Number(one(`SELECT COALESCE(SUM(MAX(0, amount - reservedAmount)), 0) AS amount
                    FROM clan_warehouse_items WHERE clanId = ? AND selfId = ?`, [clan, itemId]).amount || 0);
                if (warehouseAmount < required) {
                    return { ok: false, code: 'warehouse_item_not_ready', warehouseAmount, requiredAmount: required, itemId };
                }
            } else {
                contributed = Number(one(`SELECT COALESCE(SUM(amount), 0) AS amount
                    FROM clan_contributions WHERE clanId = ? AND targetLevel = ?`, [clan, Number(fromLevel)]).amount || 0);
                if (contributed < required) {
                    return { ok: false, code: 'contribution_level_ready', contributed, requiredAmount: required };
                }
            }

            const updated = write('UPDATE clans SET level = ? WHERE id = ? AND level = ?', [Number(toLevel), clan, Number(fromLevel)]);
            if (updated.affectedRows !== 1) return { ok: false, code: 'level_already_advanced' };
            const previousState = jsonObject(simulation.stateJson);
            const timestamp = now();
            if (itemId > 0 && required > 0) {
                let remaining = required;
                const rows = all(`SELECT id, amount, reservedAmount FROM clan_warehouse_items
                    WHERE clanId = ? AND selfId = ? AND amount > reservedAmount ORDER BY id`, [clan, itemId]);
                rows.forEach((row) => {
                    if (remaining <= 0) return;
                    const available = Math.max(0, Number(row.amount) - Number(row.reservedAmount || 0));
                    const consumed = Math.min(available, remaining);
                    const nextAmount = Number(row.amount) - consumed;
                    if (nextAmount <= 0) write('DELETE FROM clan_warehouse_items WHERE id = ? AND clanId = ?', [row.id, clan]);
                    else write(`UPDATE clan_warehouse_items SET amount = ?, updatedAt = ? WHERE id = ? AND clanId = ?`, [nextAmount, timestamp, row.id, clan]);
                    remaining -= consumed;
                });
                if (remaining > 0) throw new Error('clan level-up warehouse changed');
                const nextWarehouseRevision = Math.max(0, Number(previousState.warehouseRevision) || 0) + 1;
                write(`INSERT INTO clan_warehouse_ledger
                    (clanId, characterId, selfId, amount, operation, resolveKey, warehouseRevision, createdAt)
                    VALUES (?, ?, ?, ?, 'level_up_consume', ?, ?, ?)`, [
                    clan,
                    Number(clanRow.leaderId),
                    itemId,
                    required,
                    `clan:${clan}:level:${Number(fromLevel)}:${Number(toLevel)}:${itemId}`,
                    nextWarehouseRevision,
                    timestamp
                ]);
                previousState.warehouseRevision = nextWarehouseRevision;
            }
            const state = simulationState(previousState, clan, clanRow.leaderId, previousState.memberIds || [], timestamp);
            state.level = Number(toLevel);
            state.goal = null;
            write('UPDATE clan_simulation_clans SET updatedAt = ?, stateJson = ? WHERE clanId = ?', [state.updatedAt, JSON.stringify(state), clan]);
            return {
                ok: true,
                code: itemId > 0 ? 'item_level_up' : 'contribution_level_up',
                clanId: clan,
                fromLevel: Number(fromLevel),
                toLevel: Number(toLevel),
                contributed,
                requiredAmount: required,
                requiredItemId: itemId,
                warehouseAmount,
                warehouseRevision: Number(state.warehouseRevision || 0)
            };
        }, 'clan-simulation:level-up');
    },
    fetchAutonomousClanCrests() {
        return run(`SELECT clans.id, clans.level, clans.crestId, crests.data AS crestData
            FROM clans
            JOIN clan_simulation_clans simulated ON simulated.clanId = clans.id
            LEFT JOIN clan_crests crests ON crests.id = clans.crestId AND crests.kind = 'pledge'
            WHERE simulated.mode = 'autonomous'
            ORDER BY clans.id ASC`, [], 'clan:crest-autonomous', true);
    },
    assignAutonomousClanCrest({ clanId, data, kind = 'pledge' } = {}) {
        const clan = Number(clanId);
        const crestData = Buffer.from(data || []);
        if (!clan || !crestData.length || !['pledge', 'ally'].includes(String(kind))) {
            return Promise.resolve({ ok: false, code: 'invalid_clan_crest' });
        }
        return inTransaction(() => {
            if (!one("SELECT clanId FROM clan_simulation_clans WHERE clanId = ? AND mode = 'autonomous'", [clan])) {
                return { ok: false, code: 'target_not_autonomous' };
            }
            const crestColumn = String(kind) === 'ally' ? 'allyCrestId' : 'crestId';
            const current = one(`SELECT level, ${crestColumn} AS crestId FROM clans WHERE id = ?`, [clan]);
            if (!current) return { ok: false, code: 'clan_missing' };
            if (String(kind) === 'pledge' && Number(current.level || 0) < 3) {
                return { ok: false, code: 'level_too_low' };
            }
            if (Number(current.crestId || 0) > 0) {
                return { ok: true, idempotent: true, crestId: Number(current.crestId) };
            }
            const created = write(`INSERT INTO clan_crests (clanId, kind, data, createdAt) VALUES (?, ?, ?, ?)`, [
                clan, String(kind), crestData, now()
            ]);
            const updated = write(`UPDATE clans SET ${crestColumn} = ? WHERE id = ? AND COALESCE(${crestColumn}, 0) = 0`, [created.insertId, clan]);
            if (Number(updated.affectedRows) !== 1) throw new Error('autonomous clan crest reservation changed');
            return { ok: true, crestId: Number(created.insertId) };
        }, 'clan:crest-autonomous-assign');
    },
    clearAutonomousClanCrest({ clanId, kind = 'pledge' } = {}) {
        const clan = Number(clanId);
        if (!clan || !['pledge', 'ally'].includes(String(kind))) {
            return Promise.resolve({ ok: false, code: 'invalid_clan_crest' });
        }
        return inTransaction(() => {
            if (!one("SELECT clanId FROM clan_simulation_clans WHERE clanId = ? AND mode = 'autonomous'", [clan])) {
                return { ok: false, code: 'target_not_autonomous' };
            }
            const crestColumn = String(kind) === 'ally' ? 'allyCrestId' : 'crestId';
            const current = one(`SELECT ${crestColumn} AS crestId FROM clans WHERE id = ?`, [clan]);
            if (!current) return { ok: false, code: 'clan_missing' };
            const crestId = Number(current.crestId || 0);
            if (!crestId) return { ok: true, idempotent: true, cleared: false };
            write(`UPDATE clans SET ${crestColumn} = 0 WHERE id = ?`, [clan]);
            write('DELETE FROM clan_crests WHERE id = ? AND clanId = ? AND kind = ?', [crestId, clan, String(kind)]);
            return { ok: true, cleared: true, crestId };
        }, 'clan:crest-autonomous-clear');
    },
    replacePlayerManagedClanCrest({ clanId, data } = {}) {
        const clan = Number(clanId);
        const crestData = Buffer.from(data || []);
        if (!clan) return Promise.resolve({ ok: false, code: 'invalid_clan_crest' });
        return inTransaction(() => {
            const current = one(`SELECT clans.level, clans.crestId
                FROM clans
                JOIN clan_simulation_clans simulated ON simulated.clanId = clans.id
                WHERE clans.id = ? AND simulated.mode = 'player_managed'`, [clan]);
            if (!current) return { ok: false, code: 'target_not_player_managed' };
            if (crestData.length && Number(current.level || 0) < 3) {
                return { ok: false, code: 'level_too_low' };
            }

            const previousCrestId = Number(current.crestId || 0);
            let crestId = 0;
            if (crestData.length) {
                const created = write(`INSERT INTO clan_crests (clanId, kind, data, createdAt)
                    VALUES (?, 'pledge', ?, ?)`, [clan, crestData, now()]);
                crestId = Number(created.insertId);
            }
            write('UPDATE clans SET crestId = ? WHERE id = ?', [crestId, clan]);
            if (previousCrestId > 0 && previousCrestId !== crestId) {
                write("DELETE FROM clan_crests WHERE id = ? AND clanId = ? AND kind = 'pledge'", [previousCrestId, clan]);
            }
            return { ok: true, clanId: clan, crestId, previousCrestId, deleted: crestId === 0 };
        }, 'clan:crest-player-managed-replace');
    },
    createClanCrest(clanId, kind, data) { return insert('clan_crests', { clanId, kind, data, createdAt: now() }, 'clan:crest-create'); },
    fetchClanCrest(id) { return selectOne('clan_crests', ['*'], 'id = ?', [id], 'clan:crest'); },
    createClan(data) { return insert('clans', { name: data.name, leaderId: data.leaderId }, 'clan:create'); },
    updateClanCrest(id, crestId) { return update('clans', { crestId }, 'id = ?', [id], 'clan:crest'); },
    updateClanLevel(id, level) { return update('clans', { level }, 'id = ?', [id], 'clan:level'); },
    updateCharacterClan(id, clanId, clanPrivileges, clanJoinExpiryTime, clanCreateExpiryTime) { return update('characters', { clanId, clanPrivileges, clanJoinExpiryTime, clanCreateExpiryTime }, 'id = ?', [id], 'character:clan'); },
    updateCharacterClanPrivileges(id, clanPrivileges) { return update('characters', { clanPrivileges }, 'id = ?', [id], 'character:clan-privileges'); },
    updateCharacterTitle(id, title) { return withCharacterFlush(id, () => update('characters', { title: String(title || '') }, 'id = ?', [id], 'character:title')); },
    updateAutonomousClanMemberTitles({ clanId, assignments = [] } = {}) {
        const clan = Number(clanId);
        const normalized = (assignments || []).map((entry) => ({
            characterId: Number(entry.characterId),
            title: String(entry.title || '').trim().replace(/\s+/g, ' ')
        }));
        const validTitle = (title) => /^[A-Za-z0-9][A-Za-z0-9 '&+.,:!?-]{1,31}$/.test(title);
        if (!clan || !normalized.length || normalized.some((entry) => !entry.characterId || !validTitle(entry.title))) {
            return Promise.resolve({ ok: false, code: 'invalid_clan_titles' });
        }
        return withCharacterFlushes(normalized.map((entry) => entry.characterId), () => inTransaction(() => {
            const simulated = one(`SELECT simulated.clanId, simulated.mode, clans.level
                FROM clan_simulation_clans simulated
                JOIN clans ON clans.id = simulated.clanId
                WHERE simulated.clanId = ?`, [clan]);
            if (!simulated || String(simulated.mode) !== 'autonomous') {
                return { ok: false, code: 'target_not_autonomous' };
            }
            if (Number(simulated.level) < 3) return { ok: false, code: 'level_too_low' };
            const ids = new Set();
            const titles = new Set();
            for (const assignment of normalized) {
                if (ids.has(assignment.characterId)) return { ok: false, code: 'duplicate_clan_title_member' };
                const titleKey = assignment.title.toLowerCase();
                if (titles.has(titleKey)) return { ok: false, code: 'duplicate_clan_title' };
                ids.add(assignment.characterId);
                titles.add(titleKey);
                const member = one('SELECT id, title FROM characters WHERE id = ? AND clanId = ?', [assignment.characterId, clan]);
                if (!member) return { ok: false, code: 'not_member' };
            }
            const existing = all(`SELECT LOWER(TRIM(title)) AS titleKey
                FROM characters
                WHERE clanId = ? AND TRIM(COALESCE(title, '')) <> ''`, [clan]);
            if (existing.some((entry) => titles.has(String(entry.titleKey || '')))) {
                return { ok: false, code: 'duplicate_clan_title' };
            }
            const updated = [];
            for (const assignment of normalized) {
                const current = one('SELECT title FROM characters WHERE id = ? AND clanId = ?', [assignment.characterId, clan]);
                if (String(current?.title || '').trim()) continue;
                const result = write('UPDATE characters SET title = ? WHERE id = ? AND clanId = ?', [
                    assignment.title, assignment.characterId, clan
                ]);
                if (Number(result.affectedRows || 0) === 1) updated.push(assignment);
            }
            return { ok: true, clanId: clan, updated };
        }, 'clan-title:apply'));
    },
    removeCharacterFromClan(id) {
        return withCharacterFlush(id, () => update('characters', {
            clanId: 0,
            clanPrivileges: 0,
            clanJoinExpiryTime: 0,
            clanCreateExpiryTime: 0,
            title: ''
        }, 'id = ?', [id], 'character:clan-remove'));
    },
    dissolveClan({ clanId, leaderId } = {}) {
        const id = Number(clanId);
        const leader = Number(leaderId);
        if (!id || !leader) return Promise.resolve({ ok: false, code: 'invalid_clan' });

        return select('characters', ['id'], 'clanId = ?', [id], 'clan:dissolve-members')
            .then((members) => withCharacterFlushes(members.map((member) => member.id), () => inTransaction(() => {
                const clan = one('SELECT id, leaderId FROM clans WHERE id = ?', [id]);
                if (!clan) return { ok: false, code: 'clan_missing' };
                if (Number(clan.leaderId) !== leader) return { ok: false, code: 'not_leader' };

                const currentMembers = all('SELECT id FROM characters WHERE clanId = ? ORDER BY id', [id]);
                write(`UPDATE characters
                    SET clanId = 0,
                        clanPrivileges = 0,
                        clanJoinExpiryTime = 0,
                        clanCreateExpiryTime = 0,
                        title = ''
                    WHERE clanId = ?`, [id]);
                write('DELETE FROM clans WHERE id = ?', [id]);
                return { ok: true, clanId: id, memberIds: currentMembers.map((member) => Number(member.id)) };
            }, 'clan:dissolve')));
    },
    deleteGearItems(characterId) { return withCharacterFlush(characterId, () => remove('items', 'characterId = ? AND selfId != 57', [characterId], 'item:delete-gear')); },
    setShortcut(characterId, shortcut) { return run(`INSERT INTO shortcuts (id, kind, slot, unknown, characterId) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(characterId, slot) DO UPDATE SET id = excluded.id, kind = excluded.kind, unknown = excluded.unknown`, [shortcut.id, shortcut.kind, shortcut.slot, shortcut.unknown, characterId], 'shortcut:upsert'); },
    fetchShortcuts(characterId) { return select('shortcuts', ['*'], 'characterId = ?', [characterId], 'shortcut:list'); },
    deleteShortcut(characterId, slot) { return remove('shortcuts', 'slot = ? AND characterId = ?', [slot, characterId], 'shortcut:delete'); },
    deleteShortcuts(characterId) { return remove('shortcuts', 'characterId = ?', [characterId], 'shortcut:delete-all'); },
    setMacro(characterId, macro) { return run(UPSERT_MACRO, [characterId, macro.id, macro.icon, macro.name, macro.descr, macro.acronym, JSON.stringify(macro.commands)], 'macro:upsert'); },
    fetchMacros(characterId) { return select('macros', ['*'], 'characterId = ?', [characterId], 'macro:list').then((rows) => rows.map((row) => ({ ...row, commands: (() => { try { return JSON.parse(row.commands); } catch (_) { return []; } })() }))); },
    deleteMacro(characterId, macroId) { return remove('macros', 'characterId = ? AND id = ?', [characterId, macroId], 'macro:delete'); },
    deleteMacros(characterId) { return remove('macros', 'characterId = ?', [characterId], 'macro:delete-all'); },
    deleteMacroShortcuts(characterId, macroId) { return remove('shortcuts', 'characterId = ? AND kind = 4 AND id = ?', [characterId, macroId], 'shortcut:delete-macro'); },
    updateCharacterLocation(id, coords) { return withCharacterFlush(id, () => update('characters', { locX: coords.locX, locY: coords.locY, locZ: coords.locZ, head: coords.head ?? -1 }, 'id = ?', [id], 'character:location')); },
    updateCharacterName(id, name) { return withCharacterFlush(id, () => update('characters', { name }, 'id = ?', [id], 'character:name')); },
    updateGeneratedBotAppearance(id, sex, appearanceVersion) {
        const characterId = Number(id);
        const normalizedSex = Number(sex) & 1;
        const version = Math.max(1, Number(appearanceVersion) || 1);
        if (!Number.isSafeInteger(characterId) || characterId <= 0) {
            return Promise.resolve({ ok: false, reason: 'invalid_character' });
        }
        return withCharacterFlush(characterId, () => inTransaction(() => {
            const character = write('UPDATE characters SET sex = ? WHERE id = ?', [normalizedSex, characterId]);
            const state = write(`UPDATE bot_life_state
                SET statsJson = json_set(
                    COALESCE(statsJson, '{}'),
                    '$.sex', ?,
                    '$.appearanceVersion', ?
                )
                WHERE characterId = ?`, [normalizedSex, version, characterId]);
            if (character.affectedRows !== 1 || state.affectedRows !== 1) {
                const error = new Error(`generated appearance target missing for ${characterId}`);
                error.code = 'BOT_APPEARANCE_TARGET_MISSING';
                throw error;
            }
            return { ok: true, characterId, sex: normalizedSex, appearanceVersion: version };
        }, 'bot-life:generated-appearance'));
    },
    updateCharacterExperience(id, level, exp, sp) { return withCharacterFlush(id, () => update('characters', { level, exp, sp }, 'id = ?', [id], 'character:experience')); },
    updateCharacterVitals(id, hp, maxHp, mp, maxMp) { return withCharacterFlush(id, () => update('characters', { hp, maxHp, mp, maxMp }, 'id = ?', [id], 'character:vitals')); },
    updateCharacterStatus(id, { hp, mp, cp, effects }) { return withCharacterFlush(id, () => update('characters', { hp, mp, cp, effects }, 'id = ?', [id], 'character:status')); },
    updateCharacterPvpPkKarma(id, pvp, pk, karma) { return withCharacterFlush(id, () => update('characters', { pvp, pk, karma }, 'id = ?', [id], 'character:karma')); },
    updateCharacterClassId(id, classId) { return withCharacterFlush(id, () => update('characters', { classId }, 'id = ?', [id], 'character:class')); }
};

module.exports = Database;
