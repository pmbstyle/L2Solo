const assertLocation = require('./helpers/assert_c4_monster_location');

assertLocation({
    slug: 'c4_catacomb_of_the_forbidden_path',
    areaId: 'c4-catacomb-of-the-forbidden-path',
    displayName: 'Catacomb of the Forbidden Path',
    mobIds: [1163, 1164, 1165, 1185, 1186, 1206, 1207, 1254, 1255],
    importedNpcIds: [],
    spawnCounts: [[1163, 11], [1164, 9], [1165, 11], [1185, 15], [1186, 16],
        [1206, 15], [1207, 16], [1254, 15], [1255, 16]],
    respawn: 60,
    region: [23, 20],
    origin: [118000, 85000, -6536],
    sample: {
        id: 1255, name: 'Tomb Preacher', level: 77, hostile: true,
        pAtk: 1664, pDef: 463, mAtk: 1031, mDef: 442, hp: 4364,
        exp: 7190, sp: 778, clan: 'c_dungeon_clan', race: 'undead'
    },
    sourceDropRows: 136,
    importedItems: {},
    bindingSlugs: ['c4_catacomb_of_the_forbidden_path', 'c4_necropolis_of_saints',
        'c4_necropolis_of_the_disciples', 'c4_catacomb_of_dark_omen'],
    importedSkillRows: 0,
    sourceSkillRows: 70,
    combatSkills: {
        1163: [4076], 1164: [4101], 1165: [4098, 4046, 4105],
        1185: [4098, 4046, 4002], 1186: [4072, 4092, 4032],
        1206: [4098, 4046, 4030], 1207: [4072, 4032],
        1254: [4032], 1255: [4002]
    }
});
