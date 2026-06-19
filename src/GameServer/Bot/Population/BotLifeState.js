const Database = invoke('Database');
const Metrics  = invoke('GameServer/Bot/Population/PopulationMetrics');
const DataCache = invoke('GameServer/DataCache');

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

function levelForExp(exp, fallback = 1) {
    const value = Number(exp || 0);
    const table = DataCache.experience || [];
    for (let i = 0; i < table.length - 1; i++) {
        if (value >= table[i] && value < table[i + 1]) {
            return i + 1;
        }
    }
    return fallback;
}

function normalize(row) {
    const stats = parseJson(row.statsJson, {});
    const inventory = parseJson(row.inventorySummary, {});

    return {
        characterId: Number(row.characterId),
        accountName: row.accountName || '',
        name: row.characterName || '',
        level: Number(row.level || 1),
        exp: Number(row.exp || 0),
        sp: Number(row.sp || 0),
        adena: Number(row.adena || 0),
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
        level: actor.fetchLevel(),
        exp: actor.fetchExp() || 0,
        sp: actor.fetchSp() || 0,
        adena: 0,
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

function rowFromState(state) {
    return {
        characterId: state.characterId,
        accountName: state.accountName || '',
        characterName: state.name || '',
        level: Number(state.level || 1),
        exp: Number(state.exp || 0),
        sp: Number(state.sp || 0),
        adena: Number(state.adena || 0),
        homeRegion: state.homeRegion || null,
        currentRegion: state.currentRegion || null,
        spotId: state.spotId || null,
        activity: state.activity || 'hunting',
        phase: state.phase || 'cold',
        activityStartedAt: state.timing?.activityStartedAt || null,
        nextResolveAt: state.timing?.nextResolveAt || null,
        lastResolvedAt: state.timing?.lastResolvedAt || null,
        lastHotAt: state.timing?.lastHotAt || null,
        locX: state.loc?.locX || 0,
        locY: state.loc?.locY || 0,
        locZ: state.loc?.locZ || 0,
        hp: state.vitals?.hp || 0,
        maxHp: state.vitals?.maxHp || 0,
        mp: state.vitals?.mp || 0,
        maxMp: state.vitals?.maxMp || 0,
        targetLevelBand: state.levelBand || levelBand(state.level),
        deathCount: state.stats?.deaths || 0,
        partyId: state.party?.partyId || null,
        inventorySummary: safeJson(state.inventory || {}),
        statsJson: safeJson(state.stats || {}),
        updatedAt: now()
    };
}

function addColumn(name, definition) {
    return Database.execute([
        `ALTER TABLE ${TABLE} ADD COLUMN ${name} ${definition}`,
        []
    ]).catch((err) => {
        if (err.code === 'ER_DUP_FIELDNAME' || err.errno === 1060) return null;
        throw err;
    });
}

function ensureColumns() {
    return Promise.all([
        addColumn('level', 'INT NOT NULL DEFAULT 1 AFTER characterName'),
        addColumn('exp', 'BIGINT NOT NULL DEFAULT 0 AFTER level'),
        addColumn('sp', 'BIGINT NOT NULL DEFAULT 0 AFTER exp'),
        addColumn('adena', 'BIGINT NOT NULL DEFAULT 0 AFTER sp')
    ]);
}

function save(row) {
    return Database.execute([
        `INSERT INTO ${TABLE} (
            characterId, accountName, characterName, level, exp, sp, adena, homeRegion, currentRegion,
            spotId, activity, phase, activityStartedAt, nextResolveAt,
            lastResolvedAt, lastHotAt, locX, locY, locZ, hp, maxHp, mp, maxMp,
            targetLevelBand, deathCount, partyId, inventorySummary, statsJson, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
            accountName = VALUES(accountName),
            characterName = VALUES(characterName),
            level = VALUES(level),
            exp = VALUES(exp),
            sp = VALUES(sp),
            adena = VALUES(adena),
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
            row.level,
            row.exp,
            row.sp,
            row.adena,
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
        ]).then(() => ensureColumns()).then(() => {
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

    dueCold(limit = 10, at = now()) {
        if (!initialized) return Promise.resolve([]);
        const safeLimit = Math.max(1, Math.min(100, Number(limit) || 10));

        return Database.execute([
            `SELECT * FROM ${TABLE}
            WHERE phase = 'cold'
            AND (nextResolveAt IS NULL OR nextResolveAt <= ?)
            ORDER BY COALESCE(nextResolveAt, 0) ASC
            LIMIT ${safeLimit}`,
            [at]
        ]).then((rows) => rows.map((row) => {
            const state = normalize(row);
            cache.set(state.characterId, state);
            return state;
        })).catch((err) => {
            utils.infoWarn('BotLife', 'failed to fetch due cold states: %s', err.message);
            return [];
        });
    },

    applyResolve(state, result) {
        if (!state || !result) return Promise.resolve(null);

        const timestamp = now();
        const exp = Number(state.exp || 0) + Number(result.materialize?.exp || 0);
        const sp = Number(state.sp || 0) + Number(result.materialize?.sp || 0);
        const level = levelForExp(exp, Number(state.level || 1));
        const adena = Number(state.adena || 0) + Number(result.materialize?.adena || 0);
        const stats = {
            ...(state.stats || {}),
            fightsWon: Number(state.stats?.fightsWon || 0) + Number(result.debug?.wins || 0),
            fightsResolved: Number(state.stats?.fightsResolved || 0) + Number(result.debug?.fights || 0),
            deaths: Number(result.patch?.deathCount || state.stats?.deaths || 0),
            expEarned: Number(state.stats?.expEarned || 0) + Number(result.materialize?.exp || 0),
            spEarned: Number(state.stats?.spEarned || 0) + Number(result.materialize?.sp || 0),
            adenaEarned: Number(state.stats?.adenaEarned || 0) + Number(result.materialize?.adena || 0),
            lastResolveDebug: result.debug || null
        };
        const inventory = { ...(state.inventory || {}) };
        (result.materialize?.items || []).forEach((item) => {
            const key = String(item.selfId);
            inventory[key] = {
                selfId: item.selfId,
                name: item.name || inventory[key]?.name || '',
                amount: Number(inventory[key]?.amount || 0) + Number(item.amount || 0)
            };
        });

        const nextState = {
            ...state,
            level,
            exp,
            sp,
            adena,
            phase: 'cold',
            activity: result.patch?.activity || state.activity,
            spotId: result.patch?.spotId || state.spotId,
            vitals: {
                ...(state.vitals || {}),
                ...(result.patch?.vitals || {})
            },
            timing: {
                ...(state.timing || {}),
                lastResolvedAt: timestamp,
                nextResolveAt: result.nextResolveAt || timestamp + 60000
            },
            stats,
            inventory,
            updatedAt: timestamp
        };
        const row = rowFromState(nextState);

        return save(row)
            .then(() => Database.updateCharacterExperience(row.characterId, row.level, row.exp, row.sp))
            .then(() => Database.updateCharacterVitals(row.characterId, row.hp, row.maxHp, row.mp, row.maxMp))
            .then(() => {
                const snapshot = normalize(row);
                cache.set(snapshot.characterId, snapshot);
                return snapshot;
            })
            .catch((err) => {
                utils.infoWarn('BotLife', 'failed to apply resolve for %s: %s', state.name, err.message);
                return null;
            });
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
