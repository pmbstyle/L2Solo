const assert = require('assert');

require('../src/Global');

const NeedsEvaluator = invoke('GameServer/Bot/Goals/NeedsEvaluator');
const GoalPlanner = invoke('GameServer/Bot/Goals/GoalPlanner');

const spot = { id: 'cruma', risk: 2, route: { id: 'cruma_construct_spoil' } };
const base = {
    characterId: 7,
    phase: 'cold',
    level: 40,
    adena: 8000,
    vitals: { hp: 900, maxHp: 1000, mp: 400, maxMp: 500 },
    party: {},
    stats: {}
};

const timestamp = 100000;
const healthy = GoalPlanner.plan(NeedsEvaluator.evaluate(base, { spot, now: timestamp }), timestamp);
assert.strictEqual(healthy.type, 'progress_level');
assert.strictEqual(healthy.plan.spotId, 'cruma');

const poor = GoalPlanner.plan(NeedsEvaluator.evaluate({ ...base, adena: 50 }, { spot, now: timestamp }), timestamp);
assert.strictEqual(poor.type, 'earn_adena');
assert.strictEqual(poor.target.adena, 4800);

const resting = GoalPlanner.plan(NeedsEvaluator.evaluate({
    ...base,
    vitals: { hp: 200, maxHp: 1000, mp: 400, maxMp: 500 }
}, { spot, now: timestamp }), timestamp);
assert.strictEqual(resting.type, 'recover');
assert.strictEqual(resting.plan.kind, 'rest');

const dead = GoalPlanner.plan(NeedsEvaluator.evaluate({ ...base, activity: 'dead' }, { spot, now: timestamp }), timestamp);
assert.strictEqual(dead.plan.kind, 'town_return');

console.log('Bot goal planner checks passed');
