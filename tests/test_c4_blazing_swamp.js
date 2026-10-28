require('../src/Global');
const assertC4MonsterLocation = require('./helpers/assert_c4_monster_location');

const mobIds = [1108,1109,1110,1111,1112,1113,1114,1115,1116];
assertC4MonsterLocation({
    slug: 'c4_blazing_swamp', displayName: "Blazing Swamp",
    mobIds, importedNpcIds: mobIds, bindingSlugs: ['c4_blazing_swamp'],
    origin: [138152,-11656,-4560],
    sample: {id: 1112,name: "Hames Orc Footman",level: 71,hostile: false,pAtk: 1363,pDef: 481,mAtk: 814,mDef: 390,hp: 3938,exp: 8724,sp: 875,clan: "orc_clan",race: "humanoid"},
    sourceDropRows: 153, importedItems: {},
    importedSkillRows: 31, sourceSkillRows: 31,
    combatSkills: {"1108":[4100,4039,4076],"1109":[4067],"1110":[4152,4160],"1111":[4158,4160],"1112":[4032],"1113":[4040],"1114":[4033],"1115":[4087,4037,4047],"1116":[4033,4032]}
});
