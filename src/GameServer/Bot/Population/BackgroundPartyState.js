const { fnv1a32 } = require('../Fnv1a');
const Diagnostics = require('../Economy/EconomyDiagnostics');
const Database = invoke('Database');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const BotLifeState = invoke('GameServer/Bot/Population/BotLifeState');
const PartyRisk = require('./PartySpotRiskPolicy');
const TableChannel = require('./ColdTableChannel').shared;
const RaidEncounterScope = invoke('GameServer/RaidBoss/RaidEncounterScope');

const TABLE = 'bot_background_parties';
const cache = new Map();
const acceptedStamps = new Map();
const byStatus = new Map([['active', new Set()], ['hot', new Set()]]);
let cacheGeneration = 0;
const publicationListeners = new Set();
// Active-party indexes kept by the one writer (acceptedParty): by leader, by
// the objective's clan, by the objective's clan goal. `indexed` holds each
// active party's keys and its place in active() (the generation of its last
// change, the order byStatus keeps), so an index read keeps active() order.
const byLeader = new Map();
const byObjectiveClan = new Map();
const byGoalKey = new Map();
const indexed = new Map();
// Raid parties by their boss, kept by the same writer for both admitted
// statuses (active and hot): `raidIndexed` holds each one's key and order.
const byRaidBoss = new Map();
const raidIndexed = new Map();

function addKey(index, key, partyId) {
    if (!key) return;
    let ids = index.get(key);
    if (!ids) index.set(key, ids = new Set());
    ids.add(partyId);
}

function dropKey(index, key, partyId) {
    const ids = index.get(key);
    if (!ids) return;
    ids.delete(partyId);
    if (!ids.size) index.delete(key);
}

function unindex(partyId) {
    const keys = indexed.get(partyId);
    if (!keys) return;
    dropKey(byLeader, keys.leaderId, partyId);
    dropKey(byObjectiveClan, keys.clanId, partyId);
    dropKey(byGoalKey, keys.goalKey, partyId);
    indexed.delete(partyId);
}

function index(snapshot) {
    unindex(snapshot.partyId);
    if (snapshot.status !== 'active') return;
    const objective = snapshot.stats?.objective;
    const keys = { leaderId: Number(snapshot.leaderId) || 0, clanId: Number(objective?.clanId) || 0,
        goalKey: String(objective?.clanGoalKey || ''), order: cacheGeneration };
    addKey(byLeader, keys.leaderId, snapshot.partyId);
    addKey(byObjectiveClan, keys.clanId, snapshot.partyId);
    addKey(byGoalKey, keys.goalKey, snapshot.partyId);
    indexed.set(snapshot.partyId, keys);
}

// The raid boss a party hunts (template id), or 0 when it is no raid party.
function raidBossKey(party) {
    const objective = party?.stats?.objective;
    if (objective?.sourceKind !== 'raid') return 0;
    const bossKey = Number(objective.raidBossTemplateId || objective.npcId);
    return bossKey > 0 ? bossKey : 0;
}

function indexRaid(snapshot) {
    const previous = raidIndexed.get(snapshot.partyId);
    if (previous) {
        dropKey(byRaidBoss, previous.bossKey, snapshot.partyId);
        raidIndexed.delete(snapshot.partyId);
    }
    if (snapshot.status !== 'active' && snapshot.status !== 'hot') return;
    const bossKey = raidBossKey(snapshot);
    if (!bossKey) return;
    addKey(byRaidBoss, bossKey, snapshot.partyId);
    raidIndexed.set(snapshot.partyId, { bossKey, order: cacheGeneration });
    // A boss a party newly hunts: its 'raids' row goes to the worker now, not
    // at the coordinator's next review.
    if (previous?.bossKey !== bossKey) RaidEncounterScope.changed(bossKey);
}

function clearIndexes() {
    byLeader.clear(); byObjectiveClan.clear(); byGoalKey.clear(); indexed.clear();
    byRaidBoss.clear(); raidIndexed.clear();
}

// The active parties under one index key, in active() order. `reader` names
// the caller for the counter: one hit and the active() scan it replaced.
function activeIn(index, key, reader) {
    return activeOf(index.get(key) || [], reader);
}

function activeOf(ids, reader) {
    Diagnostics.count('party_index', 'hit', reader);
    Diagnostics.count('party_index', 'scan_avoided', reader, byStatus.get('active').size);
    const parties = [];
    for (const id of ids) if (indexed.has(id)) parties.push(cache.get(id));
    if (parties.length > 1) parties.sort((a, b) => indexed.get(a.partyId).order - indexed.get(b.partyId).order);
    return parties;
}

// The 'parties' table (ColdTableChannel, key: party id): an active party's
// snapshot plus the raid owner of its full roster and the re-plan due mark
// (PopulationService.partyRequirementRefreshDue), both read when the row is
// published. A party that is no longer active leaves the table. The worker
// reads its party and leadership from it (ColdSimulationKernel.partyRow).
let requirementDue = () => false;
function tableRow(party) {
    const roster = party.stats?.objective?.fullRoster;
    return { ...party, raidOwner: roster && Database.isReady() ? Database.clanRaidOwner(roster) : null,
        requirementRefresh: requirementDue(String(party.partyId)) === true };
}

