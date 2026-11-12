const SavedStats = require('../SavedStats');
const Lifecycle = require('./BackgroundPartyLifecycle');

// Called only inside the native transaction, after the runtime/worker fence.
// Move membership and revisions together; never rewind inventory or rewards.
function claim({ one, all, write, row: getRow, now, settleAgreement }, request) {
    const id = Number(request.characterId), playerId = Number(request.playerId);
    const authority = one(`SELECT c.clanId FROM characters c JOIN clans cl ON cl.id=c.clanId
        JOIN characters leader ON leader.id=cl.leaderId AND leader.clanId=cl.id
        WHERE c.id=? AND cl.leaderId=?`, [id, playerId]);
    if (!authority || request.isCurrent?.() !== true) return { ok: false, reason: 'clan_leader_changed' };
    const selected = getRow(id);
    if (!selected) return { ok: false, reason: 'missing_state' };
    if (request.expectedRevision !== undefined && Number(selected.simulationRevision) !== request.expectedRevision) {
        return { ok: false, reason: 'member_changed' };
    }
    if (one('SELECT 1 FROM board_trade_meetings WHERE actorA=? OR actorB=? LIMIT 1', [id, id])
        || invoke('GameServer/AfkTrade/TradeMeetingService').hasPreparation(id)) {
        return { ok: false, reason: 'trade_cancellation_pending' };
    }
    const timestamp = now(), selectedStats = SavedStats.merge(selected.statsJson, selected.mindJson);
    const partyId = selected.partyId || selectedStats.constPartySession?.groupId || selectedStats.playerPartyTakeover?.partyId;
    const party = partyId && one('SELECT * FROM bot_background_parties WHERE partyId=?', [partyId]);
    if (String(partyId || '') !== String(request.expectedPartyId || '')
        || (party?.revision ?? null) !== request.expectedPartyRevision || (party?.status || null) !== request.expectedPartyStatus) {
        return { ok: false, reason: 'party_changed' };
    }
    const ids = party ? JSON.parse(party.memberIdsJson || '[]').map(Number) : [id];
    if (!ids.includes(id)) return { ok: false, reason: 'party_changed' };
    if (request.expectedMembers && (ids.length !== request.expectedMembers.length || ids.some(id => !request.expectedMembers.includes(id)))) {
        return { ok: false, reason: 'party_changed' };
    }
    const rows = ids.map(getRow);
    if (rows.some(row => !row)) return { ok: false, reason: 'party_changed' };
    const partyStats = party ? JSON.parse(party.statsJson || '{}') : {};
    if (party && rows.some(row => {
        const stats = SavedStats.merge(row.statsJson, row.mindJson);
        if (['active', 'hot'].includes(party.status)) return row.partyId !== partyId;
        if (party.status === 'const_paused') return !!row.partyId || stats.constPartySession?.groupId !== partyId;
        if (party.status === 'player_taken_over') return !!row.partyId || stats.playerPartyTakeover?.partyId !== partyId
            || Number(stats.playerPartyTakeover?.playerId) !== Number(partyStats.playerTakeover?.playerId);
        return true;
    })) return { ok: false, reason: 'party_membership_changed' };
    // Fixed military/raid rosters must re-form after losing a member. Ordinary
    // hunting parties retain their other members and elect a new leader.
    const fixedRoster = !!(partyStats.raidAdmission || partyStats.warOperation || partyStats.clanOperation
        || partyStats.raidEncounter || partyStats.objective?.kind === 'raid' || partyStats.objective?.sourceKind === 'raid');
    const remaining = rows.filter(row => Number(row.characterId) !== id);
    const dissolve = fixedRoster || remaining.length < Math.max(2, Number(request.partyMinSize) || 2);
    const leaderId = remaining.some(row => row.characterId === party?.leaderId)
        ? party.leaderId : remaining[0]?.characterId || 0;
    const changedIds = new Set([id]);
    let payment = null;
    if (party) {
        const retainedIds = dissolve ? [] : remaining.map(row => row.characterId);
        const nextStats = { ...partyStats, ...(dissolve ? { partyBreakReason: 'clan_leader_invite' } : {}) };
        if (nextStats.agreement) nextStats.agreement = { ...nextStats.agreement, leaderId, memberIds: retainedIds,
            ...(nextStats.agreement.materialNeeds ? { materialNeeds: nextStats.agreement.materialNeeds.filter(need => retainedIds.includes(Number(need.characterId))) } : {}) };
        const proposed = { ...party, memberIdsJson: JSON.stringify(retainedIds),
            status: dissolve ? 'dissolved' : party.status, statsJson: JSON.stringify(nextStats) };
        payment = settleAgreement(party, proposed);
        const coverage = require('./BackgroundPartyComposition').roleCoverage(dissolve ? []
            : remaining.map(row => ({ stats: SavedStats.merge(row.statsJson, row.mindJson) })));
        write(`UPDATE bot_background_parties SET memberIdsJson=?,leaderId=?,status=?,nextResolveAt=?,
            roleCoverageJson=?,statsJson=?,updatedAt=?,revision=revision+1 WHERE partyId=?`,
        [proposed.memberIdsJson, leaderId, proposed.status, dissolve ? null : party.nextResolveAt,
            JSON.stringify(coverage), payment.row.statsJson, timestamp, partyId]);
    }
    for (const original of rows) {
        const row = getRow(original.characterId);
        const active = Number(row.characterId) === id;
        let stats = SavedStats.merge(row.statsJson, row.mindJson);
        const checkpoint = stats.constPartySession;
        const released = active || dissolve;
        let activity = row.activity, spotId = row.spotId, phase = row.phase;
        if (released) {
            const next = Lifecycle.releaseMember({ characterId: row.characterId, phase: row.phase, activity,
                spotId, party: { partyId: row.partyId }, stats }, timestamp, 'clan_leader_invite', partyStats.objective);
            stats = next.stats;
            activity = next.activity;
            spotId = next.spotId;
            delete stats.playerPartyTakeover;
            // Other players' active const companions stay attached to them.
            if (active || !stats.constPartySession?.active) delete stats.constPartySession;
            else stats.constPartySession = { ...checkpoint, groupId: null,
                saved: { ...checkpoint.saved, partyId: null,
                    fields: { ...checkpoint.saved.fields, backgroundPartyId: null, leaderId: null } } };
            if (!active && checkpoint && !checkpoint.active) {
                phase = 'cold';
                activity = 'hunting';
            }
        } else {
            stats.leaderId = leaderId;
            const saved = stats.constPartySession?.saved;
            if (saved) stats.constPartySession = { ...stats.constPartySession,
                saved: { ...saved, fields: { ...saved.fields, leaderId } } };
        }
        if (active) {
            activity = 'hunting';
            for (const key of ['travel', 'pvpEncounter', 'coldCompetition', 'supplyErrand', 'mammonReturn',
                'restUntil', 'partyMarketReturn', 'marketReturn', 'clanPartyObjective', 'constPartySession']) delete stats[key];
            stats.leaderId = null;
        }
        const columns = SavedStats.statsColumns(stats);
        write(`UPDATE bot_life_state SET phase=?,activity=?,partyId=?,spotId=?,nextResolveAt=?,statsJson=?,mindJson=?,
            updatedAt=?,simulationRevision=simulationRevision+1 WHERE characterId=?`,
        [active ? 'hot' : phase, activity, released ? null : row.partyId, spotId,
            active ? null : row.nextResolveAt || timestamp + 1000, columns.statsJson, columns.mindJson, timestamp, row.characterId]);
        changedIds.add(Number(row.characterId));
    }
    // A running clan operation no longer owns the summoned member.
    const operations = all("SELECT operationId FROM clan_operation_members WHERE characterId=? AND status='active'", [id]);
    for (const { operationId } of operations) {
        write("UPDATE clan_operations SET status='cancelled',reasonCode='clan_leader_invite',resolvedAt=?,updatedAt=? WHERE id=? AND status='active'",
            [timestamp, timestamp, operationId]);
        write("UPDATE clan_operation_members SET status='released',releasedAt=? WHERE operationId=? AND status='active'", [timestamp, operationId]);
    }
    return { ok: true, rows: [...changedIds].map(getRow),
        inventories: [...(payment?.touched || [])].map(characterId => ({ characterId,
            items: all('SELECT * FROM items WHERE characterId=?', [characterId]) })),
        party: party && one('SELECT * FROM bot_background_parties WHERE partyId=?', [partyId]) };
}

module.exports = { claim };
