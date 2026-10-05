const assert = require('assert');
const Policy = require('../src/GameServer/Bot/Economy/WealthCraftPolicy');

const recipe = {
    type: 'dwarven', recipeId: 41, productId: 1894, productCount: 1,
    successRate: 100, mpCost: 20,
    materials: [{ selfId: 1876, amount: 2 }, { selfId: 1881, amount: 1 }]
};
const state = { adena: 500000, vitals: { mp: 100 } };
// Each missing input is one purchase in the town where it costs the least
// with the trip (ColdMarketService.planPurchase): goods cost and landed cost.
const unitPrice = new Map([[1876, 11000], [1881, 5000]]);
let trip = 0;
const planFor = (selfId, missing) => (unitPrice.has(selfId)
    ? { town: 'Giran', cost: unitPrice.get(selfId) * missing, landed: unitPrice.get(selfId) * missing + trip, units: missing, whole: true }
    : null);
const exit = { type: 'afk', price: 50000, count: 1, trip: 0 };
const found = Policy.opportunityFor(state, recipe, planFor, [exit]);
assert(found, 'funded, complete and profitable basket should be selected');
assert.strictEqual(found.basket.cost, 27000);
assert.deepStrictEqual(found.basket.purchases.map((purchase) => [purchase.selfId, purchase.count, purchase.town]),
    [[1876, 2, 'Giran'], [1881, 1, 'Giran']], 'one purchase per input, in its town');
assert.strictEqual(found.expectedProfit, 23000);
// The trips of the purchases and of the sale are costs of the craft (group C item 7).
trip = 2000;
const landed = Policy.opportunityFor(state, recipe, planFor, [{ ...exit, trip: 3000 }]);
assert.strictEqual(landed.basket.cost, 31000, 'two purchase trips');
assert.strictEqual(landed.basket.cashCost, 27000, 'the wallet pays the goods');
assert.strictEqual(landed.expectedProfit, 50000 - 31000 - 3000, 'and the sale trip');
trip = 0;
const partialStock = Policy.opportunityFor(state, recipe, planFor, [exit], (selfId) => (
    selfId === 1876 ? { count: 1, unitValue: 11000 } : null
));
assert(partialStock, 'the crafter can buy only the missing pieces');
assert.strictEqual(partialStock.basket.cashCost, 16000);
assert.strictEqual(partialStock.basket.cost, 27000,
    'owned materials must still count toward economic cost');
assert.deepStrictEqual(partialStock.basket.purchases.map((purchase) => purchase.count), [1, 1]);
assert.strictEqual(Policy.opportunityFor(state, recipe, planFor, [{ ...exit, count: 0 }]), null,
    'the output needs a buyer for the full craft yield');
assert.strictEqual(Policy.opportunityFor(state, recipe, planFor, [{ ...exit, price: 30000 }]), null,
    'a thin margin should not risk the materials');
assert.strictEqual(Policy.opportunityFor({ ...state, adena: 100000 }, recipe, planFor, [exit]), null,
    'purchases must preserve the wallet risk limit');
assert.strictEqual(Policy.opportunityFor(state, { ...recipe, successRate: 50 }, planFor, [exit]), null,
    'failed crafts must be included in expected profit');
assert.strictEqual(Policy.opportunityFor(state, recipe, (selfId, missing) => (selfId === 1881 ? null : planFor(selfId, missing)), [exit]), null,
    'every ingredient must be available before the bot starts buying');
assert.strictEqual(Policy.opportunityFor(state, recipe, (selfId, missing) => ({ ...planFor(selfId, missing), whole: false }), [exit]), null,
    'every ingredient must be available in full');
assert.strictEqual(Policy.opportunityFor({ ...state, vitals: { mp: 1 } }, recipe, planFor, [exit]), null,
    'the crafter must have enough MP');

console.log('Wealth craft policy checks passed');
