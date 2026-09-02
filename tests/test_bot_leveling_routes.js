const assert = require('assert');

require('../src/Global');

const LevelingRoutes = invoke('GameServer/Bot/AI/LevelingRoutes');
const SpotService = invoke('GameServer/Bot/AI/SpotService');

const spots = [
    {
        id: 'field_undead',
        name: 'Cemetery Bones',
        minLevel: 58,
        maxLevel: 64,
        avgLevel: 61,
        density: 8,
        center: { locX: 1000, locY: 1000, locZ: 0 },
        npcNames: ['Ghoul', 'Skeleton Archer', 'Bone Collector']
    },
    {
        id: 'field_beasts',
        name: 'Beast Farm',
        minLevel: 58,
        maxLevel: 64,
        avgLevel: 61,
        density: 12,
        center: { locX: 2000, locY: 1000, locZ: 0 },
        npcNames: ['Buffalo', 'Antelope', 'Kookaburra']
    },
    {
        id: 'cata_room',
        name: 'Catacomb of the Branded',
        minLevel: 58,
        maxLevel: 64,
        avgLevel: 61,
        density: 20,
        center: { locX: 3000, locY: 1000, locZ: 0 },
        npcNames: ['Nephilim Guard', 'Lilim Priest', 'Seal Watchman']
    },
    {
        id: 'lizard_spoil',
        name: 'Plains of the Lizardmen',
        minLevel: 35,
        maxLevel: 40,
        avgLevel: 38,
        density: 7,
        center: { locX: 4000, locY: 1000, locZ: 0 },
        npcNames: ['Leto Lizardman Warrior', 'Leto Lizardman Archer']
    },
    {
        id: 'cruma_construct',
        name: 'Cruma Tower',
        minLevel: 40,
        maxLevel: 45,
        avgLevel: 42,
        density: 9,
        center: { locX: 5000, locY: 1000, locZ: 0 },
        npcNames: ['Porta', 'Excuro', 'Krator']
    },
    {
        id: 'toi_party',
        name: 'Tower of Insolence',
        minLevel: 66,
        maxLevel: 74,
        avgLevel: 70,
        density: 8,
        center: { locX: 6000, locY: 1000, locZ: 0 },
        npcNames: ['Tower Guardian', 'Platinum Angel']
    }
];

let best = LevelingRoutes.bestSpot(spots, {
    level: 61,
    stats: { role: 'healer', classId: 16 }
}, { mode: 'solo' });
assert.strictEqual(best.spot.id, 'field_undead', 'healers should prefer undead-friendly leveling spots');
assert.strictEqual(best.route.reason, 'cleric_might_of_heaven');

best = LevelingRoutes.bestSpot(spots, {
    level: 38,
    stats: { classId: 55 }
}, { mode: 'solo' });
assert.strictEqual(best.spot.id, 'lizard_spoil', 'Bounty Hunters should prefer spoil material routes');
assert.strictEqual(best.route.reason, 'spoiler_materials');

best = LevelingRoutes.bestSpot(spots, {
    level: 42,
    stats: { classId: 54 }
}, { mode: 'solo' });
assert.notStrictEqual(best.spot.id, 'cruma_construct', 'a solo Scavenger must not enter Cruma for its construct spoil route');

const fullKit = (rank) => [
    { equipped: true, kind: 'Weapon.Sword', rank, slot: 7 },
    { equipped: true, kind: 'Armor.Wear', rank, slot: 6 },
    { equipped: true, kind: 'Armor.Wear', rank, slot: 9 },
    { equipped: true, kind: 'Armor.Chain', rank, slot: 10 },
    { equipped: true, kind: 'Armor.Chain', rank, slot: 11 }
];
best = LevelingRoutes.bestSpot(spots, {
    level: 42,
    stats: { classId: 54 }
}, { mode: 'solo', equipment: fullKit('c') });
assert.strictEqual(best.spot.id, 'cruma_construct',
    'a solo Scavenger in a complete C-grade kit may use the Cruma construct route');

best = LevelingRoutes.bestSpot(spots, {
    level: 42,
    activity: 'grouped',
    party: { partyId: 'cruma_spoil_party' },
    stats: { classId: 54, routeMode: 'party' }
}, { mode: 'party' });
assert.strictEqual(best.spot.id, 'cruma_construct', 'a Scavenger party should prefer construct spoil routes around Cruma levels');
assert.strictEqual(best.route.reason, 'spoiler_construct_materials');

best = LevelingRoutes.bestSpot(spots, {
    level: 61,
    stats: { role: 'mage', classId: 12 }
}, { mode: 'solo' });
assert.notStrictEqual(best.spot.id, 'cata_room', 'solo mages should avoid catacomb-style high downtime spots');
assert.strictEqual(best.route.reason, 'mage_low_downtime');

