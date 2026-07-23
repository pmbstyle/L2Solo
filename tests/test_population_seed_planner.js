const assert = require('assert');

require('../src/Global');

const Planner = invoke('GameServer/Bot/Population/PopulationSeedPlanner');
const GeneratedColdSeeder = invoke('GameServer/Bot/Population/GeneratedColdSeeder');
const BotPopulation = invoke('GameServer/Bot/BotPopulation');

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
assert.strictEqual(Planner.waveLevelThreshold(1), 5, 'x1 must open the next wave at level 5');
assert.strictEqual(Planner.waveLevelThreshold(10), 5, 'x10 must retain the level-5 wave threshold');
assert.strictEqual(Planner.waveLevelThreshold(50), 10, 'x50 must defer the next wave to level 10');
assert.strictEqual(Planner.waveLevelThreshold(100), 10, 'rates above x50 must retain the level-10 wave threshold');

const starterRaces = { human: 0, elf: 1, dark_elf: 2, orc: 3, dwarf: 4 };
Object.entries(starterRaces).forEach(([starterRegion, race]) => {
    Array.from({ length: 20 }, (_, index) => index).forEach((index) => {
        assert.strictEqual(GeneratedColdSeeder.baseForIndex(index, starterRegion).race, race,
            `${starterRegion} population slots must use only that race`);
    });
});

const staticStarterRaces = {
    'Talking Island': 0,
    'Elven Village': 1,
    'Dark Elven Village': 2,
    'Orc Village': 3,
    'Dwarven Village': 4
};
BotPopulation.buildStarterBots()
    .filter((bot) => Object.hasOwn(staticStarterRaces, bot.homeRegion))
    .forEach((bot) => {
        assert.strictEqual(bot.race, staticStarterRaces[bot.homeRegion],
            `${bot.homeRegion} static starter cohort must use the local race`);
    });

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
        stats: { populationWave: 1, starterRegion: spot.starterRegion }
    })),
    { characterId: 2, level: 70, spotId: null, activity: 'crafting' }
], 1700, 30, { progressionMultiplier: 1 });
assert.strictEqual(progressed.averageLevel, 5, 'craft services must not accelerate population waves');
assert.strictEqual(progressed.wave, 2);
assert.strictEqual(progressed.targetPopulation, 300);
assert.strictEqual(progressed.missing.length, 150,
    'at average level 5 exactly one additional 150-bot starter cohort opens');
assert.strictEqual(Planner.seedBatchSize(progressed, 2), 150,
    'a later 150-bot cohort must not be split by the normal seed batch limit');

const highRateNotReady = Planner.plan(profiles, initial.missing.map((spot, index) => ({
    characterId: index + 1,
    level: 5,
    spotId: `high_rate_${index}`,
    activity: 'hunting',
    stats: { populationWave: 1, starterRegion: spot.starterRegion }
})), 1700, 30, { progressionMultiplier: 50 });
assert.strictEqual(highRateNotReady.levelThreshold, 10);
assert.strictEqual(highRateNotReady.wave, 1, 'x50 must not open the second wave at level 5');
assert.strictEqual(highRateNotReady.missing.length, 0, 'x50 must wait for the first cohort to reach level 10');

const highRateProgressed = Planner.plan(profiles, initial.missing.map((spot, index) => ({
    characterId: index + 1,
    level: 10,
    spotId: `high_rate_${index}`,
    activity: 'hunting',
    stats: { populationWave: 1, starterRegion: spot.starterRegion }
})), 1700, 30, { progressionMultiplier: 50 });
assert.strictEqual(highRateProgressed.wave, 2, 'x50 must open the second wave at level 10');
assert.strictEqual(highRateProgressed.missing.length, 150, 'x50 level-10 progress must add one full cohort');

const merchantBackfill = Planner.plan(profiles, initial.missing.map((spot, index) => ({
    characterId: index + 1,
    level: 2,
    spotId: spot.id,
    activity: spot.starterRegion === 'human' && index < 10 ? 'merchant' : 'hunting',
    stats: { populationWave: 1, starterRegion: spot.starterRegion }
})), 1700, 30);
assert.strictEqual(merchantBackfill.missing.length, 2, 'merchant departures must only backfill their own racial cohort');
assert(merchantBackfill.missing.every((spot) => spot.starterRegion === 'human'), 'racial backfill must not drift into another starter region');

const merchantCapped = Planner.plan(profiles, Array.from({ length: 1700 }, (_, index) => ({
    characterId: index + 1,
    level: 12,
    spotId: `merchant_cap_${index}`,
    activity: index < 150 ? 'merchant' : 'hunting',
    stats: { populationWave: 1, starterRegion: index < 150 ? 'human' : 'elf' }
})), 1700, 30);
assert.strictEqual(merchantCapped.playingPopulation, 1550,
    'merchant states must remain outside the hunting population used for wave pacing');
assert.strictEqual(merchantCapped.population, 1700,
    'the global cap must include generated merchants');
assert.strictEqual(merchantCapped.missing.length, 0,
    'no replacement may be created once all generated bot slots are occupied by hunters or merchants');

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

const generatedNames = Array.from({ length: 5000 }, (_, index) => GeneratedColdSeeder.nameFor(Date.now() + index));
assert.ok(generatedNames.every((name) => name.length >= 3 && name.length <= 16), 'generated names must fit the character-name column');
assert.ok(generatedNames.every((name) => /^[A-Za-z]+$/.test(name)), 'generated names must remain client-safe alphabetic nicknames');
assert.ok(new Set(generatedNames).size > 4500, 'the local nickname corpus must provide a varied population');
assert.ok(generatedNames.every((name) => !/[0-9]/.test(name)), 'ordinary generated names must not expose population counters');

console.log('Population seed planner checks passed');
