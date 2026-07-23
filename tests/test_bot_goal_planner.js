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

const expectedChest = invoke('GameServer/Bot/AI/BotGear').planFor({ classId: 0, level: 40 }).items.find((item) => Number(item.slot) === 10);
const expectedChestPrice = Number((DataCache.items || []).find((item) => Number(item.selfId) === Number(expectedChest.selfId))?.template?.price || 0);
const armorGoal = GoalPlanner.plan(NeedsEvaluator.evaluate({
    ...base,
    adena: 1000000,
    stats: {
        classId: 0,
        build: { grade: 'c', classId: 0, level: 40 },
        equipment: [{ selfId: expectedWeapon.selfId, slot: 7, rank: 'c', name: expectedWeapon.name }]
    }
}, { spot, now: timestamp }), timestamp);
assert.strictEqual(armorGoal.type, 'upgrade_gear');
assert.strictEqual(armorGoal.target.equipmentSlot, 'chest');
assert.strictEqual(armorGoal.target.itemId, expectedChest.selfId);
assert.strictEqual(armorGoal.plan.expectedBenefit, 'market_search_for_gear');

const staleMarketPlanGoal = GoalPlanner.plan(NeedsEvaluator.evaluate({
    ...base,
    adena: 1000000,
    stats: {
        classId: 0,
        build: { grade: 'c', classId: 0, level: 40 },
        // The weapon was just purchased. The resolver has not rebuilt the
        // equipment plan yet, so the next goal must use the chest's own
        // template data instead of the completed weapon offer.
        equipment: [{ selfId: expectedWeapon.selfId, slot: 7, rank: 'c', name: expectedWeapon.name }],
        equipmentPlan: {
            status: 'active',
            strategy: 'market',
            target: { selfId: expectedWeapon.selfId },
            market: { town: 'Dion', price: 7 }
        }
    }
}, { spot, now: timestamp }), timestamp);
assert.strictEqual(staleMarketPlanGoal.target.itemId, expectedChest.selfId, 'the next build slot must replace a completed market target');
assert.strictEqual(staleMarketPlanGoal.target.adena, expectedChestPrice, 'the next item must use its own price rather than the completed offer');
assert.strictEqual(staleMarketPlanGoal.plan.marketTown, null, 'the next item must be replanned before choosing a market town');

const noSnapshot = GoalPlanner.plan(NeedsEvaluator.evaluate({ ...base, stats: { classId: 0, build: { grade: 'c' } } }, { spot, now: timestamp }), timestamp);
assert.notStrictEqual(noSnapshot.type, 'upgrade_gear', 'missing equipment data must not invent a gear deficit');

const preFocusGoal = GoalPlanner.plan(NeedsEvaluator.evaluate({
    ...base,
    level: 4,
    stats: {
        classId: 0,
        build: { grade: 'none', classId: 0, level: 4 },
        equipment: []
    }
}, { spot, now: timestamp }), timestamp);
assert.strictEqual(preFocusGoal.type, 'progress_level', 'bots below level five must not abandon starter leveling for equipment goals');

const saleGoal = GoalPlanner.plan(NeedsEvaluator.evaluate({
    ...base,
    inventory: {
        1864: { selfId: 1864, name: 'Stem', amount: 12, kind: 'Other.Material' }
    }
}, { spot, now: timestamp }), timestamp);
assert.strictEqual(saleGoal.type, 'sell_inventory');
assert.strictEqual(saleGoal.plan.expectedBenefit, 'market_sale_inventory');

const poorSellerGoal = GoalPlanner.plan(NeedsEvaluator.evaluate({
    ...base,
    adena: 50,
    inventory: {
        1864: { selfId: 1864, name: 'Stem', amount: 12, kind: 'Other.Material' }
    }
}, { spot, now: timestamp }), timestamp);
assert.strictEqual(poorSellerGoal.type, 'sell_inventory', 'valuable surplus should fund progress before another low-adena farm loop');

console.log('Bot goal planner checks passed');
