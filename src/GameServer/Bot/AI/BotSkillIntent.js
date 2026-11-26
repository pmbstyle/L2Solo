const Rules = invoke('GameServer/Skills/C4SkillRules');
const Effects = invoke('GameServer/Effects/EffectStore');
const Roles = invoke('GameServer/Bot/AI/BotRoles');
const Attack = invoke('GameServer/Skills/WeaponMask');

function alive(actor) {
    return !!actor && actor.isDead?.() !== true && actor.state?.fetchDead?.() !== true && !(actor.fetchHp?.() <= 0);
}

function usable(actor, skill, reserve = 0) {
    if (!skill || skill.fetchPassive?.() || !alive(actor) || !invoke('GameServer/Effects/EffectRestrictions').canCast(actor) || actor.canUseSkill?.(skill) === false) return false;
    const semantic = skill.fetchSemantic?.() || {};
    if (semantic.notUsedInC4) return false;
    const mp = Number(actor.fetchMp?.() || 0), maxMp = Math.max(1, Number(actor.fetchMaxMp?.() || mp || 1));
    const cost = Math.max(0, Number(skill.fetchConsumedMp?.() || 0));
    if (cost > mp || (mp - cost) / maxMp < reserve) return false;
    if (Number(skill.fetchConsumedHp?.() || 0) >= Number(actor.fetchHp?.() || Infinity)) return false;
    const limit = semantic.condition?.actorHpPercentAtMost;
    if (limit != null && Number(actor.fetchHp?.()) / Math.max(1, Number(actor.fetchMaxHp?.())) * 100 > limit) return false;
    const required = Number(semantic.requires?.weaponsAllowed) || 0;
    return !required || (required & Attack.weaponMaskFor(actor)) !== 0;
}

function inRange(actor, target, skill) {
    const range = Number(skill.fetchDistance?.());
    if (!Number.isFinite(range) || range < 0) return true;
    if (!actor.fetchLocX || !target?.fetchLocX) return true;
    return Math.hypot(actor.fetchLocX()-target.fetchLocX(),actor.fetchLocY()-target.fetchLocY()) <= range;
}

// Is a cast pointless given the effects running on its target (plain records:
// id, key, level, stackFamily, stackOrder)? A buff is pointless under an equal
// or stronger copy of itself or of its C4 stack family. A heal over time is
// worth its remaining ticks: a cast over a running member of its skill or
// stack family removes it (Lisvus CancelLesserEffect, EffectStore) and throws
// those ticks away, so the bot lets it run; an emergency heal takes a stronger
// member over it (our choice: C4 lets a player overwrite). One answer hot and
// cold: equivalentActive (hot) and BackgroundResolver.chooseHeal (cold, the
// worker loads this module: no packet or geodata import at the top).
function equivalentIn(effects, semantic, selfId, level, emergency = false) {
    const keep = !!semantic.hot && !emergency;
    return effects.some(effect => {
        if (Number(effect.id) === Number(selfId) || (semantic.effect && effect.key === semantic.effect)) {
            return keep || Number(effect.level || 1) >= Number(level || 1);
        }
        return !!semantic.stackFamily && effect.stackFamily === semantic.stackFamily
            && (keep || Number(effect.stackOrder ?? 0) >= Number(semantic.stackOrder ?? 0));
    });
}

function equivalentActive(target, skill, { emergency = false } = {}) {
    return equivalentIn(Effects.list(target), skill.fetchSemantic?.() || {}, skill.fetchSelfId?.(), skill.fetchLevel?.(), emergency);
}

function debuffUseful(actor, target, skill, { primary = false, fleeing = false } = {}) {
    if (actor.session && !invoke('GameServer/Bot/AI/HotPartyCastTracker').mayCast(actor.session, target, skill)) return false;
    if (!alive(target) || !inRange(actor,target,skill)) return false;
    if (invoke('GameServer/Bot/AI/BotActionFeedback').blocked(actor,target,skill)) return false;
    const semantic = skill.fetchSemantic?.() || {};
    if (semantic.undeadOnly && target.fetchUndead?.() !== true) return false;
    if (semantic.mobOnly && target.fetchAttackable?.() !== true) return false;
    if (semantic.skillType === Rules.CANCEL || semantic.skillType === Rules.BANE) {
        return Effects.list(target).some(effect=>effect.type !== 'debuff' && effect.dispellable !== false
            && (!semantic.baneStackFamilies || semantic.baneStackFamilies.includes(effect.stackFamily)));
    }
    if (equivalentActive(target,skill)) return false;
    const effect = String(semantic.effect || '');
    if (primary && !fleeing && /sleep|fear/.test(effect)) return false;
    const classId = Roles.classIdOf(target);
    if (classId != null) {
        const role=Roles.inferRole(target), caster=['mage','healer','buffer'].includes(role);
        if (effect === 'silence' && !caster) return false;
        if (effect === 'physical_mute' && ['mage','healer'].includes(role)) return false;
    }
    if (fleeing && !/sleep|fear|root|stun|slow/.test(effect)) return false;
    return true;
}

module.exports = { alive, usable, inRange, equivalentIn, equivalentActive, debuffUseful };
