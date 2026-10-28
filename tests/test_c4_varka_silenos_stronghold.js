require('../src/Global');

const assertC4MonsterLocation = require('./helpers/assert_c4_monster_location');

const mobIds = [
    1350, 1351, 1352, 1353, 1354, 1355, 1356, 1357, 1358, 1359, 1360,
    1361, 1362, 1363, 1364, 1365, 1366, 1367, 1368, 1369, 1371, 1373
];

assertC4MonsterLocation({
    slug: 'c4_varka_silenos_stronghold',
    displayName: 'Varka Silenos Stronghold',
    mobIds,
    importedNpcIds: mobIds,
    bindingSlugs: ['c4_varka_silenos_stronghold'],
    origin: [125543, -40953, -3724],
    sample: {
        id: 1350, name: 'Varka Silenos Recruit', level: 77, hostile: true,
        pAtk: 1664, pDef: 544, mAtk: 1031, mDef: 442, hp: 4364,
        exp: 9851, sp: 1066, clan: 'varka_silenos_clan', race: 'humanoid'
    },
    sourceDropRows: 297,
    importedItems: {},
    importedSkillRows: 166,
    sourceSkillRows: 166,
    combatSkills: {
        1350: [4092, 4072, 4032], 1351: [], 1352: [4067],
        1353: [4317, 4072, 4038], 1354: [4040],
        1355: [4160, 4030, 4031, 4098], 1356: [4073],
        1357: [4560, 4119], 1358: [4317, 4072, 4038], 1359: [4032],
        1360: [4160, 4033, 4035], 1361: [4099, 4571],
        1362: [4317, 4072, 4038], 1363: [4032],
        1364: [4160, 4030, 4119], 1365: [4317, 4033, 4038],
        1366: [4317, 4072, 4077, 4038], 1367: [],
        1368: [4160, 4033, 4119], 1369: [4038], 1371: [],
        1373: [4160, 4030, 4119]
    }
});
