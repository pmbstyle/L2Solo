const assert = require('assert/strict');
const fs = require('fs');
const modulePath = '../src/GameServer/Bot/Economy/TradeIntent';
const Intent = require(modulePath);
const keys = ['power:101:7', 'stock:shots', 'stock:potions', 'book:123', 'enchant:123:4',
    'sa:123:555', 'henna:10', 'status:101', 'resale:101'];
for (const key of keys) {
    const row = { key, itemId: 202, amount: 6, price: 11, recipeId: 301, valueHours: 2, valueRate: .01 };
    assert.deepEqual(Intent.decode(Intent.encode(row)), row);
}
for (const key of ['unknown:1', 'stock:food', 'power:1', 'book:1:2', 'power:NaN:7']) assert.throws(() => Intent.rootTuple(key));
for (const bad of [NaN, Infinity, -1]) assert.throws(() => Intent.encode({ key: 'book:1', itemId: 1, amount: 1, price: 1, valueHours: bad, valueRate: 1 }));
const loaded = { exports: {} };
new Function('require', 'module', fs.readFileSync(require.resolve(modulePath), 'utf8'))(
    () => ({ freeAmount: (state, row) => row.amount || 0 }), loaded);
const projection = { nodes: [
    { key: 'power:101:7', paths: [{ requirements: [{ key: 'item:101', amount: 1 }] }] },
    { key: 'item:101', paths: [{ kind: 'buy' }, { kind: 'craft', recipeId: 301,
        grossRequirements: [{ key: 'item:202', amount: 10 }] }] }, { key: 'item:202', paths: [{ kind: 'buy' }] }
] };
const network = { queue: [{ key: 'power:101:7', object: { itemId: 101 }, valueHours: 2, ratio: .01 }] };
for (const owned of [0, 4, 6, 9]) {
    const rows = loaded.exports.project({ inventory: { 202: { amount: owned } } }, network, projection, () => 100);
    assert.equal(rows[1].amount, 10 - owned);
    assert.equal(rows[0].itemId, 101, 'finished item and inputs coexist without a seller');
    assert.equal(rows[1].key, 'power:101:7');
}
assert.equal(loaded.exports.project({ inventory: { 202: { amount: 4 } }, acceptedIncoming: { 202: 2 } }, network, projection, () => 100)[1].amount, 4);
assert.equal(loaded.exports.project({ inventory: { 101: { amount: 1 } } }, network, projection, () => 100).length, 0);
const shared = { nodes: [
    { key: 'power:101:7', paths: [{ requirements: [{ key: 'item:101', amount: 1 }] }] },
    { key: 'item:101', paths: [{ kind: 'craft', recipeId: 301, productCount: 2,
        grossRequirements: [{ key: 'item:202', amount: 6 }, { key: 'item:203', amount: 1 }] }] },
    { key: 'item:203', paths: [{ kind: 'craft', recipeId: 302,
        grossRequirements: [{ key: 'item:202', amount: 6 }] }] }, { key: 'item:202', paths: [{ kind: 'buy' }] }
] };
const singlePool = loaded.exports.project({ inventory: { 202: { amount: 7 } } }, network, shared, () => 100);
assert.equal(singlePool.find(row => row.itemId === 202).amount, 5, 'two transformations share one physical input pool');
const gross = loaded.exports.project({ inventory: {} }, network, shared, () => 100);
assert.equal(gross.find(row => row.itemId === 202).amount, 12, 'repeated input quantities are summed before publication');
assert(gross.find(row => row.itemId === 202).valueHours <= network.queue[0].valueHours);
const batchesProjection = { nodes: projection.nodes.map(node => node.key === 'power:101:7'
    ? { ...node, paths: [{ requirements: [{ key: 'item:101', amount: 5 }] }] }
    : node.key === 'item:101' ? { ...node, paths: node.paths.map(path => path.kind === 'craft' ? { ...path, productCount: 2 } : path) } : node) };
assert.equal(loaded.exports.project({ inventory: {} }, network, batchesProjection, () => 100)[1].amount, 30, 'five outputs at two per batch require three complete input batches');
console.log('trade intention codec, batch rounding, repeated input and single stock allocation pass');
