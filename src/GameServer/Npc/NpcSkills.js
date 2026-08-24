const SkillModel = invoke('GameServer/Model/Skill');
const C4SkillRules = invoke('GameServer/Skills/C4SkillRules');

const activeSkills = require('../../../data/Skills/Active/active.json');
const passiveSkills = require('../../../data/Skills/Passive/passive.json');
const npcActiveSkills = require('../../../data/Npcs/Skills/active.json');
const c4SwampSkills = require('../../../data/Npcs/Skills/c4_swamp_of_screams_templates.json');
const c4GardenSkills = require('../../../data/Npcs/Skills/c4_garden_of_beasts_templates.json');
const c4ValleySkills = require('../../../data/Npcs/Skills/c4_valley_of_saints_templates.json');
const c4ForestSkills = require('../../../data/Npcs/Skills/c4_forest_of_the_dead_templates.json');
const c4DevilsIsleSkills = require('../../../data/Npcs/Skills/c4_devils_isle_templates.json');
const c4NecropolisSacrificeSkills = require('../../../data/Npcs/Skills/c4_necropolis_of_sacrifice_templates.json');
const c4DevastatedCastleSkills = require('../../../data/Npcs/Skills/c4_devastated_castle_templates.json');
const c4KetraOrcOutpostSkills = require('../../../data/Npcs/Skills/c4_ketra_orc_outpost_templates.json');
const c4VarkaSilenosStrongholdSkills = require('../../../data/Npcs/Skills/c4_varka_silenos_stronghold_templates.json');
const c4HotSpringsSkills = require('../../../data/Npcs/Skills/c4_hot_springs_templates.json');
const c4WallOfArgosSkills = require('../../../data/Npcs/Skills/c4_wall_of_argos_templates.json');
const c4ForgeOfTheGodsSkills = require('../../../data/Npcs/Skills/c4_forge_of_the_gods_templates.json');
const c4FieldsSkills = require('../../../data/Npcs/Skills/c4_fields_of_silence_and_whispers_templates.json');
const c4HeathenCampSkills = require('../../../data/Npcs/Skills/c4_heathen_camp_templates.json');
const c4ImperialTombSkills = require('../../../data/Npcs/Skills/c4_imperial_tomb_templates.json');
const c4LowLevelRaidBossSkills = require('../../../data/Npcs/Skills/c4_low_level_raid_bosses_templates.json');
const c4RaidBossSkills = require('../../../data/Npcs/Skills/c4_raid_bosses_templates.json');
const c4RaidBossMinionSkills = require('../../../data/Npcs/Skills/c4_raid_boss_minions_templates.json');
const c4LegacyMonsterSkillTemplates = require('../../../data/Npcs/Skills/c4_legacy_monster_templates.json');
const c4LegacyMonsterSkillRows = require('../../../data/Npcs/Skills/c4_legacy_monsters.json');
const c4LegacyMonsterIds = new Set(c4LegacyMonsterSkillRows.map((row) => Number(row.npcId)));
const npcSkillRows = [
    ...require('../../../data/Npcs/Skills/skills.json').filter((row) => !c4LegacyMonsterIds.has(Number(row.npcId))),
    ...c4LegacyMonsterSkillRows,
    ...require('../../../data/Npcs/Skills/c4_swamp_of_screams.json'),
    ...require('../../../data/Npcs/Skills/c4_garden_of_beasts.json'),
    ...require('../../../data/Npcs/Skills/c4_valley_of_saints.json'),
    ...require('../../../data/Npcs/Skills/c4_forest_of_the_dead.json'),
    ...require('../../../data/Npcs/Skills/c4_devils_isle.json'),
    ...require('../../../data/Npcs/Skills/c4_elmore_northeast_coast.json'),
    ...require('../../../data/Npcs/Skills/c4_devastated_castle.json'),
    ...require('../../../data/Npcs/Skills/c4_ketra_orc_outpost.json'),
    ...require('../../../data/Npcs/Skills/c4_varka_silenos_stronghold.json'),
    ...require('../../../data/Npcs/Skills/c4_hot_springs.json'),
    ...require('../../../data/Npcs/Skills/c4_wall_of_argos.json'),
    ...require('../../../data/Npcs/Skills/c4_shrine_of_loyalty.json'),
    ...require('../../../data/Npcs/Skills/c4_forge_of_the_gods.json'),
    ...require('../../../data/Npcs/Skills/c4_fields_of_silence_and_whispers.json'),
    ...require('../../../data/Npcs/Skills/c4_alligator_island.json'),
    ...require('../../../data/Npcs/Skills/c4_heathen_camp.json'),
    ...require('../../../data/Npcs/Skills/c4_imperial_tomb.json'),
    ...require('../../../data/Npcs/Skills/c4_tower_of_insolence.json'),
    ...require('../../../data/Npcs/Skills/c4_necropolis_of_sacrifice.json'),
    ...require('../../../data/Npcs/Skills/c4_catacomb_of_the_branded.json'),
    ...require('../../../data/Npcs/Skills/c4_catacomb_of_the_witch.json'),
    ...require('../../../data/Npcs/Skills/c4_necropolis_of_the_disciples.json'),
    ...require('../../../data/Npcs/Skills/c4_necropolis_of_saints.json'),
    ...require('../../../data/Npcs/Skills/c4_necropolis_of_patriots.json'),
    ...require('../../../data/Npcs/Skills/c4_necropolis_of_ascetics.json'),
    ...require('../../../data/Npcs/Skills/c4_necropolis_of_pilgrims.json'),
    ...require('../../../data/Npcs/Skills/c4_necropolis_of_worshipers.json'),
    ...require('../../../data/Npcs/Skills/c4_necropolis_of_martyrs.json'),
    ...require('../../../data/Npcs/Skills/c4_catacomb_of_dark_omen.json'),
    ...require('../../../data/Npcs/Skills/c4_catacomb_of_the_apostate.json'),
    ...require('../../../data/Npcs/Skills/c4_catacomb_of_the_heretics.json'),
    ...require('../../../data/Npcs/Skills/c4_catacomb_of_the_forbidden_path.json'),
    ...require('../../../data/Npcs/Skills/c4_low_level_raid_bosses.json'),
    ...require('../../../data/Npcs/Skills/c4_raid_bosses.json'),
    ...require('../../../data/Npcs/Skills/c4_raid_boss_minions.json')
];

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
    [...activeSkills, ...passiveSkills, ...npcActiveSkills, ...c4LegacyMonsterSkillTemplates, ...c4SwampSkills, ...c4GardenSkills, ...c4ValleySkills, ...summonActionSkills, ...c4ForestSkills, ...c4DevilsIsleSkills, ...c4NecropolisSacrificeSkills, ...c4DevastatedCastleSkills, ...c4KetraOrcOutpostSkills, ...c4VarkaSilenosStrongholdSkills, ...c4HotSpringsSkills, ...c4WallOfArgosSkills, ...c4ForgeOfTheGodsSkills, ...c4FieldsSkills, ...c4HeathenCampSkills, ...c4ImperialTombSkills, ...c4LowLevelRaidBossSkills, ...c4RaidBossSkills, ...c4RaidBossMinionSkills]
        .map((skill) => [Number(skill.selfId), skill])
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
    C4SkillRules.FATAL,
    C4SkillRules.DRAIN,
    C4SkillRules.BLOW,
    C4SkillRules.EFFECT,
    C4SkillRules.AGGRO_DAMAGE,
    C4SkillRules.GET_PLAYER
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
        if (
            skill.fetchTargetKind?.() === 'enemy' &&
            Number(skill.fetchDistance?.()) < 0 &&
            skill.fetchSemantic?.().sourceTarget !== 'aura'
        ) return false;
        return true;
    });
}

function passiveSkillsFor(npc) {
    return forNpc(npc).filter((skill) => skill.fetchPassive?.() === true);
}

module.exports = {
    forNpc,
    combatSkillsFor,
    passiveSkillsFor
};
