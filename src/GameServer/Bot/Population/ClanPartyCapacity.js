const MarketBreak = require('./PartyMarketBreak');
const Lifecycle = require('./BackgroundPartyLifecycle');
function required(objective) {
    return objective?.status === 'open' && objective.priority === 'required'
        && Number(objective.clanId) > 0 && !!objective.clanGoalKey;
}
function elective(party, now) {
    return party.status === 'active' && !party.stats?.objective?.clanGoalKey
        && party.stats?.objective?.priority !== 'required'
        && !MarketBreak.pending(party, now).length
        && !party.stats?.travel && !party.stats?.coldCompetition?.wait;
}
function safeMembers(party, members) {
    return members.length > 0 && members.length === party.memberIds.length
        && members.every(member => party.memberIds.includes(member.characterId)
            && member.phase === 'cold' && member.party?.partyId === party.partyId
            && String(member.simulation?.ownerId || 'legacy_main') === 'legacy_main'
            && ['hunting', 'grouped', 'resting', 'party_wait'].includes(member.activity)
            && !member.stats?.clanPartyObjective && !member.stats?.equipmentPlan?.clanGoal
            && !member.stats?.pvpEncounter && !member.stats?.partyMarketReturn
            && !member.stats?.travel);
}
async function reclaim(objective, { parties, life, database, metrics }, now = Date.now()) {
    if (!required(objective)) return false;
    // Bounded search; do not scan the population or interrupt a foreground party.
    const candidates = parties.active().filter(party => elective(party, now))
        .sort((a, b) => a.memberIds.length - b.memberIds.length || a.startedAt - b.startedAt).slice(0, 8);
    for (const party of candidates) {
        const members = await life.statesForParty(party.partyId);
        if (!safeMembers(party, members)) continue;
        const preparedParty = parties.prepareCommit({ ...party, status: 'dissolved', memberIds: [],
            stats: { ...party.stats, dissolvedReason: 'clan_priority', replacedForClan: objective.clanId }, updatedAt: now });
        const prepared = members.map(member => life.preparePartyReview(member,
            Lifecycle.releaseMember(member, now, 'clan_priority')));
        if (!preparedParty || prepared.some(member => !member)) continue;
        const result = await database.commitBackgroundPartyMembership({ party: preparedParty.row, members: prepared,
            review: true, preserveClanOperations: true, expectedPartyUpdatedAt: party.updatedAt,
            event: { characterId: party.leaderId, eventType: 'party_capacity_reclaimed',
                summary: 'Background party released capacity for a required clan hunt', weight: 1, createdAt: now,
                meta: { partyId: party.partyId, clanId: objective.clanId, clanGoalKey: objective.clanGoalKey } } });
        // A worker claim or membership change wins over this stale decision.
        if (!result?.ok) continue;
        life.acceptPartyAssignments(prepared);
        parties.acceptCommit(preparedParty);
        metrics.recordPartyDissolution();
        return true;
    }
    return false;
}
module.exports = { required, elective, safeMembers, reclaim };
