const assert = require('assert');

require('../src/Global');

const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');
const assertC4MonsterLocation = require('./helpers/assert_c4_monster_location');
const assertMonsterEmptyBeforeSlice = require('./helpers/assert_monster_empty_before_slice');
const verifyGeodataWhenAvailable = require('./helpers/verify_geodata_when_available');
const spawnAreas = require('../data/Npcs/Spawns/c4_ketra_orc_outpost.json');

const mobIds = [
    1324, 1325, 1326, 1327, 1328, 1329, 1330, 1331, 1332, 1333, 1334,
    1335, 1336, 1337, 1338, 1339, 1340, 1341, 1342, 1343, 1345, 1347
];

assertC4MonsterLocation({
    slug: 'c4_ketra_orc_outpost',
    displayName: 'Ketra Orc Outpost',
    areaId: 'c4-ketra-orc-outpost',
    mobIds,
    importedNpcIds: mobIds,
    bindingSlugs: ['c4_ketra_orc_outpost'],
    spawnCounts: [
        [1324, 52], [1325, 51], [1326, 54], [1327, 34], [1328, 28], [1329, 34],
        [1330, 36], [1331, 36], [1332, 32], [1333, 36], [1334, 34], [1335, 42],
        [1336, 32], [1337, 40], [1338, 36], [1339, 42], [1340, 34], [1341, 44],
        [1342, 34], [1343, 10], [1345, 10], [1347, 10]
    ],
    respawn: 120,
    respawnByMob: { 1343: 100, 1345: 100, 1347: 100 },
    region: [24, 15],
    maxHeightDelta: 1340,
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

assertMonsterEmptyBeforeSlice({
    slug: 'c4_ketra_orc_outpost',
    displayName: 'Ketra Orc Outpost',
    box: { minX: 132272, maxX: 159607, minY: -95555, maxY: -68265, minZ: -5584, maxZ: -2832 }
});

verifyGeodataWhenAvailable(GeodataEngine, [[24, 15]], 'Ketra Orc Outpost', () => {
    const coords = spawnAreas[0].spawns.flatMap((spawn) => spawn.coords);
    const heightDeltas = coords.map((coord) => Math.abs(
        GeodataEngine.getHeight(coord.locX, coord.locY, coord.locZ) - coord.locZ
    ));
    assert.strictEqual(heightDeltas.filter((delta) => delta <= 32).length, 648,
        '648 authentic Ketra points must agree with current C4 geodata within 32 Z');
    assert.strictEqual(heightDeltas.filter((delta) => delta <= 128).length, 687,
        '687 authentic Ketra points must agree with current C4 geodata within 128 Z');
    assert.strictEqual(Math.max(...heightDeltas), 1340,
        'known multi-level Ketra source offsets must not drift beyond the audited maximum');
});
