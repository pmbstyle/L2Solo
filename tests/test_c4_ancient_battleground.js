require('../src/Global');
const assertC4MonsterLocation = require('./helpers/assert_c4_monster_location');

const mobIds = [956,959,963];
assertC4MonsterLocation({
    slug: 'c4_ancient_battleground', displayName: "Ancient Battleground", areaId: 'c4-ancient-battleground',
    mobIds, importedNpcIds: mobIds, bindingSlugs: ['c4_ancient_battleground'],
    spawnCounts: [[956,41],[959,11],[963,22]],
    respawn: 37,
    regions: [[23,17],[23,18]], maxHeightDelta: 872, origin: [109591,-2053,-3448],
    sample: {id: 956,name: "Past Knight",level: 64,hostile: true,pAtk: 1031,pDef: 408,mAtk: 589,mDef: 331,hp: 3384,exp: 11588,sp: 1060,clan: "bloody_clan",race: "undead"},
    sourceDropRows: 49, importedItems: {},
    importedSkillRows: 19, sourceSkillRows: 19,
    combatSkills: {"956":[4032],"959":[4073],"963":[4100]}
});
