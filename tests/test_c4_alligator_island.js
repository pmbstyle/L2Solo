require('../src/Global');

const assertC4MonsterLocation = require('./helpers/assert_c4_monster_location');
const assertMonsterEmptyBeforeSlice = require('./helpers/assert_monster_empty_before_slice');

const mobIds = [135, 791, 792];

assertC4MonsterLocation({
    slug: 'c4_alligator_island',
    displayName: 'Alligator Island',
    areaId: 'c4-alligator-island',
    mobIds,
    importedNpcIds: mobIds,
    bindingSlugs: ['c4_alligator_island'],
    spawnCounts: [[135, 47], [791, 42], [792, 48]],
    respawn: 30,
    regions: [[22, 24], [23, 23], [23, 24]],
    maxHeightDelta: 510,
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

assertMonsterEmptyBeforeSlice({
    slug: 'c4_alligator_island',
    displayName: 'Alligator Island',
    ignoreSlugs: ['c4_fields_of_silence_and_whispers'],
    box: { minX: 75423, maxX: 123050, minY: 183564, maxY: 223814, minZ: -3902, maxZ: -3320 }
});
