const Validation = require('./ColdCompetitionValidation');
const Episode = require('./ColdCompetitionEpisode');
// Voluntary decisions affect the actor's whole hunting unit, without blame.
const AVOID_MS = 10 * 60000;

async function apply({ event, life, owner, memory, parties, participantAllowed, contestContextAllowed,
    retreatRoute, onState, now, waitMs }) {
    const at = now(), sides = [];
    for (const participant of [event.actor, event.peer]) {
        const principal = life.cachedState(participant.id);
        const validation = { retreat: true, at, memory, participantAllowed, contestContextAllowed };
        const principalFailure = Validation.principal(principal, participant, memory);
        if (principalFailure) return principalFailure;
        const party = participant.partyId ? parties?.find(participant.partyId) : null;
        const partyFailure = Validation.party(party, participant, event, { ...validation,
            leader: party ? life.cachedState(party.leaderId) : null });
        if (partyFailure) return partyFailure;
        const memberIds = party ? party.memberIds : [participant.id];
        const members = memberIds.map(id => life.cachedState(id));
        for (let i = 0; i < members.length; i++) {
            const failure = Validation.member(members[i], memberIds[i], participant, event, { ...validation, party });
            if (failure) return failure;
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
            stats: { ...side.party.stats, ...(travel ? { travel } : {}), coldCompetition: Episode.begin(side.party.stats?.coldCompetition, {
                outcome: event.action, key: event.key, at, action: event.action, peerId: sides[1 - i].principal.characterId,
                ...(i === 0 ? avoiding ? { avoid } : { wait: { start: at, until: at + waitMs } } : {})
            }) } });
        prepared.row.updatedAt = Math.max(prepared.row.updatedAt, side.party.updatedAt + 1);
        prepared.snapshot.updatedAt = prepared.row.updatedAt;
        return prepared;
    });
    const next = sides.flatMap((side, i) => side.members.map((s, j) => {
        const result = avoiding && i === 0 ? travelling[j] : s;
        return { ...result, stats: { ...result.stats, coldCompetition: Episode.begin(result.stats?.coldCompetition, {
            outcome: event.action, key: event.key, at, action: event.action, peerId: sides[1 - i].principal.characterId,
            ...(i === 0 && !avoiding ? { wait: { start: at, until: at + waitMs } } : {}) }) },
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
