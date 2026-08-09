const assertLocation = require('./helpers/assert_c4_monster_location');

assertLocation({
    slug: 'c4_catacomb_of_dark_omen',
    areaId: 'c4-catacomb-of-dark-omen',
    displayName: 'Catacomb of Dark Omen',
    mobIds: [1162, 1163, 1165, 1184, 1185, 1186, 1205, 1206, 1207, 1253, 1254, 1255],
    importedNpcIds: [1253, 1254, 1255],
    spawnCounts: [[1162, 17], [1163, 14], [1165, 16], [1184, 17], [1185, 13], [1186, 16],
        [1205, 17], [1206, 14], [1207, 16], [1253, 17], [1254, 14], [1255, 16]],
    respawn: 120,
    region: [19, 18],
    origin: [-14000, 18000, -4896],
    sample: {
        id: 1253, name: 'Crypt Preacher', level: 72, hostile: true,
        pAtk: 1413, pDef: 417, mAtk: 849, mDef: 399, hp: 4013,
        exp: 5623, sp: 571, clan: 'c_dungeon_clan', race: 'demonic'
    },
    sourceDropRows: 184,
    importedItems: {
        7646: 'Spellbook - Curse of Doom',
        7647: 'Spellbook - Curse of Abyss',
        7648: 'Spellbook - Arcane Chaos',
        7662: 'Spellbook - Elemental Protection',
        7663: 'Spellbook - Divine Protection',
        7664: 'Spellbook - Arcane Protection'
    },
    bindingSlugs: ['c4_catacomb_of_dark_omen', 'c4_necropolis_of_the_disciples',
        'c4_necropolis_of_saints'],
    importedSkillRows: 17,
    sourceSkillRows: 86,
    combatSkills: {
        1162: [4069], 1163: [4076], 1165: [4098, 4046, 4105], 1184: [4067],
        1185: [4098, 4046, 4002], 1186: [4072, 4092, 4032], 1205: [4032],
        1206: [4098, 4046, 4030], 1207: [4072, 4032], 1253: [4099],
        1254: [4032], 1255: [4002]
    },
    multipliers: [
        { npcId: 1184, stat: 'darkVuln', value: 0.5 },
        { npcId: 1205, stat: 'darkVuln', value: 1.2 }
    ]
});
