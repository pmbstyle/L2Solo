const Database = invoke('Database');

const TABLE = 'bot_life_events';
const MAX_EVENTS_PER_BOT = 20;
const ROUTINE_EVENT_WINDOW_MS = 30 * 60 * 1000;
const ROUTINE_EVENT_TYPES = new Set(['rest', 'hunt']);
let initialized = false;
let initStarted = false;
let initPromise = null;

function now() {
    return Date.now();
}

function safeJson(value) {
    return JSON.stringify(value || {});
}

function insertEvent(characterId, eventType, summary, meta, weight, createdAt) {
    return Database.execute([
        `INSERT INTO ${TABLE} (characterId, eventType, summary, weight, createdAt, metaJson)
        VALUES (?, ?, ?, ?, ?, ?)`,
        [characterId, eventType, summary, weight, createdAt, safeJson(meta)]
    ]).then((result) => ({ result, inserted: true, coalesced: false }));
}

function writeEvent(characterId, eventType, summary, meta = {}, weight = 1) {
    const createdAt = now();
    const safeSummary = String(summary).slice(0, 255);
    if (!ROUTINE_EVENT_TYPES.has(eventType)) {
        return insertEvent(characterId, eventType, safeSummary, meta, weight, createdAt);
    }

    return Database.execute([
        `UPDATE ${TABLE}
        SET summary = ?,
            weight = MAX(weight, ?),
            createdAt = ?,
            metaJson = json_set(
                ?, '$.coalescedCount',
                COALESCE(CAST(json_extract(metaJson, '$.coalescedCount') AS INTEGER), 1) + 1
            )
        WHERE id = (
            SELECT id FROM ${TABLE}
            WHERE characterId = ? AND eventType = ? AND createdAt >= ?
            ORDER BY createdAt DESC, id DESC
            LIMIT 1
        )`,
        [safeSummary, weight, createdAt, safeJson(meta), characterId, eventType, createdAt - ROUTINE_EVENT_WINDOW_MS]
    ]).then((result) => {
        if (Number(result?.affectedRows || 0) > 0) return { result, inserted: false, coalesced: true };
        return insertEvent(characterId, eventType, safeSummary, meta, weight, createdAt);
    });
}

const BotLifeEvents = {
    init() {
        if (initialized) return Promise.resolve(true);
        if (initStarted) return initPromise;
        initStarted = true;

        initPromise = Database.execute(['SELECT 1', []], 'schema:bot-life-events').then(() => {
            initialized = true;
            utils.infoSuccess('BotLife', 'events table ready');
            return true;
        }).catch((err) => {
            utils.infoWarn('BotLife', 'events table unavailable: %s', err.message);
            return false;
        });

        return initPromise;
    },

    record(characterId, eventType, summary, meta = {}, weight = 1) {
        if (!characterId || !eventType || !summary) return Promise.resolve(null);
        const ready = initialized ? Promise.resolve(true) : this.init();

        return ready.then((isReady) => {
            if (!isReady) return null;
            return writeEvent(characterId, eventType, summary, meta, weight);
        }).then(async (writeResult) => {
            if (writeResult?.inserted) await this.prune(characterId);
            return writeResult?.result || null;
        }).catch((err) => {
            utils.infoWarn('BotLife', 'failed to record life event: %s', err.message);
            return null;
        });
    },

    recordMany(characterId, events = []) {
        if (!characterId || !events.length) return Promise.resolve([]);
        const ready = initialized ? Promise.resolve(true) : this.init();
        return ready.then(async (isReady) => {
            if (!isReady) return [];
            const results = [];
            let inserted = false;
            for (const event of events) {
                if (!event?.type || !event?.summary) continue;
                const writeResult = await writeEvent(characterId, event.type, event.summary, event.meta, event.weight);
                inserted = inserted || writeResult.inserted;
                results.push(writeResult.result);
            }
            if (inserted) await this.prune(characterId);
            return results;
        }).catch((err) => {
            utils.infoWarn('BotLife', 'failed to record life events: %s', err.message);
            return [];
        });
    },

    recentForBot(characterId, limit = 5) {
        if (!characterId) return Promise.resolve([]);
        const safeLimit = Math.max(1, Math.min(20, Number(limit) || 5));
        const ready = initialized ? Promise.resolve(true) : this.init();

        return ready.then((isReady) => {
            if (!isReady) return [];
            return Database.execute([
                `SELECT eventType, summary, weight, createdAt, metaJson
                FROM ${TABLE}
                WHERE characterId = ?
                ORDER BY createdAt DESC, weight DESC
                LIMIT ${safeLimit}`,
                [characterId]
            ]);
        }).then((rows) => (rows || []).map((row) => ({
            type: row.eventType,
            summary: row.summary,
            weight: Number(row.weight || 1),
            createdAt: Number(row.createdAt || 0)
        }))).catch((err) => {
            utils.infoWarn('BotLife', 'failed to read recent events for %s: %s', characterId, err.message);
            return [];
        });
    },

    recent(limit = 24) {
        const safeLimit = Math.max(1, Math.min(80, Number(limit) || 24));
        const ready = initialized ? Promise.resolve(true) : this.init();

        return ready.then((isReady) => {
            if (!isReady) return [];
            return Database.execute([
                `SELECT characterId, eventType, summary, weight, createdAt
                FROM ${TABLE}
                ORDER BY createdAt DESC, weight DESC
                LIMIT ${safeLimit}`,
                []
            ]);
        }).then((rows) => (rows || []).map((row) => ({
            characterId: Number(row.characterId || 0),
            type: row.eventType,
            summary: row.summary,
            weight: Number(row.weight || 1),
            createdAt: Number(row.createdAt || 0)
        }))).catch((err) => {
            utils.infoWarn('BotLife', 'failed to read recent observer events: %s', err.message);
            return [];
        });
    },

    prune(characterId) {
        return Database.execute([
            `DELETE FROM ${TABLE}
            WHERE characterId = ?
            AND id NOT IN (
                SELECT id FROM (
                    SELECT id FROM ${TABLE}
                    WHERE characterId = ?
                    ORDER BY weight DESC, createdAt DESC
                    LIMIT ${MAX_EVENTS_PER_BOT}
                ) keep_rows
            )`,
            [characterId, characterId]
        ]).catch(() => null);
    }
};

module.exports = BotLifeEvents;
