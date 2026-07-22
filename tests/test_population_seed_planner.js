const assert = require('assert');

require('../src/Global');

const Planner = invoke('GameServer/Bot/Population/PopulationSeedPlanner');

const profiles = [
    { id: 'starter_a', minLevel: 1, avgLevel: 1 },
    { id: 'starter_b', minLevel: 1, avgLevel: 1 },
    { id: 'level_six', minLevel: 6, avgLevel: 6 },
    { id: 'level_twelve', minLevel: 12, avgLevel: 12 }
];

const initial = Planner.plan(profiles, [], 1700, 5);
assert.strictEqual(initial.averageLevel, 0);
assert.strictEqual(initial.maxMobLevel, 1);
assert.deepStrictEqual(initial.missing.map((spot) => spot.id), ['starter_a', 'starter_a', 'starter_a', 'starter_b', 'starter_b'],
    'first start must cover every level-one starter sector and reach the planned starter population');
assert.strictEqual(Planner.seedBatchSize(initial, 2), 5,
    'the first wave must not be split by the normal seed batch limit');

const progressed = Planner.plan(profiles, [
    { characterId: 1, level: 5, spotId: 'moved_on', activity: 'hunting', stats: { populationWave: 1 } },
    { characterId: 2, level: 70, spotId: null, activity: 'crafting' }
], 1700, 5);
assert.strictEqual(progressed.averageLevel, 5, 'craft services must not accelerate population waves');
assert.strictEqual(progressed.maxMobLevel, 6);
assert.deepStrictEqual(progressed.missing.map((spot) => spot.id), ['starter_a', 'starter_a', 'starter_a', 'starter_b', 'starter_b', 'level_six'],
    'at average level 5 the vacated starter grounds are refilled and the next band opens');
assert.strictEqual(Planner.seedBatchSize(progressed, 2), 2,
    'later waves must still respect the normal seed batch limit');

const capped = Planner.plan(profiles, [
    { characterId: 1, level: 20, spotId: 'moved_a', activity: 'hunting', stats: { populationWave: 1 } },
    { characterId: 2, level: 20, spotId: 'moved_b', activity: 'hunting', stats: { populationWave: 1 } }
], 2, 5);
assert.strictEqual(capped.missing.length, 0, 'the hard population cap must prevent any additional adventurer');

console.log('Population seed planner checks passed');
