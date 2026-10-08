'use strict';
const assert = require('node:assert/strict');
const { WishNetwork } = require('../src/GameServer/Bot/Economy/WishNetwork');
const Intent = require('../src/GameServer/Bot/Economy/TradeIntent');
function build(nodes, roots, stockFor) {
    return new WishNetwork().build({ actorKey: 'quantity', inputKey: 'fresh', nodes, roots, stockFor,
        wallet: 10000, hourAdena: 100, persona: { traits: { commitment: 0 } }, remembered: false });
}
const material = { key: 'item:202', price: 2, paths: [{ kind: 'buy', activity: 'shopping', price: 2,
    itemId: 202, executable: true, quoted: true, availableUnits: 100 }] };
const product = { key: 'item:101', price: 500, paths: [{ kind: 'craft', activity: 'crafting', costHours: .1,
    itemId: 101, productCount: 2, recipeId: 7, grossRequirements: [{ key: 'item:202', amount: 10 }],
    requirements: [{ key: 'item:202', amount: 6 }] }] };
const root = { key: 'power:101:7', need: 'power', valueHours: 100, object: { itemId: 101 },
    paths: [{ requirements: [{ key: product.key, amount: 5 }] }] };
let result = build([root, product, material], [root.key], id => id === 202 ? { owned: 4, incoming: 2 } : {});
let attempt = result.plans.get(root.key).requirements[0].plan;
assert.equal(attempt.batches, 3);
assert.equal(attempt.requirements[0].amount, 24, 'three whole batches minus owned four and incoming two');
assert.equal(result.queue[0].price, 48, 'basket pays only for the remaining material');
assert.equal(attempt.awaitingIncoming, true, 'incoming is planned supply, never physical craft readiness');
assert.equal(result.activity.itemId, 202);
assert.equal(result.activity.amount, 24);
assert.equal(result.activity.price, 48);
assert.equal(Intent.project({}, result, {}, () => 2).find(row => row.itemId === 202).amount, 24,
    'advertisement reads the same remaining quantity without a second subtraction');
result = build([root, product, material], [root.key], id => id === 202 ? { owned: 30 } : {});
attempt = result.plans.get(root.key).requirements[0].plan;
assert.equal(attempt.requirements.length, 0);
assert.equal(result.activity.itemId, 101, 'physical complete materials make the craft executable');
assert.equal(result.activity.batches, 3);
const roots = [100, 20].map((valueHours, index) => ({ key: `power:${300 + index}:7`, need: 'power', valueHours,
    object: { itemId: 300 + index },
    paths: [{ requirements: [{ key: 'item:202', amount: 8 }] }] }));
result = build([...roots, material], roots.map(row => row.key), () => ({ owned: 5 }));
assert.equal(result.plans.get(roots[0].key).requirements[0].amount, 3);
assert.equal(result.plans.get(roots[1].key).requirements[0].amount, 8, 'lower priority root cannot reuse the first root stock');
assert.equal(Intent.project({}, result, {}, () => 2)[0].amount, 3, 'one advert binds the first useful root');
const alternatives = { key: 'item:101', price: 500, paths: [product.paths[0],
    { ...product.paths[0], recipeId: 8, grossRequirements: [{ key: 'item:202', amount: 12 }] }] };
result = build([root, alternatives, material], [root.key], id => id === 202 ? { owned: 4 } : {});
assert.equal(result.plans.get(root.key).requirements[0].plan.requirements[0].amount, 26,
    'alternative recipes start from the same owned-stock baseline');
console.log('Canonical wish quantities: whole batches, own/incoming stock, native readiness, basket cost and shared root allocation passed');
