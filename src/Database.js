const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

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

const Database = {
    init(callback = () => {}) {
        try {
            shuttingDown = false;
            closePromise = null;
            databasePath = databaseFile();
            fs.mkdirSync(path.dirname(databasePath), { recursive: true });
            connection = new DatabaseSync(databasePath, { timeout: 5000 });
            connection.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA temp_store = MEMORY;');
            connection.exec(fs.readFileSync(path.join(process.cwd(), 'database', 'sql', 'sqlite.sql'), 'utf8'));
            applySchemaMigrations();
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
        const patch = { ...(request.patch || {}) };
        const invalidColumn = Object.keys(patch).find((column) => !COLD_SIMULATION_PATCH_COLUMNS.has(column));
        if (!Number.isSafeInteger(characterId) || characterId <= 0) return Promise.resolve({ ok: false, reason: 'invalid_character' });
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return Promise.resolve({ ok: false, reason: 'invalid_revision' });
        if (ownerId !== COLD_SIMULATION_OWNER || !leaseId || leaseUntil <= timestamp) return Promise.resolve({ ok: false, reason: 'invalid_lease' });
        if (invalidColumn) return Promise.resolve({ ok: false, reason: 'invalid_patch', column: invalidColumn });

        return inTransaction(() => {
            const row = coldSimulationRow(characterId);
            const conflict = coldSimulationConflict(row, { expectedRevision, ownerId, leaseId }, timestamp);
            if (conflict !== 'cas_failed') return { ok: false, reason: conflict };
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
                    const invalidColumn = Object.keys(request.patch || {})
                        .find((column) => !COLD_SIMULATION_PATCH_COLUMNS.has(column));
                    const row = coldSimulationRow(characterId);
                    const conflict = coldSimulationConflict(row, { expectedRevision, ownerId, leaseId }, timestamp);
                    const proposed = { ...row, ...(request.patch || {}), phase: request.patch?.phase || row?.phase, activity: request.patch?.activity || row?.activity };
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
            const patch = { ...(request.patch || {}) };
            const invalidColumn = Object.keys(patch).find((column) => !COLD_SIMULATION_PATCH_COLUMNS.has(column));
            if (!Number.isSafeInteger(characterId) || characterId <= 0) return { ok: false, characterId, reason: 'invalid_character' };
            if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return { ok: false, characterId, reason: 'invalid_revision' };
            if (ownerId !== COLD_SIMULATION_OWNER || !leaseId) return { ok: false, characterId, reason: 'invalid_lease' };
            if (invalidColumn) return { ok: false, characterId, reason: 'invalid_patch', column: invalidColumn };
            const row = coldSimulationRow(characterId);
            const conflict = coldSimulationConflict(row, { expectedRevision, ownerId, leaseId }, timestamp);
            if (conflict !== 'cas_failed') return { ok: false, characterId, reason: conflict };
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
        return inTransaction(() => {
            const row = coldSimulationRow(characterId);
            if (!row) return { ok: false, reason: 'missing_state' };
            const revision = Number(row.simulationRevision || 0);
            if (expectedRevision !== null && revision !== expectedRevision) return { ok: false, reason: 'stale_revision' };
            const ownerId = String(row.simulationOwner || LEGACY_SIMULATION_OWNER);
            if (ownerId === LEGACY_SIMULATION_OWNER) {
                return { ok: true, characterId, ownerId, leaseId: null, revision, leaseUntil: 0, reason: 'already_main' };
            }
            if (ownerId !== COLD_SIMULATION_OWNER) return { ok: false, reason: 'owner_changed' };
            const nextRevision = revision + 1;
            const result = write(`UPDATE bot_life_state
                SET simulationOwner = ?, simulationRevision = ?, simulationLeaseId = NULL, simulationLeaseUntil = 0
                WHERE characterId = ? AND simulationOwner = ? AND simulationRevision = ?`, [
                LEGACY_SIMULATION_OWNER, nextRevision, characterId, ownerId, revision
            ]);
            if (result.affectedRows !== 1) return { ok: false, reason: 'cas_failed' };
            return { ok: true, characterId, ownerId: LEGACY_SIMULATION_OWNER, leaseId: null, revision: nextRevision, leaseUntil: 0, reason: 'hot_handoff' };
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
        closePromise = pending.then(() => {
            if (!connection) return false;
            const openConnection = connection;
            connection = null;
            openConnection.close();
            queryTail = Promise.resolve();
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
            operations
        };
        if (resetPeak) metrics.maxPending = metrics.pending;
        return snapshot;
    },

    checkpoint() {
        return enqueue(() => normalizeRows(connection.prepare('PRAGMA wal_checkpoint(PASSIVE)').all()), { operation: 'maintenance:checkpoint', read: false });
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
            const warehouseId = target ? target.id : write('INSERT INTO warehouse_items (selfId, name, amount, enchant, petData, characterId) VALUES (?, ?, ?, ?, ?, ?)', [item.selfId, item.name || '', item.amount, sourceEnchant, item.petData ? JSON.stringify(item.petData) : null, characterId]).insertId;
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
    createClanCrest(clanId, kind, data) { return insert('clan_crests', { clanId, kind, data, createdAt: now() }, 'clan:crest-create'); },
    fetchClanCrest(id) { return selectOne('clan_crests', ['*'], 'id = ?', [id], 'clan:crest'); },
    createClan(data) { return insert('clans', { name: data.name, leaderId: data.leaderId }, 'clan:create'); },
    updateClanCrest(id, crestId) { return update('clans', { crestId }, 'id = ?', [id], 'clan:crest'); },
    updateClanLevel(id, level) { return update('clans', { level }, 'id = ?', [id], 'clan:level'); },
    updateCharacterClan(id, clanId, clanPrivileges, clanJoinExpiryTime, clanCreateExpiryTime) { return update('characters', { clanId, clanPrivileges, clanJoinExpiryTime, clanCreateExpiryTime }, 'id = ?', [id], 'character:clan'); },
    updateCharacterClanPrivileges(id, clanPrivileges) { return update('characters', { clanPrivileges }, 'id = ?', [id], 'character:clan-privileges'); },
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
    updateCharacterExperience(id, level, exp, sp) { return withCharacterFlush(id, () => update('characters', { level, exp, sp }, 'id = ?', [id], 'character:experience')); },
    updateCharacterVitals(id, hp, maxHp, mp, maxMp) { return withCharacterFlush(id, () => update('characters', { hp, maxHp, mp, maxMp }, 'id = ?', [id], 'character:vitals')); },
    updateCharacterStatus(id, { hp, mp, cp, effects }) { return withCharacterFlush(id, () => update('characters', { hp, mp, cp, effects }, 'id = ?', [id], 'character:status')); },
    updateCharacterPvpPkKarma(id, pvp, pk, karma) { return withCharacterFlush(id, () => update('characters', { pvp, pk, karma }, 'id = ?', [id], 'character:karma')); },
    updateCharacterClassId(id, classId) { return withCharacterFlush(id, () => update('characters', { classId }, 'id = ?', [id], 'character:class')); }
};

module.exports = Database;
