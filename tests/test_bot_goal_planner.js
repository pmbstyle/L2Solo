const assert = require('assert');

require('../src/Global');

const NeedsEvaluator = invoke('GameServer/Bot/Goals/NeedsEvaluator');
const GoalPlanner = invoke('GameServer/Bot/Goals/GoalPlanner');
const DataCache = invoke('GameServer/DataCache');

DataCache.init();

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

const expectedWeapon = invoke('GameServer/Bot/AI/BotGear').planFor({ classId: 0, level: 40 }).items.find((item) => Number(item.slot) === 7);
const equipmentGoal = GoalPlanner.plan(NeedsEvaluator.evaluate({
    ...base,
    stats: {
        classId: 0,
        build: { grade: 'c', classId: 0, level: 40 },
        equipment: [{ selfId: 999, slot: 7, rank: 'd', name: 'Old Weapon' }]
    }
}, { spot, now: timestamp }), timestamp);
assert.strictEqual(equipmentGoal.type, 'upgrade_gear');
assert.strictEqual(equipmentGoal.target.itemId, expectedWeapon.selfId);
assert.strictEqual(equipmentGoal.plan.expectedBenefit, 'adena_for_weapon_upgrade');

const noSnapshot = GoalPlanner.plan(NeedsEvaluator.evaluate({ ...base, stats: { classId: 0, build: { grade: 'c' } } }, { spot, now: timestamp }), timestamp);
assert.notStrictEqual(noSnapshot.type, 'upgrade_gear', 'missing equipment data must not invent a gear deficit');

const saleGoal = GoalPlanner.plan(NeedsEvaluator.evaluate({
    ...base,
    inventory: {
        1864: { selfId: 1864, name: 'Stem', amount: 12, kind: 'Other.Material' }
    }
}, { spot, now: timestamp }), timestamp);
assert.strictEqual(saleGoal.type, 'sell_inventory');
assert.strictEqual(saleGoal.plan.expectedBenefit, 'market_sale_inventory');

console.log('Bot goal planner checks passed');
