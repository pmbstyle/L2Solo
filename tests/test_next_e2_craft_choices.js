'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const Policy = require('../src/GameServer/Bot/Economy/WealthCraftPolicy');
const Decision = require('../src/GameServer/Bot/Economy/WealthCraftDecision');
const Shots = require('../src/GameServer/Bot/Economy/ShotCraftPolicy');
const Funding = require('../src/GameServer/Bot/Economy/PurchaseFunding');
const state = { characterId: 900003, phase: 'cold', activity: 'hunting', level: 60,
    adena: 100000, vitals: { mp: 1000 }, inventory: {}, stats: { classId: 57, money: [1000, .001, 0, 0] } };
const context = { hourAdena: 1000, moneyPrice: .001, mpPerHour: 1000 };
const recipe = { type: 'dwarven', recipeId: 20, recipeItemId: 1804, level: 1,
    productId: 1463, productCount: 100, successRate: 60, mpCost: 1,
    materials: [{ selfId: 1458, amount: 1 }] };
const purchase = (id, amount) => ({ town: 'Giran', cost: amount * 2, landed: amount * 2, units: amount, whole: true });
const exit = { price: 10, count: 10, trip: 0 };
const finite = Policy.opportunityFor(state, recipe, purchase, [exit], undefined, context);
assert(finite);
assert.equal(finite.batches, 1, 'finite marginal output stops after the first saturating batch');
assert.equal(finite.expectedSold, 6, 'cap success output before mixing the 60% physical outcome');
assert.equal(finite.expectedProfit, 57);
assert.equal(finite.repeatable, false);
assert(Number.isNaN(finite.incomePerHour), 'a finite buyer supplies no occupation clock');
const stock = Policy.opportunityFor(state, recipe, purchase, [exit], id => id === 1463
    ? { count: 10, unitValue: 10 } : null, context);
assert.equal(stock, null, 'old goods satisfy the same bid in the without-case');
const duplicate = { ...recipe, productCount: 1, successRate: 100,
    materials: [{ selfId: 1458, amount: 4 }, { selfId: 1458, amount: 6 }] };
const basket = Policy.basketFor(duplicate, purchase, () => ({ count: 6, unitValue: 2 }));
assert.deepEqual(basket.owned, [{ selfId: 1458, count: 6, unitValue: 2 }]);
assert.deepEqual(basket.purchases.map(row => row.count), [4], 'aggregate requirements before allocating one physical stock');
const withTrips = Policy.basketFor({ ...duplicate, materials: [{ selfId: 1458, amount: 1 }, { selfId: 1785, amount: 1 }] },
    (id, amount) => ({ ...purchase(id, amount), landed: 12, tripDetails: { hours: .25, fees: 3 } }), undefined, 1, context);
assert.equal(withTrips.travelHours, .25);
assert.equal(withTrips.actualCashFees, 3, 'one town route is charged once');
const deterministic = { ...recipe, productCount: 1, successRate: 100, mpCost: 10 };
const capacity = Policy.chooseQuantity({ state, recipe: deterministic, planFor: purchase,
    exits: [{ price: 20, count: 1000 }], context: { ...context, destinationCapacity: 3 } });
assert.equal(capacity.batches, 3);
const nonconcave = Policy.chooseQuantity({ state, recipe: deterministic,
    planFor: (id, amount) => ({ ...purchase(id, amount), cost: amount >= 7 ? amount : 100,
        landed: amount >= 7 ? amount : 100 }), exits: [{ price: 20, count: 9 }], context });
assert.equal(nonconcave.batches, 9, 'bounded complete search crosses the discontinuous price break');
const nativeLimit = Policy.chooseQuantity({ state: { ...state, vitals: { mp: 1e9 } }, recipe: deterministic,
    planFor: purchase, exits: [{ price: 20, count: 1e9 }], context });
assert.equal(nativeLimit.batches, 64);
const trial = Policy.chooseQuantity({ state, recipe: deterministic, planFor: purchase,
    exits: [{ price: 20, count: 1000, trial: true }], context });
