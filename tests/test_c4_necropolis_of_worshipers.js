const assertLocation = require('./helpers/assert_c4_monster_location');

assertLocation({
    slug: 'c4_necropolis_of_worshipers',
    areaId: 'c4-necropolis-of-worshipers',
    displayName: 'Necropolis of Worshipers',
    mobIds: [1147, 1148, 1149, 1174, 1175, 1176, 1195, 1196, 1197, 1217, 1218, 1219],
    importedNpcIds: [1148, 1217, 1218, 1219],
    spawnCounts: [[1147, 11], [1148, 14], [1149, 14], [1174, 10], [1175, 9], [1176, 13],
        [1195, 12], [1196, 9], [1197, 12], [1217, 13], [1218, 11], [1219, 13]],
    respawn: 60,
    region: [23, 23],
    origin: [116000, 179000, -5432],
    sample: {
        id: 1148, name: 'Catacomb Liviona', level: 44, hostile: true,
        pAtk: 354, pDef: 196, mAtk: 176, mDef: 187, hp: 1799,
        exp: 2100, sp: 143, clan: 'c_dungeon_clan', race: 'construct'
    },
    sourceDropRows: 164,
    importedItems: {
        5812: 'Spellbook: Servitor Empowerment',
        5813: 'Spellbook: Servitor Cure'
    },
    bindingSlugs: ['c4_necropolis_of_worshipers', 'c4_catacomb_of_the_branded'],
    importedSkillRows: 22,
    sourceSkillRows: 84,
    combatSkills: {
        1147: [4072], 1148: [4157, 4160, 4038], 1149: [4101], 1174: [4029],
        1175: [4067], 1176: [4098, 4046, 4002], 1195: [4029], 1196: [4032],
        1197: [4098, 4046, 4030], 1217: [4099], 1218: [4032], 1219: [4002]
    },
    multipliers: [
        { npcId: 1148, stat: 'windVuln', value: 1.15 },
        { npcId: 1175, stat: 'darkVuln', value: 0.5 },
        { npcId: 1196, stat: 'darkVuln', value: 1.2 }
    ]
});
