'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
const isolated = require('./helpers/isolatedSocialDatabase')('goal-planner-native');
require('../src/Global');
isolated.assertConfigured(options.default);
const Data = invoke('GameServer/DataCache');
Data.init();
invoke('GameServer/Bot/Economy/MarketCounters').useSpots(() => invoke('GameServer/Bot/Population/SpotProfiles').ensure());
const Needs = invoke('GameServer/Bot/Goals/NeedsEvaluator');
const Planner = invoke('GameServer/Bot/Goals/GoalPlanner');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Funding = invoke('GameServer/Bot/Economy/PurchaseFunding');
const Gear = invoke('GameServer/Bot/AI/BotGear');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Floor = invoke('GameServer/Bot/Population/SurvivalFloor');
const { compact, ColdEconomyDecisions } = require('../src/GameServer/Bot/Population/ColdEconomyDecision');
const timestamp = 1800000000000;
let nextId = 72000;
function fixture({ level = 40, classId = 0, adena = 8000, inventory, stats = {}, ...extra } = {}) {
    const bag = inventory || Life.inventorySummaryFromItems(Gear.planFor({ classId, level }).items);
    return { characterId: ++nextId, phase: 'hot', activity: 'hunting', updatedAt: timestamp,
        level, adena, currentRegion: 'Giran', loc: { locX: 80000, locY: 148000, locZ: -3500 },
        vitals: { hp: 900, maxHp: 1000, mp: 400, maxMp: 500 },
        inventory: { ...structuredClone(bag), 57: { selfId: 57, amount: adena } },
        stats: { classId, exp: Data.experience[level - 1] + 1, ...stats }, ...extra };
}
function checkLeaf(goals, leaf, label) {
    assert.equal(goals.length, leaf ? 1 : 0, `${label}: one decided voluntary leaf`);
    if (!leaf) return;
    const goal = goals[0];
    assert.equal(goal.priority, 50, `${label}: no gear/material/sale priority ladder`);
    assert.equal(goal.plan.wishKey, leaf.rootKey);
    assert.equal(goal.plan.economyActivity, leaf.activity);
    assert.equal(goal.plan.kind, leaf.activity === 'hunting' ? 'farm_route'
        : leaf.activity === 'selling' ? 'market_sell' : leaf.kind);
    if (leaf.activity === 'shopping') {
        const id = Number(leaf.itemId || (typeof leaf.object === 'number' ? leaf.object : leaf.object?.itemId));
        assert.equal(goal.target.itemId, id);
        assert.equal(goal.target.amount, Math.max(1, Math.ceil(leaf.amount || 1)));
        assert.equal(goal.plan.estimatedCost, leaf.price);
        assert.deepEqual(goal.blockers, []);
    } else if (leaf.activity === 'hunting') {
        assert.equal(goal.type, leaf.funding ? 'earn_adena' : 'progress_level');
        assert.equal(goal.plan.spotId, leaf.spotId);
        assert.equal(goal.plan.npcId, leaf.npcId);
    } else if (leaf.activity === 'selling') {
        assert.equal(goal.type, 'sell_inventory');
        assert.deepEqual(goal.target.itemIds, leaf.items || []);
    }
}
// ARCH-NOTE: E1/E3 fund the common native queue; C1 exposes its one chosen
// leaf. The old unconditional progress/4800-adena and81/88/87/78/89/86
// priorities bypassed this decision. Preserve each case with real game data,
// then test the independent packet/floor and native producer/goal contract.
function checkHot(label, state) {
    const before = structuredClone(state);
    const context = Economy.forState(state, { timestamp });
    const goals = Needs.evaluate(state, { now: timestamp, economy: context });
    checkLeaf(goals, context.network.activity, label);
    assert.deepEqual(state, before, `${label}: evaluating goals cannot spend or equip items`);
    const packet = context.statsPacket.money;
    assert(packet.every(Number.isFinite));
    assert(packet[0] >= 1 && packet[1] >= 1 / packet[0]);
    const fundedState = { ...state, stats: { ...state.stats, money: packet } };
    let cumulative = 0;
    for (let index = 4; index < packet.length; index += 3) {
        const ownPrice = packet[index + 1] - cumulative;
        assert(ownPrice > 0 && packet[index] >= packet[1]);
        assert(Funding.spendable(fundedState, 0, { r: packet[index] }) >= ownPrice,
            `${label}: every funded quote is admitted by the same payment rule`);
        cumulative = packet[index + 1];
    }
    const selected = Planner.plan(goals, timestamp);
    assert.equal(selected?.plan.wishKey || null, context.network.activity?.rootKey || null);
    if (context.network.activity?.funding) {
        assert.equal(selected.target.adena, context.network.gap.price,
            `${label}: earning targets the native gap, not a level-based wallet floor`);
    }
    return { state, context, goals };
}
const healthy = fixture();
checkHot('healthy', healthy);
checkHot('poor', fixture({ adena: 50 }));
const lowHp = fixture({ vitals: { hp: 200, maxHp: 1000, mp: 400, maxMp: 500 } });
// ARCH-NOTE: C1 defers voluntary cold goals without an accepted decision.
// Low HP alone does not create a new recovery heuristic in this task.
for (const state of [healthy, lowHp, fixture({ adena: 50 })]) {
    const cold = { ...state, phase: 'cold' };
    assert.deepEqual(Needs.evaluate(cold, { now: timestamp }), []);
    assert.equal(Planner.plan(Needs.evaluate(cold, { now: timestamp }), timestamp), null);
}
const dead = { ...healthy, phase: 'cold', activity: 'dead' };
// ARCH-NOTE: the native dead floor already returned revive at10083113;
// the old town_return expectation was stale. C1 preserves hard survival floors.
assert.equal(Floor.forState(dead, timestamp).action, 'revive');
assert.equal(Planner.plan(Needs.evaluate(dead, { now: timestamp }), timestamp).plan.kind, 'revive');

