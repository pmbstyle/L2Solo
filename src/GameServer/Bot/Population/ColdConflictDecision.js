const Policy = require('../../Social/ResourceCompetitionPolicy');

// A forecast lives for a few seconds. Reassess it against current participants
// before taking leases; never turn ordinary state writes into cancelled meetings.
// Reusing the original draws also prevents retries from fishing for a PvP roll.
function refresh(event, { life, parties, memory, personaFor }, timestamp) {
    if (event.contextVersion !== 1) return { event };
    const sides = [];
    for (const old of [event.actor, event.peer]) {
        const state = life.cachedState(old.id);
        if (!state) return { reason: 'participant_missing' };
        const partyId = state.party?.partyId || state.partyId || null;
        const party = partyId ? parties?.find(partyId) : null;
        if (partyId && (!party || party.status !== 'active' || !Array.isArray(party.memberIds)
            || party.memberIds.length < 2 || party.memberIds.length > 9
            || !party.memberIds.includes(old.id) || !party.memberIds.includes(party.leaderId)
            || new Set(party.memberIds).size !== party.memberIds.length)) return { reason: 'party_roster_unavailable' };
        const members = party ? party.memberIds.map(id => life.cachedState(id)) : [state];
        if (members.some(s => !s)) return { reason: 'party_roster_unavailable' };
        sides.push({ state, members, participant: { ...old, partyId, size: members.length,
            level: members.reduce((sum, s) => sum + Number(s.level || 1), 0) / members.length,
            partyUpdatedAt: party?.updatedAt, revision: Number(state.simulation?.revision || 0) } });
    }
    if (sides[0].members.some(a => sides[1].members.some(b => a.characterId === b.characterId))) {
        return { reason: 'overlapping_sides' };
    }
    const [a, b] = sides;
    const ab = memory.assess({ id: a.state.characterId }, { id: b.state.characterId }, {}, timestamp);
    const ba = memory.assess({ id: b.state.characterId }, { id: a.state.characterId }, {}, timestamp);
    if (!ab.ready || !ba.ready) return { reason: 'memory_unavailable' };
    a.participant.memoryRevision = ab.revision;
    b.participant.memoryRevision = ba.revision;
    let decision = {};
    if (event.action === 'contest') {
        const rolls = event.decisionRolls;
        if (!Array.isArray(rolls) || rolls.length !== 4 || rolls.some(r => !Number.isFinite(r) || r < 0 || r >= 1)) {
            return { reason: 'invalid_decision_rolls' };
        }
        let index = 0;
        decision = Policy.decide({ pressure: event.pressure, actor: a.participant, peer: b.participant,
            actorPersona: personaFor(a.state), peerPersona: personaFor(b.state),
            towardPeer: ab, towardActor: ba, rng: () => rolls[index++] });
        if (decision.action !== 'contest') return { reason: 'decision_changed', decision: decision.action };
    }
    // Revenge has its own saved roll and is re-evaluated by ColdPartyConflict.
    return { event: { ...event, ...decision, actor: a.participant, peer: b.participant }, refreshed: true };
}

module.exports = { refresh };
