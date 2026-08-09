const assert = require('assert');

require('../src/Global');

const C4SkillRules = invoke('GameServer/Skills/C4SkillRules');
const assertC4MonsterLocation = require('./helpers/assert_c4_monster_location');
const assertMonsterEmptyBeforeSlice = require('./helpers/assert_monster_empty_before_slice');

const mobIds = [1376, 1377, 1378, 1379, 1380, 1381, 1382, 1383, 1384, 1385, 1386, 1387, 1388, 1389, 1390, 1391, 1392, 1393, 1394, 1395, 1652, 1653, 1654, 1655, 1656, 1657];

assertC4MonsterLocation({
    slug: 'c4_forge_of_the_gods',
    displayName: 'Forge of the Gods',
    areaId: 'c4-forge-of-the-gods',
    mobIds,
    importedNpcIds: mobIds,
    bindingSlugs: ['c4_forge_of_the_gods'],
    spawnCounts: [
        [1376, 12], [1377, 12], [1378, 12], [1379, 18], [1380, 18], [1381, 16],
        [1382, 12], [1383, 10], [1384, 10], [1385, 16], [1386, 14], [1387, 14],
        [1388, 13], [1389, 9], [1390, 9], [1391, 22], [1392, 27], [1393, 26],
        [1394, 22], [1395, 33], [1652, 18], [1653, 22], [1654, 15], [1655, 21],
        [1656, 9], [1657, 13]
    ],
    respawn: 110,
    respawnByMob: { 1394: 90, 1395: 60 },
    region: [25, 14],
    maxHeightDelta: 6600,
    origin: [184000, -113000, -3500],
    sample: {
        id: 1376, name: 'Scarlet Stakato Walker', level: 78, hostile: true,
        pAtk: 1886, pDef: 505, mAtk: 1069, mDef: 451, hp: 4428,
        exp: 7054, sp: 772, clan: 'fire_clan', race: 'insect'
    },
    sourceDropRows: 379,
    importedItems: {},
    importedSkillRows: 202,
    sourceSkillRows: 202,
    combatSkills: {
        1376: [], 1377: [], 1378: [], 1379: [4117, 4037], 1380: [4119],
        1381: [4244], 1382: [4317, 4072, 4037], 1383: [],
        1384: [4153, 4072, 4031], 1385: [], 1386: [], 1387: [4157],
        1388: [], 1389: [], 1390: [4072, 4030], 1391: [4078],
        1392: [4229, 4605], 1393: [4605], 1394: [4607], 1395: [4607],
        1652: [], 1653: [], 1654: [], 1655: [], 1656: [], 1657: []
    },
    multipliers: [
        { npcId: 1385, stat: 'fireVuln', value: 0.7 },
        { npcId: 1385, stat: 'waterVuln', value: 1.15 },
        { npcId: 1388, stat: 'maxHpMul', value: 6 }
    ]
});

assertMonsterEmptyBeforeSlice({
    slug: 'c4_forge_of_the_gods',
    displayName: 'Forge of the Gods',
    box: { minX: 174668, maxX: 193733, minY: -121291, maxY: -105461, minZ: -6128, maxZ: -776 }
});

assert.deepStrictEqual(
    C4SkillRules.resolve({ selfId: 4601, level: 3, name: 'NPC Clan Buff - Acumen Focus' }).stats,
    { pCritRateMul: 1.3, castSpdMul: 1.3 }
);
const weakness = C4SkillRules.resolve({ selfId: 4605, level: 12, name: 'Fire Weakness', power: 2617, buff: 15000 });
assert.strictEqual(weakness.skillType, C4SkillRules.DAMAGE_EFFECT);
assert.strictEqual(weakness.stats.fireVuln, 1.3);
assert.strictEqual(C4SkillRules.resolve({ selfId: 4584, level: 8, name: 'Reducing P.Def Shock' }).skillType, C4SkillRules.NOT_DONE);

console.log('C4 Forge of the Gods skill semantics checks passed');
