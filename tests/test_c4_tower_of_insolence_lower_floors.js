require('../src/Global');
const assertC4MonsterLocation = require('./helpers/assert_c4_monster_location');

const mobIds = [809,810,811,814];
assertC4MonsterLocation({
    slug: 'c4_tower_of_insolence_lower_floors', displayName: "Tower of Insolence lower floors", areaId: 'c4-tower-of-insolence-lower-floors',
    mobIds, importedNpcIds: mobIds, bindingSlugs: ['c4_tower_of_insolence_lower_floors'],
    spawnCounts: [[809,12],[810,28],[811,12],[814,12]],
    respawn: 148,
    region: [23,18], maxHeightDelta: 3712, origin: [113879,14008,-5096],
    sample: {id: 810,name: "Seer of Hallate",level: 60,hostile: true,pAtk: 946,pDef: 335,mAtk: 478,mDef: 299,hp: 3054,exp: 4045,sp: 351,clan: "hallate_clan",race: "construct"},
    sourceDropRows: 72, importedItems: {},
    importedSkillRows: 30, sourceSkillRows: 30,
    combatSkills: {"809":[4158,4160,4098],"810":[4046,4098,4088,4002],"811":[4072,4092,4032],"814":[4033,4032]}
});
