const assert = require('assert');

require('../src/Global');

const C4SkillRules = invoke('GameServer/Skills/C4SkillRules');
const assertC4MonsterLocation = require('./helpers/assert_c4_monster_location');
const assertMonsterEmptyBeforeSlice = require('./helpers/assert_monster_empty_before_slice');

const mobIds = [1314, 1315, 1316, 1317, 1318, 1319, 1320, 1321, 1322, 1323];

assertC4MonsterLocation({
    slug: 'c4_hot_springs',
    displayName: 'Hot Springs',
    areaId: 'c4-hot-springs',
    mobIds,
    importedNpcIds: mobIds,
    bindingSlugs: ['c4_hot_springs'],
    spawnCounts: [
        [1314, 21], [1315, 18], [1316, 12], [1317, 9], [1318, 26],
        [1319, 25], [1320, 22], [1321, 13], [1322, 15], [1323, 10]
    ],
    respawn: 70,
    region: [24, 14],
    maxHeightDelta: 440,
    origin: [148000, -113000, -2500],
    sample: {
        id: 1314, name: 'Hot Springs Bandersnatchling', level: 73, hostile: true,
        pAtk: 2032, pDef: 502, mAtk: 885, mDef: 407, hp: 4086,
        exp: 8609, sp: 886, clan: '', race: 'animal'
    },
    sourceDropRows: 129,
    importedItems: {
        7649: 'Spellbook - Fire Vortex',
        7650: 'Spellbook - Ice Vortex',
        7651: 'Spellbook - Wind Vortex',
        7652: 'Spellbook - Light Vortex',
        7653: 'Spellbook - Dark Vortex'
    },
    importedSkillRows: 119,
    sourceSkillRows: 119,
    combatSkills: {
        1314: [4002, 4073, 4074, 4096, 4551, 4554],
        1315: [4092, 4072, 4073],
        1316: [4073, 4099, 4074, 4552, 4554],
        1317: [4002, 4073, 4074, 4096, 4553, 4554],
        1318: [4092, 4033, 4073],
        1319: [4073, 4072, 4074, 4099, 4552, 4554],
        1320: [4092, 4072, 4073],
        1321: [4002, 4073, 4074, 4096, 4551, 4554],
        1322: [4002, 4073, 4074, 4099, 4553, 4554],
        1323: [4092, 4033, 4073]
    }
});

assertMonsterEmptyBeforeSlice({
    slug: 'c4_hot_springs',
    displayName: 'Hot Springs',
    box: { minX: 138484, maxX: 158620, minY: -123090, maxY: -102992, minZ: -3832, maxZ: -1280 }
});

const semantic = (selfId, level) => C4SkillRules.resolve({
    selfId, level, name: 'Hot Springs disease', power: 100, buff: 600000, spell: true, distance: 600
});
assert.deepStrictEqual(semantic(4551, 10).stats, { pDefMul: 0.85, pCritRateAdd: 0 });
assert.deepStrictEqual(semantic(4552, 10).stats, { pEvasionRateAdd: -10, pAccuracyCombatAdd: 0 });
assert.deepStrictEqual(semantic(4553, 4).stats, { pAtkSpdMul: 1.16, pAtkMul: 0.96 });
assert.deepStrictEqual(semantic(4554, 10).stats, { castSpdMul: 1, magicalMpConsumeMul: 0.84 });
assert.strictEqual(semantic(4551, 1).mpInitialConsume, 14);
assert.strictEqual(semantic(4555, 1).skillType, C4SkillRules.NOT_DONE);

console.log('C4 Hot Springs disease semantics checks passed');