// Party row writes that wrote nothing, by reason: counted always (one Map
// write), logged at most once a minute. Such a party keeps its old row and
// due, and its leader steps again on them.
const skippedWrites = new Map();
let skippedLoggedAt = 0;
function skippedWrite(reason, partyId) {
    skippedWrites.set(reason, (skippedWrites.get(reason) || 0) + 1);
    const at = Date.now();
    if (at - skippedLoggedAt < 60000) return null;
    skippedLoggedAt = at;
    utils.infoWarn('BotParty', 'party row writes that wrote nothing since start: %s (last: %s)',
        [...skippedWrites].map(([key, count]) => `${key}:${count}`).join('|'), partyId);
    return null;
}

function publish(partyId) {
    const party = cache.get(String(partyId));
    TableChannel.changed('parties', party?.status === 'active' ? tableRow(party)
        : { key: String(partyId), removed: true });
}

TableChannel.register('parties', {
    key: row => row.partyId,
    allRows: () => Array.from(byStatus.get('active'), id => tableRow(cache.get(id)))
});

function acceptedParty(snapshot) {
    const current = cache.get(snapshot.partyId);
    // Each accepted row carries its database revision. One FNV stamp of the
    // whole snapshot per accept: a re-accepted identical row changes nothing.
    const stamp = fnv1a32(JSON.stringify(snapshot));
    if (current && acceptedStamps.get(snapshot.partyId) === stamp) return current;
    cache.set(snapshot.partyId, snapshot);
    acceptedStamps.set(snapshot.partyId, stamp);
    for (const ids of byStatus.values()) ids.delete(snapshot.partyId);
    byStatus.get(snapshot.status)?.add(snapshot.partyId);
    cacheGeneration++;
    index(snapshot);
    indexRaid(snapshot);
    for (const listener of publicationListeners) {
        try { listener(snapshot, current || null); }
        catch (error) { utils.infoWarn('BotParty', 'publication listener failed: %s', error?.message || error); }
    }
    // After the listeners: the row reads the due mark they set.
    publish(snapshot.partyId);
    if (!byStatus.has(snapshot.status)) {
        cache.delete(snapshot.partyId);
        acceptedStamps.delete(snapshot.partyId);
        invoke('GameServer/Bot/Economy/EconomyContext').forgetGroup(snapshot.partyId);
    }
    return snapshot;
}
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
    const stats = PartyRisk.marksInSteps(parseJson(row.statsJson, {}), row.partyId || '', Date.now());
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
        updatedAt: Number(row.updatedAt || 0),
        revision: Number(row.revision || 0)
    };
}

// The bots' downtime (BotLifeState.bootPause, L136) moves the active parties'
// due times too: the party row is the leader's scheduling authority. Before
// loadActive, so the cache reads the moved row (its updatedAt moves by the same
// delta, so the party commit fence still matches the row).
function shiftDueTimesByDowntime() {
    return BotLifeState.bootPause().then(({ startedAt, downtimeMs }) => {
        if (!(downtimeMs > 0)) return 0;
        return Database.execute([
            `UPDATE ${TABLE} SET nextResolveAt = nextResolveAt + ?, updatedAt = updatedAt + ?, revision = revision + 1
            WHERE status = 'active' AND nextResolveAt > 0 AND updatedAt > 0 AND updatedAt < ?`,
            [downtimeMs, downtimeMs, startedAt]
        ]).then((result) => {
            const shifted = Number(result?.affectedRows || 0);
            utils.infoWarn('BotParty', 'cold hydrate: shifted %d party due times by %d ms', shifted, downtimeMs);
            return shifted;
        });
    });
}

