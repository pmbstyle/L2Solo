'use strict';

// Owner: when a summoner heals its pet, hot (SummonerTactics) and cold
// (BackgroundResolver) alike, and what those heals hold off (the solo gate,
// BotTargetMatchup.sideLifetime; the offline hunt model). The summoner keeps
// its pet alive as a party member (docs/game-decisions.md, 10-30): it heals
// the pet below the party heal line (PartyHealPolicy.HEAL_BELOW), in a fight
// and between fights, solo and in a party.

const C4SkillRules = invoke('GameServer/Skills/C4SkillRules');
const EffectStore = invoke('GameServer/Effects/EffectStore');
const Formulas = invoke('GameServer/Formulas');
const { HEAL_BELOW } = invoke('GameServer/Bot/AI/PartyHealPolicy');

const PET_HEAL_BELOW = HEAL_BELOW;

function wantsHeal(hp, maxHp) {
    return Number(maxHp) > 0 && Number(hp) > 0 && Number(hp) / Number(maxHp) < PET_HEAL_BELOW;
}

// A skill that heals the caster's pet (Servitor Heal; not Servitor Cure,
// a cleanse): read by meaning, a hot skill or a cold skill record alike.
function isPetHeal(skill) {
    if (!skill || skill.passive === true || skill.fetchPassive?.() === true) return false;
    const semantic = skill.fetchSemantic?.() || C4SkillRules.resolveCached(skill);
    return semantic.skillType === C4SkillRules.HEAL && semantic.target === 'pet';
}

// The pet heal an owner casts now, on the actor API (a hot actor, or a cold
// profile through ColdClassPolicy.actorFor): its highest level with the reuse
// and MP ready; none while the owner may not cast (silence, stun: the cast
// would be refused, SkillRequest), so a silenced bot walks on, not stalls.
// options.anyReuse: one on its reuse counts too (restView).
function choose(actor, options = {}) {
    const impairments = EffectStore.impairments(actor);
    if (impairments.disabled || impairments.silenced || impairments.magicMuted) return null;
    const skills = actor?.skillset?.skills || actor?.skillset?.fetchSkills?.() || [];
    const mp = Number(actor.fetchMp?.() || 0);
    let best = null;
    for (const skill of skills) {
        if (!isPetHeal(skill) || (options.anyReuse !== true && actor.canUseSkill?.(skill) === false)
            || Number(skill.fetchConsumedMp?.() || 0) > mp) continue;
        if (!best || Number(skill.fetchLevel?.() || 0) > Number(best.fetchLevel?.() || 0)) best = skill;
    }
    return best;
}

// A living pet as the rest rule reads it (RestPolicy.needsRest options.pet):
// { ratio, healable }, healable when its owner (the actor API) may heal it
// now or once the reuse ends; null without a pet.
function restView(actor, hp, maxHp) {
    if (!(Number(maxHp) > 0) || !(Number(hp) > 0)) return null;
    return { ratio: Number(hp) / Number(maxHp), healable: !!choose(actor, { anyReuse: true }) };
}

// The HP one pet heal restores (C4SkillEffects.applyHeal: a spiritshot
// boosts it). shot: { spiritshot, blessedSpiritshot } or null.
function amount(record, shot = null) {
    return Math.max(0, Formulas.calcHealAmount(record.power, shot?.spiritshot ? shot : {}));
}

// An owner's best pet heal as numbers: { amount, mp, castMs, reuseMs }, null
// without one. records: cold skill records; castMsOf(record): its action time.
function sustainOf(records, castMsOf) {
    let best = null;
    for (const record of records || []) if (isPetHeal(record) && (!best || Number(record.level) > Number(best.level))) best = record;
    return best ? { amount: Math.max(1, amount(best)), mp: Number(best.mp) || 0,
        castMs: Math.max(1, Number(castMsOf(best)) || 0), reuseMs: Math.max(1, Number(best.reuse) || 0) } : null;
}

// How long a pet of hp lives under incoming damage per second while its
// owner heals it (sustainOf), one heal per reuse, as long as ownerMp pays:
// its HP over the damage less the heal rate, and no longer than its HP plus
// every heal the MP pays for over the damage. Infinity without damage.
function healedLifetime(hp, incoming, sustain, ownerMp) {
    if (!(incoming > 0)) return Infinity;
    if (!sustain) return hp / incoming;
    const rate = sustain.amount / (Math.max(sustain.reuseMs, sustain.castMs) / 1000);
    const paid = sustain.mp > 0 ? Math.floor(Math.max(0, Number(ownerMp) || 0) / sustain.mp) : Infinity;
    const byRate = rate < incoming ? hp / (incoming - rate) : Infinity;
    return Math.min(byRate, (hp + paid * sustain.amount) / incoming);
}

module.exports = { PET_HEAL_BELOW, wantsHeal, isPetHeal, choose, restView, amount, sustainOf, healedLifetime };
