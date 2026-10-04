const Database = invoke('Database');

const TABLE = 'bot_life_events';
let initialized = false;
let initStarted = false;
let initPromise = null;

function now() {
    return Date.now();
}

// The events go to the history file through the world outbox. There a
// routine event (rest, hunt) updates the bot's latest one of the same type
// within 30 minutes, and each bot keeps its 20 most telling events
// (HistoryStore APPLY.life_events).
function writeEvents(characterId, events) {
    const createdAt = now();
    return Database.recordHistory('life_events', {
        characterId,
        prune: 'recent',
        events: events.map((event) => ({
            eventType: event.eventType,
            summary: String(event.summary).slice(0, 255),
            weight: event.weight ?? 1,
            createdAt,
            meta: event.meta || {},
            coalesce: true
        }))
    }, 'history:life-events');
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
            return writeEvents(characterId, [{ eventType, summary, meta, weight }]);
        }).catch((err) => {
            utils.infoWarn('BotLife', 'failed to record life event: %s', err.message);
            return null;
        });
    },

    recordMany(characterId, events = []) {
        if (!characterId || !events.length) return Promise.resolve([]);
        const ready = initialized ? Promise.resolve(true) : this.init();
        return ready.then((isReady) => {
            if (!isReady) return [];
            const valid = events.filter((event) => event?.type && event?.summary)
                .map((event) => ({ eventType: event.type, summary: event.summary, meta: event.meta, weight: event.weight }));
            if (!valid.length) return [];
            return writeEvents(characterId, valid).then((outboxId) => valid.map(() => outboxId));
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
            return Database.readHistory([
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
            return Database.readHistory([
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
    }
};

module.exports = BotLifeEvents;
