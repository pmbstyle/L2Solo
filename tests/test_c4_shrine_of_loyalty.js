require('../src/Global');

const assertC4MonsterLocation = require('./helpers/assert_c4_monster_location');

const mobIds = [1646, 1647, 1648, 1649, 1650, 1651];

assertC4MonsterLocation({
    slug: 'c4_shrine_of_loyalty',
    displayName: 'Shrine of Loyalty',
    mobIds,
    importedNpcIds: mobIds,
    bindingSlugs: ['c4_shrine_of_loyalty'],
    origin: [190000, -64000, -2800],
    sample: {
        id: 1646, name: 'Grave Scarab', level: 73, hostile: false,
        pAtk: 1463, pDef: 502, mAtk: 885, mDef: 407, hp: 4086,
        exp: 10206, sp: 1050, clan: '', race: 'insect'
    },
    sourceDropRows: 91,
    importedItems: {},
    importedSkillRows: 30,
    sourceSkillRows: 30,
    combatSkills: {
        1646: [], 1647: [4001, 4002, 4035], 1648: [4067],
        1649: [4232, 4067], 1650: [4630, 4160, 4571, 4635, 4035], 1651: [4033]
    }
});