best = LevelingRoutes.bestSpot(spots, {
    level: 70,
    stats: { role: 'mage', classId: 12 }
}, { mode: 'party' });
assert.strictEqual(best.spot.id, 'toi_party', 'mage parties should be allowed to prefer party routes');
assert.strictEqual(best.route.reason, 'mage_party_damage');
assert.strictEqual(
    LevelingRoutes.scoreSpot(spots[5], { level: 70, stats: { role: 'mage', classId: 12 } }, {
        mode: 'solo',
        equipment: fullKit('b')
    }).huntingGround.allowed,
    true,
    'a solo Tower of Insolence hunter in a complete B-grade kit must pass the ground gate'
);

assert.ok(LevelingRoutes.tagsForSpot(spots[0]).includes('undead'), 'undead tag should be inferred from mob names');
assert.ok(LevelingRoutes.tagsForSpot(spots[2]).includes('catacomb'), 'catacomb tag should be inferred from zone and mob names');
assert.strictEqual(
    LevelingRoutes.scoreSpot(spots[2], { level: 61, stats: { role: 'dps' } }, { mode: 'solo' }).huntingGround.allowed,
    false,
    'ordinary solo bots must treat catacombs as party-required hunting grounds'
);
assert.strictEqual(
    LevelingRoutes.scoreSpot(spots[2], { level: 61, stats: { role: 'dps' } }, { mode: 'party' }).huntingGround.allowed,
    true,
    'party routes must remain eligible for catacomb hunting'
);
const exceptionalSolo = LevelingRoutes.scoreSpot(spots[2], { level: 76, stats: { role: 'dps' } }, {
    mode: 'solo',
    equipment: [
        { equipped: true, kind: 'Weapon.Sword', rank: 's', slot: 7 },
        { equipped: true, kind: 'Armor.Heavy', rank: 's', slot: 6 },
        { equipped: true, kind: 'Armor.Heavy', rank: 's', slot: 9 },
        { equipped: true, kind: 'Armor.Heavy', rank: 's', slot: 10 },
        { equipped: true, kind: 'Armor.Heavy', rank: 's', slot: 12 }
    ]
});
assert.strictEqual(exceptionalSolo.huntingGround.allowed, true,
    'a substantially over-levelled solo bot with a complete current-grade kit may enter');
assert.strictEqual(exceptionalSolo.huntingGround.exceptionalSoloReady, true);
const sameGradeSolo = LevelingRoutes.scoreSpot({
    ...spots[2],
    minLevel: 20,
    maxLevel: 24,
    avgLevel: 22
}, { level: 30, stats: { role: 'dps' } }, {
    mode: 'solo',
    equipment: [
        { equipped: true, kind: 'Armor.Jewel', rank: 'd', slot: 1 },
        { equipped: true, kind: 'Armor.Jewel', rank: 'd', slot: 2 },
        { equipped: true, kind: 'Armor.Jewel', rank: 'd', slot: 3 },
        { equipped: true, kind: 'Armor.Jewel', rank: 'd', slot: 4 },
        { equipped: true, kind: 'Weapon.Sword', rank: 'd', slot: 7 },
        { equipped: true, kind: 'Armor.Wear', rank: 'd', slot: 6 },
        { equipped: true, kind: 'Armor.Wear', rank: 'd', slot: 9 },
        { equipped: true, kind: 'Armor.Leather', rank: 'd', slot: 10 },
        { equipped: true, kind: 'Armor.Wear', rank: 'd', slot: 12 }
    ]
});
assert.strictEqual(sameGradeSolo.huntingGround.allowed, false,
    'same-grade equipment and jewellery must not masquerade as exceptional catacomb readiness');

const sharedElvenStarter = {
    id: 'elf-dark-elf-overlap',
    name: 'Shared Elven Starter Field',
    minLevel: 1,
    maxLevel: 12,
    avgLevel: 6,
    density: 10,
    center: { locX: 46000, locY: 40000, locZ: 0 },
    npcNames: ['Young Brown Keltir'],
    tags: ['starter'],
    tagsAuthoritative: true
};
assert.strictEqual(
    LevelingRoutes.scoreSpot(sharedElvenStarter, { level: 6, stats: { starterRegion: 'elf' } }).localityPenalty,
    0,
    'an Elf starter spot must remain local to the Elf cohort'
);
assert.strictEqual(
    LevelingRoutes.scoreSpot(sharedElvenStarter, { level: 6, stats: { starterRegion: 'dark_elf' } }).localityPenalty,
    0,
    'overlapping starter radii must not exclude the adjacent Dark Elf cohort'
);
assert.ok(
    LevelingRoutes.scoreSpot(sharedElvenStarter, { level: 6, stats: { starterRegion: 'orc' } }).localityPenalty >= 10000,
    'a genuinely remote starter cohort must still receive the locality penalty'
);

