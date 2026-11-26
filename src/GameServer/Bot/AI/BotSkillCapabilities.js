const C4SkillRules = invoke('GameServer/Skills/C4SkillRules');
const BuffCatalog = invoke('GameServer/Effects/BuffCatalog');

const FRIENDLY_HEAL_TYPES = new Set([
    C4SkillRules.HEAL,
    C4SkillRules.HEAL_PERCENT,
    C4SkillRules.HEAL_STATIC,
    C4SkillRules.HEAL_HOT,
    C4SkillRules.HOT,
    C4SkillRules.HEAL_CLEANSE
]);
const FRIENDLY_MANA_TYPES = new Set([
    C4SkillRules.MANA_RECHARGE,
    C4SkillRules.MANA_HEAL
]);

function activeSkills(actor) {
    return (actor?.skillset?.skills || []).filter((skill) => skill && !skill.fetchPassive?.());
}

function learnedSkill(actor, selfId) {
    return actor?.skillset?.fetchSkill?.(selfId) || null;
}

function healSkills(actor) {
    return activeSkills(actor)
        .filter((skill) => FRIENDLY_HEAL_TYPES.has(skill.fetchSkillType?.()))
        .filter((skill) => ['friendly', 'party', 'ally'].includes(skill.fetchTargetKind?.()));
}

function healName(skill) {
    return String(skill?.fetchName?.() || skill?.model?.name || '').toLowerCase();
}

function selectHealSkill(actor, { emergency = false, group = false, target = null, fallbackGroup = false } = {}) {
    const usable = healSkills(actor).filter((skill) => {
        if (!target) return true;
        const semantic = skill.fetchSemantic?.() || {};
        if (semantic.hot && invoke('GameServer/Bot/AI/BotSkillIntent').equivalentActive(target, skill, { emergency })) return false;
        if (skill.fetchTargetKind?.() !== 'ally' || target === actor) return true;
        // Paagrio healing reaches clan/alliance members, rather than every
        // party member. Match the native ally fanout before choosing it.
        const clanId = Number(actor.fetchClanId?.()) || 0;
        const PledgeHelpers = invoke('GameServer/Network/Response/PledgeHelpers');
        const allyId = PledgeHelpers.allyId(actor);
        return (clanId > 0 && Number(target.fetchClanId?.()) === clanId)
            || (allyId > 0 && PledgeHelpers.allyId(target) === allyId);
    });
    const single = usable.filter((skill) => skill.fetchTargetKind?.() === 'friendly');
    const area = usable.filter((skill) => ['party', 'ally'].includes(skill.fetchTargetKind?.()));
    const pool = group ? area : single.length ? single : fallbackGroup ? area : [];
    if (pool.length === 0) return null;
    // A heal over time ranks by its heal per tick, as PartyHealPolicy.score
    // reads it (its power column is 1).
    const power = (skill) => {
        const semantic = skill.fetchSemantic?.() || {};
        return semantic.skillType === C4SkillRules.HOT ? Number(semantic.hot?.heal || 0) : Number(skill.fetchPower?.() || 0);
    };
    return pool.sort((a, b) => {
        const aBattle = /battle heal/.test(healName(a)) ? 1 : 0;
        const bBattle = /battle heal/.test(healName(b)) ? 1 : 0;
        const urgency = emergency ? bBattle - aBattle : aBattle - bBattle;
        return urgency ||
            power(b) - power(a) ||
            Number(a.fetchConsumedMp?.() || 0) - Number(b.fetchConsumedMp?.() || 0);
    })[0] || null;
}

function healSkill(actor) {
    return selectHealSkill(actor);
}

function buffSkill(actor, buffType) {
    const requested = String(buffType || '').trim().toLowerCase().replace(/\s+/g, '_');
    const buff = BuffCatalog.byTypeOrKey(requested);
    const direct = buff ? learnedSkill(actor, buff.id) : null;
    if (direct) return direct;
    return supportBuffs(actor).find((entry) => entry.type === requested || entry.key === requested || entry.name.toLowerCase() === String(buffType || '').trim().toLowerCase())?.skill || null;
}

function supportBuffs(actor) {
    return activeSkills(actor)
        .map((skill) => ({ skill, semantic: skill.fetchSemantic?.() || {} }))
        .filter(({ skill, semantic }) => semantic.effectType === 'buff' && ['friendly', 'ally', 'party'].includes(semantic.target || skill.fetchTargetKind?.()))
        .map(({ skill, semantic }) => ({
            type: String(semantic.effect || '').toLowerCase(),
            key: String(semantic.effect || '').toLowerCase(),
            name: skill.model?.name || semantic.effect || `Skill ${skill.fetchSelfId?.()}`,
            skill
        }))
        .filter((entry) => entry.type);
}

function manaRechargeSkill(actor) {
    return activeSkills(actor)
        .filter((skill) => FRIENDLY_MANA_TYPES.has(skill.fetchSkillType?.()))
        .filter((skill) => ['friendly', 'party'].includes(skill.fetchTargetKind?.()))
        .filter((skill) => actor.canUseSkill?.(skill) !== false)
        .filter((skill) => Number(actor.fetchMp?.() || 0) >= Number(skill.fetchConsumedMp?.() || 0))
        .sort((a, b) => Number(b.fetchPower?.() || 0) - Number(a.fetchPower?.() || 0))[0] || null;
}

module.exports = {
    aggressionSkill: (actor) => learnedSkill(actor, 28),
    buffSkill,
    supportBuffs,
    healSkills,
    selectHealSkill,
    healSkill,
    manaRechargeSkill,
    learnedSkill
};