function rowFromParty(party) {
    const current = cache.get(String(party.partyId))?.stats;
    if (Number(current?.clanGoalInvalidationVersion || 0) > Number(party.stats?.clanGoalInvalidationVersion || 0)) {
        party = { ...party, stats: { ...party.stats, objective: current.objective,
            acquisitionGoal: current.acquisitionGoal,
            clanGoalInvalidationVersion: current.clanGoalInvalidationVersion } };
    }
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

const BackgroundPartyState = {
    subscribeChanges(listener) {
        if (typeof listener !== 'function') throw new TypeError('invalid_party_publication_listener');
        publicationListeners.add(listener);
        return () => publicationListeners.delete(listener);
    },
    init() {
        if (initialized) return Promise.resolve(true);
        if (initStarted) return initPromise;
        initStarted = true;

        initPromise = Database.execute(['SELECT 1', []], 'schema:bot-parties')
            .then(() => Database.execute([`UPDATE ${TABLE} SET status = 'active', nextResolveAt = ?, updatedAt = ?, revision = revision + 1 WHERE status = 'hot'`, [now() + 30000, now()]], 'bot-party:startup-recovery'))
            .then(() => shiftDueTimesByDowntime())
            .then(() => this.loadActive()).then(() => {
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
            const next = rows.map(normalize);
            const keys = Array.from(cache.keys());
            const changedOrder = keys.length !== next.length || next.some((party, index) => party.partyId !== keys[index]);
            if (changedOrder) {
                const kept = new Set(next.map(party => String(party.partyId)));
                for (const id of byStatus.get('active')) if (!kept.has(id)) TableChannel.changed('parties', { key: id, removed: true });
                cache.clear();
                acceptedStamps.clear();
                for (const ids of byStatus.values()) ids.clear();
                clearIndexes();
                cacheGeneration++;
            }
            next.forEach(acceptedParty);
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
                WHERE status NOT IN ('active', 'const_paused')
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

    createOrUpdate(party, options = {}) {
        const prepared = this.prepareCommit(party);
        if (!prepared) return Promise.resolve(skippedWrite('roster_size', party?.partyId));
        const ready = initialized ? Promise.resolve(true) : this.init();

        return ready.then((isReady) => {
            if (!isReady) return skippedWrite('db_not_ready', prepared.snapshot.partyId);
            return Database.saveBackgroundParty(prepared.row, options).then((result) => {
                // Only the whole-party lifecycle can change a hot roster.
                // A cold maintenance job may have prepared this save before activation.
                if (!result.affectedRows) return skippedWrite(result.reason || 'not_written', prepared.snapshot.partyId);
                (result.lifeRows || []).forEach(row => BotLifeState.acceptNewerLifecycleRow(row));
                return this.acceptRow(result.row);
            });
        }).catch((err) => {
            utils.infoWarn('BotParty', 'failed to save background party %s: %s', prepared.snapshot.partyId, err.message);
            return skippedWrite('db_error', prepared.snapshot.partyId);
        });
    },

    async commitGoals(party, members, joint) {
        const next = { ...party, stats: { ...party.stats, ...joint },
            updatedAt: Math.max(Date.now(), Number(party.updatedAt || 0) + 1) };
        if (!Database.isReady()) return this.createOrUpdate(next);
        const result = await Database.commitBackgroundPartyGoals({
            partyId: party.partyId, expectedPartyRevision: Number(party.revision || 0),
            leaderId: Number(party.leaderId), memberIds: party.memberIds,
            sources: require('./PartyGoalCalculation').sources(members),
            statsJson: safeJson(next.stats), updatedAt: next.updatedAt });
        return result.ok ? this.acceptRow(result.partyRow) : null;
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

    acceptRow(row) {
        const snapshot = normalize(row);
        return acceptedParty(snapshot);
    },

    // The re-plan due mark's owner (PopulationService) hands its reader; a
    // change of the mark outside a party write re-publishes the row (publish).
    useRequirementDue(reader) {
        requirementDue = typeof reader === 'function' ? reader : () => false;
    },

    publish,

    find(partyId) {
        return cache.get(String(partyId || '')) || null;
    },

    active() {
        return Array.from(byStatus.get('active'), id => cache.get(id));
    },

    admitted() {
        return [...byStatus.get('active'), ...byStatus.get('hot')].map(id => cache.get(id));
    },

    // Index reads of active(): same parties, same order, without the scan.
    activeByLeaders(leaderIds, reader = 'unknown') {
        const ids = new Set();
        for (const leaderId of leaderIds || []) for (const id of byLeader.get(Number(leaderId) || 0) || []) ids.add(id);
        return activeOf(ids, reader);
    },

    activeByObjectiveClan(clanId, reader = 'unknown') {
        return activeIn(byObjectiveClan, Number(clanId) || 0, reader);
    },

    activeByGoalKey(goalKey, reader = 'unknown') {
        return activeIn(byGoalKey, String(goalKey || ''), reader);
    },

    // The parties with this status hunting one raid boss, without one party,
    // in the order active() / admitted() give them (last accepted change).
    raidCompetitors(bossKey, status, exceptPartyId, reader = 'unknown') {
        Diagnostics.count('party_index', 'hit', reader);
        Diagnostics.count('party_index', 'scan_avoided', reader,
            byStatus.get('active').size + (status === 'hot' ? byStatus.get('hot').size : 0));
        const parties = [];
        for (const id of byRaidBoss.get(bossKey) || []) {
            const party = cache.get(id);
            if (id !== exceptPartyId && party?.status === status) parties.push(party);
        }
        if (parties.length > 1) parties.sort((a, b) => raidIndexed.get(a.partyId).order - raidIndexed.get(b.partyId).order);
        return parties;
    },

    raidBossKey,

    // The raid bosses (template ids) active or hot parties hunt.
    raidBossKeys() {
        return byRaidBoss.keys();
    },

    // The active parties among these ids (each once), in active() order.
    activeByIds(partyIds, reader = 'unknown') {
        return activeOf(new Set((partyIds || []).map(String)), reader);
    },

    setStatus(partyId, status = 'inactive') {
        const party = this.find(partyId);
        if (!party) return Promise.resolve(null);
        return this.createOrUpdate({ ...party, status });
    },

    size() { return cache.size; },

    counts() {
        const active = byStatus.get('active').size;
        return { active, inactive: cache.size - active, total: cache.size };
    }
};

module.exports = BackgroundPartyState;
