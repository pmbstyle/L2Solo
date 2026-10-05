require('../src/Global');
const assertC4MonsterLocation = require('./helpers/assert_c4_monster_location');

const mobIds = [947,950,953];
assertC4MonsterLocation({
    slug: 'c4_skyshadow_meadow', displayName: "Skyshadow Meadow", areaId: 'c4-skyshadow-meadow',
    mobIds, importedNpcIds: mobIds, bindingSlugs: ['c4_skyshadow_meadow'],
    spawnCounts: [[947,72],[950,16],[953,39]],
    respawn: 33,
    regions: [[22,19],[22,20]], maxHeightDelta: 600, origin: [78772,63174,-3640],
    sample: {id: 947,name: "Connabi",level: 54,hostile: false,pAtk: 636,pDef: 313,mAtk: 339,mDef: 254,hp: 2562,exp: 7437,sp: 592,clan: "green_clan",race: "humanoid"},
    sourceDropRows: 41, importedItems: {},
    importedSkillRows: 12, sourceSkillRows: 12,
    combatSkills: {"947":[4032],"950":[4073],"953":[4073]}
});
