'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
const Valuation = require('../src/GameServer/Bot/Economy/EconomicValuation');
const context = { moneyPrice: 0.001, itemUsefulness: () => 0.02, riskWeight: 1 };
const route = { known: true, hours: 0.1, fees: 5 };
const tiny = Valuation.acquisition(context, { selfId: 1835, units: 1, cost: 1 }, route);
assert(tiny.known && tiny.valueHours < 0, 'one unit cannot pay for a separate round trip');
const useful = Valuation.acquisition(context, { selfId: 1835, units: 100, cost: 100 }, route);
assert(useful.known && useful.valueHours > 0, 'an executable useful stack can justify the same trip');
assert.equal(useful.valueHours, 2 - 0.105 - 0.1);
assert.equal(useful.cashNow, 105, 'transport fees consume money once');
assert.equal(useful.cycleHours, 0.1);
assert(Valuation.acquisition(context, { selfId: 1835, units: 1, cost: 1 },
    { known: true, hours: 0, fees: 0 }).valueHours > 0, 'a local tiny purchase adds no journey');
for (const invalid of [{ known: false, hours: 0, fees: 0 },
    { known: true, hours: NaN, fees: 0 }, { known: true, hours: 0, fees: Infinity }]) {
    assert.equal(Valuation.acquisition(context, { selfId: 1835, units: 100, cost: 100 }, invalid).known, false);
}
assert.equal(Valuation.acquisition(context, { selfId: 1835, units: 0, cost: 0 }, route).known, false);

const Needs = invoke('GameServer/Bot/Goals/NeedsEvaluator');
const Floor = invoke('GameServer/Bot/Population/SurvivalFloor');
const originalFloor = Floor.forState;
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const originalReserve = Economy.survivalReserve;
try {
    Floor.forState = () => null;
    Economy.survivalReserve = () => 0;
    const leaf = { activity: 'shopping', itemId: 1835, amount: 10, valueHours: 1,
        price: 100, town: 'Giran', heldAtDecision: 0 };
    const remaining = Needs.evaluate({ characterId: 9911, inventory: { 1835: { amount: 2 } } },
        { errand: null, economy: { inputHash: 1, network: { activity: leaf } }, board: { heads: () => [] }, npcOffersFor: () => [] });
    assert.equal(remaining[0].target.amount, 8);
    assert.equal(remaining[0].plan.valueHours, 0.8, 'already acquired units cannot subsidise another trip for the remainder');
} finally { Floor.forState = originalFloor; Economy.survivalReserve = originalReserve; }

const Market = invoke('GameServer/Bot/Economy/ColdMarketService');
const Remote = invoke('GameServer/Bot/Economy/BotAfkMarketService');
const Trip = invoke('GameServer/Bot/Population/ColdTrip');
const GoalExecutor = invoke('GameServer/Bot/Goals/GoalExecutor');
const saved = { check: Market.canTravelForPurchase, remote: Remote.canTradeRemotely, trip: Trip.toTown };
const now = Date.now();
const errand = { selfId: 1835, amount: 100, town: 'Giran', purpose: 'shots', r: 0.02,
    survivalCost: 500, tag: [5], at: now };
const state = { characterId: 9911, activity: 'hunting', currentRegion: 'Field',
    loc: { locX: 20000, locY: 140000, locZ: -3000 }, stats: { marketErrand: errand } };
const goal = { type: 'market_errand', target: { itemId: 1835, amount: 100 },
    plan: { expectedBenefit: 'market_errand', marketTown: 'Giran', purpose: 'shots' } };
let checks = 0, travels = 0, allowed = false;
try {
    Remote.canTradeRemotely = () => false;
    Trip.toTown = () => { travels++; return { activity: 'traveling' }; };
    Market.canTravelForPurchase = (_state, request) => {
        checks++;
        assert.equal(request.selfId, 1835);
        assert.equal(request.amount, 100);
        assert.equal(request.town, 'Giran');
        assert.equal(request.r, 0.02);
        assert.equal(request.survivalCost, 500);
        assert.deepEqual(request.tag, [5], 'saved source and funding terms survive the execution gate');
        return allowed;
    };
    assert.equal(GoalExecutor.beginMarketTravel(state, goal, now), null);
    assert.equal(travels, 0, 'a refused purchase does not enter the travel owner');
    allowed = true;
    assert.equal(GoalExecutor.beginMarketTravel(state, goal, now).activity, 'traveling');
    assert.equal(travels, 1);
    assert.equal(GoalExecutor.beginMarketTravel({ ...state, activity: 'traveling' }, goal, now), null);
    assert.equal(checks, 2, 'the gate never reconsiders an already accepted journey');
    const sale = { type: 'sell_inventory', target: { cleanupReason: 'inventory_full' },
        plan: { expectedBenefit: 'market_sale_inventory', marketTown: 'Giran' } };
    assert.equal(GoalExecutor.beginMarketTravel(state, sale, now).activity, 'traveling');
    assert.equal(checks, 2, 'forced unloading keeps its existing independent owner');
} finally {
    Market.canTravelForPurchase = saved.check;
    Remote.canTradeRemotely = saved.remote;
    Trip.toTown = saved.trip;
}
console.log('Acquisition executable quantity, marginal journey, unknown route and cold travel gate: PASS');
