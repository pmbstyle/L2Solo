const assertLocation = require('./helpers/assert_c4_monster_location');

assertLocation({
    slug: 'c4_catacomb_of_the_heretics',
    areaId: 'c4-catacomb-of-the-heretics',
    displayName: 'Catacomb of the Heretics',
    mobIds: [1143, 1144, 1145, 1146, 1169, 1170, 1171, 1172,
        1190, 1191, 1192, 1193, 1236, 1237, 1238, 1239],
    importedNpcIds: [1143, 1236, 1237, 1238, 1239],
    spawnCounts: [[1143, 15], [1144, 15], [1145, 16], [1146, 16],
        [1169, 15], [1170, 15], [1171, 15], [1172, 16],
        [1190, 15], [1191, 15], [1192, 15], [1193, 16],
        [1236, 15], [1237, 15], [1238, 15], [1239, 15]],
    respawn: 120,
    region: [21, 22],
    origin: [49000, 149000, -5376],
    sample: {
        id: 1236, name: 'Barrow Sentinel', level: 30, hostile: false,
        pAtk: 132, pDef: 140, mAtk: 58, mDef: 114, hp: 954,
        exp: 957, sp: 52, clan: 'c_dungeon_clan', race: 'undead'
    },
    sourceDropRows: 234,
    importedItems: {},
    bindingSlugs: ['c4_catacomb_of_the_heretics', 'c4_necropolis_of_pilgrims',
        'c4_necropolis_of_sacrifice'],
    importedSkillRows: 26,
    sourceSkillRows: 95,
    combatSkills: {
        1143: [4002], 1144: [4158, 4160, 4076], 1145: [4035], 1146: [4066],
        1169: [4067], 1170: [4001], 1171: [4029], 1172: [4067],
        1190: [4032], 1191: [4078], 1192: [4029], 1193: [4032],
        1236: [4317], 1237: [4099], 1238: [4032], 1239: [4002]
    }
});
