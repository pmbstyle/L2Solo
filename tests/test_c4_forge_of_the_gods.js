const assert = require('assert');

require('../src/Global');

const C4SkillRules = invoke('GameServer/Skills/C4SkillRules');
const assertC4MonsterLocation = require('./helpers/assert_c4_monster_location');

const mobIds = [1376, 1377, 1378, 1379, 1380, 1381, 1382, 1383, 1384, 1385, 1386, 1387, 1388, 1389, 1390, 1391, 1392, 1393, 1394, 1395, 1652, 1653, 1654, 1655, 1656, 1657];

assertC4MonsterLocation({
    slug: 'c4_forge_of_the_gods',
    displayName: 'Forge of the Gods',
    mobIds,
    importedNpcIds: mobIds,
    bindingSlugs: ['c4_forge_of_the_gods'],
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


assert.deepStrictEqual(
    C4SkillRules.resolve({ selfId: 4601, level: 3, name: 'NPC Clan Buff - Acumen Focus' }).stats,
    { pCritRateMul: 1.3, castSpdMul: 1.3 }
);
const weakness = C4SkillRules.resolve({ selfId: 4605, level: 12, name: 'Fire Weakness', power: 2617, buff: 15000 });
assert.strictEqual(weakness.skillType, C4SkillRules.DAMAGE_EFFECT);
assert.strictEqual(weakness.stats.fireVuln, 1.3);
assert.strictEqual(C4SkillRules.resolve({ selfId: 4584, level: 8, name: 'Reducing P.Def Shock' }).skillType, C4SkillRules.NOT_DONE);

console.log('C4 Forge of the Gods skill semantics checks passed');
