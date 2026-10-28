require('../src/Global');

const assertC4MonsterLocation = require('./helpers/assert_c4_monster_location');

const mobIds = [1438, 1439, 1440, 1441, 1442];

assertC4MonsterLocation({
    slug: 'c4_heathen_camp',
    displayName: 'Heathen Camp',
    mobIds,
    importedNpcIds: mobIds,
    bindingSlugs: ['c4_heathen_camp'],
    origin: [102000, -60500, -2600],
    sample: {
        id: 1438, name: 'Heathen Warrior', level: 65, hostile: true,
        pAtk: 1140, pDef: 346, mAtk: 619, mDef: 340, hp: 3465,
        exp: 5966, sp: 556, clan: 'undead_clan', race: 'undead'
    },
    sourceDropRows: 74,
    importedItems: {},
    importedSkillRows: 34,
    sourceSkillRows: 34,
    combatSkills: {
        1438: [4032], 1439: [4073], 1440: [4040], 1441: [4072], 1442: [4232]
    }
});

