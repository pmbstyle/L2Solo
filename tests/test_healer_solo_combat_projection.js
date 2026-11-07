'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
require('../src/Global');
const Data = invoke('GameServer/DataCache');
const Matchup = invoke('GameServer/Bot/AI/BotTargetMatchup');
const ClassPolicy = invoke('GameServer/Bot/Population/ColdClassPolicy');
const Combat = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Skill = invoke('GameServer/Model/Skill');
Data.init();

function learned(selfId, level) {
    const source = Data.skills.find(skill => skill.selfId === selfId);
    const rank = source.levels.find(skill => skill.level === level);
    assert(rank, `skill ${selfId}/${level} must exist in the datapack`);
    return { selfId, ...source.template, ...source.time, ...rank };
}

// A real undergeared Bishop can afford both holy spells. The gate judges the
// spell the executor picks (its MP priced in rest time, T100), not the
// strongest one it knows.
const bishop = {
    classId: 16, role: 'healer', level: 68,
    pAtk: 207.8, mAtk: 468.9, pDef: 453.7, maxHp: 1496.14, maxMp: 2724.03,
    atkSpd: 383, castSpd: 387, weaponMask: 0,
    equipment: { weaponKind: 'Weapon.Etc' },
    skills: [learned(1028, 16), learned(1031, 8)]
};
const undead = Combat.npcCombatStats(Data.npcs.find(npc => npc.selfId === 998));
const selected = ClassPolicy.select(bishop, {
    hp: bishop.maxHp, mp: bishop.maxMp, cooldowns: {}, time: 0, mob: undead
});
assert(selected?.skill, 'the executor picks a holy spell against undead');
const profiles = Matchup.coldProfiles(bishop);
const actualSpell = Matchup.coldProfiles({ ...bishop, skills: [selected.skill] });
assert.equal(Matchup.soloSurvival(profiles, undead).survivalRatio,
    Matchup.soloSurvival(actualSpell, undead).survivalRatio,
    'the survival estimate must use the spell the executor selects');
const actor = {
    fetchClassId: () => bishop.classId, fetchLevel: () => bishop.level,
    fetchCollectivePAtk: () => bishop.pAtk, fetchCollectiveMAtk: () => bishop.mAtk,
    fetchCollectivePDef: () => bishop.pDef, fetchMaxHp: () => bishop.maxHp,
    fetchMaxMp: () => bishop.maxMp, fetchMp: () => bishop.maxMp,
    fetchCollectiveAtkSpd: () => bishop.atkSpd, fetchCollectiveCastSpd: () => bishop.castSpd,
    backpack: { fetchTotalWeaponKind: () => bishop.equipment.weaponKind },
    skillset: { skills: bishop.skills.map(record => new Skill(record)) }
};
assert.equal(Matchup.soloSurvival(Matchup.actorProfiles([actor]), undead).survivalRatio,
    Matchup.soloSurvival(profiles, undead).survivalRatio,
    'native target scans and cold routing must project the same healer rotation');

const strongOnly = Matchup.coldProfiles({ ...bishop, skills: [bishop.skills[0]] });
assert.equal(Matchup.soloCanHunt(strongOnly, undead).eligible, true,
    'a healer who actually selects Might of Heaven retains a safe undead route');
const easyUndead = { ...undead, maxHp: undead.maxHp / 4, pAtk: undead.pAtk / 4 };
assert.equal(Matchup.soloCanHunt(profiles, easyUndead).eligible, true,
    'the cheaper spell still allows easier earning fights');

const living = { ...easyUndead, undead: false };
const physical = Matchup.coldProfiles({ ...bishop, skills: [] });
assert.equal(ClassPolicy.select(bishop, {
    hp: bishop.maxHp, mp: bishop.maxMp, cooldowns: {}, time: 0, mob: living
}), null, 'holy-only healers fall back to a weapon against living targets');
assert.equal(Matchup.soloSurvival(profiles, living).survivalRatio,
    Matchup.soloSurvival(physical, living).survivalRatio,
    'an unavailable holy spell must preserve the healer weapon fallback');

console.log('Healer solo survival matches native spell selection and weapon fallback');
