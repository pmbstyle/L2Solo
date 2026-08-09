const assertLocation = require('./helpers/assert_c4_monster_location');

assertLocation({
    slug: 'c4_necropolis_of_pilgrims',
    areaId: 'c4-necropolis-of-pilgrims',
    displayName: 'Necropolis of Pilgrims',
    mobIds: [1144, 1145, 1146, 1170, 1171, 1172, 1191, 1192, 1193, 1213, 1214, 1215],
    importedNpcIds: [1144, 1145, 1146, 1170, 1171, 1172, 1191, 1192, 1193, 1213, 1214, 1215],
    spawnCounts: [[1144, 14], [1145, 15], [1146, 15], [1170, 15], [1171, 14], [1172, 16],
        [1191, 15], [1192, 14], [1193, 14], [1213, 15], [1214, 15], [1215, 14]],
    respawn: 120,
    region: [21, 21],
    origin: [50000, 118000, -5408],
    sample: {
        id: 1144, name: 'Catacomb Shadow', level: 34, hostile: true,
        pAtk: 178, pDef: 138, mAtk: 82, mDef: 132, hp: 1164,
        exp: 1254, sp: 73, clan: 'c_dungeon_clan', race: 'demonic'
    },
    sourceDropRows: 177,
    importedItems: {
        7638: 'Spellbook - Mass Summon Storm Cubic',
        7639: 'Spellbook - Mass Summon Aqua Cubic',
        7640: 'Spellbook - Mass Summon Phantom Cubic',
        7643: 'Spellbook - Summon Nightshade',
        7644: 'Spellbook - Summon Cursed Man'
    },
    bindingSlugs: ['c4_necropolis_of_pilgrims'],
    importedSkillRows: 71,
    sourceSkillRows: 71,
    combatSkills: {
        1144: [4158, 4160, 4076], 1145: [4035], 1146: [4066], 1170: [4001],
        1171: [4029], 1172: [4067], 1191: [4078], 1192: [4029], 1193: [4032],
        1213: [4099], 1214: [4032], 1215: [4002]
    },
    multipliers: [
        { npcId: 1144, stat: 'windVuln', value: 1.15 },
        { npcId: 1172, stat: 'darkVuln', value: 0.5 },
        { npcId: 1193, stat: 'darkVuln', value: 1.2 }
    ]
});
