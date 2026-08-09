const assertLocation = require('./helpers/assert_c4_monster_location');

assertLocation({
    slug: 'c4_catacomb_of_the_apostate',
    areaId: 'c4-catacomb-of-the-apostate',
    displayName: 'Catacomb of the Apostate',
    mobIds: [1152, 1153, 1154, 1155, 1176, 1177, 1178, 1179,
        1197, 1198, 1199, 1200, 1244, 1245, 1246, 1247],
    importedNpcIds: [1152, 1244, 1245, 1246, 1247],
    spawnCounts: [[1152, 16], [1153, 16], [1154, 14], [1155, 14],
        [1176, 17], [1177, 16], [1178, 16], [1179, 14],
        [1197, 17], [1198, 16], [1199, 16], [1200, 14],
        [1244, 17], [1245, 17], [1246, 16], [1247, 16]],
    respawn: 60,
    region: [22, 20],
    origin: [83000, 83000, -5120],
    sample: {
        id: 1244, name: 'Crypt Archon', level: 50, hostile: false,
        pAtk: 560, pDef: 253, mAtk: 264, mDef: 226, hp: 2245,
        exp: 2658, sp: 200, clan: 'c_dungeon_clan', race: 'undead'
    },
    sourceDropRows: 281,
    importedItems: {},
    bindingSlugs: ['c4_catacomb_of_the_apostate', 'c4_necropolis_of_patriots',
        'c4_catacomb_of_the_branded', 'c4_catacomb_of_the_witch'],
    importedSkillRows: 27,
    sourceSkillRows: 110,
    combatSkills: {
        1152: [4151, 4160], 1153: [4101], 1154: [4035], 1155: [4002],
        1176: [4098, 4046, 4002], 1177: [4072, 4092, 4032], 1178: [4067],
        1179: [4098, 4046, 4002], 1197: [4098, 4046, 4030],
        1198: [4072, 4032], 1199: [4032], 1200: [4098, 4046, 4030],
        1244: [4317], 1245: [4099], 1246: [4032], 1247: [4002]
    }
});
