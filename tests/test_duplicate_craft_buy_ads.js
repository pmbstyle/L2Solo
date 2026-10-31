'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Trade = invoke('GameServer/Bot/Economy/TradeIntent');
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const Warehouse = invoke('GameServer/Bot/Economy/PersonalWarehouseIndex');
const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const Pricing = invoke('GameServer/Bot/Economy/MarketPricing');
const Funding = invoke('GameServer/Bot/Economy/PurchaseFunding');
const BuyAds = invoke('GameServer/Bot/Economy/BuyAdPolicy');
const recipe = Recipes.resolveByRecipeId(424);
const part = recipe.materials.find(row => Number(row.selfId) !== Number(recipe.recipeItemId));
const original = { considerable: Planner.considerable, fulfilled: Planner.equipmentTargetFulfilled,
    bid: Pricing.bid, spendable: Funding.spendable };
const project = (target, next) => ({ status: 'deferred', reason: 'wish_focus', strategy: 'none',
    target: { selfId: target, slot: 12 }, recipeId: 424, materials: recipe.materials,
    craftProviders: { 424: { publicStation: true } }, heldInputs: {}, inputPreparation: next });
const state = { characterId: 993311, phase: 'cold', activity: 'hunting', level: 60, adena: 10000000,
    inventory: {}, stats: { money: [1000, .001, 0, 0], equipmentPlan: { status: 'active', strategy: 'direct_drop',
        target: { selfId: 76, slot: 7 }, inputPreparation: project(5726, project(5727, project(5728))) } } };
Warehouse.useRowSource(() => Warehouse.prepareRow([state.characterId, 1, []]), () => true);
Planner.considerable = () => true;
Planner.equipmentTargetFulfilled = () => false;
try {
    const network = { quantityPrepared: true, queue: [], moneyPrice: .001 };
    const physical = Trade.retainedProjectIntents(state, network, () => 100);
    assert.equal(physical.filter(row => row.itemId === part.selfId).length, 3,
        'separate saved projects really need the same recipe input');
    const projected = Trade.project(state, network, null, () => 100, 8);
    const selected = projected.filter(row => row.itemId === part.selfId);
    assert.equal(selected.length, 1, 'one item gets one physical buy order');
    assert.equal(selected[0].key, 'power:5726:12', 'the first retained project keeps its own consent');
    assert.equal(selected[0].amount, part.amount, 'do not combine independent projects into one certificate');
    assert.deepEqual(Trade.project(state, network, null, () => 100, 0), [], 'a zero publication limit remains empty');

    // Even a caller holding an older duplicate watch card must not send a
    // duplicate native batch; later distinct items still use available slots.
    const ids = [1864, 1865, 1866, 1867, 1868, 1869, 1870, 1871];
    const intent = (itemId, key) => ({ itemId, amount: 1, worth: 100, key,
        recipeId: 0, valueHours: 1, valueRate: 1 });
    const watch = [intent(ids[0], 'power:5726:12'), intent(ids[0], 'power:5727:12'),
        ...ids.slice(1).map((id, n) => intent(id, `resale:${id}`))];
    Pricing.bid = () => ({ price: 10, count: 1, purchaseCap: 10, pricing: { price: 10 } });
    Funding.spendable = () => 10000000;
    const trip = () => 0; trip.details = () => ({ known: true, hours: 0, fees: 0 });
    const economy = { moneyPrice: .001, hourAdena: 1000, worth: () => 100,
        trip, persona: { traits: {} }, network: { moneyPrice: .001 } };
    const bids = BuyAds.linesFor(state, null, { watchList: watch, economy, townFor: () => 'Giran',
        board: { ownerLines: () => [], list: () => [] }, npcOffersFor: () => [] });
    assert.deepEqual(bids.map(row => row.selfId), ids, 'duplicate goals cannot consume another item’s slot');
    assert.equal(bids[0].intent.key, 'power:5726:12');
    watch[0].valueHours = .01;
    Pricing.bid = (_id, _ctx, options) => options.worth < 100 ? null
        : { price: 10, count: 1, purchaseCap: 10, pricing: { price: 10 } };
    const fallback = BuyAds.linesFor(state, null, { watchList: watch, economy, townFor: () => 'Giran',
        board: { ownerLines: () => [], list: () => [] }, npcOffersFor: () => [] });
    assert.equal(fallback[0].intent.key, 'power:5727:12', 'another root can bid when the first cannot');
    assert.deepEqual(fallback.map(row => row.selfId), ids);
    console.log('PASS shared craft inputs produce one ordered, bounded buy bid without dropping other items');
} finally {
    Warehouse.useRowSource();
    Planner.considerable = original.considerable;
    Planner.equipmentTargetFulfilled = original.fulfilled;
    Pricing.bid = original.bid;
    Funding.spendable = original.spendable;
}
