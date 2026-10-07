const assert = require('assert');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Gear = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const Policy = invoke('GameServer/Clan/ClanEquipmentPolicy');
const Planner = require('../src/GameServer/Clan/ClanEquipmentPlanner');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Database = invoke('Database');
const plan = { status: 'active', strategy: 'market', grade: 'b', target: { selfId: 72, slot: 7, name: 'Stormbringer' },
    combine: { type: 'dual_sword', resultId: 2566, requirements: [{ selfId: 72, amount: 1 }, { selfId: 75, amount: 1 }] },
    clanGoal: { clanId: 77, goalKey: 'clan-equipment:77:1:72:7' },
    rateModelVersion: Gear.RATE_MODEL_VERSION, rateProfileSignature: Gear.rateProfileSignature() };
const member = { characterId: 1, name: 'Buyer', phase: 'cold', level: 56,
    inventory: { 72: { selfId: 72, amount: 1, equipped: false, slot: 7 } }, stats: { equipmentPlan: plan } };
(async () => {
    assert.strictEqual(Gear.clanGoalPlanLocked(member, plan), false, 'owned component must unlock the next acquisition step');
    assert.strictEqual(Gear.clanGoalPlanLocked({ ...member, inventory: {} }, plan), true);
    const regular = { ...plan, combine: undefined };
    assert.strictEqual(Gear.clanGoalPlanLocked(member, regular), true, 'ordinary unequipped gear is not fulfilled');
    const goal = Policy.buildGoal({ id: 77 }, { member, plan }, null, 123);
    assert.deepStrictEqual(goal.target.componentRequirement, { resultId: 2566, amount: 1 });
    assert.strictEqual(Policy.targetFulfilled({ ...member, stats: {} }, JSON.parse(JSON.stringify(goal)), Gear.equippedSlotsFor), true,
        'completion remains recognizable after the beneficiary has replanned');
    const legacy = { ...goal, target: { ...goal.target, componentRequirement: undefined } };
    assert.strictEqual(Policy.targetFulfilled(member, legacy, Gear.equippedSlotsFor), true, 'existing saved goals can advance');
    assert.strictEqual(Policy.targetFulfilled({ ...member, stats: { clanEquipmentAcquisition: {
        goalKey: legacy.goalKey, itemId: 72, resultId: 2566, amount: 1
    } } }, legacy, Gear.equippedSlotsFor), true, 'legacy goal survives a beneficiary replan');
    const twoBlades = { ...goal, target: { ...goal.target, componentRequirement: { resultId: 2566, amount: 2 } } };
    assert.strictEqual(Policy.targetFulfilled(member, twoBlades, Gear.equippedSlotsFor), false);
    const original = Gear.planFor;
    let calls = 0;
    Gear.planFor = () => { calls++; return { ...plan, target: { selfId: 75, slot: 7 } }; };
    try {
        assert.strictEqual(Planner.planForMember(member).target.selfId, 75);
        assert.strictEqual(calls, 1, 'clan planner must not reuse the purchased market target');
    } finally { Gear.planFor = original; }
    const enqueue = Database.enqueueClanAction;
    const actions = [];
    Database.enqueueClanAction = async action => { actions.push(action); return action; };
    try {
        await Life.enqueueEquipmentGoalAdvanceForState(member);
        assert.strictEqual(actions.length, 1);
        assert.strictEqual(actions[0].actionType, 'goal_plan');
        assert.strictEqual(actions[0].payload.goalKey, plan.clanGoal.goalKey);
        await Life.enqueueEquipmentGoalAdvanceForState({ ...member, inventory: {} });
        assert.strictEqual(actions.length, 1, 'unbought component must not advance the goal');
    } finally { Database.enqueueClanAction = enqueue; }
    console.log('Clan component acquisition: owned blade unlocks planning, persists progress and queues goal advancement');
})().catch(error => { console.error(error); process.exitCode = 1; });
