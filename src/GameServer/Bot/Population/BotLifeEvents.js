const Database = invoke('Database');

const TABLE = 'bot_life_events';
const MAX_EVENTS_PER_BOT = 20;
let initialized = false;
let initStarted = false;
let initPromise = null;

function now() {
    return Date.now();
}

function safeJson(value) {
    return JSON.stringify(value || {});
}

const BotLifeEvents = {
    init() {
        if (initialized) return Promise.resolve(true);
        if (initStarted) return initPromise;
        initStarted = true;

        initPromise = Database.execute([
            `CREATE TABLE IF NOT EXISTS ${TABLE} (
                id BIGINT NOT NULL AUTO_INCREMENT,
                characterId INT NOT NULL,
                eventType VARCHAR(32) NOT NULL,
                summary VARCHAR(255) NOT NULL DEFAULT '',
                weight INT NOT NULL DEFAULT 1,
                createdAt BIGINT NOT NULL DEFAULT 0,
                metaJson TEXT NULL,
                PRIMARY KEY (id),
                INDEX characterId_createdAt (characterId, createdAt)
            )`,
            []
        ]).then(() => {
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
            return Database.execute([
                `INSERT INTO ${TABLE} (characterId, eventType, summary, weight, createdAt, metaJson)
                VALUES (?, ?, ?, ?, ?, ?)`,
                [characterId, eventType, String(summary).slice(0, 255), weight, now(), safeJson(meta)]
            ]);
        }).then((result) => {
            this.prune(characterId);
            return result;
        }).catch((err) => {
            utils.infoWarn('BotLife', 'failed to record life event: %s', err.message);
            return null;
        });
    },

    recordMany(characterId, events = []) {
        return Promise.all(events.map((event) => (
            this.record(characterId, event.type, event.summary, event.meta, event.weight)
        )));
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
