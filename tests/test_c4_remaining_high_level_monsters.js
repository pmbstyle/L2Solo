require('../src/Global');
const assertC4MonsterLocation = require('./helpers/assert_c4_monster_location');

const mobIds = [803,941,994,1261,1797];
assertC4MonsterLocation({
    slug: 'c4_remaining_high_level_monsters', displayName: "remaining high-level monsters", areaId: 'c4-remaining-high-level-monsters',
    mobIds, importedNpcIds: mobIds, bindingSlugs: ['c4_remaining_high_level_monsters'],
    spawnCounts: [[803,23],[941,22],[994,15],[1261,22],[1797,20]],
    respawn: 94, respawnByMob: { 941: 45, 994: 110, 1261: 41, 1797: 80 },
    regions: [[21,22],[22,17],[22,22],[22,25],[23,17],[23,19]], maxHeightDelta: 6841, origin: [80395,252483,-10872],
    sample: {id: 941,name: "Tanor Silenos Chieftain",level: 50,hostile: true,pAtk: 509,pDef: 278,mAtk: 264,mDef: 226,hp: 2245,exp: 6503,sp: 490,clan: "silenos_clan",race: "humanoid"},
    sourceDropRows: 71, importedItems: {},
    importedSkillRows: 31, sourceSkillRows: 31,
    combatSkills: {"803":[4074],"941":[4032],"994":[4073],"1261":[4032],"1797":[]}
});
