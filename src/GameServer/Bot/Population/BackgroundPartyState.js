const Database = invoke('Database');

const TABLE = 'bot_background_parties';
const cache = new Map();
let initialized = false;
let initStarted = false;
let initPromise = null;

function now() {
    return Date.now();
}

function safeJson(value) {
    return JSON.stringify(value || {});
}

function parseJson(raw, fallback) {
    if (!raw) return fallback;
    try {
        return JSON.parse(raw);
    } catch (err) {
        return fallback;
    }
}

function normalize(row) {
    return {
        partyId: row.partyId || '',
        leaderId: Number(row.leaderId || 0),
        memberIds: parseJson(row.memberIdsJson, []).map((id) => Number(id)).filter(Boolean),
        spotId: row.spotId || null,
        startedAt: Number(row.startedAt || 0),
        nextResolveAt: row.nextResolveAt ? Number(row.nextResolveAt) : null,
        cohesion: Number(row.cohesion || 0),
        risk: Number(row.risk || 0),
        status: row.status || 'active',
        roleCoverage: parseJson(row.roleCoverageJson, {}),
        stats: parseJson(row.statsJson, {}),
        updatedAt: Number(row.updatedAt || 0)
    };
}

function rowFromParty(party) {
    const timestamp = now();
    return {
        partyId: party.partyId,
        leaderId: Number(party.leaderId || party.memberIds?.[0] || 0),
        memberIdsJson: safeJson((party.memberIds || []).map((id) => Number(id)).filter(Boolean)),
        spotId: party.spotId || null,
        startedAt: party.startedAt || timestamp,
        nextResolveAt: party.nextResolveAt || null,
        cohesion: Number(party.cohesion ?? 0.65),
        risk: Number(party.risk ?? 0.25),
        status: party.status || 'active',
        roleCoverageJson: safeJson(party.roleCoverage || {}),
        statsJson: safeJson(party.stats || {}),
        updatedAt: timestamp
    };
}

function save(row) {
    return Database.execute([
        `INSERT INTO ${TABLE} (
            partyId, leaderId, memberIdsJson, spotId, startedAt, nextResolveAt,
            cohesion, risk, status, roleCoverageJson, statsJson, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
            leaderId = VALUES(leaderId),
            memberIdsJson = VALUES(memberIdsJson),
            spotId = VALUES(spotId),
            nextResolveAt = VALUES(nextResolveAt),
            cohesion = VALUES(cohesion),
            risk = VALUES(risk),
            status = VALUES(status),
            roleCoverageJson = VALUES(roleCoverageJson),
            statsJson = VALUES(statsJson),
            updatedAt = VALUES(updatedAt)`,
        [
            row.partyId,
            row.leaderId,
            row.memberIdsJson,
            row.spotId,
            row.startedAt,
            row.nextResolveAt,
            row.cohesion,
            row.risk,
            row.status,
            row.roleCoverageJson,
            row.statsJson,
            row.updatedAt
        ]
    ]);
}

const BackgroundPartyState = {
    init() {
        if (initialized) return Promise.resolve(true);
        if (initStarted) return initPromise;
        initStarted = true;

        initPromise = Database.execute([
            `CREATE TABLE IF NOT EXISTS ${TABLE} (
                partyId VARCHAR(64) NOT NULL,
                leaderId INT NOT NULL DEFAULT 0,
                memberIdsJson TEXT NULL,
                spotId VARCHAR(32) NULL,
                startedAt BIGINT NOT NULL DEFAULT 0,
                nextResolveAt BIGINT NULL,
                cohesion DECIMAL(5,4) NOT NULL DEFAULT 0.6500,
                risk DECIMAL(5,4) NOT NULL DEFAULT 0.2500,
                status VARCHAR(16) NOT NULL DEFAULT 'active',
                roleCoverageJson TEXT NULL,
                statsJson TEXT NULL,
                updatedAt BIGINT NOT NULL DEFAULT 0,
                PRIMARY KEY (partyId),
                INDEX status_nextResolveAt (status, nextResolveAt),
                INDEX spotId (spotId)
            )`,
            []
        ]).then(() => this.loadActive()).then(() => {
            initialized = true;
            utils.infoSuccess('BotParty', 'background party table ready');
            return true;
        }).catch((err) => {
            utils.infoWarn('BotParty', 'background party table unavailable: %s', err.message);
            return false;
        });

        return initPromise;
    },

    loadActive() {
        return Database.execute([
            `SELECT * FROM ${TABLE} WHERE status = 'active'`,
            []
        ]).then((rows) => {
            cache.clear();
            rows.map((row) => normalize(row)).forEach((party) => {
                cache.set(party.partyId, party);
            });
            return Array.from(cache.values());
        });
    },

    createOrUpdate(party) {
        if (!party?.partyId || !party.memberIds?.length) return Promise.resolve(null);
        const ready = initialized ? Promise.resolve(true) : this.init();

        return ready.then((isReady) => {
            if (!isReady) return null;
            const row = rowFromParty(party);
            return save(row).then(() => {
                const snapshot = normalize(row);
                cache.set(snapshot.partyId, snapshot);
                return snapshot;
            });
        }).catch((err) => {
            utils.infoWarn('BotParty', 'failed to save background party %s: %s', party.partyId, err.message);
            return null;
        });
    },

    find(partyId) {
        return cache.get(String(partyId || '')) || null;
    },

    active() {
        return Array.from(cache.values()).filter((party) => party.status === 'active');
    },

    due(limit = 10, at = now()) {
        if (!initialized) return Promise.resolve([]);
        const safeLimit = Math.max(1, Math.min(100, Number(limit) || 10));

        return Database.execute([
            `SELECT * FROM ${TABLE}
            WHERE status = 'active'
            AND (nextResolveAt IS NULL OR nextResolveAt <= ?)
            ORDER BY COALESCE(nextResolveAt, 0) ASC
            LIMIT ${safeLimit}`,
            [at]
        ]).then((rows) => rows.map((row) => {
            const party = normalize(row);
            cache.set(party.partyId, party);
            return party;
        })).catch((err) => {
            utils.infoWarn('BotParty', 'failed to fetch due background parties: %s', err.message);
            return [];
        });
    },

    setStatus(partyId, status = 'inactive') {
        const party = this.find(partyId);
        if (!party) return Promise.resolve(null);
        return this.createOrUpdate({ ...party, status });
    },

    counts() {
        const counts = { active: 0, inactive: 0, total: 0 };
        cache.forEach((party) => {
            if (party.status === 'active') counts.active += 1;
            else counts.inactive += 1;
            counts.total += 1;
        });
        return counts;
    }
};

module.exports = BackgroundPartyState;
