const Database = invoke('Database');

const MAX_TEXT_CHARS = 240;
const memory = [];
let memorySequence = 0;
let schemaPromise = null;

function id(value) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function text(value, max = MAX_TEXT_CHARS) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function databaseReady() {
    return typeof Database.isReady === 'function' && Database.isReady();
}

function ensureSchema() {
    if (!databaseReady()) return Promise.resolve(false);
    if (!schemaPromise) {
        schemaPromise = Database.execute([
            'SELECT 1 FROM bot_tool_outcomes LIMIT 1',
            []
        ], 'schema:bot-tool-outcomes').then(() => true).catch(() => false);
    }
    return schemaPromise;
}

function normalizeMeta(value) {
    if (!value) return null;
    try { return JSON.parse(JSON.stringify(value)); } catch (_) { return null; }
}

async function record(input = {}) {
    const botId = id(input.botId);
    if (!botId) return { ok: false, reason: 'invalid_bot' };

    const event = {
        id: ++memorySequence,
        playerId: id(input.playerId),
        botId,
        turnId: text(input.turnId, 128) || null,
        toolName: text(input.toolName, 64),
        outcome: text(input.outcome, 32),
        reason: text(input.reason, 160),
        worldRevision: text(input.worldRevision, 160) || null,
        createdAt: Number(input.createdAt || Date.now()),
        meta: normalizeMeta(input.meta)
    };
    if (!event.toolName || !event.outcome) return { ok: false, reason: 'invalid_outcome' };

    if (databaseReady() && await ensureSchema()) {
        try {
            const result = await Database.execute([
                `INSERT INTO bot_tool_outcomes
                 (playerId, botId, turnId, toolName, outcome, reason, worldRevision, createdAt, metaJson)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    event.playerId,
                    event.botId,
                    event.turnId,
                    event.toolName,
                    event.outcome,
                    event.reason,
                    event.worldRevision,
                    event.createdAt,
                    event.meta ? JSON.stringify(event.meta).slice(0, 1200) : null
                ]
            ], 'bot-tool-outcome:insert');
            event.id = Number(result.insertId || event.id);
            return { ok: true, event };
        } catch (_) {
            // Keep the audit event available during a transient database outage.
        }
    }

    memory.push(event);
    while (memory.length > 4000) memory.shift();
    return { ok: true, event };
}

const BotToolAudit = {
    ensureSchema,
    record,
    recent(input = {}) {
        const botId = id(input.botId);
        const limit = Math.max(1, Math.min(100, Number(input.limit || 20)));
        return memory
            .filter((event) => !botId || event.botId === botId)
            .slice(-limit)
            .map((event) => ({ ...event, meta: event.meta ? { ...event.meta } : null }));
    },
    resetMemory() {
        memory.length = 0;
        memorySequence = 0;
        schemaPromise = null;
    }
};

module.exports = BotToolAudit;
