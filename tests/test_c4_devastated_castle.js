require('../src/Global');

const assertC4MonsterLocation = require('./helpers/assert_c4_monster_location');

assertC4MonsterLocation({
    slug: 'c4_devastated_castle',
    displayName: 'Devastated Castle',
    mobIds: [1004, 1005, 1006],
    importedNpcIds: [1004, 1005, 1006],
    bindingSlugs: ['c4_devastated_castle'],
    origin: [178000, -15000, -2800],
    sample: {
        id: 1004, name: 'Dismal Pole', level: 58, hostile: true,
        pAtk: 828, pDef: 384, mAtk: 428, mDef: 284, hp: 2889,
        exp: 5239, sp: 443, clan: 'undead_clan', race: 'plant'
    },
    sourceDropRows: 51,
    importedItems: {
        4911: 'Spellbook: Curse Disease',
        4925: "Amulet: Pa'agrio's Haste",
        4951: 'Recipe: Avadon Robe (60%)'
    },
    importedSkillRows: 17,
    sourceSkillRows: 17,
    combatSkills: {
        1004: [4028],
        1005: [4074],
        1006: [4034, 4100, 4002, 4038]
    },
    multipliers: [
        { npcId: 1004, stat: 'holyVuln', value: 1.2 },
        { npcId: 1004, stat: 'fireVuln', value: 1.15 },
        { npcId: 1004, stat: 'bowWpnVuln', value: 0.5 },
        { npcId: 1004, stat: 'poisonVuln', value: 0.5 },
        { npcId: 1006, stat: 'pCritDamageMul', value: 1.25 }
    ]
});
