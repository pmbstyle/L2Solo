require('../src/Global');
const assertC4MonsterLocation = require('./helpers/assert_c4_monster_location');

const mobIds = [966,969,973,1058];
assertC4MonsterLocation({
    slug: 'c4_fields_of_massacre', displayName: "Fields of Massacre", areaId: 'c4-fields-of-massacre',
    mobIds, importedNpcIds: mobIds, bindingSlugs: ['c4_fields_of_massacre'],
    spawnCounts: [[966,14],[969,12],[973,14],[1058,10]],
    respawn: 37, respawnByMob: { 1058: 150 },
    region: [25,19], maxHeightDelta: 24, origin: [173709,58040,-5904],
    sample: {id: 973,name: "Forgotten Ancient People",level: 77,hostile: true,pAtk: 1664,pDef: 463,mAtk: 1031,mDef: 442,hp: 4364,exp: 16958,sp: 1836,clan: "giant_clan",race: "giant"},
    sourceDropRows: 64, importedItems: {"7656":"Spellbook - Warrior Servitor","7657":"Spellbook - Wizard Servitor","7658":"Spellbook - Assassin Servitor","7659":"Spellbook - Final Servitor"},
    importedSkillRows: 20, sourceSkillRows: 20,
    combatSkills: {"966":[4072],"969":[4105],"973":[4033],"1058":[4072]}
});
