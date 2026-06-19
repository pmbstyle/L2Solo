const Database = invoke('Database');
const Metrics  = invoke('GameServer/Bot/Population/PopulationMetrics');

const TABLE = 'bot_life_state';
const cache = new Map();
const pendingWrites = new Map();
let initialized = false;
let initStarted = false;
let initPromise = null;

function now() {
    return Date.now();
}

function safeJson(value) {
    return JSON.stringify(value || {});
}

function parseJson(raw, fallback = {}) {
    if (!raw) return fallback;
    try {
        return JSON.parse(raw);
    } catch (err) {
        return fallback;
    }
}

function actorLocation(actor) {
    return {
        locX: actor.fetchLocX(),
        locY: actor.fetchLocY(),
        locZ: actor.fetchLocZ()
    };
}

function actorVitals(actor) {
    return {
        hp: actor.fetchHp(),
        maxHp: actor.fetchMaxHp(),
        mp: actor.fetchMp(),
        maxMp: actor.fetchMaxMp()
    };
}

function levelBand(level) {
    const value = Number(level || 1);
    return `${Math.max(1, value - 2)}-${value + 2}`;
}

function normalize(row) {
    const stats = parseJson(row.statsJson, {});
    const inventory = parseJson(row.inventorySummary, {});

    return {
        characterId: Number(row.characterId),
        accountName: row.accountName || '',
        name: row.characterName || '',
        phase: row.phase || 'cold',
        activity: row.activity || 'hunting',
        homeRegion: row.homeRegion || null,
        currentRegion: row.currentRegion || null,
        spotId: row.spotId || null,
        loc: {
            locX: Number(row.locX || 0),
            locY: Number(row.locY || 0),
            locZ: Number(row.locZ || 0)
        },
        vitals: {
            hp: Number(row.hp || 0),
            maxHp: Number(row.maxHp || 0),
            mp: Number(row.mp || 0),
            maxMp: Number(row.maxMp || 0)
        },
        levelBand: row.targetLevelBand || null,
        timing: {
            activityStartedAt: row.activityStartedAt ? Number(row.activityStartedAt) : null,
            nextResolveAt: row.nextResolveAt ? Number(row.nextResolveAt) : null,
            lastResolvedAt: row.lastResolvedAt ? Number(row.lastResolvedAt) : null,
            lastHotAt: row.lastHotAt ? Number(row.lastHotAt) : null
        },
        party: {
            partyId: row.partyId || null,
            role: stats.role || null,
            leaderId: stats.leaderId || null
        },
        stats,
        inventory,
        updatedAt: Number(row.updatedAt || 0)
    };
}

function recordFromSession(session, phase, reason = '') {
    const actor = session.actor;
    const loc = actorLocation(actor);
    const vitals = actorVitals(actor);
    const currentSpot = session.currentSpot || null;
    const timestamp = now();
    const characterId = Number(actor.fetchId());
    const stats = {
        role: session.botStatus?.role || null,
        leaderId: session.followPlayerSession?.actor?.fetchId ? Number(session.followPlayerSession.actor.fetchId()) : null,
        lastReason: reason
    };

    return {
        characterId,
        accountName: session.accountId || '',
        characterName: actor.fetchName(),
        homeRegion: session.homeRegion || null,
        currentRegion: session.homeRegion || null,
        spotId: currentSpot?.id || null,
        activity: session.plan || 'hunting',
        phase,
        activityStartedAt: timestamp,
        nextResolveAt: null,
        lastResolvedAt: null,
        lastHotAt: phase === 'hot' ? timestamp : null,
        locX: loc.locX,
        locY: loc.locY,
        locZ: loc.locZ,
        hp: vitals.hp,
        maxHp: vitals.maxHp,
        mp: vitals.mp,
        maxMp: vitals.maxMp,
        targetLevelBand: levelBand(actor.fetchLevel()),
        deathCount: 0,
        partyId: null,
        inventorySummary: safeJson({}),
        statsJson: safeJson(stats),
        updatedAt: timestamp
    };
}

