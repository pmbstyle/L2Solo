const assertLocation = require('./helpers/assert_c4_monster_location');

assertLocation({
    slug: 'c4_necropolis_of_ascetics',
    areaId: 'c4-necropolis-of-ascetics',
    displayName: 'Necropolis of Ascetics',
    mobIds: [1156, 1157, 1158, 1179, 1180, 1181, 1200, 1201, 1202, 1224, 1225, 1226],
    importedNpcIds: [1158, 1224, 1225, 1226],
    spawnCounts: [[1156, 15], [1157, 16], [1158, 16], [1179, 15], [1180, 15], [1181, 16],
        [1200, 15], [1201, 15], [1202, 16], [1224, 15], [1225, 15], [1226, 15]],
    respawn: 120,
    region: [18, 20],
    maxHeightDelta: 48,
    origin: [-47000, 84000, -4784],
    sample: {
        id: 1158, name: 'Hell Keeper Crimson Doll', level: 67, hostile: true,
        pAtk: 1063, pDef: 483, mAtk: 681, mDef: 356, hp: 3626,
        exp: 5133, sp: 488, clan: 'c_dungeon_clan', race: 'undead'
    },
    sourceDropRows: 202,
    importedItems: {
        6350: "Amulet: Pa'agrio's Honor",
        6352: 'Spellbook: Prayer'
    },
    bindingSlugs: ['c4_necropolis_of_ascetics', 'c4_catacomb_of_the_witch'],
    importedSkillRows: 25,
    sourceSkillRows: 87,
    combatSkills: {
        1156: [4158, 4160, 4076], 1157: [4035], 1158: [4073],
        1179: [4098, 4046, 4002], 1180: [4072, 4092, 4032], 1181: [4067],
        1200: [4098, 4046, 4030], 1201: [4072, 4032], 1202: [4032],
        1224: [4317], 1225: [4099], 1226: [4032]
    },
    multipliers: [
        { npcId: 1158, stat: 'maxHpMul', value: 4 },
        { npcId: 1181, stat: 'darkVuln', value: 0.5 },
        { npcId: 1202, stat: 'darkVuln', value: 1.2 }
    ]
});
