const SkillModel = invoke('GameServer/Model/Skill');
const C4SkillRules = invoke('GameServer/Skills/C4SkillRules');

const activeSkills = require('../../../data/Skills/Active/active.json');
const npcActiveSkills = require('../../../data/Npcs/Skills/active.json');
const npcSkillRows = require('../../../data/Npcs/Skills/skills.json');

const skillTemplates = new Map(
    [...activeSkills, ...npcActiveSkills].map((skill) => [Number(skill.selfId), skill])
);

const skillsByNpc = new Map();
npcSkillRows.forEach((row) => {
    const npcId = Number(row.npcId);
    if (!skillsByNpc.has(npcId)) {
        skillsByNpc.set(npcId, []);
    }
    skillsByNpc.get(npcId).push({
        skillId: Number(row.skillId),
        level: Number(row.level) || 1
    });
});

const COMBAT_SKILL_TYPES = new Set([
    C4SkillRules.DAMAGE,
    C4SkillRules.DAMAGE_EFFECT,
    C4SkillRules.DEATH_LINK,
    C4SkillRules.DRAIN,
    C4SkillRules.BLOW,
    C4SkillRules.EFFECT,
    C4SkillRules.AGGRO_DAMAGE
]);

function instantiate(row) {
    const template = skillTemplates.get(row.skillId);
    if (!template) {
        return null;
    }

    const levels = template.levels || [];
    const level = levels.find((entry) => Number(entry.level) === row.level)
        || levels[Math.max(0, Math.min(levels.length - 1, row.level - 1))];

    if (!level) {
        return null;
    }

    return new SkillModel({
        ...utils.crushOb(template),
        ...level
    });
}

function forNpc(npc) {
    return (skillsByNpc.get(Number(npc.fetchSelfId?.())) || [])
        .map(instantiate)
        .filter(Boolean);
}

function combatSkillsFor(npc) {
    return forNpc(npc).filter((skill) => {
        if (skill.fetchPassive?.()) return false;
        if (skill.fetchSemantic?.().notUsedInC4) return false;
        if (!COMBAT_SKILL_TYPES.has(skill.fetchSkillType?.())) return false;
        if (!['enemy', 'self'].includes(skill.fetchTargetKind?.())) return false;
        if (skill.fetchTargetKind?.() === 'enemy' && Number(skill.fetchDistance?.()) < 0) return false;
        return true;
    });
}

module.exports = {
    forNpc,
    combatSkillsFor
};
