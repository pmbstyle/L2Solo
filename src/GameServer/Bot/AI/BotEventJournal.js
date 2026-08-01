const Database = invoke('Database');

const DEFAULT_LIMIT = 12;
const DEFAULT_COALESCE_WINDOW_MS = 60 * 1000;
const MAX_SUMMARY_CHARS = 280;
const MAX_META_CHARS = 1200;

const memory = [];
let memorySequence = 0;
let schemaPromise = null;

function numberId(value) {
    const id = Number(value);
    return Number.isInteger(id) && id > 0 ? id : null;
}

function text(value, max = MAX_SUMMARY_CHARS) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeMeta(value) {
    if (!value) return null;
    const source = typeof value === 'object' ? value : (() => {
        try { return JSON.parse(String(value)); } catch (_) { return null; }
    })();
    if (!source) return null;
    try {
        return JSON.parse(JSON.stringify(source));
    } catch (_) {
        return null;
    }
}

function normalizeRow(row) {
    if (!row) return null;
    let meta = null;
    try { meta = row.metaJson ? JSON.parse(row.metaJson) : null; } catch (_) { meta = null; }
    return {
        id: Number(row.id || 0),
        playerId: numberId(row.playerId),
        botId: numberId(row.botId),
        eventType: text(row.eventType, 64),
        summary: text(row.summary),
        weight: Math.max(1, Number(row.weight || 1)),
        dedupeKey: row.dedupeKey ? text(row.dedupeKey, 96) : null,
        count: Math.max(1, Number(row.count || 1)),
        createdAt: Number(row.createdAt || 0),
        updatedAt: Number(row.updatedAt || 0),
        meta
    };
}

function databaseReady() {
    return typeof Database.isReady === 'function' && Database.isReady();
}

function ensureSchema() {
    if (!databaseReady()) return Promise.resolve(false);
    if (!schemaPromise) {
        schemaPromise = Database.execute([
            'SELECT 1 FROM bot_activity_journal LIMIT 1',
            []
        ], 'schema:bot-activity-journal').then(() => true).catch(() => false);
    }
    return schemaPromise;
}

function memoryMatch(input, row, now) {
    return row.botId === input.botId &&
        row.playerId === input.playerId &&
        row.eventType === input.eventType &&
        row.dedupeKey === input.dedupeKey &&
        input.dedupeKey && now - row.updatedAt <= input.coalesceWindowMs;
}

function copy(row) {
    return row ? { ...row, meta: row.meta ? { ...row.meta } : null } : null;
}

