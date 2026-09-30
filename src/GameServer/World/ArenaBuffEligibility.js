const SkillRules = require('../Skills/C4SkillRules');

// TARGET_SELF/effectType=buff describe normal skill use, not permission to
// activate combat states during arena preparation. Keep this policy local to
// the automatic arena profile; manual casts and their restrictions are intact.
function isAutomaticArenaBuff(skill) {
    const semantic = skill?.fetchSemantic?.();
    if (!semantic || skill.fetchPassive?.() === true || semantic.notUsedInC4) return false;
    if (skill.fetchTargetKind?.() !== 'self' || semantic.effectType !== 'buff') return false;
    if (![SkillRules.EFFECT, SkillRules.HEAL_PERCENT].includes(semantic.skillType)) return false;
    if (semantic.operateType === 'toggle' || semantic.selfEffect || semantic.condition) return false;

    // Totems and positional dagger Focus are mutually exclusive combat choices,
    // left to intentional skill use. Ordinary Focus has a different effect key.
    if (semantic.stackFamily === 'possession' || semantic.effect === 'dagger_focus') return false;

    const stats = semantic.stats || {};
    const bonuses = [stats, ...(semantic.conditionalStats || []).map((entry) => entry.stats || {}),
        ...(semantic.situationalStats || []).map((entry) => entry.stats || {})];
    if (bonuses.some((bonus) => ['immobile', 'fakeDeath', 'relaxing', 'silentMoving']
        .some((key) => bonus[key] === true))) return false;
    const duration = Number(skill.fetchBuffTime?.());
    if (!Number.isFinite(duration) || duration <= 0) return false;

    // An inferred or unsupported effect without any implemented bonus is not
    // a useful arena buff. Conditional/situational bonuses are still effects.
    return Object.keys(stats).length > 0
        || semantic.conditionalStats?.length > 0
        || semantic.situationalStats?.length > 0;
}

module.exports = { isAutomaticArenaBuff };
