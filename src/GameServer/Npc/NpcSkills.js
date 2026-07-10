const SkillModel = invoke('GameServer/Model/Skill');
const C4SkillRules = invoke('GameServer/Skills/C4SkillRules');

const activeSkills = require('../../../data/Skills/Active/active.json');
const npcActiveSkills = require('../../../data/Npcs/Skills/active.json');
const npcSkillRows = require('../../../data/Npcs/Skills/skills.json');

// These action skills belong to temporary servitors, but their NPC templates
// are generated from class summon skills rather than ordinary spawn rows.
// Keep their sourced level-one definitions here until the NPC-skill datapack
// importer covers all generated servitor templates.
const summonActionSkills = [
    { selfId: 4137, template: { name: 'Hydro Screw', passive: false, spell: true, distance: 500 }, time: { hitTime: 4000, reuse: 8000, buff: 0 }, levels: [{ level: 1, power: 9, mp: 18, hp: 0, itemId: 0, itemCount: 0 }] },
    { selfId: 4138, template: { name: 'NPC AE - Corpse Burst', passive: false, spell: true, distance: 900 }, time: { hitTime: 4000, reuse: 8000, buff: 0 }, levels: [{ level: 1, power: 9, mp: 18, hp: 0, itemId: 0, itemCount: 0 }] },
    { selfId: 4139, template: { name: 'Boom Attack', passive: false, spell: true, distance: -1 }, time: { hitTime: 6000, reuse: 8000, buff: 0 }, levels: [{ level: 1, power: 52, mp: 0, hp: 0, itemId: 0, itemCount: 0 }] },
    { selfId: 4230, template: { name: 'Wild Cannon', passive: false, spell: false, distance: 2500 }, time: { hitTime: 10000, reuse: 10500, buff: 0 }, levels: [{ level: 1, power: 532048, mp: 0, hp: 0, itemId: 0, itemCount: 0 }] },
    { selfId: 4259, template: { name: 'Toxic Smoke', passive: false, spell: true, distance: 500 }, time: { hitTime: 2000, reuse: 8000, buff: 30000 }, levels: [{ level: 1, power: 2, mp: 18, hp: 0, itemId: 0, itemCount: 0 }] },
    { selfId: 4378, template: { name: 'Self Damage Shield', passive: false, spell: false, distance: -1 }, time: { hitTime: 1800, reuse: 60000, buff: 60000 }, levels: [{ level: 1, power: 0, mp: 12, hp: 0, itemId: 0, itemCount: 0 }] }
];

const summonActionSkillIds = new Map([
    [299, [4230]],
    [301, [4139]],
    [1276, [4378]],
    [1277, [4137]],
    [1278, [4138, 4259]]
]);

const skillTemplates = new Map(
    [...activeSkills, ...npcActiveSkills, ...summonActionSkills].map((skill) => [Number(skill.selfId), skill])
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
    const rows = [...(skillsByNpc.get(Number(npc.fetchSelfId?.())) || [])];
    const actionSkillIds = summonActionSkillIds.get(Number(npc.fetchSummonSkillId?.())) || [];
    actionSkillIds.forEach((skillId) => {
        if (!rows.some((row) => row.skillId === skillId)) {
            rows.push({ skillId, level: 1 });
        }
    });

    return rows
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
