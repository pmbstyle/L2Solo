'use strict';
// The native-worker cases from gear acquisition, isolated from its large main
// assertion set so a snapshot/worker fault has a narrow regression boundary.
const assert = require('node:assert/strict');
const Packet = require('../src/GameServer/Bot/Economy/StatsPacket');
require('./helpers/databaseIsolation');
const isolated = require('./helpers/isolatedSocialDatabase')('static-gear-worker');
require('../src/Global');
isolated.assertConfigured(options.default);
const DataCache = invoke('GameServer/DataCache'); DataCache.init();
const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const BotGear = invoke('GameServer/Bot/AI/BotGear');
const BotLifeState = invoke('GameServer/Bot/Population/BotLifeState');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const NeedsEvaluator = invoke('GameServer/Bot/Goals/NeedsEvaluator');
const palusStarterInventory = BotLifeState.inventorySummaryFromItems(BotGear.planFor({ classId: 31, level: 1 }).items);
const inventory = { ...palusStarterInventory, 57: { selfId: 57, amount: 300000 } };
const affordableArmorState = { level: 25, adena: 300000,
    stats: { classId: 32, role: 'tank', equipment: BotLifeState.equipmentSummaryFromInventory(inventory) }, inventory };
const affordableArmorPlan = GearAcquisitionPlanner.planFor(affordableArmorState);
const nativeArmorState = { ...affordableArmorState, characterId: 71001, phase: 'cold',
    activity: 'hunting', updatedAt: 1000,
    vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 },
    stats: { ...affordableArmorState.stats, exp: DataCache.experience[24] + 1, equipmentPlan: affordableArmorPlan } };
const mage = { level: 40, stats: { classId: 10, role: 'mage' }, inventory: {} };
const target = GearAcquisitionPlanner.preferredTarget(mage);
const nativeMaterialState = { ...structuredClone(mage), characterId: 71002, adena: 100000,
    inventory: { 57: { selfId: 57, amount: 100000 } }, phase: 'cold', activity: 'hunting', updatedAt: 1000,
    vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 },
    stats: { ...mage.stats, exp: DataCache.experience[39] + 1, equipmentPlan: {
        status: 'active', strategy: 'craft', marketFallback: true, recipeId: target.recipe.recipeId,
        next: { itemId: 1869 }, materials: [{ selfId: 1869, missing: 4 }]
    } } };
const nativeGoalStates = [nativeArmorState, nativeMaterialState];
async function verifyWorkerSelectedGoals() {
    const { ColdEconomyDecisions, compact } = require('../src/GameServer/Bot/Population/ColdEconomyDecision');
    const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
    const build = Economy.forState;
    const Funding = invoke('GameServer/Bot/Economy/PurchaseFunding');
    invoke('GameServer/Bot/Economy/MarketCounters').useSpots(() => SpotProfiles.ensure());
    try {
        for (const input of nativeGoalStates) {
            const native = await require('./helpers/workerEconomyDecision')(input, { timestamp: 1000 });
            const state = { ...input, stats: { ...input.stats, ...native.statsPacket } };
            const decisions = new ColdEconomyDecisions();
            decisions.accept(state.characterId, native.decision);
            const leaf = compact(native.decision).activity;
            assert(leaf, 'the complete native state must produce a voluntary leaf');
            assert(native.queue.some(row => row.key === leaf.rootKey)
                || leaf.activity === 'hunting' && !leaf.funding && leaf.rootKey === `level:${state.level + 1}`,
                'paid roots belong to the native queue; free level progress is an explicit network root');
            assert(Number.isFinite(Packet.hourAdena(state.stats.money)) && Packet.hourAdena(state.stats.money) > 0,
                'native planning supplies a positive hour value, without a synthetic money packet');
            Economy.forState = () => { throw Error('cold goal reader rebuilt the wish network'); };
            const goals = NeedsEvaluator.evaluate(state, { now: 1000, decisions });
            assert.strictEqual(goals.length, leaf ? 1 : 0);
            if (leaf) {
                assert.strictEqual(goals[0].priority, 50);
                assert.strictEqual(goals[0].plan.wishKey, leaf.rootKey);
                assert.strictEqual(goals[0].plan.economyActivity, leaf.activity);
                if (leaf.activity === 'shopping') {
                    assert(Number.isFinite(leaf.price) && leaf.price > 0);
                    assert(Funding.spendable(state, 0, { itemId: leaf.itemId }) >= leaf.price,
                        'a selected purchase fits the actual packet and survival floor');
                    assert.strictEqual(goals[0].target.itemId, leaf.itemId);
                    assert.strictEqual(goals[0].target.amount, Math.max(1, Math.ceil(leaf.amount)));
                } else if (leaf.activity === 'hunting') {
                    assert.strictEqual(goals[0].type, leaf.funding ? 'earn_adena' : 'progress_level');
                    if (leaf.funding) assert(goals[0].target.adena > 0);
                    else assert.strictEqual(goals[0].target.level, state.level + 1);
                }
            }
            assert.deepStrictEqual(NeedsEvaluator.evaluate({ ...state, updatedAt: 1001 },
                { now: 1000, decisions }), [], 'a stale decision cannot drive an armour or material purchase');
            decisions.forget(state.characterId);
            Economy.forState = build;
        }
        console.log('Native worker armour/material goal checks passed');
    } finally { Economy.forState = build; }
}
verifyWorkerSelectedGoals().catch(error => { console.error(error); process.exitCode = 1; });
