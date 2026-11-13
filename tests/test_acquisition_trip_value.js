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
// One look a visit: the visit's steps in one town pay its one trip together.
const step = (amount, valueHours) => ({ itemId: 1835, amount, unitPrice: 1, valueHours });
assert.equal(Valuation.visitPays(context, [step(1, 0.02)], route), false, 'one unit alone does not pay the road');
assert.equal(Valuation.visitPays(context, [step(1, 0.02), step(100, 2)], route), true, 'the visit\'s other steps carry it');
assert.equal(Valuation.visitPays(context, [step(1, 0.02)], { known: true, hours: 0, fees: 0 }), true, 'in town it costs no road');
// A required purchase's road (hot and cold alike): its share of the whole need still to buy.
const kitUnit = { selfId: 1835, units: 1, amount: 1, cost: 1000 };
assert.equal(Valuation.tripPays(context, kitUnit, route, { required: true, valueHours: 0.05 }), true, 'the whole need carries its road');
assert.equal(Valuation.tripPays(context, kitUnit, route, { required: true, valueHours: 0.05, wanted: 10 }), false,
    'a tenth of the need does not, as a visit\'s step of it would not');
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
const originalReserve = Economy.refillReserve;
try {
    Floor.forState = () => null;
    Economy.refillReserve = () => 0;
    const leaf = { activity: 'shopping', itemId: 1835, amount: 10, valueHours: 1,
        price: 100, town: 'Giran', heldAtDecision: 0 };
    const remaining = Needs.evaluate({ characterId: 9911, inventory: { 1835: { amount: 2 } } },
        { errand: null, economy: { inputHash: 1, network: { activity: leaf } }, board: { heads: () => [] }, npcOffersFor: () => [] });
    assert.equal(remaining[0].target.amount, 8, 'already acquired units leave the remainder to buy');
} finally { Floor.forState = originalFloor; Economy.refillReserve = originalReserve; }

const Remote = invoke('GameServer/Bot/Economy/BotAfkMarketService');
const Trip = invoke('GameServer/Bot/Population/ColdTrip');
const GoalExecutor = invoke('GameServer/Bot/Goals/GoalExecutor');
const saved = { remote: Remote.canTradeRemotely, trip: Trip.toTown };
const now = Date.now();
const errand = { selfId: 1835, amount: 100, town: 'Giran', purpose: 'shots', r: 0.02,
    survivalCost: 500, tag: [5], at: now };
const state = { characterId: 9911, activity: 'hunting', currentRegion: 'Field',
    loc: { locX: 20000, locY: 140000, locZ: -3000 }, stats: { marketErrand: errand } };
const goal = { type: 'market_errand', target: { itemId: 1835, amount: 100 },
    plan: { expectedBenefit: 'market_errand', marketTown: 'Giran', purpose: 'shots' } };
let travels = 0;
try {
    Remote.canTradeRemotely = () => false;
    Trip.toTown = () => { travels++; return { activity: 'traveling' }; };
    // An errand's road was weighed when it was taken (ColdMarketService.acquire), a plan
    // step's by its build (visitPays): the trip goes as decided, the market is read there.
    assert.equal(GoalExecutor.beginMarketTravel(state, goal, now).activity, 'traveling', 'the errand goes as decided');
    assert.equal(GoalExecutor.beginMarketTravel({ ...state, activity: 'traveling' }, goal, now), null, 'an accepted journey is not begun twice');
    const stepGoal = { type: 'buy_craft_material', target: { itemId: 1835, amount: 100 },
        plan: { expectedBenefit: 'market_buy_craft_material', marketTown: 'Giran', economyActivity: 'shopping', valueRate: 0.02 } };
    assert.equal(GoalExecutor.beginMarketTravel({ ...state, stats: {} }, stepGoal, now)?.activity, 'traveling',
        'the plan\'s step goes and reads the market there');
    assert.equal(travels, 2);
} finally {
    Remote.canTradeRemotely = saved.remote;
    Trip.toTown = saved.trip;
}
console.log('Acquisition executable quantity, marginal journey, unknown route and cold travel gate: PASS');
