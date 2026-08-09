const assertLocation = require('./helpers/assert_c4_monster_location');

assertLocation({
    slug: 'c4_necropolis_of_patriots',
    areaId: 'c4-necropolis-of-patriots',
    displayName: 'Necropolis of Patriots',
    mobIds: [1153, 1154, 1155, 1177, 1178, 1179, 1198, 1199, 1200, 1221, 1222, 1223],
    importedNpcIds: [1153, 1154, 1155, 1177, 1178, 1198, 1199, 1221, 1222, 1223],
    spawnCounts: [[1153, 16], [1154, 16], [1155, 16], [1177, 15], [1178, 16], [1179, 16],
        [1198, 16], [1199, 16], [1200, 16], [1221, 14], [1222, 15], [1223, 16]],
    respawn: 120,
    region: [19, 20],
    origin: [-18000, 82000, -5168],
    sample: {
        id: 1153, name: 'Purgatory Serpent', level: 56, hostile: true,
        pAtk: 706, pDef: 281, mAtk: 382, mDef: 269, hp: 2724,
        exp: 3586, sp: 294, clan: 'c_dungeon_clan', race: 'beast'
    },
    sourceDropRows: 222,
    importedItems: {
        4944: 'Recipe: Avadon Breastplate (60%)',
        4965: "Recipe: Sprite's Staff (60%)",
        4968: 'Recipe: Kris (60%)',
        5003: 'Recipe: Art of Battle Axe (60%)',
        5280: 'Recipe: Greater Blessed Spiritshot (B) Compressed Package(100%)',
        5809: 'Spellbook: Aqua Splash',
        5810: 'Spellbook: Rain of Fire',
        5816: 'Spellbook: Advanced Block',
        6351: 'Amulet: Ritual of Life'
    },
    bindingSlugs: ['c4_necropolis_of_patriots', 'c4_catacomb_of_the_witch'],
    importedSkillRows: 58,
    sourceSkillRows: 78,
    combatSkills: {
        1153: [4101], 1154: [4035], 1155: [4002], 1177: [4072, 4092, 4032],
        1178: [4067], 1179: [4098, 4046, 4002], 1198: [4072, 4032], 1199: [4032],
        1200: [4098, 4046, 4030], 1221: [4099], 1222: [4032], 1223: [4002]
    },
    multipliers: [
        { npcId: 1178, stat: 'darkVuln', value: 0.5 },
        { npcId: 1199, stat: 'darkVuln', value: 1.2 }
    ]
});
