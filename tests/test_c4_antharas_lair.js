require('../src/Global');
const assertC4MonsterLocation = require('./helpers/assert_c4_monster_location');

const mobIds = [1084,1085,1086,1087,1088,1089,1090];
assertC4MonsterLocation({
    slug: 'c4_antharas_lair', displayName: "Antharas' Lair", areaId: 'c4-antharas-lair',
    mobIds, importedNpcIds: mobIds, bindingSlugs: ['c4_antharas_lair'],
    spawnCounts: [[1084,19],[1085,20],[1086,28],[1087,50],[1088,21],[1089,51],[1090,30]],
    respawn: 300, respawnByMob: { 1084: 250, 1090: 400 },
    region: [24,21], maxHeightDelta: 3930, origin: [135571,114137,-3720],
    sample: {id: 1089,name: "Bloody Lord",level: 75,hostile: true,pAtk: 1720,pDef: 475,mAtk: 957,mDef: 425,hp: 4229,exp: 6817,sp: 719,clan: "bloody_clan",race: "demonic"},
    sourceDropRows: 121, importedItems: {},
    importedSkillRows: 53, sourceSkillRows: 53,
    combatSkills: {"1084":[4039,4035],"1085":[],"1086":[4157,4160],"1087":[4033,4092,4073],"1088":[4257,4160],"1089":[4072,4090,4032],"1090":[4152,4160,4117]}
});