assert.equal(trial.batches, 1);
const unknownClock = Policy.chooseQuantity({ state, recipe: deterministic, planFor: purchase,
    exits: [{ price: 20, count: 1000 }], context: { hourAdena: 1000 } });
assert.equal(unknownClock, null);
const zeroClock = Policy.chooseQuantity({ state, recipe: { ...deterministic, mpCost: 0 },
    planFor: (id, n) => ({ ...purchase(id, n), npc: n }), exits: [{ price: 20, count: 1000, repeatable: true }], context,
    mode: 'occupation' });
assert.equal(zeroClock, null, 'zero MP alone is no repeatable full-cycle clock');
const recurring = Policy.chooseQuantity({ state, recipe: deterministic,
    planFor: (id, n) => ({ ...purchase(id, n), npc: n }), exits: [{ price: 20, count: 1000, repeatable: true }],
    context, mode: 'occupation' });
assert(recurring?.incomePerHour > 0);
assert(Funding.forOpportunity(state, finite.valuation) > 0);
const poor = { ...state, adena: 1 };
assert.equal(Policy.opportunityFor(poor, recipe, purchase, [exit], undefined, context), null);
const recipeOwner = { ...state, inventory: { 1804: { selfId: 1804, amount: 1 } } };
const learning = Decision.recipePaths(recipeOwner, recipe, { route: finite, sale: { price: 10 }, context });
assert.equal(learning.best.kind, 'learn');
const noDeal = Decision.recipePaths(recipeOwner, recipe, { route: { ...finite, valueHours: .005 }, sale: { price: 10 }, context });
assert.equal(noDeal.best.kind, 'sale', 'a valuable scroll stays saleable when one action cannot repay it');
const unavailable = Decision.recipePaths(state, recipe, { route: finite, acquisition: { available: false, price: 1 }, context });
assert.equal(unavailable.best.kind, 'hold');
const affordableScroll = Decision.recipePaths(state, recipe, {
    route: finite, acquisition: { available: true, price: 1 }, context
});
assert.equal(affordableScroll.best.kind, 'acquire', 'shared finite benefit admits a useful cheap shot recipe');
const expensiveScroll = Decision.recipePaths(state, recipe, { route: finite,
    acquisition: { available: true, price: finite.valueHours / context.moneyPrice + 1 }, context });
assert.equal(expensiveScroll.best.kind, 'hold',
    'a scroll that costs more than its finite benefit is rejected even with ample wallet funds');
const commissioned = Decision.recipePaths(state, recipe, { commission: { available: true,
    outcome: { receipts: 100 } }, context });
assert.equal(commissioned.best.kind, 'hold', 'no imagined commissioned contract');
const packed = Shots.packStep({ wealth: { recipeId: 20, batches: 3 } });
assert.deepEqual(Shots.unpackStep(packed), { wealth: { recipeId: 20, batches: 3 } });
assert(Buffer.byteLength(JSON.stringify(packed)) <= 128);
const sourceStep = { craft: { recipeId: 20, batches: 64, exit: [1234567, 2345678, 100, 9999],
    gear: [45, 0, 2345678, 3456789, 1000, 9999], ownReserve: 3000 } };
const sourcePacket = Shots.packStep(sourceStep), sourceResult = Shots.unpackStep(sourcePacket);
assert(Buffer.byteLength(JSON.stringify(sourcePacket)) <= 69, 'command header leaves 69 B for a typical physical source');
assert.deepEqual(sourceResult.craft.exit, [null, 2345678, null, 9999]);
assert.deepEqual(sourceResult.craft.gear, [45, 0, null, 3456789, null, 9999]);
assert.equal(sourceResult.craft.ownReserve, 3000);
assert.equal(sourceResult.craft.batches, 64);
assert.deepEqual(Funding.nativeTerms({ free: true, clanPart: 200, survivalCost: 50 }, 1463),
    { itemId: 1463, survivalCost: 50, free: true, clanPart: 200 });
assert.deepEqual(Funding.nativeTerms({ free: 1, clanPart: -1 }, 1463), { itemId: 1463 });
console.log('NEXT-E2 finite craft quantities, physical branches, recipe alternatives and funding passed');
