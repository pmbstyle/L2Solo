require('../src/Global');

const assert = require('assert');
const assertC4MonsterLocation = require('./helpers/assert_c4_monster_location');
const assertMonsterEmptyBeforeSlice = require('./helpers/assert_monster_empty_before_slice');

const mobIds = [
    783, 784, 785, 786, 787, 788, 789, 790, 793,
    804, 805, 806, 807, 808, 989, 991, 1034,
    1638, 1639, 1640, 1641, 1642, 1643, 1644, 1645
];

const respawnByMob = {
    788: 30, 789: 30, 790: 30, 793: 30,
    804: 60, 805: 60, 806: 60, 807: 60, 808: 60,
    989: 45, 991: 80
};

assertC4MonsterLocation({
    slug: 'c4_fields_of_silence_and_whispers',
    displayName: 'Fields of Silence and Whispers',
    areaId: 'c4-fields-of-silence-and-whispers',
    mobIds,
    importedNpcIds: mobIds,
    bindingSlugs: ['c4_fields_of_silence_and_whispers'],
    spawnCounts: [
        [783, 30], [784, 36], [785, 32], [786, 37], [787, 33],
        [788, 26], [789, 70], [790, 92], [793, 35],
        [804, 60], [805, 47], [806, 51], [807, 44], [808, 29],
        [989, 37], [991, 12], [1034, 36],
        [1638, 30], [1639, 36], [1640, 33], [1641, 36],
        [1642, 21], [1643, 21], [1644, 39], [1645, 34]
    ],
    respawn: 25,
    respawnByMob,
    regions: [[22, 23], [22, 24], [22, 25], [23, 23]],
    maxHeightDelta: 4771,
    origin: [88539, 179050, -3765],
    sample: {
        id: 804, name: 'Crokian Lad', level: 41, hostile: true,
        pAtk: 291, pDef: 208, mAtk: 141, mDef: 169, hp: 1593,
        exp: 2574, sp: 168, clan: 'croc_clan2', race: 'beast'
    },
    sourceDropRows: 409,
    importedItems: { 6667: 'Deluxe Chest Key - Grade 3' },
    importedSkillRows: 103,
    sourceSkillRows: 103,
    combatSkills: {
        783: [], 784: [], 785: [4034], 786: [4034], 787: [4036],
        788: [4032], 789: [4030], 790: [4228], 793: [4099],
        804: [4074], 805: [4228], 806: [4030],
        807: [4153, 4160], 808: [], 989: [4067], 991: [4073],
        1034: [4032], 1638: [4032], 1639: [4124],
        1640: [4153, 4160], 1641: [4092, 4032], 1642: [4124],
        1643: [4124, 4244], 1644: [4565], 1645: [4157, 4560, 4076]
    }
});

const spawnArea = require('../data/Npcs/Spawns/c4_fields_of_silence_and_whispers.json')[0];
const spawnCoords = spawnArea.spawns.flatMap((spawn) => spawn.coords.map((coord) => ({
    npcId: spawn.selfId,
    ...coord
})));
const nearestDistance = (locX, locY) => Math.min(...spawnCoords.map((coord) =>
    Math.hypot(coord.locX - locX, coord.locY - locY)));

assert.ok(nearestDistance(88539, 179050) < 130,
    'the live dagger location must have a source monster within 130 units');
assert.ok(nearestDistance(82192, 226128) < 565,
    'the Field of Whispers teleport must have a source monster within 565 units');
assert.ok(spawnCoords.some((coord) => coord.npcId === 1639
    && coord.locX === 88613 && coord.locY === 178947 && coord.locZ === -3745),
    'the nearest Tasaba Lizardman source point must remain exact');

assertMonsterEmptyBeforeSlice({
    slug: 'c4_fields_of_silence_and_whispers',
    displayName: 'Field of Silence around the live dagger location',
    ignoreSlugs: ['c4_alligator_island'],
    box: { minX: 85000, maxX: 92000, minY: 175000, maxY: 183000, minZ: -3858, maxZ: -2897 }
});

assertMonsterEmptyBeforeSlice({
    slug: 'c4_fields_of_silence_and_whispers',
    displayName: 'Field of Whispers surface',
    ignoreSlugs: ['c4_alligator_island'],
    box: { minX: 73676, maxX: 96304, minY: 197254, maxY: 226972, minZ: -3871, maxZ: -3216 }
});

assertMonsterEmptyBeforeSlice({
    slug: 'c4_fields_of_silence_and_whispers',
    displayName: 'Field of Whispers deep Nos points',
    ignoreSlugs: ['c4_alligator_island'],
    box: { minX: 75710, maxX: 77264, minY: 245267, maxY: 248020, minZ: -8875, maxZ: -8875 }
});

assertMonsterEmptyBeforeSlice({
    slug: 'c4_fields_of_silence_and_whispers',
    displayName: 'Fields of Silence and Whispers eastern Crokian grounds',
    ignoreSlugs: ['c4_alligator_island'],
    box: { minX: 103662, maxX: 127319, minY: 166091, maxY: 191725, minZ: -3864, maxZ: -2672 }
});