const elvenRuins = {
    id: '7_41',
    name: 'Elven Ruins',
    minLevel: 9,
    maxLevel: 22,
    avgLevel: 13,
    density: 78,
    capacity: 64,
    center: { locX: 45596, locY: 247589, locZ: -6518 },
    npcNames: ['Skeleton', 'Tunath Orc Warrior', 'Tunath Orc Marksman'],
    tags: ['dungeon', 'undead', 'ruins'],
    tagsAuthoritative: true,
    localStarterRegions: ['human'],
    localUntilLevel: 20
};
assert.deepStrictEqual(
    LevelingRoutes.tagsForSpot(elvenRuins),
    ['dungeon', 'undead', 'ruins'],
    'canonical area tags must override incidental mob-name matches such as Tunath Orc'
);
assert.ok(
    LevelingRoutes.scoreSpot(elvenRuins, { level: 12, stats: { starterRegion: 'elf' } }).localityPenalty >= 10000,
    'non-human starter cohorts must not converge on the Talking Island dungeon'
);
assert.strictEqual(
    LevelingRoutes.scoreSpot(elvenRuins, { level: 12, stats: { starterRegion: 'human' } }).localityPenalty,
    0,
    'the local human starter cohort may still use Elven Ruins at the intended level'
);
const crowded = LevelingRoutes.scoreSpot(elvenRuins, { characterId: 1, level: 13 }, { occupancy: { '7_41': 273 } });
const available = LevelingRoutes.scoreSpot(elvenRuins, { characterId: 1, level: 13 }, { occupancy: { '7_41': 20 } });
assert.ok(crowded.crowdPenalty > available.crowdPenalty + 1000,
    'a 273-bot dungeon pile must lose decisively to an available hunting spot');

const mithrilMines = {
    id: '29_-30',
    name: 'Mithril Mines',
    minLevel: 10,
    maxLevel: 16,
    avgLevel: 12.5,
    density: 89,
    capacity: 48,
    center: { locX: 176673, locY: -177656, locZ: 801 },
    npcNames: ['Akaste Bone Soldier', 'Darkstone Golem', 'Mineshaft Bat'],
    tags: ['dungeon', 'undead', 'construct', 'mine'],
    tagsAuthoritative: true,
    localStarterRegions: ['dwarf'],
    localUntilLevel: 20
};
assert.deepStrictEqual(
    LevelingRoutes.tagsForSpot(mithrilMines),
    ['dungeon', 'undead', 'construct', 'mine'],
    'canonical Mithril Mines metadata must not acquire the generic starter tag'
);
assert.ok(
    LevelingRoutes.scoreSpot(mithrilMines, { level: 13, stats: { starterRegion: 'elf' } }).localityPenalty >= 10000,
    'non-dwarven starter cohorts must leave the detached Mithril Mines cell'
);
assert.strictEqual(
    LevelingRoutes.scoreSpot(mithrilMines, { level: 13, stats: { starterRegion: 'dwarf' } }).localityPenalty,
    0,
    'dwarven starters may use their native mine route'
);
assert.strictEqual(LevelingRoutes.capacityForSpot(mithrilMines), 48, 'the explicit mine capacity must override density-derived defaults');
assert.strictEqual(LevelingRoutes.capacityForSpot({ density: 4 }), 9,
    'a sparse ordinary field must still fit one complete party');
assert.strictEqual(LevelingRoutes.capacityForSpot({ density: 40 }), 30,
    'ordinary field capacity must stay below its continuously unavailable spawn count');
assert.strictEqual(LevelingRoutes.capacityForSpot({ density: 200 }), 36,
    'a dense grid cell must not become a bottomless cold-planning destination');

const originalEnsureIndexed = SpotService.ensureIndexed;
SpotService.ensureIndexed = () => [
    {
        id: 'local_starter', name: 'Local Starter Field', minLevel: 1, maxLevel: 10, avgLevel: 5, density: 8,
        center: { locX: 2500, locY: 0, locZ: 0 }, npcNames: ['Keltir'], localStarterRegions: ['elf'], localUntilLevel: 20
    },
    {
        id: 'remote_starter', name: 'Remote Starter Field', minLevel: 1, maxLevel: 10, avgLevel: 5, density: 10,
        center: { locX: 2600, locY: 0, locZ: 0 }, npcNames: ['Keltir'], localStarterRegions: ['orc'], localUntilLevel: 20
    }
];
try {
    const routed = SpotService.findBestSpot({
        characterId: 77,
        level: 5,
        role: 'dps',
        classId: 19,
        starterRegion: 'elf',
        loc: { locX: 0, locY: 0, locZ: 0 }
    }, { minDensity: 1, minDistance: 1, maxDistance: 10000, occupancy: { local_starter: 1, remote_starter: 0 } });
    assert.strictEqual(routed.spot.id, 'local_starter',
        'SpotService ranking must retain LevelingRoutes locality and occupancy adjustments');
    assert.strictEqual(routed.localityPenalty, 0);

    const nestedRoleRoute = SpotService.findBestSpot({
        characterId: 78,
        level: 5,
        stats: { role: 'spoiler', classId: 55, starterRegion: 'elf' },
        loc: { locX: 0, locY: 0, locZ: 0 }
    }, { minDensity: 1, minDistance: 1, maxDistance: 10000 });
    assert.strictEqual(nestedRoleRoute.route.role, 'spoiler',
        'SpotService must preserve nested role and class metadata for route scoring');
} finally {
    SpotService.ensureIndexed = originalEnsureIndexed;
}

console.log('Bot leveling route checks passed');
