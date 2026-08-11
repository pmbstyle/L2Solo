require('../src/Global');

const assertC4MonsterLocation = require('./helpers/assert_c4_monster_location');
const assertMonsterEmptyBeforeSlice = require('./helpers/assert_monster_empty_before_slice');

const mobIds = [1646, 1647, 1648, 1649, 1650, 1651];

assertC4MonsterLocation({
    slug: 'c4_shrine_of_loyalty',
    displayName: 'Shrine of Loyalty',
    areaId: 'c4-shrine-of-loyalty',
    mobIds,
    importedNpcIds: mobIds,
    bindingSlugs: ['c4_shrine_of_loyalty'],
    spawnCounts: [[1646, 6], [1647, 8], [1648, 12], [1649, 7], [1650, 10], [1651, 9]],
    respawn: 45,
    regions: [[25, 15], [25, 16]],
    maxHeightDelta: 805,
    origin: [190000, -64000, -2800],
    sample: {
        id: 1646, name: 'Grave Scarab', level: 73, hostile: false,
        pAtk: 1463, pDef: 502, mAtk: 885, mDef: 407, hp: 4086,
        exp: 10206, sp: 1050, clan: '', race: 'insect'
    },
    sourceDropRows: 91,
    importedItems: {},
    importedSkillRows: 30,
    sourceSkillRows: 30,
    combatSkills: {
        1646: [], 1647: [4001, 4002, 4035], 1648: [4067],
        1649: [4232, 4067], 1650: [4630, 4160, 4571, 4635, 4035], 1651: [4033]
    }
});

assertMonsterEmptyBeforeSlice({
    slug: 'c4_shrine_of_loyalty',
    displayName: 'Shrine of Loyalty',
    ignoreSlugs: ['c4_wall_of_argos'],
    box: { minX: 185384, maxX: 194404, minY: -70460, maxY: -58698, minZ: -3000, maxZ: -2568 }
});
