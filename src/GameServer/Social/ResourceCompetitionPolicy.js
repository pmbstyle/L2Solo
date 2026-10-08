// Shared social decisions. A forecast is not an accepted encounter or a memory event.
const Config = require('../Bot/Population/PopulationConfig');
const { scaleChance, retreatChance } = require('./PvpAggression');
const Visible = require('./VisibleStrength');
const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, Number(value) || 0));
function traits(persona = {}) {
    const t = persona?.traits || {};
    return Object.fromEntries(['sociability', 'commitment', 'caution', 'ambition', 'assertiveness', 'empathy', 'resilience']
        .map(key => [key, clamp(t[key] ?? 0.5)]));
}
// A clanmate is met at least as the 'friendly' stance of InteractionMemoryPolicy
// (trust >= 5): clanmates share a crowded spot instead of disputing it.
const CLANMATE_WARMTH = (5 * 2) / 30;
function sameClan(relation) {
    return Number(relation?.sourceClanId) > 0 && Number(relation.sourceClanId) === Number(relation.targetClanId);
}
function feeling(relation) {
    const p = relation?.ready ? (relation.effective || relation.personal) : null;
    const result = p
        ? { warmth: clamp((p.affinity + p.trust * 2) / 30, -1, 1), hostility: clamp(p.hostility / 30), fear: Visible.fear(relation) }
        : { warmth: 0, hostility: 0, fear: 0 };
    if (sameClan(relation)) result.warmth = Math.max(result.warmth, CLANMATE_WARMTH);
    return result;
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
    const chance = clamp(0.45 + t.assertiveness * 0.4 + relation.hostility * 0.6
        - t.caution * 0.15 - t.resilience * 0.1 - t.empathy * 0.22
        - Math.max(0, relation.warmth) * 0.7 - relation.fear * 0.5, 0, 0.8) * disciplineRestraint(persona, towardOpponent);
    return scaleChance(chance, Config.pvpAggression);
}
// Can I win? Only by what a player sees (U26). A unit may carry own (how it
// knows itself) and seen (how others see it); otherwise its look and size.
function view(unit, field) {
    return unit[field] || { look: unit.look, people: unit.people ?? unit.size };
}

// key: the encounter's key; each side's can-I-win is rolled once here and
// returned as willing [actor, peer], carried on to give-way and the PvP start.
// willing: the rolls already taken for this encounter (a re-check reuses them).
function decide({ pressure, actor, peer, actorPersona, peerPersona, towardPeer, towardActor, rng, key, willing = null, actorKnowledge = null, peerKnowledge = null }) {
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
    const sides = willing || [[actor, peer, a, ab, actorKnowledge], [peer, actor, b, ba, peerKnowledge]].map(([own, other, t, f, knowledge], index) =>
        Visible.willing(Visible.canWin({ own: view(own, 'own'), other: view(other, 'seen'), traits: t, fear: f.fear,
            knowledge }), key, 'can_win', index));
    const cooperate = clamp(0.1 + (a.sociability + b.sociability) * 0.2 + friendly * 0.35 - hostile * 0.6, 0, 0.8);
    if (canGroup && rng() < cooperate) {
        return { action: 'offer_party', pvpIntent: false, reason: 'shared_target', willing: sides,
            accepted: rng() < clamp(0.15 + b.sociability * 0.35 + b.empathy * 0.15 + ba.warmth * 0.3 - ba.hostility * 0.5, 0, 0.85) };
    }
    const outmatched = !sides[0];
    const retreat = clamp(a.caution * (outmatched ? 0.65 : 0.15) + ab.fear * 0.4 + hostile * a.caution * 0.2, 0, 0.85);
    if (rng() < retreatChance(retreat, Config.pvpAggression)) return { action: 'avoid', pvpIntent: false, reason: outmatched ? 'outmatched' : 'avoid_conflict', willing: sides };
    const contest = clamp(shortage * (0.3 + a.ambition * 0.35 + a.assertiveness * 0.4
        + ab.hostility * 0.25 - a.empathy * 0.12 - a.caution * 0.1 - Math.max(0, ab.warmth) * 0.6), 0, 0.85) * disciplineRestraint(actorPersona, towardPeer);
    if (rng() < contest) {
        const escalation = escalationChance(peerPersona, towardActor);
        return { action: 'contest', pvpIntent: rng() < escalation, reason: 'resource_dispute', willing: sides };
    }
    return { action: 'yield', pvpIntent: false, reason: 'tolerate_competition', willing: sides };
}

module.exports = { decide, escalationChance };