const nativeItem = id => Data.items.find(row => Number(row.selfId) === Number(id));
const dKit = Life.inventorySummaryFromItems(Gear.planFor({ classId: 0, level: 20 }).items);
checkHot('under-grade weapon', fixture({ inventory: dKit }));
checkHot('wealth investment after deaths', fixture({ adena: 1000000000, inventory: dKit,
    persona: { primaryDrive: 'wealth', traits: {} },
    stats: { deaths: 3, fightsResolved: 12, spotRisk: { deathsAtEntry: 1, fightsAtEntry: 2 } } }));
const withoutArmour = Object.fromEntries(Object.entries(dKit).filter(([, row]) => Number(row.slot) === 7));
checkHot('armour missing', fixture({ adena: 1000000, inventory: withoutArmour }));
for (const [label, slot] of [['NPC weapon', 7], ['NPC armour', 10], ['NPC jewellery', 1]]) {
    const item = Data.items.find(row => String(row.etc?.rank).toLowerCase() === 'd'
        && Number(row.etc?.slot) === slot && Number(row.template?.price) > 0);
    assert(item);
    const bag = Object.fromEntries(Object.entries(dKit).filter(([, row]) => Number(row.slot) !== slot));
    bag[1864] = { selfId: 1864, amount: 12, kind: 'Other.Material' };
    const state = fixture({ level: 20, adena: Number(item.template.price) + 1000000, inventory: bag,
        stats: { equipmentPlan: { status: 'active', strategy: 'market', partyNeedReason: 'npc_progression',
            target: { selfId: item.selfId, slot }, market: { town: 'Giran',
                price: Number(item.template.price), reserve: 50000, sourceType: 'npc' } } } });
    checkHot(label, state);
    if (slot === 1) checkHot('clan jewellery assignment', { ...state,
        stats: { ...state.stats, clanId: 77, equipmentPlan: { ...state.stats.equipmentPlan,
            clanGoal: { clanId: 77, goalKey: 'clan-equipment:77:1', priority: 'required' } } } });
}
const expectedCWeapon = Gear.planFor({ classId: 0, level: 40 }).items.find(row => Number(row.slot) === 7);
assert(expectedCWeapon && String(nativeItem(expectedCWeapon.selfId).etc.rank).toLowerCase() === 'c');
const cWeaponRecipe = Object.values(invoke('GameServer/Items/C4RecipeItems').loadRecipeItems())
    .find(recipe => Number(recipe.productId) === Number(expectedCWeapon.selfId) && recipe.type === 'dwarven');
