require('../src/Global');
const assertC4MonsterLocation = require('./helpers/assert_c4_monster_location');

const mobIds = [974,1001,1002,1003,1007,1008,1009,1010];
assertC4MonsterLocation({
    slug: 'c4_devastated_castle_outskirts', displayName: "Devastated Castle outskirts", areaId: 'c4-devastated-castle-outskirts',
    mobIds, importedNpcIds: mobIds, bindingSlugs: ['c4_devastated_castle_outskirts'],
    spawnCounts: [[974,13],[1001,31],[1002,22],[1003,38],[1007,28],[1008,15],[1009,71],[1010,43]],
    respawn: 75, respawnByMob: { 974: 110 },
    regions: [[24,17],[25,17]], maxHeightDelta: 896, origin: [178231,-25856,-2624],
    sample: {id: 1009,name: "Doom Trooper",level: 63,hostile: false,pAtk: 1267,pDef: 362,mAtk: 560,mDef: 323,hp: 3302,exp: 7966,sp: 719,clan: "doom_clan",race: "undead"},
    sourceDropRows: 128, importedItems: {"5165":"Recipe: Blessed Spiritshot (B) Compressed Package (100%)"},
    importedSkillRows: 44, sourceSkillRows: 44,
    combatSkills: {"974":[4073],"1001":[4120],"1002":[4074],"1003":[4035,4046,4002],"1007":[4036],"1008":[4120],"1009":[4072,4244],"1010":[4030]}
});
