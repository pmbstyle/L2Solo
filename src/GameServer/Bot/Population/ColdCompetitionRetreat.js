// Voluntary decisions affect the actor's whole hunting unit, without blame.
const partyIdOf = s => s?.party?.partyId || s?.partyId || null;
const AVOID_MS = 10 * 60000;

async function apply({ event, life, owner, memory, parties, participantAllowed, contestContextAllowed,
    retreatRoute, onState, now, waitMs }) {
    const at = now(), sides = [];
    for (const participant of [event.actor, event.peer]) {
        const principal = life.cachedState(participant.id);
        if (!principal || partyIdOf(principal) !== (participant.partyId || null)
            || Number(principal.simulation?.revision || 0) !== participant.revision
            || memory.snapshot(participant.id)?.revision !== participant.memoryRevision) return { ok: false, reason: 'state_or_memory_changed' };
        const party = participant.partyId ? parties?.find(participant.partyId) : null;
        if (participant.partyId && (!party || party.status !== 'active' || party.updatedAt !== participant.partyUpdatedAt
            || party.memberIds.length !== participant.size || party.memberIds.length < 2 || party.memberIds.length > 9
            || !party.memberIds.includes(participant.id) || !party.memberIds.includes(party.leaderId)
            || party.spotId !== event.spotId || party.stats?.travel || party.stats?.coldCompetition?.wait
            || Number(party.stats?.objective?.npcId || party.stats?.acquisitionGoal?.next?.npcId || 0) !== event.npcId)) {
            return { ok: false, reason: 'party_changed' };
        }
        const members = party ? party.memberIds.map(id => life.cachedState(id)) : [principal];
        if (members.some(s => !s || s.phase !== 'cold' || !(s.vitals?.hp > 0)
            || !(party ? ['grouped', 'hunting'] : ['hunting']).includes(s.activity)
            || partyIdOf(s) !== (participant.partyId || null) || s.spotId !== event.spotId
            || s.stats?.travel || s.stats?.coldCompetition?.wait || s.stats?.pvpEncounter
            || s.stats?.supplyErrand || s.stats?.warehouseWorkflow || s.stats?.marketReturn
            || (s.simulation?.ownerId || 'legacy_main') !== 'legacy_main'
            || !participantAllowed(s.characterId) || !contestContextAllowed(s, event) || !memory.snapshot(s.characterId)
            || at - Number(s.stats?.coldCompetition?.at || 0) < 120000
            || (!party && (s.stats?.equipmentPlan?.status !== 'active'
                || Number(s.stats.equipmentPlan.next?.npcId || s.stats.equipmentPlan.targetNpcId || 0) !== event.npcId)))) {
            return { ok: false, reason: 'member_busy_or_changed' };
        }
        sides.push({ principal, party, members });
    }
    const states = sides.flatMap(s => s.members);
    if (states.length > 18 || new Set(states.map(s => s.characterId)).size !== states.length) return { ok: false, reason: 'overlapping_sides' };
    const revisions = new Map(states.map(s => [s.characterId, memory.snapshot(s.characterId).revision]));
    const avoiding = event.action === 'avoid';
    const avoid = avoiding ? { spotId: event.spotId, until: at + AVOID_MS } : null;
    const actorMembers = sides[0].members.map(s => avoiding ? { ...s, stats: { ...s.stats,
        coldCompetition: { ...s.stats?.coldCompetition, avoid } } } : s);
    const route = avoiding ? retreatRoute(actorMembers, sides[0].party, event, at) : null;
    if (avoiding && (!route?.needed || !route.spotId || route.spotId === event.spotId)) return { ok: false, reason: 'no_retreat_route' };
    const { beginRouteTravelState } = require('./ColdSimulationKernel');
    const travelling = avoiding ? actorMembers.map(s => beginRouteTravelState(s, route, at)) : [];
    if (avoiding && travelling.some(s => !s)) return { ok: false, reason: 'invalid_retreat_route' };
    const preparedParties = sides.map((side, i) => {
        if (!side.party) return null;
        const travel = avoiding && i === 0 ? { reason: 'party_spot_replan', cause: 'competition_avoid',
            regionName: route.regionName, spotId: route.spotId, startedAt: at, arrivalAt: travelling[0].timing.nextResolveAt } : null;
        const prepared = parties.prepareCommit({ ...side.party,
            spotId: travel ? route.spotId : side.party.spotId,
            nextResolveAt: i === 0 ? travel?.arrivalAt || Math.max(at, Number(side.party.nextResolveAt || 0)) + waitMs : side.party.nextResolveAt,
            stats: { ...side.party.stats, ...(travel ? { travel } : {}), coldCompetition: {
                ...side.party.stats?.coldCompetition, key: event.key, at, action: event.action, peerId: sides[1 - i].principal.characterId,
                ...(i === 0 ? avoiding ? { avoid } : { wait: { start: at, until: at + waitMs } } : {})
            } } });
        prepared.row.updatedAt = Math.max(prepared.row.updatedAt, side.party.updatedAt + 1);
        prepared.snapshot.updatedAt = prepared.row.updatedAt;
        return prepared;
    });
    const next = sides.flatMap((side, i) => side.members.map((s, j) => {
        const result = avoiding && i === 0 ? travelling[j] : s;
        return { ...result, stats: { ...result.stats, coldCompetition: { ...result.stats?.coldCompetition,
            key: event.key, at, action: event.action, peerId: sides[1 - i].principal.characterId,
            ...(i === 0 && !avoiding ? { wait: { start: at, until: at + waitMs } } : {}) } },
        timing: i === 0 ? { ...result.timing,
            nextResolveAt: preparedParties[i]?.row.nextResolveAt || (avoiding ? result.timing.nextResolveAt : Math.max(at, Number(s.timing?.nextResolveAt || 0)) + waitMs) } : s.timing };
    }));
    const { grants } = await owner.claimBatch(states, { timestamp: at, allowParty: true, allowLifecycle: true });
    try {
        if (grants.length !== states.length) return { ok: false, reason: 'claim_rejected' };
        if (now() - event.at > 10000 || states.some(s => !participantAllowed(s.characterId) || !contestContextAllowed(s, event)
            || memory.snapshot(s.characterId)?.revision !== revisions.get(s.characterId))) return { ok: false, reason: 'retreat_changed_during_claim' };
        const group = { id: event.key, memberIds: states.map(s => s.characterId),
            partyChanges: preparedParties.flatMap((p, i) => p ? [{ partyId: p.row.partyId,
                expectedUpdatedAt: sides[i].party.updatedAt, memberIds: sides[i].party.memberIds,
                spotId: p.row.spotId, nextResolveAt: p.row.nextResolveAt, statsJson: p.row.statsJson, updatedAt: p.row.updatedAt }] : []) };
        const results = await owner.commitAndReleaseBatch(next.map((s, i) => ({
            token: grants.find(g => g.characterId === s.characterId), nextState: s, atomicGroup: group,
            options: { allowParty: true, allowLifecycle: true }, proposal: { baseState: states[i] }
        })), { timestamp: now() });
        if (results.length !== states.length || results.some(r => !r.ok)) return { ok: false, reason: 'commit_rejected' };
        preparedParties.filter(Boolean).forEach(p => parties.acceptCommit(p));
        return { ok: true, affectedIds: sides[0].members.map(s => s.characterId), memoryEvents: 0,
            matchup: sides.map(s => s.party ? 'party' : 'solo').join('_vs_'),
            ...(avoiding ? { destinationSpotId: route.spotId, arrivalAt: travelling[0].timing.nextResolveAt, avoidUntil: avoid.until }
                : { waitUntil: at + waitMs }) };
    } finally {
        const owned = grants.filter(g => life.cachedState(g.characterId)?.simulation?.leaseId === g.leaseId);
        if (owned.length) await owner.releaseBatch(owned);
        states.forEach(s => onState(s.characterId));
    }
}
module.exports = { apply, AVOID_MS };
