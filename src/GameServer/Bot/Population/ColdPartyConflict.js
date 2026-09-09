// Main-process execution of one bounded encounter (at most two C4 parties).
// Membership alone never makes a bot an aggressor or creates a memory edge.
const { seeded } = require('./ColdCompetitionMonitor');
const clamp = (n, low = 0, high = 1) => Math.max(low, Math.min(high, n));
const partyIdOf = state => state?.party?.partyId || state?.partyId || null;

function reaction(state, principal, opponent, memory, personaFor, rng, now) {
    const towardPrincipal = memory.assess({ id: state.characterId }, { id: principal.characterId }, {}, now);
    const towardOpponent = memory.assess({ id: state.characterId }, { id: opponent.characterId }, {}, now);
    const t = personaFor(state)?.traits || {};
    const trait = key => clamp(Number(t[key] ?? 0.5));
    const warmth = relation => clamp(((relation.personal?.affinity || 0) + (relation.personal?.trust || 0)) / 40, -1, 1);
    const hostility = clamp((towardOpponent.personal?.hostility || 0) / 30);
    const calm = clamp(0.1 + trait('empathy') * 0.35 + Math.max(0, warmth(towardOpponent)) * 0.3
        - trait('assertiveness') * 0.25 - hostility * 0.35, 0, 0.7);
    if (rng() < calm) return 'deescalate';
    const support = clamp(0.2 + trait('commitment') * 0.4 + trait('sociability') * 0.1
        + warmth(towardPrincipal) * 0.3 + hostility * 0.2 - trait('caution') * 0.2
        - Math.max(0, warmth(towardOpponent)) * 0.3, 0, 0.9);
    return rng() < support ? 'support' : 'stand_aside';
}

