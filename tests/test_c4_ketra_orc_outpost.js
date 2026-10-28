require('../src/Global');

const assertC4MonsterLocation = require('./helpers/assert_c4_monster_location');

const mobIds = [
    1324, 1325, 1326, 1327, 1328, 1329, 1330, 1331, 1332, 1333, 1334,
    1335, 1336, 1337, 1338, 1339, 1340, 1341, 1342, 1343, 1345, 1347
];

assertC4MonsterLocation({
    slug: 'c4_ketra_orc_outpost',
    displayName: 'Ketra Orc Outpost',
    mobIds,
    importedNpcIds: mobIds,
    bindingSlugs: ['c4_ketra_orc_outpost'],
    origin: [140000, -80000, -4000],
    sample: {
        id: 1324, name: 'Ketra Orc Footman', level: 77, hostile: true,
        pAtk: 1664, pDef: 544, mAtk: 1031, mDef: 442, hp: 4364,
        exp: 9323, sp: 1009, clan: 'ketra_orc_clan', race: 'humanoid'
    },
    sourceDropRows: 312,
    importedItems: {
        5167: 'Recipe: Blessed Spiritshot (S) Compressed Package (100%)',
        5533: 'Elysian Head',
        5545: "Dark Legion's Edge Blade",
        6672: 'Deluxe Chest Key - Grade 8',
        6689: 'Basalt Battlehammer Head',
        6693: 'Dragon Hunter Axe Blade',
        7668: 'Spellbook - Block Shield',
        7669: 'Spellbook - Block Wind Walk',
        7670: 'Spellbook - Mass Block Shield',
        7671: 'Spellbook - Mass Block Wind Walk'
    },
    importedSkillRows: 162,
    sourceSkillRows: 162,
    combatSkills: {
        1324: [4099, 4072], 1325: [4032], 1326: [4073],
        1327: [4317, 4072, 4038], 1328: [4040],
        1329: [4157, 4561, 4030, 4031, 4035], 1330: [4073],
        1331: [4078, 4119], 1332: [4317, 4072, 4038], 1333: [4067],
        1334: [4158, 4561, 4571, 4035], 1335: [4099, 4571],
        1336: [4317, 4072, 4038], 1337: [4032],
        1338: [4158, 4561, 4030, 4035], 1339: [4317, 4571, 4038],
        1340: [4317, 4571, 4038], 1341: [],
        1342: [4158, 4561, 4571, 4031, 4035], 1343: [4038],
        1345: [4100], 1347: [4158, 4561, 4030, 4035]
    }
});
