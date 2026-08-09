require('../src/Global');

const assertC4MonsterLocation = require('./helpers/assert_c4_monster_location');
const assertMonsterEmptyBeforeSlice = require('./helpers/assert_monster_empty_before_slice');

const mobIds = [1438, 1439, 1440, 1441, 1442];

assertC4MonsterLocation({
    slug: 'c4_heathen_camp',
    displayName: 'Heathen Camp',
    areaId: 'c4-heathen-camp',
    mobIds,
    importedNpcIds: mobIds,
    bindingSlugs: ['c4_heathen_camp'],
    spawnCounts: [[1438, 12], [1439, 12], [1440, 12], [1441, 12], [1442, 12]],
    respawn: 37,
    period: 'night',
    region: [23, 16],
    maxHeightDelta: 112,
    origin: [102000, -60500, -2600],
    sample: {
        id: 1438, name: 'Heathen Warrior', level: 65, hostile: true,
        pAtk: 1140, pDef: 346, mAtk: 619, mDef: 340, hp: 3465,
        exp: 5966, sp: 556, clan: 'undead_clan', race: 'undead'
    },
    sourceDropRows: 74,
    importedItems: {},
    importedSkillRows: 34,
    sourceSkillRows: 34,
    combatSkills: {
        1438: [4032], 1439: [4073], 1440: [4040], 1441: [4072], 1442: [4232]
    }
});

assertMonsterEmptyBeforeSlice({
    slug: 'c4_heathen_camp',
    displayName: 'Heathen Camp',
    box: { minX: 98868, maxX: 105806, minY: -61713, maxY: -59263, minZ: -2816, maxZ: -2288 }
});
