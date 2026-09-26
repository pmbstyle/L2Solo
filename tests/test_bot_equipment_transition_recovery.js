const assert = require('assert');
require('../src/Global');
const Data = invoke('GameServer/DataCache');
Data.init();
const Gear = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const Spots = invoke('GameServer/Bot/Population/SpotProfiles');
const Craft = invoke('GameServer/Bot/Economy/ColdCraftingService');
const ClanCrafting = invoke('GameServer/Clan/ClanCraftingPolicy');
const item = (id) => Data.items.find(entry => Number(entry.selfId) === id);
function inventory(entries) {
    return Object.fromEntries(entries.map(([selfId, slots]) => [selfId, {
        selfId, amount: slots.length, equipped: true, equippedSlots: slots, slot: slots[0]
    }]));
}
const heavy = [[47, [6]], [58, [10]], [59, [11]], [606, [9]], [850, [1, 2]],
    [881, [4, 5]], [913, [3]], [1124, [12]]];
const at = 1800000000000;
const oldPlan = { status: 'active', strategy: 'direct_drop', grade: 'c',
    target: { selfId: 84, slot: 7 }, next: { npcId: 136, itemId: 84 },
    startedAt: at - 600000, targetProgress: { npcId: 136, resolves: 0, targetKills: 0 } };
const failed = { level: 55, stats: { classId: 30, role: 'healer', targetCombat: {
    populationTargets: { 136: { resolves: 20, targetKills: 0 } }
} }, inventory: {} };
const context = Gear.replanContextFor(failed, oldPlan, at);
assert.strictEqual(context.failure?.reason, 'combat_unviable',
    'crossing C to B must not disable failure detection for a retained C route');
assert.strictEqual(Gear.replanContextFor({ ...failed, level: 40 },
    { ...oldPlan, grade: 'd' }, at).failure?.reason, 'combat_unviable',
    'crossing D to C must retain the old route failure too');
const cooldown = { ...oldPlan, status: 'complete', recoveryTargets: context.recoveryTargets };
assert(context.recoveryTargets.some(entry => entry.targetId === 84));
assert(Gear.replanContextFor({ ...failed, level: 61 }, cooldown, at + 1).excludedTargetIds.includes(84),
    'the same route cooldown must survive another grade transition');
assert(!Gear.replanContextFor(failed, cooldown, at + 7200000).excludedTargetIds.includes(84),
    'expired route cooldowns must still clear');

const caster = { level: 56, adena: 11564058, stats: { classId: 51, role: 'buffer' },
    inventory: inventory([...heavy, [156, [7]]]) };
assert.strictEqual(Gear.combatReadiness(caster).hasWeapon, false,
    'a physical Hand Axe must not satisfy an Overlord caster weapon requirement');
const casterBridge = Gear.npcWeaponBridgePlan(caster);
assert.strictEqual(casterBridge?.weaponBridge, true);
assert.strictEqual(casterBridge.target.selfId, 178);
const robeState = { ...caster, inventory: inventory([...heavy, [178, [14]]]) };
assert.strictEqual(Gear.staticNpcKitAdequate(robeState), false,
    'old heavy armor must not satisfy the current robe profile');
assert.strictEqual(item(Gear.staticNpcUpgradePlan(robeState).target.selfId).template.kind, 'Armor.Fabric');
const oldFarm = { ...oldPlan, target: { selfId: 195, slot: 14 }, next: { npcId: 685, itemId: 195 } };
assert.strictEqual(item(Gear.replacementPlanFor(robeState, oldFarm, Spots.ensure()).target.selfId).template.kind, 'Armor.Fabric',
    'an available old farming source must not suppress the class armor bridge');

const dual = { characterId: 123, level: 59, adena: 6330530,
    stats: { classId: 34, role: 'buffer', clanId: 7 }, inventory: inventory([...heavy, [127, [7]]]) };
const spots = Spots.ensure();
const occupancy = Spots.occupancySnapshot(spots, [dual]);
const forced = Gear.planFor(dual, { spots, occupancy, clanCrafting: true, recipeId: 902551 });
assert.strictEqual(forced.strategy, 'market',
    'live availability must consider buying the missing blade before rejecting its recipe');
assert.strictEqual(forced.target.selfId, 127);
assert.strictEqual(forced.combine.resultId, 2551);
const bridge = Gear.npcWeaponBridgePlan(dual);
assert(bridge?.weaponBridge && bridge.combine, 'a clan member lacking duals needs an affordable blacksmith bridge');
assert.strictEqual(item(bridge.combine.resultId).etc.rank, 'c');
assert(bridge.market.price + bridge.market.reserve <= dual.adena);
assert.strictEqual(Gear.planFor(dual, { spots, occupancy }).combine.resultId, bridge.combine.resultId,
    'normal planning at B grade must recover a usable C bridge');
