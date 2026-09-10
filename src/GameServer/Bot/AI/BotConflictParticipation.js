const Policy = require('../../Social/ConflictParticipationPolicy');
const Memory = invoke('GameServer/Social/InteractionMemoryRuntime');
const Threats = invoke('GameServer/Bot/AI/BotPvpThreats');
const Voice = invoke('GameServer/Bot/AI/BotChatVoice');
const id = session => Number(session?.actor?.fetchId?.() || 0);
const partyId = session => session?.coldLifeState?.party?.partyId || null;
const autonomous = session => String(session?.accountId || '').startsWith('bot_') && !session.partyCompanion;
function available(session, now) {
    return autonomous(session) && session.aiActive !== false && !session.staticService && !session.arenaEphemeral
        && ['hunting', 'following', 'resting'].includes(session.plan)
        && !session.pvpDefense && !session.pvpRevenge && !session.pendingPvpProvocation
        && !Threats.context(session, now).threats.length
        && invoke('GameServer/Effects/EffectRestrictions').canUseBasicAction(session.actor);
}

function side(principal, now, decisions = true) {
    const grouped = autonomous(principal) && partyId(principal) && partyId(principal) !== 'forming';
    const sessions = (grouped ? Threats.members(principal) : [principal]).filter(s =>
        Threats.alive(s.actor) && Threats.distance(s.actor, principal.actor) <= Threats.PARTY_RADIUS);
    if (!sessions.includes(principal)) sessions.push(principal);
    // Invalid oversized live parties fail closed instead of truncating away
    // the leader or silently changing a majority.
    if (sessions.length > 9) return null;
    const members = sessions.map(session => ({ characterId: id(session),
        ...(decisions ? { persona: Voice.profile(session),
        canParticipate: available(session, now) } : {}) }));
    return { principal: members.find(s => s.characterId === id(principal)), members,
        party: grouped ? { partyId: partyId(principal), leaderId: Number(principal.coldLifeState?.party?.leaderId || 0) } : null };
}

function prepare(session, target, now, rng) {
    // Human-led companion parties keep their existing combat coordination.
    if (!autonomous(session)) return null;
    const sides = [side(session, now), side(target.session || { actor: target }, now)];
    if (sides.some(s => !s)) return { blocked: true };
    const { roles, deescalated } = Policy.select(sides, Memory, s => s.persona, rng, now);
    return { at: now, deescalated, participants: [...roles].map(([id, role]) => ({ id, role })),
        sides: sides.map(s => ({ principalId: s.principal.characterId, partyId: s.party?.partyId || null,
            leaderId: s.party?.leaderId || 0, memberIds: s.members.map(m => m.characterId).sort((a, b) => a - b) })) };
}

function valid(episode, session, target, now) {
    if (!episode) return true;
    if (episode.blocked) return false;
    return [session, target.session || { actor: target }].every((principal, index) => {
        const current = side(principal, now, false), before = episode.sides[index];
        return current && before.principalId === id(principal) && before.partyId === (current.party?.partyId || null)
            && before.leaderId === (current.party?.leaderId || 0)
            && JSON.stringify(before.memberIds) === JSON.stringify(current.members.map(m => m.characterId).sort((a, b) => a - b));
    });
}

function supports(episode, member) {
    if (!episode) return true;
    return !episode.blocked && !episode.deescalated && episode.sides[0].memberIds.includes(id(member))
        && episode.participants.some(p => p.id === id(member) && ['initiator', 'support'].includes(p.role));
}

module.exports = { prepare, valid, supports, side, autonomous, available };
