const assert = require('assert');
require('../src/Global');
const DataCache = invoke('GameServer/DataCache');
const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const Recipes = invoke('GameServer/Items/C4RecipeItems');
DataCache.init();

async function run() {
    const now = 10000000;
    const plan = { status: 'active', strategy: 'craft', grade: 'b', recipeId: 902566,
        target: { selfId: 2566, slot: 14 }, next: { itemId: 75, npcId: 136 },
        materials: [{ selfId: 72, amount: 1, missing: 1 }, { selfId: 75, amount: 1, missing: 1 }] };
    const state = { characterId: 42, level: 53, phase: 'cold', activity: 'merchant', adena: 20000000,
        inventory: {}, stats: { classId: 34, role: 'buffer', equipmentPlan: plan,
            marketStore: { storeType: 3, expiresAt: now, items: [{ selfId: 75, count: 1 }] } } };
    const originalSave = LifeState.upsertState;
    LifeState.upsertState = async (value) => value;
    try {
        // The physical buy stall that abandoned the plan on expiry is gone
        // (step 3.3: a buy ad returns its escrow and the bot reviews again);
        // the planner's own abandonment stands for it here.
        const abandoned = Planner.abandonAcquisition(state, 75, now);
        assert.strictEqual(abandoned.stats.equipmentPlan.status, 'abandoned');
        const remembered = JSON.parse(JSON.stringify(abandoned));
        const context = Planner.replanContextFor(remembered, remembered.stats.equipmentPlan, now + 1);
        assert(context.excludedTargetIds.includes(2566));
        assert(context.excludedMaterialIds.includes(75));
        const alternative = Planner.preferredTarget(remembered, { ...context, findMarketOffer: () => null });
        assert(alternative, 'another dual-sword route should remain available');
        assert(!alternative.recipe.materials.some((item) => item.selfId === 75), 'changing the duals must not retain the failed blade');
        const idle = Planner.finalizePlan(remembered, remembered.stats.equipmentPlan,
            { status: 'complete', strategy: 'none' }, context, now + 2);
        assert(Planner.replanContextFor(remembered, idle, now + 3).excludedMaterialIds.includes(75),
            'an idle tick without alternatives must retain the failure memory');
        assert.strictEqual(Planner.replanContextFor(remembered, idle, now + 5 * 3600000).excludedMaterialIds.length, 0);
        const variants = new Set(Array.from({ length: 30 }, (_, i) => Planner.preferredTarget(
            { ...state, characterId: i + 1 }, { findMarketOffer: () => null })?.item.selfId));
        assert(variants.size > 1, 'comparable dual routes must not synchronize the whole population');
    } finally {
        LifeState.upsertState = originalSave;
    }

    assert.strictEqual(Planner.abandonAcquisition(state, 1869, now), state,
        'an unrelated shopping goal must not discard the equipment plan');
    const clanState = { ...state, stats: { ...state.stats,
        equipmentPlan: { ...plan, clanGoal: { clanId: 1, goalKey: 'assigned-weapon' } } } };
    assert.strictEqual(Planner.abandonAcquisition(clanState, 75, now), clanState,
        'an individual purchase timeout must not cancel a clan-owned objective');

    const stamped = Planner.finalizePlan(state, null, plan, {}, now);
    const stalled = Planner.replanContextFor(state, stamped, now + 5 * 3600000);
    assert.strictEqual(stalled.failure.reason, 'craft_stalled');
    assert(stalled.excludedMaterialIds.includes(75));
    const progressState = { ...state, inventory: { 75: { selfId: 75, amount: 1 } } };
    assert.strictEqual(Planner.replanContextFor(progressState, stamped, now + 5 * 3600000).failure, null,
        'actually acquiring a component must prevent a no-progress timeout');
    const refreshed = Planner.finalizePlan(progressState, stamped, plan, {}, now + 5 * 3600000);
    assert.strictEqual(refreshed.acquisitionProgress.at, now + 5 * 3600000);
    const cappedBaseline = Planner.finalizePlan(progressState, null, plan, {}, now);
    const excessState = { ...state, inventory: { 75: { selfId: 75, amount: 2 } } };
    assert.strictEqual(Planner.replanContextFor(excessState, cappedBaseline, now + 5 * 3600000).failure?.reason,
        'craft_stalled', 'extra copies beyond recipe needs must not hide a missing component');
    const acquiredPlan = { ...plan, next: { itemId: 75, amount: 1, requiredTotal: 1 } };
    assert.strictEqual(Planner.bestSourceForPlan(progressState, acquiredPlan, []), null,
        'an acquired ingredient must stop retaining its old farming route');
    const legacy = Planner.replanContextFor(state, plan, now + 5 * 3600000);
    assert.strictEqual(legacy.failure, null, 'legacy craft plans need a progress baseline first');

    // A ready intermediate recipe is cheaper than farming its rare full drop.
    const component = Recipes.resolveByProductId(75);
    assert(component, 'Caliburs must have a component recipe');
    const stocked = { ...state, inventory: Object.fromEntries(component.materials.map((m) => [m.selfId,
        { selfId: m.selfId, amount: m.amount }])) };
    const spots = [{ id: 'death-knight', avgLevel: 50, npcEntries: [{ selfId: 136, name: 'Death Knight', count: 8 }] }];
    const route = Planner.farmSourceForMaterial(75, stocked, spots, new Set([component.recipeId]));
    assert.strictEqual(route.effort, 8, 'a ready craft must beat a rare direct drop');
    assert(!route.spotId, 'ready ingredients must not send the bot to farm a finished blade');
    const missingRoutes = Planner.farmSourceForMaterial(75, state, [], new Set([component.recipeId]));
    assert.strictEqual(missingRoutes, null, 'a recipe with unavailable pieces is not an available route');
    const needs = invoke('GameServer/Bot/Goals/NeedsEvaluator');
    const nestedState = { ...state, activity: 'hunting', inventory: { 1869: { selfId: 1869, amount: 2 } },
        stats: { ...state.stats, equipmentPlan: { ...plan, marketFallback: true,
            next: { itemId: 1869, amount: 3, requiredTotal: 3 } } } };
    // The common economy now owns the missing quantity. The goal adapter
    // forwards its selected shopping leaf and resolves the displayed name.
    const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
    const originalContext = Economy.forState;
    let selected = { activity: 'shopping', itemId: 1869, amount: 1, price: 10, rootKey: 'ingredient' };
    Economy.forState = () => ({ network: { activity: selected, queue: [] } });
    try {
        const nestedGoal = needs.evaluate(nestedState, { now }).find((goal) => goal.type === 'buy_craft_material');
        assert.strictEqual(nestedGoal.target.itemId, 1869);
        assert.strictEqual(nestedGoal.target.amount, 1, 'shopping forwards the missing quantity from the economy');
        const ingredientName = DataCache.items.find((item) => Number(item.selfId) === 1869).template.name;
        assert.strictEqual(nestedGoal.target.itemName, ingredientName, 'a buy ad names the material, not its id (T25)');
        const noneHeld = { ...nestedState, inventory: {} };
        selected = { ...selected, amount: 3, price: 30 };
        const noneHeldGoal = needs.evaluate(noneHeld, { now }).find((goal) => goal.type === 'buy_craft_material');
        assert.strictEqual(noneHeldGoal.target.amount, 3);
        assert.strictEqual(noneHeldGoal.target.itemName, ingredientName,
            'a bot holding none of the material still names it (T25)');
        const named = { ...nestedState, inventory: { 1869: { selfId: 1869, amount: 2, name: 'Iron Ore' } } };
        assert.strictEqual(needs.evaluate(named, { now })[0].target.itemName, 'Iron Ore');
        selected = null;
        nestedState.inventory[1869].amount = 3;
        assert(!needs.evaluate(nestedState, { now }).some((goal) => goal.type === 'buy_craft_material'),
            'a completed ingredient without a shopping leaf must not create another WTB goal');
    } finally {
        Economy.forState = originalContext;
    }

    const disposition = invoke('GameServer/Bot/Economy/ItemDisposition');
    const reserves = disposition.reservedCraftAmounts(state);
    const edge = component.materials.find((material) => material.selfId === 2089);
    assert(edge, 'Caliburs recipe must require edges');
    assert.strictEqual(reserves[2089], edge.amount, 'the dual plan must reserve pieces of its missing blade');
    const ownedBladeReserves = disposition.reservedCraftAmounts(progressState);
    assert.strictEqual(ownedBladeReserves[2089] || 0, 0, 'an owned blade no longer needs its crafting pieces reserved');

    const originalRecipeLookup = Recipes.resolveByProductId;
    const ironSpots = [{ id: 'stone-golem', avgLevel: 19, npcEntries: [{ selfId: 16, name: 'Stone Golem', count: 8 }] }];
    let synthetic = { recipeId: 999001, productCount: 1, materials: [{ selfId: 1869, amount: 3 }] };
    Recipes.resolveByProductId = (id) => Number(id) === 999001 ? synthetic : null;
    try {
        const routeState = { ...state, level: 19, inventory: {} };
        const leaf = Planner.farmSourceForMaterial(999001, routeState, ironSpots, new Set([999001]));
        assert.strictEqual(leaf.itemId, 1869, 'nested craft routes must farm the ingredient, not the parent weapon');
        assert.strictEqual(leaf.requiredAmount, 3);
        synthetic = { ...synthetic, materials: [...synthetic.materials, { selfId: 999002, amount: 1 }] };
        assert.strictEqual(Planner.farmSourceForMaterial(999001, routeState, ironSpots, new Set([999001])), null,
            'one farmable ingredient must not hide another ingredient with no source');
    } finally {
        Recipes.resolveByProductId = originalRecipeLookup;
    }
    console.log('Bot acquisition recovery checks passed');
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