async function record(input = {}) {
    const botId = numberId(input.botId);
    if (!botId) return { ok: false, reason: 'invalid_bot' };
    const playerId = numberId(input.playerId);
    const eventType = text(input.eventType, 64);
    const summary = text(input.summary);
    if (!eventType || !summary) return { ok: false, reason: 'invalid_event' };

    const createdAt = Number(input.createdAt || Date.now());
    const dedupeKey = input.dedupeKey ? text(input.dedupeKey, 96) : null;
    const coalesceWindowMs = Math.max(0, Number(input.coalesceWindowMs ?? DEFAULT_COALESCE_WINDOW_MS));
    const weight = Math.max(1, Math.min(10, Number(input.weight || 1)));
    const meta = normalizeMeta(input.meta);
    const normalized = { playerId, botId, eventType, summary, weight, dedupeKey, coalesceWindowMs, createdAt, meta };

    const existingMemory = memory.find((row) => memoryMatch(normalized, row, createdAt));
    if (existingMemory) {
        existingMemory.count += 1;
        existingMemory.summary = summary;
        existingMemory.weight = Math.max(existingMemory.weight, weight);
        existingMemory.updatedAt = createdAt;
        existingMemory.meta = meta || existingMemory.meta;
        return { ok: true, inserted: false, coalesced: true, event: copy(existingMemory) };
    }

    if (databaseReady() && await ensureSchema()) {
        try {
            if (dedupeKey && coalesceWindowMs > 0) {
                const rows = await Database.execute([
                    `SELECT id, playerId, botId, eventType, summary, weight, dedupeKey, count, createdAt, updatedAt, metaJson
                     FROM bot_activity_journal
                     WHERE botId = ? AND playerId IS ? AND eventType = ? AND dedupeKey = ? AND updatedAt >= ?
                     ORDER BY updatedAt DESC LIMIT 1`,
                    [botId, playerId, eventType, dedupeKey, createdAt - coalesceWindowMs]
                ], 'bot-activity:coalesce-find');
                const current = normalizeRow(rows[0]);
                if (current) {
                    await Database.execute([
                        `UPDATE bot_activity_journal
                         SET summary = ?, weight = ?, count = count + 1, updatedAt = ?, metaJson = ?
                         WHERE id = ?`,
                        [summary, weight, createdAt, meta ? JSON.stringify(meta).slice(0, MAX_META_CHARS) : null, current.id]
                    ], 'bot-activity:coalesce-update');
                    current.summary = summary;
                    current.weight = Math.max(current.weight, weight);
                    current.count += 1;
                    current.updatedAt = createdAt;
                    current.meta = meta || current.meta;
                    return { ok: true, inserted: false, coalesced: true, event: current };
                }
            }

            const result = await Database.execute([
                `INSERT INTO bot_activity_journal
                 (playerId, botId, eventType, summary, weight, dedupeKey, count, createdAt, updatedAt, metaJson)
                 VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
                [playerId, botId, eventType, summary, weight, dedupeKey, createdAt, createdAt, meta ? JSON.stringify(meta).slice(0, MAX_META_CHARS) : null]
            ], 'bot-activity:insert');
            const rows = await Database.execute([
                `SELECT id, playerId, botId, eventType, summary, weight, dedupeKey, count, createdAt, updatedAt, metaJson
                 FROM bot_activity_journal WHERE id = ? LIMIT 1`,
                [Number(result.insertId || 0)]
            ], 'bot-activity:insert-row');
            const event = normalizeRow(rows[0]) || {
                id: Number(result.insertId || 0), playerId, botId, eventType, summary, weight,
                dedupeKey, count: 1, createdAt, updatedAt: createdAt, meta
            };
            return { ok: true, inserted: true, event };
        } catch (_) {
            // A transient DB issue must not make a bot lose the event needed for
            // its next hot decision. Keep a bounded in-memory copy instead.
        }
    }

    const event = {
        id: ++memorySequence,
        playerId,
        botId,
        eventType,
        summary,
        weight,
        dedupeKey,
        count: 1,
        createdAt,
        updatedAt: createdAt,
        meta
    };
    memory.push(event);
    while (memory.length > 2000) memory.shift();
    return { ok: true, inserted: true, event: copy(event) };
}

async function recent(input = {}) {
    const botId = numberId(input.botId);
    if (!botId) return [];
    const playerId = numberId(input.playerId);
    const limit = Math.max(1, Math.min(50, Number(input.limit || DEFAULT_LIMIT)));
    if (databaseReady() && await ensureSchema()) {
        try {
            const rows = await Database.execute([
                `SELECT id, playerId, botId, eventType, summary, weight, dedupeKey, count, createdAt, updatedAt, metaJson
                 FROM bot_activity_journal
                 WHERE botId = ? AND (playerId IS ? OR playerId IS NULL)
                 ORDER BY updatedAt DESC, id DESC LIMIT ?`,
                [botId, playerId, limit]
            ], 'bot-activity:recent');
            return rows.map(normalizeRow).filter(Boolean).reverse();
        } catch (_) { /* use memory fallback */ }
    }
    return memory
        .filter((row) => row.botId === botId && (row.playerId === playerId || row.playerId === null))
        .sort((a, b) => b.updatedAt - a.updatedAt || b.id - a.id)
        .slice(0, limit)
        .reverse()
        .map(copy);
}

const BotEventJournal = {
    DEFAULT_LIMIT,
    DEFAULT_COALESCE_WINDOW_MS,
    ensureSchema,
    record,
    recent,
    resetMemory() {
        memory.length = 0;
        memorySequence = 0;
        schemaPromise = null;
    },
    memorySize() { return memory.length; }
};

module.exports = BotEventJournal;
