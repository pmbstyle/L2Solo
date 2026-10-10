'use strict';
// Task 4 B5 (N2): a material with both a buy path and an executable spoil path serves the same root.
// The bot that farms the missing material carries the root it farms for (rootKey power:101:7, amount 26 from
// owned 4) and no second power:* root appears; the buy-only variant with incoming 2 still asks for 24.
const assert = require('node:assert/strict');
const { WishNetwork } = require('../src/GameServer/Bot/Economy/WishNetwork');
const Intent = require('../src/GameServer/Bot/Economy/TradeIntent');
function build(nodes, roots, stockFor) {
    return new WishNetwork().build({ actorKey: 'spoil-root', inputKey: 'fresh', nodes, roots, stockFor,
        wallet: 10000, hourAdena: 100, persona: { traits: { commitment: 0 } }, remembered: false });
}
const buy = { kind: 'buy', activity: 'shopping', price: 2, itemId: 202, executable: true, quoted: true, availableUnits: 100 };
// Spoil hours are per unit: .01 h x 26 = .26 h beats the purchase 26 x 2 adena = .52 h at 100 adena/hour.
const spoil = { kind: 'spoil', activity: 'hunting', costHours: .01, itemId: 202, spotId: 123, npcId: 456, executable: true };
const material = { key: 'item:202', price: 2, paths: [buy, spoil] };
const product = { key: 'item:101', price: 500, paths: [{ kind: 'craft', activity: 'crafting', costHours: .1,
    itemId: 101, productCount: 2, recipeId: 7, grossRequirements: [{ key: 'item:202', amount: 10 }],
    requirements: [{ key: 'item:202', amount: 6 }] }] };
const root = { key: 'power:101:7', need: 'power', valueHours: 100, object: { itemId: 101 },
    paths: [{ requirements: [{ key: product.key, amount: 5 }] }] };

let result = build([root, product, material], [root.key], id => id === 202 ? { owned: 4 } : {});
assert.equal(result.activity.kind, 'spoil', 'cheaper executable spoil path is chosen over the purchase');
assert.equal(result.activity.itemId, 202);
assert.equal(result.activity.amount, 26, 'three whole batches (30) minus owned four');
assert.equal(result.activity.rootKey, 'power:101:7', 'spoil activity carries the root it serves');
const powerKeys = [...result.plans.keys()].filter(key => String(key).startsWith('power:'));
assert.deepEqual(powerKeys, ['power:101:7'], 'no second power root is created for the farmed material');
assert.equal(result.plans.get(root.key).requirements[0].plan.requirements[0].amount, 26);
assert.equal(Intent.project({}, result, {}, () => 2).filter(row => row.itemId === 202).length, 0,
    'farming the material opens no buy advert for it');

// Same stock, slower spoil (.1 h x 26 = 2.6 h): the purchase wins, still the same root and the same 26.
result = build([root, product, { ...material, paths: [buy, { ...spoil, costHours: .1 }] }], [root.key],
    id => id === 202 ? { owned: 4 } : {});
assert.equal(result.activity.kind, 'buy');
assert.equal(result.activity.amount, 26);
assert.equal(result.activity.rootKey, 'power:101:7');

result = build([root, product, { ...material, paths: [buy] }], [root.key], id => id === 202 ? { owned: 4, incoming: 2 } : {});
assert.equal(result.activity.kind, 'buy');
assert.equal(result.activity.amount, 24, 'purchase variant subtracts incoming two once');
assert.equal(result.activity.rootKey, 'power:101:7');
const ads = Intent.project({}, result, {}, () => 2).filter(row => row.itemId === 202);
assert.equal(ads.length, 1);
assert.equal(ads[0].amount, 24);
console.log('Task 4 B5 spoil root: buy-or-spoil material farms 26 under power:101:7, purchase variant stays 24');
