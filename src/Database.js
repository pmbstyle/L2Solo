const BeginnerShots = require('./GameServer/Items/C4BeginnerShots');
const fs = require('fs');
const DiagnosticConfig = require('./GameServer/Bot/Population/PopulationConfig');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { AsyncLocalStorage } = require('node:async_hooks');
const mutationAdmission = new AsyncLocalStorage();
function checkMutationAdmission() {
    const guard = mutationAdmission.getStore();
    if (guard && guard() !== undefined) throw new TypeError('invalid_mutation_admission');
}
const Statements = require('./DatabaseStatements');
const MarketTradeOverview = require('./MarketTradeOverview');
const EconomyJournal = require('./EconomyJournal');
const PvpJournal = require('./PvpJournal');
const CheckpointCoordinator = require('./DatabaseCheckpointCoordinator');
const HistoryStore = require('./HistoryStore');
const History = require('./HistoryDatabase');
const { XP_DIVIDER: KARMA_XP_DIVIDER } = require('./GameServer/Karma');
const InteractionMemoryPolicy = require('./GameServer/Social/InteractionMemoryPolicy');
const ClanNameCatalog = require('./GameServer/Clan/ClanNameCatalog');
const BoardRules = require('./GameServer/AfkTrade/BoardRules');
const BotErrands = require('./GameServer/Bot/Population/BotErrands');
const ColdProtocol = require('./GameServer/Bot/Population/ColdSimulationProtocol');
const NativeWriteCheckpoint = require('./GameServer/Bot/Population/NativeWriteCheckpoint');
const EconomyCommit = require('./GameServer/Bot/Economy/EconomyCommit');
const Diagnostics = require('./GameServer/Bot/Economy/EconomyDiagnostics');
let nativeDiagnosticFacts = null;
let nativeDiagnosticCounts = null;
let nativeDiagnosticOverflow = 0;
function stageNativeDiagnostic(characterId, step, phase, reason, fields) {
    if (!Diagnostics.active()) return;
    try {
        nativeDiagnosticCounts ||= new Map();
        const key = `${phase}:${reason}`, previous = nativeDiagnosticCounts.get(key);
        if (previous) previous.count++;
        else if (nativeDiagnosticCounts.size < 64) nativeDiagnosticCounts.set(key, { phase, reason, count: 1 });
        else nativeDiagnosticOverflow++;
        if (!Diagnostics.enabled(characterId)) return;
        if ((nativeDiagnosticFacts?.length || 0) >= 64) { Diagnostics.noteDropped(1); return; }
        nativeDiagnosticFacts ||= [];
        nativeDiagnosticFacts.push(Object.freeze({ ...fields, owner: Number(characterId), phase, reason, at: Date.now(),
            commandId: step?.command?.[0], commandKind: step?.command?.[1], sequence: step?.command?.[2],
            revision: Number(step?.row?.simulationRevision) }));
    } catch (_) { /* Observations cannot abort the physical transaction. */ }
}
function publishNativeDiagnostics(rolledBack = null) {
    const counts = nativeDiagnosticCounts, facts = nativeDiagnosticFacts, overflow = nativeDiagnosticOverflow;
    // Release transaction ownership before calling any observational consumer.
    nativeDiagnosticCounts = null; nativeDiagnosticFacts = null; nativeDiagnosticOverflow = 0;
    if (!counts && !facts && !overflow) return;
    const count = (...args) => { try { Diagnostics.count(...args); } catch (_) { /* Keep the native result. */ } };
    if (counts) {
        if (rolledBack) count('native', 'transaction', 'rolled_back');
        for (const row of counts.values()) {
            // Attempts and refusals are real even when the proposed effects roll back.
            const layer = rolledBack && row.phase !== 'native_attempt' && row.phase !== 'native_refusal'
                ? 'native_rollback' : 'native';
            count(layer, row.phase, row.reason, row.count);
        }
    }
    if (overflow) count('native', 'aggregate_overflow', rolledBack ? 'rolled_back' : 'committed', overflow);
    if (!facts) return;
    for (const row of facts) {
        try {
            Diagnostics.push(rolledBack ? { ...row, outcome: 'rolled_back',
                reason: row.phase === 'native_refusal' ? row.reason : rolledBack,
                planned: row.planned ?? row.actual, actual: 0, spent: 0,
                ...(row.goalApplied === undefined ? {} : { goalApplied: 0 }) } : { ...row, outcome: 'committed' });
        } catch (_) { /* Observations cannot change native results or errors. */ }
    }
}

function invalidNpcPurchase(characterId, step, line, lineId, reason, field, value, details, message = 'invalid npc purchase') {
    if (Diagnostics.active()) {
        try {
            const numeric = Number(value);
            const kind = Number.isNaN(numeric) ? 'NaN' : !Number.isFinite(numeric) ? String(numeric)
                : !Number.isInteger(numeric) ? 'fractional' : !Number.isSafeInteger(numeric) ? 'unsafe_integer'
                    : numeric <= 0 ? 'nonpositive' : 'finite';
            stageNativeDiagnostic(characterId, step, 'native_refusal', reason, {
                item: Number(line.selfId), requested: Number(line.amount), unitPrice: Number(line.unitPrice),
                cost: Number(line.amount) * Number(line.unitPrice), after: numeric, lineId,
                caller: details.diagnosticCaller || 'purchaseNpcInventoryBasket', source: step?.row?.phase || 'legacy',
                trigger: `${field}:${typeof value}:${kind}`, actual: 0, spent: 0
            });
        } catch (_) { /* Input observations preserve the original refusal. */ }
    }
    return Error(message);
}

let connection;
let queryTail = Promise.resolve();
let shuttingDown = false;
let closePromise = null;
let databasePath;
let historyPath;
let boardDealCountsReady = false;
let boardCounterCountsReady = false;
let flushPendingCharacterWrites = null;
const MARKET_TRADE_RETENTION_MS = HistoryStore.MARKET_TRADE_RETENTION_MS;
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
    byOperation: null
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
    if (!DiagnosticConfig.developerDiagnostics) return;
    metrics.byOperation ||= new Map();
    if (!metrics.byOperation.has(operation) && metrics.byOperation.size >= 127) operation = 'other';
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

function enqueue(work, { operation = 'raw', read = false, onTiming = null } = {}) {
    if (shuttingDown) {
        return Promise.reject(new Error(`SQLite shutdown is in progress (${operation})`));
    }
    const timed = DiagnosticConfig.developerDiagnostics;
    const queuedAt = timed ? now() : 0;
    metrics.pending += 1;
    if (timed) metrics.maxPending = Math.max(metrics.maxPending, metrics.pending);
    const execute = () => {
        const startedAt = timed ? now() : 0;
        const wait = startedAt - queuedAt;
        EconomyJournal.begin(operation);
        try {
            const result = work();
            EconomyJournal.commit();
            if (timed) record(operation, wait, now() - startedAt, read);
            return result;
        } catch (error) {
            EconomyJournal.discard();
            if (timed) record(operation, wait, now() - startedAt, read, true);
            throw error;
        } finally {
            metrics.pending -= 1;
            if (typeof onTiming === 'function') {
                // Observability must never turn a committed operation into a failure.
                try { onTiming(timed ? { waitMs: wait, runMs: now() - startedAt } : undefined); }
                catch (_) { /* Timing delivery is best effort. */ }
            }
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

function run(sql, params = [], operation, readOverride = null, onTiming = null) {
    const read = readOverride === null ? isReadStatement(sql) : !!readOverride;
    return enqueue(() => {
        if (!connection) throw new Error(`SQLite is not initialized (${operation || operationName(sql)})`);
        const statement = Statements.prepare(connection, sql);
        if (!isReadStatement(sql)) checkMutationAdmission();
        if (read) return normalizeRows(statement.all(...params));
        const result = statement.run(...params);
        return {
            affectedRows: Number(result.changes || 0),
            insertId: Number(result.lastInsertRowid || 0)
        };
    }, { operation: operation || operationName(sql), read, onTiming });
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

const ECONOMY_JOURNAL_FLUSH_MS = 60 * 1000;
let economyJournalTimer = null;
let economyJournalComplete = false;

function historyFile() {
    return HistoryStore.pathFor(databaseFile(), options.default.Database?.historyPath || '');
}

// A history row written inside the current world transaction: one small
// outbox row; the history thread moves it into the history file (HistoryStore
// APPLY[kind]). Returns the outbox id, which is also the id of an AFK trade
// event or a clan goal event.
function historyOutboxUnsafe(kind, payload) {
    return write('INSERT INTO history_outbox (kind, payload) VALUES (?, ?)', [kind, JSON.stringify(payload)]).insertId;
}

// The history thread moved the outbox rows up to `upTo`; delete them from the
// world through the write queue, one delete at a time.
let outboxDeletedUpTo = 0;
let outboxDeleteWanted = 0;
let outboxDeleting = false;
function deleteMovedOutbox(upTo) {
    outboxDeleteWanted = Math.max(outboxDeleteWanted, Number(upTo) || 0);
    if (outboxDeleting || outboxDeleteWanted <= outboxDeletedUpTo || shuttingDown) return;
    outboxDeleting = true;
    const target = outboxDeleteWanted;
    enqueue(() => write('DELETE FROM history_outbox WHERE id <= ?', [target]), { operation: 'history:outbox-delete' })
        .then(() => { outboxDeletedUpTo = target; })
        .catch(() => null)
        .finally(() => {
            outboxDeleting = false;
            if (outboxDeleteWanted > outboxDeletedUpTo) deleteMovedOutbox(outboxDeleteWanted);
        });
}

// Waits until every write queued before the call is committed and moved into
// the history file, so a history reader sees what the world already holds.
function flushHistory() {
    return enqueue(() => null, { operation: 'history:barrier', read: true })
        .then(() => History.flush())
        .catch((error) => utils.infoWarn('DB', 'history flush failed: %s', error.message));
}

function readHistory(work, operation) {
    return flushHistory().then(() => enqueue(work, { operation, read: true }));
}

// Writes the economy and PvP journals gathered in memory as one history row;
// the history thread adds them up and prunes old rows (HistoryStore).
function flushJournals() {
    return enqueue(() => {
        if (!economyJournalComplete) economyJournalComplete = EconomyJournal.attachMissing(connection);
        const rows = EconomyJournal.snapshot();
        const conflicts = PvpJournal.snapshot();
        if (!rows.length && !conflicts.length) return 0;
        if (DiagnosticConfig.developerDiagnostics) metrics.transactions += 1;
        connection.exec('BEGIN IMMEDIATE');
        try {
            historyOutboxUnsafe('journal', { rows, conflicts });
            connection.exec('COMMIT');
        } catch (error) {
            try { connection.exec('ROLLBACK'); } catch (_) { /* preserve the write failure */ }
            throw error;
        }
        // This synchronous write-queue job cannot interleave with producers.
        // Keep both buffers intact until their outbox transaction commits.
        EconomyJournal.drain();
        PvpJournal.drain();
        return rows.length + conflicts.length;
    }, { operation: 'journal:flush' });
}

function startEconomyJournal() {
    EconomyJournal.attach(connection);
    economyJournalComplete = false;
    clearInterval(economyJournalTimer);
    economyJournalTimer = setInterval(() => {
        flushJournals().catch((error) => utils.infoWarn('DB', 'journal flush failed: %s', error.message));
    }, ECONOMY_JOURNAL_FLUSH_MS);
    economyJournalTimer.unref?.();
}

function cleanZeroAmountItems() {
    return run('DELETE FROM items WHERE amount <= 0', [], 'maintenance:zero-items');
}

// ARCH-NOTE: Failure-only diagnostics retain native rejection identity and existing SQL accounting.
// The configured timeout is a source value, not a sampled PRAGMA; SQL/parameters are omitted.
function reportTransactionSqliteFailure(operation, phase, error) {
    try {
        if (error?.code !== 'ERR_SQLITE_ERROR') return;
        if (!DiagnosticConfig.developerDiagnostics) {
            console.warn('DB          :: sqlite transaction failure %s %s %s', operation, phase, error.code);
            return;
        }
        const frames = String(error.stack || '').split('\n')
            .filter(line => /^\s+at /.test(line)).slice(0, 8);
        console.warn('DB          :: sqlite transaction failure %s', JSON.stringify({
            operation, phase, code: error.code, sqliteCode: error.errcode ?? null,
            sqliteReason: error.errstr ?? null, configuredWriterBusyTimeoutMs: 5000,
            frames
        }));
    } catch (_) { /* Logging must preserve the original SQLite rejection. */ }
}

// ARCH-NOTE: A queued lifecycle save can reject a stale native command before
// SQL. Failure-only diagnostics distinguish that admission from a SQLite fault
// without changing either rejection identity or the existing failure counters.
function reportBotLifeSaveFailure(phase, error) {
    try {
        if (!DiagnosticConfig.developerDiagnostics) {
            console.warn('DB          :: bot life save failure %s %s', phase, error?.message || 'unknown');
            return;
        }
        const { WorkerCommandAdmissionRefusal } = require('./GameServer/Bot/Population/WorkerCommandAdmission');
        const reasons = ['stale_worker_source', 'coordinator_stopping', 'missing_state',
            'hot_handoff_fenced', 'stale_command', 'invalid_worker_admission'];
        const frames = String(error?.stack || '').split('\n')
            .filter(line => /^\s+at /.test(line)).slice(0, 8);
        console.warn('DB          :: bot life save failure %s', JSON.stringify({
            operation: 'bot-life:save', phase, errorName: error?.name ?? null, code: error?.code ?? null,
            sqliteCode: error?.errcode ?? null, sqliteReason: error?.errstr ?? null,
            admissionRefusalReason: error instanceof WorkerCommandAdmissionRefusal
                && reasons.includes(error.message) ? error.message : null,
            configuredWriterBusyTimeoutMs: 5000, frames
        }));
    } catch (_) { /* Diagnostics must preserve the original save rejection. */ }
}

function performTransaction(work, operation) {
        if (DiagnosticConfig.developerDiagnostics) metrics.transactions += 1;
        try {
            connection.exec('BEGIN IMMEDIATE');
        } catch (error) {
            reportTransactionSqliteFailure(operation, 'begin', error);
            throw error;
        }
        pendingSettlementUndo = new Map();
        nativeDiagnosticFacts = null; nativeDiagnosticCounts = null; nativeDiagnosticOverflow = 0;
        let phase = 'work';
        try {
            const result = work();
            phase = 'commit';
            connection.exec('COMMIT');
            publishNativeDiagnostics();
            return result;
        } catch (error) {
            reportTransactionSqliteFailure(operation, phase, error);
            try {
                connection.exec('ROLLBACK');
            } finally {
                boardDealCountsReady = false;
                boardCounterCountsReady = false;
                for (const [ownerId, pending] of pendingSettlementUndo) {
                    if (pending) pendingSettlementOwners.add(ownerId);
                    else pendingSettlementOwners.delete(ownerId);
                }
                publishNativeDiagnostics(error?.message || 'rollback');
            }
            throw error;
        } finally {
            nativeDiagnosticFacts = null; nativeDiagnosticCounts = null; nativeDiagnosticOverflow = 0;
            pendingSettlementUndo = null;
        }
}

async function inTransaction(work, operation = 'transaction') {
    return enqueue(() => performTransaction(work, operation), { operation, read: false });
}

// ARCH-NOTE: Hall input reads/planning join the existing write queue before
// BEGIN, eliminating intervening local queued writes without widening the lock.
// Native total_changes/data_version CAS still checks all planning-time writes.
async function inPreparedTransaction(prepare, operation) {
    return enqueue(() => {
        const prepared = prepare();
        if (prepared && typeof prepared.then === 'function')
            throw new TypeError('prepared_transaction_must_be_synchronous');
        return typeof prepared === 'function' ? performTransaction(prepared, operation) : prepared;
    }, { operation, read: false });
}

// ARCH-NOTE: One bounded queue admission; each clan still prepares before its
// own BEGIN and commits independently. Journal each durable child before the
// next child so a later rollback cannot discard an earlier committed flow.
function syncPreparedHook(hook, ...args) {
    if (!hook) return;
    const result = hook(...args);
    if (result && typeof result.then === 'function')
        throw new TypeError('prepared_transaction_hook_must_be_synchronous');
    return result;
}

async function inPreparedTransactionBatch(items, prepare, hooks, operation) {
    const count = Array.isArray(items) ? items.length : -1;
    if (count < 0 || count > 4)
        throw new RangeError('prepared_transaction_batch_bound');
    // Capture bounded inputs before callbacks or queue wait; later caller
    // mutation cannot admit extra clans or replace the deadline/hook references.
    const admitted = new Array(count);
    for (let index = 0; index < count; index++) admitted[index] = items[index];
    Object.freeze(admitted);
    const { deadline, before, failed, committed } = hooks || {};
    if (!Number.isFinite(deadline))
        throw new TypeError('prepared_transaction_deadline_required');
    if (deadline > Date.now() + 40)
        throw new RangeError('prepared_transaction_deadline_bound');
    if (!admitted.length || Date.now() >= deadline) return [];
    // Match the original loop's first call admission/deletion before it waits
    // on the queue. Later wakeups for this ID must survive that wait.
    try { syncPreparedHook(before, admitted[0]); }
    catch (error) { syncPreparedHook(failed, admitted[0], error); throw error; }
    const firstTimestamp = Date.now();
    let entered = false;
    return enqueue(() => {
        entered = true;
        const completed = [];
        for (let index = 0; index < admitted.length; index++) {
            if (index > 0 && Date.now() >= deadline) break;
            const id = admitted[index];
            let value;
            try {
                if (index > 0) syncPreparedHook(before, id);
                EconomyJournal.begin(operation);
                const prepared = prepare(id, index === 0 ? firstTimestamp : Date.now());
                if (prepared && typeof prepared.then === 'function')
                    throw new TypeError('prepared_transaction_must_be_synchronous');
                value = typeof prepared === 'function' ? performTransaction(prepared, operation) : prepared;
                EconomyJournal.commit();
            } catch (error) {
                EconomyJournal.discard();
                syncPreparedHook(failed, id, error);
                throw error;
            }
            try {
                completed.push({ id, result: committed ? syncPreparedHook(committed, id, value) : value });
            } catch (error) {
                syncPreparedHook(failed, id, error);
                // The previous single-clan tx continuation also rejects after
                // SQL queue success. Keep that native counter/error boundary.
                return { completed, afterCommitError: error };
            }
        }
        return { completed };
    }, { operation, read: false }).catch(error => {
        if (!entered) syncPreparedHook(failed, admitted[0], error);
        throw error;
    }).then(result => {
        if (Object.hasOwn(result, 'afterCommitError')) throw result.afterCommitError;
        return result.completed;
    });
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

            // A new world keeps bot_life_events in the history file only.
            const lifeEventsHere = !!connection.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'bot_life_events'").get();
            const routineEventsRemoved = !lifeEventsHere ? 0 : Number(connection.prepare(`DELETE FROM bot_life_events
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
        }],
        [31, () => connection.exec(`
            CREATE TABLE IF NOT EXISTS afk_trade_shops (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ownerId INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
                storeType INTEGER NOT NULL CHECK(storeType IN (1, 3)),
                status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'closed', 'filled')),
                title TEXT NOT NULL DEFAULT '',
                town TEXT,
                locX INTEGER NOT NULL,
                locY INTEGER NOT NULL,
                locZ INTEGER NOT NULL,
                head INTEGER NOT NULL DEFAULT 0,
                appearanceJson TEXT NOT NULL DEFAULT '{}',
                packageSale INTEGER NOT NULL DEFAULT 0,
                escrowAdena INTEGER NOT NULL DEFAULT 0 CHECK(escrowAdena >= 0),
                revision INTEGER NOT NULL DEFAULT 1,
                createdAt INTEGER NOT NULL,
                updatedAt INTEGER NOT NULL,
                closedAt INTEGER
            );
            CREATE UNIQUE INDEX IF NOT EXISTS afk_trade_shops_active_owner
                ON afk_trade_shops(ownerId) WHERE status = 'active';
            CREATE INDEX IF NOT EXISTS afk_trade_shops_active_market
                ON afk_trade_shops(status, town, storeType, updatedAt);

            CREATE TABLE IF NOT EXISTS afk_trade_lines (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                shopId INTEGER NOT NULL REFERENCES afk_trade_shops(id) ON DELETE CASCADE,
                sourceObjectId INTEGER,
                selfId INTEGER NOT NULL,
                name TEXT NOT NULL DEFAULT '',
                count INTEGER NOT NULL CHECK(count >= 0),
                initialCount INTEGER NOT NULL CHECK(initialCount > 0),
                price INTEGER NOT NULL CHECK(price >= 0),
                enchant INTEGER NOT NULL DEFAULT 0 CHECK(enchant >= 0),
                slot INTEGER NOT NULL DEFAULT 0,
                stackable INTEGER NOT NULL DEFAULT 0,
                petData TEXT,
                createdAt INTEGER NOT NULL,
                updatedAt INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS afk_trade_lines_shop_item
                ON afk_trade_lines(shopId, selfId, count);

            CREATE TABLE IF NOT EXISTS afk_trade_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                shopId INTEGER REFERENCES afk_trade_shops(id) ON DELETE SET NULL,
                ownerId INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
                counterpartyId INTEGER REFERENCES characters(id) ON DELETE SET NULL,
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
        `)],
        [32, () => connection.exec(`
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
            INSERT OR IGNORE INTO market_trades (
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
            FROM afk_trade_events events
            LEFT JOIN afk_trade_shops shops ON shops.id = events.shopId
            LEFT JOIN characters owner ON owner.id = events.ownerId
            LEFT JOIN characters counterparty ON counterparty.id = events.counterpartyId;
        `)],
        [33, () => connection.exec(`
            CREATE INDEX IF NOT EXISTS bot_goal_state_review_queue ON bot_goal_state(
                updatedAt,
                COALESCE(CAST(json_extract(goalJson, '$.nextReviewAt') AS INTEGER), 0),
                characterId
            );
            CREATE INDEX IF NOT EXISTS bot_life_state_goal_review
                ON bot_life_state(characterId, updatedAt)
                WHERE phase = 'cold'
                AND (partyId IS NULL OR partyId = '')
                AND activity NOT IN ('traveling', 'shopping', 'merchant', 'crafting');
            CREATE INDEX IF NOT EXISTS warehouse_items_positive_self_owner
                ON warehouse_items(selfId, characterId) WHERE amount > 0;
            CREATE INDEX IF NOT EXISTS bot_life_state_warehouse_release
                ON bot_life_state(characterId, updatedAt)
                WHERE phase = 'cold' AND simulationOwner = 'legacy_main'
                AND accountName NOT LIKE 'bot_craft_%'
                AND (partyId IS NULL OR partyId = '')
                AND activity IN ('hunting', 'resting');
        `)],
        [34, () => connection.exec(`
            CREATE INDEX IF NOT EXISTS bot_life_state_warehouse_demand
                ON bot_life_state(updatedAt, characterId)
                WHERE phase = 'cold' AND simulationOwner = 'legacy_main'
                AND accountName NOT LIKE 'bot_craft_%'
                AND (partyId IS NULL OR partyId = '')
                AND activity IN ('hunting', 'resting');
        `)],
        [35, () => connection.exec(`
            CREATE INDEX IF NOT EXISTS bot_life_state_market_review
                ON bot_life_state(updatedAt, characterId,
                    COALESCE(CAST(json_extract(statsJson, '$.marketSellRetryAfter') AS INTEGER), 0))
                WHERE phase = 'cold'
                AND (partyId IS NULL OR partyId = '')
                AND activity NOT IN ('traveling', 'shopping', 'merchant', 'crafting', 'dead', 'pk_hunting');
        `)],
        [36, () => connection.exec(`
            CREATE TABLE IF NOT EXISTS character_saved_locations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                characterId INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                locX INTEGER NOT NULL,
                locY INTEGER NOT NULL,
                locZ INTEGER NOT NULL,
                head INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS character_saved_locations_owner
                ON character_saved_locations(characterId, id);
        `)],
        [37, () => connection.exec(`
            CREATE TABLE IF NOT EXISTS bot_interaction_memory (
                ownerId INTEGER PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
                snapshotJson TEXT NOT NULL,
                updatedAt INTEGER NOT NULL
            );
        `)],
        [38, () => connection.exec(`
            CREATE TABLE IF NOT EXISTS clan_social_memory (
                clanId INTEGER PRIMARY KEY REFERENCES clans(id) ON DELETE CASCADE,
                snapshotJson TEXT NOT NULL,
                updatedAt INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS clan_social_memory_updated ON clan_social_memory(updatedAt, clanId);
        `)],
        [39, () => require('./DatabasePartyCandidateProjection').install(connection)],
        [40, () => {
            if (!connection.prepare('PRAGMA table_info(characters)').all().some(column => column.name === 'skillCooldowns'))
                connection.exec("ALTER TABLE characters ADD COLUMN skillCooldowns TEXT NOT NULL DEFAULT '[]'");
        }],
        [41, () => {
            // Early versions of this branch used 40 for death EXP. Also repair
            // those databases without changing main's existing migration.
            if (!connection.prepare('PRAGMA table_info(characters)').all().some(column => column.name === 'skillCooldowns'))
                connection.exec("ALTER TABLE characters ADD COLUMN skillCooldowns TEXT NOT NULL DEFAULT '[]'");
            connection.exec(`
            CREATE TABLE IF NOT EXISTS character_death_experience (
                characterId INTEGER PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
                deathSequence INTEGER NOT NULL DEFAULT 1,
                expBeforeDeath INTEGER NOT NULL,
                expLost INTEGER NOT NULL,
                expAfterDeath INTEGER NOT NULL,
                deathContext TEXT NOT NULL DEFAULT '{}',
                penaltyAppliedAt INTEGER NOT NULL,
                pendingRestoration INTEGER NOT NULL DEFAULT 1 CHECK(pendingRestoration IN (0, 1)),
                resolvedAt INTEGER,
                resolutionReason TEXT NOT NULL DEFAULT ''
            );
        `);
        }],
        [42, () => connection.exec(`
            CREATE INDEX IF NOT EXISTS clan_actions_uncompacted_details
                ON clan_actions(resolvedAt, id)
                WHERE status IN ('succeeded', 'failed', 'cancelled')
                  AND (payloadJson <> '{}' OR resultJson <> '{}');
            CREATE INDEX IF NOT EXISTS clan_goal_events_uncompacted_details
                ON clan_goal_events(occurredAt, id)
                WHERE eventType IN ('action_succeeded', 'action_failed', 'action_cancelled')
                  AND payloadJson <> '{}';
            DROP INDEX IF EXISTS clan_actions_terminal_retention;
            DROP INDEX IF EXISTS clan_goal_events_action_retention;
        `)],
        [43, () => connection.exec(fs.readFileSync(path.join(__dirname, '../database/sql/market-store-history.sql'), 'utf8'))],
        [44, () => {
            connection.exec(`
                DROP TRIGGER IF EXISTS market_store_insert;
                DROP TRIGGER IF EXISTS market_store_update;
                DELETE FROM market_store_events
                WHERE eventType = 'closed' AND storeId IN (
                    SELECT json_extract(statsJson, '$.marketStore.id') FROM bot_life_state
                    WHERE json_extract(statsJson, '$.marketStore.id') IS NOT NULL
                );
            `);
            connection.exec(fs.readFileSync(path.join(__dirname, '../database/sql/market-store-history.sql'), 'utf8'));
        }]
    ];
    migrations.push([45, () => connection.exec(`CREATE TABLE IF NOT EXISTS bot_raid_encounters (
        raidKey TEXT PRIMARY KEY, revision INTEGER NOT NULL, snapshotJson TEXT NOT NULL
    )`)]);
    migrations.push([46, () => {
        if (!connection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='raid_boss_state'").get()) return;
        // Existing raid rows are written at defeat. Rebase old datapack
        // windows once, retaining that wall-clock origin across restarts.
        // Keep this migration's historical five-hour value fixed.
        connection.exec(`UPDATE raid_boss_state SET respawnTime = updatedAt + 18000000
            WHERE respawnTime > 0 AND updatedAt > 0`);
    }]);
    migrations.push([47, () => {
        const columns = connection.prepare('PRAGMA table_info(characters)').all().map(column => column.name);
        if (!columns.includes('newbie')) connection.exec('ALTER TABLE characters ADD COLUMN newbie INTEGER NOT NULL DEFAULT -1');
        if (!columns.includes('newbieShotsReceived')) connection.exec('ALTER TABLE characters ADD COLUMN newbieShotsReceived INTEGER NOT NULL DEFAULT 0');
    }]);
    migrations.push([48, () => connection.exec(`CREATE TABLE IF NOT EXISTS character_hennas (
        characterId INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        slot INTEGER NOT NULL,
        symbolId INTEGER NOT NULL,
        PRIMARY KEY(characterId, slot)
    )`)]);
    migrations.push([49, () => {
        connection.exec(`CREATE INDEX IF NOT EXISTS clan_warehouse_ledger_revision
            ON clan_warehouse_ledger(clanId, warehouseRevision)`);
        // The history file creates its own index (database/sql/history.sql).
        if (!connection.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'clan_goal_events'").get()) return;
        connection.exec(`CREATE INDEX IF NOT EXISTS clan_goal_events_meaningful_recent
            ON clan_goal_events(clanId, occurredAt DESC, id DESC)
            WHERE eventType != 'action_succeeded'`);
    }]);
    migrations.push([50, () => {
        // Two databases: history rows leave the world through history_outbox
        // (HistoryStore.js); the tables themselves move once at start
        // (HistoryStore.moveWorldTables). The token ties the history file to
        // this world.
        connection.exec(`
            CREATE TABLE IF NOT EXISTS history_outbox (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                kind TEXT NOT NULL,
                payload TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS world_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            DROP INDEX IF EXISTS clan_actions_uncompacted_details;
            DROP TRIGGER IF EXISTS market_store_insert;
            DROP TRIGGER IF EXISTS market_store_update;
        `);
        connection.prepare("INSERT OR IGNORE INTO world_meta (key, value) VALUES ('historyToken', ?)")
            .run(require('crypto').randomUUID());
        connection.exec(fs.readFileSync(path.join(__dirname, '../database/sql/market-store-outbox.sql'), 'utf8'));
    }]);
    migrations.push([51, () => {
        // An inactive gear plan does not name the party objective spot
        // (PartyRequestPlanner.objectiveSpot). The column stays a prefilter:
        // party formation checks each candidate's spot again. A virtual
        // column cannot be altered, so it is dropped and added again.
        const table = connection.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'bot_life_state'").get();
        if (String(table?.sql || '').includes("'$.equipmentPlan.status'")) return;
        connection.exec(`
            DROP INDEX IF EXISTS bot_life_state_party_candidate_projection;
            ALTER TABLE bot_life_state DROP COLUMN partyObjectiveSpot;
            ALTER TABLE bot_life_state ADD COLUMN partyObjectiveSpot TEXT
                GENERATED ALWAYS AS (COALESCE(
                    json_extract(statsJson, '$.partyRequest.spotId'),
                    CASE WHEN json_extract(statsJson, '$.equipmentPlan.status') = 'active'
                        THEN json_extract(statsJson, '$.equipmentPlan.next.spotId') END,
                    spotId
                )) VIRTUAL;
        `);
        require('./DatabasePartyCandidateProjection').createIndex(connection);
    }]);
    // Personas v2 (step 3.1, N6a): eleven types by class and share, clan
    // leaders through the author's founder gate, remembered listing prices reset.
    migrations.push([52, () => invoke('GameServer/Bot/AI/BotPersonaMigration').apply(connection, now())]);
    // The board (step 3.3, group A): every AFK shop row is a record of a
    // kind with an expiry; one active shop per owner, any number of other
    // records. Closed records are deleted at once (design 16.19).
    migrations.push([53, () => {
        const columns = connection.prepare('PRAGMA table_info(afk_trade_shops)').all().map((column) => column.name);
        if (!columns.includes('kind')) {
            connection.exec(`ALTER TABLE afk_trade_shops ADD COLUMN kind TEXT NOT NULL DEFAULT 'shop'
                CHECK(kind IN ('shop', 'sell_ad', 'buy_ad', 'order'))`);
        }
        if (!columns.includes('expiresAt')) connection.exec('ALTER TABLE afk_trade_shops ADD COLUMN expiresAt INTEGER NOT NULL DEFAULT 0');
        // Old worlds still hold their history until History.prepare below.
        // Deleting each closed shop invokes this legacy SET NULL foreign key;
        // its owner index cannot serve shopId and would rescan all events.
        if (connection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='afk_trade_events'").get()) {
            connection.exec('CREATE INDEX IF NOT EXISTS afk_trade_events_shop_migration ON afk_trade_events(shopId)');
        }
        connection.exec(`
            DROP INDEX IF EXISTS afk_trade_shops_active_owner;
            CREATE UNIQUE INDEX afk_trade_shops_active_owner
                ON afk_trade_shops(ownerId) WHERE status = 'active' AND kind = 'shop';
            CREATE INDEX IF NOT EXISTS afk_trade_shops_owner_kind ON afk_trade_shops(ownerId, kind);
            DELETE FROM afk_trade_lines WHERE shopId IN (SELECT id FROM afk_trade_shops WHERE status != 'active');
            DELETE FROM afk_trade_shops WHERE status != 'active';
        `);
    }]);
    // A world that traded before the board closes its bot records once at the
    // board's first start (Database.migrateBoardWorld, which needs the item
    // catalogue); a new world has nothing to close.
    migrations.push([54, () => {
        const traded = connection.prepare(`SELECT 1 FROM afk_trade_shops WHERE status = 'active' LIMIT 1`).get()
            || connection.prepare(`SELECT 1 FROM bot_life_state WHERE json_extract(statsJson, '$.marketStore') IS NOT NULL LIMIT 1`).get();
        if (traded) {
            connection.prepare("INSERT OR IGNORE INTO world_meta (key, value) VALUES ('boardMigrationPending', ?)").run(String(now()));
        }
    }]);
    // The physical cold stores are gone with the board: their statsJson
    // triggers (two json_extract on every statsJson write) and the expression
    // index the market review paged through go too (perf 15). The review keeps
    // its filter and pages through a plain index.
    migrations.push([55, () => connection.exec(`
        DROP TRIGGER IF EXISTS market_store_insert;
        DROP TRIGGER IF EXISTS market_store_update;
        DROP INDEX IF EXISTS bot_life_state_market_review;
        CREATE INDEX IF NOT EXISTS bot_life_state_market_page
            ON bot_life_state(updatedAt, characterId)
            WHERE phase = 'cold'
            AND (partyId IS NULL OR partyId = '')
            AND activity NOT IN ('traveling', 'shopping', 'merchant', 'crafting', 'dead', 'pk_hunting');
    `)]);
    // Board records close by events only (user, 2026-10-05): the 12-hour
    // lifetime of a world that ran with it ends, and the uptime clock with it.
    migrations.push([56, () => connection.exec(`
        UPDATE afk_trade_shops SET expiresAt = 0 WHERE expiresAt > 0;
        DELETE FROM world_meta WHERE key = 'boardAliveAt';
    `)]);
    // N79: observations belong to an open line, not to a bot's item book.
    // Durable cursors are initialized after history/the catalogue are ready.
    migrations.push([57, () => connection.exec(`
        ALTER TABLE afk_trade_lines ADD COLUMN fills INTEGER NOT NULL DEFAULT 0 CHECK(fills >= 0);
        ALTER TABLE afk_trade_lines ADD COLUMN pricingPrice INTEGER;
        ALTER TABLE afk_trade_lines ADD COLUMN pricingSeenCounter INTEGER;
        ALTER TABLE afk_trade_lines ADD COLUMN pricingSeenItem INTEGER;
        ALTER TABLE afk_trade_lines ADD COLUMN pricingRival INTEGER;
        ALTER TABLE afk_trade_lines ADD COLUMN pricingWorth REAL;
        ALTER TABLE afk_trade_lines ADD COLUMN pricingSeenFills INTEGER;
        UPDATE bot_life_state SET statsJson = json_remove(statsJson, '$.priceBeliefs')
            WHERE json_valid(statsJson) AND json_type(statsJson, '$.priceBeliefs') IS NOT NULL;
    `)]);
    migrations.push([58, () => require('./GameServer/Social/InteractionMemoryRows').install(connection)]);
    migrations.push([59, () => connection.exec(`
        CREATE TABLE IF NOT EXISTS bot_market_counts (
            characterId INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
            counter TEXT NOT NULL,
            deals INTEGER NOT NULL,
            PRIMARY KEY(characterId, counter)
        );
        INSERT INTO bot_market_counts(characterId, counter, deals)
            SELECT life.characterId, counts.key, MAX(0, CAST(counts.value AS INTEGER))
            FROM bot_life_state life JOIN characters c ON c.id=life.characterId,
                json_each(life.statsJson, '$.marketTrades') counts
            WHERE substr(c.username, 1, 4)='bot_' AND counts.type IN ('integer', 'real')
            ON CONFLICT(characterId, counter) DO UPDATE SET deals=MAX(deals, excluded.deals);
        UPDATE bot_life_state SET statsJson=json_remove(statsJson, '$.marketTrades')
            WHERE json_type(statsJson, '$.marketTrades') IS NOT NULL;
        INSERT OR IGNORE INTO world_meta(key,value) VALUES('botMarketCountsMoved','1');
    `)]);
    // Own-line price attention checkpoints time only with publication/reprice.
    migrations.push([60, () => connection.exec(`
        ALTER TABLE afk_trade_lines ADD COLUMN pricingSeenAt INTEGER NOT NULL DEFAULT 0;
    `)]);
    migrations.push([61, () => connection.exec(`
        ALTER TABLE afk_trade_lines ADD COLUMN pricingSeenCount INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE afk_trade_lines ADD COLUMN pricingSigma REAL NOT NULL DEFAULT 0;
    `)]);
    migrations.push([62, () => require('./GameServer/AfkTrade/TradeMeetingSchema').install(connection)]);
    migrations.push([63, () => connection.exec('ALTER TABLE board_trade_participants ADD COLUMN lastReceipt TEXT')]);
    migrations.push([64, () => connection.exec(`
        CREATE INDEX board_trade_meetings_actor_a ON board_trade_meetings(actorA,state,id);
        CREATE INDEX board_trade_meetings_actor_b ON board_trade_meetings(actorB,state,id);
    `)]);
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
    if (!isReadStatement(sql)) checkMutationAdmission();
    return normalizeRow(Statements.prepare(connection, sql).get(...params));
}

function all(sql, params = []) {
    if (!isReadStatement(sql)) checkMutationAdmission();
    return normalizeRows(Statements.prepare(connection, sql).all(...params));
}

function write(sql, params = []) {
    checkMutationAdmission();
    const result = Statements.prepare(connection, sql).run(...params);
    return { affectedRows: Number(result.changes || 0), insertId: Number(result.lastInsertRowid || 0) };
}

// Capture before a native flush can await; skill writers capture at their call.
// Each admitted writer keeps its original SQL queue.
const coldTrainingGuards = new WeakMap();
// ARCH-NOTE: Only a native training checkpoint refusal belongs to this domain; same-message SQL/user errors stay distinct.
class ColdTrainingSourceRetired extends Error {
    constructor() { super('cold_training_source_retired'); }
}
function captureWriteAdmission(options, errorCode, characterId, rowStatement = null) {
    let beforeWrite, nativeProof, present = false, captureFailed = false, captureError;
    try {
        if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError(errorCode);
        const descriptor = Object.getOwnPropertyDescriptor(options, 'beforeWrite');
        if (descriptor) {
            present = true;
            if (!Object.prototype.hasOwnProperty.call(descriptor, 'value') || typeof descriptor.value !== 'function') {
                throw new TypeError(errorCode);
            }
            beforeWrite = descriptor.value;
            const nativeBeforeWrite = coldTrainingGuards.get(beforeWrite)?.nativeBeforeWrite || beforeWrite;
            nativeProof = rowStatement ? NativeWriteCheckpoint.captureRow(nativeBeforeWrite, rowStatement)
                : NativeWriteCheckpoint.capture(nativeBeforeWrite, characterId);
        } else if ('beforeWrite' in options) throw new TypeError(errorCode);
    } catch (error) {
        captureFailed = true;
        captureError = error;
    }
    return Object.freeze({ beforeWrite, nativeProof, coldTraining: coldTrainingGuards.get(beforeWrite), present, captureFailed, captureError, errorCode });
}

function checkCapturedWriteAdmission(admission, characterId) {
    if (admission.captureFailed) throw admission.captureError;
    if (admission.present) {
        const beforeWrite = admission.beforeWrite;
        const verdict = beforeWrite();
        if (verdict !== undefined) {
            if (verdict instanceof Promise) Promise.prototype.then.call(verdict, undefined, () => {});
            throw new TypeError(admission.errorCode);
        }
    }
    let trainingRow;
    if (admission.coldTraining) {
        const Protocol = invoke('GameServer/Bot/Population/ColdSimulationProtocol');
        const row = trainingRow = one(`SELECT ${NativeWriteCheckpoint.columns.join(', ')},
            COALESCE(json_extract(statsJson, '$.clanInventoryRevision'), 0) <= COALESCE(json_extract(?, '$'), 0)
            AND COALESCE(json_extract(statsJson, '$.clanLevelSpVersion'), 0) <= COALESCE(json_extract(?, '$'), 0)
            AND COALESCE(json_extract(statsJson, '$.clanMembershipVersion'), 0) <= COALESCE(json_extract(?, '$'), 0)
                AS trainingVersionsCurrent
            FROM bot_life_state WHERE characterId = ?`, [...admission.coldTraining.versions, characterId]);
        const current = Protocol.commandCheckpoint(row && { ...row, activityStartedAt: row.activityStartedAt || 0,
            nextResolveAt: row.nextResolveAt || 0, lastResolvedAt: row.lastResolvedAt || 0, lastHotAt: row.lastHotAt || 0 });
        if (current?.phase !== 'cold' || current.simulationOwner !== LEGACY_SIMULATION_OWNER
            || row.trainingVersionsCurrent !== 1
            || (!admission.nativeProof && !Protocol.sameCommandCheckpoint(admission.coldTraining, current))) throw new ColdTrainingSourceRetired();
    }
    if (admission.nativeProof) {
        NativeWriteCheckpoint.checkTarget(admission.nativeProof, characterId);
        NativeWriteCheckpoint.check(admission.nativeProof, trainingRow || one(`SELECT ${NativeWriteCheckpoint.columns.join(', ')}
            FROM bot_life_state WHERE characterId = ?`, [characterId]));
    }
}

function guardedNativeWrite(sql, params, operation, admission) {
    return enqueue(() => {
        if (!connection) throw new Error(`SQLite is not initialized (${operation})`);
        checkCapturedWriteAdmission(admission, params[params.length - 1]);
        return write(sql, params);
    }, { operation, read: false });
}

function guardedSkillWrite(sql, params, operation, options = {}) {
    return guardedNativeWrite(sql, params, operation, captureWriteAdmission(options, 'invalid_skill_before_write', params[params.length - 1]));
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

function marketTradeAggregate(since, { selfId = null, to = null } = {}) {
    const where = ['occurredAt >= ?', MarketTradeOverview.CANONICAL_FILTER];
    const params = [Number(since)];
    if (Number(selfId) > 0) {
        where.push('selfId = ?');
        params.push(Number(selfId));
    }
    if (Number(to) > 0) {
        where.push('occurredAt <= ?');
        params.push(Number(to));
    }
    const row = History.one(`SELECT COUNT(*) AS trades,
        COALESCE(SUM(quantity), 0) AS units,
        COALESCE(SUM(totalPrice), 0) AS adena,
        COUNT(DISTINCT selfId) AS items,
        MIN(occurredAt) AS firstAt,
        MAX(occurredAt) AS lastAt
        FROM market_trades WHERE ${where.join(' AND ')}`, params) || {};
    return {
        trades: Number(row.trades || 0),
        units: Number(row.units || 0),
        adena: Number(row.adena || 0),
        items: Number(row.items || 0),
        firstAt: Number(row.firstAt || 0) || null,
        lastAt: Number(row.lastAt || 0) || null
    };
}

function weightedMedianPrice(levels = []) {
    const rows = levels
        .map((level) => ({ price: Number(level.unitPrice || 0), units: Math.max(0, Number(level.units || 0)) }))
        .filter((level) => level.units > 0)
        .sort((left, right) => left.price - right.price);
    const total = rows.reduce((sum, level) => sum + level.units, 0);
    if (!total) return null;
    const middle = (total + 1) / 2;
    let cumulative = 0;
    for (const level of rows) {
        cumulative += level.units;
        if (cumulative >= middle) return level.price;
    }
    return rows.at(-1)?.price ?? null;
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

function playerClanCraftOrderUnsafe(clanId, orderId, settings = {}) {
    const order = one('SELECT * FROM clan_orders WHERE id = ? AND clanId = ?', [orderId, clanId]);
    const members = values => [...values].map(Number).sort((a, b) => a - b);
    if (!order || order.status !== 'active' || order.strategy !== 'craft' || settings.strategy !== 'craft'
        || ['itemId', 'amount', 'maxUnitPrice', 'budget'].some(key => Number(order[key]) !== Number(settings[key]))
        || JSON.stringify(members(jsonArray(order.memberIdsJson))) !== JSON.stringify(members(settings.memberIds || []))) return null;
    return order;
}

const FINISHED_CLAN_ACTION = "('succeeded', 'failed', 'cancelled')";

// A finished clan action lives in the history file; until the history thread
// moves it, in the outbox. The outbox is read first: a row leaves it only
// after the history file holds it. `column` is 'id' or 'actionKey'.
function finishedClanActionUnsafe(column, value) {
    const queued = one(`SELECT payload FROM history_outbox
        WHERE kind = 'clan_action' AND json_extract(payload, '$.${column}') = ?
        ORDER BY id DESC LIMIT 1`, [value]);
    if (queued) return JSON.parse(queued.payload);
    return History.one(`SELECT * FROM clan_actions WHERE ${column} = ?`, [value]) || null;
}

// One clan action by id or actionKey, live (world) or finished (history).
function clanActionUnsafe(column, value) {
    return one(`SELECT * FROM clan_actions WHERE ${column} = ?`, [value]) || finishedClanActionUnsafe(column, value);
}

// Finished clan actions leave the world in the transaction that finishes
// them; returns the moved rows.
function archiveFinishedClanActionsUnsafe(clanId) {
    const rows = all(`SELECT * FROM clan_actions WHERE clanId = ? AND status IN ${FINISHED_CLAN_ACTION}`, [Number(clanId)]);
    if (!rows.length) return rows;
    rows.forEach((row) => historyOutboxUnsafe('clan_action', row));
    write(`DELETE FROM clan_actions WHERE clanId = ? AND status IN ${FINISHED_CLAN_ACTION}`, [Number(clanId)]);
    return rows;
}

// A new pending clan action. Its actionKey stays unique across live and
// finished actions, as when both were one table: a key taken by a finished
// action fails (or is ignored) like the UNIQUE constraint did.
function insertClanActionUnsafe({ clanId, actionKey, actionType, priority = 100, availableAt, payload = {},
    reasonCode = '', createdAt }, { ignoreDuplicate = false } = {}) {
    if (finishedClanActionUnsafe('actionKey', actionKey)) {
        if (ignoreDuplicate) return { affectedRows: 0, insertId: 0 };
        throw Object.assign(new Error('UNIQUE constraint failed: clan_actions.actionKey'),
            { code: 'ERR_SQLITE_ERROR', errcode: 2067, errstr: 'constraint failed' });
    }
    return write(`INSERT ${ignoreDuplicate ? 'OR IGNORE ' : ''}INTO clan_actions
        (clanId, actionKey, actionType, priority, status, attempt, availableAt,
         payloadJson, resultJson, reasonCode, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, '{}', ?, ?, ?)`, [
        clanId, actionKey, actionType, priority, availableAt, JSON.stringify(payload), reasonCode, createdAt, createdAt
    ]);
}

function cancelPlayerManagedClanWorkUnsafe(clanId, reasonCode, timestamp = now()) {
    const clan = Number(clanId);
    const reason = String(reasonCode || 'player_order_replaced');
    // Invalidate travelling/crafting customers in the same transaction as the
    // order change. A stale cold tick must not consume the old order's inputs.
    write(`UPDATE bot_life_state SET statsJson = json_set(json_remove(statsJson,
            '$.equipmentPlan', '$.clanMaterialDemand', '$.craftReturn', '$.travel'),
            '$.clanInventoryRevision', simulationRevision + 1),
            activity = CASE WHEN activity IN ('crafting', 'traveling') THEN 'hunting' ELSE activity END,
            simulationRevision = simulationRevision + 1, updatedAt = ?
        WHERE characterId IN (SELECT id FROM characters WHERE clanId = ?)
          AND json_extract(statsJson, '$.equipmentPlan.clanGoal.orderId') IS NOT NULL`, [timestamp, clan]);
    write(`UPDATE clan_actions
        SET status = 'cancelled', leaseUntil = NULL, reasonCode = ?, updatedAt = ?, resolvedAt = ?
        WHERE clanId = ? AND status IN ('pending', 'running')`, [reason, timestamp, timestamp, clan]);
    archiveFinishedClanActionsUnsafe(clan);
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
    const stalePlayerGoal = previousState.goal
        && String(previousState.goal.controlledBy || '') === 'player'
        && (!currentOrder || Number(previousState.goal.orderId) !== Number(currentOrder.id));
    if (simulation && !membershipChanged && !stalePlayerGoal) {
        return { ok: true, created: false, changed: false, clanId: Number(clanId), mode: 'player_managed', memberIds: botMemberIds };
    }

    const state = simulationState({ ...previousState, mode: 'player_managed' }, clanId, clan.leaderId, botMemberIds, timestamp);
    state.mode = 'player_managed';
    state.level = Math.max(0, Math.min(3, Number(clan.level) || 0));
    if (stalePlayerGoal) {
        cancelPlayerManagedClanWorkUnsafe(clanId, 'player_managed_stale_order_cleared', timestamp);
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
    if (activeOrder || !currentOrder) {
        insertClanActionUnsafe({
            clanId: Number(clanId),
            actionKey: `clan:${Number(clanId)}:player-managed:${timestamp}`,
            actionType: 'goal_plan',
            availableAt: timestamp,
            payload: {
                reason: simulation ? 'player_managed_membership_changed' : 'player_managed_enabled',
                clanId: Number(clanId),
                orderId: Number(activeOrder?.id) || null,
                orderRevision: Number(activeOrder?.revision) || null,
                control: activeOrder ? 'player' : 'automatic'
            },
            reasonCode: 'player_managed_sync',
            createdAt: timestamp
        }, { ignoreDuplicate: true });
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

// Economic operations must commit their cold projection with the physical
// inventory. A later failure or restart must not replay pre-purchase balances.
function syncEconomySnapshotUnsafe(characterId, state, changedIds, mp = null) {
    if (!state) return null;
    const row = one('SELECT * FROM bot_life_state WHERE characterId = ?', [Number(characterId)]);
    if (!row || row.phase !== 'cold' || row.simulationOwner !== LEGACY_SIMULATION_OWNER
        || (state.simulation && Number(row.simulationRevision) !== Number(state.simulation.revision))) {
        throw new Error('economy_state_changed');
    }
    return writeColdInventorySnapshotUnsafe(characterId, row, changedIds, mp);
}

function economyOwnerUnsafe(characterId, authority, fresh = false) {
    checkMutationAdmission();
    const row = one('SELECT life.*, c.username FROM bot_life_state life JOIN characters c ON c.id=life.characterId WHERE life.characterId=?',
        [Number(characterId)]);
    if (!row || !BoardRules.isBotAccount(row.username) || !authority
        || row.phase !== authority.phase || row.simulationOwner !== authority.ownerId
        || (row.simulationLeaseId || null) !== (authority.leaseId || null)
        || Number(row.lastHotAt || 0) !== Number(authority.hotAt || 0)
        || row.simulationOwner !== LEGACY_SIMULATION_OWNER || row.simulationLeaseId
        || (fresh && Number(row.simulationRevision) !== authority.revision)) throw Error('economy_owner_changed');
    return row;
}

// Read a saved completion before examining the now-consumed physical inputs.
// Authority is still checked first; an obsolete session/worker cannot spend.
function economyStepUnsafe(characterId, command, kind) {
    if (!command) return null;
    if (kind !== undefined && command[1] !== kind) throw Error('economy_kind_changed');
    EconomyCommit.header(command[0], command[1], command[2], command.authority);
    if (Diagnostics.active()) stageNativeDiagnostic(characterId, { command }, 'native_attempt', 'requested', { commandKind: command[1] });
    const row = economyOwnerUnsafe(characterId, command.authority);
    if (Diagnostics.active()) stageNativeDiagnostic(characterId, { row, command }, 'native_admission', 'authority_checked',
        { commandKind: command[1] });
    const tuple = jsonObject(row.statsJson).economyCommit;
    if (!EconomyCommit.valid(tuple) || tuple[2] !== command[0] || tuple[3] !== command[1]) throw Error('economy_intent_changed');
    if (tuple[1] === 1 && command[2] === tuple[0] - 1) {
        if (Diagnostics.active()) stageNativeDiagnostic(characterId, { row, command }, 'native_replay', 'saved_receipt',
            { nativeId: tuple[8], receiptUnits: tuple[5], receiptSpent: tuple[6], actual: 0, spent: 0 });

        return { row, replay: { ...EconomyCommit.result(tuple), coldLifeRow: normalizeRow(row) } };
    }
    if (tuple[1] !== 0 || command[2] !== tuple[0]) throw Error('economy_sequence_changed');
    economyOwnerUnsafe(characterId, command.authority, true);
    const state = { level: Number(row.level), phase: row.phase, stats: jsonObject(row.statsJson),
        inventory: jsonObject(row.inventorySummary) };
    // Current own protection is prepared once inside the atomic boundary,
    // never inferred from the worker's spending proposal.
    const reserved = invoke('GameServer/Bot/Economy/ItemDisposition').reservedEquipmentAmounts(state);
    return { row, command, reserved };
}

function completeEconomyStepUnsafe(characterId, step, result, changedIds, mp = null, learning = null, statsPatch = null) {
    if (!step) return null;
    const tuple = EconomyCommit.completed(step.command, result);
    if (Diagnostics.active()) stageNativeDiagnostic(characterId, step, 'native_result', result.success === false ? 'failed_outcome' : 'completed',
        { actual: Number(result.units || 0), spent: Number(result.spent || 0), nativeId: Number(result.nativeId || 0),
            source: step.command[1] === EconomyCommit.KINDS.npcBuy ? 'npc' : step.command[1] === EconomyCommit.KINDS.craft ? 'craft' : 'board',
            recipeId: step.command[1] === EconomyCommit.KINDS.craft ? Number(result.nativeId || 0) : undefined });
    const patch = { ...statsPatch, economyCommit: tuple, ...(learning ? { lastRecipeBookLearning: learning } : {}) };
    if (step.row.phase === 'cold') return writeColdInventorySnapshotUnsafe(characterId, step.row, changedIds, mp, patch);
    write("UPDATE bot_life_state SET statsJson=json_patch(COALESCE(statsJson,'{}'),json(?)) WHERE characterId=?",
        [JSON.stringify(patch), Number(characterId)]);
    return normalizeRow(one('SELECT * FROM bot_life_state WHERE characterId=?', [Number(characterId)]));
}

// Preserve the pre-native-receipt cold auto-equip rule inside the purchase.
// Only physical flags move; no predicted cold items are materialized here.
function equipColdPurchaseUnsafe(characterId, step, itemId, autoEquip, heldItemIds = []) {
    if (!step || step.row.phase !== 'cold' || autoEquip === false) return null;
    const template = require('./GameServer/Item/ItemTemplateIndex').find(invoke('GameServer/DataCache').items, Number(itemId));
    if (template?.etc?.stackable || !(Number(template?.etc?.slot) > 0)) return null;
    const Life = invoke('GameServer/Bot/Population/BotLifeState');
    const physical = all('SELECT * FROM items WHERE characterId=? AND amount>0', [characterId]);
    const stats = jsonObject(step.row.statsJson);
    const held = new Set(heldItemIds);
    const reconciled = Life.reconcileEquipmentInventory({ characterId, level: Number(step.row.level), phase: 'cold', stats,
        inventory: Life.inventorySummaryFromItems(physical.filter(row => Number(row.equipped) || !held.has(Number(row.selfId)))) });
    const ids = new Set([Number(itemId)]);
    for (const row of physical) {
        const instance = reconciled.inventory[row.selfId]?.instances?.find(item => Number(item.id) === Number(row.id));
        if (!instance) continue;
        const equipped = instance.equipped ? 1 : 0, slot = Number(instance.slot || 0);
        if (equipped !== Number(row.equipped) || slot !== Number(row.slot)) {
            write('UPDATE items SET equipped=?,slot=? WHERE id=? AND characterId=?', [equipped, slot, row.id, characterId]);
            ids.add(Number(row.selfId));
            if (Diagnostics.active()) stageNativeDiagnostic(characterId, step, 'native_equip', equipped ? 'equipped' : 'unequipped',
                { item: Number(row.selfId), nativeId: Number(row.id), actual: equipped });
        }
    }
    const patch = {};
    for (const key of ['equipment', 'equipmentPlan', 'partyRequest', 'clanPartyObjective', 'clanEquipmentAcquisition',
        'marketWanted', 'marketRetryAfter', 'marketLead']) {
        if (Object.hasOwn(reconciled.stats, key)) patch[key] = reconciled.stats[key];
        else if (Object.hasOwn(stats, key)) patch[key] = null;
    }
    return { ids: [...ids], patch };
}

function checkEconomyFundingUnsafe(characterId, step, amount, funding = {}, walletOverride = null, packetOverride = null) {
    if (!step) return;
    const stats = jsonObject(step.row.statsJson), packet = packetOverride || stats.money;
    if (!Array.isArray(packet) || packet.length < 4) throw Error('economy_funding_missing');
    const wallet = walletOverride === null ? Number(one('SELECT COALESCE(SUM(amount),0) amount FROM items WHERE characterId=? AND selfId=57', [characterId]).amount) : walletOverride;
    const { r, itemId, valueHours, survivalCost, clanPart } = funding;
    const fundingCapture = Diagnostics.active() && Diagnostics.enabled(characterId) ? {} : null;
    const budget = require('./GameServer/Bot/Economy/PurchaseFunding').spendable({
        adena: wallet, stats: { money: packet }
    }, 0, { r, itemId, valueHours, survivalCost, clanPart, free: funding.free === true }, fundingCapture);
    if (Diagnostics.active()) stageNativeDiagnostic(characterId, step, 'native_funding', amount <= budget ? 'allowed' : 'funding_changed',
        { item: Number(funding.itemId), cost: amount, wallet, budget, available: budget, reserve: Number(packet[2]),
            priorityReserve: fundingCapture?.priorityReserve, moneyPrice: Number(packet[1]), escrow: 0,
            decisionSeq: Number(stats.decisionSeq), activityLeaf: Number(stats.activityLeaf), wishKey: stats.wishFocus?.[0] });

    if (!Number.isFinite(amount) || amount > budget) throw Error('economy_funding_changed');
}

function checkEconomyMaterialProtectionUnsafe(characterId, step, selfId, used) {
    if (!step) return;
    const stats = jsonObject(step.row.statsJson), inventory = jsonObject(step.row.inventorySummary);
    const item = inventory[selfId] || {};
    if (item.protected || item.acceptedCustomer || item.assignedClan || item.available === false) throw Error('economy_material_protected');
    const goalReserve = stats.equipmentPlan?.status === 'active' && Number(stats.equipmentPlan.target?.selfId) === Number(selfId) ? 1 : 0;
    const reserve = Math.max(Number(stats.clanMaterialDemand?.[selfId] || 0), goalReserve,
        Number(step.reserved?.[selfId] || 0), Number(item.protectedAmount || 0), Number(item.starterMobLootAmount || 0), Number(item.reservedAmount || 0));
    const available = Number(one('SELECT COALESCE(SUM(amount),0) amount FROM items WHERE characterId=? AND selfId=? AND equipped=0',
        [characterId, Number(selfId)]).amount);
    if (available - reserve < used) throw Error('economy_material_protected');
}

// An AFK fill changes the items of a bot whose row the cold worker may lease;
// the worker would later commit its older summary over them. Fence it as clan
// writes do: the same transaction writes the new amounts into the summary and
// advances simulationRevision, so the worker's commit fails its CAS and the
// bot is resolved again from this row. Returns the row when it was fenced.
function fenceLeasedColdInventoryUnsafe(characterId, changedIds) {
    const row = one('SELECT simulationOwner, inventorySummary FROM bot_life_state WHERE characterId = ?', [Number(characterId)]);
    if (!row || row.simulationOwner !== COLD_SIMULATION_OWNER) return null;
    return writeColdInventorySnapshotUnsafe(characterId, row, changedIds);
}

// The summary entries of changedIds and adena from the physical rows, and the
// next simulationRevision, for a row its caller has checked.
function writeColdInventorySnapshotUnsafe(characterId, row, changedIds, mp = null, statsPatch = null) {
    const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
    const physical = LifeState.inventorySummaryFromItems(all('SELECT * FROM items WHERE characterId = ?', [Number(characterId)]));
    const inventory = jsonObject(row.inventorySummary);
    for (const id of new Set([57, ...changedIds].map(Number))) {
        if (physical[id]) inventory[id] = physical[id];
        else delete inventory[id];
    }
    const adena = Number(physical[57]?.amount || 0);
    write(`UPDATE bot_life_state SET inventorySummary = ?, adena = ?, mp = COALESCE(?, mp),
        statsJson = CASE WHEN ? IS NULL THEN statsJson ELSE json_patch(statsJson,json(?)) END,
        simulationRevision = simulationRevision + 1, updatedAt = ? WHERE characterId = ?`,
    [JSON.stringify(inventory), adena, mp, statsPatch ? JSON.stringify(statsPatch) : null,
        statsPatch ? JSON.stringify(statsPatch) : null, now(), Number(characterId)]);
    const inventoryPatch = Object.fromEntries([...new Set([57, ...changedIds].map(Number))]
        .map(id => [id, physical[id] || null]));
    return { ...normalizeRow(coldSimulationRow(characterId)), inventoryPatch };
}

// The funded order belongs to the native party row. Worker patches may
// advance the hunt and its loot cursor, but cannot mint/replay its escrow.
function partyAgreementUnsafe(previous, proposed) {
    const oldStats = jsonObject(previous?.statsJson), stats = jsonObject(proposed.statsJson);
    const oldAgreement = oldStats.agreement, agreement = stats.agreement;
    const ids = JSON.parse(proposed.memberIdsJson || previous?.memberIdsJson || '[]').map(Number);
    let help = oldAgreement?.help;
    const touched = new Set();
    const ready = id => {
        const row = coldSimulationRow(id);
        if (!row || row.phase !== 'cold' || row.simulationOwner !== LEGACY_SIMULATION_OWNER || row.simulationLeaseId) {
            throw new Error('party_payment_owner_busy');
        }
        return row;
    };
    const move = (id, amount, debit = false) => {
        if (!amount) return;
        const row = ready(id);
        if (debit) afkTradeDebitAdenaUnsafe(id, amount); else afkTradeCreditAdenaUnsafe(id, amount);
        writeColdInventorySnapshotUnsafe(id, row, [57]); touched.add(id);
    };
    if (!previous && agreement?.help?.status === 'proposed') {
        const order = agreement.help, payerId = Number(order.payerId), fee = Number(order.fee);
        const helperIds = ids.filter(id => id !== payerId);
        if (ids.length < 2 || ids.length > 9 || new Set(ids).size !== ids.length
            || !ids.includes(payerId) || !helperIds.length || !Number.isSafeInteger(fee) || fee <= 0
            || !Number.isSafeInteger(order.itemId) || order.itemId <= 0
            || !Number.isSafeInteger(order.count) || order.count <= 0) throw new Error('invalid_party_help_order');
        ids.forEach(id => {
            if (ready(id).partyId !== proposed.partyId) throw new Error('party_help_membership_changed');
        });
        move(payerId, fee, true);
        const amount = Number(one('SELECT COALESCE(SUM(amount),0) amount FROM items WHERE characterId = ? AND selfId = ?',
            [payerId, order.itemId]).amount);
        help = { ...order, helperIds, remaining: fee, paid: 0, delivered: 0, baselineAmount: amount, status: 'funded' };
    }
    if (help?.status === 'funded') {
        const currentIds = new Set(ids);
        const helpers = help.helperIds.filter(id => currentIds.has(id));
        const terminal = !['active', 'hot'].includes(proposed.status) || !currentIds.has(help.payerId) || !helpers.length;
        if (terminal) {
            move(help.payerId, help.remaining);
            help = { ...help, remaining: 0, refunded: Number(help.remaining), status: 'cancelled' };
        } else {
            const amount = Number(one('SELECT COALESCE(SUM(amount),0) amount FROM items WHERE characterId = ? AND selfId = ?',
                [help.payerId, help.itemId]).amount);
            const delivered = Math.min(help.count, Math.max(help.delivered, amount - help.baselineAmount));
            const due = Math.min(help.remaining, Math.max(0, Math.floor(help.fee * delivered / help.count) - help.paid));
            helpers.forEach((id, index) => move(id, Math.floor(due / helpers.length) + (index < due % helpers.length ? 1 : 0)));
            help = { ...help, delivered, paid: help.paid + due, remaining: help.remaining - due,
                status: delivered >= help.count ? 'completed' : 'funded' };
        }
    }
    if (oldAgreement || agreement) stats.agreement = { ...oldAgreement, ...agreement, ...(help ? { help } : { help: null }) };
    return { row: { ...proposed, statsJson: JSON.stringify(stats) }, touched };
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

function updateColdInventorySnapshotUnsafe(characterId, selfId, event = null, expectedRevision = null, allowParty = false) {
    const id = Number(characterId);
    const itemId = Number(selfId);
    const row = one(`SELECT phase, simulationOwner, simulationRevision, partyId,
            inventorySummary, statsJson
        FROM bot_life_state WHERE characterId = ?`, [id]);
    if (!row) return { ok: false, code: 'missing_state' };
    if (String(row.phase || '') !== 'cold'
        || (!allowParty && String(row.simulationOwner || LEGACY_SIMULATION_OWNER) !== LEGACY_SIMULATION_OWNER)
        || (!allowParty && String(row.partyId || '') !== '')) {
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
    if (allowParty) stats.clanInventoryRevision = nextRevision;
    // The adena column is the wallet the next cold resolve starts from; it
    // follows the inventory, as syncAdenaSnapshotUnsafe keeps it.
    const updated = write(`UPDATE bot_life_state
        SET inventorySummary = ?, adena = COALESCE(?, adena), statsJson = ?, simulationRevision = ?, updatedAt = ?
        WHERE characterId = ? AND phase = 'cold'
          AND simulationOwner = ? AND simulationRevision = ?
          AND (? = 1 OR partyId IS NULL OR partyId = '')`, [
        JSON.stringify(inventory),
        itemId === 57 ? physical : null,
        JSON.stringify(stats),
        nextRevision,
        now(),
        id,
        String(row.simulationOwner || LEGACY_SIMULATION_OWNER),
        currentRevision,
        allowParty ? 1 : 0
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

// Both views of one stats string from a single JSON.parse: `loose` as
// parsedObject returns it (null for bad JSON) and `plain` as jsonObject does.
function statsViews(raw) {
    if (typeof raw !== 'string' || !raw) return { loose: parsedObject(raw), plain: jsonObject(raw) };
    let value;
    try {
        value = JSON.parse(raw);
    } catch (_) {
        return { loose: null, plain: {} };
    }
    const loose = value && typeof value === 'object' ? value : {};
    return { loose, plain: Array.isArray(loose) ? {} : loose };
}

function mergeVersionedAppearance(current, proposed, proposedRaw) {
    if (!current || !proposed) return proposedRaw;

    const currentVersion = Math.max(0, Number(current.appearanceVersion || 0));
    const proposedVersion = Math.max(0, Number(proposed.appearanceVersion || 0));
    if (currentVersion <= proposedVersion) return proposedRaw;

    const merged = { ...proposed, appearanceVersion: currentVersion };
    if (Object.prototype.hasOwnProperty.call(current, 'sex')) merged.sex = current.sex;
    return JSON.stringify(merged);
}

function preserveColdVersionedStats(row, patch = {}) {
    return preserveColdVersionedStatsParsed(row, patch).patch;
}

// Resolved on first use; require() re-resolved the path on every cold commit.
let ClanMembershipPolicyModule;
const clanMembershipPolicy = () => ClanMembershipPolicyModule
    || (ClanMembershipPolicyModule = require('./GameServer/Clan/ClanMembershipPolicy'));

// Parses the current and proposed stats once each. Besides the patch it
// returns what later cold commit steps would otherwise parse again: the final
// stats as parsedObject(patch.statsJson) would see them (undefined when the
// patch carries no stats) and the proposed death-experience record.
function preserveColdVersionedStatsParsed(row, patch = {}) {
    const next = { ...patch };
    if (!Object.prototype.hasOwnProperty.call(next, 'statsJson')) return { patch: next, stats: undefined, deathExperience: undefined };
    const proposedRaw = next.statsJson;
    const currentViews = statsViews(row?.statsJson);
    const proposedViews = statsViews(proposedRaw);
    const deathExperience = proposedViews.loose?.deathExperience;
    let stats = proposedViews.loose;
    next.statsJson = mergeVersionedAppearance(currentViews.loose, proposedViews.loose, proposedRaw);
    const current = currentViews.plain;
    const incoming = next.statsJson === proposedRaw ? proposedViews.plain : jsonObject(next.statsJson);
    if (next.statsJson !== proposedRaw) stats = incoming;
    // The native transaction owns this leaf. A stale worker/handoff snapshot
    // cannot remove, fabricate or rewind an intent or its saved completion.
    if (Object.hasOwn(current, 'economyCommit') || Object.hasOwn(incoming, 'economyCommit')) {
        if (Object.hasOwn(current, 'economyCommit')) incoming.economyCommit = current.economyCommit;
        else delete incoming.economyCommit;
        next.statsJson = JSON.stringify(incoming);
        stats = incoming;
    }
    // ARCH-NOTE: old workers can still carry the retired counters; the row table owns them now.
    if (incoming.marketTrades || incoming.priceBeliefs) {
        delete incoming.marketTrades;
        delete incoming.priceBeliefs;
        next.statsJson = JSON.stringify(incoming);
        stats = incoming;
    }
    if (Number(current.nameGeneratorVersion || 0) > Number(incoming.nameGeneratorVersion || 0)) {
        incoming.nameGeneratorVersion = current.nameGeneratorVersion;
        next.statsJson = JSON.stringify(incoming);
        stats = incoming;
    }
    if (Number(current.nameGeneratorVersion || 0) > 0 && 'characterName' in next) {
        next.characterName = row.characterName;
    }
    if (Number(current.clanMembershipVersion || 0) > Number(incoming.clanMembershipVersion || 0)) {
        for (const key of ['clanId', 'clanMembershipVersion', 'clanDiscipline', 'clanPartyObjective']) incoming[key] = current[key];
        if (Number(current.clanDiscipline?.clanId) > 0
            && incoming.equipmentPlan?.clanGoal?.clanId === current.clanDiscipline.clanId) incoming.equipmentPlan = null;
        next.statsJson = JSON.stringify(incoming);
        stats = incoming;
    }
    const proposed = {
        activity: next.activity || row?.activity, stats: incoming
    };
    const policy = clanMembershipPolicy();
    const repaired = policy.reconcileState(policy.preserveGoalInvalidation(proposed, current));
    if (repaired !== proposed) {
        next.statsJson = JSON.stringify(repaired.stats);
        stats = repaired.stats;
        if (repaired.activity !== proposed.activity) next.activity = repaired.activity;
    }
    return { patch: next, stats, deathExperience };
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
            const complete = invoke('GameServer/Bot/Population/InventorySummary').completeInstances(item);
            const identifiedIds = new Set(complete.instances.map((instance) => Number(instance.id))
                .filter((id) => byId.get(id)?.selfId === selfId));
            const desiredIds = new Set();
            complete.instances.forEach((instance) => {
                const instanceId = Number(instance?.id || 0);
                const identified = instanceId > 0 ? byId.get(instanceId) : null;
                const instanceEnchant = Math.max(0, Number(instance?.enchant ?? (hasEnchant ? enchant : 0)) || 0);
                // Summaries can still hold a null/old id after materialization.
                // Reuse its matching row instead of replacing it on every sync.
                const current = identified && Number(identified.selfId) === selfId && !desiredIds.has(instanceId)
                    ? identified : rows.find((row) => !identifiedIds.has(Number(row.id))
                        && !desiredIds.has(Number(row.id)) && Number(row.enchant || 0) === instanceEnchant);
                const equipped = instance?.equipped ? 1 : 0;
                const slot = Number(instance?.slot || 0);
                if (current) {
                    desiredIds.add(Number(current.id));
                    if (Number(current.amount) !== 1 || Number(current.enchant || 0) !== instanceEnchant
                        || Number(current.equipped) !== equipped || Number(current.slot) !== slot) {
                        write('UPDATE items SET amount = 1, enchant = ?, equipped = ?, slot = ? WHERE id = ? AND characterId = ?', [instanceEnchant, equipped, slot, current.id, characterId]);
                    }
                } else {
                    const inserted = write('INSERT INTO items (selfId, name, amount, enchant, equipped, slot, characterId) VALUES (?, ?, 1, ?, ?, ?, ?)', [selfId, item.name || `Item ${selfId}`, instanceEnchant, equipped, slot, characterId]);
                    desiredIds.add(Number(inserted.insertId));
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

function syncColdDeathExperienceUnsafe(characterId, record, timestamp) {
    if (record === undefined) return;
    if (!record) {
        write(`UPDATE character_death_experience SET pendingRestoration = 0, resolvedAt = ?,
            resolutionReason = 'cold_recovery' WHERE characterId = ? AND pendingRestoration = 1`,
        [timestamp, characterId]);
        return;
    }
    const existing = one('SELECT * FROM character_death_experience WHERE characterId = ?', [characterId]);
    const appliedAt = Number(record.penaltyAppliedAt);
    if (existing && Number(existing.penaltyAppliedAt) > appliedAt) return;
    const sameDeath = existing && Number(existing.penaltyAppliedAt) === appliedAt;
    // A later snapshot of the same corpse cannot reopen consumed restoration.
    const pending = record.pendingRestoration && (!sameDeath || Number(existing.pendingRestoration) === 1) ? 1 : 0;
    if (sameDeath && Number(existing.pendingRestoration) === pending) return;
    write(`INSERT INTO character_death_experience
        (characterId, deathSequence, expBeforeDeath, expLost, expAfterDeath, deathContext,
         penaltyAppliedAt, pendingRestoration, resolvedAt, resolutionReason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(characterId) DO UPDATE SET
            deathSequence = excluded.deathSequence, expBeforeDeath = excluded.expBeforeDeath,
            expLost = excluded.expLost, expAfterDeath = excluded.expAfterDeath,
            deathContext = excluded.deathContext, penaltyAppliedAt = excluded.penaltyAppliedAt,
            pendingRestoration = excluded.pendingRestoration, resolvedAt = excluded.resolvedAt,
            resolutionReason = excluded.resolutionReason`,
    [characterId, Number(existing?.deathSequence || 0) + (sameDeath ? 0 : 1),
        record.expBeforeDeath, record.expLost, record.expAfterDeath,
        JSON.stringify(record.deathContext || {}), appliedAt, pending,
        pending ? null : sameDeath && existing.resolvedAt != null ? existing.resolvedAt : timestamp,
        pending ? '' : record.resolutionReason || existing?.resolutionReason || 'cold_recovery']);
}

// The accepted fight proposal carries the actual Drain Soul mark. The
// native lease/admission transaction still owns the physical source check.
function applySoulCrystalStepsUnsafe(characterId, steps, guard = () => {}) {
    if (!Array.isArray(steps) || steps.length > 18) throw Error('invalid_cold_soul_crystals');
    const Native = invoke('GameServer/Items/SoulCrystalProgression');
    const quest = one('SELECT state FROM character_quests WHERE characterId = ? AND questId = 350', [characterId]);
    if (steps.length && quest?.state !== 'started') throw Error('cold_soul_crystal_quest_changed');
    for (const step of steps) {
        guard();
        const item = one('SELECT * FROM items WHERE characterId = ? AND id = ?', [characterId, step.objectId]);
        const rule = Native.catalog.npcs[step.npcId], crystal = Native.catalog.crystals[step.fromId];
        const total = one(`SELECT SUM(amount) AS count FROM items WHERE characterId = ? AND selfId IN (${Native.crystalIds.map(() => '?').join(',')})`, [characterId,...Native.crystalIds]);
        if (!rule || !crystal || !item || item.amount !== 1 || item.equipped || item.selfId !== step.fromId || total.count !== 1
            || !Number.isFinite(step.roll) || step.roll < 0 || step.roll >= 1
            || step.skillId !== 2096 || rule.maxStage <= 10 && (!Number.isFinite(step.maxHp) || !(step.maxHp > 0) || !Number.isFinite(step.absorbedHp) || !(step.absorbedHp > 0) || step.absorbedHp > step.maxHp / 2)) throw Error('cold_soul_crystal_source_changed');
        const outcome = Native.outcomeFor(rule, crystal.stage, step.npcId, step.roll);
        const targetId = outcome === 'success' ? crystal.nextId : outcome === 'broken' ? crystal.brokenId : null;
        if (!targetId || targetId !== step.toId) throw Error('cold_soul_crystal_outcome_changed');
        const target = invoke('GameServer/DataCache').items.find(row => row.selfId === targetId);
        if (!target) throw Error('cold_soul_crystal_template_missing');
        guard();
        write('UPDATE items SET selfId = ?, name = ? WHERE id = ? AND characterId = ?', [targetId,target.template.name,item.id,characterId]);
    }
}

function applyColdPhysicalStateUnsafe(characterId, physical = {}) {
    const before = one('SELECT hp,karma,pk FROM characters WHERE id = ?', [characterId]);
    // Use the persisted XP delta inside the fenced transaction: unchanged
    // snapshots cannot wash karma twice, and non-combat updates grant none.
    write(`UPDATE characters SET karma = MAX(0, karma - CAST(MAX(0, ? - exp) / ? AS INTEGER)),
        level = ?, exp = ?, sp = ?, hp = ?, maxHp = ?, mp = ?, maxMp = ?${
        Number.isFinite(Number(physical.classId)) ? ', classId = ?' : ''
    } WHERE id = ?`, [
        Number(physical.exp || 0), KARMA_XP_DIVIDER,
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
            ON CONFLICT(characterId, selfId) DO UPDATE SET name = excluded.name, passive = excluded.passive,
                level = MAX(skills.level, excluded.level)`, [
            selfId, String(skill.name || `Skill ${selfId}`), skill.passive ? 1 : 0, level, characterId
        ]);
    });
    if (physical.soulCrystals?.length) applySoulCrystalStepsUnsafe(characterId, physical.soulCrystals);
    if (physical.inventory) syncInventorySummaryUnsafe(characterId, physical.inventory);
    if (physical.pvpKills?.length) {
        if (physical.pvpKills.length > 18) throw Error('cold PvP: too many kills');
        const current = one('SELECT level, pvp, pk, karma FROM characters WHERE id = ?', [characterId]);
        for (const kill of physical.pvpKills) {
            if (!Number.isSafeInteger(kill.victimId) || kill.victimId === characterId
                || !Number.isSafeInteger(kill.victimLevel) || kill.victimLevel < 1 || typeof kill.pvp !== 'boolean') {
                throw Error('cold PvP: invalid kill');
            }
            if (kill.pvp) current.pvp++;
            else {
                current.karma += require('./GameServer/Karma').pkKillKarma({ fetchPk: () => current.pk,
                    fetchLevel: () => current.level }, { fetchLevel: () => kill.victimLevel });
                current.pk++;
            }
        }
        write('UPDATE characters SET pvp = ?, pk = ?, karma = ? WHERE id = ?',
            [current.pvp, current.pk, current.karma, characterId]);
        write("UPDATE bot_life_state SET statsJson = json_set(statsJson, '$.karma', ?, '$.pk', ?) WHERE characterId = ?",
            [current.karma, current.pk, characterId]);
    }
    return Number(before?.hp) > 0 && Number(physical.hp) <= 0
        ? dropPkDeathItemsUnsafe(characterId).drops : [];
}

function dropPkDeathItemsUnsafe(characterId) {
    const current = one('SELECT hp,karma,pk FROM characters WHERE id=?', [characterId]);
    if (!current || Number(current.hp) > 0 || !require('./GameServer/PkDropPolicy').enabled(current)) return { drops: [] };
    const life = one('SELECT deathCount,statsJson FROM bot_life_state WHERE characterId=?', [characterId]);
    const stats = jsonObject(life?.statsJson), death = Number(life?.deathCount || stats.deaths || 0);
    if (!life || death <= Number(stats.pkDropDeathSequence || 0)) return { drops: [] };
    const Data = invoke('GameServer/DataCache');
    const Templates = require('./GameServer/Item/ItemTemplateIndex');
    const inventory = all('SELECT * FROM items WHERE characterId=? ORDER BY id', [characterId]).map(item => {
        const template = Templates.find(Data.items, item.selfId);
        return { ...template?.template, ...template?.etc, ...item };
    });
    const drops = require('./GameServer/PkDropPolicy').rollPlan({ karma: current?.karma, pk: current?.pk, inventory });
    for (const item of drops) write('DELETE FROM items WHERE id=? AND characterId=?', [item.id, characterId]);
    const summary = invoke('GameServer/Bot/Population/BotLifeState').inventorySummaryFromItems(all('SELECT * FROM items WHERE characterId=? ORDER BY id', [characterId]));
    write("UPDATE bot_life_state SET inventorySummary=?, statsJson=json_set(statsJson,'$.pkDropDeathSequence',?) WHERE characterId=?",
        [JSON.stringify(summary), death, characterId]);
    return { drops, inventory: summary, deathSequence: death };
}

// `parsedStats`, when given, is parsedObject(row.statsJson) computed earlier.
function coldSimulationPartition(row, options = {}, parsedStats) {
    if (!row) return { ok: false, reason: 'missing_state' };
    if (row.phase !== 'cold') return { ok: false, reason: 'not_cold' };
    if (!SIMPLE_COLD_ACTIVITIES.has(String(row.activity || '')) && options.allowLifecycle !== true) {
        return { ok: false, reason: 'legacy_activity' };
    }
    if (row.partyId && options.allowParty !== true) return { ok: false, reason: 'background_party' };
    const stats = parsedStats !== undefined ? parsedStats : parsedObject(row.statsJson);
    if (!stats) return { ok: false, reason: 'invalid_stats' };
    if (options.allowLifecycle === true) {
        return { ok: true, reason: row.partyId ? 'background_party_cold' : 'trusted_cold_lifecycle' };
    }
    const busy = BotErrands.busyWith({ stats }, BotErrands.COLD_CLAIM);
    if (busy) return { ok: false, reason: BotErrands.CLAIM_REASONS[busy] };
    return { ok: true, reason: row.partyId ? 'background_party_cold' : 'simple_solo_cold' };
}

function coldSimulationRow(characterId) {
    const row = one('SELECT * FROM bot_life_state WHERE characterId = ?', [Number(characterId)]);
    return row ? { ...row, ...require('./GameServer/AfkTrade/TradeMeeting').projectIncoming(acceptedTradeIncomingUnsafe(Number(characterId), row)) } : row;
}

// The existing participant slot and pending-settlement owner are the only
// selectors. No second custody map or population-wide read is retained.
function acceptedTradeIncomingUnsafe(characterId, row) {
    const incoming = {};
    const add = (id, count) => {
        if (Number(id) === 57) return;
        const amount = Number(incoming[id] || 0) + Number(count);
        if (!Number.isSafeInteger(amount) || amount < 0) throw Error('trade_meeting_integer');
        if (amount) incoming[id] = amount;
    };
    // Native snapshots serialize the slim reference with JSON.stringify or
    // json_patch. A cheap marker gates the indexed read; SQL remains authority.
    if (String(row?.statsJson || '').includes('"tradeMeeting":[')) {
        const meetings = all(`SELECT id,actorB FROM board_trade_meetings WHERE actorA=? AND state='accepted'
            UNION ALL SELECT id,actorB FROM board_trade_meetings WHERE actorB=? AND state='accepted'
            ORDER BY id LIMIT ${require('./GameServer/AfkTrade/TradeMeeting').MAX_COMMITMENTS}`, [characterId, characterId]);
        for (const meeting of meetings) for (const line of all(`SELECT selfId,heldCount FROM board_trade_meeting_lines
            WHERE meetingId=? AND payer=? AND custodyType='trade' AND heldCount>0 ORDER BY ordinal`,
        [meeting.id, Number(meeting.actorB === characterId)])) add(line.selfId, line.heldCount);
    }
    if (pendingSettlementOwners.has(characterId)) for (const line of all(`SELECT selfId,SUM(amount) amount
        FROM board_settlements WHERE ownerId=? GROUP BY selfId`, [characterId])) add(line.selfId, line.amount);
    return incoming;
}

// A claim needs the lease columns and the workflow flags coldSimulationPartition
// reads, not the whole row with its 9 KB stats. json_extract keeps JavaScript
// truthiness for them: false, 0, '' and missing values come back as 0, '' or
// NULL, objects and arrays as their JSON text. Empty stats parse to {} as in
// parsedObject; malformed stats have no flags and fail as invalid_stats.
const COLD_CLAIM_FLAGS = BotErrands.COLD_CLAIM;
const COLD_CLAIM_SQL = `SELECT characterId, phase, activity, partyId,
        simulationOwner, simulationRevision, simulationLeaseUntil,
        (statsJson IS NULL OR statsJson = '' OR json_valid(statsJson)) AS statsValid,
        ${COLD_CLAIM_FLAGS.map((flag) => `CASE WHEN json_valid(statsJson) THEN json_extract(statsJson, '$.${flag}') END AS "${flag}"`).join(',\n        ')}
    FROM bot_life_state WHERE characterId = ?`;

function coldClaimRow(characterId) {
    const row = one(COLD_CLAIM_SQL, [Number(characterId)]);
    if (!row) return { row: null, stats: undefined };
    const stats = row.statsValid ? Object.fromEntries(COLD_CLAIM_FLAGS.map((flag) => [flag, row[flag]])) : null;
    return { row, stats };
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

// One clan goal event for the history file (clan_goal_events). Its id is the
// outbox id.
function recordClanGoalEventUnsafe({ clanId, eventType, goalType = '', plan = '', reasonCode = '',
    payloadJson = '{}', occurredAt = now() }) {
    return historyOutboxUnsafe('clan_goal_event', { clanId, eventType, goalType, plan, reasonCode, payloadJson, occurredAt });
}

// One market trade for the history file (market_trades); a repeated eventKey
// is ignored there.
const BOARD_TRADE_SOURCES = new Set(['afk_bot_store', 'afk_player_store', 'afk_bot_buy_store', 'afk_player_buy_store']);
const BOARD_DEAL_COUNT_PREFIX = 'boardDealCount:';
const BOARD_COUNTER_COUNT_PREFIX = 'boardCounterDealCount:';
const PRICING_FIELDS = Object.freeze(['price', 'seenCounter', 'seenItem', 'rival', 'worth', 'seenFills', 'seenAt', 'seenCount', 'sigma']);
const PRICING_COLUMNS = Object.freeze(['pricingPrice', 'pricingSeenCounter', 'pricingSeenItem',
    'pricingRival', 'pricingWorth', 'pricingSeenFills', 'pricingSeenAt', 'pricingSeenCount', 'pricingSigma']);
const OPTIONAL_PRICING_FIELDS = new Set(['seenAt', 'seenCount', 'sigma']);

function boardTradeEligible(trade) {
    return Number(trade.selfId) > 0 && Number(trade.selfId) !== 57
        && Number(trade.unitPrice) > 0 && Number(trade.quantity) > 0;
}

function linePricing(line) {
    if (line.pricingPrice === null || line.pricingPrice === undefined) return undefined;
    const pricing = Object.fromEntries(PRICING_FIELDS.map((field, index) => [field, Number(line[PRICING_COLUMNS[index]])]));
    // A legacy cursor with no timestamp retains the one-hour default and its
    // old external shape until an actual reprice checkpoints the time.
    if (!pricing.seenAt) delete pricing.seenAt;
    if (!pricing.seenCount) delete pricing.seenCount;
    if (!pricing.sigma) delete pricing.sigma;
    return pricing;
}

function pricingValues(pricing) {
    const values = PRICING_FIELDS.map(field => OPTIONAL_PRICING_FIELDS.has(field) ? pricing?.[field] ?? 0 : pricing?.[field]);
    if (values.some((value, index) => !(['worth', 'sigma'].includes(PRICING_FIELDS[index]) ? Number.isFinite(value) : Number.isSafeInteger(value))
        || value < 0)) throw new Error('invalid_board_pricing');
    const sigma = values[PRICING_FIELDS.indexOf('sigma')];
    if (sigma !== 0 && (sigma < 0.6 / Math.sqrt(61) || sigma > 0.6)) throw new Error('invalid_board_pricing');
    return values;
}

function checkLinePricingUnsafe(line, previousPricing) {
    const current = linePricing(line);
    if (!current || !previousPricing || PRICING_FIELDS.some(field => OPTIONAL_PRICING_FIELDS.has(field)
        ? (current[field] ?? 0) !== (previousPricing[field] ?? 0) : current[field] !== previousPricing[field])) {
        throw new Error('afk_trade_pricing_changed');
    }
}

function updateLinePricingUnsafe(line, pricing) {
    const values = pricingValues(pricing);
    if (pricing.seenFills > Number(line.fills)) throw new Error('invalid_board_pricing');
    const current = linePricing(line);
    if (current && PRICING_FIELDS.every((field, index) => (current[field] ?? 0) === values[index])) return false;
    write(`UPDATE afk_trade_lines SET ${PRICING_COLUMNS.map(column => `${column} = ?`).join(', ')}, updatedAt = ? WHERE id = ?`,
        [...values, now(), line.id]);
    return true;
}

function ensureBoardDealCountsUnsafe() {
    if (boardDealCountsReady) return;
    if (one("SELECT value FROM world_meta WHERE key = 'boardDealCountsReady'")) { boardDealCountsReady = true; return; }
    // A queued world write freezes the outbox while one history query counts
    // the union. Rows already transferred but not yet deleted count once.
    const pending = all("SELECT payload FROM history_outbox WHERE kind = 'market_trade' ORDER BY id")
        .map(({ payload }) => JSON.parse(payload));
    const totals = History.all(`WITH pending AS (SELECT
            json_extract(value, '$.eventKey') AS eventKey, json_extract(value, '$.selfId') AS selfId,
            json_extract(value, '$.sourceType') AS sourceType, json_extract(value, '$.unitPrice') AS unitPrice,
            json_extract(value, '$.quantity') AS quantity, CAST(key AS INTEGER) AS eventOrder FROM json_each(?)),
        trades AS (SELECT eventKey, selfId, sourceType, unitPrice, quantity, 0 AS stage, id AS eventOrder FROM market_trades
            UNION ALL SELECT eventKey, selfId, sourceType, unitPrice, quantity, 1 AS stage, eventOrder FROM pending),
        canonical AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY eventKey ORDER BY stage, eventOrder) AS first FROM trades)
        SELECT selfId, COUNT(*) AS deals FROM canonical
        WHERE first = 1 AND sourceType IN ('afk_bot_store', 'afk_player_store', 'afk_bot_buy_store', 'afk_player_buy_store')
            AND unitPrice > 0 AND quantity > 0 AND selfId != 57 GROUP BY selfId`, [JSON.stringify(pending)]);
    for (const { selfId, deals } of totals) write('INSERT INTO world_meta (key, value) VALUES (?, ?)',
        [`${BOARD_DEAL_COUNT_PREFIX}${Number(selfId)}`, String(deals)]);
    write("INSERT INTO world_meta (key, value) VALUES ('boardDealCountsReady', '1')");
    boardDealCountsReady = true;
}

function ensureBoardCounterCountsUnsafe() {
    ensureBoardDealCountsUnsafe();
    if (boardCounterCountsReady) return;
    if (one("SELECT value FROM world_meta WHERE key = 'boardCounterCountsReady'")) { boardCounterCountsReady = true; return; }
    const MarketCounters = invoke('GameServer/Bot/Economy/MarketCounters');
    if (!invoke('GameServer/DataCache').items?.length) throw new Error('board_market_data_not_ready');
    const totals = new Map();
    for (const { key, value } of all('SELECT key, value FROM world_meta WHERE key LIKE ?', [`${BOARD_DEAL_COUNT_PREFIX}%`])) {
        const counter = MarketCounters.counterOf(Number(key.slice(BOARD_DEAL_COUNT_PREFIX.length)));
        totals.set(counter, Number(totals.get(counter) || 0) + Number(value));
    }
    for (const [key, count] of totals) write('INSERT INTO world_meta (key, value) VALUES (?, ?)',
        [`${BOARD_COUNTER_COUNT_PREFIX}${key}`, String(count)]);
    write("INSERT INTO world_meta (key, value) VALUES ('boardCounterCountsReady', '1')");
    boardCounterCountsReady = true;
}

function initialLinePricingUnsafe(selfId, price, storeType) {
    ensureBoardCounterCountsUnsafe();
    const key = invoke('GameServer/Bot/Economy/MarketCounters').counterOf(selfId);
    return { price,
        seenCounter: Number(one('SELECT value FROM world_meta WHERE key = ?', [`${BOARD_COUNTER_COUNT_PREFIX}${key}`])?.value || 0),
        seenItem: Number(one('SELECT value FROM world_meta WHERE key = ?', [`${BOARD_DEAL_COUNT_PREFIX}${selfId}`])?.value || 0),
        rival: 0, worth: Number(storeType) === BoardRules.BUY ? price : 0, seenFills: 0, seenAt: now() };
}

function learnBoardTradeUnsafe(trade, participants) {
    if (!boardTradeEligible(trade)) return {};
    if (!invoke('GameServer/Bot/Economy/PriceLearning').knowledgeEnabled()) return {};
    const counter = invoke('GameServer/Bot/Economy/MarketCounters').counterOf(trade.selfId);
    const rows = {};
    for (const [id, participant] of participants) {
        if (!BoardRules.isBotAccount(participant?.username) || rows[id]) continue;
        const row = one(`INSERT INTO bot_market_counts(characterId,counter,deals) VALUES(?,?,1)
            ON CONFLICT(characterId,counter) DO UPDATE SET deals=deals+1 RETURNING deals`, [id, counter]);
        rows[id] = { [counter]: Number(row.deals) };
    }
    return rows;
}

function recordMarketTradeUnsafe(trade, { unique = false } = {}) {
    // The observation count belongs to the world, not to the retained tail
    // of its history. Bootstrap it on the first replay or deal, then advance it in
    // the same transaction as each board deal. AFK event keys are new by
    // construction; imported telemetry can repeat a key.
    if (BOARD_TRADE_SOURCES.has(trade.sourceType) && boardTradeEligible(trade)) {
        ensureBoardCounterCountsUnsafe();
        const duplicate = !unique && (History.one('SELECT id FROM market_trades WHERE eventKey = ?', [trade.eventKey])
            || one(`SELECT id FROM history_outbox WHERE kind = 'market_trade'
                AND json_extract(payload, '$.eventKey') = ? LIMIT 1`, [trade.eventKey]));
        if (!duplicate) {
            const key = invoke('GameServer/Bot/Economy/MarketCounters').counterOf(trade.selfId);
            for (const aggregate of [`${BOARD_DEAL_COUNT_PREFIX}${Number(trade.selfId)}`, `${BOARD_COUNTER_COUNT_PREFIX}${key}`]) {
                write(`INSERT INTO world_meta (key, value) VALUES (?, '1')
                    ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1`, [aggregate]);
            }
        }
    }
    return historyOutboxUnsafe('market_trade', trade);
}

// One AFK trade notification for the shop owner (afk_trade_events in the
// history file). Its id is the outbox id.
function recordAfkTradeEventUnsafe(event) {
    return historyOutboxUnsafe('afk_event', event);
}

function afkTradeShopUnsafe(shopId) {
    const shop = one(`SELECT shops.*, characters.name AS ownerName, characters.username AS ownerAccount
        FROM afk_trade_shops shops
        JOIN characters ON characters.id = shops.ownerId
        WHERE shops.id = ?`, [shopId]);
    if (!shop) return null;
    return {
        ...shop,
        appearance: jsonObject(shop.appearanceJson),
        lines: all('SELECT * FROM afk_trade_lines WHERE shopId = ? ORDER BY id', [shopId])
            .map(line => ({ ...line, ...(linePricing(line) ? { pricing: linePricing(line) } : {}) }))
    };
}

function afkTradeInventoryUnsafe(characterId) {
    return all('SELECT * FROM items WHERE characterId = ? AND amount > 0 ORDER BY id', [characterId]);
}

function afkTradeAdenaRowsUnsafe(characterId) {
    return all('SELECT id, amount FROM items WHERE characterId = ? AND selfId = 57 AND amount > 0 ORDER BY id', [characterId]);
}

// One line of a bot's board record at a new price (and, for a sell line,
// a smaller count: the rest goes back to the bag). The record's escrow
// follows a buy line's bid. Every check comes before the line's first write.
// Returns { shop, changedIds, moved }: moved when an item or Adena moved.
function repriceAfkTradeLineUnsafe(characterId, id, unitPrice, expectedRevision, quantity, { checkpoint = true, rival = null } = {}) {
    const shop = one(`SELECT shops.* FROM afk_trade_shops shops JOIN afk_trade_lines lines ON lines.shopId = shops.id
        WHERE lines.id = ? AND shops.ownerId = ? AND shops.status = 'active'`, [id, characterId]);
    if (!shop) throw new Error('afk_trade_shop_unavailable');
    if (expectedRevision !== null && Number(shop.revision) !== Number(expectedRevision)) {
        throw new Error('afk_trade_shop_changed');
    }
    const line = one('SELECT * FROM afk_trade_lines WHERE id = ? AND shopId = ? AND count > 0', [id, shop.id]);
    if (!line) throw new Error('afk_trade_line_unavailable');
    const count = quantity === null ? Number(line.count) : Math.floor(Number(quantity));
    if (!Number.isSafeInteger(count) || count < 1 || count > Number(line.count)) {
        throw new Error('invalid_afk_trade_quantity');
    }
    const returned = Number(line.count) - count;
    const difference = shop.custodyPolicy !== 1 && Number(shop.storeType) === 3
        ? unitPrice * count - Number(line.price) * Number(line.count) : 0;
    const reserved = Number(shop.escrowAdena || 0) + difference;
    if (!Number.isSafeInteger(reserved) || reserved < 0) throw new Error('invalid_afk_trade_budget');
    if (difference > 0) afkTradeDebitAdenaUnsafe(characterId, difference);
    if (difference < 0) afkTradeCreditAdenaUnsafe(characterId, -difference);
    const changedIds = [];
    if (returned > 0 && shop.custodyPolicy !== 1 && Number(shop.storeType) === 1) {
        afkTradeCreditItemUnsafe(characterId, line, returned);
        changedIds.push(Number(line.selfId));
    }
    const timestamp = now();
    write('UPDATE afk_trade_lines SET price = ?, count = ?, updatedAt = ? WHERE id = ?',
        [unitPrice, count, timestamp, id]);
    write(`UPDATE afk_trade_shops SET escrowAdena = ?, revision = revision + 1,
        updatedAt = ? WHERE id = ?`, [reserved, timestamp, shop.id]);
    const owner = one('SELECT username FROM characters WHERE id = ?', [characterId]);
    if (checkpoint && unitPrice !== Number(line.price) && BoardRules.isBotAccount(owner?.username)) {
        const previous = linePricing(line);
        const pricing = initialLinePricingUnsafe(Number(line.selfId), unitPrice, shop.storeType);
        updateLinePricingUnsafe(line, { ...pricing, rival: rival ?? previous?.rival ?? 0,
            worth: previous?.worth ?? pricing.worth, seenFills: Number(line.fills) });
    }
    const current = afkTradeShopUnsafe(shop.id);
    const filled = completeAfkTradeIfFilledUnsafe(shop.id, timestamp, BoardRules.isBotAccount(owner?.username));
    return {
        shop: filled ? closedRecord(current) : afkTradeShopUnsafe(shop.id),
        changedIds,
        moved: changedIds.length > 0 || difference !== 0
    };
}

// What a reprice moved: the owner's bag and the fenced cold row when an item
// or Adena moved; a price-only change reads nothing and leaves the worker's
// lease alone (ownerInventory null: the callers have nothing to sync).
function afkTradeRepriceMovesUnsafe(characterId, changedIds, moved) {
    if (!moved) return { ownerInventory: null, coldLifeRows: {} };
    return {
        ownerInventory: afkTradeInventoryUnsafe(characterId),
        coldLifeRows: fenceAfkTradePartiesUnsafe([characterId], changedIds)
    };
}

function afkTradeDebitAdenaUnsafe(characterId, amount) {
    let remaining = Math.max(0, Math.floor(Number(amount) || 0));
    if (remaining === 0) return;
    const rows = afkTradeAdenaRowsUnsafe(characterId);
    const total = rows.reduce((sum, row) => sum + Number(row.amount || 0), 0);
    if (total < remaining) throw new Error('not_enough_adena');
    for (const row of rows) {
        const used = Math.min(remaining, Number(row.amount));
        const next = Number(row.amount) - used;
        if (next > 0) write('UPDATE items SET amount = ? WHERE id = ? AND characterId = ?', [next, row.id, characterId]);
        else write('DELETE FROM items WHERE id = ? AND characterId = ?', [row.id, characterId]);
        remaining -= used;
        if (remaining === 0) break;
    }
}

function afkTradeCreditAdenaUnsafe(characterId, amount) {
    const value = Math.max(0, Math.floor(Number(amount) || 0));
    if (value === 0) return 0;
    const row = one('SELECT id, amount FROM items WHERE characterId = ? AND selfId = 57 ORDER BY id LIMIT 1', [characterId]);
    if (row) {
        const total = Number(row.amount) + value;
        write('UPDATE items SET amount = ? WHERE id = ? AND characterId = ?', [total, row.id, characterId]);
        return Number(row.id);
    }
    return Number(write(`INSERT INTO items
        (selfId, name, amount, enchant, equipped, slot, characterId)
        VALUES (57, 'Adena', ?, 0, 0, 0, ?)`, [value, characterId]).insertId);
}

function afkTradeCreditItemUnsafe(characterId, item, amount) {
    const count = Math.max(1, Math.floor(Number(amount) || 1));
    const selfId = Number(item.selfId);
    const enchant = Math.max(0, Number(item.enchant || 0));
    const stackable = Number(item.stackable || 0) === 1;
    if (stackable) {
        const target = one(`SELECT id, amount FROM items
            WHERE characterId = ? AND selfId = ? AND enchant = ? AND equipped = 0
            ORDER BY id LIMIT 1`, [characterId, selfId, enchant]);
        if (target) {
            const total = Number(target.amount) + count;
            write('UPDATE items SET amount = ? WHERE id = ? AND characterId = ?', [total, target.id, characterId]);
            return [Number(target.id)];
        }
    }
    const inserted = [];
    const rows = stackable ? 1 : count;
    for (let index = 0; index < rows; index += 1) {
        inserted.push(Number(write(`INSERT INTO items
            (selfId, name, amount, enchant, equipped, slot, petData, characterId)
            VALUES (?, ?, ?, ?, 0, ?, ?, ?)`, [
            selfId,
            item.name || `Item ${selfId}`,
            stackable ? count : 1,
            enchant,
            Number(item.slot || 0),
            item.petData || null,
            characterId
        ]).insertId));
    }
    return inserted;
}

function afkTradeTakeItemUnsafe(characterId, itemId, selfId, enchant, amount) {
    const count = Math.max(1, Math.floor(Number(amount) || 1));
    const source = itemId
        ? one('SELECT * FROM items WHERE id = ? AND characterId = ?', [itemId, characterId])
        : one(`SELECT * FROM items
            WHERE characterId = ? AND selfId = ? AND enchant = ? AND equipped = 0 AND amount >= ?
            ORDER BY id LIMIT 1`, [characterId, selfId, enchant, count]);
    if (!source || Number(source.selfId) !== Number(selfId) || Number(source.enchant || 0) !== Number(enchant || 0)
        || Number(source.equipped) !== 0 || Number(source.amount) < count) {
        throw new Error('inventory_item_changed');
    }
    const remaining = Number(source.amount) - count;
    if (remaining > 0) write('UPDATE items SET amount = ? WHERE id = ? AND characterId = ?', [remaining, source.id, characterId]);
    else write('DELETE FROM items WHERE id = ? AND characterId = ?', [source.id, characterId]);
    return source;
}

// ---- The board (design section 4): the author's AFK shop rows are records ----

// Bot owners whose settlements wait for their next save; kept in memory so a
// save looks only when there is something to merge (rebuilt at start).
const pendingSettlementOwners = new Set();
let pendingSettlementUndo = null;

// The queue runs transaction work synchronously. Remember only the owners
// touched by this transaction, so later moves see its changes and rollback
// restores discovery along with the durable settlements.
function setPendingSettlementUnsafe(ownerId, pending) {
    if (pendingSettlementUndo && !pendingSettlementUndo.has(ownerId)) {
        pendingSettlementUndo.set(ownerId, pendingSettlementOwners.has(ownerId));
    }
    if (pending) pendingSettlementOwners.add(ownerId);
    else pendingSettlementOwners.delete(ownerId);
}

function isBotOwnerUnsafe(ownerId) {
    return BoardRules.isBotAccount(one('SELECT username FROM characters WHERE id = ?', [Number(ownerId)])?.username);
}

// A cold bot learns of a deal at its next save: what the deal owes it waits on
// the board. A player or a hot actor gets it at once (the main thread owns its
// bag and refreshes the actor after the commit).
function settlesLaterUnsafe(ownerId) {
    return one('SELECT phase FROM bot_life_state WHERE characterId = ?', [Number(ownerId)])?.phase === 'cold';
}

// Gives a record owner `amount` of `item` (selfId 57 for adena): into a
// settlement for a cold bot, into the bag for anyone else. Returns where.
function creditRecordOwnerUnsafe(ownerId, item, amount, at = now()) {
    const owner = Number(ownerId);
    const count = Math.floor(Number(amount) || 0);
    if (count <= 0) return null;
    const selfId = Number(item.selfId);
    if (settlesLaterUnsafe(owner)) {
        write(`INSERT INTO board_settlements (ownerId, selfId, name, amount, enchant, slot, stackable, petData, createdAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [owner, selfId, selfId === 57 ? 'Adena' : String(item.name || `Item ${selfId}`),
            count, Math.max(0, Number(item.enchant || 0)), Number(item.slot || 0),
            selfId === 57 || Number(item.stackable || 0) === 1 ? 1 : 0, item.petData || null, at]);
        setPendingSettlementUnsafe(owner, true);
        return 'settlement';
    }
    if (selfId === 57) afkTradeCreditAdenaUnsafe(owner, count);
    else afkTradeCreditItemUnsafe(owner, item, count);
    return 'bag';
}

// A move names the revision of each record it changes (its idempotency key):
// a replayed or stale move finds another revision, or no record, and changes
// nothing. A new ad cannot be opened twice (one ad per item and kind).
function checkRecordRevisionUnsafe(shop, expected) {
    if (expected === undefined || expected === null) return;
    if (!shop || Number(shop.revision) !== Number(expected)) throw new Error('afk_trade_shop_changed');
}

// Per-bot caps (BoardRules): a shop holds at most BOT_SHOP_LINES lines; a bot
// holds at most BOT_RECORDS[kind] records of another kind. Over the cap the
// new record is refused and nothing moves.
function checkBotCapsUnsafe(ownerId, kind, lineCount) {
    if (!isBotOwnerUnsafe(ownerId)) return;
    if (kind === 'shop') {
        if (lineCount > BoardRules.BOT_SHOP_LINES) throw new Error('board_cap_reached');
        return;
    }
    const held = Number(one('SELECT COUNT(*) AS count FROM afk_trade_shops WHERE ownerId = ? AND kind = ?',
        [Number(ownerId), kind]).count || 0);
    if (held + 1 > Number(BoardRules.BOT_RECORDS[kind] || 0)) throw new Error('board_cap_reached');
}

// A closed record is deleted at once (design 16.19): its holdings first go
// back (count and escrow to zero, so the economy journal sees them leave),
// then its lines and the row itself.
function deleteBoardRecordUnsafe(shopId, at) {
    write('UPDATE afk_trade_lines SET count = 0, updatedAt = ? WHERE shopId = ? AND count > 0', [at, shopId]);
    write('UPDATE afk_trade_shops SET escrowAdena = 0, updatedAt = ? WHERE id = ? AND escrowAdena > 0', [at, shopId]);
    write('DELETE FROM afk_trade_lines WHERE shopId = ?', [shopId]);
    write('DELETE FROM afk_trade_shops WHERE id = ?', [shopId]);
}

// Closes a record and gives its holdings back: the items of its sell lines or
// its escrow. The owner's own move (a stop, a replace, a withdrawal) puts them
// in its bag; a close the owner did not make (expiry, leave) goes through
// creditRecordOwnerUnsafe. Returns the selfIds that went back to the bag.
function closeBoardRecordUnsafe(shop, { ownMove = true, at = now() } = {}) {
    const ownerId = Number(shop.ownerId);
    const lines = all('SELECT * FROM afk_trade_lines WHERE shopId = ? AND count > 0 ORDER BY id', [shop.id]);
    const changed = [];
    const give = (item, amount) => {
        if (!ownMove) return creditRecordOwnerUnsafe(ownerId, item, amount, at);
        if (Number(item.selfId) === 57) afkTradeCreditAdenaUnsafe(ownerId, amount);
        else afkTradeCreditItemUnsafe(ownerId, item, amount);
        return 'bag';
    };
    if (shop.custodyPolicy !== 1 && Number(shop.storeType) === BoardRules.SELL) {
        lines.forEach((line) => {
            if (give(line, line.count) === 'bag') changed.push(Number(line.selfId));
        });
    }
    if (Number(shop.escrowAdena || 0) > 0) give({ selfId: 57 }, shop.escrowAdena);
    deleteBoardRecordUnsafe(shop.id, at);
    return changed;
}

// An AFK shop write (a fill, close, reprice or publish) moves adena and the
// items selfIds into or out of each party's backpack. Fences each party whose
// lifecycle row the cold worker leases; by characterId.
function fenceAfkTradePartiesUnsafe(characterIds, selfIds) {
    const rows = {};
    for (const characterId of characterIds) {
        const row = fenceLeasedColdInventoryUnsafe(characterId, selfIds);
        if (row) rows[Number(characterId)] = row;
    }
    return rows;
}

// After a deal: a record with nothing left is closed and deleted; one with
// lines left gets the bot's title for its remaining stock. Returns true when
// the record closed.
function completeAfkTradeIfFilledUnsafe(shopId, timestamp, botOwned = false) {
    const lines = botOwned ? all(`SELECT selfId, name, count FROM afk_trade_lines
        WHERE shopId = ? AND count > 0 ORDER BY id`, [shopId]) : null;
    const remaining = lines ? lines.length : Number(one(`SELECT COUNT(*) AS count FROM afk_trade_lines
        WHERE shopId = ? AND count > 0`, [shopId])?.count || 0);
    if (remaining > 0) {
        if (lines) {
            const { marketStoreTitle, marketBuyStoreTitle } = invoke('GameServer/Bot/Economy/MarketStoreTitle');
            const sellTitle = marketStoreTitle(lines), buyTitle = marketBuyStoreTitle(lines);
            // Same trade transaction and existing revision: only this shop's few
            // remaining lines are inspected, with no population/market scan.
            write(`UPDATE afk_trade_shops SET title = CASE WHEN storeType = 3 THEN ? ELSE ? END
                WHERE id = ? AND title != CASE WHEN storeType = 3 THEN ? ELSE ? END`,
            [buyTitle, sellTitle, shopId, buyTitle, sellTitle]);
        }
        return false;
    }
    const shop = one('SELECT * FROM afk_trade_shops WHERE id = ?', [shopId]);
    if (shop) closeBoardRecordUnsafe(shop, { ownMove: false, at: timestamp });
    return true;
}

// A record as the callers knew it, after it closed: the projection and the
// in-memory index drop it; nothing is left in the database.
function closedRecord(shop, status = 'filled') {
    return { ...shop, status, escrowAdena: 0, lines: (shop.lines || []).map((line) => ({ ...line, count: 0 })) };
}

function validBoardRecord(kind, storeType, rows) {
    if (!BoardRules.isKind(kind) || !Array.isArray(rows) || rows.length < 1) return false;
    if (kind !== 'shop' && rows.length !== 1) return false;
    return [BoardRules.SELL, BoardRules.BUY].includes(BoardRules.storeTypeFor(kind, storeType));
}

// Opens one record inside the caller's transaction (see createAfkTradeShop).
// A shop replaces the owner's shop when `replace` is set; an ad is one item
// and one per item. `expectedRevision` names the shop it replaces. No kind
// has a deadline (expiresAt 0): records close by events (user, 2026-10-05).
// Returns { shop, changedIds }.
function openBoardRecordUnsafe(characterId, config, rows, { prepaid = false } = {}) {
    const kind = config.kind;
    const storeType = BoardRules.storeTypeFor(kind, config.storeType);
    if (rows.some(line => BeginnerShots.isRestricted(line.selfId))) throw Error('beginner_shot_not_tradable');
    const owner = one('SELECT id, race FROM characters WHERE id = ?', [characterId]);
    if (!owner) throw new Error('afk_trade_owner_missing');
    const timestamp = now();
    const changedIds = [];
    let active = null;
    if (kind === 'shop') {
        const expandTrade = one('SELECT level FROM skills WHERE characterId = ? AND selfId = 1370', [characterId]);
        const limit = require('./GameServer/PrivateStoreLimits').tradeLimit(owner.race, expandTrade?.level || 0, storeType);
        if (rows.length > limit) throw new Error(`AFK trade allows at most ${limit} item slots`);
        active = one("SELECT * FROM afk_trade_shops WHERE ownerId = ? AND kind = 'shop' AND status = 'active'", [characterId]);
        if (active && !config.replace) throw new Error('afk_trade_already_active');
        if (config.expectedRevision !== undefined) checkRecordRevisionUnsafe(active, config.expectedRevision);
        // Replacing a remote shop returns its escrow and reserves the new
        // stock in the same transaction. A failed publish restores both.
        if (active) {
            changedIds.push(...closeBoardRecordUnsafe(active, { ownMove: true, at: timestamp }));
        }
    } else {
        const line = rows[0];
        const same = one(`SELECT shops.id FROM afk_trade_shops shops JOIN afk_trade_lines lines ON lines.shopId = shops.id
            WHERE shops.ownerId = ? AND shops.kind = ? AND lines.selfId = ? AND lines.enchant = ?`,
        [characterId, kind, Number(line.selfId), Math.max(0, Math.floor(Number(line.enchant || 0)))]);
        if (same) throw new Error('board_ad_exists');
    }
    checkBotCapsUnsafe(characterId, kind, rows.length);

    const conditional = ['buy_ad', 'sell_ad'].includes(kind) && isBotOwnerUnsafe(characterId);
    let escrowAdena = 0;
    if (!conditional && storeType === BoardRules.BUY) {
        escrowAdena = rows.reduce((sum, line) => {
            const count = Math.floor(Number(line.count));
            const price = Math.floor(Number(line.price));
            if (!Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(price) || price < 1
                || !Number.isSafeInteger(sum + count * price)) throw new Error('invalid_afk_trade_line');
            return sum + count * price;
        }, 0);
        if (!prepaid) {
            afkTradeDebitAdenaUnsafe(characterId, escrowAdena);
            changedIds.push(57);
        }
    }

    const shopId = Number(write(`INSERT INTO afk_trade_shops(
        ownerId, storeType, status, title, town, locX, locY, locZ, head,
        appearanceJson, packageSale, escrowAdena, revision, createdAt, updatedAt, kind, expiresAt
    ) VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 0)`, [
        characterId,
        storeType,
        String(config.title || '').slice(0, 52),
        config.town || null,
        Number(config.locX || 0),
        Number(config.locY || 0),
        Number(config.locZ || 0),
        Number(config.head || 0),
        // Only a shop stands in the world and is drawn from its snapshot.
        kind === 'shop' ? JSON.stringify(config.appearance || {}) : '{}',
        config.packageSale ? 1 : 0,
        escrowAdena,
        timestamp,
        timestamp,
        kind
    ]).insertId);

    if (conditional) write('UPDATE afk_trade_shops SET custodyPolicy=1 WHERE id=?', [shopId]);

    // A replaced shop or an ad may name a stack the bag has merged since: the
    // same item from another stack serves. A player's new shop names its own.
    const flexible = !!active || kind !== 'shop';
    const sourceIds = new Set();
    const botOwned = isBotOwnerUnsafe(characterId);
    rows.forEach((line) => {
        const selfId = Number(line.selfId);
        const count = Math.floor(Number(line.count));
        const price = Math.floor(Number(line.price));
        const enchant = Math.max(0, Math.floor(Number(line.enchant || 0)));
        if (!Number.isSafeInteger(selfId) || selfId <= 0 || selfId === 57
            || !Number.isSafeInteger(count) || count < 1
            || !Number.isSafeInteger(price) || price < (storeType === BoardRules.BUY ? 1 : 0)) {
            throw new Error('invalid_afk_trade_line');
        }
        const fills = botOwned ? (line.fills ?? 0) : 0;
        if (!Number.isSafeInteger(fills) || fills < 0) throw new Error('invalid_board_pricing');
        const pricing = botOwned ? (line.pricing || initialLinePricingUnsafe(selfId, price, storeType)) : null;
        const observations = pricing ? pricingValues(pricing) : PRICING_FIELDS.map(field => OPTIONAL_PRICING_FIELDS.has(field) ? 0 : null);
        if (pricing && pricing.seenFills > fills) throw new Error('invalid_board_pricing');

        let source = null;
        if (storeType === BoardRules.SELL) {
            let sourceId = Number(line.objectId || line.sourceObjectId || 0);
            if (flexible) {
                const preferred = one(`SELECT id FROM items WHERE id = ? AND characterId = ?
                    AND selfId = ? AND enchant = ? AND equipped = 0 AND amount >= ?`,
                [sourceId, characterId, selfId, enchant, count]);
                if (!preferred || sourceIds.has(sourceId)) {
                    const candidates = all(`SELECT id FROM items WHERE characterId = ?
                        AND selfId = ? AND enchant = ? AND equipped = 0 AND amount >= ?
                        ORDER BY id`, [characterId, selfId, enchant, count]);
                    sourceId = Number(candidates.find((candidate) => !sourceIds.has(Number(candidate.id)))?.id || 0);
                }
            }
            if (!sourceId || sourceIds.has(sourceId)) throw new Error('invalid_afk_trade_source');
            sourceIds.add(sourceId);
            source = conditional ? one('SELECT * FROM items WHERE id=? AND characterId=?', [sourceId, characterId])
                : afkTradeTakeItemUnsafe(characterId, sourceId, selfId, enchant, count);
            if (!conditional) changedIds.push(selfId);
        }
        write(`INSERT INTO afk_trade_lines(
            shopId, sourceObjectId, selfId, name, count, initialCount, price,
            enchant, slot, stackable, petData, createdAt, updatedAt, fills,
            ${PRICING_COLUMNS.join(', ')}
        ) VALUES (${Array(14 + PRICING_COLUMNS.length).fill('?').join(', ')})`, [
            shopId,
            source ? Number(source.id) : null,
            selfId,
            source?.name || line.name || `Item ${selfId}`,
            count,
            count,
            price,
            source ? Number(source.enchant || 0) : enchant,
            source ? Number(source.slot || 0) : Number(line.slot || 0),
            line.stackable ? 1 : 0,
            source?.petData || line.petData || null,
            timestamp,
            timestamp,
            fills,
            ...observations
        ]);
    });
    if (conditional && storeType === BoardRules.BUY) {
        checkConditionalBidUnsafe(characterId, rows[0]);
        const revision = Number(one('SELECT simulationRevision FROM bot_life_state WHERE characterId=?', [characterId])?.simulationRevision || 0);
        if (rows[0].intent) {
            const intent = require('./GameServer/Bot/Economy/TradeIntent').encode(rows[0].intent);
            write('UPDATE afk_trade_lines SET intentJson=?,intentRevision=? WHERE shopId=?', [JSON.stringify(intent), revision, shopId]);
        }
    }
    return { shop: afkTradeShopUnsafe(shopId), changedIds };
}

// A bot's at-most-five buy ads are one reserved obligation. Retain native
// identities and pricing cursors; money moves once by the net remaining
// reserve, including additions/removals. The caller already checked the
// complete expected set inside this same transaction.
function checkConditionalBidUnsafe(characterId, line, price = Number(line.price)) {
    const total = Number(line.count) * price;
    if (!Number.isSafeInteger(total) || total < 1) throw Error('invalid_afk_trade_budget');
    const wallet = Number(one('SELECT COALESCE(SUM(amount),0) amount FROM items WHERE characterId=? AND selfId=57', [characterId]).amount);
    if (total > wallet) throw Error('not_enough_adena');
    const row = one('SELECT * FROM bot_life_state WHERE characterId=?', [characterId]);
    if (row) checkEconomyFundingUnsafe(characterId, { row }, total,
        line.intent ? { r: line.intent.valueRate } : { itemId: Number(line.selfId) });
}

function reconcileBotBuyAdsUnsafe(characterId, held, configs, timestamp) {
    if (configs.length > BoardRules.BOT_RECORDS.buy_ad) throw Error('board_cap_reached');
    const key = (town, line) => `${town || ''}:${Number(line.selfId)}:${Number(line.enchant || 0)}`;
    const current = new Map(held.map(shop => [key(shop.town, shop.lines[0]), shop]));
    const identities = new Set(), wanted = configs.map(config => {
        const line = config.lines[0], selfId = Number(line.selfId), count = Number(line.count);
        const enchant = Number(line.enchant || 0), identity = `${selfId}:${enchant}`;
        if (!Number.isSafeInteger(selfId) || selfId <= 0 || selfId === 57
            || !Number.isSafeInteger(count) || count <= 0 || !Number.isSafeInteger(enchant) || enchant < 0
            || !Number.isSafeInteger(Number(line.price)) || Number(line.price) <= 0) throw Error('invalid_afk_trade_line');
        if (identities.has(identity)) throw Error('board_ad_exists');
        identities.add(identity);
        const previous = current.get(key(config.town, line));
        // A retained line's price belongs to MarketPricing.look, not the
        // newly prepared opening price. A quantity review preserves it.
        const price = previous ? Number(previous.lines[0].price) : Number(line.price);
        const reserve = count * price;
        if (!Number.isSafeInteger(reserve)) throw Error('invalid_afk_trade_budget');
        if (!previous && line.pricing) pricingValues(line.pricing);
        return { config, line, previous, count, price, reserve };
    });
    if (isBotOwnerUnsafe(characterId)) {
        for (const row of wanted) if (!row.previous || row.count > Number(row.previous.lines[0].count)) checkConditionalBidUnsafe(characterId, row.line, row.price);
        const revision = Number(one('SELECT simulationRevision FROM bot_life_state WHERE characterId=?', [characterId])?.simulationRevision || 0);
        const keep = new Set(wanted.filter(row => row.previous).map(row => row.previous.id));
        const removed = held.filter(shop => !keep.has(shop.id));
        const changedIds = [];
        for (const shop of removed) changedIds.push(...closeBoardRecordUnsafe(shop));
        const retained = [], opened = [], changed = [];
        for (const row of wanted) {
            const intent = row.line.intent ? require('./GameServer/Bot/Economy/TradeIntent').encode(row.line.intent) : null;
            if (!row.previous) {
                const record = openBoardRecordUnsafe(characterId, { ...row.config, kind: 'buy_ad' }, row.config.lines).shop;
                opened.push(record); changed.push(record); continue;
            }
            const previous = row.previous, line = previous.lines[0];
            if (previous.custodyPolicy !== 1) throw Error('trade_intent_migration_pending');
            if (intent) intent[2] = row.price;
            const encoded = intent ? JSON.stringify(intent) : null;
            if (line.count !== row.count || line.intentJson !== encoded || line.intentRevision !== (intent ? revision : -1) || previous.title !== String(row.config.title || '').slice(0,52)) {
                write('UPDATE afk_trade_lines SET count=?,price=?,intentJson=?,intentRevision=?,updatedAt=? WHERE id=?',
                    [row.count, row.price, encoded, intent ? revision : -1, timestamp, line.id]);
                write('UPDATE afk_trade_shops SET title=?,revision=revision+1,updatedAt=? WHERE id=?', [String(row.config.title || '').slice(0,52), timestamp, previous.id]);
                const record = afkTradeShopUnsafe(previous.id); retained.push(record); changed.push(record);
            } else retained.push(previous);
        }
        return { closed: removed.map(shop => closedRecord(shop, 'closed')), opened, retained, changed,
            ownerInventory: changedIds.length ? afkTradeInventoryUnsafe(characterId) : null,
            coldLifeRows: changedIds.length ? fenceAfkTradePartiesUnsafe([characterId], changedIds) : {} };
    }
    const oldReserve = held.reduce((sum, shop) => sum + Number(shop.escrowAdena), 0);
    const newReserve = wanted.reduce((sum, row) => sum + row.reserve, 0);
    if (!Number.isSafeInteger(oldReserve) || !Number.isSafeInteger(newReserve)) throw Error('invalid_afk_trade_budget');
    const difference = newReserve - oldReserve;
    // Existing reservations may shrink or remain without another admission.
    // Growth must fit today's native wallet and protected money queue; no
    // other kind's escrow or settlement enters this allowance.
    const additions = wanted.filter(row => !row.previous || row.count > Number(row.previous.lines[0].count));
    if (additions.length) {
        const life = one('SELECT statsJson FROM bot_life_state WHERE characterId = ?', [characterId]);
        const stats = jsonObject(life?.statsJson);
        if (life && (!Array.isArray(stats.money) || stats.money.length < 4)) throw Error('economy_funding_missing');
        if (Array.isArray(stats.money)) {
            const wallet = Number(one('SELECT COALESCE(SUM(amount),0) amount FROM items WHERE characterId=? AND selfId=57', [characterId]).amount);
            const Funding = require('./GameServer/Bot/Economy/PurchaseFunding');
            for (const row of additions) {
                if (newReserve > Funding.spendable({ adena: wallet, stats }, oldReserve, { itemId: Number(row.line.selfId) })) {
                    throw Error('economy_funding_changed');
                }
            }
        }
    }
    if (difference > 0) afkTradeDebitAdenaUnsafe(characterId, difference);
    else if (difference < 0) afkTradeCreditAdenaUnsafe(characterId, -difference);
    const kept = new Set(wanted.filter(row => row.previous).map(row => row.previous.id));
    const removed = held.filter(shop => !kept.has(shop.id));
    removed.forEach(shop => deleteBoardRecordUnsafe(shop.id, timestamp));
    const retained = [], opened = [], changed = [];
    for (const row of wanted) {
        const { previous, config, count, reserve } = row;
        if (!previous) {
            const created = openBoardRecordUnsafe(characterId, { ...config, kind: 'buy_ad' }, config.lines, { prepaid: true }).shop;
            opened.push(created); changed.push(created);
            continue;
        }
        const line = previous.lines[0], title = String(config.title || '').slice(0, 52);
        const countChanged = Number(line.count) !== count;
        const metadataChanged = String(previous.title || '') !== title;
        if (countChanged) {
            write('UPDATE afk_trade_lines SET count = ?, updatedAt = ? WHERE id = ?', [count, timestamp, line.id]);
        }
        if (countChanged || metadataChanged) {
            write(`UPDATE afk_trade_shops SET title = ?, escrowAdena = ?, revision = revision + 1,
                updatedAt = ? WHERE id = ?`, [title, reserve, timestamp, previous.id]);
            const updated = afkTradeShopUnsafe(previous.id);
            retained.push(updated); changed.push(updated);
        } else retained.push(previous);
    }
    return { closed: removed.map(shop => closedRecord(shop, 'closed')), opened, retained, changed,
        ownerInventory: difference ? afkTradeInventoryUnsafe(characterId) : null,
        coldLifeRows: difference ? fenceAfkTradePartiesUnsafe([characterId], [57]) : {} };
}

// Merges a bot's settlements into its bag; its cold row follows: the summary
// entries of the merged items and the adena are read back from the items, as
// a fenced write does (writeColdInventorySnapshotUnsafe). `advance` moves the
// row's simulationRevision (a main-thread settle); a commit that already set
// it passes false. Returns { changedIds, row } or null when nothing waited.
function mergeBoardSettlementsUnsafe(characterId, { advance = false } = {}) {
    const id = Number(characterId);
    const rows = all('SELECT * FROM board_settlements WHERE ownerId = ? ORDER BY id', [id]);
    if (!rows.length) {
        setPendingSettlementUnsafe(id, false);
        return null;
    }
    const changedIds = new Set([57]);
    for (const row of rows) {
        if (Number(row.selfId) === 57) afkTradeCreditAdenaUnsafe(id, row.amount);
        else afkTradeCreditItemUnsafe(id, row, row.amount);
        changedIds.add(Number(row.selfId));
    }
    write('DELETE FROM board_settlements WHERE ownerId = ?', [id]);
    setPendingSettlementUnsafe(id, false);
    const life = one('SELECT phase, inventorySummary FROM bot_life_state WHERE characterId = ?', [id]);
    if (!life || life.phase !== 'cold') return { changedIds: [...changedIds], row: null };
    const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
    const physical = LifeState.inventorySummaryFromItems(all('SELECT * FROM items WHERE characterId = ?', [id]));
    const inventory = jsonObject(life.inventorySummary);
    for (const selfId of changedIds) {
        if (physical[selfId]) inventory[selfId] = physical[selfId];
        else delete inventory[selfId];
    }
    write(`UPDATE bot_life_state SET inventorySummary = ?, adena = ?,
        simulationRevision = simulationRevision + ?, updatedAt = ? WHERE characterId = ?`,
    [JSON.stringify(inventory), Number(physical[57]?.amount || 0), advance ? 1 : 0, now(), id]);
    return { changedIds: [...changedIds], row: normalizeRow(coldSimulationRow(id)) };
}

function commitInteractionMemoryUnsafe(batch, timestamp) {
    const snapshots = new Map();
    const before = new Map();
    const Rows = require('./GameServer/Social/InteractionMemoryRows');
    const changed = new Set();
    const statuses = [];
    for (const event of batch) {
        if (!snapshots.has(event.sourceId)) {
            const snapshot = Rows.load({ one, all }, event.sourceId);
            snapshots.set(event.sourceId, snapshot);
            before.set(event.sourceId, snapshot);
        }
        const result = InteractionMemoryPolicy.apply(snapshots.get(event.sourceId), event, timestamp);
        if (!['applied', 'duplicate', 'rate_limited'].includes(result.status)) {
            return { ok: false, reason: result.status, key: event.key, snapshots: [] };
        }
        snapshots.set(event.sourceId, result.snapshot);
        if (result.status === 'applied') changed.add(event.sourceId);
        statuses.push(result.status);
    }
    // No write until every event passes; both directed memories are atomic.
    for (const ownerId of changed) {
        Rows.save({ write }, before.get(ownerId), snapshots.get(ownerId));
    }
    commitClanSocialUnsafe(batch.filter((_, i) => statuses[i] === 'applied'), timestamp);
    return { ok: true, statuses, snapshots: [...snapshots.values()] };
}

function commitClanSocialUnsafe(batch, timestamp) {
    const ClanSocial = require('./GameServer/Clan/ClanSocialPolicy');
    const clanSnapshots = new Map(), clanContexts = new Map(), changedClans = new Set();
    for (let i = 0; i < batch.length; i++) {
        const event = batch[i];
        if (!event.clan) continue;
        for (const clanId of new Set([event.clan.sourceClanId, event.clan.targetClanId].filter(Boolean))) {
            if (!clanContexts.has(clanId)) {
                const clan = one(`SELECT c.leaderId, p.traitsJson FROM clans c
                    LEFT JOIN bot_personas p ON p.characterId = c.leaderId WHERE c.id = ?`, [clanId]);
                clanContexts.set(clanId, clan || null);
            }
            const clan = clanContexts.get(clanId);
            if (!clan) continue;
            if (!clanSnapshots.has(clanId)) {
                const row = one('SELECT snapshotJson FROM clan_social_memory WHERE clanId = ?', [clanId]);
                clanSnapshots.set(clanId, row ? JSON.parse(row.snapshotJson) : ClanSocial.empty(clanId));
            }
            const targetLeader = one('SELECT leaderId FROM clans WHERE id = ?', [event.clan.targetClanId]);
            const currentMember = one('SELECT clanId FROM characters WHERE id = ?', [event.targetId]);
            const previous = clanSnapshots.get(clanId);
            const previousRevision = previous.revision;
            const next = ClanSocial.apply(previous, event, timestamp, {
                leaderTraits: jsonObject(clan.traitsJson), targetLeaderId: targetLeader?.leaderId,
                currentTargetClanId: Number(currentMember?.clanId || 0), mutable: true
            });
            if (next.revision !== previousRevision) changedClans.add(clanId);
            clanSnapshots.set(clanId, next);
        }
    }
    for (const [clanId, snapshot] of clanSnapshots) {
        if (!changedClans.has(clanId)) continue;
        const changedAt = Math.max(timestamp, Number(one('SELECT MAX(updatedAt) AS at FROM clan_social_memory')?.at || 0) + 1);
        write(`INSERT INTO clan_social_memory(clanId, snapshotJson, updatedAt) VALUES (?, ?, ?)
            ON CONFLICT(clanId) DO UPDATE SET snapshotJson = excluded.snapshotJson, updatedAt = MAX(clan_social_memory.updatedAt + 1, excluded.updatedAt)`,
        [clanId, JSON.stringify(snapshot), changedAt]);
    }
}

function rememberClanContributionUnsafe(clanId, contributor, leaderId, ledgerId, requested, sourceBefore, at) {
    if (!leaderId || leaderId === contributor || requested < Math.max(1000, sourceBefore * 0.01)) return;
    const event = require('./GameServer/Clan/ClanSocialEvidence').attach({
        key: `clan-contribution:${ledgerId}`, sourceId: leaderId, targetId: contributor, kind: 'character', type: 'resources_received', at
    }, { clanId }, { clanId }, `clan-contribution:${ledgerId}`, 'cooperation', true);
    commitClanSocialUnsafe([event], at);
}

function commitColdInteractionMemoryUnsafe(request) {
    if (request.memoryEvents === undefined) return null;
    if (!Array.isArray(request.memoryEvents) || request.memoryEvents.length > InteractionMemoryPolicy.MAX_BATCH) {
        throw new Error('interaction memory: invalid cold batch');
    }
    if (!request.memoryEvents.length) return null;
    const events = request.memoryEvents.map(InteractionMemoryPolicy.event);
    if (events.some(event => event.sourceId !== Number(request.characterId))) {
        throw new Error('interaction memory: cold event owner mismatch');
    }
    const result = commitInteractionMemoryUnsafe(events, now());
    // Throw to roll back the physical state too. A caller must refresh/replan,
    // never retry a rejected outcome as a separate successful social event.
    if (!result.ok) throw new Error(`interaction memory: ${result.reason}`);
    return result.snapshots.map(snapshot => ({ ...snapshot,
        appliedEvents: events.filter((event, index) => event.sourceId === snapshot.ownerId && result.statuses[index] === 'applied') }));
}

const ClanMembership = require('./GameServer/Clan/ClanMembershipRepository')({ all, write, inTransaction, now });
function publishClanMembership(result) {
    const { previousClanId, nextClanId, ...value } = result || {};
    if (result?.ok || Number(result?.affectedRows) > 0) {
        const Events = require('./GameServer/Clan/ClanReviewEvents');
        for (const id of new Set([previousClanId, nextClanId])) if (Number(id) > 0) Events.changed(id, 'membership');
    }
    return value;
}


const Database = {
    reconcileBotClanMembership: ClanMembership.reconcile,
    reconcileBotClanGoals: ClanMembership.reconcileGoals,
    init(callback = () => {}) {
        try {
            boardDealCountsReady = false;
            boardCounterCountsReady = false;
            shuttingDown = false;
            closePromise = null;
            databasePath = databaseFile();
            // Runtime startup already holds the shared database-access lock.
            // Recover the stopped pair before either database can be opened.
            require('./DatabaseRestore').recover(databasePath, historyFile());
            fs.mkdirSync(path.dirname(databasePath), { recursive: true });
            connection = new DatabaseSync(databasePath, { timeout: 5000 });
            // SQLite's built-in auto-checkpoint runs synchronously inside the
            // unlucky gameplay write that crosses its frame threshold. Keep
            // WAL durability, but move checkpoint I/O to a dedicated worker.
            connection.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA temp_store = MEMORY; PRAGMA wal_autocheckpoint = 0;');
            connection.exec(fs.readFileSync(path.join(process.cwd(), 'database', 'sql', 'sqlite.sql'), 'utf8'));
            applySchemaMigrations();
            pendingSettlementOwners.clear();
            connection.prepare('SELECT DISTINCT ownerId FROM board_settlements').all()
                .forEach((row) => pendingSettlementOwners.add(Number(row.ownerId)));
            historyPath = historyFile();
            History.prepare(connection, historyPath);
            outboxDeletedUpTo = 0;
            outboxDeleteWanted = 0;
            History.start({ worldPath: databasePath, historyPath, onMoved: deleteMovedOutbox,
                transferMs: Number(options.default.Database?.historyTransferMs) || 200 });
            startEconomyJournal();
            CheckpointCoordinator.start(databasePath, {
                intervalMs: Number(options.default.Database?.checkpointIntervalMs) || 5000,
                minWalBytes: Number(options.default.Database?.checkpointMinWalBytes) || (4 * 1024 * 1024)
            });
            cleanZeroAmountItems().catch((error) => utils.infoWarn('DB', 'failed to clean zero amount items: %s', error.message));
            utils.infoSuccess('DB', 'SQLite connected %s (history %s)', databasePath, historyPath);
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
            History.stop().catch(() => null);
            process.exitCode = 1;
            utils.infoFail('DB', 'SQLite initialization failed -> %s', error.message);
        }
    },

    execute(statement, operation = 'raw') {
        return run(statement[0], statement[1] || [], operation, statement[2]?.read ?? null, statement[2]?.onTiming);
    },

    // The lifecycle save's protected stats and its cache row are read from
    // the same queued statement; a later trade cannot slip between them.
    saveBotLifeState(statement, options = {}) {
        const admission = captureWriteAdmission(options, 'invalid_bot_life_before_write', null, statement);
        return enqueue(() => {
            let phase = 'row_admission';
            try {
                if (admission.nativeProof) NativeWriteCheckpoint.checkRow(admission.nativeProof, statement);
                phase = 'write_admission';
                checkCapturedWriteAdmission(admission, admission.nativeProof ? statement[1][0] : null);
                const returning = admission.nativeProof ? `${NativeWriteCheckpoint.columns.join(', ')}, statsJson` : 'statsJson';
                phase = 'write';
                const row = one(`${statement[0]} RETURNING ${returning}`, statement[1] || []);
                phase = 'advance';
                if (row && admission.nativeProof) NativeWriteCheckpoint.advance(admission.nativeProof, row);
                return { affectedRows: row ? 1 : 0, statsJson: row?.statsJson };
            } catch (error) {
                reportBotLifeSaveFailure(phase, error);
                throw error;
            }
        }, { operation: 'bot-life:save', read: false });
    },

    publishBotResolvedState(characterId, options, publish) {
        const admission = captureWriteAdmission(options, 'invalid_bot_resolve_publication', characterId);
        return enqueue(() => {
            if (!connection) throw new Error('SQLite is not initialized (bot-life:resolve-publication)');
            checkCapturedWriteAdmission(admission, characterId);
            if (!admission.nativeProof || typeof publish !== 'function') throw new TypeError('invalid_bot_resolve_publication');
            const result = publish();
            if (result instanceof Promise) {
                Promise.prototype.then.call(result, undefined, () => {});
                throw new TypeError('invalid_bot_resolve_publication');
            }
            if (result && (typeof result === 'object' || typeof result === 'function') && 'then' in result) {
                throw new TypeError('invalid_bot_resolve_publication');
            }
            return result;
        }, { operation: 'bot-life:resolve-publication', read: true });
    },

    transferBuffServiceAdena({ payerId, providerId, amount, expectedSpotId = null } = {}) {
        const payer = Number(payerId), provider = Number(providerId), price = Number(amount);
        if (!Number.isSafeInteger(payer) || payer <= 0 || !Number.isSafeInteger(provider) || provider <= 0
            || payer === provider || !Number.isSafeInteger(price) || price <= 0) {
            return Promise.resolve({ ok: false, reason: 'invalid_payment' });
        }
        return withCharacterFlush(payer, () => withCharacterFlush(provider, () => inTransaction(() => {
            const payerCharacter = one('SELECT id FROM characters WHERE id = ?', [payer]);
            const providerCharacter = one('SELECT id FROM characters WHERE id = ?', [provider]);
            if (!payerCharacter || !providerCharacter) return { ok: false, reason: 'missing_character' };
            const payerState = one('SELECT phase, activity, partyId, spotId FROM bot_life_state WHERE characterId = ?', [payer]);
            const providerState = one('SELECT phase, activity, partyId, spotId FROM bot_life_state WHERE characterId = ?', [provider]);
            if (expectedSpotId !== null) {
                if (!payerState || !providerState || payerState.phase !== 'cold' || providerState.phase !== 'cold'
                    || payerState.spotId !== expectedSpotId || providerState.spotId !== expectedSpotId
                    || payerState.partyId || providerState.partyId
                    || !['hunting', 'resting'].includes(payerState.activity)
                    || !['hunting', 'resting'].includes(providerState.activity)) {
                    return { ok: false, reason: 'spot_or_activity_changed' };
                }
            }
            const balance = afkTradeAdenaRowsUnsafe(payer)
                .reduce((sum, row) => sum + Number(row.amount || 0), 0);
            if (balance < price) return { ok: false, reason: 'not_enough_adena' };
            afkTradeDebitAdenaUnsafe(payer, price);
            const providerAdenaId = afkTradeCreditAdenaUnsafe(provider, price);
            const payerRows = afkTradeAdenaRowsUnsafe(payer);
            const payerBalance = payerRows.reduce((sum, row) => sum + Number(row.amount || 0), 0);
            const providerBalance = afkTradeAdenaRowsUnsafe(provider)
                .reduce((sum, row) => sum + Number(row.amount || 0), 0);
            if (payerState) syncAdenaSnapshotUnsafe(payer, payerBalance);
            if (providerState) syncAdenaSnapshotUnsafe(provider, providerBalance);
            return { ok: true, payerBalance, providerBalance,
                payerAdenaId: Number(payerRows[0]?.id || 0), providerAdenaId };
        }, 'buff-service:payment')));
    },

    purchaseColdBuffs({ payerId, providerId, spotId, payerRevision, providerRevision,
        price, mpCost, effects, timestamp = now() } = {}) {
        const payer = Number(payerId), provider = Number(providerId);
        const fee = Number(price), mana = Number(mpCost);
        if (!Number.isSafeInteger(payer) || payer <= 0 || !Number.isSafeInteger(provider) || provider <= 0
            || payer === provider || !spotId || !Number.isSafeInteger(fee) || fee < 0
            || !Number.isSafeInteger(mana) || mana < 0 || !Array.isArray(effects)
            || effects.length < 1 || effects.length > 20) return Promise.resolve({ ok: false, reason: 'invalid_request' });
        return withCharacterFlush(payer, () => withCharacterFlush(provider, () => inTransaction(() => {
            const rows = [payer, provider].map(id => one('SELECT * FROM bot_life_state WHERE characterId = ?', [id]));
            const [buyer, seller] = rows;
            if (!buyer || !seller || [buyer, seller].some(row => row.phase !== 'cold'
                || row.spotId !== spotId || row.partyId || !['hunting', 'resting'].includes(row.activity))) {
                return { ok: false, reason: 'spot_or_activity_changed' };
            }
            if (Number(buyer.simulationRevision) !== Number(payerRevision)
                || Number(seller.simulationRevision) !== Number(providerRevision)) return { ok: false, reason: 'stale_snapshot' };
            if (Number(seller.mp || 0) < mana) return { ok: false, reason: 'not_enough_mp' };
            const buyerStats = parsedObject(buyer.statsJson), sellerStats = parsedObject(seller.statsJson);
            if (!buyerStats || !sellerStats) return { ok: false, reason: 'invalid_stats' };
            const sellerSkills = sellerStats.coldCombat?.skills?.length
                ? sellerStats.coldCombat.skills
                : invoke('GameServer/Bot/Population/ColdCombatProfile').skillRecordsFromTree(
                    Number(sellerStats.classId || sellerStats.classProgressionClassId || 0), Number(seller.level || 1));
            const known = new Map(sellerSkills.map(skill => [Number(skill.selfId), Number(skill.level)]));
            if (effects.some(effect => !known.has(Number(effect.id)) || known.get(Number(effect.id)) < Number(effect.level))) {
                return { ok: false, reason: 'skill_changed' };
            }
            const currentEffects = (buyerStats.coldCombat?.effects || []).filter(effect => Number(effect.expiresAt || 0) > timestamp);
            if (effects.some(next => currentEffects.some(effect =>
                String(effect.stackFamily || effect.key) === String(next.stackFamily || next.key)
                    && Number(effect.level || 0) >= Number(next.level || 0)
                    && Number(effect.expiresAt || 0) - timestamp > 120000))) {
                return { ok: false, reason: 'already_buffed' };
            }
            const payerBalance = afkTradeAdenaRowsUnsafe(payer).reduce((sum, row) => sum + Number(row.amount || 0), 0);
            if (payerBalance < fee) return { ok: false, reason: 'not_enough_adena' };
            if (fee > 0) {
                afkTradeDebitAdenaUnsafe(payer, fee);
                afkTradeCreditAdenaUnsafe(provider, fee);
            }
            const nextEffects = currentEffects.filter(effect => !effects.some(next =>
                String(effect.stackFamily || effect.key) === String(next.stackFamily || next.key)));
            nextEffects.push(...effects);
            buyerStats.coldCombat = { ...(buyerStats.coldCombat || {}), effects: nextEffects };
            buyerStats.lastBuffServicePurchase = { providerId: provider, price: fee, count: effects.length, at: timestamp };
            sellerStats.lastBuffService = { buyerId: payer, price: fee, count: effects.length, at: timestamp };
            const nextMp = Math.max(0, Number(seller.mp) - mana);
            const buyerAdena = payerBalance - fee;
            const sellerAdena = afkTradeAdenaRowsUnsafe(provider).reduce((sum, row) => sum + Number(row.amount || 0), 0);
            const buyerInventory = parsedObject(buyer.inventorySummary) || {};
            const sellerInventory = parsedObject(seller.inventorySummary) || {};
            buyerInventory['57'] = { ...(buyerInventory['57'] || {}), selfId: 57, name: 'Adena', amount: buyerAdena };
            sellerInventory['57'] = { ...(sellerInventory['57'] || {}), selfId: 57, name: 'Adena', amount: sellerAdena };
            write(`UPDATE bot_life_state SET statsJson = ?, inventorySummary = ?, adena = ?,
                simulationRevision = simulationRevision + 1, updatedAt = ? WHERE characterId = ?`,
            [JSON.stringify(buyerStats), JSON.stringify(buyerInventory), buyerAdena, timestamp, payer]);
            write(`UPDATE bot_life_state SET statsJson = ?, inventorySummary = ?, adena = ?, mp = ?,
                simulationRevision = simulationRevision + 1, updatedAt = ? WHERE characterId = ?`,
            [JSON.stringify(sellerStats), JSON.stringify(sellerInventory), sellerAdena, nextMp, timestamp, provider]);
            write('UPDATE characters SET mp = ? WHERE id = ?', [nextMp, provider]);
            return { ok: true, buyerAdena, sellerAdena, nextMp,
                buyerRevision: Number(buyer.simulationRevision) + 1,
                sellerRevision: Number(seller.simulationRevision) + 1,
                buyerStats, sellerStats, buyerInventory, sellerInventory };
        }, 'buff-service:cold')));
    },

    recordMarketTrade(trade = {}) {
        const eventKey = String(trade.eventKey || '').slice(0, 180);
        const occurredAt = Math.max(1, Math.floor(Number(trade.at || trade.occurredAt || now())));
        const selfId = Math.floor(Number(trade.selfId || 0));
        const quantity = Math.floor(Number(trade.quantity || 0));
        const unitPrice = Math.floor(Number(trade.unitPrice ?? trade.price));
        const totalPrice = quantity * unitPrice;
        const sellerName = trade.seller?.name || trade.sellerName || null;
        const buyerName = trade.buyer?.name || trade.buyerName || null;
        if (!eventKey || !Number.isSafeInteger(selfId) || selfId <= 0
            || !Number.isSafeInteger(quantity) || quantity <= 0
            || !Number.isSafeInteger(unitPrice) || unitPrice < 0
            || !Number.isSafeInteger(totalPrice) || totalPrice < 0) {
            return Promise.reject(new Error('invalid_market_trade'));
        }
        const record = () => {
            const id = recordMarketTradeUnsafe({
                eventKey,
                occurredAt,
                channel: String(trade.channel || 'wts').slice(0, 32),
                sourceType: String(trade.sourceType || '').slice(0, 64),
                selfId,
                itemName: String(trade.itemName || '').slice(0, 160),
                quantity,
                unitPrice,
                totalPrice,
                town: trade.town ? String(trade.town).slice(0, 80) : null,
                sellerCharacterId: Number(trade.seller?.characterId || trade.sellerCharacterId || 0) || null,
                sellerName: sellerName ? String(sellerName).slice(0, 80) : null,
                buyerCharacterId: Number(trade.buyer?.characterId || trade.buyerCharacterId || 0) || null,
                buyerName: buyerName ? String(buyerName).slice(0, 80) : null
            });
            // The row reaches market_trades in the history file shortly; a
            // repeated eventKey is ignored there.
            return { queued: true, outboxId: id };
        };
        return BOARD_TRADE_SOURCES.has(trade.sourceType)
            ? inTransaction(record, 'market:trade-record')
            : enqueue(record, { operation: 'market:trade-record', read: false });
    },

    fetchMarketStoreHistory({ timestamp = now(), rangeMs = 24 * 60 * 60 * 1000, recentLimit = 100 } = {}) {
        const since = Number(timestamp) - Math.max(1, Math.min(MARKET_TRADE_RETENTION_MS, Number(rangeMs) || 86400000));
        const limit = Math.max(1, Math.min(500, Math.floor(Number(recentLimit) || 100)));
        return readHistory(() => ({
            retentionDays: 90,
            since,
            byEvent: History.all(`SELECT eventType, storeType, reason, COUNT(*) AS events
                FROM market_store_events WHERE occurredAt >= ?
                GROUP BY eventType, storeType, reason`, [since]),
            byItem: History.all(`SELECT CAST(json_extract(item.value, '$.selfId') AS INTEGER) AS selfId,
                    json_extract(item.value, '$.name') AS name, events.storeType, COUNT(*) AS openings
                FROM market_store_events events, json_each(events.itemsJson) item
                WHERE events.occurredAt >= ? AND events.eventType = 'opened'
                GROUP BY selfId, events.storeType ORDER BY openings DESC, selfId LIMIT 100`, [since]),
            recent: History.all(`SELECT * FROM market_store_events WHERE occurredAt >= ?
                ORDER BY occurredAt DESC, id DESC LIMIT ${limit}`, [since]).map(({ itemsJson, ...event }) => ({
                ...event, items: JSON.parse(itemsJson)
            }))
        }), 'market:store-history');
    },

    fetchMarketTradeOverview({ timestamp = now(), recentLimit = 200 } = {}) {
        return readHistory(() => ({
            ...MarketTradeOverview.fetch(History.all, { timestamp, recentLimit }),
            economy: require('./MarketEconomyOverview').fetch(History.all, { timestamp })
        }),
            'market:trade-overview');
    },

    fetchMarketBuyerActivity({ timestamp = now(), rangeMs = 24 * 60 * 60 * 1000 } = {}) {
        const since = Number(timestamp) - Math.max(1, Math.min(MARKET_TRADE_RETENTION_MS, Number(rangeMs) || 86400000));
        // A matched AFK trade can write both seller and buyer journal rows.
        // Distinct buyers count that transaction once and bound repeat purchases
        // of the same equipment by one bot during the review window.
        return readHistory(() => History.all(`SELECT selfId, COUNT(DISTINCT buyerCharacterId) AS buyers
            FROM market_trades
            WHERE occurredAt >= ? AND buyerCharacterId > 0
                AND sourceType NOT IN ('npc', 'static_buy_store', 'static_sell_store')
            GROUP BY selfId`, [since]), 'market:buyer-activity');
    },

    // The board deals the market counters replay at start (MarketCounters.load),
    // oldest first: the last `perItem` deals of every item and every deal in
    // the `rangeMs` before the last one, however long ago the server stopped
    // (the counters decay on uptime, not on the wall clock). Only the board's
    // own deals (the rows AfkTrade settlements write, the ones
    // MarketCounters.deal counts live); a private or configured merchant
    // store writes the same wts/wtb channels with its own source.
    // Startup barrier after DataCache/history, before workers. Only migrated
    // lines without state are initialized; later restarts do not consume evidence.
    initializeBoardPricing() {
        return inTransaction(() => {
            ensureBoardCounterCountsUnsafe();
            const lines = all(`SELECT lines.*, shops.storeType FROM afk_trade_lines lines
                JOIN afk_trade_shops shops ON shops.id = lines.shopId
                JOIN characters c ON c.id = shops.ownerId
                WHERE shops.status = 'active' AND lines.count > 0 AND lines.pricingPrice IS NULL
                    AND substr(c.username, 1, 4) = 'bot_'`);
            for (const line of lines) updateLinePricingUnsafe(line, initialLinePricingUnsafe(line.selfId, line.price, line.storeType));
            return { initialized: lines.length };
        }, 'board:pricing-initialize');
    },

    // Startup explicitly chooses retained history once, before line pricing.
    // Existing authoritative counts are preserved; retention makes the seed
    // an incomplete lower bound, not a reconstruction of lifelong experience.
    initializeBotMarketTrades(mode) {
        if (!['zero', 'history'].includes(mode)) return Promise.reject(new Error('invalid_market_trades_seed'));
        return flushHistory().then(() => inTransaction(() => {
            const marker = one("SELECT value FROM world_meta WHERE key = 'botMarketTradesInitialized'");
            if (marker) return { skipped: true, mode: marker.value, rows: [] };
            const MarketCounters = invoke('GameServer/Bot/Economy/MarketCounters');
            if (!invoke('GameServer/DataCache').items?.length) throw new Error('board_market_data_not_ready');
            const totals = new Map();
            if (mode === 'history') {
                const pending = all("SELECT payload FROM history_outbox WHERE kind = 'market_trade' ORDER BY id")
                    .map(row => JSON.parse(row.payload));
                const trades = History.all(`WITH pending AS (SELECT json_extract(value, '$.eventKey') AS eventKey,
                        json_extract(value, '$.selfId') AS selfId, json_extract(value, '$.sourceType') AS sourceType,
                        json_extract(value, '$.unitPrice') AS unitPrice, json_extract(value, '$.quantity') AS quantity,
                        json_extract(value, '$.sellerCharacterId') AS sellerCharacterId,
                        json_extract(value, '$.buyerCharacterId') AS buyerCharacterId, CAST(key AS INTEGER) AS eventOrder
                        FROM json_each(?)),
                    trades AS (SELECT eventKey, selfId, sourceType, unitPrice, quantity, sellerCharacterId,
                        buyerCharacterId, 0 AS stage, id AS eventOrder FROM market_trades
                        UNION ALL SELECT eventKey, selfId, sourceType, unitPrice, quantity, sellerCharacterId,
                            buyerCharacterId, 1 AS stage, eventOrder FROM pending),
                    canonical AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY eventKey ORDER BY stage, eventOrder) AS first FROM trades)
                    SELECT selfId, sellerCharacterId, buyerCharacterId, COUNT(*) AS deals FROM canonical
                    WHERE first = 1 AND sourceType IN ('afk_bot_store', 'afk_player_store', 'afk_bot_buy_store', 'afk_player_buy_store')
                        AND unitPrice > 0 AND quantity > 0 AND selfId != 57
                    GROUP BY selfId, sellerCharacterId, buyerCharacterId`, [JSON.stringify(pending)]);
                for (const trade of trades) for (const id of new Set([trade.sellerCharacterId, trade.buyerCharacterId].map(Number).filter(Boolean))) {
                    const counts = totals.get(id) || {};
                    const key = MarketCounters.counterOf(trade.selfId);
                    counts[key] = Number(counts[key] || 0) + Number(trade.deals);
                    totals.set(id, counts);
                }
            }
            const rows = [];
            for (const life of all(`SELECT life.characterId FROM bot_life_state life
                JOIN characters c ON c.id = life.characterId WHERE substr(c.username, 1, 4) = 'bot_'`)) {
                if (one('SELECT 1 FROM bot_market_counts WHERE characterId=? LIMIT 1', [life.characterId])) continue;
                const counts = totals.get(Number(life.characterId)) || {};
                for (const [counter, deals] of Object.entries(counts)) write(
                    'INSERT INTO bot_market_counts(characterId,counter,deals) VALUES(?,?,?)', [life.characterId, counter, deals]);
                rows.push({ characterId: Number(life.characterId), marketTrades: counts });
            }
            write("INSERT INTO world_meta (key, value) VALUES ('botMarketTradesInitialized', ?)", [mode]);
            return { skipped: false, mode, rows };
        }, 'board:own-trades-initialize'));
    },

    fetchBotMarketCounts() {
        return run('SELECT characterId,counter,deals FROM bot_market_counts', [], 'board:own-counts', true);
    },

    fetchRecentBoardDeals({ perItem = 32, rangeMs = 24 * 60 * 60 * 1000 } = {}) {
        return flushHistory().then(() => enqueue(() => {
            const rows = History.all(`WITH board AS (
                SELECT id, selfId, unitPrice, quantity, occurredAt, sellerCharacterId, buyerCharacterId, town
                FROM market_trades
                WHERE sourceType IN ('afk_bot_store', 'afk_player_store', 'afk_bot_buy_store', 'afk_player_buy_store')
                    AND unitPrice > 0),
            ranked AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY selfId ORDER BY occurredAt DESC, id DESC) AS recent
                FROM board)
            SELECT selfId, unitPrice, quantity, occurredAt, sellerCharacterId, buyerCharacterId, town FROM ranked
            WHERE recent <= ? OR occurredAt >= (SELECT MAX(occurredAt) FROM board) - ?
            ORDER BY occurredAt ASC, id ASC`, [Math.max(1, Math.floor(Number(perItem) || 32)),
            Math.max(0, Number(rangeMs) || 0)]);
            // Initialize at the same queued boundary as the history snapshot,
            // before later trades can advance these world-owned counts.
            if (!one("SELECT value FROM world_meta WHERE key = 'boardDealCountsReady'")) {
                connection.exec('BEGIN IMMEDIATE');
                try {
                    ensureBoardDealCountsUnsafe();
                    connection.exec('COMMIT');
                } catch (error) {
                    connection.exec('ROLLBACK');
                    boardDealCountsReady = false;
                    boardCounterCountsReady = false;
                    throw error;
                }
            }
            const counts = all('SELECT key, value FROM world_meta WHERE key LIKE ?', [`${BOARD_DEAL_COUNT_PREFIX}%`])
                .map(({ key, value }) => ({ selfId: Number(key.slice(BOARD_DEAL_COUNT_PREFIX.length)), deals: Number(value) }));
            const byItem = new Map(counts.map(({ selfId, deals }) => [selfId, deals]));
            for (const row of rows) row.totalDeals = byItem.get(Number(row.selfId)) || 0;
            rows.dealCounts = counts;
            return rows;
        }, { operation: 'market:recent-board-deals', read: false }));
    },

    fetchMarketTradeHistory(selfId, { timestamp = now(), rangeMs = 24 * 60 * 60 * 1000, bucketMs = 60 * 60 * 1000 } = {}) {
        const itemId = Math.floor(Number(selfId || 0));
        if (!Number.isSafeInteger(itemId) || itemId <= 0) return Promise.reject(new Error('invalid_market_item'));
        const current = Math.max(1, Number(timestamp) || now());
        const range = Math.max(60 * 60 * 1000, Math.min(MARKET_TRADE_RETENTION_MS, Math.floor(Number(rangeMs) || 0)));
        const bucket = Math.max(5 * 60 * 1000, Math.min(24 * 60 * 60 * 1000, Math.floor(Number(bucketMs) || 0)));
        const since = current - range;
        return readHistory(() => {
            const levels = History.all(`SELECT CAST(occurredAt / ? AS INTEGER) * ? AS bucketAt,
                unitPrice, COUNT(*) AS trades, SUM(quantity) AS units, SUM(totalPrice) AS adena
                FROM market_trades
                WHERE selfId = ? AND occurredAt >= ? AND occurredAt <= ?
                    AND ${MarketTradeOverview.CANONICAL_FILTER}
                GROUP BY bucketAt, unitPrice ORDER BY bucketAt ASC, unitPrice ASC`,
            [bucket, bucket, itemId, since, current]);
            const grouped = new Map();
            levels.forEach((level) => {
                const bucketAt = Number(level.bucketAt);
                const entry = grouped.get(bucketAt) || { at: bucketAt, trades: 0, units: 0, adena: 0, low: null, high: null, levels: [] };
                const price = Number(level.unitPrice || 0);
                const units = Number(level.units || 0);
                entry.trades += Number(level.trades || 0);
                entry.units += units;
                entry.adena += Number(level.adena || 0);
                entry.low = entry.low === null ? price : Math.min(entry.low, price);
                entry.high = entry.high === null ? price : Math.max(entry.high, price);
                entry.levels.push({ unitPrice: price, units });
                grouped.set(bucketAt, entry);
            });
            const buckets = Array.from(grouped.values()).map((entry) => ({
                at: entry.at,
                trades: entry.trades,
                units: entry.units,
                adena: entry.adena,
                low: entry.low,
                high: entry.high,
                vwap: entry.units ? Math.round(entry.adena / entry.units) : null,
                median: weightedMedianPrice(entry.levels)
            }));
            const allLevels = Array.from(levels.reduce((summary, level) => {
                const price = Number(level.unitPrice || 0);
                summary.set(price, Number(summary.get(price) || 0) + Number(level.units || 0));
                return summary;
            }, new Map()).entries()).map(([unitPrice, units]) => ({ unitPrice, units }));
            const summary = marketTradeAggregate(since, { selfId: itemId, to: current });
            const priceSummary = History.one(`SELECT MIN(unitPrice) AS low, MAX(unitPrice) AS high,
                CASE WHEN SUM(quantity) > 0 THEN CAST(SUM(totalPrice) AS REAL) / SUM(quantity) END AS vwap
                FROM market_trades WHERE selfId = ? AND occurredAt >= ? AND occurredAt <= ?
                    AND ${MarketTradeOverview.CANONICAL_FILTER}`,
            [itemId, since, current]) || {};
            const channels = Object.fromEntries(History.all(`SELECT channel, COUNT(*) AS trades,
                SUM(quantity) AS units, SUM(totalPrice) AS adena
                FROM market_trades WHERE selfId = ? AND occurredAt >= ? AND occurredAt <= ?
                    AND ${MarketTradeOverview.CANONICAL_FILTER}
                GROUP BY channel ORDER BY adena DESC`, [itemId, since, current]).map((row) => [row.channel, {
                trades: Number(row.trades || 0), units: Number(row.units || 0), adena: Number(row.adena || 0)
            }]));
            return {
                selfId: itemId,
                from: since,
                to: current,
                rangeMs: range,
                bucketMs: bucket,
                summary: {
                    ...summary,
                    low: Number(priceSummary.low || 0) || null,
                    high: Number(priceSummary.high || 0) || null,
                    vwap: Number.isFinite(Number(priceSummary.vwap)) ? Math.round(Number(priceSummary.vwap)) : null,
                    median: weightedMedianPrice(allLevels)
                },
                channels,
                buckets
            };
        }, 'market:trade-history');
    },

    // Opens a board record (design 4.1): an AFK shop (`kind` 'shop', the
    // default), a sell ad, a buy ad or an order. In the same transaction the
    // record takes what it holds out of the owner's bag: the items of its sell
    // lines or the escrow of its buy lines. `replace` replaces the owner's
    // shop; `expectedRevision` names the revision of the shop it replaces
    // (the move's idempotency key).
    createAfkTradeShop(ownerId, config = {}) {
        const characterId = Number(ownerId);
        const kind = config.kind || 'shop';
        const rows = Array.isArray(config.lines) ? config.lines.slice() : [];
        if (!characterId || !validBoardRecord(kind, config.storeType, rows)) {
            return Promise.reject(new Error('invalid_afk_trade_shop'));
        }
        return withCharacterFlush(characterId, () => inTransaction(() => {
            const opened = openBoardRecordUnsafe(characterId, { ...config, kind }, rows);
            return {
                shop: opened.shop,
                ownerInventory: afkTradeInventoryUnsafe(characterId),
                coldLifeRows: fenceAfkTradePartiesUnsafe([characterId], opened.changedIds)
            };
        }, 'afk-trade:create'));
    },

    // The owner's records of one kind are replaced by `configs` (each one
    // record) in one transaction: the old ones give back what they hold, the
    // new ones take it. A bot's buy ads follow its goal this way. `expected`
    // maps every record of that kind the caller saw to its revision (the
    // move's idempotency key): any other state refuses the move.
    replaceBoardRecords(ownerId, kind, configs = [], { expected = null, expectedAuthority = null } = {}) {
        const characterId = Number(ownerId);
        const list = Array.isArray(configs) ? configs : [];
        if (!characterId || kind === 'shop' || !BoardRules.isKind(kind)
            || list.some((config) => !validBoardRecord(kind, config.storeType, config.lines || []))) {
            return Promise.reject(new Error('invalid_board_records'));
        }
        return withCharacterFlush(characterId, () => inTransaction(() => {
            if (expectedAuthority) {
                const row = one('SELECT phase,simulationOwner,simulationRevision,simulationLeaseId,lastHotAt FROM bot_life_state WHERE characterId=?',
                    [characterId]);
                if (!row || row.phase !== expectedAuthority.phase || row.simulationOwner !== expectedAuthority.ownerId
                    || Number(row.simulationRevision) !== expectedAuthority.revision
                    || (row.simulationLeaseId || null) !== expectedAuthority.leaseId
                    || Number(row.lastHotAt || 0) !== expectedAuthority.hotAt) throw Error('economy_plan_need_changed');
            }
            const timestamp = now();
            const closed = all('SELECT id FROM afk_trade_shops WHERE ownerId = ? AND kind = ? ORDER BY id', [characterId, kind])
                .map((row) => afkTradeShopUnsafe(row.id));
            if (expected) {
                const seen = Object.keys(expected).map(Number);
                if (seen.length !== closed.length) throw new Error('afk_trade_shop_changed');
                closed.forEach((shop) => {
                    if (!Object.hasOwn(expected, shop.id) || !Number.isSafeInteger(Number(expected[shop.id]))
                        || Number(expected[shop.id]) < 1) throw new Error('afk_trade_shop_changed');
                    checkRecordRevisionUnsafe(shop, expected[shop.id]);
                });
            }
            if (kind === 'buy_ad' && isBotOwnerUnsafe(characterId)) {
                if (!expected) throw Error('afk_trade_shop_changed');
                return reconcileBotBuyAdsUnsafe(characterId, closed, list, timestamp);
            }
            const changedIds = [57];
            closed.forEach((shop) => changedIds.push(...closeBoardRecordUnsafe(shop, { ownMove: true, at: timestamp })));
            const opened = list.map((config) => openBoardRecordUnsafe(characterId, { ...config, kind }, config.lines));
            opened.forEach((record) => changedIds.push(...record.changedIds));
            return {
                closed: closed.map((shop) => closedRecord(shop, 'closed')),
                opened: opened.map((record) => record.shop),
                ownerInventory: afkTradeInventoryUnsafe(characterId),
                coldLifeRows: fenceAfkTradePartiesUnsafe([characterId], changedIds)
            };
        }, 'board:replace'));
    },

    // The owner opens several records of one kind (not shops) in one move;
    // any refusal (a cap, an item gone) moves nothing.
    openBoardRecords(ownerId, kind, configs = []) {
        const characterId = Number(ownerId);
        const list = Array.isArray(configs) ? configs : [];
        if (!characterId || kind === 'shop' || !BoardRules.isKind(kind) || !list.length
            || list.some((config) => !validBoardRecord(kind, config.storeType, config.lines || []))) {
            return Promise.reject(new Error('invalid_board_records'));
        }
        return withCharacterFlush(characterId, () => inTransaction(() => {
            const opened = list.map((config) => openBoardRecordUnsafe(characterId, { ...config, kind }, config.lines));
            return {
                opened: opened.map((record) => record.shop),
                ownerInventory: afkTradeInventoryUnsafe(characterId),
                coldLifeRows: fenceAfkTradePartiesUnsafe([characterId], opened.flatMap((record) => record.changedIds))
            };
        }, 'board:open'));
    },

    // The owner closes its AFK shop (the author's .afkstop): its stock or
    // escrow goes back to its bag.
    closeAfkTradeShop(ownerId) {
        const characterId = Number(ownerId);
        if (!characterId) return Promise.resolve({ closed: false, ownerInventory: [] });
        return withCharacterFlush(characterId, () => inTransaction(() => {
            const shop = one("SELECT * FROM afk_trade_shops WHERE ownerId = ? AND kind = 'shop' AND status = 'active'", [characterId]);
            if (!shop) return { closed: false, ownerInventory: afkTradeInventoryUnsafe(characterId) };
            const changedIds = closeBoardRecordUnsafe(shop);
            return {
                closed: true,
                shopId: Number(shop.id),
                ownerId: characterId,
                ownerInventory: afkTradeInventoryUnsafe(characterId),
                coldLifeRows: fenceAfkTradePartiesUnsafe([characterId], changedIds)
            };
        }, 'afk-trade:close'));
    },

    // The owner closes one of its records (any kind); what it holds goes back
    // to the owner's bag.
    closeBoardRecord(ownerId, recordId, { expectedRevision } = {}) {
        const characterId = Number(ownerId);
        const id = Number(recordId);
        if (!characterId || !id) return Promise.reject(new Error('invalid_board_record'));
        return withCharacterFlush(characterId, () => inTransaction(() => {
            const shop = afkTradeShopUnsafe(id);
            if (!shop || Number(shop.ownerId) !== characterId) return { closed: false, ownerInventory: afkTradeInventoryUnsafe(characterId) };
            checkRecordRevisionUnsafe(shop, expectedRevision);
            const changedIds = closeBoardRecordUnsafe(shop);
            return {
                closed: true,
                record: closedRecord(shop, 'closed'),
                ownerInventory: afkTradeInventoryUnsafe(characterId),
                coldLifeRows: fenceAfkTradePartiesUnsafe([characterId], changedIds)
            };
        }, 'board:close'));
    },

    // The leave rule (design 2.7): an owner leaving the game closes every
    // record it holds, of every kind; items and escrow go back to it.
    closeOwnerBoardRecords(ownerId) {
        const characterId = Number(ownerId);
        if (!characterId) return Promise.resolve({ closed: [], settlementOwners: [] });
        return withCharacterFlush(characterId, () => inTransaction(() => {
            const at = now();
            const closed = all('SELECT id FROM afk_trade_shops WHERE ownerId = ? ORDER BY id', [characterId])
                .map((row) => afkTradeShopUnsafe(row.id));
            closed.forEach((shop) => closeBoardRecordUnsafe(shop, { ownMove: false, at }));
            return {
                closed: closed.map((shop) => closedRecord(shop, 'closed')),
                settlementOwners: pendingSettlementOwners.has(characterId) ? [characterId] : [],
                ownerInventory: afkTradeInventoryUnsafe(characterId)
            };
        }, 'board:leave'));
    },

    // A main-thread save of what waits for a bot on the board: merged unless
    // the worker leases the bot (its commit merges it). Returns the bot's
    // row when its cold state changed, and its bag.
    settleBoardOwner(ownerId) {
        const characterId = Number(ownerId);
        if (!characterId || !pendingSettlementOwners.has(characterId)) return Promise.resolve({ settled: false });
        return withCharacterFlush(characterId, () => inTransaction(() => {
            const life = one('SELECT simulationOwner FROM bot_life_state WHERE characterId = ?', [characterId]);
            if (life?.simulationOwner === COLD_SIMULATION_OWNER) return { settled: false, leased: true };
            const merged = mergeBoardSettlementsUnsafe(characterId, { advance: true });
            if (!merged) return { settled: false };
            return { settled: true, row: merged.row, ownerInventory: afkTradeInventoryUnsafe(characterId) };
        }, 'board:settle'));
    },

    boardSettlementOwners() {
        return [...pendingSettlementOwners];
    },

    // The old world at the first start of the board (Q8 B, user 2026-10-05):
    // every bot record closes once and gives back what it holds; the bots
    // relist under the board's rules at their next review. A physical cold
    // store or a budget-backed buy store in a bot's state is cancelled (its
    // stock and money never left the bag). Players' AFK shops stay as they
    // are. One transaction, once: migration 54 marks a world that traded
    // before the board (boardMigrationPending).
    migrateBoardWorld(at = now()) {
        return inTransaction(() => {
            if (!one("SELECT value FROM world_meta WHERE key = 'boardMigrationPending'")) return { skipped: true };
            const shops = all(`SELECT shops.id FROM afk_trade_shops shops JOIN characters ON characters.id = shops.ownerId
                WHERE substr(characters.username, 1, 4) = 'bot_' ORDER BY shops.id`).map((row) => afkTradeShopUnsafe(row.id));
            const owners = new Map();
            let lines = 0;
            let escrow = 0;
            for (const shop of shops) {
                const ownerId = Number(shop.ownerId);
                if (!owners.has(ownerId)) owners.set(ownerId, new Set([57]));
                lines += shop.lines.filter((line) => Number(line.count) > 0).length;
                escrow += Number(shop.escrowAdena || 0);
                closeBoardRecordUnsafe(shop, { ownMove: true, at }).forEach((selfId) => owners.get(ownerId).add(selfId));
            }
            for (const [ownerId, changedIds] of owners) {
                const row = one('SELECT inventorySummary FROM bot_life_state WHERE characterId = ?', [ownerId]);
                if (row) writeColdInventorySnapshotUnsafe(ownerId, row, [...changedIds]);
            }
            const stores = all(`SELECT characterId, activity, statsJson FROM bot_life_state
                WHERE json_extract(statsJson, '$.marketStore') IS NOT NULL`);
            for (const row of stores) {
                const stats = jsonObject(row.statsJson);
                const merchant = row.activity === 'merchant';
                delete stats.marketStore;
                write(`UPDATE bot_life_state SET statsJson = ?, activity = ?, nextResolveAt = CASE WHEN ? THEN ? ELSE nextResolveAt END,
                    updatedAt = ? WHERE characterId = ?`, [JSON.stringify(stats),
                    merchant ? (stats.marketReturn ? 'shopping' : 'hunting') : row.activity, merchant ? 1 : 0, at, at, row.characterId]);
            }
            const kept = Number(one("SELECT COUNT(*) AS count FROM afk_trade_shops WHERE status = 'active'").count || 0);
            write("DELETE FROM world_meta WHERE key = 'boardMigrationPending'");
            write(`INSERT INTO world_meta (key, value) VALUES ('boardMigrated', ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [String(at)]);
            const touched = [...new Set([...owners.keys(), ...stores.map((row) => Number(row.characterId))])];
            return { closedShops: shops.length, closedLines: lines, returnedEscrow: escrow, owners: owners.size,
                cancelledStores: stores.length, keptRecords: kept,
                rows: touched.map((id) => normalizeRow(one('SELECT * FROM bot_life_state WHERE characterId = ?', [id]))).filter(Boolean) };
        }, 'board:migrate-world');
    },

    // The owner changes the price (and count) of one of its lines: a sell
    // line gives back the rest of its stock, a buy line's escrow follows.
    repriceAfkTradeShop(ownerId, lineId, price, expectedRevision = null, quantity = null, rival = null) {
        const characterId = Number(ownerId);
        const id = Number(lineId);
        const unitPrice = Math.floor(Number(price));
        if (!characterId || !id || !Number.isSafeInteger(unitPrice) || unitPrice < 1
            || (rival !== null && (!Number.isSafeInteger(rival) || rival < 0))) {
            return Promise.reject(new Error('invalid_afk_trade_price'));
        }
        return withCharacterFlush(characterId, () => inTransaction(() => {
            const repriced = repriceAfkTradeLineUnsafe(characterId, id, unitPrice, expectedRevision, quantity, { rival });
            return { shop: repriced.shop, ...afkTradeRepriceMovesUnsafe(characterId, repriced.changedIds, repriced.moved) };
        }, 'afk-trade:reprice'));
    },

    // A bot's look reprices several of its board lines (BotAfkMarketService
    // .applyReview): one transaction for all. A line whose record changed or
    // closed meanwhile, or a bid the wallet cannot cover, is skipped
    // (skipped: [{ lineId, reason }]); the others go on. Returns { shops (the
    // records after the moves), skipped, ownerInventory, coldLifeRows } as
    // repriceAfkTradeShop does.
    repriceBoardLines(ownerId, reprices = [], { withdrawals = [], updates = [],
        coldAuthority = null, hotAuthority = null, canCommitReview = null } = {}) {
        const characterId = Number(ownerId);
        if (!characterId) return Promise.reject(new Error('invalid_afk_trade_price'));
        return withCharacterFlush(characterId, () => inTransaction(() => {
            // The flush can outlive a fence or a handoff. Check authority in
            // this transaction before metadata, quote or escrow writes.
            if (coldAuthority && hotAuthority) throw new Error('invalid_market_review_authority');
            const authority = coldAuthority || hotAuthority;
            if (authority) {
                const life = one(`SELECT phase, simulationOwner, simulationRevision, simulationLeaseId
                    FROM bot_life_state WHERE characterId = ?`, [characterId]);
                if (!life || life.phase !== (coldAuthority ? 'cold' : 'hot') || life.simulationOwner !== authority.ownerId
                    || Number(life.simulationRevision) !== authority.revision
                    || (life.simulationLeaseId || null) !== authority.leaseId) {
                    throw new Error('stale_market_review');
                }
            }
            if (canCommitReview && canCommitReview() !== true) throw new Error('hot_handoff_fenced');
            const shops = new Map();
            const skipped = [];
            const changedIds = [];
            let moved = false;
            let changed = 0;
            let updated = 0;
            const observed = new Map();
            const reviewRecord = (move) => {
                const lineId = Number(move.lineId);
                const shop = one(`SELECT shops.* FROM afk_trade_shops shops JOIN afk_trade_lines lines ON lines.shopId = shops.id
                    WHERE lines.id = ? AND lines.count > 0 AND shops.ownerId = ? AND shops.status = 'active'`, [lineId, characterId]);
                if (!shop) throw new Error('afk_trade_line_unavailable');
                if (!observed.has(Number(shop.id))) observed.set(Number(shop.id), Number(shop.revision));
                if (Number(move.recordId) !== Number(shop.id) || !Number.isSafeInteger(move.expectedRevision)
                    || move.expectedRevision !== observed.get(Number(shop.id))) throw new Error('afk_trade_shop_changed');
                return shop;
            };
            const skip = (move, error) => {
                if (!['afk_trade_shop_unavailable', 'afk_trade_line_unavailable', 'afk_trade_shop_changed',
                    'afk_trade_pricing_changed', 'not_enough_adena', 'invalid_afk_trade_budget'].includes(error.message)) throw error;
                skipped.push({ lineId: Number(move.lineId), reason: error.message });
            };
            for (const reprice of reprices) {
                const id = Number(reprice.lineId);
                const unitPrice = Math.floor(Number(reprice.price));
                if (!id || !Number.isSafeInteger(unitPrice) || unitPrice < 1) {
                    skipped.push({ lineId: id, reason: 'invalid_afk_trade_price' });
                    continue;
                }
                let repriced;
                try {
                    // Fence the original snapshot once per record. Our earlier
                    // lines in this transaction can advance its revision.
                    reviewRecord(reprice);
                    const line = one('SELECT * FROM afk_trade_lines WHERE id = ?', [id]);
                    checkLinePricingUnsafe(line, reprice.previousPricing);
                    if (reprice.pricing) {
                        pricingValues(reprice.pricing);
                        if (reprice.pricing.seenFills > Number(line.fills)) throw new Error('invalid_board_pricing');
                    }
                    repriced = repriceAfkTradeLineUnsafe(characterId, id, unitPrice, null, null,
                        { checkpoint: !reprice.pricing });
                    if (reprice.pricing && updateLinePricingUnsafe(line, reprice.pricing)) updated += 1;
                } catch (error) {
                    skip(reprice, error);
                    continue;
                }
                shops.set(Number(repriced.shop.id), repriced.shop);
                changedIds.push(...repriced.changedIds);
                moved = moved || repriced.moved;
                changed += 1;
            }
            for (const update of updates) {
                try {
                    const shop = reviewRecord(update);
                    const line = one('SELECT * FROM afk_trade_lines WHERE id = ?', [Number(update.lineId)]);
                    checkLinePricingUnsafe(line, update.previousPricing);
                    if (updateLinePricingUnsafe(line, update.pricing)) {
                        shops.set(Number(shop.id), afkTradeShopUnsafe(shop.id));
                        updated += 1;
                    }
                } catch (error) { skip(update, error); }
            }
            const leaving = new Map();
            for (const withdrawal of withdrawals) {
                try {
                    const shop = reviewRecord(withdrawal);
                    const line = one('SELECT * FROM afk_trade_lines WHERE id = ?', [Number(withdrawal.lineId)]);
                    checkLinePricingUnsafe(line, withdrawal.previousPricing);
                    if (!leaving.has(Number(shop.id))) leaving.set(Number(shop.id), new Set());
                    leaving.get(Number(shop.id)).add(Number(withdrawal.lineId));
                } catch (error) { skip(withdrawal, error); }
            }
            for (const [recordId, lineIds] of leaving) {
                const shop = afkTradeShopUnsafe(recordId);
                const lines = shop.lines.filter((line) => Number(line.count) > 0);
                const timestamp = now();
                if (shop.kind !== 'shop' || lines.every((line) => lineIds.has(Number(line.id)))) {
                    changedIds.push(...closeBoardRecordUnsafe(shop, { at: timestamp }));
                    if (Number(shop.storeType) === BoardRules.BUY) changedIds.push(57);
                    shops.set(recordId, closedRecord(shop, 'closed'));
                } else {
                    for (const line of lines.filter((line) => lineIds.has(Number(line.id)))) {
                        if (Number(shop.storeType) === BoardRules.SELL) {
                            afkTradeCreditItemUnsafe(characterId, line, line.count);
                            changedIds.push(Number(line.selfId));
                        } else {
                            const refund = Number(line.price) * Number(line.count);
                            afkTradeCreditAdenaUnsafe(characterId, refund);
                            write('UPDATE afk_trade_shops SET escrowAdena = escrowAdena - ? WHERE id = ?', [refund, recordId]);
                            changedIds.push(57);
                        }
                        write('UPDATE afk_trade_lines SET count = 0, updatedAt = ? WHERE id = ?', [timestamp, line.id]);
                        write('DELETE FROM afk_trade_lines WHERE id = ?', [line.id]);
                    }
                    write('UPDATE afk_trade_shops SET revision = revision + 1, updatedAt = ? WHERE id = ?', [timestamp, recordId]);
                    shops.set(recordId, afkTradeShopUnsafe(recordId));
                }
                moved = true;
                changed += 1;
            }
            return { shops: [...shops.values()].map(shop => shop.status === 'active' ? afkTradeShopUnsafe(shop.id) : shop),
                skipped, changed, updated, ...afkTradeRepriceMovesUnsafe(characterId, changedIds, moved) };
        }, 'afk-trade:reprice-lines'));
    },

    // A buyer in person (a player, or a bot acting now) buys from a sell
    // record: the buyer's bag pays and receives in the same transaction; the
    // record's owner is credited by creditRecordOwnerUnsafe.
    buyFromAfkTradeShop(counterpartyId, details = {}) {
        const buyerId = Number(counterpartyId);
        const shopId = Number(details.shopId);
        const lineId = Number(details.lineId);
        const quantity = Math.floor(Number(details.amount));
        if (!buyerId || !shopId || !lineId || !Number.isSafeInteger(quantity) || quantity < 1) {
            return Promise.reject(new Error('invalid_afk_trade_purchase'));
        }
        return withCharacterFlushes([buyerId, Number(details.ownerId)], () => inTransaction(() => {
            const step = economyStepUnsafe(buyerId, details.economyCommand, EconomyCommit.KINDS.afkBuy);
            if (step?.replay) return { ...step.replay, eventId: step.replay.nativeId,
                totalPrice: step.replay.spent, counterpartyInventory: afkTradeInventoryUnsafe(buyerId),
                coldLifeRows: { [buyerId]: step.replay.coldLifeRow } };
            details.validate?.();
            const shop = one("SELECT * FROM afk_trade_shops WHERE id = ? AND status = 'active' AND storeType = 1", [shopId]);
            if (shop?.custodyPolicy === 1) throw Error('trade_meeting_required');
            if (!shop || Number(shop.ownerId) === buyerId) throw new Error('afk_trade_shop_unavailable');
            const line = one('SELECT * FROM afk_trade_lines WHERE id = ? AND shopId = ?', [lineId, shopId]);
            if (!line || Number(line.count) < quantity) throw new Error('afk_trade_stock_changed');
            if (details.expectedPrice !== undefined && Number(details.expectedPrice) !== Number(line.price)) throw new Error('afk_trade_price_changed');
            if (details.expectedRevision !== undefined && Number(details.expectedRevision) !== Number(shop.revision)) throw new Error('afk_trade_shop_changed');
            const total = Number(line.price) * quantity;
            if (!Number.isSafeInteger(total) || total < 0) throw new Error('invalid_afk_trade_total');
            checkEconomyFundingUnsafe(buyerId, step, total, { ...details.funding, itemId: line.selfId });
            const timestamp = now();
            afkTradeDebitAdenaUnsafe(buyerId, total);
            afkTradeCreditItemUnsafe(buyerId, line, quantity);
            creditRecordOwnerUnsafe(shop.ownerId, { selfId: 57 }, total, timestamp);
            write('UPDATE afk_trade_lines SET count = count - ?, fills = fills + 1, updatedAt = ? WHERE id = ?', [quantity, timestamp, lineId]);
            write('UPDATE afk_trade_shops SET revision = revision + 1, updatedAt = ? WHERE id = ?', [timestamp, shopId]);
            const eventId = Number(recordAfkTradeEventUnsafe({
                shopId, ownerId: shop.ownerId, counterpartyId: buyerId, kind: 'sale', selfId: line.selfId,
                itemName: line.name, amount: quantity, unitPrice: line.price, totalPrice: total, createdAt: timestamp
            }));
            const owner = one('SELECT name, username FROM characters WHERE id = ?', [shop.ownerId]);
            const buyer = one('SELECT name, username FROM characters WHERE id = ?', [buyerId]);
            const botOwned = BoardRules.isBotAccount(owner?.username);
            recordMarketTradeUnsafe({
                eventKey: `afk:${eventId}`, occurredAt: timestamp, channel: botOwned ? 'bot_wts' : 'player_wts',
                sourceType: botOwned ? 'afk_bot_store' : 'afk_player_store', selfId: line.selfId, itemName: line.name,
                quantity, unitPrice: line.price, totalPrice: total, town: shop.town,
                sellerCharacterId: shop.ownerId, sellerName: owner?.name || null,
                buyerCharacterId: buyerId, buyerName: buyer?.name || null
            }, { unique: true });
            const marketTrades = learnBoardTradeUnsafe({ selfId: line.selfId, unitPrice: line.price, quantity,
                sellerCharacterId: shop.ownerId, buyerCharacterId: buyerId }, [[Number(shop.ownerId), owner], [buyerId, buyer]]);
            const before = afkTradeShopUnsafe(shopId);
            const filled = completeAfkTradeIfFilledUnsafe(shopId, timestamp, botOwned);
            const equipped = equipColdPurchaseUnsafe(buyerId, step, line.selfId, details.autoEquip);
            const completedRow = completeEconomyStepUnsafe(buyerId, step,
                { units: quantity, spent: total, nativeId: eventId }, equipped?.ids || [line.selfId], null, null, equipped?.patch);
            return {
                committed: true,
                ...(completedRow ? { economyCommit: jsonObject(completedRow.statsJson).economyCommit } : {}),
                coldLifeRows: completedRow ? { [buyerId]: completedRow } : fenceAfkTradePartiesUnsafe([buyerId], [line.selfId]),
                settlementOwners: pendingSettlementOwners.has(Number(shop.ownerId)) ? [Number(shop.ownerId)] : [],
                eventId,
                marketTrades,
                filled,
                amount: quantity,
                totalPrice: total,
                line: { ...line, count: Number(line.count) - quantity, fills: Number(line.fills) + 1 },
                shop: filled ? closedRecord(before) : afkTradeShopUnsafe(shopId),
                ownerInventory: afkTradeInventoryUnsafe(shop.ownerId),
                counterpartyInventory: afkTradeInventoryUnsafe(buyerId)
            };
        }, 'afk-trade:buy-from-shop'));
    },

    // A seller in person sells into a buy record: the item leaves the
    // seller's bag (no item, no deal: afkTradeTakeItemUnsafe) and the price
    // comes from the record's escrow, in one transaction; the item goes to
    // the record's owner by creditRecordOwnerUnsafe.
    sellToAfkTradeShop(counterpartyId, details = {}) {
        const sellerId = Number(counterpartyId);
        const shopId = Number(details.shopId);
        const lineId = Number(details.lineId);
        const quantity = Math.floor(Number(details.amount));
        if (!sellerId || !shopId || !lineId || !Number.isSafeInteger(quantity) || quantity < 1) {
            return Promise.reject(new Error('invalid_afk_trade_sale'));
        }
        return withCharacterFlushes([sellerId, Number(details.ownerId)], () => inTransaction(() => {
            const step = economyStepUnsafe(sellerId, details.economyCommand, EconomyCommit.KINDS.afkSell);
            if (step?.replay) return { ...step.replay, eventId: step.replay.nativeId,
                totalPrice: step.replay.received, counterpartyInventory: afkTradeInventoryUnsafe(sellerId),
                coldLifeRows: { [sellerId]: step.replay.coldLifeRow } };
            details.validate?.();
            const shop = one("SELECT * FROM afk_trade_shops WHERE id = ? AND status = 'active' AND storeType = 3", [shopId]);
            if (shop?.custodyPolicy === 1) throw Error('trade_meeting_required');
            if (!shop || Number(shop.ownerId) === sellerId) throw new Error('afk_trade_shop_unavailable');
            const line = one('SELECT * FROM afk_trade_lines WHERE id = ? AND shopId = ?', [lineId, shopId]);
            if (!line || Number(line.count) < quantity) throw new Error('afk_trade_demand_changed');
            if (details.expectedPrice !== undefined && Number(details.expectedPrice) !== Number(line.price)) throw new Error('afk_trade_price_changed');
            if (details.expectedRevision !== undefined && Number(details.expectedRevision) !== Number(shop.revision)) throw new Error('afk_trade_shop_changed');
            const total = Number(line.price) * quantity;
            if (!Number.isSafeInteger(total) || total < 1 || Number(shop.escrowAdena) < total) throw new Error('afk_trade_budget_changed');
            checkEconomyMaterialProtectionUnsafe(sellerId, step, line.selfId, quantity);
            const timestamp = now();
            const source = afkTradeTakeItemUnsafe(
                sellerId,
                Number(details.objectId || 0),
                Number(line.selfId),
                Number(line.enchant || 0),
                quantity
            );
            creditRecordOwnerUnsafe(shop.ownerId, { ...source, stackable: Number(line.stackable || 0) }, quantity, timestamp);
            afkTradeCreditAdenaUnsafe(sellerId, total);
            write('UPDATE afk_trade_lines SET count = count - ?, fills = fills + 1, updatedAt = ? WHERE id = ?', [quantity, timestamp, lineId]);
            write(`UPDATE afk_trade_shops
                SET escrowAdena = escrowAdena - ?, revision = revision + 1, updatedAt = ?
                WHERE id = ?`, [total, timestamp, shopId]);
            const eventId = Number(recordAfkTradeEventUnsafe({
                shopId, ownerId: shop.ownerId, counterpartyId: sellerId, kind: 'purchase', selfId: line.selfId,
                itemName: line.name, amount: quantity, unitPrice: line.price, totalPrice: total, createdAt: timestamp
            }));
            const seller = one('SELECT name, username FROM characters WHERE id = ?', [sellerId]);
            const owner = one('SELECT name, username FROM characters WHERE id = ?', [shop.ownerId]);
            const botOwned = BoardRules.isBotAccount(owner?.username);
            recordMarketTradeUnsafe({
                eventKey: `afk:${eventId}`, occurredAt: timestamp, channel: 'wtb',
                sourceType: botOwned ? 'afk_bot_buy_store' : 'afk_player_buy_store', selfId: line.selfId, itemName: line.name,
                quantity, unitPrice: line.price, totalPrice: total, town: shop.town,
                sellerCharacterId: sellerId, sellerName: seller?.name || null,
                buyerCharacterId: shop.ownerId, buyerName: owner?.name || null
            }, { unique: true });
            const marketTrades = learnBoardTradeUnsafe({ selfId: line.selfId, unitPrice: line.price, quantity,
                sellerCharacterId: sellerId, buyerCharacterId: shop.ownerId }, [[sellerId, seller], [Number(shop.ownerId), owner]]);
            const before = afkTradeShopUnsafe(shopId);
            const filled = completeAfkTradeIfFilledUnsafe(shopId, timestamp, botOwned);
            const completedRow = completeEconomyStepUnsafe(sellerId, step,
                { units: quantity, received: total, nativeId: eventId }, [line.selfId]);
            return {
                committed: true,
                ...(completedRow ? { economyCommit: jsonObject(completedRow.statsJson).economyCommit } : {}),
                coldLifeRows: completedRow ? { [sellerId]: completedRow } : fenceAfkTradePartiesUnsafe([sellerId], [line.selfId]),
                settlementOwners: pendingSettlementOwners.has(Number(shop.ownerId)) ? [Number(shop.ownerId)] : [],
                eventId,
                marketTrades,
                filled,
                amount: quantity,
                totalPrice: total,
                line: { ...line, count: Number(line.count) - quantity, fills: Number(line.fills) + 1 },
                shop: filled ? closedRecord(before) : afkTradeShopUnsafe(shopId),
                ownerInventory: afkTradeInventoryUnsafe(shop.ownerId),
                counterpartyInventory: afkTradeInventoryUnsafe(sellerId)
            };
        }, 'afk-trade:sell-to-shop'));
    },

    fetchAfkTradeShops(ownerId = null, { activeOnly = true } = {}) {
        const where = [activeOnly ? "shops.status = 'active'" : '1 = 1'];
        const params = [];
        if (Number(ownerId)) {
            where.push('shops.ownerId = ?');
            params.push(Number(ownerId));
        }
        const condition = where.join(' AND ');
        return Promise.all([
            run(`SELECT shops.*, characters.name AS ownerName, characters.username AS ownerAccount
                FROM afk_trade_shops shops JOIN characters ON characters.id = shops.ownerId
                WHERE ${condition} ORDER BY shops.id`, params, 'afk-trade:list'),
            run(`SELECT lines.* FROM afk_trade_lines lines
                JOIN afk_trade_shops shops ON shops.id = lines.shopId
                WHERE ${condition} ORDER BY lines.shopId, lines.id`, params, 'afk-trade:lines')
        ]).then(([shops, lines]) => {
            const byShop = new Map();
            lines.forEach((line) => {
                const shopLines = byShop.get(Number(line.shopId)) || [];
                const pricing = linePricing(line);
                shopLines.push({ ...line, ...(pricing ? { pricing } : {}) });
                byShop.set(Number(line.shopId), shopLines);
            });
            return shops.map((shop) => ({
                ...shop,
                appearance: jsonObject(shop.appearanceJson),
                lines: byShop.get(Number(shop.id)) || []
            }));
        });
    },

    fetchAfkTradeNotifications(ownerId, limit = 50) {
        const safeLimit = Math.max(1, Math.min(200, Math.floor(Number(limit) || 50)));
        return readHistory(() => History.all(`SELECT * FROM afk_trade_events
            WHERE ownerId = ? AND deliveredAt IS NULL
            ORDER BY id ASC LIMIT ${safeLimit}`, [Number(ownerId)]), 'afk-trade:notifications');
    },

    markAfkTradeNotificationsDelivered(ownerId, eventIds = []) {
        const ids = [...new Set((eventIds || []).map(Number).filter(Boolean))];
        if (!ids.length) return Promise.resolve({ affectedRows: 0 });
        // Through the outbox, so it lands after the events it marks even when
        // they have not reached the history file yet.
        return enqueue(() => {
            historyOutboxUnsafe('afk_delivered', { ownerId: Number(ownerId), ids, at: now() });
            return { queued: ids.length };
        }, { operation: 'afk-trade:notifications-delivered' });
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

    commitInteractionMemory(events) {
        if (!Array.isArray(events) || !events.length || events.length > InteractionMemoryPolicy.MAX_BATCH) {
            return Promise.reject(new Error('interaction memory: invalid batch'));
        }
        // Normalize before queuing: callers cannot mutate an in-flight batch.
        const batch = events.map(InteractionMemoryPolicy.event);
        return inTransaction(() => commitInteractionMemoryUnsafe(batch, now()), 'social-memory:commit');
    },

    loadInteractionMemories(ownerIds) {
        const ids = ownerIds.map(InteractionMemoryPolicy.id);
        if (ids.length > InteractionMemoryPolicy.MAX_BATCH) return Promise.reject(Error('interaction memory: invalid load batch'));
        return enqueue(() => ids.map(id => require('./GameServer/Social/InteractionMemoryRows').load({ one, all }, id)), { operation: 'social-memory:load', read: true });
    },

    saveBackgroundParty(row) {
        return inTransaction(() => {
            const previous = one('SELECT * FROM bot_background_parties WHERE partyId = ?', [row.partyId]);
            if (previous?.status === 'hot' || Number(jsonObject(previous?.statsJson).clanGoalInvalidationVersion || 0)
                > Number(jsonObject(row.statsJson).clanGoalInvalidationVersion || 0)) return { affectedRows: 0 };
            const payment = partyAgreementUnsafe(previous, row);
            row = payment.row;
            const result = write(`INSERT INTO bot_background_parties (
                partyId, leaderId, memberIdsJson, spotId, startedAt, nextResolveAt,
                cohesion, risk, status, roleCoverageJson, statsJson, updatedAt
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(partyId) DO UPDATE SET
                leaderId = excluded.leaderId, memberIdsJson = excluded.memberIdsJson,
                spotId = excluded.spotId, nextResolveAt = excluded.nextResolveAt,
                cohesion = excluded.cohesion, risk = excluded.risk, status = excluded.status,
                roleCoverageJson = excluded.roleCoverageJson, statsJson = excluded.statsJson, updatedAt = excluded.updatedAt`,
            [row.partyId, row.leaderId, row.memberIdsJson, row.spotId, row.startedAt, row.nextResolveAt,
                row.cohesion, row.risk, row.status, row.roleCoverageJson, row.statsJson,
                Math.max(Number(row.updatedAt), Number(previous?.updatedAt || 0) + 1)]);
            return { ...result, row: one('SELECT * FROM bot_background_parties WHERE partyId = ?', [row.partyId]),
                lifeRows: [...payment.touched].map(coldSimulationRow) };
        }, 'bot-party:save-agreement');
    },

    commitBackgroundPartyGoals({ partyId, expectedUpdatedAt, leaderId, memberIds, sources, statsJson, updatedAt } = {}) {
        const ids = Array.isArray(memberIds) ? memberIds : [];
        if (!partyId || ids.length < 1 || ids.length > 9 || new Set(ids).size !== ids.length
            || !ids.every(id => Number.isSafeInteger(id) && id > 0) || !ids.includes(leaderId)
            || !Array.isArray(sources) || sources.length !== ids.length
            || new Set(sources.map(source => source.characterId)).size !== ids.length
            || sources.some(source => !ids.includes(source.characterId) || source.phase !== 'cold'
                || source.partyId !== partyId || !Number.isSafeInteger(source.updatedAt)
                || !Number.isSafeInteger(source.revision) || source.revision < 0)
            || !Number.isSafeInteger(expectedUpdatedAt) || !Number.isSafeInteger(updatedAt)
            || updatedAt <= expectedUpdatedAt || typeof statsJson !== 'string')
            return Promise.resolve({ ok: false, reason: 'invalid_party_goals' });
        return inTransaction(() => {
            const party = one('SELECT * FROM bot_background_parties WHERE partyId = ?', [partyId]);
            if (party?.status !== 'active' || Number(party.updatedAt) !== expectedUpdatedAt
                || Number(party.leaderId) !== leaderId || party.memberIdsJson !== JSON.stringify(ids))
                return { ok: false, reason: 'party_goals_changed' };
            const rows = all(`SELECT characterId, phase, partyId, updatedAt, simulationOwner,
                simulationRevision, simulationLeaseId FROM bot_life_state
                WHERE characterId IN (${ids.map(() => '?').join(',')})`, ids);
            const byId = new Map(rows.map(row => [Number(row.characterId), row]));
            if (sources.some(source => {
                const row = byId.get(source.characterId);
                return !row || row.phase !== source.phase || row.partyId !== source.partyId
                    || Number(row.updatedAt) !== source.updatedAt
                    || String(row.simulationOwner || LEGACY_SIMULATION_OWNER) !== source.ownerId
                    || Number(row.simulationRevision || 0) !== source.revision
                    || String(row.simulationLeaseId || '') !== source.leaseId;
            })) return { ok: false, reason: 'party_goal_member_changed' };
            write('UPDATE bot_background_parties SET statsJson = ?, updatedAt = ? WHERE partyId = ?',
                [statsJson, updatedAt, partyId]);
            return { ok: true, partyRow: one('SELECT * FROM bot_background_parties WHERE partyId = ?', [partyId]) };
        });
    },

    commitBackgroundPartyMembership({ party, members = [], event = null, review = false, expectedPartyUpdatedAt = null,
        expectedPhase = 'cold', canCommitHot = null, preserveClanOperations = false } = {}) {
        const batch = Array.isArray(members) ? members.slice(0, 40) : [];
        const characterIds = [...new Set(batch.map((entry) => Number(entry?.row?.characterId)).filter((id) => (
            Number.isSafeInteger(id) && id > 0
        )))];
        if (!party?.partyId || !characterIds.length || characterIds.length !== batch.length) {
            return Promise.resolve({ ok: false, reason: 'invalid_party_membership' });
        }

        return inTransaction(() => {
            if (!['cold', 'hot'].includes(expectedPhase)) return { ok: false, reason: 'invalid_membership_phase' };
            if (expectedPhase === 'hot') {
                const declared = JSON.parse(party.memberIdsJson || '[]').map(Number);
                const existing = one('SELECT status, memberIdsJson, updatedAt FROM bot_background_parties WHERE partyId = ?', [party.partyId]);
                const previousIds = existing ? JSON.parse(existing.memberIdsJson || '[]').map(Number) : [];
                if (review || party.status !== 'hot' || declared.length < 2 || declared.length > 9
                    || declared.length !== characterIds.length || !declared.includes(Number(party.leaderId))
                    || new Set(declared).size !== declared.length || declared.some(id => !characterIds.includes(id))
                    || batch.some(e => e.row.partyId !== party.partyId || (e.expectedPartyId && e.expectedPartyId !== party.partyId))
                    || (expectedPartyUpdatedAt === null ? !!existing : existing?.status !== 'hot'
                        || Number(existing.updatedAt) !== Number(expectedPartyUpdatedAt)
                        || previousIds.some(id => !characterIds.includes(id))
                        || batch.some(e => !!e.expectedPartyId !== previousIds.includes(Number(e.row.characterId))))
                    || typeof canCommitHot !== 'function' || !canCommitHot()) return { ok: false, reason: 'hot_party_context_changed' };
            }
            if (review) {
                const existing = one('SELECT status, memberIdsJson, updatedAt FROM bot_background_parties WHERE partyId = ?', [party.partyId]);
                const ids = existing ? JSON.parse(existing.memberIdsJson || '[]').map(Number) : [];
                const retained = JSON.parse(party.memberIdsJson || '[]').map(Number);
                if (existing?.status !== 'active' || Number(existing.updatedAt) !== Number(expectedPartyUpdatedAt)
                    || ids.length !== characterIds.length || ids.some(id => !characterIds.includes(id))
                    || retained.some(id => !characterIds.includes(id))
                    || batch.some(entry => entry.expectedPartyId !== party.partyId
                        || String(entry.row.partyId || '') !== (retained.includes(Number(entry.row.characterId)) ? party.partyId : ''))) {
                    return { ok: false, reason: 'party_review_membership_changed' };
                }
            }
            const placeholders = characterIds.map(() => '?').join(', ');
            const currentRows = all(`SELECT characterId, phase, simulationOwner, simulationRevision, simulationLeaseId, partyId, updatedAt
                FROM bot_life_state WHERE characterId IN (${placeholders})`, characterIds);
            const currentById = new Map(currentRows.map((row) => [Number(row.characterId), row]));
            const conflicts = batch.filter((entry) => {
                const row = entry.row;
                const current = currentById.get(Number(row.characterId));
                return !current
                    || current.phase !== expectedPhase
                    || String(current.simulationOwner || LEGACY_SIMULATION_OWNER) !== LEGACY_SIMULATION_OWNER
                    || String(current.partyId || '') !== String(entry.expectedPartyId || '')
                    || Number(current.updatedAt || 0) !== Number(entry.expectedUpdatedAt || 0)
                    || entry.expectedSimulationRevision !== undefined
                        && Number(current.simulationRevision || 0) !== entry.expectedSimulationRevision
                    || entry.expectedSimulationLeaseId !== undefined
                        && String(current.simulationLeaseId || '') !== entry.expectedSimulationLeaseId;
            }).map((entry) => Number(entry.row.characterId));
            if (conflicts.length) return { ok: false, reason: 'membership_conflict', conflicts };

            const reserved = all(`SELECT characterId FROM clan_operation_members
                WHERE characterId IN (${placeholders}) AND status = 'active'`, characterIds)
                .map((row) => Number(row.characterId));
            if (reserved.length && (!review || preserveClanOperations)) return { ok: false, reason: 'clan_operation_reserved', conflicts: reserved };

            const previousParty = one('SELECT * FROM bot_background_parties WHERE partyId = ?', [party.partyId]);
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
                        partyId = ?, statsJson = ?, updatedAt = ?, spotId = COALESCE(?, spotId)
                    WHERE characterId = ?
                    AND phase = ?
                    AND simulationOwner = ?
                    AND COALESCE(partyId, '') = ?
                    AND updatedAt = ?`, [
                    row.activity, row.activityStartedAt, row.nextResolveAt,
                    row.partyId, row.statsJson, row.updatedAt,
                    expectedPhase === 'hot' ? row.spotId : null,
                    row.characterId, expectedPhase, LEGACY_SIMULATION_OWNER,
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
                // Kept per bot by weight here (the life events service keeps
                // the most recent ones); both rules live in HistoryStore.
                historyOutboxUnsafe('life_events', {
                    characterId: eventCharacterId,
                    prune: 'weight',
                    events: [{
                        eventType,
                        summary: eventSummary,
                        weight: Math.max(1, Number(event?.weight || 1)),
                        createdAt: Number(event?.createdAt || Date.now()),
                        meta: event?.meta || {}
                    }]
                });
            }

            const payment = partyAgreementUnsafe(previousParty, party);
            write('UPDATE bot_background_parties SET statsJson = ? WHERE partyId = ?', [payment.row.statsJson, party.partyId]);
            return { ok: true, partyId: party.partyId, characterIds,
                partyRow: one('SELECT * FROM bot_background_parties WHERE partyId = ?', [party.partyId]),
                lifeRows: characterIds.map(coldSimulationRow) };
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
            const { row, stats } = coldClaimRow(characterId);
            const partition = coldSimulationPartition(row, request, stats);
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
            const { row, stats } = coldClaimRow(characterId);
            const partition = coldSimulationPartition(row, request, stats);
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
                ...(request.memoryEvents !== undefined ? { memorySnapshots: commitColdInteractionMemoryUnsafe(request) || [] } : {}),
                row: coldSimulationRow(characterId)
            };
        }, 'bot-life:cold-owner-commit');
    },

    commitAndReleaseColdSimulationLeases(requests = []) {
        const batch = Array.isArray(requests) ? requests.slice(0, 32) : [];
        if (!batch.length) return Promise.resolve([]);
        if (batch.reduce((count, request) => count + (request.memoryEvents?.length || 0), 0) > InteractionMemoryPolicy.MAX_BATCH) {
            return Promise.reject(new Error('interaction memory: cold transaction event budget exceeded'));
        }
        const atomicGroupFailures = new Map();
        const atomicGroups = new Map();
        batch.forEach((request) => {
            const groupId = request.atomicGroup?.id ? String(request.atomicGroup.id) : null;
            if (!groupId) return;
            const group = atomicGroups.get(groupId) || [];
            group.push(request);
            atomicGroups.set(groupId, group);
        });
        const validatedRaidKeys = new Set();
        const validateAtomicGroups = () => atomicGroups.forEach((group, groupId) => {
            const expectedIds = new Set((group[0]?.atomicGroup?.memberIds || []).map(Number).filter(Boolean));
            const presentIds = new Set(group.map((request) => Number(request.characterId)).filter(Boolean));
            let failure = expectedIds.size === 0
                || expectedIds.size !== presentIds.size
                || [...expectedIds].some((id) => !presentIds.has(id));
            let reason = failure ? 'party_group_incomplete' : null;
            const pvpContext = group[0]?.atomicGroup?.pvpContext;
            const raidCommit = group[0]?.atomicGroup?.raidCommit;
            if (!failure && raidCommit) {
                const saved = one('SELECT revision FROM bot_raid_encounters WHERE raidKey = ?', [raidCommit.key]);
                failure = validatedRaidKeys.has(raidCommit.key) || Number(saved?.revision || 0) !== raidCommit.expectedRevision
                    || !Number.isSafeInteger(raidCommit.expectedRevision) || raidCommit.expectedRevision < 0
                    || raidCommit.revision !== raidCommit.expectedRevision + 1
                    || raidCommit.snapshot?.key !== raidCommit.key
                    || group[0].atomicGroup.partyChanges?.length !== 1;
                if (failure) reason = 'raid_revision_changed';
            }
            if (!failure && pvpContext) {
                const members = Array.isArray(pvpContext) ? pvpContext.flat() : [];
                const rows = members.map(m => one('SELECT id, clanId, karma FROM characters WHERE id = ?', [m.id]));
                failure = pvpContext.length !== 2 || members.length > 18 || members.length !== expectedIds.size
                    || new Set(members.map(m => m.id)).size !== expectedIds.size
                    || members.some((m, i) => !expectedIds.has(m.id) || !rows[i]
                        || Number(rows[i].clanId || 0) !== m.clanId || Number(rows[i].karma || 0) !== m.karma)
                    || pvpContext[0].some(a => pvpContext[1].some(b => a.clanId > 0 && a.clanId === b.clanId));
                if (failure) reason = 'pvp_context_changed';
            }
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
                    const { patch, stats } = preserveColdVersionedStatsParsed(row, requestedPatch);
                    const proposed = { ...row, ...patch, phase: patch.phase || row?.phase, activity: patch.activity || row?.activity };
                    const partition = coldSimulationPartition(proposed, request, stats);
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
            if (!failure && group[0]?.atomicGroup?.partyChanges !== undefined) {
                const changes = group[0].atomicGroup.partyChanges;
                failure = !Array.isArray(changes) || changes.length > 2
                    || new Set(changes.map(change => change.partyId)).size !== changes.length;
                if (!failure) for (const change of changes) {
                    const party = one('SELECT status, memberIdsJson, updatedAt FROM bot_background_parties WHERE partyId = ?', [change.partyId]);
                    const ids = party ? JSON.parse(party.memberIdsJson || '[]').map(Number) : [];
                    const expected = change.memberIds || [];
                    if (party?.status !== 'active' || Number(party.updatedAt) !== Number(change.expectedUpdatedAt)
                        || ids.length < 2 || ids.length > 9 || ids.length !== expected.length
                        || new Set(expected).size !== expected.length || ids.some(id => !expected.includes(id) || !presentIds.has(id)
                            || coldSimulationRow(id)?.partyId !== change.partyId)
                        || !Number.isSafeInteger(change.updatedAt) || change.updatedAt <= Number(party.updatedAt)
                        || (change.nextResolveAt !== null && (!Number.isSafeInteger(change.nextResolveAt) || change.nextResolveAt < 0))
                        || (change.spotId !== undefined && (typeof change.spotId !== 'string' || !change.spotId.length || change.spotId.length > 256))
                        || (change.status !== undefined && !['active', 'dissolved'].includes(change.status))
                        || !change.statsJson || typeof JSON.parse(change.statsJson) !== 'object') {
                        failure = true;
                        break;
                    }
                }
                if (failure) reason = 'party_context_changed';
            }
            if (failure) atomicGroupFailures.set(groupId, reason || 'party_group_aborted');
            else if (raidCommit) validatedRaidKeys.add(raidCommit.key);
        });
        const commitBatch = () => batch.map((request) => {
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
            const { patch, stats, deathExperience } = preserveColdVersionedStatsParsed(row, requestedPatch);
            const proposed = { ...row, ...patch, phase: patch.phase || row.phase, activity: patch.activity || row.activity };
            const partition = coldSimulationPartition(proposed, request, stats);
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
            EconomyJournal.detail(request.journalReason || 'resolve');
            const pkDrops = physical ? applyColdPhysicalStateUnsafe(characterId, physical) : [];
            // What deals and closed records left for the bot on the board while
            // the worker held it reaches its bag with this save.
            EconomyJournal.detail('board_settlement');
            const settled = pendingSettlementOwners.has(characterId)
                ? mergeBoardSettlementsUnsafe(characterId, { advance: false }) : null;
            EconomyJournal.detail(null);
            // Persist the entitlement under the same lease fence and transaction
            // as EXP. Cold-to-hot resurrection reads this durable record.
            syncColdDeathExperienceUnsafe(characterId, deathExperience, timestamp);
            return {
                ok: true,
                characterId,
                ownerId: LEGACY_SIMULATION_OWNER,
                leaseId: null,
                revision,
                leaseUntil: 0,
                reason: 'committed_released',
                ...(pkDrops.length ? { pkDrops } : {}),
                ...(request.memoryEvents !== undefined ? { memorySnapshots: commitColdInteractionMemoryUnsafe(request) || [] } : {}),
                ...(settled ? { settled: true } : {}),
                row: coldSimulationRow(characterId)
            };
        });
        return inTransaction(() => {
            // Validate all participants after earlier queued writes have settled.
            // Preflight outside this transaction could allow half an encounter.
            validateAtomicGroups();
            const results = commitBatch();
            for (const [groupId, group] of atomicGroups) {
                if (atomicGroupFailures.has(groupId)) continue;
                const changes = group[0].atomicGroup.partyChanges || [];
                if (!changes.length) continue;
                if (group.some(request => !results.find(result => result.characterId === Number(request.characterId))?.ok)) {
                    throw new Error('party conflict: incomplete atomic outcome');
                }
                for (const change of changes) {
                    const previous = one('SELECT * FROM bot_background_parties WHERE partyId = ?', [change.partyId]);
                    const payment = partyAgreementUnsafe(previous, { ...previous, ...change });
                    change.statsJson = payment.row.statsJson;
                    const updated = write(`UPDATE bot_background_parties SET nextResolveAt = ?, statsJson = ?, updatedAt = ?, spotId = COALESCE(?, spotId),
                        status = COALESCE(?, status), cohesion = COALESCE(?, cohesion), risk = COALESCE(?, risk)
                        WHERE partyId = ? AND status = 'active' AND updatedAt = ?`,
                    [change.nextResolveAt, change.statsJson, change.updatedAt, change.spotId ?? null,
                        change.status ?? null, change.cohesion ?? null, change.risk ?? null, change.partyId, change.expectedUpdatedAt]);
                    if (updated.affectedRows !== 1) throw new Error('party conflict: party changed during commit');
                    for (const request of group) {
                        const result = results.find(result => result.characterId === Number(request.characterId));
                        result.row = coldSimulationRow(result.characterId);
                        result.revision = Number(result.row.simulationRevision);
                        result.partyRow = one('SELECT * FROM bot_background_parties WHERE partyId = ?', [change.partyId]);
                    }
                }
                const raidCommit = group[0].atomicGroup.raidCommit;
                if (raidCommit) {
                    write(`INSERT INTO bot_raid_encounters(raidKey, revision, snapshotJson) VALUES (?, ?, ?)
                        ON CONFLICT(raidKey) DO UPDATE SET revision=excluded.revision, snapshotJson=excluded.snapshotJson`,
                    [raidCommit.key, raidCommit.revision, JSON.stringify(raidCommit.snapshot)]);
                    if (raidCommit.worldDefeat) {
                        const defeat = raidCommit.worldDefeat;
                        write(`INSERT INTO raid_boss_state(npcId, respawnTime, hp, mp, updatedAt) VALUES (?, ?, 0, 0, ?)
                            ON CONFLICT(npcId) DO UPDATE SET respawnTime=excluded.respawnTime, hp=0, mp=0, updatedAt=excluded.updatedAt`,
                        [defeat.npcId, defeat.respawnTime, now()]);
                    }
                    for (const request of group) {
                        const result = results.find(result => result.characterId === Number(request.characterId));
                        result.raidRow = one('SELECT * FROM bot_raid_encounters WHERE raidKey = ?', [raidCommit.key]);
                        result.raidRespawnAt = raidCommit.worldDefeat?.respawnTime || null;
                        result.raidPartyRow = one('SELECT * FROM bot_background_parties WHERE partyId = ?', [changes[0].partyId]);
                    }
                }
            }
            return results;
        }, 'bot-life:cold-owner-commit-release-batch');
    },

    releaseColdSimulationLeases(requests = []) {
        const batch = Array.isArray(requests) ? requests.slice(0, 64) : [];
        if (!batch.length) return Promise.resolve([]);
        return inTransaction(() => batch.map((request) => {
            const characterId = Number(request.characterId);
            let expectedRevision = Number(request.expectedRevision);
            const ownerId = String(request.ownerId || COLD_SIMULATION_OWNER);
            const leaseId = String(request.leaseId || '');
            const timestamp = Number(request.timestamp || now());
            const row = coldSimulationRow(characterId);
            // A clan inventory write can advance the row while retaining the
            // same lease. Its rejected proposal must still relinquish that
            // lease; otherwise renewal keeps an abandoned owner alive forever.
            // This opt-in path changes ownership only, never character data.
            if (request.releaseInvalidated === true && row?.phase === 'cold'
                && leaseId && row.simulationLeaseId === leaseId
                && row.simulationOwner === ownerId
                && Number(row.simulationRevision) > expectedRevision) {
                expectedRevision = Number(row.simulationRevision);
            }
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

    renewColdSimulationLeases(tokens = [], {
        now: clock = Date.now,
        leaseMs = 30000,
        canRenew
    } = {}) {
        const batch = Array.isArray(tokens) && tokens.length <= ColdProtocol.MAX_BATCH
            ? tokens.map(ColdProtocol.leaseRenewalToken) : null;
        const ids = new Set(batch?.filter(Boolean).map(token => token.characterId));
        if (!batch || batch.length > ColdProtocol.MAX_BATCH || batch.some(token => !token)
            || ids.size !== batch.length || (batch.length && (typeof clock !== 'function'
                || typeof canRenew !== 'function' || !Number.isSafeInteger(leaseMs) || leaseMs < 1000))) {
            return Promise.reject(new Error('invalid_lease_renewal_batch'));
        }
        if (!batch.length) return Promise.resolve([]);
        return withCharacterFlushes([...ids], () => inTransaction(() => batch.map(token => {
            const cutoff = clock();
            if (!Number.isSafeInteger(cutoff) || cutoff < 0 || !Number.isSafeInteger(cutoff + leaseMs)) {
                throw new Error('invalid_lease_renewal_clock');
            }
            const refused = reason => ({ ok: false, ...token, reason });
            if (canRenew(token) !== true) return refused('renewal_source_changed');
            const current = one(`SELECT phase, simulationOwner, simulationRevision, simulationLeaseId,
                simulationLeaseUntil FROM bot_life_state WHERE characterId = ?`, [token.characterId]);
            if (!current) return refused('missing_state');
            if (current.phase !== 'cold') return refused('not_cold');
            if (current.simulationOwner !== token.ownerId) return refused('owner_changed');
            if (Number(current.simulationRevision) !== token.revision) return refused('stale_revision');
            if (current.simulationLeaseId !== token.leaseId) return refused('lease_changed');
            if (Number(current.simulationLeaseUntil) <= cutoff) return refused('lease_expired');
            const leaseUntil = Math.max(Number(current.simulationLeaseUntil), cutoff + leaseMs);
            const result = write(`UPDATE bot_life_state
                SET simulationLeaseUntil = ?
                WHERE characterId = ? AND phase = 'cold' AND simulationOwner = ?
                  AND simulationRevision = ? AND simulationLeaseId = ?
                  AND simulationLeaseUntil > ?`, [
                leaseUntil, token.characterId, token.ownerId, token.revision, token.leaseId, cutoff
            ]);
            return result.affectedRows === 1 ? { ok: true, ...token, leaseUntil, reason: 'renewed' }
                : refused('renewal_cas_failed');
        }), 'bot-life:cold-owner-renew-batch'));
    },

    endPvpEncounter(key, ids, outcome = 'pvp_expired') {
        if (typeof key !== 'string' || !Array.isArray(ids) || ids.length > 18) return Promise.resolve({ rows: [], complete: false });
        return inTransaction(() => {
            const rows = [], parties = [], partyIds = new Set(), timestamp = now();
            let complete = true;
            for (const id of ids) {
                const row = coldSimulationRow(Number(id));
                const stats = row && JSON.parse(row.statsJson || '{}');
                if (row?.partyId) partyIds.add(row.partyId);
                if (stats?.pvpEncounter?.key !== key && !(stats?.coldCompetition?.key === key
                    && stats.coldCompetition.outcome === 'pvp_fighting' && !stats.pvpEncounter)) continue;
                if (row.simulationLeaseId) { complete = false; continue; }
                stats.pvpEncounter = null;
                if (stats.coldCompetition?.key === key) {
                    stats.coldCompetition = { ...stats.coldCompetition, wait: null, outcome, endedAt: timestamp };
                }
                write('UPDATE bot_life_state SET statsJson = ?, lastResolvedAt = ?, nextResolveAt = ?, simulationRevision = simulationRevision + 1, updatedAt = ? WHERE characterId = ?',
                    [JSON.stringify(stats), timestamp, row.phase === 'cold' ? timestamp + 1000 : null, timestamp, id]);
                rows.push(coldSimulationRow(id));
            }
            for (const partyId of partyIds) {
                const party = one('SELECT * FROM bot_background_parties WHERE partyId = ?', [partyId]);
                const stats = party && JSON.parse(party.statsJson || '{}');
                if (stats?.coldCompetition?.key !== key) continue;
                if (JSON.parse(party.memberIdsJson).some(id => coldSimulationRow(id)?.simulationLeaseId)) { complete = false; continue; }
                stats.coldCompetition = { ...stats.coldCompetition, wait: null, outcome, endedAt: timestamp };
                write('UPDATE bot_background_parties SET statsJson = ?, updatedAt = ? WHERE partyId = ?',
                    [JSON.stringify(stats), Math.max(timestamp, Number(party.updatedAt) + 1), partyId]);
                parties.push(one('SELECT * FROM bot_background_parties WHERE partyId = ?', [partyId]));
            }
            return { rows, parties, complete };
        }, 'bot-life:pvp-encounter-end');
    },

    transitionPvpEncounter(request = {}) {
        const members = request.members || [], ids = members.map(m => Number(m.characterId));
        if (!request.key || ids.length < 2 || ids.length > 18 || new Set(ids).size !== ids.length
            || !['hot', 'cold'].includes(request.phase) || !['hot', 'cold'].includes(request.expectedPhase)) {
            return Promise.resolve({ ok: false, reason: 'invalid_encounter_transition' });
        }
        return inTransaction(() => {
            if (request.validate && !request.validate()) return { ok: false, reason: 'encounter_live_state_changed' };
            const rows = ids.map(coldSimulationRow);
            for (let i = 0; i < rows.length; i++) {
                const row = rows[i], m = members[i];
                const encounter = row && JSON.parse(row.statsJson || '{}').pvpEncounter;
                const declared = encounter?.sides?.flatMap(s => s.memberIds) || [];
                if (!row || row.phase !== request.expectedPhase || encounter?.key !== request.key
                    || declared.length !== ids.length || declared.some(id => !ids.includes(id))
                    || Number(row.simulationRevision) !== m.expectedRevision || Number(row.updatedAt) !== m.expectedUpdatedAt
                    || ![LEGACY_SIMULATION_OWNER, COLD_SIMULATION_OWNER].includes(row.simulationOwner)
                    || row.simulationLeaseId
                    || Object.keys(m.patch || {}).some(key => !COLD_SIMULATION_PATCH_COLUMNS.has(key))
                    || (m.patch.partyId || null) !== (row.partyId || null) || m.patch.phase !== request.phase) {
                    return { ok: false, reason: 'encounter_member_changed' };
                }
            }
            const partyIds = [...new Set(rows.map(r => r.partyId).filter(Boolean))];
            const parties = partyIds.map(id => one('SELECT * FROM bot_background_parties WHERE partyId = ?', [id]));
            for (const party of parties) {
                const attached = party && all('SELECT characterId FROM bot_life_state WHERE partyId = ?', [party.partyId]).map(r => r.characterId);
                const declared = party && JSON.parse(party.memberIdsJson);
                if (!party || party.status !== (request.expectedPhase === 'hot' ? 'hot' : 'active')
                    || declared.length !== attached.length || declared.some(id => !ids.includes(id) || !attached.includes(id))) {
                    return { ok: false, reason: 'encounter_party_changed' };
                }
            }
            const timestamp = Math.max(now(), ...rows.map(r => Number(r.updatedAt) + 1));
            for (let i = 0; i < rows.length; i++) {
                const row = rows[i], m = members[i];
                const patch = preserveColdVersionedStats(row, { ...m.patch, updatedAt: timestamp });
                const entries = Object.entries(patch);
                const changed = write(`UPDATE bot_life_state SET ${entries.map(([k]) => `${escapeIdentifier(k)} = ?`).join(', ')},
                    simulationOwner = ?, simulationRevision = simulationRevision + 1, simulationLeaseId = NULL, simulationLeaseUntil = 0
                    WHERE characterId = ? AND simulationRevision = ?`,
                [...entries.map(([, v]) => v), LEGACY_SIMULATION_OWNER, m.characterId, m.expectedRevision]);
                if (changed.affectedRows !== 1) throw Error('encounter lifecycle CAS failed');
                // Staged actors must read the same physical resources as the life snapshot.
                const combat = JSON.parse(patch.statsJson || '{}').coldCombat;
                write('UPDATE characters SET hp = ?, mp = ?, cp = COALESCE(?, cp), locX = ?, locY = ?, locZ = ? WHERE id = ?',
                    [patch.hp, patch.mp, combat?.cp ?? null, patch.locX, patch.locY, patch.locZ, m.characterId]);
            }
            for (const party of parties) {
                const stats = JSON.parse(party.statsJson || '{}');
                stats.hotLifecycle = request.phase === 'hot' ? { startedAt: timestamp, reason: request.reason } : null;
                if (stats.coldCompetition) stats.coldCompetition.wait = null;
                write('UPDATE bot_background_parties SET status = ?, nextResolveAt = ?, statsJson = ?, updatedAt = ? WHERE partyId = ?',
                    [request.phase === 'hot' ? 'hot' : 'active', request.phase === 'hot' ? null : timestamp + 1000,
                        JSON.stringify(stats), timestamp, party.partyId]);
            }
            return { ok: true, rows: ids.map(coldSimulationRow),
                parties: partyIds.map(id => one('SELECT * FROM bot_background_parties WHERE partyId = ?', [id])) };
        }, 'bot-life:pvp-encounter-lifecycle');
    },

    transitionBackgroundParty(request = {}) {
        const members = request.members || [];
        const ids = members.map(m => Number(m.characterId));
        if (ids.length < 2 || ids.length > 9 || new Set(ids).size !== ids.length
            || !['hot', 'cold'].includes(request.phase) || !['hot', 'cold'].includes(request.expectedPhase)) {
            return Promise.resolve({ ok: false, reason: 'invalid_party_transition' });
        }
        return inTransaction(() => {
            const party = one('SELECT * FROM bot_background_parties WHERE partyId = ?', [request.partyId]);
            const declared = party ? JSON.parse(party.memberIdsJson) : [];
            if (!party || party.status !== request.expectedStatus || Number(party.updatedAt) !== request.expectedUpdatedAt
                || declared.length !== ids.length || declared.some(id => !ids.includes(Number(id)))) {
                return { ok: false, reason: 'party_changed' };
            }
            const attached = all('SELECT characterId FROM bot_life_state WHERE partyId = ?', [request.partyId]);
            if (attached.length !== ids.length || attached.some(r => !ids.includes(Number(r.characterId)))) {
                return { ok: false, reason: 'party_membership_changed' };
            }
            const rows = members.map(m => coldSimulationRow(Number(m.characterId)));
            for (let i = 0; i < members.length; i++) {
                const row = rows[i], m = members[i];
                if (!row || row.phase !== request.expectedPhase || row.partyId !== request.partyId
                    || Number(row.simulationRevision) !== m.expectedRevision || Number(row.updatedAt) !== m.expectedUpdatedAt
                    || ![LEGACY_SIMULATION_OWNER, COLD_SIMULATION_OWNER].includes(row.simulationOwner)
                    || Object.keys(m.patch || {}).some(key => !COLD_SIMULATION_PATCH_COLUMNS.has(key))
                    || m.patch.partyId !== request.partyId || m.patch.phase !== request.phase) {
                    return { ok: false, reason: 'member_changed' };
                }
            }
            const timestamp = Math.max(now(), Number(party.updatedAt) + 1);
            for (let i = 0; i < members.length; i++) {
                const m = members[i], row = rows[i];
                const entries = Object.entries(preserveColdVersionedStats(row, { ...m.patch, updatedAt: timestamp }));
                const changed = write(`UPDATE bot_life_state SET ${entries.map(([key]) => `${escapeIdentifier(key)} = ?`).join(', ')},
                    simulationOwner = ?, simulationRevision = simulationRevision + 1, simulationLeaseId = NULL, simulationLeaseUntil = 0
                    WHERE characterId = ? AND simulationRevision = ?`,
                [...entries.map(([, value]) => value), LEGACY_SIMULATION_OWNER, m.characterId, m.expectedRevision]);
                if (changed.affectedRows !== 1) throw Error('party lifecycle CAS failed');
            }
            write('UPDATE bot_background_parties SET status = ?, nextResolveAt = ?, statsJson = ?, updatedAt = ? WHERE partyId = ?',
                [request.phase === 'hot' ? 'hot' : 'active', request.nextResolveAt, request.statsJson, timestamp, request.partyId]);
            return { ok: true, rows: ids.map(coldSimulationRow),
                party: one('SELECT * FROM bot_background_parties WHERE partyId = ?', [request.partyId]) };
        }, 'bot-life:party-lifecycle');
    },

    takeOverBackgroundParty(request = {}) {
        const members = request.members || [];
        const ids = members.map((member) => Number(member.characterId));
        const playerId = Number(request.playerId || 0);
        if (!request.partyId || !Number.isSafeInteger(playerId) || playerId <= 0
            || ids.length < 2 || ids.length > 8 || new Set(ids).size !== ids.length) {
            return Promise.resolve({ ok: false, reason: 'invalid_party_takeover' });
        }
        return inTransaction(() => {
            const party = one('SELECT * FROM bot_background_parties WHERE partyId = ?', [request.partyId]);
            const declared = party ? JSON.parse(party.memberIdsJson || '[]').map(Number) : [];
            if (!party || party.status !== 'hot' || Number(party.updatedAt) !== Number(request.expectedUpdatedAt)
                || declared.length !== ids.length || declared.some((id) => !ids.includes(id))) {
                return { ok: false, reason: 'party_changed' };
            }
            const attached = all('SELECT characterId FROM bot_life_state WHERE partyId = ?', [request.partyId])
                .map((row) => Number(row.characterId));
            if (attached.length !== ids.length || attached.some((id) => !ids.includes(id))) {
                return { ok: false, reason: 'party_membership_changed' };
            }
            const rows = members.map((member) => coldSimulationRow(member.characterId));
            for (let index = 0; index < members.length; index += 1) {
                const member = members[index];
                const row = rows[index];
                if (!row || row.phase !== 'hot' || row.partyId !== request.partyId
                    || Number(row.simulationRevision) !== Number(member.expectedRevision)
                    || Number(row.updatedAt) !== Number(member.expectedUpdatedAt)
                    || String(row.simulationOwner || LEGACY_SIMULATION_OWNER) !== LEGACY_SIMULATION_OWNER
                    || row.simulationLeaseId) {
                    return { ok: false, reason: 'member_changed' };
                }
            }

            const timestamp = Math.max(now(), Number(party.updatedAt) + 1,
                ...rows.map((row) => Number(row.updatedAt) + 1));
            for (let index = 0; index < members.length; index += 1) {
                const member = members[index];
                const row = rows[index];
                const stats = parsedObject(row.statsJson) || {};
                stats.leaderId = playerId;
                stats.backgroundPartyId = null;
                stats.partyRequest = null;
                stats.partyBreakReason = 'player_takeover';
                stats.playerPartyTakeover = {
                    partyId: request.partyId,
                    playerId,
                    source: String(request.source || 'player_request').slice(0, 64),
                    at: timestamp
                };
                const changed = write(`UPDATE bot_life_state SET
                    partyId = NULL, activity = 'hunting', activityStartedAt = ?, nextResolveAt = NULL,
                    lastResolvedAt = ?, statsJson = ?, updatedAt = ?, simulationOwner = ?,
                    simulationRevision = simulationRevision + 1, simulationLeaseId = NULL, simulationLeaseUntil = 0
                    WHERE characterId = ? AND partyId = ? AND phase = 'hot' AND simulationRevision = ?`, [
                    timestamp,
                    timestamp,
                    JSON.stringify(stats),
                    timestamp,
                    LEGACY_SIMULATION_OWNER,
                    member.characterId,
                    request.partyId,
                    member.expectedRevision
                ]);
                if (changed.affectedRows !== 1) throw Error('party takeover CAS failed');
            }

            const partyStats = parsedObject(party.statsJson) || {};
            partyStats.hotLifecycle = null;
            partyStats.partyBreakReason = 'player_takeover';
            partyStats.playerTakeover = {
                playerId,
                source: String(request.source || 'player_request').slice(0, 64),
                at: timestamp
            };
            const changedParty = write(`UPDATE bot_background_parties
                SET status = 'player_taken_over', nextResolveAt = NULL, statsJson = ?, updatedAt = ?
                WHERE partyId = ? AND status = 'hot' AND updatedAt = ?`, [
                JSON.stringify(partyStats), timestamp, request.partyId, request.expectedUpdatedAt
            ]);
            if (changedParty.affectedRows !== 1) throw Error('party takeover party CAS failed');
            return {
                ok: true,
                rows: ids.map(coldSimulationRow),
                party: one('SELECT * FROM bot_background_parties WHERE partyId = ?', [request.partyId])
            };
        }, 'bot-life:party-takeover');
    },

    restoreTakenOverBackgroundParty(request = {}) {
        const partyId = String(request.partyId || '');
        const playerId = Number(request.playerId || 0);
        if (!partyId || !Number.isSafeInteger(playerId) || playerId <= 0) {
            return Promise.resolve({ ok: false, reason: 'invalid_party_restore' });
        }
        return inTransaction(() => {
            const party = one('SELECT * FROM bot_background_parties WHERE partyId = ?', [partyId]);
            const partyStats = parsedObject(party?.statsJson) || {};
            const declared = party ? JSON.parse(party.memberIdsJson || '[]').map(Number) : [];
            if (!party || party.status !== 'player_taken_over'
                || Number(partyStats.playerTakeover?.playerId || 0) !== playerId
                || declared.length < 2 || declared.length > 8 || new Set(declared).size !== declared.length) {
                return { ok: false, reason: 'party_changed' };
            }

            const placeholders = declared.map(() => '?').join(', ');
            const rows = all(`SELECT * FROM bot_life_state WHERE characterId IN (${placeholders})`, declared);
            if (rows.length !== declared.length) return { ok: false, reason: 'party_membership_changed' };
            const phases = new Set(rows.map((row) => row.phase));
            if (phases.size !== 1 || !['hot', 'cold'].includes(rows[0]?.phase)) {
                return { ok: false, reason: 'member_changed' };
            }
            for (const row of rows) {
                const stats = parsedObject(row.statsJson) || {};
                if (row.partyId || Number(stats.playerPartyTakeover?.playerId || 0) !== playerId
                    || stats.playerPartyTakeover?.partyId !== partyId
                    || String(row.simulationOwner || LEGACY_SIMULATION_OWNER) !== LEGACY_SIMULATION_OWNER
                    || row.simulationLeaseId) {
                    return { ok: false, reason: 'member_changed' };
                }
            }

            const phase = rows[0].phase;
            const status = phase === 'hot' ? 'hot' : 'active';
            const timestamp = Math.max(now(), Number(party.updatedAt) + 1,
                ...rows.map((row) => Number(row.updatedAt) + 1));
            const nextResolveAt = phase === 'hot' ? null : timestamp + 1000;
            for (const row of rows) {
                const stats = parsedObject(row.statsJson) || {};
                stats.leaderId = Number(party.leaderId);
                stats.backgroundPartyId = partyId;
                stats.partyRequest = null;
                stats.partyBreakReason = 'player_party_released';
                delete stats.playerPartyTakeover;
                const changed = write(`UPDATE bot_life_state SET
                    partyId = ?, activity = 'grouped', activityStartedAt = ?, nextResolveAt = ?,
                    lastResolvedAt = ?, statsJson = ?, updatedAt = ?, simulationOwner = ?,
                    simulationRevision = simulationRevision + 1, simulationLeaseId = NULL, simulationLeaseUntil = 0
                    WHERE characterId = ? AND partyId IS NULL AND simulationRevision = ?`, [
                    partyId,
                    timestamp,
                    nextResolveAt,
                    timestamp,
                    JSON.stringify(stats),
                    timestamp,
                    LEGACY_SIMULATION_OWNER,
                    Number(row.characterId),
                    Number(row.simulationRevision)
                ]);
                if (changed.affectedRows !== 1) throw Error('party restore CAS failed');
            }

            delete partyStats.playerTakeover;
            partyStats.partyBreakReason = 'player_party_released';
            // Time spent under a player leader is not autonomous party-session
            // age. Start a fresh review window when the bots resume control.
            partyStats.formedAt = timestamp;
            partyStats.sessionExpiresAt = null;
            partyStats.sessionReview = null;
            partyStats.lastProgressAt = timestamp;
            partyStats.partySpotRisk = null;
            partyStats.hotLifecycle = phase === 'hot'
                ? { startedAt: timestamp, reason: 'player_party_released' }
                : null;
            const changedParty = write(`UPDATE bot_background_parties
                SET status = ?, nextResolveAt = ?, statsJson = ?, updatedAt = ?
                WHERE partyId = ? AND status = 'player_taken_over' AND updatedAt = ?`, [
                status,
                nextResolveAt,
                JSON.stringify(partyStats),
                timestamp,
                partyId,
                Number(party.updatedAt)
            ]);
            if (changedParty.affectedRows !== 1) throw Error('party restore party CAS failed');
            return {
                ok: true,
                rows: declared.map(coldSimulationRow),
                party: one('SELECT * FROM bot_background_parties WHERE partyId = ?', [partyId])
            };
        }, 'bot-life:party-restore');
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
        clearInterval(economyJournalTimer);
        economyJournalTimer = null;
        if (connection) {
            flushJournals().catch((error) => utils.infoWarn('DB', 'journal flush failed: %s', error.message));
        }
        shuttingDown = true;
        const pending = queryTail;
        closePromise = pending.then(async () => {
            if (!connection) {
                await History.stop();
                await CheckpointCoordinator.stop({ final: true });
                return false;
            }
            // The history thread moves what is left in the outbox; the moved
            // rows leave the world before it closes.
            const movedUpTo = await History.stop();
            const openConnection = connection;
            connection = null;
            if (movedUpTo > 0) {
                try {
                    openConnection.prepare('DELETE FROM history_outbox WHERE id <= ?').run(movedUpTo);
                } catch (error) {
                    utils.infoWarn('DB', 'history outbox cleanup failed: %s', error.message);
                }
            }
            EconomyCommit.clear();
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

    admitEconomyCommand(characterId, kind, { authority, original = null, acknowledged = null, reconcilePending = false } = {}) {
        const beforeWrite = mutationAdmission.getStore();
        // Admission metadata is saved BEFORE the concrete physical step is
        // guarded. The synchronous guard never enqueues another DB mutation.
        return mutationAdmission.run(undefined, () => inTransaction(() => {
            if (beforeWrite && beforeWrite() !== undefined) throw Error('invalid_economy_admission');
            const row = economyOwnerUnsafe(characterId, authority, !original);
            const previous = jsonObject(row.statsJson).economyCommit;
            if (previous && !EconomyCommit.valid(previous)) throw Error('invalid_economy_receipt');
            const sequence = previous?.[0] || 0;
            if (original) {
                const command = EconomyCommit.header(original[0], original[1], original[2], authority);
                if (kind !== command[1]) throw Error('economy_kind_changed');
                economyStepUnsafe(characterId, command);
                return { command, row: normalizeRow(row) };
            }
            if (sequence >= Number.MAX_SAFE_INTEGER) throw Error('economy_sequence_exhausted');
            if (previous && JSON.stringify(previous) !== JSON.stringify(acknowledged)) throw Error('economy_result_unacknowledged');
            if (previous?.[1] === 0 && !reconcilePending) throw Error('economy_intent_pending');
            // A recovered pending intent has no physical commit. Its arguments
            // are not reconstructed; the new step is planned from actual state.
            const command = EconomyCommit.create(kind, sequence, authority);
            write("UPDATE bot_life_state SET statsJson=json_set(COALESCE(statsJson,'{}'),'$.economyCommit',json(?)) WHERE characterId=?",
                [JSON.stringify(EconomyCommit.pending(command)), Number(characterId)]);
            return { command, row: normalizeRow(one('SELECT * FROM bot_life_state WHERE characterId=?', [Number(characterId)])),
                recovered: previous?.[1] === 0 ? 'pending_aborted' : null };
        }, 'economy:intent'));
    },

    withMutationAdmission(beforeWrite, work) {
        if (typeof beforeWrite !== 'function' || typeof work !== 'function') throw new TypeError('invalid_mutation_admission');
        return mutationAdmission.run(beforeWrite, () => Promise.resolve().then(work));
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
        // Depth and physical checkpoint outcomes are runtime control sources.
        if (!DiagnosticConfig.developerDiagnostics) return { path: databasePath || null, historyPath: historyPath || null,
            pending: metrics.pending, diagnostics: { enabled: false }, checkpoint: CheckpointCoordinator.snapshot(), history: History.stats() };
        const operations = Object.fromEntries(Array.from(metrics.byOperation?.entries() || []).map(([key, value]) => [key, { ...value }]));
        const snapshot = {
            path: databasePath || null,
            historyPath: historyPath || null,
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
            checkpoint: CheckpointCoordinator.snapshot(),
            history: History.stats()
        };
        if (resetPeak) metrics.maxPending = metrics.pending;
        return snapshot;
    },

    checkpoint(options = {}) {
        if (shuttingDown) return Promise.reject(new Error('SQLite shutdown is in progress (maintenance:checkpoint)'));
        if (!connection) return Promise.reject(new Error('SQLite is not initialized (maintenance:checkpoint)'));
        const requestOptions = {
            force: true,
            mode: options.mode === 'truncate'
                ? 'truncate'
                : options.mode === 'restart' ? 'restart' : 'passive',
            minWalBytes: 0,
            busyTimeoutMs: options.busyTimeoutMs
        };
        const request = () => CheckpointCoordinator.request(requestOptions);
        if (requestOptions.mode === 'passive') return request();
        const result = queryTail.then(request, request);
        queryTail = result.catch(() => null);
        return result;
    },

    applyBufferedCharacterState(characterId, state = {}) {
        return inTransaction(() => applyBufferedCharacterStateUnsafe(characterId, state), 'buffered-character:flush');
    },

    applyBufferedCharacterStates(entries = []) {
        return inTransaction(() => entries.map(([characterId, state]) => applyBufferedCharacterStateUnsafe(Number(characterId), state)), 'buffered-character:flush-batch');
    },

    // reason names the bot action for the economy journal (e.g. 'npc_liquidation').
    syncInventorySummary(characterId, inventory = {}, reason = null, options = {}) {
        const admission = captureWriteAdmission(options, 'invalid_inventory_before_write', characterId);
        return withCharacterFlush(characterId, () => inTransaction(
            () => {
                checkCapturedWriteAdmission(admission, characterId);
                const result = syncInventorySummaryUnsafe(characterId, inventory);
                // A new ordinary cold death consumes its ordered bag once, in
                // the same transaction that reconciles the physical inventory.
                if (reason === 'resolve_death') return dropPkDeathItemsUnsafe(characterId);
                return result;
            },
            reason ? `inventory:sync-summary:${reason}` : 'inventory:sync-summary'
        ));
    },

    flushJournals,
    flushHistory,

    // A history row outside any other world write (HistoryStore APPLY[kind]).
    recordHistory(kind, payload, operation = `history:${kind}`) {
        return enqueue(() => historyOutboxUnsafe(kind, payload), { operation });
    },

    // A raw read of the history file, after flushHistory (see readHistory).
    readHistory(statement, operation = 'history:raw') {
        return readHistory(() => History.all(statement[0], statement[1] || []), operation);
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
                if (!entry.fromCharacterId || !entry.toCharacterId || !entry.sourceItemId || !entry.selfId || BeginnerShots.isRestricted(entry.selfId) || entry.amount <= 0) {
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
                return inTransaction(() => {
                    const count = one('SELECT COUNT(*) AS total FROM characters WHERE username = ? COLLATE NOCASE', [accounts[0].username]).total;
                    const newbie = require('./GameServer/Quest/BeginnerReward').flagForNewCharacter(count);
                    return write(`INSERT INTO characters(username, name, race, classId, maxHp, maxMp, sex, face, hair, hairColor, locX, locY, locZ, newbie)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
                        accounts[0].username, data.name, data.race, data.classId, data.maxHp, data.maxMp,
                        data.sex, data.face, data.hair, data.hairColor, data.locX, data.locY, data.locZ, newbie
                    ]);
                }, 'character:create');
            });
    },
    deleteCharacter(username, name) {
        return inTransaction(() => {
            const character = one('SELECT id FROM characters WHERE username=? COLLATE NOCASE AND name=? COLLATE NOCASE', [username, name]);
            if (!character) return { affectedRows: 0 };
            const slot = one('SELECT meetingId FROM board_trade_participants WHERE characterId=?', [character.id]);
            if (slot?.meetingId) {
                const result = TradeMeetings.terminal(slot.meetingId, false, 'character_deleted');
                const row = result.meeting;
                // Final credit is already durable. Remove the deleted actor's
                // claim without erasing the surviving actor's acknowledgement.
                TradeMeetings.acknowledge(row.id, row.actorA);
                TradeMeetings.acknowledge(row.id, row.actorB);
            }
            write('DELETE FROM board_trade_participants WHERE characterId=?', [character.id]);
            return write('DELETE FROM characters WHERE id=?', [character.id]);
        }, 'character:delete');
    },
    fetchSkills(characterId) {
        return select('skills', ['*'], 'characterId = ?', [characterId], 'skill:list');
    },
    fetchSkill(characterId, skillSelfId) {
        return selectOne('skills', ['*'], 'characterId = ? AND selfId = ?', [characterId, skillSelfId], 'skill:one');
    },
    isColdTrainingSourceRetired(error) {
        return error instanceof ColdTrainingSourceRetired;
    },
    createColdTrainingGuard(state, validate, nativeBeforeWrite) {
        const Protocol = invoke('GameServer/Bot/Population/ColdSimulationProtocol');
        const expected = Protocol.commandCheckpoint({ characterId: state.characterId, phase: state.phase, activity: state.activity,
            simulationOwner: state.simulation?.ownerId, simulationRevision: state.simulation?.revision,
            simulationLeaseId: state.simulation?.leaseId || null,
            activityStartedAt: state.timing?.activityStartedAt || 0, nextResolveAt: state.timing?.nextResolveAt || 0,
            lastResolvedAt: state.timing?.lastResolvedAt || 0, lastHotAt: state.timing?.lastHotAt || 0, updatedAt: state.updatedAt });
        if (!expected || expected.phase !== 'cold' || expected.simulationOwner !== LEGACY_SIMULATION_OWNER
            || typeof validate !== 'function' || (nativeBeforeWrite !== undefined && typeof nativeBeforeWrite !== 'function')) {
            throw Error('invalid_cold_training_source');
        }
        // Training alone carries immutable ROW version floors. Its optional
        // native callback still supplies the original target/checkpoint proof.
        const beforeWrite = () => { validate(); nativeBeforeWrite?.(); };
        // ARCH-NOTE: These three short-lived SQL scalars preserve ROW JSON <= semantics without protocol/cache fields.
        const versions = Object.freeze(['clanInventoryRevision', 'clanLevelSpVersion', 'clanMembershipVersion'].map(key => {
            const descriptor = Object.getOwnPropertyDescriptor(state.stats || {}, key);
            if (descriptor?.enumerable && !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
                throw new TypeError('invalid_cold_training_version');
            }
            const value = descriptor?.enumerable ? descriptor.value : undefined;
            if (value !== null && value !== undefined && !['number', 'string', 'boolean'].includes(typeof value)) {
                throw new TypeError('invalid_cold_training_version');
            }
            return JSON.stringify(value ?? null);
        }));
        coldTrainingGuards.set(beforeWrite, Object.freeze({ ...expected, versions, nativeBeforeWrite }));
        return beforeWrite;
    },
    publishColdTraining(characterId, resolved, options = {}) {
        const admission = captureWriteAdmission(options, 'invalid_skill_before_write', characterId);
        return withCharacterFlush(characterId, () => inTransaction(() => {
            checkCapturedWriteAdmission(admission, characterId);
            if (!admission.coldTraining) throw Error('missing_cold_training_source');
            const row = one('SELECT * FROM bot_life_state WHERE characterId = ?', [characterId]);
            const character = one('SELECT classId,sp FROM characters WHERE id = ?', [characterId]);
            const inventory = invoke('GameServer/Bot/Population/BotLifeState').inventorySummaryFromItems(all('SELECT * FROM items WHERE characterId = ? ORDER BY id',[characterId]));
            const stats = jsonObject(row.statsJson);
            stats.classId = character.classId; stats.classProgressionClassId = character.classId; stats.classProgressionLevel = row.level;
            stats.classTransitions = [...(stats.classTransitions || []), ...(resolved.transitions || [])];
            stats.coldCombat = invoke('GameServer/Bot/Population/ColdCombatProfile').legacySnapshot({stats,level:row.level},
                all('SELECT * FROM skills WHERE characterId = ?', [characterId]), now());
            checkCapturedWriteAdmission(admission, characterId);
            write('UPDATE bot_life_state SET sp = ?, inventorySummary = ?, statsJson = ?, simulationRevision = simulationRevision + 1, updatedAt = ? WHERE characterId = ?',
                [character.sp, JSON.stringify(inventory), JSON.stringify(stats), now(), characterId]);
            return one('SELECT * FROM bot_life_state WHERE characterId = ?', [characterId]);
        }, 'cold:paid-training'));
    },
    learnBotSkill(characterId, skillSelfId, skillLevel, options = {}) {
        const id = Number(characterId);
        const admission = captureWriteAdmission(options, 'invalid_skill_before_write', id);
        return withCharacterFlush(id, () => inTransaction(() => {
            checkCapturedWriteAdmission(admission, id);
            const character = one('SELECT username, classId, level, sp FROM characters WHERE id = ?', [id]);
            if (!character || !String(character.username).startsWith('bot_')) return { learned: false, reason: 'not_bot' };
            const known = one('SELECT level FROM skills WHERE characterId = ? AND selfId = ?', [id, skillSelfId]);
            if (Number(known?.level || 0) >= Number(skillLevel)) return { learned: false, reason: 'already_known' };
            const Catalog = invoke('GameServer/Skills/SkillBookCatalog');
            const training = Catalog.nextTraining(character.classId, character.level, skillSelfId, known?.level || 0);
            const definition = invoke('GameServer/DataCache').skills.find((row) => Number(row.selfId) === Number(skillSelfId));
            if (!training || training.level !== Number(skillLevel)
                || !definition?.levels?.some((row) => Number(row.level) === training.level)) {
                return { learned: false, reason: 'ineligible_rank' };
            }
            // Static workshops are authored infrastructure, rather than a
            // progressing character. Ordinary bots pay the canonical SP/book.
            const infrastructure = String(character.username).startsWith('bot_craft_');
            const spentSp = infrastructure ? 0 : training.sp;
            if (Number(character.sp) < spentSp) return { learned: false, reason: 'insufficient_sp' };
            const book = !infrastructure && training.bookId
                ? one('SELECT id, amount FROM items WHERE characterId = ? AND selfId = ? AND amount > 0 AND equipped = 0 ORDER BY id LIMIT 1', [id, training.bookId]) : null;
            if (!infrastructure && training.bookId && !book) return { learned: false, reason: 'missing_book' };
            if (spentSp) {
                checkCapturedWriteAdmission(admission, id);
                write('UPDATE characters SET sp = sp - ? WHERE id = ?', [spentSp, id]);
            }
            const consumedBooks = [];
            if (book) {
                checkCapturedWriteAdmission(admission, id);
                if (Number(book.amount) > 1) write('UPDATE items SET amount = amount - 1 WHERE id = ? AND characterId = ?', [book.id, id]);
                else write('DELETE FROM items WHERE id = ? AND characterId = ?', [book.id, id]);
                consumedBooks.push({ selfId: training.bookId, amount: 1, objectId: book.id, remaining: Number(book.amount) - 1 });
            }
            checkCapturedWriteAdmission(admission, id);
            write(`INSERT INTO skills (selfId, name, passive, level, characterId) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(characterId, selfId) DO UPDATE SET name = excluded.name, passive = excluded.passive, level = excluded.level`,
            [Number(skillSelfId), definition.template?.name || training.name || '', definition.template?.passive ? 1 : 0, training.level, id]);
            return { learned: true, level: training.level, spentSp, consumedBooks };
        }, 'skill:learn-bot'));
    },
    deleteSkills(characterId) {
        return remove('skills', 'characterId = ?', [characterId], 'skill:delete-all');
    },
    setSkill(skill, characterId, options = {}) {
        return guardedSkillWrite(`INSERT INTO skills (selfId, name, passive, level, characterId) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(characterId, selfId) DO UPDATE SET name = excluded.name, passive = excluded.passive, level = excluded.level`,
        [skill.selfId, skill.name, skill.passive ? 1 : 0, skill.level, characterId], 'skill:upsert', options);
    },
    updateSkillLevel(characterId, skillSelfId, skillLevel, options = {}) {
        return guardedSkillWrite('UPDATE "skills" SET "level" = ? WHERE selfId = ? AND characterId = ?',
            [skillLevel, skillSelfId, characterId], 'skill:level', options);
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

    transferWarehouseToInventory(characterId, item, { coldState = null, inTown = false } = {}) {
        if (coldState && inTown !== true) return Promise.reject(new Error('economy_state_changed'));
        // ARCH-NOTE: a legacy movement save need not advance simulationRevision.
        // Capture the town intent before the character flush/queue, then compare
        // its scalar location and activity inside the native transaction.
        const townIntent = coldState && { activity: coldState.activity, currentRegion: coldState.currentRegion,
            locX: Number(coldState.loc?.locX || 0), locY: Number(coldState.loc?.locY || 0), locZ: Number(coldState.loc?.locZ || 0) };
        return withCharacterFlush(characterId, () => inTransaction(() => {
            let life = null;
            if (coldState) {
                life = one(`SELECT phase, activity, currentRegion, locX, locY, locZ,
                    simulationOwner, simulationRevision, partyId, inventorySummary,
                    json_extract(statsJson,'$.equipmentPlan') AS equipmentPlan FROM bot_life_state WHERE characterId=?`, [characterId]);
                // A queued flush can hand the bot to a worker or add a craft
                // reservation after the caller planned the withdrawal.
                if (!life || Number(coldState.characterId) !== Number(characterId)
                    || life.phase !== 'cold' || life.simulationOwner !== LEGACY_SIMULATION_OWNER
                    || life.partyId || !['hunting', 'resting', 'shopping', 'merchant'].includes(life.activity)
                    || life.activity !== townIntent.activity || life.currentRegion !== townIntent.currentRegion
                    || Number(life.locX) !== townIntent.locX || Number(life.locY) !== townIntent.locY || Number(life.locZ) !== townIntent.locZ
                    || (coldState.simulation && Number(life.simulationRevision) !== Number(coldState.simulation.revision))
                    || JSON.stringify(life.equipmentPlan ? JSON.parse(life.equipmentPlan) : null) !== JSON.stringify(coldState.stats?.equipmentPlan || null)) {
                    throw new Error('economy_state_changed');
                }
                // A resolve saves its lifecycle row before materializing loot.
                // Hydration can see that row while physical items still lag.
                const inventory = jsonObject(life.inventorySummary);
                const physical = all(`SELECT selfId, SUM(amount) AS amount FROM items
                    WHERE characterId = ? AND selfId IN (57, ?) GROUP BY selfId`, [characterId, item.selfId]);
                const amounts = new Map(physical.map(row => [Number(row.selfId), Number(row.amount)]));
                for (const selfId of new Set([57, Number(item.selfId)])) {
                    const projected = Number(inventory[String(selfId)]?.amount || 0);
                    if (projected !== Number(amounts.get(selfId) || 0)
                        || projected !== Number(coldState.inventory?.[String(selfId)]?.amount || 0)) {
                        throw new Error('economy_state_changed');
                    }
                }
            }
            const source = one('SELECT id, selfId, amount, enchant, petData FROM warehouse_items WHERE id = ? AND characterId = ?', [item.id, characterId]);
            if (!source || Number(source.selfId) !== Number(item.selfId) || Number(source.amount) < Number(item.amount)) throw new Error('warehouse item changed');
            const sourceEnchant = Math.max(0, Number(source.enchant) || 0);
            const target = item.stackable ? one('SELECT id, amount FROM items WHERE characterId = ? AND selfId = ? ORDER BY id LIMIT 1', [characterId, item.selfId]) : null;
            const inventoryAmount = Number(target?.amount || 0) + Number(item.amount);
            const inventoryId = target ? target.id : write('INSERT INTO items (selfId, name, amount, enchant, equipped, slot, petData, characterId) VALUES (?, ?, ?, ?, 0, 0, ?, ?)', [item.selfId, item.name || '', item.amount, sourceEnchant, source.petData, characterId]).insertId;
            if (target) write('UPDATE items SET amount = ? WHERE id = ? AND characterId = ?', [inventoryAmount, inventoryId, characterId]);
            const warehouseAmount = Number(source.amount) - Number(item.amount);
            if (warehouseAmount <= 0) write('DELETE FROM warehouse_items WHERE id = ? AND characterId = ?', [item.id, characterId]);
            else write('UPDATE warehouse_items SET amount = ? WHERE id = ? AND characterId = ?', [warehouseAmount, item.id, characterId]);
            const coldLifeRow = syncEconomySnapshotUnsafe(characterId, coldState, [item.selfId]);
            return { inventoryId: Number(inventoryId), inventoryAmount, warehouseAmount, petData: source.petData, enchant: sourceEnchant,
                ...(coldLifeRow ? { coldLifeRow } : {}) };
        }, 'warehouse:withdraw'));
    },

    patchWarehouseWithdrawal(characterId, withdrawal) {
        const record = require('./GameServer/Bot/LastOperations').compact({ at: Number(withdrawal.at) || now() },
            withdrawal.items, { marketFirst: true });
        const raw = JSON.stringify(record);
        const market = record.items.some(row => row[2] === 1);
        return enqueue(() => {
            const row = one(`UPDATE bot_life_state SET statsJson=json_set(COALESCE(statsJson,'{}'),
                '$.lastWarehouseWithdrawal',json(?)${market ? ", '$.marketSellRetryAfter', NULL" : ''}),
                nextResolveAt=CASE WHEN activity='hunting' THEN ? ELSE nextResolveAt END WHERE characterId=?
                RETURNING characterId,nextResolveAt,simulationRevision,updatedAt`, [raw, record.at, Number(characterId)]);
            return row ? { ...row, withdrawal: record, market } : null;
        }, { operation: 'warehouse:withdrawal-record' });
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

    fetchSavedLocations(characterId) {
        return run('SELECT * FROM character_saved_locations WHERE characterId = ? ORDER BY id DESC', [characterId], 'saved-location:list');
    },
    saveLocation(characterId, name, coords) {
        return insert('character_saved_locations', {
            characterId, name, locX: coords.locX, locY: coords.locY, locZ: coords.locZ, head: coords.head
        }, 'saved-location:insert');
    },
    fetchSavedLocation(characterId, id) {
        return selectOne('character_saved_locations', ['*'], 'characterId = ? AND id = ?', [characterId, id], 'saved-location:one');
    },
    deleteSavedLocation(characterId, id) {
        return remove('character_saved_locations', 'characterId = ? AND id = ?', [characterId, id], 'saved-location:delete');
    },
    fetchCharacterQuests(characterId) { return select('character_quests', ['*'], 'characterId = ?', [characterId], 'quest:list'); },
    feedMountedPet(characterId, controlId, foodId, feed) {
        return withCharacterFlush(characterId, () => inTransaction(() => {
            const collar = one('SELECT selfId, petData FROM items WHERE id = ? AND characterId = ?', [controlId, characterId]);
            const food = one('SELECT selfId, amount FROM items WHERE id = ? AND characterId = ?', [foodId, characterId]);
            const Rules = require('./GameServer/Pets/PetRules');
            const type = Rules.TYPES[collar?.selfId];
            const state = JSON.parse(collar?.petData || '{}');
            if (!Number.isFinite(feed) || feed <= 0 || type?.category !== 'strider' || state.dead || state.expired || !food || food.amount < 1 || !type.food.includes(food.selfId)) throw new Error('Mounted pet food unavailable');
            const currentFeed = Math.min(Rules.stats(type.npcId, state.level).maxFeed, state.currentFeed + feed);
            if (food.amount === 1) write('DELETE FROM items WHERE id = ? AND characterId = ?', [foodId, characterId]);
            else write('UPDATE items SET amount = ? WHERE id = ? AND characterId = ?', [food.amount-1, foodId, characterId]);
            write('UPDATE items SET petData = ? WHERE id = ? AND characterId = ?', [JSON.stringify({...state,currentFeed,starvingSince:0}),controlId,characterId]);
            return { currentFeed, remaining:food.amount-1 };
        }, 'pet:mount-food'));
    },
    exchangeDimensionalDiamond(characterId, itemId) {
        return withCharacterFlush(characterId, () => inTransaction(() => {
            const recipe = require('../data/Items/dimensional_diamond_exchanges.json').recipes.find(row => row.itemId === itemId);
            if (!recipe) throw new Error('Invalid dimensional diamond exchange');
            const diamonds = all('SELECT id, amount FROM items WHERE characterId = ? AND selfId = 7562 AND equipped = 0 ORDER BY id', [characterId]);
            if (diamonds.reduce((sum, item) => sum + item.amount, 0) < recipe.cost) throw new Error('Not enough dimensional diamonds');
            const template = require('./GameServer/DataCache').items.find(item => item.selfId === itemId);
            if (!template?.etc.stackable) throw new Error('Missing teleport scroll template');
            const changed = new Set();
            let remaining = recipe.cost;
            for (const item of diamonds) {
                const used = Math.min(remaining, item.amount);
                if (!used) break;
                remaining -= used;
                changed.add(item.id);
                if (used === item.amount) write('DELETE FROM items WHERE id = ?', [item.id]);
                else write('UPDATE items SET amount = ? WHERE id = ?', [item.amount - used, item.id]);
            }
            const scroll = one('SELECT id, amount FROM items WHERE characterId = ? AND selfId = ? AND equipped = 0 ORDER BY id LIMIT 1', [characterId, itemId]);
            if (scroll) { write('UPDATE items SET amount = amount + 1 WHERE id = ?', [scroll.id]); changed.add(scroll.id); }
            else changed.add(Number(write('INSERT INTO items(selfId, name, amount, characterId) VALUES (?, ?, 1, ?)', [itemId, template.template.name, characterId]).insertId));
            return [...changed].map(id => one('SELECT * FROM items WHERE id = ? AND characterId = ?', [id, characterId]) || { id, amount: 0 });
        }, 'quest:diamond-exchange'));
    },
    completeSecondProfession(characterId, expectedClassId, targetClassId) {
        return withCharacterFlush(characterId, () => inTransaction(() => {
            const route = require('../data/Templates/second_profession_trials.json').find(row => row.classId === targetClassId);
            const character = one('SELECT classId, level, race FROM characters WHERE id = ?', [characterId]);
            if (!route || character?.classId !== expectedClassId || character.level < 40 || character.race !== route.race
                || !require('./GameServer/ClassProgression').secondProfMap[expectedClassId]?.includes(targetClassId)) {
                throw new Error('Second profession is not available');
            }
            const changed = [];
            for (const selfId of route.marks) {
                const mark = one('SELECT id, amount FROM items WHERE characterId = ? AND selfId = ? AND equipped = 0 AND amount >= 1 ORDER BY id LIMIT 1', [characterId, selfId]);
                if (!mark) throw new Error('Required profession marks missing');
                if (mark.amount === 1) write('DELETE FROM items WHERE id = ? AND characterId = ?', [mark.id, characterId]);
                else write('UPDATE items SET amount = amount - 1 WHERE id = ? AND characterId = ?', [mark.id, characterId]);
                changed.push({ id: mark.id, amount: mark.amount - 1 });
            }
            write('UPDATE characters SET classId = ? WHERE id = ? AND classId = ?', [targetClassId, characterId, expectedClassId]);
            return changed;
        }, 'quest:second-profession'));
    },
    applyQuestStep(characterId, questId, expected, next, takes, gives, experience = null, beginner = null, pk = null, removeRecipes = []) {
        return withCharacterFlush(characterId, () => inTransaction(() => {
            if (!require('./GameServer/Quest/QuestRegistry').entries.some(e => e.id === questId && e.status === 'active')) throw new Error('Unsupported quest');
            const row = one('SELECT state, variables FROM character_quests WHERE characterId = ? AND questId = ?', [characterId, questId]);
            const current = row ? JSON.parse(row.variables || '{}') : {};
            if ((row?.state || 'created') !== expected.state || JSON.stringify(current) !== JSON.stringify(expected.variables)) throw new Error('Quest step changed');
            const changed = new Set();
            for (const take of takes) {
                // Only the owning trial may retire its currently wielded quest weapon.
                const trialWeapon = { 212: 3027, 218: 3026, 224: 3028, 229: 3029 }[questId];
                const equipmentFilter = take.selfId === trialWeapon ? '' : 'AND equipped = 0';
                const items = all(`SELECT id, amount FROM items WHERE characterId = ? AND selfId = ? ${equipmentFilter} ORDER BY id`, [characterId, take.selfId]);
                if (!Number.isSafeInteger(take.amount) || take.amount < 1 || items.reduce((sum, item) => sum + item.amount, 0) < take.amount) throw new Error('Required quest items missing');
                let remaining = take.amount;
                for (const item of items) {
                    const used = Math.min(remaining, item.amount);
                    if (!used) break;
                    remaining -= used;
                    changed.add(item.id);
                    if (used === item.amount) write('DELETE FROM items WHERE id = ? AND characterId = ?', [item.id, characterId]);
                    else write('UPDATE items SET amount = ? WHERE id = ? AND characterId = ?', [item.amount - used, item.id, characterId]);
                }
            }
            for (const give of gives) {
                if (!Number.isSafeInteger(give.amount) || give.amount < 1 || (!give.stackable && give.amount !== 1)) throw new Error('Invalid quest reward');
                const item = give.stackable ? one('SELECT id, amount FROM items WHERE characterId = ? AND selfId = ? ORDER BY id LIMIT 1', [characterId, give.selfId]) : null;
                if (item) { write('UPDATE items SET amount = ? WHERE id = ?', [item.amount + give.amount, item.id]); changed.add(item.id); }
                else changed.add(Number(write('INSERT INTO items(selfId, name, amount, characterId) VALUES (?, ?, ?, ?)', [give.selfId, give.name, give.amount, characterId]).insertId));
            }
            for (const recipeId of removeRecipes) {
                const allowed = { 216: [315, 316], 221: [314] }[questId] || [];
                if (!allowed.includes(recipeId)) throw new Error('Unsupported quest recipe');
                write('DELETE FROM character_recipes WHERE characterId = ? AND recipeId = ?', [characterId, recipeId]);
            }
            write(UPSERT_CHARACTER_QUEST, [characterId, questId, next.state, JSON.stringify(next.variables)]);
            const rows = [...changed].map(id => one('SELECT * FROM items WHERE id = ? AND characterId = ?', [id, characterId]) || { id, amount: 0 });
            if (experience) {
                if (![experience.exp, experience.sp].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('Invalid quest experience');
                const actor = one('SELECT exp, sp, level FROM characters WHERE id = ?', [characterId]);
                const cap = require('./GameServer/Progression/ProgressionCap');
                const award = cap.applyAward(actor.exp, experience.exp);
                const level = Math.max(actor.level, cap.levelForExperience(award.totalExp, actor.level));
                const totalSp = actor.sp + experience.sp;
                write('UPDATE characters SET exp = ?, sp = ?, level = ? WHERE id = ?', [award.totalExp, totalSp, level, characterId]);
                rows.experience = { totalExp: award.totalExp, totalSp, level, grantedExp: award.accepted, grantedSp: experience.sp };
            }
            // A beginner-shot grant and its character-wide receipt commit with the
            // rest of the hand-in, so shots can never be handed out unrecorded and
            // the counter can never advance without the shots.
            if (beginner) {
                const character = one('SELECT newbieShotsReceived FROM characters WHERE id = ?', [characterId]);
                if (Number(character.newbieShotsReceived) + 1 !== Number(beginner.received)) {
                    throw new Error('beginner reward receipt changed');
                }
                write('UPDATE characters SET newbieShotsReceived = ? WHERE id = ?',
                    [Number(beginner.received), characterId]);
                rows.beginner = { received: Number(beginner.received) };
            }
            if (pk) {
                if (questId !== 422 || !Number.isSafeInteger(pk.expected) || !Number.isSafeInteger(pk.next)
                    || pk.next < 0 || pk.next >= pk.expected) throw new Error('Invalid quest PK reward');
                const result = write('UPDATE characters SET pk = ? WHERE id = ? AND pk = ?',
                    [pk.next, characterId, pk.expected]);
                if (Number(result.affectedRows) !== 1) throw new Error('Quest PK count changed');
                rows.pk = pk.next;
            }
            return rows;
        }, 'quest:step'));
    },
    applyPetQuestStep(characterId, questId, expected, next, takes, gives) {
        return withCharacterFlush(characterId, () => inTransaction(() => {
            if (![420, 421].includes(questId)) throw new Error('Unsupported pet quest');
            const row = one('SELECT state, variables FROM character_quests WHERE characterId = ? AND questId = ?', [characterId, questId]);
            const current = row ? JSON.parse(row.variables || '{}') : {};
            if ((row?.state || 'created') !== expected.state || JSON.stringify(current) !== JSON.stringify(expected.variables)) throw new Error('Pet quest step changed');
            const changed = new Set();
            for (const take of takes) {
                const items = all('SELECT id, amount FROM items WHERE characterId = ? AND selfId = ? AND equipped = 0 ORDER BY id', [characterId, take.selfId]);
                if (!Number.isSafeInteger(take.amount) || take.amount < 1 || items.reduce((sum, item) => sum + item.amount, 0) < take.amount) throw new Error('Required quest items missing');
                let remaining = take.amount;
                for (const item of items) {
                    const used = Math.min(remaining, item.amount);
                    if (!used) break;
                    remaining -= used;
                    changed.add(item.id);
                    if (used === item.amount) write('DELETE FROM items WHERE id = ? AND characterId = ?', [item.id, characterId]);
                    else write('UPDATE items SET amount = ? WHERE id = ? AND characterId = ?', [item.amount - used, item.id, characterId]);
                }
            }
            for (const give of gives) {
                if (!Number.isSafeInteger(give.amount) || give.amount < 1 || (!give.stackable && give.amount !== 1)) throw new Error('Invalid quest reward');
                const item = give.stackable ? one('SELECT id, amount FROM items WHERE characterId = ? AND selfId = ? ORDER BY id LIMIT 1', [characterId, give.selfId]) : null;
                if (item) { write('UPDATE items SET amount = ? WHERE id = ?', [item.amount + give.amount, item.id]); changed.add(item.id); }
                else changed.add(Number(write('INSERT INTO items(selfId, name, amount, characterId) VALUES (?, ?, ?, ?)', [give.selfId, give.name, give.amount, characterId]).insertId));
            }
            write(UPSERT_CHARACTER_QUEST, [characterId, questId, next.state, JSON.stringify(next.variables)]);
            return [...changed].map(id => one('SELECT * FROM items WHERE id = ? AND characterId = ?', [id, characterId]) || { id, amount: 0 });
        }, 'pet:quest-step'));
    },
    evolveHatchling(characterId, controlId) {
        return withCharacterFlush(characterId, () => inTransaction(() => {
            const quest = one('SELECT state, variables FROM character_quests WHERE characterId = ? AND questId = 421', [characterId]);
            const variables = JSON.parse(quest?.variables || '{}');
            const item = one('SELECT * FROM items WHERE id = ? AND characterId = ?', [controlId, characterId]);
            const target = {3500:4422,3501:4423,3502:4424}[item?.selfId];
            const saved = JSON.parse(item?.petData || '{}');
            if (!target || quest?.state !== 'started' || Number(variables.cond) !== 3 || Number(variables.controlId) !== controlId || Number(variables.trees) !== 15 || saved.level < 55 || saved.dead || saved.expired) throw new Error('Hatchling evolution is not ready');
            const Rules = require('./GameServer/Pets/PetRules');
            const type = Rules.TYPES[target];
            const stats = Rules.stats(type.npcId, saved.level);
            const state = { ...saved, npcId: type.npcId, hp: stats.maxHp, mp: stats.maxMp, currentFeed: stats.maxFeed,
                maxFeed: stats.maxFeed, feedNormal: stats.feedNormal, feedBattle: stats.feedBattle, starvingSince: 0,
                inventory: (saved.inventory || []).map(row => ({ ...row, equipped: false })) };
            write('UPDATE items SET selfId = ?, name = ?, petData = ? WHERE id = ? AND characterId = ?', [target, `Dragon Bugle of ${type.name.slice(11)}`, JSON.stringify(state), controlId, characterId]);
            write("UPDATE character_quests SET state = 'created', variables = '{}' WHERE characterId = ? AND questId = 421", [characterId]);
            return { ...item, selfId: target, petData: state };
        }, 'pet:evolution'));
    },
    replaceSoulCrystal(characterId, id, expectedSelfId, selfId, name, crystalIds, isStillValid) {
        return withCharacterFlush(characterId, () => inTransaction(() => {
            if (!isStillValid()) return false;
            const quest = one('SELECT state FROM character_quests WHERE characterId = ? AND questId = 350', [characterId]);
            const item = one('SELECT selfId, amount, equipped FROM items WHERE id = ? AND characterId = ?', [id, characterId]);
            if (quest?.state !== 'started' || !item || item.selfId !== expectedSelfId || item.amount !== 1 || item.equipped) return false;
            const quantity = one(`SELECT SUM(amount) AS count FROM items WHERE characterId = ? AND amount > 0 AND selfId IN (${crystalIds.map(() => '?').join(',')})`, [characterId, ...crystalIds]);
            if (quantity.count !== 1) return false;
            write('UPDATE items SET selfId = ?, name = ? WHERE id = ? AND characterId = ?', [selfId, name, id, characterId]);
            return true;
        }, 'item:soul-crystal'));
    },
    exchangePetTicket(characterId, ticketId) {
        return withCharacterFlush(characterId, () => inTransaction(() => {
            const ticket = one('SELECT selfId, amount, equipped FROM items WHERE id = ? AND characterId = ?', [ticketId, characterId]);
            const output = require('./GameServer/Pets/PetExchangeData').tickets[ticket?.selfId];
            if (!ticket || !output || ticket.amount < 1 || ticket.equipped) throw new Error('Pet ticket missing or no longer owned');
            const slots = one('SELECT COUNT(*) AS count FROM items WHERE characterId = ?', [characterId]).count;
            if (ticket.amount > 1 && slots >= 80) throw new Error('Inventory is full');
            const remaining = ticket.amount - 1;
            if (remaining) write('UPDATE items SET amount = ? WHERE id = ? AND characterId = ?', [remaining, ticketId, characterId]);
            else write('DELETE FROM items WHERE id = ? AND characterId = ?', [ticketId, characterId]);
            const id = Number(write('INSERT INTO items(selfId, name, amount, characterId) VALUES (?, ?, 1, ?)', [output.itemId, output.name, characterId]).insertId);
            return { id, selfId: output.itemId, remaining };
        }, 'pet:ticket-exchange'));
    },
    completeWolfQuest(characterId) {
        return withCharacterFlush(characterId, () => inTransaction(() => {
            const quest = one('SELECT state, variables FROM character_quests WHERE characterId = ? AND questId = 419', [characterId]);
            const variables = quest ? JSON.parse(quest.variables || '{}') : {};
            if (quest?.state !== 'started' || Number(variables.cond) !== 3 || Number(variables.answers) !== 9) throw new Error('Wolf quest reward already claimed or not ready');
            const list = one('SELECT id FROM items WHERE characterId = ? AND selfId = 3417 AND amount >= 1', [characterId]);
            if (!list) throw new Error('Animal Lovers List missing');
            write('DELETE FROM items WHERE id = ? AND characterId = ?', [list.id, characterId]);
            const id = Number(write("INSERT INTO items(selfId, name, amount, characterId) VALUES (2375, 'Wolf Collar', 1, ?)", [characterId]).insertId);
            write("UPDATE character_quests SET state = 'created', variables = '{}' WHERE characterId = ? AND questId = 419", [characterId]);
            return { id, removedItemId: list.id };
        }, 'pet:wolf-quest-reward'));
    },
    setCharacterQuest(characterId, questId, state, variables) { return run(UPSERT_CHARACTER_QUEST, [characterId, questId, state, JSON.stringify(variables || {})], 'quest:upsert'); },
    deleteCharacterQuest(characterId, questId) { return remove('character_quests', 'characterId = ? AND questId = ?', [characterId, questId], 'quest:delete'); },
    fetchCharacterRecipes(characterId) { return run('SELECT recipeId, type FROM character_recipes WHERE characterId = ?', [characterId], 'recipe:list'); },
    setCharacterRecipe(characterId, recipeId, type) { return run(UPSERT_RECIPE, [characterId, recipeId, type], 'recipe:upsert'); },

    learnColdRecipes(characterId, recipes, coldState, { economyCommand = null, validate = null } = {}) {
        return withCharacterFlush(characterId, () => inTransaction(() => {
            const step = economyStepUnsafe(characterId, economyCommand, EconomyCommit.KINDS.learn);
            if (step?.replay) return { ...step.replay, learned: step.replay.success && step.replay.nativeId
                ? [{ recipeId: step.replay.nativeId }] : [] };
            if (step && recipes.length !== 1) throw Error('economy_learning_requires_one_recipe');
            validate?.();
            const learned = [];
            for (const recipe of recipes) {
                if (step) {
                    const native = invoke('GameServer/Items/C4RecipeItems').resolveByRecipeId(recipe.recipeId);
                    const skill = one('SELECT level FROM skills WHERE characterId=? AND selfId=?',
                        [Number(characterId), native?.type === 'dwarven' ? 172 : 132]);
                    if (!native || Number(native.recipeItemId) !== Number(recipe.recipeItemId)
                        || Number(skill?.level || 0) < Number(native.level)) throw Error('recipe_learning_not_available');
                }
                if (one('SELECT recipeId FROM character_recipes WHERE characterId = ? AND recipeId = ?',
                    [characterId, recipe.recipeId])) continue;
                const scroll = one('SELECT id, amount FROM items WHERE characterId = ? AND selfId = ? AND amount > 0 AND equipped = 0 ORDER BY id LIMIT 1',
                    [characterId, recipe.recipeItemId]);
                if (!scroll) throw new Error('recipe_scroll_missing');
                checkEconomyMaterialProtectionUnsafe(characterId, step, recipe.recipeItemId, 1);
                if (Number(scroll.amount) === 1) write('DELETE FROM items WHERE id = ? AND characterId = ?', [scroll.id, characterId]);
                else write('UPDATE items SET amount = amount - 1 WHERE id = ? AND characterId = ?', [scroll.id, characterId]);
                write(UPSERT_RECIPE, [characterId, recipe.recipeId, recipe.type]);
                learned.push({ recipeId: recipe.recipeId, recipeItemId: recipe.recipeItemId, name: recipe.name || '' });
            }
            if (!learned.length && !step) return { learned, coldLifeRow: null };
            const receipt = { success: learned.length > 0, units: learned.length, nativeId: Number(recipes[0]?.recipeId || 0) };
            const learning = { learned, at: now() };
            const completedRow = step ? completeEconomyStepUnsafe(characterId, step, receipt,
                learned.map(recipe => recipe.recipeItemId), null, learning) : syncEconomySnapshotUnsafe(characterId, coldState, learned.map(recipe => recipe.recipeItemId));
            if (!step) write("UPDATE bot_life_state SET statsJson = json_set(statsJson, '$.lastRecipeBookLearning', json(?)) WHERE characterId = ?",
                [JSON.stringify(learning), characterId]);
            return { learned, committed: true, ...(step ? { economyCommit: jsonObject(completedRow.statsJson).economyCommit } : {}),
                coldLifeRow: normalizeRow(one('SELECT * FROM bot_life_state WHERE characterId = ?', [characterId])) };
        }, 'recipe:cold-learn'));
    },

    purchaseNpcInventoryItem(characterId, details) {
        return this.purchaseNpcInventoryBasket(characterId, { ...details,
            ...(Diagnostics.active() && { diagnosticCaller: 'purchaseNpcInventoryItem' }),
            lines: [{ stackable: true, slot: 0, ...details }] });
    },

    // A bounded purchase from one real NPC. The legacy scalar adapter retains
    // its direct-call contract; autonomous baskets supply a seller and command.
    purchaseNpcInventoryBasket(characterId, details = {}) {
        if (Array.isArray(details.lines) && details.lines.length > 12) return Promise.reject(Error('invalid npc basket'));
        if (details.lines?.some(line => line.fundingParts?.length > 12 || line.errands?.length > 8)) return Promise.reject(Error('invalid npc basket attribution'));
        const { economyCommand = null, coldState = null, validate = null } = details;
        const seller = details.seller ? { ...details.seller } : null;
        const captured = Array.isArray(details.lines) ? details.lines.map(line => ({ ...line,
            funding: { ...line.funding }, fundingParts: line.fundingParts?.map(part => ({ ...part, funding: { ...part.funding } })),
            errands: (line.errands || []).map(entry => ({ ...entry,
                errand: JSON.parse(JSON.stringify(entry.errand)) })),
            goal: line.goal ? JSON.parse(JSON.stringify(line.goal)) : null })) : [];
        return withCharacterFlush(characterId, () => inTransaction(() => {
            const step = economyStepUnsafe(characterId, economyCommand, EconomyCommit.KINDS.npcBuy);
            const goalRow = () => normalizeRow(one('SELECT * FROM bot_goal_state WHERE characterId=?', [characterId]));
            if (step?.replay) return { ...step.replay, ok: step.replay.success, goalRow: goalRow() };
            if (!captured.length || captured.length > 12) throw Error('invalid npc basket');
            const Shop = invoke('GameServer/World/Generics/NpcShopBuyLists');
            const Index = require('./GameServer/Item/ItemTemplateIndex');
            const Data = invoke('GameServer/DataCache');
            if (seller) {
                const found = invoke('GameServer/Bot/Economy/TownNpcCatalog').rowsForTown(seller.town).some(row =>
                    Number(row.npcSelfId) === Number(seller.sourceId) && ['locX', 'locY', 'locZ'].every(key =>
                        Number.isFinite(Number(seller[key])) && Number(row[key]) === Number(seller[key])));
                if (!found || step && seller.town !== step.row.currentRegion) throw Error('npc_seller_changed');
            }

            validate?.();
            const seen = new Set(), lines = [];
            let total = 0, units = 0, errandCount = 0;
            for (const line of captured) {
                const itemId = Number(line.selfId), count = Number(line.amount), price = Number(line.unitPrice);
                if (Diagnostics.active()) stageNativeDiagnostic(characterId, step, 'native_quantity', 'npc_requested',
                    { lineId: lines.length, item: itemId, requested: count, planned: count, unitPrice: price,
                        npcId: seller ? Number(seller.sourceId) : undefined, town: seller?.town,
                        goalRevision: Number(line.goal?.updatedAt) });
                if (!Number.isSafeInteger(itemId) || itemId <= 0)
                    throw invalidNpcPurchase(characterId, step, line, lines.length, 'invalid_item', 'selfId', line.selfId, details);
                if (seen.has(itemId))
                    throw invalidNpcPurchase(characterId, step, line, lines.length, 'duplicate_item', 'selfId', line.selfId, details);
                if (!Number.isSafeInteger(count) || count <= 0)
                    throw invalidNpcPurchase(characterId, step, line, lines.length, 'invalid_count', 'amount', line.amount, details);
                if (!Number.isSafeInteger(price) || price <= 0)
                    throw invalidNpcPurchase(characterId, step, line, lines.length, 'invalid_price', 'unitPrice', line.unitPrice, details);
                if (!Number.isSafeInteger(count * price))
                    throw invalidNpcPurchase(characterId, step, line, lines.length, 'invalid_line_total', 'total', count * price, details);
                seen.add(itemId);
                const template = Index.find(Data.items, itemId);
                if (seller) {
                    const quote = Shop.rowForNpc(Number(seller.sourceId), itemId);
                    if (!quote || Number(quote.price) !== price
                        || !require('./GameServer/Bot/Economy/ProductionPolicy').allowsNpcShot(itemId)) throw Error('npc_quote_changed');
                }
                const stackable = line.stackable === undefined ? !!template?.etc?.stackable : !!line.stackable;
                const slot = line.slot === undefined ? Number(template?.etc?.slot || 0) : Number(line.slot);
                // Stack quantities come from the funded missing need. They use
                // one physical row; retain the instance bound for unstacked goods.
                if (!stackable && count > 10000)
                    throw invalidNpcPurchase(characterId, step, line, lines.length, 'nonstackable_limit', 'amount', line.amount, details);
                if ((step || seller) && (!template || stackable !== !!template.etc?.stackable
                    || slot !== Number(template.etc?.slot || 0))) throw Error('npc_item_template_changed');
                if (seller && step && slot > 0) {
                    const blocker = invoke('GameServer/Bot/Population/BotLifeState').marketPurchaseBlocker({
                        stats: jsonObject(step.row.statsJson), inventory: jsonObject(step.row.inventorySummary)
                    }, { selfId: itemId }, count);
                    if (blocker) throw Error(blocker);
                }
                let attributed = 0, attributedCost = 0;
                for (const entry of line.errands) {
                    if (!entry.errand || Number(entry.errand.selfId) !== itemId || seller && entry.errand.town !== seller.town
                        || !Number.isSafeInteger(entry.units) || entry.units <= 0
                        || entry.units > Number(entry.errand.amount)
                        || !Number.isSafeInteger(entry.spent) || entry.spent < 0 || entry.spent !== entry.units * price) throw Error('invalid npc errand attribution');
                    attributed += entry.units; attributedCost += entry.spent;
                    if (++errandCount > 8) throw Error('invalid npc errand attribution');
                }
                if (attributed > count || attributedCost > count * price) throw Error('invalid npc errand attribution');
                total += count * price; units += count;
                if (!Number.isSafeInteger(total) || !Number.isSafeInteger(units))
                    throw invalidNpcPurchase(characterId, step, line, lines.length, 'invalid_basket_total',
                        Number.isSafeInteger(total) ? 'units' : 'total', Number.isSafeInteger(total) ? units : total, details, 'invalid npc basket total');
                lines.push({ ...line, selfId: itemId, amount: count, unitPrice: price, stackable, slot,
                    name: line.name || template?.template?.name || `Item ${itemId}` });
            }
            if (Diagnostics.active()) stageNativeDiagnostic(characterId, step, 'npc_basket', 'planned',
                { requested: units, planned: units, cost: total, npcId: seller ? Number(seller.sourceId) : undefined, town: seller?.town });
            const wallet = one('SELECT id, amount FROM items WHERE characterId=? AND selfId=57 ORDER BY id LIMIT 1', [characterId]);
            let remainingWallet = Number(wallet?.amount || 0);
            const Funding = require('./GameServer/Bot/Economy/PurchaseFunding');
            let remainingPacket = step ? jsonObject(step.row.statsJson).money : null;
            const parts = [];
            for (const [index, line] of lines.entries()) {
                const fundingParts = line.fundingParts || [{ amount: line.amount, funding: line.funding, order: index }];
                let count = 0;
                for (const part of fundingParts) {
                    if (!Number.isSafeInteger(part.amount) || part.amount <= 0
                        || !Number.isSafeInteger(part.order) || part.order < 0 || part.order >= 12) throw Error('invalid npc funding part');
                    count += part.amount;
                    parts.push({ ...part, selfId: line.selfId, unitPrice: line.unitPrice });
                }
                if (count !== line.amount) throw Error('invalid npc funding part');
            }
            if (parts.length > 12 || new Set(parts.map(part => part.order)).size !== parts.length) throw Error('invalid npc funding parts');
            parts.sort((left, right) => left.order - right.order);
            for (const part of parts) {
                const spent = part.amount * part.unitPrice, funding = { ...part.funding, itemId: part.selfId };
                checkEconomyFundingUnsafe(characterId, step, spent, funding, remainingWallet, remainingPacket);
                remainingWallet -= spent;
                remainingPacket = Funding.packetAfterPurchase(remainingPacket, spent, funding);
            }
            if (!wallet || remainingWallet < 0) {
                if (Diagnostics.active()) stageNativeDiagnostic(characterId, step, 'npc_basket', 'insufficient_adena',
                    { requested: units, planned: units, actual: 0, spent: 0, wallet: Number(wallet?.amount || 0),
                        npcId: seller ? Number(seller.sourceId) : undefined, town: seller?.town });
                const row = completeEconomyStepUnsafe(characterId, step, { success: false,
                    nativeId: Number(seller?.sourceId || lines[0].selfId) }, []);
                return { ok: false, reason: 'insufficient_adena', ...(row ? { coldLifeRow: row } : {}) };
            }
            write('UPDATE items SET amount=? WHERE id=? AND characterId=?', [remainingWallet, wallet.id, characterId]);
            for (const line of lines) {
                const existing = line.stackable ? one('SELECT id,amount FROM items WHERE characterId=? AND selfId=? ORDER BY id LIMIT 1', [characterId, line.selfId]) : null;
                if (existing) {
                    const nextAmount = Number(existing.amount) + line.amount;
                    if (!Number.isSafeInteger(nextAmount))
                        throw invalidNpcPurchase(characterId, step, line, lines.indexOf(line), 'invalid_stack_total', 'amount', nextAmount, details, 'invalid npc stack total');
                    write('UPDATE items SET amount=? WHERE id=? AND characterId=?', [nextAmount, existing.id, characterId]);
                }
                else for (let index = 0; index < (line.stackable ? 1 : line.amount); index++) {
                    write('INSERT INTO items(selfId,name,amount,equipped,slot,characterId) VALUES(?,?,?,0,?,?)',
                        [line.selfId, line.name, line.stackable ? line.amount : 1, line.slot, characterId]);
                }
            }
            if (Diagnostics.active()) for (const [lineId, line] of lines.entries()) {
                stageNativeDiagnostic(characterId, step, 'native_quantity', 'npc_filled',
                    { lineId, item: line.selfId, requested: line.amount, planned: line.amount, actual: line.amount,
                        spent: line.amount * line.unitPrice, unitPrice: line.unitPrice,
                        npcId: seller ? Number(seller.sourceId) : undefined, town: seller?.town });
            }
            const changed = new Set(lines.map(line => line.selfId)), patch = {};
            if (step) patch.money = remainingPacket;
            // Reconcile the complete purchased bag once, not once per line.
            const gear = lines.find(line => !line.stackable && line.slot > 0
                && (line.autoEquip ?? details.autoEquip) !== false);
            const heldIds = lines.filter(line => (line.autoEquip ?? details.autoEquip) === false).map(line => line.selfId);
            const equipped = gear ? equipColdPurchaseUnsafe(characterId, step, gear.selfId, true, heldIds) : null;
            for (const id of equipped?.ids || []) changed.add(id);
            Object.assign(patch, equipped?.patch);
            if (step && lines.some(line => line.errands.length)) {
                const Errands = require('./GameServer/Bot/Population/CombinedErrandPolicy');
                const stats = jsonObject(step.row.statsJson);
                let errands = Errands.pending({ stats });
                for (const line of lines) for (const entry of line.errands) {
                    const index = errands.findIndex(other => Errands.key(other) === Errands.key(entry.errand)
                        && Number(other.at) === Number(entry.errand.at) && Number(other.amount) === Number(entry.errand.amount));
                    if (index < 0) {
                        if (Diagnostics.active()) stageNativeDiagnostic(characterId, step, 'npc_errand', 'stale_errand',
                            { item: line.selfId, errandKey: Errands.key(entry.errand), errandAt: Number(entry.errand.at),
                                requested: Number(entry.errand.amount), planned: entry.units, actual: 0, spent: 0 });
                        continue;
                    }
                    const old = errands[index], rest = Math.max(0, Number(old.amount) - entry.units);
                    if (!rest) errands.splice(index, 1);
                    else errands[index] = { ...old, amount: rest,
                        ...(Number.isFinite(old.money) ? { money: Math.max(0, old.money - entry.spent) } : {}),
                        ...(old.purpose === 'clan' ? { tag: { ...old.tag, clanPart: Math.max(0, Number(old.tag?.clanPart || 0) - entry.spent) } } : {}) };
                    if (Diagnostics.active()) stageNativeDiagnostic(characterId, step, 'npc_errand', rest ? 'partial' : 'completed',
                        { item: line.selfId, errandKey: Errands.key(old), errandAt: Number(old.at),
                            requested: Number(old.amount), planned: entry.units, actual: entry.units, spent: entry.spent, remaining: rest });
                    patch.lastErrand = { purpose: old.purpose, selfId: old.selfId, units: entry.units, tag: old.tag || null, at: now() };
                }
                Object.assign(patch, { marketErrands: errands, marketErrand: errands[0] || null });
            }
            const Goals = invoke('GameServer/Bot/Goals/GoalState');
            for (const line of lines) if (line.goal) {
                const { expectedGoal, updatedAt } = line.goal;
                const count = Number(line.goal.units ?? line.amount);
                if (!Number.isSafeInteger(count) || count <= 0 || count > line.amount
                    || Number(expectedGoal?.target?.itemId) !== line.selfId) throw Error('invalid npc goal attribution');
                const timestamp = now(), next = Goals.purchasePatch(expectedGoal, count, timestamp);
                const applied = next ? write('UPDATE bot_goal_state SET goalJson=?,updatedAt=? WHERE characterId=? AND updatedAt=? AND goalJson=?',
                    [JSON.stringify(next), timestamp, characterId, updatedAt, JSON.stringify(expectedGoal)]) : null;
                if (Diagnostics.active()) stageNativeDiagnostic(characterId, step, 'npc_goal', applied?.affectedRows ? 'applied' : 'unchanged',
                    { item: line.selfId, goalRevision: Number(updatedAt), goalApplied: Number(applied?.affectedRows || 0),
                        requested: Number(expectedGoal?.target?.amount), planned: count, actual: applied?.affectedRows ? count : 0,
                        remaining: applied?.affectedRows ? Number(next.target?.amount) : undefined });
            }
            const receipt = { units, spent: total, nativeId: Number(seller?.sourceId || lines[0].selfId) };
            const row = step ? completeEconomyStepUnsafe(characterId, step, receipt, [...changed], null, null, patch)
                : syncEconomySnapshotUnsafe(characterId, coldState, [...changed]);
            return { ok: true, committed: true, ...receipt, amount: units, lines,
                goalRow: goalRow(), ...(row ? { coldLifeRow: row, economyCommit: jsonObject(row.statsJson).economyCommit } : {}) };
        }, 'bot:npc-purchase'));
    },

    craftInventoryItems(characterId, { materials, product, mp, coldState = null, economyCommand = null,
        recipeId = 0, batches = 1, random = Math.random, validate = null }) {
        return withCharacterFlush(characterId, () => inTransaction(() => {
            const step = economyStepUnsafe(characterId, economyCommand, EconomyCommit.KINDS.craft);
            if (step?.replay) return step.replay;
            validate?.();
            let success = !!product;
            if (step) {
                const recipe = invoke('GameServer/Items/C4RecipeItems').resolveByRecipeId(recipeId);
                if (!recipe || !Number.isSafeInteger(batches) || batches < 1 || batches > 64
                    || !one('SELECT recipeId FROM character_recipes WHERE characterId=? AND recipeId=?', [characterId, recipeId])) throw Error('craft_recipe_changed');
                const skill = one('SELECT level FROM skills WHERE characterId=? AND selfId=?',
                    [characterId, recipe.type === 'dwarven' ? 172 : 132]);
                const currentMp = step.row.phase === 'cold' ? Number(step.row.mp)
                    : Number(one('SELECT mp FROM characters WHERE id=?', [characterId])?.mp || 0);
                if (Number(skill?.level || 0) < Number(recipe.level) || currentMp < recipe.mpCost * batches) throw Error('craft_skill_or_mp_changed');
                const required = new Map(), supplied = new Map();
                for (const material of recipe.materials) required.set(Number(material.selfId),
                    (required.get(Number(material.selfId)) || 0) + Number(material.amount) * batches);
                for (const material of materials) supplied.set(Number(material.selfId),
                    (supplied.get(Number(material.selfId)) || 0) + Number(material.amount));
                if (required.size !== supplied.size || [...required].some(([id, amount]) => supplied.get(id) !== amount)) throw Error('craft_recipe_materials_changed');
                for (const [id, amount] of required) checkEconomyMaterialProtectionUnsafe(characterId, step, id, amount);
                if (!product || Number(product.selfId) !== Number(recipe.productId)
                    || Number(product.amount) !== Number(recipe.productCount) * batches) throw Error('craft_product_changed');
                const template = require('./GameServer/Item/ItemTemplateIndex').find(invoke('GameServer/DataCache').items, Number(recipe.productId));
                if (!template || !!product.stackable !== !!template.etc?.stackable || Number(product.slot || 0) !== Number(template.etc?.slot || 0)) throw Error('craft_product_template_changed');
                mp = currentMp - recipe.mpCost * batches;
                success = recipe.successRate >= 100 || Number(random()) * 100 < recipe.successRate;
                if (!success) product = null;
            }
            const sources = [];
            const rows = new Map();
            for (const material of materials) {
                if (!Number.isSafeInteger(Number(material.amount)) || Number(material.amount) <= 0) throw Error('invalid_craft_material');
                const previous = rows.get(Number(material.id));
                if (previous && Number(previous.selfId) !== Number(material.selfId)) throw Error('craft_material_identity_changed');
                rows.set(Number(material.id), { ...material, amount: Number(material.amount) + Number(previous?.amount || 0) });
            }
            for (const material of rows.values()) {
                const source = one('SELECT id, selfId, amount, equipped FROM items WHERE id = ? AND characterId = ?', [material.id, characterId]);
                if (!source || source.equipped || Number(source.selfId) !== Number(material.selfId) || Number(source.amount) < Number(material.amount)) throw new Error('craft material changed');
                sources.push({ id: Number(source.id), amount: Number(source.amount) - Number(material.amount) });
                if (Diagnostics.active()) stageNativeDiagnostic(characterId, step, 'craft_material', 'validated',
                    { item: Number(material.selfId), nativeId: Number(source.id), recipeId: Number(recipeId), owned: Number(source.amount), requested: Number(material.amount) });
            }
            const target = product?.stackable ? one('SELECT id, amount FROM items WHERE characterId = ? AND selfId = ? ORDER BY id LIMIT 1', [characterId, product.selfId]) : null;
            let productId = Number(target?.id || 0);
            const productAmount = Number(target?.amount || 0) + Number(product?.amount || 0);
            sources.forEach((source) => source.amount <= 0 ? write('DELETE FROM items WHERE id = ? AND characterId = ?', [source.id, characterId]) : write('UPDATE items SET amount = ? WHERE id = ? AND characterId = ?', [source.amount, source.id, characterId]));
            if (target) write('UPDATE items SET amount = ? WHERE id = ? AND characterId = ?', [productAmount, productId, characterId]);
            else if (product) {
                for (let index = 0; index < (product.stackable ? 1 : Number(product.amount)); index++) {
                    const inserted = write('INSERT INTO items (selfId, name, amount, equipped, slot, characterId) VALUES (?, ?, ?, 0, ?, ?)',
                        [product.selfId, product.name || '', product.stackable ? product.amount : 1, product.slot || 0, characterId]).insertId;
                    if (!productId) productId = inserted;
                }
            }
            write('UPDATE characters SET mp = ? WHERE id = ?', [mp, characterId]);
            const changedIds = [...materials.map(item => item.selfId), ...(product ? [product.selfId] : [])];
            const result = { success, units: Number(product?.amount || 0), nativeId: Number(recipeId || 0), mp };
            const coldLifeRow = step ? completeEconomyStepUnsafe(characterId, step, result, changedIds, mp)
                : syncEconomySnapshotUnsafe(characterId, coldState, changedIds, mp);
            return { ...result, committed: true, sources, product: product ? { id: productId, amount: productAmount } : null,
                ...(coldLifeRow ? { coldLifeRow, economyCommit: jsonObject(coldLifeRow.statsJson).economyCommit } : {}) };
        }, 'craft:self'));
    },

    exchangeWeaponSA(characterId, { npcId, recipeId, sourceObjectId, expectedSelfId, expectedEnchant, validate }) {
        return withCharacterFlush(characterId, () => inTransaction(() => {
            validate();
            const catalog = invoke('GameServer/Items/C4WeaponSAExchange');
            const recipe = catalog.resolve(npcId, recipeId);
            const target = recipe && invoke('GameServer/DataCache').items.find(item => item.selfId === recipe.productId);
            const weapon = one('SELECT * FROM items WHERE id = ? AND characterId = ?', [sourceObjectId, characterId]);
            if (!recipe || !target || !weapon || weapon.selfId !== expectedSelfId || weapon.selfId !== recipe.sourceId
                || weapon.enchant !== expectedEnchant || weapon.amount !== 1 || weapon.equipped) throw Error('weapon_sa_source_changed');
            const consumed = [];
            for (const cost of catalog.costs(recipe)) {
                const rows = all('SELECT * FROM items WHERE characterId = ? AND selfId = ? AND amount > 0 AND equipped = 0 ORDER BY id', [characterId, cost.selfId]);
                validate(rows);
                let remaining = cost.amount;
                for (const row of rows) {
                    if (remaining <= 0) break;
                    const amount = Math.min(remaining, row.amount);
                    consumed.push({ id: row.id, selfId: row.selfId, remaining: row.amount - amount });
                    remaining -= amount;
                }
                if (remaining) throw Error('weapon_sa_missing_materials');
            }
            for (const row of consumed) {
                if (row.remaining) write('UPDATE items SET amount = ? WHERE id = ? AND characterId = ?', [row.remaining, row.id, characterId]);
                else write('DELETE FROM items WHERE id = ? AND characterId = ?', [row.id, characterId]);
            }
            // Enchant is deliberately absent from this UPDATE. Installation and
            // removal preserve the selected instance rather than creating +0 gear.
            write('UPDATE items SET selfId = ?, name = ?, slot = ? WHERE id = ? AND characterId = ?',
                [target.selfId, target.template.name, target.etc.slot, sourceObjectId, characterId]);
            return { weapon: { ...weapon, selfId: target.selfId, name: target.template.name, slot: target.etc.slot }, consumed };
        }, 'item:weapon-sa'));
    },

    unsealInventoryItem(characterId, sourceId, productId, validate) {
        return withCharacterFlush(characterId, () => inTransaction(() => {
            validate?.();
            const row = one('SELECT * FROM items WHERE id = ? AND characterId = ?', [sourceId, characterId]);
            const recipe = row && invoke('GameServer/Items/C4Unseal').resolve(row.selfId, productId);
            const item = recipe && invoke('GameServer/DataCache').items.find(i => i.selfId === recipe.productId);
            if (!item || Number(row.amount) !== 1 || Number(row.equipped) !== 0) throw Error('unseal_source_changed');
            // Update in place: enchant and all other instance metadata survive.
            write('UPDATE items SET selfId = ?, name = ?, slot = ? WHERE id = ? AND characterId = ?',
                [item.selfId, item.template.name, item.etc.slot, sourceId, characterId]);
            return { ...row, selfId:item.selfId, name:item.template.name, slot:item.etc.slot };
        }, 'item:unseal'));
    },

    combineInventoryItems(characterId, { ingredients, product, validate }) {
        return withCharacterFlush(characterId, () => inTransaction(() => {
            validate?.();
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

    crystallizeInventoryItem(characterId, { sourceId, sourceSelfId, crystalId, crystalName, crystalAmount, coldState = null, expectedEnchant = null, validate }) {
        return withCharacterFlush(characterId, () => inTransaction(() => {
            validate?.();
            if (!Number.isSafeInteger(crystalAmount) || crystalAmount <= 0 || crystalAmount > 2147483647) throw new Error('invalid crystal amount');
            const source = one('SELECT id, selfId, amount, equipped, enchant FROM items WHERE id = ? AND characterId = ?', [sourceId, characterId]);
            if (!source || Number(source.selfId) !== Number(sourceSelfId) || Number(source.amount) !== 1 || Number(source.equipped) !== 0
                || (expectedEnchant !== null && Number(source.enchant || 0) !== Number(expectedEnchant))) throw new Error('crystallize source changed');
            const target = one('SELECT id, amount FROM items WHERE characterId = ? AND selfId = ? ORDER BY id LIMIT 1', [characterId, crystalId]);
            const amount = Number(target?.amount || 0) + Number(crystalAmount);
            if (!Number.isSafeInteger(amount) || amount > 2147483647) throw new Error('crystal stack is full');
            let id = Number(target?.id || 0);
            write('DELETE FROM items WHERE id = ? AND characterId = ?', [sourceId, characterId]);
            if (target) write('UPDATE items SET amount = ? WHERE id = ? AND characterId = ?', [amount, id, characterId]);
            else id = write('INSERT INTO items (selfId, name, amount, equipped, slot, characterId) VALUES (?, ?, ?, 0, 0, ?)', [crystalId, crystalName || '', crystalAmount, characterId]).insertId;
            const coldLifeRow = syncEconomySnapshotUnsafe(characterId, coldState, [sourceSelfId, crystalId]);
            return { crystalId, id, amount, ...(coldLifeRow ? { coldLifeRow } : {}) };
        }, 'crystalize'));
    },

    applyColdSoulCrystalResults(characterId, steps, options = {}) {
        const admission = captureWriteAdmission(options, 'invalid_soul_crystal_before_write', characterId);
        return withCharacterFlush(characterId, () => inTransaction(() => {
            const guard = () => {
                checkCapturedWriteAdmission(admission, characterId);
                const row = one('SELECT phase,simulationOwner FROM bot_life_state WHERE characterId=?',[characterId]);
                if (row?.phase !== 'cold' || row.simulationOwner !== LEGACY_SIMULATION_OWNER) throw Error('soul_crystal_owner_changed');
            };
            guard(); applySoulCrystalStepsUnsafe(characterId, steps, guard);
            return { changed: steps.length };
        }, 'cold:soul-crystals'));
    },

    applyBotImprovement(characterId, proposal, options = {}) {
        const admission = captureWriteAdmission(options, 'invalid_improvement_before_write', characterId);
        const state = options.coldState;
        const rng = typeof options.rng === 'function' ? options.rng : Math.random;
        return withCharacterFlush(characterId, () => inTransaction(() => {
            const guard = () => {
                checkCapturedWriteAdmission(admission, characterId);
                options.validate?.();
                if (!state) {
                    const row = one('SELECT phase, simulationOwner FROM bot_life_state WHERE characterId = ?', [characterId]);
                    if (row && (row.phase !== 'hot' || row.simulationOwner !== LEGACY_SIMULATION_OWNER)) throw Error('improvement_hot_source_changed');
                }
                if (state) {
                    const row = one('SELECT phase, simulationOwner, simulationRevision FROM bot_life_state WHERE characterId = ?', [characterId]);
                    if (state.characterId !== characterId || row?.phase !== 'cold' || row.simulationOwner !== LEGACY_SIMULATION_OWNER
                        || Number(row.simulationRevision) !== Number(state.simulation?.revision || 0)) throw Error('economy_state_changed');
                }
            };
            guard();
            const mutate = (sql, args) => { guard(); return write(sql, args); };
            const consume = (selfId, count) => {
                const rows = all('SELECT * FROM items WHERE characterId = ? AND selfId = ? AND equipped = 0 AND amount > 0 ORDER BY id', [characterId, selfId]);
                if (!Number.isSafeInteger(count) || count < 1 || rows.reduce((n, r) => n + r.amount, 0) < count) throw Error('improvement_missing_materials');
                let left = count;
                for (const row of rows) {
                    const amount = Math.min(left, row.amount); if (!amount) continue;
                    if (row.amount > amount) mutate('UPDATE items SET amount = amount - ? WHERE id = ? AND characterId = ?', [amount, row.id, characterId]);
                    else mutate('DELETE FROM items WHERE id = ? AND characterId = ?', [row.id, characterId]);
                    left -= amount;
                }
            };
            let result, changedIds = [], hennas;
            const Policy = invoke('GameServer/Bot/Economy/BotImprovementPolicy');
            if (proposal.kind === 'enchant') {
                const Rules = invoke('GameServer/Items/C4EnchantRules');
                const item = one('SELECT * FROM items WHERE id = ? AND characterId = ?', [proposal.objectId, characterId]);
                const scroll = Rules.resolveScroll(proposal.scrollId), config = Rules.configWith(globalThis.options?.default?.Enchant);
                if (!item || item.selfId !== proposal.itemId || Number(item.enchant) !== proposal.from
                    || !Rules.validTarget(Policy.adapter(item), scroll)) throw Error('improvement_source_changed');
                const category = Rules.categoryOf(Policy.adapter(item)), max = Rules.maxFor(category, config);
                if (max && item.enchant >= max || scroll.scrollType === 'blessed' && Rules.isSafe(Policy.adapter(item), item.enchant, config)) throw Error('invalid_bot_enchant');
                const chance = Rules.isSafe(Policy.adapter(item), item.enchant, config) ? 1 : Rules.chanceFor(category, scroll.scrollType, config) / 100;
                const success = rng() < chance;
                consume(proposal.scrollId, 1);
                result = success ? 'success' : scroll.scrollType === 'blessed' ? 'blessed-fail' : 'break';
                if (result !== 'break') mutate('UPDATE items SET enchant = ? WHERE id = ? AND characterId = ?', [success ? item.enchant + 1 : 0, item.id, characterId]);
                else {
                    mutate('DELETE FROM items WHERE id = ? AND characterId = ?', [item.id, characterId]);
                    const crystalId = Rules.CRYSTAL_IDS[Rules.gradeOf(Policy.adapter(item))];
                    const amount = Math.max(1, Rules.crystalCount(Policy.adapter(item), item.enchant)
                        - Math.floor((Policy.adapter(item).fetchCristals() + 1) / 2));
                    const held = one('SELECT id FROM items WHERE characterId = ? AND selfId = ? ORDER BY id LIMIT 1', [characterId, crystalId]);
                    if (held) mutate('UPDATE items SET amount = amount + ? WHERE id = ?', [amount, held.id]);
                    else mutate('INSERT INTO items(selfId,name,amount,characterId) VALUES(?,?,?,?)', [crystalId, `Crystal ${crystalId}`, amount, characterId]);
                    changedIds.push(crystalId);
                }
                changedIds.push(item.selfId, proposal.scrollId);
            } else if (proposal.kind === 'sa') {
                const SA = invoke('GameServer/Items/C4WeaponSAExchange');
                const recipe = SA.resolve(proposal.npcId, proposal.recipeId);
                const item = one('SELECT * FROM items WHERE id = ? AND characterId = ?', [proposal.objectId, characterId]);
                if (recipe?.station !== 'blacksmith' || recipe.operation !== 'install' || !item || item.amount !== 1
                    || recipe.sourceId !== item.selfId || item.selfId !== proposal.itemId
                    || item.enchant !== proposal.from) throw Error('improvement_source_changed');
                const product = invoke('GameServer/DataCache').items.find(row => row.selfId === recipe.productId);
                if (!product) throw Error('improvement_missing_template');
                for (const cost of SA.costs(recipe)) { consume(cost.selfId, cost.amount); changedIds.push(cost.selfId); }
                mutate('UPDATE items SET selfId = ?, name = ?, slot = ? WHERE id = ? AND characterId = ?',
                    [product.selfId, product.template.name, product.etc.slot, item.id, characterId]);
                changedIds.push(item.selfId, product.selfId); result = 'sa';
            } else if (proposal.kind === 'crystal_quest') {
                const character = one('SELECT level FROM characters WHERE id = ?', [characterId]);
                if (character?.level < 40 || ![4629,4640,4651].includes(proposal.starterId)) throw Error('invalid_bot_crystal_quest');
                const Native = invoke('GameServer/Items/SoulCrystalProgression');
                const held = all(`SELECT * FROM items WHERE characterId = ? AND selfId IN (${[...Native.crystalIds,4662,4663,4664].map(() => '?').join(',')}) AND amount > 0`,
                    [characterId,...Native.crystalIds,4662,4663,4664]);
                if (held.length > 1 || held[0]?.amount > 1) throw Error('soul_crystal_resonance');
                mutate(`INSERT INTO character_quests(characterId,questId,state,variables) VALUES(?,350,'started','{"cond":"1"}')
                    ON CONFLICT(characterId,questId) DO UPDATE SET state='started',variables=excluded.variables`, [characterId]);
                if (!held.length || [4662,4663,4664].includes(held[0].selfId)) {
                    if (held[0]) { consume(held[0].selfId, 1); changedIds.push(held[0].selfId); }
                    const source = invoke('GameServer/DataCache').items.find(row => row.selfId === proposal.starterId);
                    mutate('INSERT INTO items(selfId,name,amount,characterId) VALUES(?,?,1,?)', [source.selfId,source.template.name,characterId]);
                    changedIds.push(proposal.starterId);
                }
                result = 'crystal_quest';
            } else if (proposal.kind === 'henna') {
                const Henna = invoke('GameServer/Henna/HennaRules');
                const character = one('SELECT classId FROM characters WHERE id = ?', [characterId]);
                const symbol = Henna.availableForClass(character?.classId).find(row => row.id === proposal.symbolId);
                const rows = all('SELECT slot, symbolId FROM character_hennas WHERE characterId = ?', [characterId]);
                const slot = [1,2,3].find(value => !rows.some(row => row.slot === value));
                if (!symbol || !slot || rows.length >= Henna.slotsForClass(character.classId)) throw Error('invalid_bot_henna');
                consume(symbol.dyeSelfId, symbol.dyeAmount); consume(57, symbol.price);
                mutate('INSERT INTO character_hennas(characterId,slot,symbolId) VALUES(?,?,?)', [characterId, slot, symbol.id]);
                hennas = [null,null,null]; for (const row of [...rows, {slot,symbolId:symbol.id}]) hennas[row.slot - 1] = row.symbolId;
                changedIds.push(57, symbol.dyeSelfId); result = 'henna';
            } else throw Error('invalid_bot_improvement');
            guard();
            if (state) {
                const current = one('SELECT statsJson FROM bot_life_state WHERE characterId = ?', [characterId]);
                const stats = jsonObject(current.statsJson);
                stats.lastImprovement = { kind: proposal.kind, result, at: now(), objectId: proposal.objectId || null };
                if (hennas) stats.hennas = hennas;
                if (result === 'crystal_quest') stats.soulCrystalQuest = true;
                if (result === 'break' || result === 'blessed-fail') {
                    const lossHours = Number(proposal.lossHours || 0);
                    stats.frustration = Number(stats.frustration || 0) + (Number.isFinite(lossHours) ? Math.max(0, lossHours) : 0);
                    stats.dormantWishes = [[proposal.key || 'enchant', result, 0, Number(proposal.price || 0), Number(stats.playedHours || 0), 0.5], ...(stats.dormantWishes || [])].slice(0,4);
                    stats.wishFocus = null;
                }
                mutate('UPDATE bot_life_state SET statsJson = ? WHERE characterId = ?', [JSON.stringify(stats), characterId]);
            }
            const coldLifeRow = syncEconomySnapshotUnsafe(characterId, state, changedIds);
            return { result, coldLifeRow, hennas, questStarted: result === 'crystal_quest', changedIds, items: all('SELECT * FROM items WHERE characterId = ? ORDER BY id', [characterId]) };
        }, 'bot:improvement'));
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

    craftForCustomer(crafterId, customerId, { materials, product, crafterMp, price, adena, clanCraft = null, clanOrder = null, workshop = null,
        economyCommand = null, funding = {}, random = Math.random }) {
        return withCharacterFlushes([crafterId, customerId], () => inTransaction(() => {
            const step = economyStepUnsafe(customerId, economyCommand, EconomyCommit.KINDS.craft);
            if (step?.replay) return { ...step.replay, customerState: step.replay.coldLifeRow,
                crafterState: normalizeRow(one('SELECT * FROM bot_life_state WHERE characterId=?', [crafterId])) };
            if (step && (!workshop || clanCraft || clanOrder)) throw Error('craft_executor_changed');
            let success = !!product;
            let clanCrafter = null;
            let workshopCrafter = null;
            if (workshop) {
                const recipes = invoke('GameServer/Items/C4RecipeItems');
                const rules = invoke('GameServer/Bot/Economy/CraftShopService');
                const recipe = recipes.resolveByRecipeId(workshop.recipeId);
                const batches = Number(workshop.batches);
                if (clanCraft || clanOrder || Number(crafterId) === Number(customerId) || !recipe
                    || !Number.isSafeInteger(batches) || batches <= 0 || batches > 64) throw new Error('invalid workshop craft');
                const rows = all(`SELECT life.*, members.id AS characterId, members.clanId, members.classId, members.level AS characterLevel,
                           members.hp AS physicalHp, members.locX AS physicalX, members.locY AS physicalY
                    FROM characters members LEFT JOIN bot_life_state life ON members.id = life.characterId
                    WHERE members.id IN (?, ?)`, [crafterId, customerId]);
                workshopCrafter = rows.find(row => Number(row.characterId) === Number(crafterId));
                const customer = rows.find(row => Number(row.characterId) === Number(customerId));
                for (const [row, revision] of [[workshopCrafter, workshop.crafterRevision], [customer, workshop.customerRevision]]) {
                    if (row === customer && !row?.phase) {
                        if (!row || Number(row.physicalHp) <= 0) throw new Error('customer unavailable');
                        continue;
                    }
                    if (!row || (row === customer && step ? row.phase !== step.row.phase : row.phase !== 'cold')
                        || row.simulationOwner !== LEGACY_SIMULATION_OWNER
                        || row.simulationLeaseId || row.partyId || Number(row.phase === 'hot' ? row.physicalHp : row.hp) <= 0
                        || ['dead', 'respawning', 'traveling'].includes(row.activity)
                        || Number(row.simulationRevision) !== Number(revision)) throw new Error('workshop ownership changed');
                }
                if (customer.phase && !step) throw Error('workshop_command_missing');
                const stats = jsonObject(workshopCrafter.statsJson);
                const entry = stats.workshop?.entries?.find(row => Number(row.recipeId) === Number(recipe.recipeId));
                if (!entry || Number(entry.price) !== Number(workshop.entryPrice)
                    || !rules.canCraft({ classId: workshopCrafter.classId, level: workshopCrafter.characterLevel }, recipe)
                    || !one('SELECT recipeId FROM character_recipes WHERE characterId = ? AND recipeId = ?', [crafterId, recipe.recipeId])
                    || Number(workshopCrafter.mp) < Number(recipe.mpCost) * batches
                    || Math.hypot(Number(customer.phase === 'cold' ? customer.locX : customer.physicalX) - Number(workshopCrafter.locX),
                        Number(customer.phase === 'cold' ? customer.locY : customer.physicalY) - Number(workshopCrafter.locY)) > 1200) {
                    throw new Error('workshop unavailable');
                }
                const stateOf = row => ({ characterId: Number(row.characterId), clanId: Number(row.clanId),
                    stats: jsonObject(row.statsJson) });
                const quote = invoke('GameServer/Bot/Economy/CraftWorkshopService').quote(stateOf(workshopCrafter), stateOf(customer), recipe.recipeId);
                if (!quote || Number(price) !== quote.price * batches || Number(workshop.fee) !== Number(price)
                    || !Number.isSafeInteger(Number(price)) || Number(price) < 0) throw new Error('workshop price changed');
                const required = new Map();
                for (const input of recipe.materials) required.set(Number(input.selfId),
                    Number(required.get(Number(input.selfId)) || 0) + Number(input.amount) * batches);
                const supplied = new Map();
                const ids = new Set();
                for (const material of materials) {
                    if (ids.has(Number(material.id)) || !Number.isSafeInteger(Number(material.amount)) || Number(material.amount) <= 0) {
                        throw new Error('invalid workshop material');
                    }
                    ids.add(Number(material.id));
                    supplied.set(Number(material.selfId), Number(supplied.get(Number(material.selfId)) || 0) + Number(material.amount));
                }
                if (required.size !== supplied.size || [...required].some(([id, amount]) => supplied.get(id) !== amount)
                    || product && (Number(product.selfId) !== Number(recipe.productId)
                        || Number(product.amount) !== Number(recipe.productCount) * batches)) throw new Error('workshop recipe changed');
                if (step) {
                    for (const [id, amount] of required) checkEconomyMaterialProtectionUnsafe(customerId, step, id, amount);
                    checkEconomyFundingUnsafe(customerId, step, Number(price), { ...funding, itemId: Number(recipe.productId) });
                    const template = require('./GameServer/Item/ItemTemplateIndex').find(invoke('GameServer/DataCache').items, Number(recipe.productId));
                    if (!product || !template || !!product.stackable !== !!template.etc?.stackable
                        || Number(product.slot || 0) !== Number(template.etc?.slot || 0)) throw Error('craft_product_template_changed');
                }
                crafterMp = Number(workshopCrafter.mp) - Number(recipe.mpCost) * batches;
            }
            let manualOrder = null;
            if (clanOrder) {
                manualOrder = playerClanCraftOrderUnsafe(clanCraft?.clanId, clanOrder.orderId, clanOrder.settings);
                if (!clanCraft || !manualOrder) {
                    throw new Error('clan craft order changed');
                }
                const recipe = invoke('GameServer/Items/C4RecipeItems').resolveByRecipeId(clanCraft.recipeId);
                if (clanOrder.final && Number(recipe?.productId) !== Number(manualOrder.itemId)) throw new Error('clan craft target changed');
                if (clanOrder.final) {
                    const stock = Number(one('SELECT COALESCE(SUM(amount), 0) AS amount FROM clan_warehouse_items WHERE clanId = ? AND selfId = ?',
                        [manualOrder.clanId, manualOrder.itemId]).amount);
                    const delivered = Number(one(`SELECT COALESCE(SUM(amount), 0) AS amount FROM clan_warehouse_ledger
                        WHERE clanId = ? AND selfId = ? AND operation = 'withdraw' AND resolveKey LIKE ?`,
                    [manualOrder.clanId, manualOrder.itemId, `player-order:${manualOrder.id}:delivery:%`]).amount);
                    if (stock + delivered >= Number(manualOrder.amount)) throw new Error('clan craft quantity already reached');
                }
            }
            if (clanCraft) {
                const recipes = invoke('GameServer/Items/C4RecipeItems');
                const recipe = recipes.resolveByRecipeId(clanCraft.recipeId);
                const craftRules = invoke('GameServer/Bot/Economy/CraftShopService');
                const rows = all(`SELECT life.*, members.clanId, members.classId, members.level AS characterLevel
                    FROM bot_life_state life JOIN characters members ON members.id = life.characterId
                    WHERE life.characterId IN (?, ?)`, [crafterId, customerId]);
                clanCrafter = rows.find(row => Number(row.characterId) === Number(crafterId));
                const customer = rows.find(row => Number(row.characterId) === Number(customerId));
                for (const [row, revision] of [[clanCrafter, clanCraft.crafterRevision], [customer, clanCraft.customerRevision]]) {
                    if (!row || Number(row.clanId) !== Number(clanCraft.clanId) || row.phase !== 'cold'
                        || row.simulationOwner !== LEGACY_SIMULATION_OWNER || row.partyId
                        || Number(row.simulationRevision) !== Number(revision)) throw new Error('clan craft ownership changed');
                }
                if (!recipe || Number(clanCrafter.hp) <= 0 || Number(customer.hp) <= 0
                    || ['dead', 'respawning'].includes(clanCrafter.activity)
                    || !craftRules.canCraft({ classId: clanCrafter.classId, level: clanCrafter.characterLevel }, recipe)
                    || Number(clanCrafter.mp) < Number(clanCraft.mpCost)
                    || Math.hypot(Number(customer.locX) - Number(clanCrafter.locX), Number(customer.locY) - Number(clanCrafter.locY)) > 1200) {
                    throw new Error('clan crafter unavailable');
                }
                const known = one('SELECT recipeId FROM character_recipes WHERE characterId = ? AND recipeId = ?', [crafterId, recipe.recipeId]);
                if (!known) {
                    if (!clanCraft.learning) throw new Error('clan recipe not learned');
                    const recipeAmount = recipe.materials.filter(item => Number(item.selfId) === Number(recipe.recipeItemId))
                        .reduce((sum, item) => sum + Number(item.amount), 0);
                    if (materials.filter(item => Number(item.selfId) === Number(recipe.recipeItemId))
                        .reduce((sum, item) => sum + Number(item.amount), 0) < recipeAmount + 1) throw new Error('clan learning scroll missing');
                    write(UPSERT_RECIPE, [crafterId, recipe.recipeId, recipe.type]);
                } else if (clanCraft.learning) throw new Error('clan recipe knowledge changed');
                crafterMp = Number(clanCrafter.mp) - Number(clanCraft.mpCost);
            }
            const sources = [];
            for (const material of [...materials].sort((left, right) => Number(left.id) - Number(right.id))) {
                const source = one('SELECT id, selfId, amount, equipped FROM items WHERE id = ? AND characterId = ?', [material.id, customerId]);
                if (!source || workshop && source.equipped || Number(source.selfId) !== Number(material.selfId) || Number(source.amount) < Number(material.amount)) throw new Error('customer craft material changed');
                sources.push({ id: Number(source.id), amount: Number(source.amount) - Number(material.amount) });
                if (Diagnostics.active()) stageNativeDiagnostic(customerId, null, 'craft_material', 'validated',
                    { item: Number(material.selfId), nativeId: Number(source.id), recipeId: Number(clanCraft?.recipeId || 0), owned: Number(source.amount), requested: Number(material.amount) });
            }
            const fee = Number(price) || 0;
            const customerAdena = fee > 0 ? one('SELECT id, amount FROM items WHERE characterId = ? AND selfId = 57 ORDER BY id LIMIT 1', [customerId]) : null;
            if (fee > 0 && (!customerAdena || Number(customerAdena.amount) < fee)) throw new Error('customer adena changed');
            let crafterAdena = fee > 0 ? one('SELECT id, amount FROM items WHERE characterId = ? AND selfId = 57 ORDER BY id LIMIT 1', [crafterId]) : null;
            // One native roll after validated physical inputs and fees;
            // the saved completion returns before every mutable quote check.
            if (step) {
                const recipe = invoke('GameServer/Items/C4RecipeItems').resolveByRecipeId(workshop.recipeId);
                success = recipe.successRate >= 100 || Number(random()) * 100 < recipe.successRate;
                if (!success) product = null;
            }
            const warehouseOutput = !!manualOrder && clanOrder.final === true;
            const target = product?.stackable ? warehouseOutput
                ? one('SELECT id, amount FROM clan_warehouse_items WHERE clanId = ? AND selfId = ? AND enchant = 0 ORDER BY id LIMIT 1', [manualOrder.clanId, product.selfId])
                : one('SELECT id, amount FROM items WHERE characterId = ? AND selfId = ? ORDER BY id LIMIT 1', [customerId, product.selfId]) : null;
            let productId = Number(target?.id || 0);
            const productAmount = Number(target?.amount || 0) + Number(product?.amount || 0);
            if (!Number.isSafeInteger(productAmount) || productAmount < 0) throw Error('craft_product_overflow');
            sources.forEach((source) => source.amount <= 0 ? write('DELETE FROM items WHERE id = ? AND characterId = ?', [source.id, customerId]) : write('UPDATE items SET amount = ? WHERE id = ? AND characterId = ?', [source.amount, source.id, customerId]));
            if (warehouseOutput && product) {
                if (target) write('UPDATE clan_warehouse_items SET amount = ?, updatedAt = ? WHERE id = ? AND clanId = ?', [productAmount, now(), productId, manualOrder.clanId]);
                else productId = write(`INSERT INTO clan_warehouse_items
                    (clanId, selfId, name, kind, amount, enchant, reservedAmount, createdAt, updatedAt)
                    VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)`, [manualOrder.clanId, product.selfId, product.name, product.kind || '', product.amount, now(), now()]).insertId;
                const simulation = one('SELECT stateJson FROM clan_simulation_clans WHERE clanId = ?', [manualOrder.clanId]);
                const state = jsonObject(simulation?.stateJson);
                state.warehouseRevision = Number(state.warehouseRevision || 0) + 1;
                state.updatedAt = now();
                write('UPDATE clan_simulation_clans SET stateJson = ?, updatedAt = ? WHERE clanId = ?', [JSON.stringify(state), state.updatedAt, manualOrder.clanId]);
            } else if (target) write('UPDATE items SET amount = ? WHERE id = ? AND characterId = ?', [productAmount, productId, customerId]);
            else if (product) {
                for (let index = 0; index < (product.stackable ? 1 : Number(product.amount)); index++) {
                    const id = write('INSERT INTO items (selfId, name, amount, equipped, slot, characterId) VALUES (?, ?, ?, 0, ?, ?)',
                        [product.selfId, product.name || '', product.stackable ? product.amount : 1, product.slot || 0, customerId]).insertId;
                    if (!productId) productId = id;
                }
            }
            if (manualOrder) {
                const eventId = recordClanGoalEventUnsafe({ clanId: manualOrder.clanId,
                    eventType: product ? 'player_order_crafted' : 'player_order_craft_failed', plan: 'craft',
                    reasonCode: product ? 'clan_craft_success' : 'clan_craft_failure',
                    payloadJson: JSON.stringify({ orderId: manualOrder.id, recipeId: clanCraft.recipeId, crafterId, customerId,
                        final: clanOrder.final, amount: Number(product?.amount || 0) }), occurredAt: now() });
                // A real craft supersedes the delayed review of the same
                // manual goal; keep one execution chain rather than adding a
                // polling chain for every component in the recipe tree.
                write(`UPDATE clan_actions SET status = 'cancelled', reasonCode = 'clan_craft_progress',
                    updatedAt = ?, resolvedAt = ? WHERE clanId = ? AND actionType = 'goal_plan' AND status = 'pending'`,
                [now(), now(), manualOrder.clanId]);
                archiveFinishedClanActionsUnsafe(manualOrder.clanId);
                insertClanActionUnsafe({
                    clanId: manualOrder.clanId,
                    actionKey: `clan:${manualOrder.clanId}:order:${manualOrder.id}:craft:${eventId}`,
                    actionType: 'goal_plan',
                    availableAt: now(),
                    payload: { orderId: manualOrder.id, reason: 'clan_craft_progress' },
                    reasonCode: 'clan_craft_progress',
                    createdAt: now()
                });
            }
            let nextCrafterAdena = null;
            if (fee > 0) {
                write('UPDATE items SET amount = ? WHERE id = ? AND characterId = ?', [Number(customerAdena.amount) - fee, customerAdena.id, customerId]);
                if (crafterAdena) {
                    nextCrafterAdena = Number(crafterAdena.amount) + fee;
                    if (!Number.isSafeInteger(nextCrafterAdena)) throw Error('craft_fee_overflow');
                    write('UPDATE items SET amount = ? WHERE id = ? AND characterId = ?', [nextCrafterAdena, crafterAdena.id, crafterId]);
                } else {
                    const id = write('INSERT INTO items (selfId, name, amount, equipped, slot, characterId) VALUES (57, ?, ?, 0, 0, ?)', [adena?.name || 'Adena', fee, crafterId]).insertId;
                    nextCrafterAdena = fee;
                    crafterAdena = { id, amount: 0 };
                }
            }
            write('UPDATE characters SET mp = ? WHERE id = ?', [crafterMp, crafterId]);
            let clanStates = {};
            if (clanCraft || workshop) {
                const lifeState = invoke('GameServer/Bot/Population/BotLifeState');
                for (const id of new Set([Number(crafterId), Number(customerId)])) {
                    const inventory = id === Number(customerId) || workshop
                        ? lifeState.inventorySummaryFromItems(all('SELECT * FROM items WHERE characterId = ? AND amount > 0', [id]))
                        : JSON.parse(clanCrafter.inventorySummary || '{}');
                    write(`UPDATE bot_life_state SET inventorySummary = ?, simulationRevision = simulationRevision + 1,
                        statsJson = json_set(statsJson, '$.clanInventoryRevision', simulationRevision + 1),
                        mp = CASE WHEN characterId = ? THEN ? ELSE mp END, updatedAt = ? WHERE characterId = ?`,
                    [JSON.stringify(inventory), crafterId, crafterMp, now(), id]);
                }
                if (workshop) {
                    const production = { ...jsonObject(workshopCrafter.statsJson).production };
                    production.crafts = Number(production.crafts || 0) + Number(workshop.batches);
                    production.customers = Number(production.customers || 0) + 1;
                    production.revenue = Number(production.revenue || 0) + fee;
                    production.lastRecipeId = Number(workshop.recipeId);
                    production.at = now();
                    const shop = { ...jsonObject(workshopCrafter.statsJson).workshop };
                    shop.entries = shop.entries.map(entry => Number(entry.recipeId) !== Number(workshop.recipeId) ? entry
                        : { ...entry, fills: Number(entry.fills || 0) + Number(workshop.batches),
                            earned: Number(entry.earned || 0) + fee });
                    write("UPDATE bot_life_state SET statsJson = json_set(statsJson, '$.production', json(?), '$.workshop', json(?)) WHERE characterId = ?",
                        [JSON.stringify(production), JSON.stringify(shop), crafterId]);
                }
                clanStates = {
                    crafterState: normalizeRow(one('SELECT * FROM bot_life_state WHERE characterId = ?', [crafterId])),
                    customerState: normalizeRow(one('SELECT * FROM bot_life_state WHERE characterId = ?', [customerId]))
                };
            }
            const receipt = step ? { committed: true, success, units: Number(product?.amount || 0), spent: fee,
                nativeId: Number(workshop.recipeId), mp: crafterMp } : {};
            if (step) {
                // Earlier workshop accounting also fences the customer. Complete
                // against that current row, without restoring its older bag.
                step.row = one('SELECT * FROM bot_life_state WHERE characterId=?', [customerId]);
                clanStates.customerState = completeEconomyStepUnsafe(customerId, step, receipt,
                    [...materials.map(row => Number(row.selfId)), ...(product ? [Number(product.selfId)] : [])]);
                receipt.economyCommit = jsonObject(clanStates.customerState.statsJson).economyCommit;
            }
            return { ...clanStates, ...receipt, sources, product: product ? { id: productId, amount: productAmount } : null, customerAdena: fee > 0 ? { id: Number(customerAdena.id), amount: Number(customerAdena.amount) - fee } : null, crafterAdena: fee > 0 ? { id: Number(crafterAdena.id), amount: nextCrafterAdena } : null };
        }, 'craft:customer'));
    },

    savePetState(characterId, id, state) {
        return withCharacterFlush(characterId, () => inTransaction(() => {
            const item = one('SELECT petData FROM items WHERE id = ? AND characterId = ?', [id, characterId]);
            if (!item) throw new Error('Pet control item no longer owned');
            const previous = item.petData ? JSON.parse(item.petData) : {};
            const next = { ...previous, ...state, inventory: previous.inventory || [] };
            write('UPDATE items SET petData = ? WHERE id = ? AND characterId = ?', [JSON.stringify(next), id, characterId]);
            return next;
        }, 'pet:state'));
    },

    transferPetInventory(characterId, controlId, command) {
        return withCharacterFlush(characterId, () => inTransaction(() => {
            const collar = one('SELECT selfId, petData FROM items WHERE id = ? AND characterId = ?', [controlId, characterId]);
            if (!collar || !require('./GameServer/Pets/PetRules').TYPES[collar.selfId]) throw new Error('Pet control item no longer owned');
            const state = collar.petData ? JSON.parse(collar.petData) : {};
            if (state.expired || state.dead) throw new Error('Pet inventory unavailable');
            const inventory = state.inventory || [];
            const amount = Number(command.amount);
            if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 2147483647) throw new Error('Invalid pet item amount');
            let playerItem = null;
            if (command.direction === 'deposit') {
                const source = one('SELECT * FROM items WHERE id = ? AND characterId = ?', [command.itemId, characterId]);
                if (!source || source.id === controlId || source.equipped || source.amount < amount || source.petData || require('./GameServer/Pets/PetRules').TYPES[source.selfId]) throw new Error('Item cannot be given to a pet');
                const target = command.stackable ? inventory.find(item => item.selfId === source.selfId && !item.equipped) : null;
                if (target) {
                    if (target.amount + amount > 2147483647) throw new Error('Pet stack overflow');
                    target.amount += amount;
                } else {
                    if (inventory.length >= 80) throw new Error('Pet inventory is full');
                    // Reserve an object ID in the same AUTOINCREMENT namespace as player items.
                    const id = Number(write('INSERT INTO items(selfId, name, amount, characterId) VALUES (?, ?, 0, ?)', [source.selfId, source.name, characterId]).insertId);
                    write('DELETE FROM items WHERE id = ?', [id]);
                    inventory.push({ id, selfId: source.selfId, name: source.name, enchant: source.enchant, amount, equipped: false });
                }
                playerItem = { ...source, amount: source.amount - amount };
                if (playerItem.amount) write('UPDATE items SET amount = ? WHERE id = ? AND characterId = ?', [playerItem.amount, source.id, characterId]);
                else write('DELETE FROM items WHERE id = ? AND characterId = ?', [source.id, characterId]);
            } else {
                const source = inventory.find(item => item.id === command.itemId);
                if (!source || source.amount < amount) throw new Error('Pet item changed');
                if (command.direction === 'equip') {
                    for (const item of inventory) if (command.equipIds.includes(item.selfId)) item.equipped = false;
                    source.equipped = !!command.equipped;
                } else {
                    if (source.equipped) throw new Error('Unequip the pet item first');
                    if (command.direction === 'withdraw') {
                        const target = command.stackable ? one('SELECT * FROM items WHERE characterId = ? AND selfId = ? AND petData IS NULL ORDER BY id LIMIT 1', [characterId, source.selfId]) : null;
                        if (target && target.amount + amount > 2147483647) throw new Error('Inventory stack overflow');
                        const id = target?.id || Number(write('INSERT INTO items(selfId, name, amount, enchant, characterId) VALUES (?, ?, ?, ?, ?)', [source.selfId, source.name, amount, source.enchant || 0, characterId]).insertId);
                        if (target) write('UPDATE items SET amount = ? WHERE id = ?', [target.amount + amount, id]);
                        playerItem = { ...source, id, amount: (target?.amount || 0) + amount, equipped: false };
                    } else if (command.direction !== 'consume') throw new Error('Unknown pet inventory command');
                    source.amount -= amount;
                }
            }
            state.inventory = inventory.filter(item => item.amount > 0);
            write('UPDATE items SET petData = ? WHERE id = ? AND characterId = ?', [JSON.stringify(state), controlId, characterId]);
            return { inventory: state.inventory, playerItem };
        }, 'pet:inventory'));
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
            const nextGoal = goal ? { ...goal, orderId, orderRevision: revision, controlledBy: 'player', updatedAt: timestamp,
                ...(strategy === 'craft' ? { goalKey: `player-order:${orderId}:craft` } : {}) } : null;
            const state = simulationState(previousState, clan, simulation.leaderId, previousState.memberIds || [], timestamp);
            state.goal = nextGoal;
            state.updatedAt = timestamp;
            write('UPDATE clan_simulation_clans SET updatedAt = ?, stateJson = ? WHERE clanId = ?', [timestamp, JSON.stringify(state), clan]);
            if (actionType && (orderStatus === 'active' || orderStatus === 'blocked' && strategy === 'craft')) {
                insertClanActionUnsafe({
                    clanId: clan, actionKey: `clan:${clan}:order:${orderId}:r${revision}:${String(actionType)}`,
                    actionType: String(actionType), availableAt: timestamp,
                    payload: { orderId, orderRevision: revision, reason: 'player_order_created' },
                    reasonCode: 'player_order_created', createdAt: timestamp
                });
            } else if (orderStatus === 'completed') {
                insertClanActionUnsafe({
                    clanId: clan, actionKey: `clan:${clan}:order:${orderId}:r${revision}:automatic`,
                    actionType: 'goal_plan', availableAt: timestamp,
                    payload: { orderId, orderRevision: revision, reason: 'player_order_completed', control: 'automatic' },
                    reasonCode: 'player_order_completed', createdAt: timestamp
                });
            }
            recordClanGoalEventUnsafe({
                clanId: clan, eventType: 'player_order_created', goalType: 'item', plan: String(nextGoal?.plan?.kind || ''),
                reasonCode: String(nextGoal?.plan?.reasonCode || ''),
                payloadJson: JSON.stringify({ orderId, revision, itemId: item, itemName: String(itemName), amount: required, strategy: String(strategy) }),
                occurredAt: timestamp
            });
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
        reasonCode = '',
        changes = null
    } = {}) {
        const clan = Number(clanId);
        const id = Number(orderId);
        const action = String(transition || '');
        if (!clan || !id || !['pause', 'resume', 'replan', 'cancel', 'edit'].includes(action)) {
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
            if (action === 'edit') {
                if (expectedRevision === null || !changes || Number(changes.itemId) !== Number(order.itemId)) {
                    return { ok: false, code: 'invalid_clan_order_edit' };
                }
                const members = [...new Set((changes.memberIds || []).map(Number))];
                if (!members.length) return { ok: false, code: 'invalid_clan_order_members' };
                const placeholders = members.map(() => '?').join(', ');
                const rows = all(`SELECT c.id, c.clanId, c.username, life.accountName, life.statsJson
                    FROM characters c LEFT JOIN bot_life_state life ON life.characterId = c.id
                    WHERE c.id IN (${placeholders})`, members);
                if (rows.length !== members.length || rows.some((member) => Number(member.clanId) !== clan || !generatedBotRow(member))) {
                    return { ok: false, code: 'invalid_clan_order_members' };
                }
                if (Number(changes.budget) > 0 && Number(changes.budget) < Number(order.spent)) {
                    return { ok: false, code: 'clan_order_budget_below_spent' };
                }
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
                status = nextGoal.status === 'completed' ? 'completed'
                    : action === 'edit' && order.status === 'paused' ? 'paused'
                        : nextGoal.status === 'blocked' ? 'blocked' : 'active';
                if (status === 'paused') nextGoal.status = 'paused';
            }
            if (action === 'edit') {
                write(`UPDATE clan_orders SET amount = ?, strategy = ?, maxUnitPrice = ?, budget = ?, memberIdsJson = ?
                    WHERE id = ? AND clanId = ?`, [
                    changes.amount, changes.strategy, changes.maxUnitPrice, changes.budget,
                    JSON.stringify(changes.memberIds), id, clan
                ]);
            }
            state.goal = nextGoal;
            state.updatedAt = timestamp;
            write('UPDATE clan_simulation_clans SET updatedAt = ?, stateJson = ? WHERE clanId = ?', [timestamp, JSON.stringify(state), clan]);
            write(`UPDATE clan_orders SET revision = ?, status = ?, planJson = ?, reasonCode = ?,
                    updatedAt = ?, resolvedAt = ? WHERE id = ? AND clanId = ?`, [
                revision, status, JSON.stringify(nextGoal?.plan || {}), String(reasonCode || nextGoal?.plan?.reasonCode || ''),
                timestamp, ['completed', 'cancelled'].includes(status) ? timestamp : null, id, clan
            ]);
            if (actionType && (status === 'active' || status === 'blocked' && nextGoal?.policy?.strategy === 'craft')) {
                insertClanActionUnsafe({
                    clanId: clan, actionKey: `clan:${clan}:order:${id}:r${revision}:${String(actionType)}`,
                    actionType: String(actionType), availableAt: timestamp,
                    payload: { orderId: id, orderRevision: revision, reason: `player_order_${action}` },
                    reasonCode: `player_order_${action}`, createdAt: timestamp
                });
            } else if (action === 'cancel' || status === 'completed') {
                insertClanActionUnsafe({
                    clanId: clan, actionKey: `clan:${clan}:order:${id}:r${revision}:automatic`,
                    actionType: 'goal_plan', availableAt: timestamp,
                    payload: { orderId: id, orderRevision: revision, reason: status === 'completed' ? 'player_order_completed' : 'player_order_cancelled', control: 'automatic' },
                    reasonCode: status === 'completed' ? 'player_order_completed' : 'player_order_cancelled', createdAt: timestamp
                });
            }
            recordClanGoalEventUnsafe({
                clanId: clan, eventType: `player_order_${action}`, goalType: 'item', plan: String(nextGoal?.plan?.kind || ''),
                reasonCode: String(reasonCode || `player_order_${action}`),
                payloadJson: JSON.stringify({ orderId: id, revision, status }), occurredAt: timestamp
            });
            return { ok: true, order: playerManagedOrderRow(one('SELECT * FROM clan_orders WHERE id = ?', [id])), goal: nextGoal };
        }, `clan-order:${action}`);
    },
    updatePlayerManagedClanOrderProgress({ clanId, orderId, expectedRevision = null, goal, spentDelta = 0, reasonCode = '' } = {}) {
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
            if (expectedRevision !== null && Number(order.revision) !== Number(expectedRevision)) {
                return { ok: false, code: 'clan_order_revision_conflict', revision: Number(order.revision) };
            }
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
                archiveFinishedClanActionsUnsafe(clan);
                write(`UPDATE clan_market_demands SET status = 'fulfilled', updatedAt = ?
                    WHERE clanId = ? AND status = 'open'`, [timestamp, clan]);
                insertClanActionUnsafe({
                    clanId: clan, actionKey: `clan:${clan}:order:${id}:r${revision}:automatic`,
                    actionType: 'goal_plan', availableAt: timestamp,
                    payload: { orderId: id, orderRevision: revision, reason: 'player_order_completed', control: 'automatic' },
                    reasonCode: 'player_order_completed', createdAt: timestamp
                });
            }
            if (completed || reasonCode) {
                recordClanGoalEventUnsafe({
                    clanId: clan, eventType: completed ? 'player_order_completed' : 'player_order_progress', goalType: 'item',
                    plan: String(nextGoal.plan?.kind || ''),
                    reasonCode: String(reasonCode || (completed ? 'goal_completed' : 'goal_progress')),
                    payloadJson: JSON.stringify({ orderId: id, revision, progress: Number(nextGoal.progress), required: Number(nextGoal.required) }),
                    occurredAt: timestamp
                });
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
            const existing = clanActionUnsafe('actionKey', key);
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
            const inserted = insertClanActionUnsafe({
                clanId: clan,
                actionKey: key,
                actionType: type,
                priority: Math.floor(Number(priority) || 0),
                availableAt: dueAt,
                payload: payload && typeof payload === 'object' ? payload : {},
                createdAt: timestamp
            });
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
            // One priority point per ready minute prevents fresh planning work
            // from indefinitely starving supplies and progression actions.
            const pending = one(`SELECT * FROM clan_actions
                WHERE status = 'pending' AND availableAt <= ?
                ORDER BY priority + CAST(MAX(0, ? - availableAt) / 60000 AS INTEGER) DESC,
                    availableAt ASC, id ASC LIMIT 1`, [timestamp, timestamp]);
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
            const action = clanActionUnsafe('id', id);
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
            const action = clanActionUnsafe('id', id);
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
            recordClanGoalEventUnsafe({
                clanId: Number(action.clanId),
                eventType: `action_${nextStatus}`,
                plan: String(action.actionType || ''),
                reasonCode: String(reasonCode || ''),
                payloadJson: JSON.stringify({ actionId: id, actionKey: action.actionKey, result: safeResult }),
                occurredAt: timestamp
            });
            const resolved = one('SELECT * FROM clan_actions WHERE id = ?', [id]);
            archiveFinishedClanActionsUnsafe(action.clanId);
            return {
                ok: true,
                actionId: id,
                status: nextStatus,
                action: resolved
            };
        }, 'clan-action:resolve');
    },
    fetchClanActions({ clanId = null, status = null, limit = 50 } = {}) {
        const clauses = [];
        const params = [];
        if (clanId !== null && clanId !== undefined) { clauses.push('clanId = ?'); params.push(Number(clanId)); }
        if (status !== null && status !== undefined) { clauses.push('status = ?'); params.push(String(status)); }
        const safeLimit = Math.max(1, Math.min(200, Math.floor(Number(limit) || 50)));
        const sql = `SELECT * FROM clan_actions${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''}
            ORDER BY updatedAt DESC, id DESC LIMIT ${safeLimit}`;
        // Live actions are in the world, finished ones in the history file.
        return readHistory(() => [...all(sql, params), ...History.all(sql, params)]
            .sort((left, right) => right.updatedAt - left.updatedAt || right.id - left.id)
            .slice(0, safeLimit), 'clan-action:list');
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
            FROM clan_actions
            WHERE status IN ('pending', 'running')`, [timestamp, timestamp, timestamp], 'clan-action:queue-stats').then((rows) => {
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
            ) OR (simulated.mode = 'player_managed' AND NOT EXISTS (
                SELECT 1 FROM clan_orders orders
                WHERE orders.clanId = simulated.clanId AND orders.status IN ('active', 'paused', 'blocked')
            ))) AND NOT EXISTS (
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
    expelDisciplinedClanMember(clanId, characterId, expectedRevision) {
        const clan = Number(clanId), id = Number(characterId);
        return withCharacterFlush(id, () => inTransaction(() => {
            const socialRow = one('SELECT snapshotJson FROM clan_social_memory WHERE clanId = ?', [clan]);
            const snapshot = socialRow && JSON.parse(socialRow.snapshotJson);
            const relation = snapshot?.relations.find(r => r.kind === 'character' && r.targetId === id);
            const d = relation?.discipline && require('./GameServer/Clan/ClanSocialPolicy').discipline(relation.discipline, 0, now());
            if (snapshot?.revision !== expectedRevision || d?.stage !== 'expulsion_pending'
                || !d.warningAt || !d.probationAt || d.lastOffenseAt <= d.probationAt) return { ok: false, reason: 'discipline_changed' };
            const simulated = one("SELECT s.stateJson, c.leaderId FROM clan_simulation_clans s JOIN clans c ON c.id = s.clanId WHERE s.clanId = ? AND s.mode = 'autonomous'", [clan]);
            const member = one(`SELECT c.id, c.username, c.clanId, l.accountName, l.statsJson FROM characters c
                LEFT JOIN bot_life_state l ON l.characterId = c.id WHERE c.id = ?`, [id]);
            const life = coldSimulationRow(id);
            if (!simulated || simulated.leaderId === id || !member || Number(member.clanId) !== clan || !generatedBotRow(member)) {
                return { ok: false, reason: 'discipline_membership_changed' };
            }
            if (!life || life.simulationLeaseId || jsonObject(life.statsJson).pvpEncounter) return { ok: false, reason: 'member_busy' };
            const at = now(), banUntil = at + 7 * 86400000;
            d.stage = 'expelled'; d.stageAt = at; d.banUntil = banUntil;
            relation.discipline = d;
            snapshot.revision++;
            const changedAt = Math.max(at, Number(one('SELECT MAX(updatedAt) AS at FROM clan_social_memory')?.at || 0) + 1);
            write('UPDATE clan_social_memory SET snapshotJson = ?, updatedAt = ? WHERE clanId = ?', [JSON.stringify(snapshot), changedAt, clan]);
            write('UPDATE characters SET clanId = 0, clanPrivileges = 0, clanJoinExpiryTime = ?, title = ? WHERE id = ? AND clanId = ?', [banUntil, '', id, clan]);
            const stats = jsonObject(life.statsJson);
            stats.clanId = 0;
            stats.clanMembershipVersion = at;
            stats.clanDiscipline = { clanId: clan, expelledAt: at, banUntil, reason: d.reason };
            stats.clanPartyObjective = null;
            if (Number(stats.equipmentPlan?.clanGoal?.clanId) === clan) stats.equipmentPlan = null;
            write('UPDATE bot_life_state SET statsJson = ?, simulationRevision = simulationRevision + 1, updatedAt = ? WHERE characterId = ?', [JSON.stringify(stats), at, id]);
            const state = jsonObject(simulated.stateJson);
            state.memberIds = (state.memberIds || []).filter(n => Number(n) !== id);
            write('UPDATE clan_simulation_clans SET stateJson = ?, updatedAt = ? WHERE clanId = ?', [JSON.stringify(state), at, clan]);
            const memory = commitInteractionMemoryUnsafe([{ key: `clan-expelled:${clan}:${id}:${at}`,
                sourceId: id, targetId: clan, kind: 'clan', type: 'aided_opponent', at }], at);
            if (!memory.ok) throw Error('expulsion memory rejected');
            return { ok: true, clanId: clan, characterId: id, banUntil, snapshot,
                row: coldSimulationRow(id), memorySnapshots: memory.snapshots };
        }, 'clan-social:expel')).then(result => publishClanMembership({ ...result, previousClanId: clan }));
    },
    migrateAutonomousClanNames({ dryRun = false } = {}) {
        return inTransaction(() => {
            const occupied = new Set(all('SELECT name FROM clans').map((row) => row.name.toLowerCase()));
            const candidates = all(`SELECT c.id, c.name, c.leaderId, s.stateJson,
                    leader.username, life.accountName, life.statsJson
                FROM clans c
                JOIN clan_simulation_clans s ON s.clanId = c.id AND s.mode = 'autonomous'
                JOIN characters leader ON leader.id = c.leaderId
                LEFT JOIN bot_life_state life ON life.characterId = leader.id
                ORDER BY c.id`);
            const renamed = [];
            for (const clan of candidates) {
                const state = jsonObject(clan.stateJson);
                if (!generatedBotRow(clan) || !ClanNameCatalog.isLegacyName(clan.name)
                    || Number(state.naming?.version || 0) >= ClanNameCatalog.VERSION) continue;
                const entry = ClanNameCatalog.select(clan.id, occupied);
                if (!entry) throw new Error('clan name catalog exhausted');
                occupied.add(entry.name.toLowerCase());
                const naming = { version: ClanNameCatalog.VERSION, source: entry.source, previousName: clan.name };
                if (!dryRun) {
                    write('UPDATE clans SET name = ? WHERE id = ?', [entry.name, clan.id]);
                    write('UPDATE clan_simulation_clans SET stateJson = ? WHERE clanId = ?',
                        [JSON.stringify({ ...state, naming }), clan.id]);
                }
                renamed.push({ clanId: clan.id, previousName: clan.name, name: entry.name, source: entry.source });
            }
            return { renamed };
        }, 'clan-simulation:name-migration');
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
            if (!Number(leaderId) || uniqueMemberIds.length < Number(founderQuorum || 5)) {
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
            if (members.some(member => Number(one('SELECT clanJoinExpiryTime FROM characters WHERE id = ?', [member.id])?.clanJoinExpiryTime || 0) > now())) {
                return { ok: false, code: 'clan_discipline_cooldown' };
            }

            const population = botPopulationUnsafe();
            const maxMembers = Math.floor(Math.max(0, Number(population.population) || 0) * Math.max(0, Math.min(1, Number(maxBotMemberShare) || 0)));
            const nextBotMembers = Number(population.botMembers) + uniqueMemberIds.length;
            if (nextBotMembers > maxMembers) {
                return { ok: false, code: 'founder_population_limit', population: Number(population.population), maxBotMembers: maxMembers };
            }

            const requestedName = String(name || '').trim();
            const generatedName = requestedName ? null : ClanNameCatalog.select(leaderId,
                all('SELECT name FROM clans').map((row) => row.name));
            if (!requestedName && !generatedName) return { ok: false, code: 'name_pool_exhausted' };
            const clanName = requestedName || generatedName.name;
            const inserted = write('INSERT INTO clans (name, leaderId) VALUES (?, ?)', [clanName, Number(leaderId)]);
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
            if (generatedName) state.naming = { version: ClanNameCatalog.VERSION, source: generatedName.source };
            write(`INSERT INTO clan_simulation_clans (clanId, version, mode, createdAt, updatedAt, stateJson)
                VALUES (?, ?, 'autonomous', ?, ?, ?)`, [clanId, 1, timestamp, timestamp, JSON.stringify(state)]);
            insertClanActionUnsafe({
                clanId,
                actionKey: `clan:${clanId}:bootstrap:${timestamp}`,
                actionType: 'goal_plan',
                availableAt: timestamp,
                payload: { reason: 'clan_created', clanId },
                reasonCode: 'clan_created',
                createdAt: timestamp
            });
            return {
                ok: true,
                clanId,
                memberIds: uniqueMemberIds,
                membershipRepair: ClanMembership.repairUnsafe(uniqueMemberIds),
                population: Number(population.population) || 0,
                botMembers: nextBotMembers,
                maxBotMembers: maxMembers
            };
        }, 'clan-simulation:create').then(result => publishClanMembership({ ...result, nextClanId: result.clanId })).then(ClanMembership.publish).catch((error) => {
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
            if (Number(one('SELECT clanJoinExpiryTime FROM characters WHERE id = ?', [id])?.clanJoinExpiryTime || 0) > now()) {
                return { ok: false, code: 'clan_discipline_cooldown' };
            }
            const social = one('SELECT snapshotJson FROM clan_social_memory WHERE clanId = ?', [targetClanId]);
            const reputation = social && JSON.parse(social.snapshotJson).relations.find(r => r.kind === 'character' && r.targetId === id);
            const feeling = require('./GameServer/Clan/ClanSocialPolicy').relation(reputation, now());
            if (Number(reputation?.discipline?.banUntil || 0) > now() || (feeling && (feeling.trust < -3 || feeling.hostility >= 10))) {
                return { ok: false, code: 'clan_distrust' };
            }

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
            if (reputation?.discipline?.stage === 'expelled') {
                const snapshot = JSON.parse(social.snapshotJson);
                const row = snapshot.relations.find(r => r.kind === 'character' && r.targetId === id);
                row.discipline = { stage: 'clear', score: 0, at: timestamp, stageAt: timestamp,
                    previousExpulsionAt: row.discipline.stageAt, lastOffenseAt: 0 };
                snapshot.revision++;
                const changedAt = Math.max(timestamp, Number(one('SELECT MAX(updatedAt) AS at FROM clan_social_memory')?.at || 0) + 1);
                write('UPDATE clan_social_memory SET snapshotJson = ?, updatedAt = ? WHERE clanId = ?', [JSON.stringify(snapshot), changedAt, targetClanId]);
            }
            const state = simulationState(simulation.stateJson, targetClanId, previousState.leaderId, previousState.memberIds || [], timestamp);
            state.memberIds = [...new Set([...state.memberIds, id])].sort((left, right) => left - right);
            write('UPDATE clan_simulation_clans SET updatedAt = ?, stateJson = ? WHERE clanId = ?', [timestamp, JSON.stringify(state), targetClanId]);
            return {
                ok: true,
                clanId: targetClanId,
                characterId: id,
                membershipRepair: ClanMembership.repairUnsafe([id]),
                population: Number(population.population) || 0,
                botMembers: nextBotMembers,
                maxBotMembers: maxMembers
            };
        }, 'clan-simulation:join').then(result => publishClanMembership({ ...result, nextClanId: result.clanId })).then(ClanMembership.publish);
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
                recordClanGoalEventUnsafe({
                    clanId: clan,
                    eventType: String(eventType),
                    goalType: String(goal?.type || ''),
                    plan: String(goal?.plan?.kind || ''),
                    reasonCode: String(reasonCode || ''),
                    payloadJson: JSON.stringify(goal || {}),
                    occurredAt: timestamp
                });
            }
            return { ok: true, clanId: clan, goal: state.goal, updatedAt: timestamp,
                membershipRepair: ClanMembership.repairGoalsUnsafe([clan]) };
        }, 'clan-goal:update').then(ClanMembership.publish);
    },
    recordClanGoalEvent({ clanId, eventType, goalType = '', plan = '', reasonCode = '', payload = {} } = {}) {
        if (!Number(clanId) || !String(eventType || '').trim()) return Promise.resolve({ ok: false, code: 'invalid_goal_event' });
        return enqueue(() => recordClanGoalEventUnsafe({
            clanId: Number(clanId),
            eventType: String(eventType),
            goalType: String(goalType || ''),
            plan: String(plan || ''),
            reasonCode: String(reasonCode || ''),
            payloadJson: JSON.stringify(payload || {}),
            occurredAt: now()
        }), { operation: 'clan-goal:event' }).then((eventId) => ({ ok: true, eventId: Number(eventId) }));
    },
    fetchClanGoalEvents(clanId, limit = 50) {
        const safeLimit = Math.max(1, Math.min(200, Math.floor(Number(limit) || 50)));
        return readHistory(() => History.all(`SELECT * FROM clan_goal_events WHERE clanId = ?
            ORDER BY occurredAt DESC, id DESC LIMIT ${safeLimit}`, [Number(clanId)]), 'clan-goal:events');
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
            recordClanGoalEventUnsafe({
                clanId: clan,
                eventType: 'party_operation_started',
                goalType: String(goal.type || ''),
                plan: String(operationType),
                reasonCode: 'party_operation_started',
                payloadJson: JSON.stringify({
                    operationKey: key,
                    operationId: Number(inserted.insertId),
                    memberIds: allMembers,
                    guestMemberIds: guests
                }),
                occurredAt: timestamp
            });
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
            recordClanGoalEventUnsafe({
                clanId: clan,
                eventType: success ? 'party_operation_succeeded' : 'party_operation_failed',
                goalType: String(goal.type || 'item'),
                plan: 'farm',
                reasonCode: String(reasonCode || (success ? 'party_operation_succeeded' : 'party_operation_failed')),
                payloadJson: JSON.stringify({ operationId: id, operationKey: operation.operationKey, reward }),
                occurredAt: timestamp
            });
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
    materializeClanSupplies(characterId, expectedRevision, itemIds = []) {
        return inTransaction(() => {
            const row = one('SELECT * FROM bot_life_state WHERE characterId = ?', [characterId]);
            if (!row || row.phase !== 'cold' || Number(row.simulationRevision) !== Number(expectedRevision)) return false;
            if (row.simulationOwner === COLD_SIMULATION_OWNER) {
                const inventory = jsonObject(row.inventorySummary);
                const supplies = Object.fromEntries(itemIds.slice(0, 128).filter(id => inventory[id]).map(id => [id, inventory[id]]));
                syncInventorySummaryUnsafe(characterId, supplies);
            }
            return true;
        }, 'clan-supplies:materialize');
    },

    transferInventoryToClanWarehouse({
        clanId,
        characterId,
        item = {},
        amount,
        resolveKey,
        expectedWarehouseRevision = null,
        expectedSimulationRevision = null,
        allowParty = false
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
            const life = one(`SELECT phase, simulationOwner, simulationRevision, partyId, inventorySummary
                FROM bot_life_state WHERE characterId = ?`, [character]);
            if (!simulation || !clanRow || !member || Number(member.clanId) !== clan) {
                return { ok: false, code: 'warehouse_transfer_failed' };
            }
            if (!life || String(life.phase || '') !== 'cold'
                || (!allowParty && String(life.simulationOwner || LEGACY_SIMULATION_OWNER) !== LEGACY_SIMULATION_OWNER)
                || (!allowParty && String(life.partyId || '') !== '')) {
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
                ? one(`SELECT SUM(amount) AS amount FROM clan_warehouse_items
                    WHERE clanId = ? AND selfId = ? AND amount > 0`, [clan, selfId])
                : null;
            if (recipeTarget && Number(recipeTarget.amount || 0) + requested > Math.max(1, Number(item.recipeLimit || 1))) {
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
            }, expectedSimulationRevision === null ? Number(life.simulationRevision || 0) : Number(expectedSimulationRevision), allowParty);
            if (!lifeUpdate.ok) throw new Error(`clan warehouse deposit rejected: ${lifeUpdate.code}`);

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
                state: normalizeRow(one('SELECT * FROM bot_life_state WHERE characterId = ?', [character])),
                ledgerId: Number(ledger.insertId)
            };
        }, 'clan-warehouse:deposit')).then(result => {
            if (result.ok) require('./GameServer/Clan/ClanReviewEvents').changed(clan, 'warehouse');
            return result;
        });
    },
    exchangeClanWarehouseEquipment({ clanId, characterId, warehouseId, expectedPhase, validateLive, validateCold } = {}) {
        const clan = Number(clanId);
        const id = Number(characterId);
        return withCharacterFlush(id, () => inTransaction(() => {
            const Policy = invoke('GameServer/Clan/ClanWarehouseEquipmentPolicy');
            const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
            const member = one('SELECT id, clanId, classId, level FROM characters WHERE id = ?', [id]);
            const life = one('SELECT * FROM bot_life_state WHERE characterId = ?', [id]);
            const stock = one('SELECT * FROM clan_warehouse_items WHERE id = ? AND clanId = ?', [Number(warehouseId), clan]);
            if (!member || Number(member.clanId) !== clan || !life || !stock) return { ok: false, code: 'stock_or_member_changed' };
            if (life.phase !== expectedPhase || !['cold', 'hot'].includes(life.phase)
                || String(life.simulationOwner || LEGACY_SIMULATION_OWNER) !== LEGACY_SIMULATION_OWNER
                || life.phase === 'cold' && (!['hunting', 'resting', 'grouped'].includes(life.activity)
                    || validateCold && !validateCold())) {
                return { ok: false, code: 'member_busy' };
            }
            if (one(`SELECT id FROM clan_orders WHERE clanId = ? AND itemId = ?
                AND status IN ('active', 'paused', 'blocked') LIMIT 1`, [clan, stock.selfId])) {
                return { ok: false, code: 'item_ordered' };
            }
            const rows = all('SELECT * FROM items WHERE characterId = ? AND amount > 0', [id]);
            if (life.phase === 'cold' && !Policy.inventoryMatches(rows, jsonObject(life.inventorySummary))) {
                return { ok: false, code: 'inventory_not_materialized' };
            }
            if (life.phase === 'hot' && (typeof validateLive !== 'function' || !validateLive(member, rows))) {
                return { ok: false, code: 'live_state_changed' };
            }
            const plan = Policy.plan(member, rows, stock);
            if (!plan) return { ok: false, code: 'not_an_upgrade' };
            const timestamp = now();
            const simulation = one('SELECT stateJson FROM clan_simulation_clans WHERE clanId = ?', [clan]);
            const clanState = jsonObject(simulation?.stateJson);
            const revision = Math.max(Number(clanState.warehouseRevision || 0), Number(one(
                'SELECT COALESCE(MAX(warehouseRevision), 0) AS revision FROM clan_warehouse_ledger WHERE clanId = ?', [clan]
            ).revision || 0)) + 1;
            const key = `gear-exchange:${stock.id}:${id}:${revision}`;
            const ledger = (selfId, operation) => write(`INSERT INTO clan_warehouse_ledger
                (clanId, characterId, selfId, amount, operation, resolveKey, warehouseRevision, createdAt)
                VALUES (?, ?, ?, 1, ?, ?, ?, ?)`, [clan, id, selfId, operation, key, revision, timestamp]);
            for (const old of plan.returned) {
                const item = Policy.materialize(old);
                write(`INSERT INTO clan_warehouse_items
                    (clanId, selfId, name, kind, amount, enchant, petData, createdAt, updatedAt)
                    VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`, [
                    clan, old.selfId, item.fetchName(), item.fetchKind(), old.enchant, old.petData, timestamp, timestamp
                ]);
                write('DELETE FROM items WHERE id = ? AND characterId = ?', [old.id, id]);
                ledger(old.selfId, 'deposit');
            }
            if (Number(stock.amount) === 1) write('DELETE FROM clan_warehouse_items WHERE id = ?', [stock.id]);
            else write('UPDATE clan_warehouse_items SET amount = amount - 1, updatedAt = ? WHERE id = ?', [timestamp, stock.id]);
            const inventoryId = Number(write(`INSERT INTO items
                (characterId, selfId, name, amount, enchant, petData, equipped, slot)
                VALUES (?, ?, ?, 1, ?, ?, 1, ?)`, [id, stock.selfId, stock.name, stock.enchant, stock.petData, plan.slot]).insertId);
            ledger(stock.selfId, 'withdraw');
            const updatedRows = all('SELECT * FROM items WHERE characterId = ? AND amount > 0', [id]);
            const physical = LifeState.inventorySummaryFromItems(updatedRows);
            const inventory = jsonObject(life.inventorySummary);
            for (const selfId of new Set([stock.selfId, ...plan.returned.map((row) => row.selfId)])) {
                delete inventory[String(selfId)];
                if (physical[String(selfId)]) inventory[String(selfId)] = physical[String(selfId)];
            }
            const stats = jsonObject(life.statsJson);
            stats.equipment = LifeState.equipmentSummaryFromInventory(inventory);
            stats.clanGearExchangeRevision = Number(life.simulationRevision || 0) + 1;
            stats.lastClanWarehouseTransfer = { operation: 'gear_exchange', clanId: clan, selfId: stock.selfId,
                returned: plan.returned.map((row) => ({ selfId: row.selfId, enchant: row.enchant })), at: timestamp };
            write(`UPDATE bot_life_state SET inventorySummary = ?, statsJson = ?,
                simulationRevision = simulationRevision + 1, updatedAt = ? WHERE characterId = ?`, [
                JSON.stringify(inventory), JSON.stringify(stats), timestamp, id
            ]);
            if (simulation) {
                clanState.warehouseRevision = revision;
                clanState.updatedAt = timestamp;
                write('UPDATE clan_simulation_clans SET stateJson = ?, updatedAt = ? WHERE clanId = ?', [JSON.stringify(clanState), timestamp, clan]);
            }
            return { ok: true, code: 'gear_exchanged', inventoryId, slot: plan.slot,
                received: { ...stock, id: inventoryId, amount: 1, slot: plan.slot, equipped: true },
                returned: plan.returned, state: normalizeRow(one('SELECT * FROM bot_life_state WHERE characterId = ?', [id])) };
        }, 'clan-warehouse:gear-exchange'));
    },

    transferClanWarehouseToMember({
        clanId,
        characterId,
        selfId,
        amount,
        goalKey,
        expectedWarehouseRevision = null,
        expectedSimulationRevision = null,
        allowParty = false,
        clanOrder = null
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
            if (clanOrder && !playerClanCraftOrderUnsafe(clan, clanOrder.orderId, clanOrder.settings)) {
                return { ok: false, code: 'clan_order_revision_conflict' };
            }
            const simulation = one('SELECT clanId, stateJson FROM clan_simulation_clans WHERE clanId = ?', [clan]);
            const member = one('SELECT id, clanId FROM characters WHERE id = ?', [beneficiary]);
            const life = one(`SELECT phase, simulationOwner, simulationRevision, partyId
                FROM bot_life_state WHERE characterId = ?`, [beneficiary]);
            if (!simulation || !member || Number(member.clanId) !== clan || !life) {
                return { ok: false, code: 'warehouse_transfer_failed' };
            }
            if (String(life.phase || '') !== 'cold'
                || String(life.simulationOwner || LEGACY_SIMULATION_OWNER) !== LEGACY_SIMULATION_OWNER
                || (!allowParty && String(life.partyId || '') !== '')) {
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
                : Number(expectedSimulationRevision), allowParty);
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
                state: normalizeRow(one('SELECT * FROM bot_life_state WHERE characterId = ?', [beneficiary])),
                ledgerId: Number(ledger.insertId)
            };
        }, 'clan-warehouse:withdraw'));
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
        if (Number(fromLevel) === 3 || Number(toLevel) === 4) return Promise.resolve({ ok: false, code: 'alliance_trial_required' });
        const clan = Number(clanId);
        return ClanLevelSp.withLeader(clan, () => inTransaction(() => {
            const simulation = one('SELECT clanId, stateJson FROM clan_simulation_clans WHERE clanId = ?', [clan]);
            const clanRow = one('SELECT id, level, leaderId FROM clans WHERE id = ?', [clan]);
            if (!simulation || !clanRow) return { ok: false, code: 'target_not_autonomous' };
            if (Number(clanRow.level) !== Number(fromLevel)) return { ok: false, code: 'level_already_advanced', level: Number(clanRow.level) };
            const spBudget = ClanLevelSp.check(clanRow, fromLevel, toLevel);
            if (!spBudget.ok) return spBudget;

            const itemId = Math.max(0, Number(requiredItemId) || 0);
            const required = Math.max(0, Math.floor(Number(itemId ? requiredItemAmount : requiredAmount) || 0));
            let contributed = 0;
            let warehouseAmount = 0;
            if (itemId === 0) {
                contributed = Number(one(`SELECT COALESCE(SUM(amount), 0) AS amount
                    FROM clan_contributions WHERE clanId = ? AND targetLevel = ?`, [clan, Number(fromLevel)]).amount || 0);
                if (contributed < required) {
                    return { ok: false, code: 'contribution_level_ready', contributed, requiredAmount: required };
                }
            }
            // The level is paid like the player's level-up (NpcBypasses/Clan): the
            // item or the Adena is spent, from the clan warehouse where the dues went.
            const timestamp = now();
            const consumedId = itemId || 57;
            if (required > 0) {
                warehouseAmount = Number(one(`SELECT COALESCE(SUM(MAX(0, amount - reservedAmount)), 0) AS amount
                    FROM clan_warehouse_items WHERE clanId = ? AND selfId = ?`, [clan, consumedId]).amount || 0);
                if (warehouseAmount < required) {
                    return { ok: false, code: 'warehouse_item_not_ready', warehouseAmount, requiredAmount: required, itemId: consumedId };
                }
            }

            const updated = write('UPDATE clans SET level = ? WHERE id = ? AND level = ?', [Number(toLevel), clan, Number(fromLevel)]);
            if (updated.affectedRows !== 1) return { ok: false, code: 'level_already_advanced' };
            const previousState = jsonObject(simulation.stateJson);
            if (required > 0) {
                let remaining = required;
                const rows = all(`SELECT id, amount, reservedAmount FROM clan_warehouse_items
                    WHERE clanId = ? AND selfId = ? AND amount > reservedAmount ORDER BY id`, [clan, consumedId]);
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
                    consumedId,
                    required,
                    `clan:${clan}:level:${Number(fromLevel)}:${Number(toLevel)}:${consumedId}`,
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
                levelSp: ClanLevelSp.spend(spBudget),
                clanId: clan,
                fromLevel: Number(fromLevel),
                toLevel: Number(toLevel),
                contributed,
                requiredAmount: required,
                requiredItemId: itemId,
                warehouseAmount,
                warehouseRevision: Number(state.warehouseRevision || 0)
            };
        }, 'clan-simulation:level-up')).then(result => {
            if (result.ok) require('./GameServer/Clan/ClanReviewEvents').changed(clan, 'level');
            return result;
        });
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
    updateCharacterClan(id, clanId, clanPrivileges, clanJoinExpiryTime, clanCreateExpiryTime) {
        return withCharacterFlush(id, () => inTransaction(() => {
            const previousClanId = Number(one('SELECT clanId FROM characters WHERE id = ?', [id])?.clanId || 0);
            const result = write(`UPDATE characters SET clanId = ?, clanPrivileges = ?, clanJoinExpiryTime = ?, clanCreateExpiryTime = ? WHERE id = ?`,
                [clanId, clanPrivileges, clanJoinExpiryTime, clanCreateExpiryTime, id]);
            return { ...result, previousClanId, nextClanId: Number(clanId), membershipRepair: ClanMembership.repairUnsafe([id]) };
        }, 'character:clan')).then(publishClanMembership).then(ClanMembership.publish);
    },
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
        return withCharacterFlush(id, () => inTransaction(() => {
            const previousClanId = Number(one('SELECT clanId FROM characters WHERE id = ?', [id])?.clanId || 0);
            const result = write(`UPDATE characters SET clanId = 0, clanPrivileges = 0,
                clanJoinExpiryTime = 0, clanCreateExpiryTime = 0, title = '' WHERE id = ?`, [id]);
            return { ...result, previousClanId, nextClanId: 0, membershipRepair: ClanMembership.repairUnsafe([id]) };
        }, 'character:clan-remove')).then(publishClanMembership).then(ClanMembership.publish);
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

                if (one("SELECT name FROM sqlite_master WHERE type='table' AND name='clan_halls'")
                    && (one('SELECT id FROM clan_halls WHERE ownerId=?', [id])
                        || one('SELECT clanId FROM clan_hall_bids WHERE clanId=?', [id]))) {
                    return { ok: false, code: 'clan_hall_owned_or_bid' };
                }
                const currentMembers = all('SELECT id FROM characters WHERE clanId = ? ORDER BY id', [id]);
                write(`UPDATE characters
                    SET clanId = 0,
                        clanPrivileges = 0,
                        clanJoinExpiryTime = 0,
                        clanCreateExpiryTime = 0,
                        title = ''
                    WHERE clanId = ?`, [id]);
                write('DELETE FROM clans WHERE id = ?', [id]);
                return { ok: true, clanId: id, memberIds: currentMembers.map((member) => Number(member.id)),
                    membershipRepair: ClanMembership.repairUnsafe(currentMembers.map(member => member.id)) };
            }, 'clan:dissolve'))).then(result => publishClanMembership({ ...result, previousClanId: id })).then(ClanMembership.publish);
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
    setCharacterHenna(characterId, slot, symbolId) { return withCharacterFlush(characterId, () => run(`INSERT INTO character_hennas (characterId, slot, symbolId) VALUES (?, ?, ?)
        ON CONFLICT(characterId, slot) DO UPDATE SET symbolId = excluded.symbolId`, [characterId, slot, symbolId], 'henna:upsert')); },
    fetchCharacterHennas(characterId) { return select('character_hennas', ['*'], 'characterId = ?', [characterId], 'henna:list'); },
    deleteCharacterHenna(characterId, slot) { return withCharacterFlush(characterId, () => remove('character_hennas', 'slot = ? AND characterId = ?', [slot, characterId], 'henna:delete')); },
    updateCharacterLocation(id, coords) { return withCharacterFlush(id, () => update('characters', { locX: coords.locX, locY: coords.locY, locZ: coords.locZ, head: coords.head ?? -1 }, 'id = ?', [id], 'character:location')); },
    updateCharacterName(id, name) { return withCharacterFlush(id, () => update('characters', { name }, 'id = ?', [id], 'character:name')); },
    updateGeneratedBotName(id, name, version) {
        const characterId = Number(id);
        return withCharacterFlush(characterId, () => inTransaction(() => {
            const character = write('UPDATE characters SET name = ? WHERE id = ?', [name, characterId]);
            const life = write(`UPDATE bot_life_state SET characterName = ?,
                statsJson = json_set(COALESCE(statsJson, '{}'), '$.nameGeneratorVersion', ?)
                WHERE characterId = ?`, [name, version, characterId]);
            if (character.affectedRows !== 1 || life.affectedRows !== 1) throw new Error(`generated name target missing for ${characterId}`);
            return { ok: true, characterId, name, version };
        }, 'bot-life:generated-name'));
    },
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
    updateColdCharacterExperience(id, level, exp, sp, options = {}) {
        const admission = captureWriteAdmission(options, 'invalid_character_experience_before_write', id);
        return withCharacterFlush(id, () => guardedNativeWrite(`UPDATE characters
            SET karma = MAX(0, karma - CAST(MAX(0, ? - exp) / ? AS INTEGER)),
                level = ?, exp = ?, sp = ? WHERE id = ?`,
            [exp, KARMA_XP_DIVIDER, level, exp, sp, id], 'character:cold-experience', admission));
    },
    updateCharacterExperience(id, level, exp, sp, options = {}) {
        const admission = captureWriteAdmission(options, 'invalid_character_experience_before_write', id);
        return withCharacterFlush(id, () => guardedNativeWrite('UPDATE "characters" SET "level" = ?, "exp" = ?, "sp" = ? WHERE id = ?',
            [level, exp, sp, id], 'character:experience', admission));
    },
    fetchCharacterDeathExperience(id) {
        return selectOne('character_death_experience', ['*'], 'characterId = ?', [Number(id)], 'character:death-exp-fetch')
            .then((rows) => rows[0] || null);
    },
    updateColdCharacterProgression(id, state) {
        return withCharacterFlush(id, () => inTransaction(() => {
            const life = one('SELECT statsJson FROM bot_life_state WHERE characterId = ?', [id]);
            if (Number(jsonObject(life?.statsJson).clanLevelSpVersion || 0) > Number(state.stats?.clanLevelSpVersion || 0)) {
                const error = new Error(`stale SP before clan level-up for ${id}`);
                error.code = 'BOT_LIFE_STATE_OWNERSHIP_CONFLICT';
                throw error;
            }
            write('UPDATE characters SET level = ?, exp = ?, sp = ? WHERE id = ?',
                [state.level, state.exp, state.sp, id]);
            syncColdDeathExperienceUnsafe(id, state.stats?.deathExperience, Number(state.updatedAt || now()));
        }, 'character:cold-progression'));
    },
    applyCharacterDeathExperience(record, options = {}) {
        const id = Number(record.characterId);
        const admission = captureWriteAdmission(options, 'invalid_character_experience_before_write', id);
        return withCharacterFlush(id, () => inTransaction(() => {
            checkCapturedWriteAdmission(admission, id);
            const existing = one('SELECT * FROM character_death_experience WHERE characterId = ?', [id]);
            const character = one('SELECT level, exp, sp FROM characters WHERE id = ?', [id]);
            if (!character) throw new Error(`death experience character missing: ${id}`);
            if (existing && Number(existing.pendingRestoration) === 1
                && Number(existing.expAfterDeath) === Number(character.exp)) {
                return { ...existing, duplicate: true };
            }
            const sequence = Number(existing?.deathSequence || 0) + 1;
            write(`UPDATE characters SET level = ?, exp = ?,
                sp = COALESCE(?, sp), karma = COALESCE(?, karma) WHERE id = ?`,
            [record.level, record.expAfterDeath,
                Number.isFinite(Number(record.sp)) ? Number(record.sp) : null,
                Number.isFinite(Number(record.karma)) ? Number(record.karma) : null, id]);
            write(`INSERT INTO character_death_experience
                (characterId, deathSequence, expBeforeDeath, expLost, expAfterDeath, deathContext,
                 penaltyAppliedAt, pendingRestoration, resolvedAt, resolutionReason)
                VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL, '')
                ON CONFLICT(characterId) DO UPDATE SET
                    deathSequence = excluded.deathSequence,
                    expBeforeDeath = excluded.expBeforeDeath,
                    expLost = excluded.expLost,
                    expAfterDeath = excluded.expAfterDeath,
                    deathContext = excluded.deathContext,
                    penaltyAppliedAt = excluded.penaltyAppliedAt,
                    pendingRestoration = 1,
                    resolvedAt = NULL,
                    resolutionReason = ''`, [id, sequence, record.expBeforeDeath, record.expLost,
                record.expAfterDeath, JSON.stringify(record.deathContext || {}), record.penaltyAppliedAt]);
            return { ...record, deathSequence: sequence, pendingRestoration: 1, duplicate: false };
        }, 'character:death-exp-apply'));
    },
    restoreCharacterDeathExperience(id, restorePercent, resolvedAt = Date.now(), options = {}) {
        const characterId = Number(id);
        const percent = Math.max(0, Math.min(100, Number(restorePercent) || 0));
        const admission = captureWriteAdmission(options, 'invalid_character_experience_before_write', characterId);
        return withCharacterFlush(characterId, () => inTransaction(() => {
            checkCapturedWriteAdmission(admission, characterId);
            const death = one('SELECT * FROM character_death_experience WHERE characterId = ?', [characterId]);
            if (!death || Number(death.pendingRestoration) !== 1) return null;
            const character = one('SELECT level, exp, sp FROM characters WHERE id = ?', [characterId]);
            if (!character) return null;
            const restoredExp = Math.min(Number(death.expLost), Math.round(Number(death.expLost) * percent / 100));
            const totalExp = Math.min(Number(death.expBeforeDeath), Number(character.exp) + restoredExp);
            const level = invoke('GameServer/Progression/ProgressionCap').levelForExperience(totalExp, character.level);
            const consumed = write(`UPDATE character_death_experience
                SET pendingRestoration = 0, resolvedAt = ?, resolutionReason = 'resurrection'
                WHERE characterId = ? AND pendingRestoration = 1`, [resolvedAt, characterId]);
            if (Number(consumed.affectedRows) !== 1) return null;
            write('UPDATE characters SET level = ?, exp = ? WHERE id = ?', [level, totalExp, characterId]);
            return { ...death, pendingRestoration: 0, restoredExp, totalExp, level, restorePercent: percent };
        }, 'character:death-exp-restore'));
    },
    clearCharacterDeathExperience(id, reason = 'invalidated', resolvedAt = Date.now(), options = {}) {
        const characterId = Number(id);
        const admission = captureWriteAdmission(options, 'invalid_character_experience_before_write', characterId);
        return withCharacterFlush(characterId, () => guardedNativeWrite(`UPDATE character_death_experience
            SET pendingRestoration = 0, resolvedAt = ?, resolutionReason = ?
            WHERE characterId = ? AND pendingRestoration = 1`,
        [resolvedAt, String(reason || 'invalidated'), characterId], 'character:death-exp-clear', admission));
    },
    updateCharacterVitals(id, hp, maxHp, mp, maxMp, options = {}) {
        const admission = captureWriteAdmission(options, 'invalid_character_vitals_before_write', id);
        return withCharacterFlush(id, () => guardedNativeWrite('UPDATE "characters" SET "hp" = ?, "maxHp" = ?, "mp" = ?, "maxMp" = ? WHERE id = ?',
            [hp, maxHp, mp, maxMp, id], 'character:vitals', admission));
    },
    updateCharacterStatus(id, { hp, mp, cp, effects, skillCooldowns }) { return withCharacterFlush(id, () => update('characters', { hp, mp, cp, effects, ...(skillCooldowns === undefined ? {} : { skillCooldowns }) }, 'id = ?', [id], 'character:status')); },
    updateCharacterPvpPkKarma(id, pvp, pk, karma) { return withCharacterFlush(id, () => update('characters', { pvp, pk, karma }, 'id = ?', [id], 'character:karma')); },
    updateCharacterClassId(id, classId, options = {}) {
        const admission = captureWriteAdmission(options, 'invalid_class_before_write', id);
        return withCharacterFlush(id, () => guardedNativeWrite('UPDATE "characters" SET "classId" = ? WHERE id = ?',
            [classId, id], 'character:class', admission));
    }
};

const ClanLevelSp = require('./GameServer/Clan/ClanLevelSpRepository')({ one, write, run, withCharacterFlushes });
Object.assign(Database, require('./GameServer/Clan/ClanAllianceRepository')({ one, all, write, inTransaction, withCharacterFlushes, ClanLevelSp, recordClanGoalEventUnsafe }));

Object.assign(Database, require('./GameServer/ClanHall/Repository')({
    one, all, write, inTransaction, inPreparedTransaction, inPreparedTransactionBatch, withCharacterFlush, updateColdInventorySnapshotUnsafe, syncInventorySummaryUnsafe,
    rememberClanContributionUnsafe
}));

const TradeMeetings = require('./GameServer/AfkTrade/TradeMeeting').create({
    one, all, write, now, take: afkTradeTakeItemUnsafe, debit: afkTradeDebitAdenaUnsafe,
    credit: (owner, item, count, at) => {
        const bag = Number(one('SELECT COALESCE(SUM(amount),0) amount FROM items WHERE characterId=? AND selfId=?', [owner, item.selfId]).amount);
        const pending = Number(one('SELECT COALESCE(SUM(amount),0) amount FROM board_settlements WHERE ownerId=? AND selfId=?', [owner, item.selfId]).amount);
        if (!Number.isSafeInteger(bag + pending + count)) throw Error('trade_meeting_integer');
        return creditRecordOwnerUnsafe(owner, item, count, at);
    }, funding: checkEconomyFundingUnsafe, protection: checkEconomyMaterialProtectionUnsafe,
    position: tradeMeetingPositionUnsafe,
    stopTrip: meeting => {
        for (const actor of [meeting.actorA, meeting.actorB]) {
            write("UPDATE bot_life_state SET activity='shopping',statsJson=json_remove(statsJson,'$.travel') WHERE characterId=? AND json_extract(statsJson,'$.travel.meetingId')=?", [actor, meeting.id]);
            // The physical receipt survives a retained session or process restart;
            // its old companion workflow must not block future activation forever.
            write("UPDATE bot_life_state SET statsJson=json_remove(statsJson,'$.supplyErrand') WHERE characterId=? AND json_extract(statsJson,'$.supplyErrand.meetingToken')=?", [actor, meeting.token]);
        }
    },
    completed: (meeting, line) => {
        const at = now(), buyerId = line.payer ? meeting.actorB : meeting.actorA;
        const sellerId = line.payer ? meeting.actorA : meeting.actorB;
        const ad = line.sourceAdId && one('SELECT * FROM afk_trade_shops WHERE id=?', [line.sourceAdId]);
        if (ad?.custodyPolicy === 1) {
            write('UPDATE afk_trade_lines SET count=max(0,count-?),fills=fills+1,updatedAt=? WHERE shopId=? AND selfId=? AND enchant=?',
                [line.count, at, ad.id, line.selfId, line.enchant]);
            write('UPDATE afk_trade_shops SET revision=revision+1,updatedAt=? WHERE id=?', [at, ad.id]);
        }
        const buyer = one('SELECT name,username FROM characters WHERE id=?', [buyerId]);
        const seller = one('SELECT name,username FROM characters WHERE id=?', [sellerId]);
        recordAfkTradeEventUnsafe({ shopId: line.sourceAdId, ownerId: ad?.ownerId || sellerId,
            counterpartyId: ad?.ownerId === buyerId ? sellerId : buyerId, kind: ad?.storeType === 3 ? 'purchase' : 'sale',
            selfId: line.selfId, itemName: line.name, amount: line.count, unitPrice: line.price,
            totalPrice: line.count * line.price, createdAt: at });
        recordMarketTradeUnsafe({ eventKey: `meeting:${meeting.id}:${line.ordinal}`, occurredAt: at,
            channel: BoardRules.isBotAccount(seller?.username) ? 'bot_wts' : 'player_wts',
            sourceType: BoardRules.isBotAccount(seller?.username) ? 'afk_bot_store' : 'afk_player_store',
            selfId: line.selfId, itemName: line.name, quantity: line.count, unitPrice: line.price,
            totalPrice: line.count * line.price, town: meeting.town, sellerCharacterId: sellerId,
            sellerName: seller?.name || null, buyerCharacterId: buyerId, buyerName: buyer?.name || null }, { unique: true });
        learnBoardTradeUnsafe({ selfId: line.selfId, unitPrice: line.price, quantity: line.count,
            sellerCharacterId: sellerId, buyerCharacterId: buyerId }, [[sellerId, seller], [buyerId, buyer]]);
    },
    startTrip: (id, meeting, side, receipt) => {
        const row = one('SELECT * FROM bot_life_state WHERE characterId=?', [id]);
        if (!row || row.phase !== 'cold' || Number(row.hp) <= 0
            || ['dead', 'fighting', 'resting'].includes(row.activity)) return false;
        const held = jsonObject(row.statsJson).travel;
        if (held?.meetingId === meeting.id) return false;
        const at = now();
        const Trip = require('./GameServer/Bot/Population/ColdTrip');
        const leg = receipt.legId.split(':');
        const coords = leg.slice(1).map(Number);
        const target = ['walk', 'gk', 'soe'].includes(leg[0]) && coords.length === 3 && coords.every(Number.isFinite)
            ? { locX: coords[0], locY: coords[1], locZ: coords[2] }
            : { locX: meeting.locX, locY: meeting.locY, locZ: meeting.locZ };
        // Legacy outbound receipts paid the complete route already. Recovery
        // walks from the committed position; it never buys that route again.
        const method = leg[0] === 'gk' || leg[0] === 'soe' ? 'soe_gatekeeper' : 'walk';
        const durationMs = leg[0] === 'gk' ? Trip.HOP_MS : leg[0] === 'soe'
            ? require('./GameServer/Bot/Travel/TripPayment').SCROLL_CAST_MS
            : Trip.runMs(row, target);
        const travel = { from: { locX: row.locX, locY: row.locY, locZ: row.locZ },
            to: target,
            townName: meeting.town, regionName: meeting.town, arrivalActivity: 'shopping', arrivalEvent: 'trade_meeting_arrival',
            method, reason: 'trade_meeting', meetingId: meeting.id, meetingRevision: meeting.revision,
            startedAt: at, arrivalAt: at + Math.max(1000, durationMs), paid: { fee: receipt.fee, ...(receipt.scroll ? { scroll: 736 } : {}) } };
        write("UPDATE bot_life_state SET activity='traveling',activityStartedAt=?,nextResolveAt=?,statsJson=json_patch(COALESCE(statsJson,'{}'),json(?)) WHERE characterId=?", [at, travel.arrivalAt, JSON.stringify({ travel }), id]);
        return true;
    },
    snapshot: (id, changed, patch) => {
        const row = one('SELECT * FROM bot_life_state WHERE characterId=?', [id]);
        if (!row) return null;
        if (row.phase === 'cold') return writeColdInventorySnapshotUnsafe(id, row, changed, null, patch);
        write("UPDATE bot_life_state SET statsJson=json_patch(COALESCE(statsJson,'{}'),json(?)),simulationRevision=simulationRevision+1 WHERE characterId=?", [JSON.stringify(patch), id]);
        return normalizeRow(coldSimulationRow(id));
    }
});
function tradeMeetingPositionUnsafe(id) {
    const session = invoke('GameServer/World/World').registeredActorById(id)?.session;
    if (session) {
        const actor = session.actor;
        return { characterId: id, locX: actor.fetchLocX(), locY: actor.fetchLocY(), locZ: actor.fetchLocZ(),
            alive: !actor.isDead(), available: !session.pendingActorTeleport && !actor.state?.fetchAttacks?.() && !actor.state?.fetchCasts?.() };
    }
    const row = one('SELECT * FROM bot_life_state WHERE characterId=?', [id]);
    // A player's persisted position is never proof of a current session.
    if (!row || row.phase !== 'cold') return null;
    return { characterId: id, locX: row.locX, locY: row.locY, locZ: row.locZ,
        alive: Number(row.hp) > 0 && row.activity !== 'dead',
        available: !['traveling', 'fighting', 'dead'].includes(row.activity) };
}
function withTradeMeetingFlush(id, work, label) {
    return inTransaction(() => TradeMeetings.meeting(Number(id)), `${label}:owners`).then(row => {
        const apply = () => inTransaction(work, label);
        return row ? withCharacterFlushes([row.actorA, row.actorB], apply) : apply();
    });
}
Object.assign(Database, {
    migrateConditionalTradeAds(ownerId) {
        return withCharacterFlush(ownerId, () => inTransaction(() => {
            const rows = all("SELECT * FROM afk_trade_shops WHERE ownerId=? AND custodyPolicy=0 AND kind IN ('buy_ad','sell_ad') ORDER BY id", [ownerId]);
            if (!isBotOwnerUnsafe(ownerId)) return { migrated: 0 };
            for (const row of rows) {
                const lines = all('SELECT * FROM afk_trade_lines WHERE shopId=? ORDER BY id', [row.id]);
                if (row.storeType === BoardRules.SELL) for (const line of lines) {
                    creditRecordOwnerUnsafe(ownerId, line, line.count);
                    // Journal observes release under the old custody policy.
                    write('UPDATE afk_trade_lines SET count=0 WHERE id=?', [line.id]);
                }
                creditRecordOwnerUnsafe(ownerId, { selfId: 57 }, row.escrowAdena);
                write('UPDATE afk_trade_shops SET custodyPolicy=1,escrowAdena=0,revision=revision+1 WHERE id=?', [row.id]);
                for (const line of lines) write('UPDATE afk_trade_lines SET count=?,intentJson=NULL,intentRevision=-1 WHERE id=?', [line.count, line.id]);
            }
            const life = one('SELECT * FROM bot_life_state WHERE characterId=?', [ownerId]);
            const fenced = rows.length && life ? writeColdInventorySnapshotUnsafe(ownerId, life, [], null, { tradeIntentDirty: true }) : null;
            return { migrated: rows.length, row: fenced };
        }, 'board:intent-migration'));
    },
    fetchConditionalMigrationOwners() {
        return inTransaction(() => all(`SELECT DISTINCT shops.ownerId FROM afk_trade_shops shops JOIN characters c ON c.id=shops.ownerId
            WHERE shops.custodyPolicy=0 AND shops.kind IN ('buy_ad','sell_ad') AND substr(c.username,1,4)='bot_'
            ORDER BY shops.ownerId LIMIT 32`).map(row => row.ownerId), 'board:intent-migration-page');
    },
    fetchAfkTradeShop(id) { return inTransaction(() => afkTradeShopUnsafe(Number(id)), 'board:record-read'); },
    prepareTradeParticipant(id) {
        return withCharacterFlush(id, () => inTransaction(() => {
            const slot = TradeMeetings.participant(Number(id)), row = one('SELECT * FROM bot_life_state WHERE characterId=?', [id]);
            return { sequence: slot.nextSequence, meetingId: slot.meetingId, anchor: TradeMeetings.anchor(Number(id)), revision: Number(row?.simulationRevision || 0),
                phase: row?.phase || 'player', ownerId: row?.simulationOwner || null,
                leaseId: row?.simulationLeaseId || null, hotAt: Number(row?.lastHotAt || 0),
                needRevision: Number(row?.simulationRevision || 0),
                inventory: afkTradeInventoryUnsafe(id), acceptedIncoming: acceptedTradeIncomingUnsafe(Number(id), row),
                position: tradeMeetingPositionUnsafe(Number(id)) };
        }, 'board:meeting-prepare'));
    },
    acceptTradeMeeting(request, preparation) {
        return withCharacterFlushes([request.actorA, request.actorB], () => inTransaction(() => TradeMeetings.accept(request, preparation), 'board:meeting-accept'));
    },
    fetchTradeMeetingByToken(token) {
        return inTransaction(() => one('SELECT * FROM board_trade_meetings WHERE token=?', [String(token)]), 'board:meeting-replay');
    },
    fetchTradeMeetingReceipt(token, actorId) {
        return inTransaction(() => {
            const slot = one('SELECT lastReceipt FROM board_trade_participants WHERE characterId=?', [Number(actorId)]);
            const receipt = slot?.lastReceipt && JSON.parse(slot.lastReceipt);
            if (!receipt || receipt[0] !== token) return null;
            return { pending: false, meetingId: receipt[1], revision: receipt[2],
                outcome: receipt[3] ? 'completed' : 'cancelled' };
        }, 'board:meeting-receipt');
    },
    fetchTradeMeetingOwnerState(actorId) {
        return inTransaction(() => normalizeRow(coldSimulationRow(actorId)), 'board:meeting-owner-state');
    },
    fetchTradeMeeting(id) { return inTransaction(() => TradeMeetings.meeting(Number(id)), 'board:meeting-read'); },
    fetchTradeMeetingsForOwner(id) { return inTransaction(() => TradeMeetings.active(Number(id)), 'board:meeting-owner-group'); },
    fetchTradeMeetingForOwner(id) {
        return inTransaction(() => { const slot = one('SELECT meetingId FROM board_trade_participants WHERE characterId=?', [id]);
            return slot?.meetingId ? TradeMeetings.meeting(slot.meetingId) : null; }, 'board:meeting-owner');
    },
    payTradeMeetingLeg(id, side, sequence, legId, fee, scroll) {
        return withTradeMeetingFlush(id, () => TradeMeetings.leg(Number(id), side, sequence, legId, fee, scroll), 'board:meeting-leg');
    },
    acknowledgeTradeMeetingLeg(id, side, sequence) {
        return inTransaction(() => {
            const row = TradeMeetings.meeting(Number(id)), suffix = side === 0 ? 'A' : side === 1 ? 'B' : null;
            if (!row || !suffix) return null;
            const receipt = jsonObject(row[`leg${suffix}`]);
            if (receipt.sequence !== sequence) throw Error('trade_meeting_leg_changed');
            write(`UPDATE board_trade_meetings SET leg${suffix}=NULL WHERE id=?`, [id]);
            return { acknowledged: true };
        }, 'board:meeting-leg-ack');
    },
    arriveTradeMeeting(id) {
        return withTradeMeetingFlush(id, () => { const row = TradeMeetings.meeting(Number(id));
            return row ? TradeMeetings.present(row.id, [tradeMeetingPositionUnsafe(row.actorA), tradeMeetingPositionUnsafe(row.actorB)]) : null;
        }, 'board:meeting-arrival');
    },
    cancelTradeMeeting(id, reason) { return withTradeMeetingFlush(id, () => TradeMeetings.terminal(Number(id), false, reason), 'board:meeting-cancel'); },
    acknowledgeTradeMeeting(id, actor) { return withCharacterFlush(actor, () => inTransaction(() => TradeMeetings.acknowledge(Number(id), Number(actor)), 'board:meeting-ack')); },
    recoverTradeMeetings(afterId = 0) { return inTransaction(() => all('SELECT id,actorA,actorB,state FROM board_trade_meetings WHERE id>? ORDER BY id LIMIT 32', [afterId]), 'board:meeting-recover'); }
});

module.exports = Database;
