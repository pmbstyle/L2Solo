require('../src/Global');

const assertC4MonsterLocation = require('./helpers/assert_c4_monster_location');

const mobIds = [135, 791, 792];

assertC4MonsterLocation({
    slug: 'c4_alligator_island',
    displayName: 'Alligator Island',
    mobIds,
    importedNpcIds: mobIds,
    bindingSlugs: ['c4_alligator_island'],
    origin: [100000, 205000, -3600],
    sample: {
        id: 135, name: 'Alligator', level: 40, hostile: true,
        pAtk: 300, pDef: 183, mAtk: 131, mDef: 164, hp: 1527,
        exp: 2373, sp: 153, clan: 'croc_clan2', race: 'beast'
    },
    sourceDropRows: 46,
    importedItems: {
        7641: 'Spellbook - Summon Queen of Cat',
        7642: 'Spellbook - Summon Unicorn Seraphim'
    },
    importedSkillRows: 10,
    sourceSkillRows: 10,
    combatSkills: { 135: [], 791: [4074], 792: [4151, 4160, 4076] }
});

