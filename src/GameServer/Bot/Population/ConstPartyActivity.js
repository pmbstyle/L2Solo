const SavedStats = require('../SavedStats');

// Only activity state is rewound. Inventory, experience, skills, vitals and
// native economy revisions earned with the player always keep their new values.
const FIELDS = ['travel', 'pvpEncounter', 'coldCompetition', 'partyRequest',
    'backgroundPartyId', 'leaderId', 'marketStore', 'supplyErrand', 'mammonReturn', 'restUntil', 'mammonRetryAt'];
const CLOCKS = new Set(['at', 'startedAt', 'startAt', 'endAt', 'arrivalAt', 'until',
    'expiresAt', 'nextResolveAt', 'sessionExpiresAt', 'lastProgressAt', 'formedAt', 'restUntil', 'mammonRetryAt']);
function shift(value, elapsed) {
    if (Array.isArray(value)) return value.map(item => shift(item, elapsed));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
        CLOCKS.has(key) && typeof item === 'number' && item > 0 ? Math.ceil(item + elapsed) : shift(item, elapsed)]));
}
function object(text) { return typeof text === 'string' ? JSON.parse(text || '{}') : text || {}; }
function marker(row) { return object(row?.statsJson).constPartySession; }
function capture(row, timestamp, activity) {
    const stats = SavedStats.merge(row.statsJson, row.mindJson);
    return { activity: activity || row.activity, currentRegion: row.currentRegion, spotId: row.spotId,
        locX: row.locX, locY: row.locY, locZ: row.locZ, partyId: row.partyId,
        activityStartedAt: row.activityStartedAt, nextResolveAt: row.nextResolveAt,
        fields: Object.fromEntries(FIELDS.filter(key => Object.hasOwn(stats, key)).map(key => [key, stats[key]])),
        at: timestamp };
}