assert(cWeaponRecipe, 'the authored C weapon has a native dwarven recipe');
for (const status of ['active', 'ready_to_craft', 'blocked']) {
    checkHot(`C crafting ${status}`, fixture({ inventory: dKit, adena: 1000000000,
        stats: { equipmentPlan: { status, strategy: 'craft', target: { selfId: expectedCWeapon.selfId, slot: 7 },
            recipeId: cWeaponRecipe.recipeId,
            materials: cWeaponRecipe.materials.map(material => ({ ...material, missing: material.amount })),
            next: null } } }));
}
checkHot('completed no-grade kit', fixture({ level: 14, classId: 53, adena: 1000000,
    stats: { equipmentPlan: { status: 'complete', reason: 'npc_adequate_kit', strategy: 'none' } } }));
const purchased = fixture({ adena: 1000000 });
const wornWeapon = Object.values(purchased.inventory).find(row => Number(row.slot) === 7);
assert(wornWeapon && nativeItem(wornWeapon.selfId));
purchased.stats.equipmentPlan = { status: 'active', strategy: 'market',
    target: { selfId: wornWeapon.selfId }, market: { town: 'Dion', price: 7 } };
const afterPurchase = checkHot('stale completed market target', purchased);
assert(!afterPurchase.goals.some(goal => goal.type === 'upgrade_gear'
    && goal.target.itemId === wornWeapon.selfId), 'a bought worn weapon is not a missing purchase');
const noSnapshot = fixture({ inventory: {}, stats: {} });
assert.deepEqual(Needs.evaluate({ ...noSnapshot, phase: 'cold' }, { now: timestamp }), [],
    'a missing cold equipment snapshot cannot invent a gear goal without a worker decision');
checkHot('starter below focus level', fixture({ level: 4 }));
for (const [label, adena, persona] of [['ordinary sale', 8000, {}],
    ['wealth sale', 8000, { primaryDrive: 'wealth', traits: {} }], ['poor seller', 50, {}]]) {
    const state = fixture({ adena, persona });
    state.inventory[1864] = { selfId: 1864, amount: 12, kind: 'Other.Material' };
    checkHot(label, state);
}

const candidate = (priority, blockers = [], nextReviewAt) => ({ type: 'test', priority,
    target: { priority }, plan: {}, blockers, ...(nextReviewAt ? { nextReviewAt } : {}) });
assert.equal(Planner.plan([], timestamp), null);
assert.equal(Planner.plan([candidate(20), candidate(90, ['blocked'])], timestamp).priority, 20);
assert.equal(Planner.plan([candidate(20), candidate(90, [], timestamp - 1)], timestamp).priority, 20);
assert.equal(Planner.plan([candidate(20), candidate(30)], timestamp).priority, 30);
assert.equal(Planner.plan([candidate(30)], timestamp).nextReviewAt, timestamp + 60000);

async function checkWorkerBoundary() {
    const input = { ...healthy, phase: 'cold' };
    const native = await require('./helpers/workerEconomyDecision')(input, { timestamp });
    const state = { ...input, stats: { ...input.stats, ...native.statsPacket } };
    const decisions = new ColdEconomyDecisions();
    decisions.accept(state.characterId, native.decision);
    const leaf = compact(native.decision).activity;
    const build = Economy.forState;
    try {
        Economy.forState = () => { throw Error('cold goal reader rebuilt the network'); };
        checkLeaf(Needs.evaluate(state, { now: timestamp, decisions }), leaf, 'actual worker');
        assert.deepEqual(Needs.evaluate({ ...state, updatedAt: timestamp + 1 },
            { now: timestamp, decisions }), [], 'changed checkpoint defers the stored leaf');
    } finally { Economy.forState = build; decisions.forget(state.characterId); }
    console.log('Native goal planner and worker boundary checks passed');
}
checkWorkerBoundary().catch(error => { console.error(error); process.exitCode = 1; });
