// Fixed reason codes and scalar context only: no roster/state copies or I/O.
const partyIdOf = state => state?.party?.partyId || state?.partyId || null;
const failed = (reason, detail, participant, characterId = participant.id, context = {}) =>
    ({ ok: false, reason, detail, rejectionContext: { characterId, partyId: participant.partyId || null, ...context } });

function principal(state, participant, memory) {
    const fail = (detail, context) => failed('state_or_memory_changed', detail, participant, participant.id, context);
    if (!state) return fail('principal_missing');
    if (partyIdOf(state) !== (participant.partyId || null)) return fail('principal_party_changed', { actual: partyIdOf(state) });
    const revision = Number(state.simulation?.revision || 0);
    if (revision !== participant.revision) return fail('principal_revision_changed', { expected: participant.revision, actual: revision });
    const view = memory.snapshot(participant.id);
    if (!view || view.revision !== participant.memoryRevision) return fail('principal_memory_changed', { expected: participant.memoryRevision, actual: view?.revision ?? null });
    return null;
}

function party(state, participant, event, { resume = null, revenge = false, retreat = false, at, leader }) {
    if (!participant.partyId) return null;
    const fail = (detail, context) => failed('party_changed', detail, participant, participant.id, context);
    if (!state) return fail('party_missing');
    if (state.status !== 'active') return fail('party_inactive', { actual: state.status });
    if (state.updatedAt !== participant.partyUpdatedAt) return fail('party_revision_changed', { expected: participant.partyUpdatedAt, actual: state.updatedAt });
    const ids = state.memberIds;
    if (ids.length !== participant.size) return fail('party_size_changed', { expected: participant.size, actual: ids.length });
    if (ids.length < 2 || ids.length > 9) return fail('party_size_invalid', { actual: ids.length });
    if (!ids.includes(participant.id)) return fail('party_principal_missing');
    if (!ids.includes(state.leaderId)) return fail('party_leader_missing', { leaderId: state.leaderId });
    if (!retreat && new Set(ids).size !== ids.length) return fail('party_duplicate_members');
    if (!resume && state.spotId !== event.spotId) return fail('party_spot_changed', { expected: event.spotId, actual: state.spotId });
    const npcId = require('./PartyHuntingTarget').npcId(state, leader);
    if (!resume && !revenge && npcId !== event.npcId) return fail('party_target_changed', { expected: event.npcId, actual: npcId });
    if (state.stats?.travel) return fail('party_travelling');
    const wait = state.stats?.coldCompetition?.wait;
    if (!resume && wait) return fail('party_competition_wait', { until: wait.until ?? null, expired: Number(wait.until) <= at });
    return null;
}

function member(state, characterId, participant, event, { party: group, resume = null, revenge = false,
    retreat = false, at, memory, participantAllowed, contestContextAllowed }) {
    const fail = (detail, context) => failed(retreat ? 'member_busy_or_changed' : 'party_member_busy_or_changed', detail, participant, characterId, context);
    if (!state) return fail('member_missing');
    if (state.phase !== 'cold') return fail('member_not_cold', { actual: state.phase });
    const activities = resume || group ? ['grouped', 'hunting', 'resting'] : retreat ? ['hunting'] : ['grouped', 'hunting'];
    if (!activities.includes(state.activity)) return fail('member_activity', { actual: state.activity });
    if (!(state.vitals?.hp > 0)) return fail('member_dead');
    if (partyIdOf(state) !== (participant.partyId || null)) return fail('member_party_changed', { actual: partyIdOf(state) });
    if (!resume && state.spotId !== event.spotId) return fail('member_spot_changed', { expected: event.spotId, actual: state.spotId });
    if (state.stats?.travel) return fail('member_travelling');
    const wait = state.stats?.coldCompetition?.wait;
    if (!resume && wait) return fail('member_competition_wait', { until: wait.until ?? null, expired: Number(wait.until) <= at });
    if (retreat && state.stats?.pvpEncounter) return fail('member_pvp_encounter');
    if (!resume && state.stats?.supplyErrand) return fail('member_supply_errand');
    if (!resume && state.stats?.warehouseWorkflow) return fail('member_warehouse_workflow');
    if (!resume && state.stats?.marketReturn) return fail('member_market_return');
    if ((state.simulation?.ownerId || 'legacy_main') !== 'legacy_main') return fail('member_owner_changed', { actual: state.simulation.ownerId });
    if (!participantAllowed(state.characterId)) return fail('member_handoff_fenced');
    if (!resume && !contestContextAllowed(state, event)) return fail('member_contest_context_changed');
    if (!memory.snapshot(state.characterId)) return fail('member_memory_unavailable');
    const lastAt = Number(state.stats?.coldCompetition?.at || 0);
    if (!resume && at - lastAt < 120000) return fail('member_decision_cooldown', { until: lastAt + 120000 });
    if (resume && (state.stats?.pvpEncounter?.key !== resume.key || state.stats.pvpEncounter.sequence !== resume.sequence)) return fail('member_encounter_changed');
    if (!resume && !revenge && !group) {
        const plan = state.stats?.equipmentPlan;
        if (!retreat && state.activity !== 'hunting') return fail('member_not_hunting');
        if (plan?.status !== 'active') return fail('member_target_inactive');
        const npcId = Number(plan.next?.npcId || plan.targetNpcId || 0);
        if (npcId !== event.npcId) return fail('member_target_changed', { expected: event.npcId, actual: npcId });
    }
    return null;
}
module.exports = { principal, party, member };
