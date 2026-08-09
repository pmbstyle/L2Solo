const assertLocation = require('./helpers/assert_c4_monster_location');

assertLocation({
    slug: 'c4_necropolis_of_martyrs',
    areaId: 'c4-necropolis-of-martyrs',
    displayName: 'Necropolis of Martyrs',
    mobIds: [1158, 1159, 1160, 1181, 1182, 1183, 1202, 1203, 1204, 1226, 1227, 1228],
    importedNpcIds: [1227],
    spawnCounts: [[1158, 11], [1159, 10], [1160, 11], [1181, 11], [1182, 10], [1183, 11],
        [1202, 11], [1203, 10], [1204, 11], [1226, 11], [1227, 10], [1228, 11]],
    respawn: 120,
    region: [23, 22],
    origin: [124000, 135000, -4824],
    sample: {
        id: 1227, name: 'Sepulcher Sage', level: 67, hostile: true,
        pAtk: 1169, pDef: 373, mAtk: 681, mDef: 356, hp: 3626,
        exp: 5444, sp: 518, clan: 'c_dungeon_clan', race: 'undead'
    },
    sourceDropRows: 195,
    importedItems: {},
    bindingSlugs: ['c4_necropolis_of_martyrs', 'c4_necropolis_of_ascetics',
        'c4_catacomb_of_the_witch', 'c4_necropolis_of_the_disciples'],
    importedSkillRows: 7,
    sourceSkillRows: 92,
    combatSkills: {
        1158: [4073], 1159: [4072], 1160: [4157, 4160, 4038], 1181: [4067],
        1182: [4098, 4046, 4002], 1183: [4072, 4092, 4032], 1202: [4032],
        1203: [4098, 4046, 4030], 1204: [4072, 4032], 1226: [4032],
        1227: [4002], 1228: [4317]
    },
    multipliers: [
        { npcId: 1181, stat: 'darkVuln', value: 0.5 },
        { npcId: 1203, stat: 'darkVuln', value: 1.2 }
    ]
});
