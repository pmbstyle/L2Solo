require('../src/Global');

const assertC4MonsterLocation = require('./helpers/assert_c4_monster_location');

const mobIds = [
    783, 784, 785, 786, 787, 788, 789, 790, 793,
    804, 805, 806, 807, 808, 989, 991, 1034,
    1638, 1639, 1640, 1641, 1642, 1643, 1644, 1645
];


assertC4MonsterLocation({
    slug: 'c4_fields_of_silence_and_whispers',
    displayName: 'Fields of Silence and Whispers',
    mobIds,
    importedNpcIds: mobIds,
    bindingSlugs: ['c4_fields_of_silence_and_whispers'],
    origin: [88539, 179050, -3765],
    sample: {
        id: 804, name: 'Crokian Lad', level: 41, hostile: true,
        pAtk: 291, pDef: 208, mAtk: 141, mDef: 169, hp: 1593,
        exp: 2574, sp: 168, clan: 'croc_clan2', race: 'beast'
    },
    sourceDropRows: 409,
    importedItems: { 6667: 'Deluxe Chest Key - Grade 3' },
    importedSkillRows: 103,
    sourceSkillRows: 103,
    combatSkills: {
        783: [], 784: [], 785: [4034], 786: [4034], 787: [4036],
        788: [4032], 789: [4030], 790: [4228], 793: [4099],
        804: [4074], 805: [4228], 806: [4030],
        807: [4153, 4160], 808: [], 989: [4067], 991: [4073],
        1034: [4032], 1638: [4032], 1639: [4124],
        1640: [4153, 4160], 1641: [4092, 4032], 1642: [4124],
        1643: [4124, 4244], 1644: [4565], 1645: [4157, 4560, 4076]
    }
});

