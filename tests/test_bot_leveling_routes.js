const assert = require('assert');

require('../src/Global');

const LevelingRoutes = invoke('GameServer/Bot/AI/LevelingRoutes');

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
assert.strictEqual(best.spot.id, 'cruma_construct', 'Scavengers should prefer construct spoil routes around Cruma levels');
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

assert.ok(LevelingRoutes.tagsForSpot(spots[0]).includes('undead'), 'undead tag should be inferred from mob names');
assert.ok(LevelingRoutes.tagsForSpot(spots[2]).includes('catacomb'), 'catacomb tag should be inferred from zone and mob names');

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

console.log('Bot leveling route checks passed');
