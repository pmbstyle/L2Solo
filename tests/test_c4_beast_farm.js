require('../src/Global');
const assertC4MonsterLocation = require('./helpers/assert_c4_monster_location');
const assertMonsterEmptyBeforeSlice = require('./helpers/assert_monster_empty_before_slice');

const mobIds = [1443,1444,1445,1446,1447,1448,1449,1450];
assertC4MonsterLocation({
    slug: 'c4_beast_farm', displayName: "Beast Farm", areaId: 'c4-beast-farm',
    mobIds, importedNpcIds: mobIds, bindingSlugs: ['c4_beast_farm'],
    spawnCounts: [[1443,4],[1444,6],[1445,7],[1446,3],[1447,5],[1448,2],[1449,19],[1450,13]],
    respawn: 60,
    region: [21,15], maxHeightDelta: 464, origin: [52152,-80134,-2928],
    sample: {id: 1449,name: "Raider of Pastureland",level: 68,hostile: true,pAtk: 800,pDef: 598,mAtk: 713,mDef: 365,hp: 3706,exp: 8440,sp: 815,clan: "nonpet_clan",race: "humanoid"},
    sourceDropRows: 119, importedItems: {},
    importedSkillRows: 17, sourceSkillRows: 17,
    combatSkills: {"1443":[4032],"1444":[],"1445":[],"1446":[4073],"1447":[4067],"1448":[],"1449":[4232],"1450":[4072]}
});
assertMonsterEmptyBeforeSlice({ slug: 'c4_beast_farm', displayName: "Beast Farm", box: {minX: 44207,maxX: 59527,minY: -93259,maxY: -76508,minZ: -3584,maxZ: -872} });
