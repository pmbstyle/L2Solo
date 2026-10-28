require('../src/Global');
const assertC4MonsterLocation = require('./helpers/assert_c4_monster_location');

const mobIds = [947,950,953];
assertC4MonsterLocation({
    slug: 'c4_skyshadow_meadow', displayName: "Skyshadow Meadow",
    mobIds, importedNpcIds: mobIds, bindingSlugs: ['c4_skyshadow_meadow'],
    origin: [78772,63174,-3640],
    sample: {id: 947,name: "Connabi",level: 54,hostile: false,pAtk: 636,pDef: 313,mAtk: 339,mDef: 254,hp: 2562,exp: 7437,sp: 592,clan: "green_clan",race: "humanoid"},
    sourceDropRows: 41, importedItems: {},
    importedSkillRows: 12, sourceSkillRows: 12,
    combatSkills: {"947":[4032],"950":[4073],"953":[4073]}
});
