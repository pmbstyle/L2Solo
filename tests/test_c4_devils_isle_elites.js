require('../src/Global');
const assertC4MonsterLocation = require('./helpers/assert_c4_monster_location');

const mobIds = [1625,1628,1631,1634,1637];
assertC4MonsterLocation({
    slug: 'c4_devils_isle_elites', displayName: "Devil's Isle elites", areaId: 'c4-devils-isle-elites',
    mobIds, importedNpcIds: mobIds, bindingSlugs: ['c4_devils_isle_elites'],
    spawnCounts: [[1625,32],[1628,27],[1631,32],[1634,32],[1637,23]],
    respawn: 180,
    region: [21,24], maxHeightDelta: 4736, origin: [47856,219693,-3584],
    sample: {id: 1625,name: "Zaken's Elite Guard",level: 50,hostile: true,pAtk: 445,pDef: 278,mAtk: 264,mDef: 226,hp: 2245,exp: 2858,sp: 215,clan: "undead_clan",race: "undead"},
    sourceDropRows: 85, importedItems: {},
    importedSkillRows: 40, sourceSkillRows: 40,
    combatSkills: {"1625":[4067],"1628":[4047],"1631":[4067],"1634":[4074],"1637":[4076,4046,4087]}
});
