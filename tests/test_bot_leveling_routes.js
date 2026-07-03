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

console.log('Bot leveling route checks passed');
