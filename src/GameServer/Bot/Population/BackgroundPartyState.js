const Database = invoke('Database');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');

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

function rotationExpiry(partyId, startedAt) {
    const maxAge = Math.max(0, Number(Config.partySessionMaxMs) || 0);
    const jitter = Math.min(maxAge, Math.max(0, Number(Config.partySessionJitterMs) || 0));
    if (!maxAge || !startedAt) return 0;
    let hash = 0;
    for (const char of String(partyId || '')) hash = ((hash * 31) + char.charCodeAt(0)) | 0;
    const span = jitter * 2 + 1;
    const offset = jitter ? Math.abs(hash) % span - jitter : 0;
    return Number(startedAt) + maxAge + offset;
}

function normalizeMembership(party = {}) {
    const memberIds = Array.from(new Set((party.memberIds || [])
        .map((id) => Number(id))
        .filter(Boolean)));
    const requestedLeaderId = Number(party.leaderId || 0);
    const leaderId = memberIds.includes(requestedLeaderId)
        ? requestedLeaderId
        : Number(memberIds[0] || 0);
    return { leaderId, memberIds };
}

function normalize(row) {
    const startedAt = Number(row.startedAt || 0);
    const stats = parseJson(row.statsJson, {});
    if (row.status === 'active' && startedAt && !Number(stats.sessionExpiresAt || 0)) {
        stats.sessionExpiresAt = rotationExpiry(row.partyId, startedAt);
    }
    const membership = normalizeMembership({
        leaderId: row.leaderId,
        memberIds: parseJson(row.memberIdsJson, [])
    });
    return {
        partyId: row.partyId || '',
        leaderId: membership.leaderId,
        memberIds: membership.memberIds,
        spotId: row.spotId || null,
        startedAt,
        nextResolveAt: row.nextResolveAt ? Number(row.nextResolveAt) : null,
        cohesion: Number(row.cohesion || 0),
        risk: Number(row.risk || 0),
        status: row.status || 'active',
        roleCoverage: parseJson(row.roleCoverageJson, {}),
        stats,
        updatedAt: Number(row.updatedAt || 0)
    };
}

function rowFromParty(party) {
    const timestamp = now();
    const membership = normalizeMembership(party);
    return {
        partyId: party.partyId,
        leaderId: membership.leaderId,
        memberIdsJson: safeJson(membership.memberIds),
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
            updatedAt = excluded.updatedAt`,
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

        initPromise = Database.execute(['SELECT 1', []], 'schema:bot-parties').then(() => this.loadActive()).then(() => {
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

    purgeHistory(limit = Config.partyHistoryCleanupBatchSize, timestamp = now()) {
        if (!initialized) return Promise.resolve(0);
        const retentionMs = Math.max(0, Number(Config.partyHistoryRetentionMs) || 0);
        if (!retentionMs) return Promise.resolve(0);
        const safeLimit = Math.max(1, Math.min(5000, Number(limit) || 1000));
        const cutoff = Math.max(0, Number(timestamp) - retentionMs);
        return Database.execute([
            `DELETE FROM ${TABLE}
             WHERE partyId IN (
                SELECT parties.partyId FROM ${TABLE} parties
                WHERE status <> 'active'
                  AND parties.updatedAt <= ?
                  AND NOT EXISTS (
                      SELECT 1 FROM bot_life_state life
                      WHERE life.partyId = parties.partyId
                  )
                ORDER BY parties.updatedAt ASC
                LIMIT ${safeLimit}
             )`,
            [cutoff]
        ]).then((result) => {
            const deleted = Number(result?.affectedRows || 0);
            if (deleted > 0) {
                utils.infoWarn('BotParty', 'purged %d dissolved background party history row(s)', deleted);
            }
            return deleted;
        }).catch((err) => {
            utils.infoWarn('BotParty', 'failed to purge dissolved background party history: %s', err.message);
            return 0;
        });
    },

    createOrUpdate(party) {
        const prepared = this.prepareCommit(party);
        if (!prepared) return Promise.resolve(null);
        const ready = initialized ? Promise.resolve(true) : this.init();

        return ready.then((isReady) => {
            if (!isReady) return null;
            return save(prepared.row).then(() => {
                this.acceptCommit(prepared);
                return prepared.snapshot;
            });
        }).catch((err) => {
            utils.infoWarn('BotParty', 'failed to save background party %s: %s', prepared.snapshot.partyId, err.message);
            return null;
        });
    },

    prepareCommit(party) {
        const membership = normalizeMembership(party);
        const status = party?.status || 'active';
        if (!party?.partyId || (status === 'active' && !membership.memberIds.length)) return null;
        const normalizedParty = { ...party, ...membership };
        if (status === 'active' && membership.memberIds.length < Config.partyMinSize) return null;
        const row = rowFromParty(normalizedParty);
        return { row, snapshot: normalize(row) };
    },

    acceptCommit(prepared) {
        const snapshot = prepared?.snapshot;
        if (!snapshot?.partyId) return null;
        cache.set(snapshot.partyId, snapshot);
        return snapshot;
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