// These operations run inside the owning native database transaction. Moving
// every member's revision and phase fences already forecast cold party steps.
function native({ one, all, write, row: getRow, now }) {
    function savePaused(row, session, timestamp) {
        const stats = SavedStats.merge(row.statsJson, row.mindJson);
        for (const key of ['travel', 'pvpEncounter', 'coldCompetition', 'partyRequest', 'backgroundPartyId']) delete stats[key];
        delete stats.playerPartyTakeover;
        stats.leaderId = session.active ? session.playerId : null;
        stats.constPartySession = session;
        const columns = SavedStats.statsColumns(stats);
        write(`UPDATE bot_life_state SET phase='hot', activity=?, partyId=NULL,
            nextResolveAt=NULL, lastResolvedAt=?, statsJson=?, mindJson=?, updatedAt=?,
            simulationRevision=simulationRevision+1 WHERE characterId=?`,
        [session.active ? 'following' : 'resting', timestamp, columns.statsJson, columns.mindJson, timestamp, row.characterId]);
    }
    function pause(request) {
        const id = Number(request.characterId), playerId = Number(request.playerId);
        const selected = getRow(id);
        if (!selected || !one("SELECT 1 FROM bot_friendships WHERE playerId=? AND botId=? AND status='accepted'", [playerId, id])) {
            return { ok: false, reason: 'not_friend' };
        }
        const timestamp = now();
        if (one('SELECT 1 FROM board_trade_meetings WHERE actorA=? OR actorB=? LIMIT 1', [id, id])
            || invoke('GameServer/AfkTrade/TradeMeetingService').hasPreparation(id)) {
            return { ok: false, reason: 'trade_cancellation_pending' };
        }
        const existing = marker(selected);
        if (existing) {
            savePaused(selected, { ...existing, active: true, playerId }, timestamp);
            return { ok: true, rows: [getRow(id)] };
        }
        const takeover = object(selected.statsJson).playerPartyTakeover;
        const takeoverId = Number(takeover?.playerId) === playerId ? takeover.partyId : null;
        let party = selected.partyId || takeoverId
            ? one('SELECT * FROM bot_background_parties WHERE partyId=?', [selected.partyId || takeoverId]) : null;
        const previousTakeover = !selected.partyId && party?.status === 'player_taken_over'
            && Number(object(party.statsJson).playerTakeover?.playerId) === playerId;
        if (!selected.partyId && !previousTakeover) party = null;
        if (party && !previousTakeover && !['active', 'hot'].includes(party.status)) return { ok: false, reason: 'party_transition_pending' };
        const ids = party ? object(party.memberIdsJson) : [id];
        if (!Array.isArray(ids) || !ids.includes(id)) return { ok: false, reason: 'party_changed' };
        const rows = ids.map(getRow);
        if (rows.some(row => !row || marker(row) || (party && (previousTakeover
            ? object(row.statsJson).playerPartyTakeover?.partyId !== party.partyId
                || Number(object(row.statsJson).playerPartyTakeover?.playerId) !== playerId
            : row.partyId !== party.partyId)))) {
            return { ok: false, reason: 'party_changed' };
        }
        if (ids.some(id => one('SELECT 1 FROM board_trade_meetings WHERE actorA=? OR actorB=? LIMIT 1', [id, id])
            || invoke('GameServer/AfkTrade/TradeMeetingService').hasPreparation(id))) {
            return { ok: false, reason: 'trade_cancellation_pending' };
        }
        for (const row of rows) {
            const active = Number(row.characterId) === id;
            const saved = capture(row, timestamp, active ? request.activity : null);
            if (previousTakeover) {
                saved.activity = 'grouped'; saved.partyId = party.partyId;
                saved.fields.backgroundPartyId = party.partyId; saved.fields.leaderId = Number(party.leaderId);
            }
            savePaused(row, { playerId: active ? playerId : 0, active, groupId: party?.partyId || null,
                saved }, timestamp);
        }
        if (party) {
            const stats = object(party.statsJson);
            const pausedAt = previousTakeover ? Number(stats.playerTakeover?.at || timestamp) : timestamp;
            delete stats.playerTakeover;
            stats.constPartyPause = { at: pausedAt, nextResolveAt: party.nextResolveAt };
            write(`UPDATE bot_background_parties SET status='const_paused',nextResolveAt=NULL,
                statsJson=?,updatedAt=?,revision=revision+1 WHERE partyId=?`, [JSON.stringify(stats), timestamp, party.partyId]);
        }
        return { ok: true, rows: ids.map(getRow), party: party && one('SELECT * FROM bot_background_parties WHERE partyId=?', [party.partyId]) };
    }
    function restoreRow(row, timestamp, groupId) {
        const session = marker(row), saved = session.saved, elapsed = Math.max(0, timestamp - saved.at);
        const stats = SavedStats.merge(row.statsJson, row.mindJson);
        for (const key of FIELDS) delete stats[key];
        const fields = shift(saved.fields, elapsed);
        // Combat opponents can die or leave while the bot is with a player.
        // Resume its hunting/PK/raid goal without replaying a stale encounter.
        delete fields.pvpEncounter;
        delete fields.coldCompetition;
        Object.assign(stats, fields);
        delete stats.constPartySession;
        delete stats.playerPartyTakeover;
        // A cancelled deal cannot regain custody, a receipt or its old escrow.
        delete stats.tradeMeeting;
        const due = saved.nextResolveAt ? Math.ceil(Math.max(timestamp + 1000, saved.nextResolveAt + elapsed)) : timestamp + 1000;
        const activity = saved.activity === 'following' || (!groupId && saved.activity === 'grouped') ? 'hunting' : saved.activity;
        if (!groupId) { delete stats.backgroundPartyId; delete stats.leaderId; }
        const columns = SavedStats.statsColumns(stats);
        write(`UPDATE bot_life_state SET phase='cold',activity=?,partyId=?,currentRegion=?,spotId=?,
            locX=?,locY=?,locZ=?,activityStartedAt=?,nextResolveAt=?,lastResolvedAt=?,
            statsJson=?,mindJson=?,updatedAt=?,simulationRevision=simulationRevision+1 WHERE characterId=?`,
        [activity, groupId, saved.currentRegion ?? null, saved.spotId ?? null, saved.locX, saved.locY, saved.locZ,
            saved.activityStartedAt ? Math.round(saved.activityStartedAt + elapsed) : timestamp, due, timestamp,
            columns.statsJson, columns.mindJson, timestamp, row.characterId]);
        // Activation reads the character table as well as the lifecycle row.
        write('UPDATE characters SET locX=?,locY=?,locZ=? WHERE id=?', [saved.locX, saved.locY, saved.locZ, row.characterId]);
    }
    function release(request) {
        const selected = getRow(Number(request.characterId)), session = marker(selected);
        if (!session) return { ok: true, rows: [] };
        if (!request.recover && Number(session.playerId) !== Number(request.playerId)) return { ok: false, reason: 'session_changed' };
        const timestamp = now();
        savePaused(selected, { ...session, active: false, playerId: 0 }, timestamp);
        const party = session.groupId ? one('SELECT * FROM bot_background_parties WHERE partyId=?', [session.groupId]) : null;
        const declared = party ? object(party.memberIdsJson) : [];
        const rows = party ? declared.map(getRow).filter(row => marker(row)?.groupId === session.groupId)
            : session.groupId ? all("SELECT * FROM bot_life_state WHERE json_extract(statsJson,'$.constPartySession.groupId')=?", [session.groupId])
                : [getRow(selected.characterId)];
        if (rows.some(row => marker(row).active)) return { ok: true, waiting: true, rows: [getRow(selected.characterId)] };
        const groupId = party?.status === 'const_paused' && rows.length === declared.length ? party.partyId : null;
        for (const row of rows) restoreRow(row, timestamp, groupId);
        if (groupId) {
            const stats = object(party.statsJson), pause = stats.constPartyPause;
            const elapsed = Math.max(0, timestamp - pause.at);
            delete stats.constPartyPause;
            const resumed = shift(stats, elapsed);
            resumed.hotLifecycle = null;
            write(`UPDATE bot_background_parties SET status='active',nextResolveAt=?,statsJson=?,
                updatedAt=?,revision=revision+1 WHERE partyId=?`,
            [Math.ceil(Math.max(timestamp + 1000, Number(pause.nextResolveAt || pause.at) + elapsed)), JSON.stringify(resumed), timestamp, groupId]);
        } else if (party?.status === 'const_paused') {
            write("UPDATE bot_background_parties SET status='dissolved',updatedAt=?,revision=revision+1 WHERE partyId=?", [timestamp, party.partyId]);
        }
        return { ok: true, rows: rows.map(row => getRow(row.characterId)), party: groupId && one('SELECT * FROM bot_background_parties WHERE partyId=?', [groupId]) };
    }
    function recover() {
        const rows = all("SELECT * FROM bot_life_state WHERE json_extract(statsJson,'$.constPartySession') IS NOT NULL");
        for (const row of rows) {
            const session = marker(getRow(row.characterId));
            if (session) savePaused(getRow(row.characterId), { ...session, active: false, playerId: 0 }, now());
        }
        for (const row of rows) release({ characterId: row.characterId, recover: true });
        return rows.length;
    }
    return { pause, release, recover };
}
module.exports = { native, shift };
