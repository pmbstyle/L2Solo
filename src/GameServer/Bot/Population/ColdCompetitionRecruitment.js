// Bounded admission into the party participating in this encounter. No global
// party search, no new party slots, and no transfer between existing parties.
async function recruit({ participants, event, parties, life, memory, composition, limitsFor,
    clanReserved, commit, participantAllowed = () => true, timestamp = Date.now() }) {
    const grouped = participants.filter(s => s.party?.partyId || s.partyId);
    if (grouped.length !== 1) return { rejected: 'party_merge_unsupported' };
    const representative = grouped[0], solo = participants.find(s => s !== representative);
    const partyId = representative.party?.partyId || representative.partyId;
    const forecast = [event.actor, event.peer].find(p => p.id === representative.characterId);
    const party = parties.find(partyId);
    if (!party || party.status !== 'active' || party.spotId !== event.spotId
        || forecast?.partyId !== partyId || forecast.partyUpdatedAt !== party.updatedAt
        || forecast.size !== party.memberIds.length) return { rejected: 'party_changed' };
    const objective = party.stats?.objective;
    if (objective?.clanGoalKey || objective?.clanOperation || participants.some(clanReserved)) return { rejected: 'clan_objective' };
    const target = Number(objective?.npcId || party.stats?.acquisitionGoal?.next?.npcId || 0);
    if (target !== event.npcId) return { rejected: 'party_target_changed' };
    const limits = limitsFor(objective);
    if (party.memberIds.length >= limits.maxSize) return { rejected: 'party_full' };
    const members = party.memberIds.map(id => life.cachedState(Number(id)));
    if (new Set(party.memberIds.map(Number)).size !== members.length
        || !party.memberIds.includes(representative.characterId)
        || !party.memberIds.includes(party.leaderId)
        || members.length < limits.minSize
        || !members.every(s => s && s.phase === 'cold' && ['grouped', 'hunting'].includes(s.activity)
            && s.vitals?.hp > 0 && s.party?.partyId === partyId && s.spotId === event.spotId
            && (s.simulation?.ownerId || 'legacy_main') === 'legacy_main'
            && !s.stats?.travel && !s.stats?.coldCompetition?.wait && !s.stats?.supplyErrand
            && !s.stats?.warehouseWorkflow && !s.stats?.marketReturn && !clanReserved(s)
            && participantAllowed(s.characterId))) return { rejected: 'party_member_busy' };
    // The representative's acceptance must not silently recruit a known enemy
    // of another member. Missing memory postpones the invitation.
    for (const member of members) {
        for (const [a, b] of [[member, solo], [solo, member]]) {
            const relation = memory.assess({ id: a.characterId }, { id: b.characterId }, {}, timestamp);
            if (!relation.ready) return { rejected: 'party_memory_unloaded' };
            if (relation.disposition === 'hostile' || relation.diplomaticEnemy) return { rejected: 'party_hostility' };
        }
    }
    const recruits = composition.selectRecruits(members, [solo], { ...limits, memory, timestamp });
    if (recruits.length !== 1) return { rejected: 'party_composition' };
    const allMembers = [...members.map(s => s.characterId === representative.characterId ? representative : s), solo];
    const nextParty = { ...party, memberIds: allMembers.map(s => s.characterId),
        roleCoverage: composition.roleCoverage(allMembers), stats: { ...party.stats,
            memberNames: allMembers.map(s => s.name), lastRecruitAt: timestamp } };
    const result = await commit(nextParty, allMembers, {
        characterId: party.leaderId, eventType: 'party_recruit',
        summary: `${solo.name} joined a party hunting the same target`,
        meta: { partyId, recruitIds: [solo.characterId], spotId: event.spotId, competitionKey: event.key },
        weight: 1, createdAt: timestamp
    });
    return result.party && !result.failed.length
        ? { ...result.party, recruited: 1 } : { rejected: result.reason || 'party_commit_rejected' };
}
module.exports = { recruit };
