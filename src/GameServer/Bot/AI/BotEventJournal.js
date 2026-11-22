const FailureLog = require('../../../FailureLog');
const Database = invoke('Database');
const { EVENT_TYPES, COMBAT_EVENT_TYPES } = require('./BotCombatMemory');

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
    return Database.isReady();
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

// Callers fire and forget, so it never rejects: a failure is counted (FailureLog) and the event lost.
function record(input = {}) {
    return recordEvent(input).catch((error) => {
        FailureLog.note('journal.record', error);
        return { ok: false, reason: 'journal_error' };
    });
}

async function recordEvent(input = {}) {
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
        } catch (error) {
            // A transient DB issue must not make a bot lose the event needed for
            // its next hot decision. Keep a bounded in-memory copy instead.
            FailureLog.note('journal.write', error);
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
    async search({ botId, playerId = null, query = '', limit = 6, combatKind = null,
        includeCombat = true, since = 0, before = Number.MAX_SAFE_INTEGER, withParticipant = null,
        matchParticipantNames = false } = {}) {
        const count = Math.max(1, Math.min(12, Math.floor(Number(limit) || 6)));
        const needle = String(query || '').trim().slice(0, 100);
        const participant = numberId(withParticipant);
        const types = EVENT_TYPES[combatKind] || (!includeCombat ? COMBAT_EVENT_TYPES : []);
        const eligible = event => !/^(?:llm_|ambient_mood)/.test(event.eventType)
            && (!types.length || types.includes(event.eventType) === includeCombat)
            && event.updatedAt >= since && event.updatedAt < before
            && (!participant || (Array.isArray(event.meta?.participantIds) && event.meta.participantIds.includes(participant)));
        const typeFilter = types.length ? `AND eventType ${includeCombat ? 'IN' : 'NOT IN'} (${types.map(() => '?').join(', ')})` : '';
        const participantIds = "json_each(CASE WHEN json_valid(metaJson) THEN metaJson ELSE '{}' END, '$.participantIds')";
        const participantFilter = participant ? `AND EXISTS (SELECT 1 FROM
            ${participantIds} WHERE value = ?)` : '';
        const nameMatches = matchParticipantNames && includeCombat && combatKind !== 'raid' && needle ? `, CASE WHEN eventType = ? THEN (
            SELECT json_group_array(id) FROM (
                SELECT c.id FROM ${participantIds} AS participant JOIN characters c ON c.id = participant.value
                WHERE c.name LIKE ? ESCAPE '\\'
                ORDER BY c.name = ? COLLATE NOCASE DESC, c.id
            )) END AS matchedParticipantIds` : '';
        if (databaseReady() && await ensureSchema()) {
            try {
                const escaped = needle.replace(/[\\%_]/g, value => '\\' + value);
                const like = `%${escaped}%`;
                const rows = await Database.execute([`SELECT * FROM (
                    SELECT id, playerId, botId, eventType, summary, weight, dedupeKey, count,
                        createdAt, updatedAt, metaJson ${nameMatches}
                    FROM bot_activity_journal WHERE botId = ? AND (playerId IS ? OR playerId IS NULL)
                    AND eventType NOT GLOB 'llm_*' AND eventType NOT GLOB 'ambient_mood*'
                    AND updatedAt >= ? AND updatedAt < ? ${typeFilter} ${participantFilter}
                    ) WHERE (summary LIKE ? ESCAPE '\\' ${nameMatches ? 'OR json_array_length(matchedParticipantIds) > 0' : ''})
                    ORDER BY updatedAt DESC, id DESC LIMIT ?`,
                [...(nameMatches ? [EVENT_TYPES.pvp[0], like, needle] : []), Number(botId), numberId(playerId),
                    since, before, ...types, ...(participant ? [participant] : []), like, count]], 'bot-activity:search');
                return rows.filter(Boolean).map(row => ({
                    ...normalizeRow(row),
                    ...(row.matchedParticipantIds ? { matchedParticipantIds: JSON.parse(row.matchedParticipantIds) } : {})
                })).reverse();
            } catch (_) { /* The in-memory journal remains a bounded fallback. */ }
        }
        return memory.filter(event => event.botId === Number(botId) &&
            (event.playerId === numberId(playerId) || event.playerId === null) && eligible(event) &&
            event.summary.toLowerCase().includes(needle.toLowerCase()))
            .sort((a, b) => a.updatedAt - b.updatedAt || a.id - b.id).slice(-count).map(copy);
    },
    resetMemory() {
        memory.length = 0;
        memorySequence = 0;
        schemaPromise = null;
    },
    memorySize() { return memory.length; }
};

module.exports = BotEventJournal;
