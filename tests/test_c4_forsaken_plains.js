require('../src/Global');
const assertC4MonsterLocation = require('./helpers/assert_c4_monster_location');

const mobIds = [1017,1018,1019,1020,1021,1022,1258,5316];
assertC4MonsterLocation({
    unspawned: [1258], // Mobius has the template, no spawn
    slug: 'c4_forsaken_plains', displayName: "Forsaken Plains",
    mobIds, importedNpcIds: mobIds, bindingSlugs: ['c4_forsaken_plains'],
    origin: [166634,34096,-4044],
    sample: {id: 1017,name: "Fallen Orc",level: 55,hostile: false,pAtk: 737,pDef: 292,mAtk: 360,mDef: 261,hp: 2643,exp: 4399,sp: 355,clan: "orc_clan",race: "humanoid"},
    sourceDropRows: 88, importedItems: {"4915":"Blueprint: Summon Wild Hog Cannon","4921":"Blueprint: Summon Big Boom"},
    importedSkillRows: 23, sourceSkillRows: 23,
    combatSkills: {"1017":[],"1018":[4067],"1019":[4040],"1020":[4001,4066,4035],"1021":[4073],"1022":[4032],"1258":[],"5316":[]}
});