function save(row) {
    return Database.execute([
        `INSERT INTO ${TABLE} (
            characterId, accountName, characterName, homeRegion, currentRegion,
            spotId, activity, phase, activityStartedAt, nextResolveAt,
            lastResolvedAt, lastHotAt, locX, locY, locZ, hp, maxHp, mp, maxMp,
            targetLevelBand, deathCount, partyId, inventorySummary, statsJson, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
            accountName = VALUES(accountName),
            characterName = VALUES(characterName),
            homeRegion = VALUES(homeRegion),
            currentRegion = VALUES(currentRegion),
            spotId = VALUES(spotId),
            activity = VALUES(activity),
            phase = VALUES(phase),
            lastHotAt = VALUES(lastHotAt),
            locX = VALUES(locX),
            locY = VALUES(locY),
            locZ = VALUES(locZ),
            hp = VALUES(hp),
            maxHp = VALUES(maxHp),
            mp = VALUES(mp),
            maxMp = VALUES(maxMp),
            targetLevelBand = VALUES(targetLevelBand),
            partyId = VALUES(partyId),
            statsJson = VALUES(statsJson),
            updatedAt = VALUES(updatedAt)`,
        [
            row.characterId,
            row.accountName,
            row.characterName,
            row.homeRegion,
            row.currentRegion,
            row.spotId,
            row.activity,
            row.phase,
            row.activityStartedAt,
            row.nextResolveAt,
            row.lastResolvedAt,
            row.lastHotAt,
            row.locX,
            row.locY,
            row.locZ,
            row.hp,
            row.maxHp,
            row.mp,
            row.maxMp,
            row.targetLevelBand,
            row.deathCount,
            row.partyId,
            row.inventorySummary,
            row.statsJson,
            row.updatedAt
        ]
    ]).then((result) => {
        Metrics.recordDbFlush();
        return result;
    });
}

const BotLifeState = {
    init() {
        if (initialized) return Promise.resolve(true);
        if (initStarted) return initPromise;
        initStarted = true;

        initPromise = Database.execute([
            `CREATE TABLE IF NOT EXISTS ${TABLE} (
                characterId INT NOT NULL,
                accountName VARCHAR(16) NOT NULL DEFAULT '',
                characterName VARCHAR(35) NOT NULL DEFAULT '',
                homeRegion VARCHAR(64) NULL,
                currentRegion VARCHAR(64) NULL,
                spotId VARCHAR(32) NULL,
                activity VARCHAR(32) NOT NULL DEFAULT 'hunting',
                phase VARCHAR(16) NOT NULL DEFAULT 'cold',
                activityStartedAt BIGINT NULL,
                nextResolveAt BIGINT NULL,
                lastResolvedAt BIGINT NULL,
                lastHotAt BIGINT NULL,
                locX INT NOT NULL DEFAULT 0,
                locY INT NOT NULL DEFAULT 0,
                locZ INT NOT NULL DEFAULT 0,
                hp INT NOT NULL DEFAULT 0,
                maxHp INT NOT NULL DEFAULT 0,
                mp INT NOT NULL DEFAULT 0,
                maxMp INT NOT NULL DEFAULT 0,
                targetLevelBand VARCHAR(16) NULL,
                deathCount INT NOT NULL DEFAULT 0,
                partyId VARCHAR(64) NULL,
                inventorySummary TEXT NULL,
                statsJson TEXT NULL,
                updatedAt BIGINT NOT NULL DEFAULT 0,
                PRIMARY KEY (characterId),
                INDEX phase_nextResolveAt (phase, nextResolveAt),
                INDEX accountName (accountName)
            )`,
            []
        ]).then(() => {
            initialized = true;
            utils.infoSuccess('BotLife', 'state table ready');
            return true;
        }).catch((err) => {
            utils.infoWarn('BotLife', 'state table unavailable: %s', err.message);
            return false;
        });

        return initPromise;
    },

    markHot(session, reason = 'hot') {
        if (!session || !session.actor) return Promise.resolve(null);

        const row = recordFromSession(session, 'hot', reason);
        const characterId = row.characterId;
        const previous = pendingWrites.get(characterId) || Promise.resolve();
        const ready = initialized ? Promise.resolve(true) : this.init();
        const next = previous.then(() => ready).then((isReady) => {
            if (!isReady) {
                throw new Error('state table unavailable');
            }
            return save(row);
        }).then(() => {
            const snapshot = normalize(row);
            cache.set(characterId, snapshot);
            return snapshot;
        }).catch((err) => {
            utils.infoWarn('BotLife', 'failed to mark %s hot: %s', row.characterName, err.message);
            return null;
        });

        const tracked = next.finally(() => {
            if (pendingWrites.get(characterId) === tracked) {
                pendingWrites.delete(characterId);
            }
        });
        pendingWrites.set(characterId, tracked);
        return next;
    },

    snapshot(characterId) {
        return cache.get(Number(characterId)) || null;
    },

    counts() {
        const counts = { cold: 0, warm: 0, hot: 0, total: 0 };
        cache.forEach((state) => {
            if (counts[state.phase] === undefined) counts[state.phase] = 0;
            counts[state.phase] += 1;
            counts.total += 1;
        });
        return counts;
    }
};

module.exports = BotLifeState;
