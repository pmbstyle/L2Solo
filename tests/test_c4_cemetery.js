require('../src/Global');
const assertC4MonsterLocation = require('./helpers/assert_c4_monster_location');

const mobIds = [996,997,998,999,1000];
assertC4MonsterLocation({
    slug: 'c4_cemetery', displayName: "Cemetery", areaId: 'c4-cemetery',
    mobIds, importedNpcIds: mobIds, bindingSlugs: ['c4_cemetery'],
    spawnCounts: [[996,20],[997,34],[998,14],[999,20],[1000,34]],
    respawn: 30,
    region: [25,18], maxHeightDelta: 256, origin: [169400,7148,-2728],
    sample: {id: 1000,name: "Soul of Ruins",level: 54,hostile: true,pAtk: 578,pDef: 344,mAtk: 339,mDef: 254,hp: 2562,exp: 4325,sp: 345,clan: "undead_clan",race: "undead"},
    sourceDropRows: 88, importedItems: {"5270":"Recipe: Greater Soulshot (B) Compressed Package(100%)"},
    importedSkillRows: 27, sourceSkillRows: 27,
    combatSkills: {"996":[4034,4254],"997":[4034,4001],"998":[4036],"999":[4032],"1000":[4002]}
});
