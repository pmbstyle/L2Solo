// Pure social decisions. A forecast is not an accepted encounter or a memory event.
const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, Number(value) || 0));
function traits(persona = {}) {
    const t = persona.traits || {};
    return Object.fromEntries(['sociability', 'commitment', 'caution', 'ambition', 'assertiveness', 'empathy', 'resilience']
        .map(key => [key, clamp(t[key] ?? 0.5)]));
}
function feeling(relation) {
    if (!relation?.ready || !(relation.effective || relation.personal)) return { warmth: 0, hostility: 0, fear: 0 };
    const p = relation.effective || relation.personal;
    return { warmth: clamp((p.affinity + p.trust * 2) / 30, -1, 1),
        hostility: clamp(p.hostility / 30), fear: clamp(p.fear / 30) };
}
function disciplineRestraint(persona, relation) {
    const stage = relation?.clanSocial?.selfDiscipline?.stage;
    const weight = { concern: 0.2, warned: 0.4, probation: 0.7, expulsion_pending: 0.85 }[stage] || 0;
    const t = traits(persona);
    return 1 - weight * (t.commitment + t.empathy) / 2;
}
// An accepted dispute has the same escalation policy in both simulation modes.
// Intent is not attack permission; live combat must still validate its context.
function escalationChance(persona, towardOpponent) {
    if (!towardOpponent?.ready) return 0;
    const t = traits(persona), relation = feeling(towardOpponent);
    // This is a response to an actual resource offense, not aggression on sight.
    // Ordinary strangers can stand their ground; friendship and fear still calm them.
    return clamp(0.45 + t.assertiveness * 0.4 + relation.hostility * 0.6
        - t.caution * 0.15 - t.resilience * 0.1 - t.empathy * 0.22
        - Math.max(0, relation.warmth) * 0.7 - relation.fear * 0.5, 0, 0.8) * disciplineRestraint(persona, towardOpponent);
}
function decide({ pressure, actor, peer, actorPersona, peerPersona, towardPeer, towardActor, rng }) {
    // A moderate shortage is already noticeable; abundant resources never provoke a dispute.
    const shortage = Math.sqrt(clamp((pressure - 1) / 2));
    if (!shortage) return { action: 'coexist', pvpIntent: false, reason: 'resource_available' };
    const a = traits(actorPersona), b = traits(peerPersona);
    const ab = feeling(towardPeer), ba = feeling(towardActor);
    const friendly = Math.min(ab.warmth, ba.warmth);
    const hostile = Math.max(ab.hostility, ba.hostility, -ab.warmth, -ba.warmth);
    const canGroup = (!actor.partyId || !peer.partyId)
        && Math.abs(actor.level - peer.level) <= 4
        && (actor.size + peer.size <= 5);
    const cooperate = clamp(0.1 + (a.sociability + b.sociability) * 0.2 + friendly * 0.35 - hostile * 0.6, 0, 0.8);
    if (canGroup && rng() < cooperate) {
        return { action: 'offer_party', pvpIntent: false, reason: 'shared_target',
            accepted: rng() < clamp(0.15 + b.sociability * 0.35 + b.empathy * 0.15 + ba.warmth * 0.3 - ba.hostility * 0.5, 0, 0.85) };
    }
    const outmatched = peer.level + Math.log2(peer.size) * 4 > actor.level + Math.log2(actor.size) * 4 + 3;
    const retreat = clamp(a.caution * (outmatched ? 0.65 : 0.15) + ab.fear * 0.4 + hostile * a.caution * 0.2, 0, 0.85);
    if (rng() < retreat) return { action: 'avoid', pvpIntent: false, reason: outmatched ? 'outmatched' : 'avoid_conflict' };
    const contest = clamp(shortage * (0.3 + a.ambition * 0.35 + a.assertiveness * 0.4
        + ab.hostility * 0.25 - a.empathy * 0.12 - a.caution * 0.1 - Math.max(0, ab.warmth) * 0.6), 0, 0.85) * disciplineRestraint(actorPersona, towardPeer);
    if (rng() < contest) {
        const escalation = escalationChance(peerPersona, towardActor);
        return { action: 'contest', pvpIntent: rng() < escalation, reason: 'resource_dispute' };
    }
    return { action: 'yield', pvpIntent: false, reason: 'tolerate_competition' };
}

module.exports = { decide, escalationChance };
