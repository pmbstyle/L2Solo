// Pure social decisions. A forecast is not an accepted encounter or a memory event.
const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, Number(value) || 0));
function traits(persona = {}) {
    const t = persona.traits || {};
    return Object.fromEntries(['sociability', 'commitment', 'caution', 'ambition', 'assertiveness', 'empathy', 'resilience']
        .map(key => [key, clamp(t[key] ?? 0.5)]));
}
function feeling(relation) {
    if (!relation?.ready || !relation.personal) return { warmth: 0, hostility: 0, fear: 0 };
    const p = relation.personal;
    return { warmth: clamp((p.affinity + p.trust * 2) / 30, -1, 1),
        hostility: clamp(p.hostility / 30), fear: clamp(p.fear / 30) };
}
function decide({ pressure, actor, peer, actorPersona, peerPersona, towardPeer, towardActor, rng }) {
    const shortage = clamp((pressure - 1) / 2);
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
    const contest = clamp(shortage * (0.03 + a.ambition * 0.12 + a.assertiveness * 0.15
        + ab.hostility * 0.2 - a.empathy * 0.15 - a.caution * 0.1 - Math.max(0, ab.warmth) * 0.2), 0, 0.35);
    if (rng() < contest) {
        const escalation = clamp(0.01 + b.assertiveness * 0.1 + ba.hostility * 0.15
            - b.caution * 0.08 - b.resilience * 0.06 - b.empathy * 0.04, 0, 0.2);
        return { action: 'contest', pvpIntent: rng() < escalation, reason: 'resource_dispute' };
    }
    return { action: 'yield', pvpIntent: false, reason: 'tolerate_competition' };
}

module.exports = { decide };
