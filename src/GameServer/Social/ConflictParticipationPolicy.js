// Pure, bounded participation decisions shared by hot and cold encounters.
const clamp = (n, low = 0, high = 1) => Math.max(low, Math.min(high, n));

function reaction(state, principal, opponent, memory, personaFor, rng, now) {
    const towardPrincipal = memory.assess({ id: state.characterId }, { id: principal.characterId }, {}, now);
    const towardOpponent = memory.assess({ id: state.characterId }, { id: opponent.characterId }, {}, now);
    if (!towardPrincipal.ready || !towardOpponent.ready || state.canParticipate === false) return 'stand_aside';
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

function select(sides, memory, personaFor, rng, now) {
    const ids = sides.flatMap(side => side.members.map(s => s.characterId));
    if (sides.length !== 2 || sides.some(side => side.members.length < 1 || side.members.length > 9
        || !side.members.some(s => s.characterId === side.principal.characterId))
        || new Set(ids).size !== ids.length) throw new Error('invalid conflict participants');
    const roles = new Map();
    for (const [index, side] of sides.entries()) {
        // An identical roster must not change its decisions after IPC or a
        // different ordering of the live party index.
        for (const member of side.members.slice().sort((a, b) => a.characterId - b.characterId)) {
            roles.set(member.characterId, member.characterId === side.principal.characterId
                ? (index === 0 ? 'initiator' : 'target')
                : reaction(member, side.principal, sides[1 - index].principal, memory, personaFor, rng, now));
        }
    }
    const deescalated = sides.some(side => side.party && (roles.get(side.party.leaderId) === 'deescalate'
        || side.members.filter(s => roles.get(s.characterId) === 'deescalate').length > side.members.length / 2));
    return { roles, deescalated };
}

module.exports = { reaction, select };
