const assert = require('assert');

require('../src/Global');

const Planner = invoke('GameServer/Bot/Population/PopulationSeedPlanner');
const GeneratedColdSeeder = invoke('GameServer/Bot/Population/GeneratedColdSeeder');

const profiles = Planner.STARTER_REGIONS.map((region) => ({
    id: `starter_${region.id}`,
    minLevel: 1,
    avgLevel: 1,
    center: { ...region.center }
}));

const initial = Planner.plan(profiles, [], 1700, 30);
assert.strictEqual(initial.averageLevel, 0);
assert.strictEqual(initial.wave, 1);
assert.strictEqual(initial.missing.length, 150, 'first start must create 30 bots at each of five racial spawns');
assert.deepStrictEqual(
    initial.missing.reduce((counts, spot) => ({ ...counts, [spot.starterRegion]: (counts[spot.starterRegion] || 0) + 1 }), {}),
    { human: 30, elf: 30, dark_elf: 30, orc: 30, dwarf: 30 },
    'the first wave must be balanced between racial spawn regions'
);
assert.strictEqual(Planner.seedBatchSize(initial, 2), 150,
    'the first wave must not be split by the normal seed batch limit');

const legacyPopulation = Planner.plan(profiles, Array.from({ length: 132 }, (_, index) => ({
    characterId: index + 1,
    level: 16,
    spotId: `legacy_${index}`,
    activity: 'hunting',
    stats: {}
})), 1700, 30);
assert.strictEqual(legacyPopulation.missing.length, 150,
    'legacy bots must not replace any member of the first 30-per-race cohort');

const regionalSlots = Planner.starterSlots([
    ...profiles,
    { id: 'remote_starter', minLevel: 1, avgLevel: 1, center: { locX: 0, locY: 0 } }
], 30, 1);
regionalSlots.forEach((spot) => {
    const region = Planner.STARTER_REGIONS.find((entry) => entry.id === spot.starterRegion);
    const dx = spot.center.locX - region.center.locX;
    const dy = spot.center.locY - region.center.locY;
    assert.ok((dx * dx) + (dy * dy) <= region.radius * region.radius,
        `${spot.starterRegion} slots must remain inside their racial starter region`);
});

const progressed = Planner.plan(profiles, [
    ...initial.missing.map((spot, index) => ({
        characterId: index + 1,
        level: 5,
        spotId: `moved_on_${index}`,
        activity: 'hunting',
        stats: { populationWave: 1 }
    })),
    { characterId: 2, level: 70, spotId: null, activity: 'crafting' }
], 1700, 30);
assert.strictEqual(progressed.averageLevel, 5, 'craft services must not accelerate population waves');
assert.strictEqual(progressed.wave, 2);
assert.strictEqual(progressed.targetPopulation, 300);
assert.strictEqual(progressed.missing.length, 150,
    'at average level 5 exactly one additional 150-bot starter cohort opens');
assert.strictEqual(Planner.seedBatchSize(progressed, 2), 150,
    'a later 150-bot cohort must not be split by the normal seed batch limit');

const capped = Planner.plan(profiles, [
    ...Array.from({ length: 1690 }, (_, index) => ({
        characterId: index + 1,
        level: 55,
        spotId: `moved_${index}`,
        activity: 'hunting',
        stats: { populationWave: 11 }
    }))
], 1700, 30);
assert.strictEqual(capped.missing.length, 10, 'the final partial wave must stop exactly at the hard population cap');

const generatedName = GeneratedColdSeeder.nameFor(Date.now());
assert.ok(generatedName.length <= 16, 'timestamp-based population slots must fit the character-name column');

console.log('Population seed planner checks passed');
