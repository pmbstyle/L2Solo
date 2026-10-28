require('../src/Global');
const assertC4MonsterLocation = require('./helpers/assert_c4_monster_location');

const mobIds = [1443,1444,1445,1446,1447,1448,1449,1450];
assertC4MonsterLocation({
    unspawned: [1443, 1444, 1446, 1447, 1448], // grown by feeding, never placed
    slug: 'c4_beast_farm', displayName: "Beast Farm",
    mobIds, importedNpcIds: mobIds, bindingSlugs: ['c4_beast_farm'],
    origin: [52152,-80134,-2928],
    sample: {id: 1449,name: "Raider of Pastureland",level: 68,hostile: true,pAtk: 800,pDef: 598,mAtk: 713,mDef: 365,hp: 3706,exp: 8440,sp: 815,clan: "nonpet_clan",race: "humanoid"},
    sourceDropRows: 119, importedItems: {},
    importedSkillRows: 17, sourceSkillRows: 17,
    combatSkills: {"1443":[4032],"1444":[],"1445":[],"1446":[4073],"1447":[4067],"1448":[],"1449":[4232],"1450":[4072]}
});
