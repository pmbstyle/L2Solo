require('../src/Global');

const assertC4MonsterLocation = require('./helpers/assert_c4_monster_location');
const assertMonsterEmptyBeforeSlice = require('./helpers/assert_monster_empty_before_slice');

const mobIds = [804, 805, 806, 807, 808, 991];

assertC4MonsterLocation({
    slug: 'c4_fields_of_silence_and_whispers',
    displayName: 'Fields of Silence and Whispers',
    areaId: 'c4-fields-of-silence-and-whispers',
    mobIds,
    importedNpcIds: mobIds,
    bindingSlugs: ['c4_fields_of_silence_and_whispers'],
    spawnCounts: [[804, 60], [805, 47], [806, 51], [807, 44], [808, 29], [991, 12]],
    respawn: 60,
    respawnByMob: { 991: 80 },
    region: [23, 23],
    maxHeightDelta: 1070,
    origin: [115000, 178000, -3200],
    sample: {
        id: 804, name: 'Crokian Lad', level: 41, hostile: true,
        pAtk: 291, pDef: 208, mAtk: 141, mDef: 169, hp: 1593,
        exp: 2574, sp: 168, clan: 'croc_clan2', race: 'beast'
    },
    sourceDropRows: 98,
    importedItems: {},
    importedSkillRows: 24,
    sourceSkillRows: 24,
    combatSkills: {
        804: [4074], 805: [4228], 806: [4030],
        807: [4153, 4160], 808: [], 991: [4073]
    }
});

assertMonsterEmptyBeforeSlice({
    slug: 'c4_fields_of_silence_and_whispers',
    displayName: 'Fields of Silence and Whispers',
    box: { minX: 103662, maxX: 127319, minY: 166091, maxY: 191725, minZ: -3864, maxZ: -2672 }
});
