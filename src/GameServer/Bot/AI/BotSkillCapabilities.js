const C4SkillRules = invoke('GameServer/Skills/C4SkillRules');
const BuffCatalog = invoke('GameServer/Effects/BuffCatalog');

const FRIENDLY_HEAL_TYPES = new Set([
    C4SkillRules.HEAL,
    C4SkillRules.HEAL_PERCENT,
    C4SkillRules.HEAL_STATIC,
    C4SkillRules.HEAL_HOT,
    C4SkillRules.HEAL_CLEANSE
]);

function activeSkills(actor) {
    return (actor?.skillset?.skills || []).filter((skill) => skill && !skill.fetchPassive?.());
}

function learnedSkill(actor, selfId) {
    return actor?.skillset?.fetchSkill?.(selfId) || null;
}

function healSkill(actor) {
    return activeSkills(actor)
        .filter((skill) => FRIENDLY_HEAL_TYPES.has(skill.fetchSkillType?.()))
        .filter((skill) => ['friendly', 'party'].includes(skill.fetchTargetKind?.()))
        .sort((a, b) => {
            const aTarget = a.fetchTargetKind?.() === 'friendly' ? 1 : 0;
            const bTarget = b.fetchTargetKind?.() === 'friendly' ? 1 : 0;
            return bTarget - aTarget || Number(b.fetchPower?.() || 0) - Number(a.fetchPower?.() || 0);
        })[0] || null;
}

function buffSkill(actor, buffType) {
    const buff = BuffCatalog.byTypeOrKey(buffType);
    return buff ? learnedSkill(actor, buff.id) : null;
}

module.exports = {
    aggressionSkill: (actor) => learnedSkill(actor, 28),
    buffSkill,
    healSkill,
    learnedSkill
};
