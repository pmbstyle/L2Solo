// The main-thread fallback uses exactly the same lease-fenced transaction as
// worker raids; it must not apply nine independent inventory updates.
async function resolve({ party, members, spot, pressure, targetNpcId, elapsedMs }) {
    const Owner = require('./ColdSimulationOwner');
    const Life = require('./BotLifeState');
    const Parties = require('./BackgroundPartyState');
    const Raid = require('./ColdRaidEncounter');
    const Authority = require('./ColdRaidAuthority');
    await Authority.init();
    spot = invoke('GameServer/RaidBoss/RaidEncounterScope').decorateSpot(spot);
    const claims = await Owner.claimBatch(members, { allowParty: true, allowLifecycle: true });
    const grants = claims.grants || [];
    const id = `raid:${grants.find(grant => Number(grant.characterId) === Number(party.leaderId))?.leaseId}`;
    try {
        if (grants.length !== members.length) return { ok: false, reason: 'raid_claim_rejected' };
        const timestamp = Date.now();
        const staged = await Raid.stage({ key: Raid.keyFor(spot, targetNpcId), id,
            memberIds: members.map(member => Number(member.characterId)) }, () => require('./BackgroundPartyResolver').resolve({
            party, members, spot, pressure, targetNpcId, elapsedMs, timestamp }));
        const result = staged.result;
        const nextParty = { ...party, ...result.partyPatch, stats: { ...party.stats, ...result.partyPatch.stats },
            nextResolveAt: result.nextResolveAt, updatedAt: Math.max(timestamp, Number(party.updatedAt) + 1) };
        const snapshot = staged.snapshot || spot.raidAuthority || { key: Raid.keyFor(spot, targetNpcId),
            raidInstanceId: spot.raidInstanceId,
            status: spot.raidWorldAvailable === false ? 'unavailable' : 'active', updatedAt: timestamp };
        const atomicGroup = { id, memberIds: party.memberIds,
            partyChanges: [{ partyId: party.partyId, memberIds: party.memberIds, expectedUpdatedAt: party.updatedAt,
                updatedAt: nextParty.updatedAt, nextResolveAt: nextParty.nextResolveAt, status: nextParty.status,
                cohesion: nextParty.cohesion, risk: nextParty.risk, statsJson: JSON.stringify(nextParty.stats) }],
            raidCommit: { key: snapshot.key, worldRequired: spot.raidWorldAvailable !== false, expectedRevision: spot.raidAuthorityRevision,
                revision: spot.raidAuthorityRevision + 1, snapshot } };
        if (!Authority.prepare(atomicGroup.raidCommit)) return { ok: false, reason: 'raid_world_changed' };
        const entries = await Promise.all(result.memberResults.map(async ({ state, result: memberResult }) => {
            let nextState = await Life.prepareResolve(state, memberResult, { persist: false, timestamp, projectClassProgression: true });
            const beforeClassId = Number(state.stats?.classProgressionClassId ?? state.stats?.classId ?? 0);
            const afterClassId = Number(nextState.stats?.classProgressionClassId ?? nextState.stats?.classId ?? beforeClassId);
            const changed = Number(state.stats?.classProgressionLevel || 0) < Number(nextState.level || 1)
                || beforeClassId !== afterClassId;
            const transitions = (nextState.stats?.classTransitions || []).slice((state.stats?.classTransitions || []).length);
            const skillClasses = [...new Set([beforeClassId, ...transitions, afterClassId].filter(Number.isFinite))];
            const skills = changed ? [...skillClasses.flatMap(classId => require('./ColdCombatProfile').skillRecordsFromTree(classId, nextState.level))
                .reduce((byId, skill) => byId.set(Number(skill.selfId), skill), new Map()).values()] : [];
            if (nextParty.status === 'dissolved') nextState = require('./BackgroundPartyLifecycle').releaseMember(
                nextState, timestamp, nextParty.stats.partyBreakReason, nextParty.stats.objective);
            return { nextState, token: grants.find(grant => Number(grant.characterId) === Number(state.characterId)),
                atomicGroup, options: { allowParty: true, allowLifecycle: true },
                proposal: { baseState: state, result: memberResult, durable: changed ? { classId: afterClassId, skills } : null } };
        }));
        const committed = await Owner.commitAndReleaseBatch(entries);
        committed.forEach(row => Raid.acknowledge(id, row.characterId, row.ok));
        if (committed.some(row => !row.ok)) return { ok: false, reason: 'raid_commit_rejected' };
        Parties.acceptRow(committed[0].raidPartyRow);
        Authority.accept(committed[0].raidRow);
        if (nextParty.stats.raidEncounter?.status === 'defeated') await require('./ColdRaidWorldBridge').settle(nextParty,
            { respawnAt: committed[0].raidRespawnAt });
        if (nextParty.stats.raidEncounter?.status === 'failed') await invoke('GameServer/Clan/ClanEquipmentService').recordRaidFailure(nextParty);
        const Events = require('./BotLifeEvents');
        await Promise.all(result.events.map(event => Events.record(event.characterId || party.leaderId,
            event.type, event.summary, event.meta, event.weight)));
        const Metrics = require('./PopulationMetrics');
        Metrics.recordPartyResolve(); Metrics.recordCombat(result.debug);
        if (nextParty.status === 'dissolved') Metrics.recordPartyDissolution();
        return { ok: true, party: Parties.find(party.partyId), debug: result.debug };
    } finally {
        Raid.abort(id);
        await Owner.releaseBatch(grants, { releaseInvalidated: true });
    }
}
module.exports = { resolve };