async function apply({ event, life, owner, memory, parties, personaFor, participantAllowed,
    contestContextAllowed, onState, now, waitMs, cooldownMs, rng = seeded(event.key) }) {
    if (!parties) return { ok: false, reason: 'party_conflicts_unavailable' };
    const timestamp = now();
    const sides = [];
    for (const participant of [event.actor, event.peer]) {
        const principal = life.cachedState(participant.id);
        if (!principal || partyIdOf(principal) !== (participant.partyId || null)
            || Number(principal.simulation?.revision || 0) !== participant.revision
            || memory.snapshot(participant.id)?.revision !== participant.memoryRevision) {
            return { ok: false, reason: 'state_or_memory_changed' };
        }
        const party = participant.partyId ? parties.find(participant.partyId) : null;
        if (participant.partyId && (!party || party.status !== 'active' || party.updatedAt !== participant.partyUpdatedAt
            || party.memberIds.length !== participant.size || party.memberIds.length < 2 || party.memberIds.length > 9
            || !party.memberIds.includes(participant.id) || !party.memberIds.includes(party.leaderId)
            || new Set(party.memberIds).size !== party.memberIds.length || party.spotId !== event.spotId
            || Number(party.stats?.objective?.npcId || party.stats?.acquisitionGoal?.next?.npcId || 0) !== event.npcId
            || party.stats?.travel || party.stats?.coldCompetition?.wait)) return { ok: false, reason: 'party_changed' };
        const members = party ? party.memberIds.map(id => life.cachedState(id)) : [principal];
        for (const state of members) {
            const plan = state?.stats?.equipmentPlan;
            if (!state || state.phase !== 'cold' || !['grouped', 'hunting'].includes(state.activity) || !(state.vitals?.hp > 0)
                || partyIdOf(state) !== (participant.partyId || null) || state.spotId !== event.spotId
                || state.stats?.travel || state.stats?.coldCompetition?.wait || state.stats?.supplyErrand
                || state.stats?.warehouseWorkflow || state.stats?.marketReturn
                || (state.simulation?.ownerId || 'legacy_main') !== 'legacy_main'
                || !participantAllowed(state.characterId) || !contestContextAllowed(state, event)
                || !memory.snapshot(state.characterId)
                || timestamp - Number(state.stats?.coldCompetition?.at || 0) < 120000
                || (!party && (state.activity !== 'hunting' || plan?.status !== 'active'
                    || Number(plan.next?.npcId || plan.targetNpcId || 0) !== event.npcId))) return { ok: false, reason: 'party_member_busy_or_changed' };
        }
        if (Number(party?.stats?.coldCompetition?.conflictUntil || 0) > timestamp
            || members.some(s => Number(s.stats?.coldCompetition?.conflictUntil || 0) > timestamp)) return { ok: false, reason: 'conflict_cooldown' };
        sides.push({ principal, party, members });
    }
    const states = sides.flatMap(side => side.members);
    if (new Set(states.map(s => s.characterId)).size !== states.length || states.length > 18) return { ok: false, reason: 'overlapping_sides' };
    const revisions = new Map(states.map(s => [s.characterId, memory.snapshot(s.characterId).revision]));
    const roles = new Map();
    for (const [index, side] of sides.entries()) {
        for (const member of side.members) roles.set(member.characterId, member.characterId === side.principal.characterId
            ? (index === 0 ? 'initiator' : 'target')
            : reaction(member, side.principal, sides[1 - index].principal, memory, personaFor, rng, timestamp));
    }
    const deescalated = sides.some(side => side.party && (roles.get(side.party.leaderId) === 'deescalate'
        || side.members.filter(s => roles.get(s.characterId) === 'deescalate').length > side.members.length / 2));
    const involved = side => side.members.filter(s => s.characterId === side.principal.characterId || roles.get(s.characterId) === 'support');
    const power = side => {
        const supporters = involved(side);
        return supporters.reduce((sum, s) => sum + Number(s.level || 1), 0) / supporters.length + Math.log2(supporters.length) * 4;
    };
    const displaced = !deescalated && rng() < clamp(0.5 + (power(sides[0]) - power(sides[1])) / 40, 0.1, 0.9);
    const losingIndex = displaced ? 1 : 0;
    const outcome = deescalated ? 'deescalated' : displaced ? 'displaced' : 'held_ground';
    const episode = { key: event.key, at: timestamp, action: 'contest', npcId: event.npcId,
        conflictUntil: timestamp + cooldownMs, outcome };
    const wait = { start: timestamp, until: timestamp + waitMs };
    const preparedParties = sides.map((side, index) => {
        if (!side.party) return null;
        const delayed = !deescalated && index === losingIndex;
        const prepared = parties.prepareCommit({ ...side.party,
            nextResolveAt: delayed ? Math.max(timestamp, Number(side.party.nextResolveAt || 0)) + waitMs : side.party.nextResolveAt,
            stats: { ...side.party.stats, coldCompetition: { ...episode, peerId: sides[1 - index].principal.characterId,
                ...(delayed ? { wait } : {}) } } });
        prepared.row.updatedAt = Math.max(prepared.row.updatedAt, side.party.updatedAt + 1);
        prepared.snapshot.updatedAt = prepared.row.updatedAt;
        return prepared;
    });
    const next = sides.flatMap((side, index) => side.members.map(state => {
        const delayed = !deescalated && index === losingIndex;
        return { ...state, stats: { ...state.stats, coldCompetition: { ...state.stats?.coldCompetition, ...episode,
            peerId: sides[1 - index].principal.characterId, role: roles.get(state.characterId),
            ...(delayed ? { wait } : {}) } }, timing: delayed ? { ...state.timing,
                nextResolveAt: preparedParties[index]?.row.nextResolveAt
                    || Math.max(timestamp, Number(state.timing?.nextResolveAt || 0)) + waitMs } : state.timing };
    }));
    // Linear attribution: the direct target remembers actual aggressors;
    // defending supporters remember the initiator. Bystanders get no offense.
    const events = [];
    if (!deescalated) {
        const add = (sourceId, targetId) => events.push({ key: `${event.key}:${sourceId}:${targetId}`, sourceId, targetId,
            kind: 'character', type: 'mob_contested', at: timestamp });
        involved(sides[0]).forEach(s => add(sides[1].principal.characterId, s.characterId));
        involved(sides[1]).filter(s => s.characterId !== sides[1].principal.characterId)
            .forEach(s => add(s.characterId, sides[0].principal.characterId));
    }
    const { grants } = await owner.claimBatch(states, { timestamp, allowParty: true, allowLifecycle: true });
    try {
        if (grants.length !== states.length) return { ok: false, reason: 'claim_rejected' };
        if (states.some(s => !participantAllowed(s.characterId) || !contestContextAllowed(s, event)
            || memory.snapshot(s.characterId)?.revision !== revisions.get(s.characterId))) return { ok: false, reason: 'contest_changed_during_claim' };
        const group = { id: event.key, memberIds: states.map(s => s.characterId), partyChanges: preparedParties.flatMap((prepared, index) => prepared ? [{
            partyId: prepared.row.partyId, expectedUpdatedAt: sides[index].party.updatedAt,
            memberIds: sides[index].party.memberIds, nextResolveAt: prepared.row.nextResolveAt,
            statsJson: prepared.row.statsJson, updatedAt: prepared.row.updatedAt }] : []) };
        const results = await owner.commitAndReleaseBatch(next.map((state, index) => ({
            token: grants.find(g => g.characterId === state.characterId), nextState: state, atomicGroup: group,
            options: { allowParty: true, allowLifecycle: true }, proposal: { baseState: states[index],
                result: { memoryEvents: events.filter(e => e.sourceId === state.characterId) } }
        })), { timestamp: now() });
        if (results.length !== states.length || results.some(r => !r.ok)) return { ok: false, reason: 'commit_rejected' };
        preparedParties.filter(Boolean).forEach(prepared => parties.acceptCommit(prepared));
        return { ok: true, deescalated, outcome, pvp: false,
            matchup: sides.map(s => s.party ? 'party' : 'solo').join('_vs_'),
            affectedIds: deescalated ? [] : sides[losingIndex].members.map(s => s.characterId),
            participants: [...roles].map(([id, role]) => ({ id, role })), memoryEvents: events.length,
            ...(deescalated ? {} : { waitUntil: wait.until, victimId: sides[1].principal.characterId }) };
    } finally {
        const owned = grants.filter(g => life.cachedState(g.characterId)?.simulation?.leaseId === g.leaseId);
        if (owned.length) await owner.releaseBatch(owned);
        states.forEach(s => onState(s.characterId));
    }
}

module.exports = { apply, reaction };