for (const classId of [2, 34]) {
    for (const level of [40, 52, 61]) {
        const transition = { ...dual, level, stats: { ...dual.stats, classId } };
        const transitionBridge = Gear.npcWeaponBridgePlan(transition);
        assert.strictEqual(item(transitionBridge.combine.resultId).etc.rank, 'c',
            `class ${classId} at level ${level} must select a funded C dual bridge`);
    }
}
const bought = structuredClone(dual);
for (const requirement of bridge.combine.requirements) {
    bought.inventory[requirement.selfId] = { ...(bought.inventory[requirement.selfId] || {}),
        selfId: requirement.selfId, amount: requirement.amount };
}
bought.stats.equipmentPlan = bridge;
const ready = Gear.npcWeaponBridgePlan(bought);
assert.strictEqual(ready.status, 'ready_to_craft');
assert.strictEqual(ready.combine.resultId, bridge.combine.resultId,
    'buying a blade must preserve the selected combination through assembly');
const Membership = invoke('GameServer/Clan/ClanMembershipPolicy');
assert.strictEqual(Membership.reconcileState({ ...bought, stats: { ...bought.stats, equipmentPlan: ready } }, 7).stats.equipmentPlan, ready,
    'membership reconciliation must preserve a personal NPC exchange');
const Needs = invoke('GameServer/Bot/Goals/NeedsEvaluator');
const goals = Needs.evaluate({ ...dual, vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
    stats: { ...dual.stats, equipmentPlan: forced, equipment: [{ selfId: 127, slot: 7, rank: 'd' }] } }, { now: at });
assert(goals.some(goal => goal.type === 'upgrade_gear' && goal.target.itemId === 127),
    'an equipped first blade must not hide the market goal for a second copy');
assert.deepStrictEqual(goals.find(goal => goal.type === 'upgrade_gear').blockers, [],
    'a funded concrete blade purchase must not require a farming spot');
const unfundedGoals = Needs.evaluate({ ...dual, adena: 0,
    vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
    stats: { ...dual.stats, equipmentPlan: forced, equipment: [{ selfId: 127, slot: 7, rank: 'd' }] }
}, { now: at });
assert.deepStrictEqual(unfundedGoals.find(goal => goal.type === 'upgrade_gear').blockers, ['missing_spot'],
    'earning the purchase budget must still require a farming spot');
const finalized = Gear.finalizePlan(bought, bridge, ready, {}, at);
assert.strictEqual(finalized.status, 'ready_to_craft', 'clan membership must not suppress an NPC blacksmith exchange');
bought.stats.equipmentPlan = finalized;
assert.strictEqual(ClanCrafting.isPersonalCraft(bought), false);
assert.strictEqual(Craft.beginTravel(bought, at)?.stats.travel.reason, 'dual_sword_combine');
assert.strictEqual(ClanCrafting.isPersonalCraft({ stats: { clanId: 7 } }, {
    strategy: 'craft', recipeId: 220
}), true, 'ordinary personal dwarven crafting remains clan-managed');
assert.strictEqual(Gear.npcWeaponBridgePlan({ ...dual, inventory: inventory([...heavy, [2551, [14]]]) }), null,
    'a usable lower-grade dual must not trigger repeated bridge purchases');
console.log('Bot equipment transition recovery checks passed');

async function verifyOrphanedMarketRecovery() {
    const Market = invoke('GameServer/Bot/Economy/ColdMarketListingService');
    const Life = invoke('GameServer/Bot/Population/BotLifeState');
    const original = Life.upsertState;
    try {
        Life.upsertState = async state => state;
        const stranded = { characterId: 321, activity: 'merchant', stats: { equipmentPlan: casterBridge } };
        const recovered = await Market.resolve(stranded, at);
        assert.strictEqual(recovered.state.activity, 'hunting');
        assert.strictEqual(recovered.state.stats.equipmentPlan, casterBridge);
        assert.strictEqual(recovered.state.timing.nextResolveAt, at);
        const service = { ...stranded, staticService: true };
        assert.strictEqual((await Market.resolve(service, at)).state, service,
            'permanent merchants must never be released as orphaned adventurers');
        Life.upsertState = async () => null;
        assert.strictEqual((await Market.resolve(stranded, at)).state, stranded,
            'a rejected state commit must not report a successful market recovery');
        console.log('Orphaned equipment buyer recovery checks passed');
    } finally { Life.upsertState = original; }
}
verifyOrphanedMarketRecovery().catch(error => { console.error(error); process.exitCode = 1; });
