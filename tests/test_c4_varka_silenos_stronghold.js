const assert = require('assert');

require('../src/Global');

const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');
const assertC4MonsterLocation = require('./helpers/assert_c4_monster_location');
const assertMonsterEmptyBeforeSlice = require('./helpers/assert_monster_empty_before_slice');
const verifyGeodataWhenAvailable = require('./helpers/verify_geodata_when_available');
const spawnAreas = require('../data/Npcs/Spawns/c4_varka_silenos_stronghold.json');

const mobIds = [
    1350, 1351, 1352, 1353, 1354, 1355, 1356, 1357, 1358, 1359, 1360,
    1361, 1362, 1363, 1364, 1365, 1366, 1367, 1368, 1369, 1371, 1373
];

assertC4MonsterLocation({
    slug: 'c4_varka_silenos_stronghold',
    displayName: 'Varka Silenos Stronghold',
    areaId: 'c4-varka-silenos-stronghold',
    mobIds,
    importedNpcIds: mobIds,
    bindingSlugs: ['c4_varka_silenos_stronghold'],
    spawnCounts: [
        [1350, 42], [1351, 40], [1352, 42], [1353, 24], [1354, 26], [1355, 20],
        [1356, 26], [1357, 26], [1358, 32], [1359, 28], [1360, 28], [1361, 20],
        [1362, 16], [1363, 22], [1364, 16], [1365, 34], [1366, 24], [1367, 36],
        [1368, 32], [1369, 10], [1371, 10], [1373, 10]
    ],
    respawn: 109,
    respawnByMob: { 1369: 103, 1371: 103, 1373: 103 },
    regions: [[23, 16], [24, 16]],
    maxHeightDelta: 1248,
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

const coords = spawnAreas[0].spawns.flatMap((spawn) => spawn.coords.map((coord) => ({
    npcId: spawn.selfId,
    ...coord
})));
const nearestTeleportDistance = Math.min(...coords.map((coord) =>
    Math.hypot(coord.locX - 125543, coord.locY + 40953)));

assert.ok(nearestTeleportDistance < 600,
    'the Varka Silenos Stronghold teleport must have a source monster within 600 units');
assert.ok(coords.some((coord) => coord.npcId === 1351
    && coord.locX === 126113 && coord.locY === -41137 && coord.locZ === -3720),
    'the nearest Varka Silenos Footman source point must remain exact');

assertMonsterEmptyBeforeSlice({
    slug: 'c4_varka_silenos_stronghold',
    displayName: 'Varka Silenos Stronghold entrance',
    box: { minX: 123000, maxX: 129000, minY: -44000, maxY: -38000, minZ: -4024, maxZ: -1856 }
});

verifyGeodataWhenAvailable(GeodataEngine, [[23, 16], [24, 16]], 'Varka Silenos Stronghold', () => {
    const heightDeltas = coords.map((coord) => Math.abs(
        GeodataEngine.getHeight(coord.locX, coord.locY, coord.locZ) - coord.locZ
    ));
    assert.strictEqual(heightDeltas.filter((delta) => delta <= 32).length, 504,
        '504 authentic Varka points must agree with current C4 geodata within 32 Z');
    assert.strictEqual(heightDeltas.filter((delta) => delta <= 128).length, 529,
        '529 authentic Varka points must agree with current C4 geodata within 128 Z');
    assert.strictEqual(Math.max(...heightDeltas), 1248,
        'known multi-level Varka source offsets must not drift beyond the audited maximum');
});
