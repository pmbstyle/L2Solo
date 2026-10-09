const assert = require('assert/strict');
const fs = require('fs');
const modulePath = '../src/GameServer/Bot/Economy/TradeIntent';
const Intent = require(modulePath);
const keys = ['power:101:7', 'stock:shots', 'stock:potions', 'stock:scrolls', 'book:123', 'enchant:123:4',
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

const plannedPurchase = (sourceType, quoted, executable, count = 1) => ({ kind: 'buy', activity: 'shopping',
    sourceType, quoted, executable, missingAmount: count, availableUnits: executable ? count : 0, requirements: [] });
const preparedRoot = (key, itemId, child) => ({ key, object: { itemId }, valueHours: 1, ratio: .1,
    plan: { missingAmount: 1, requirements: [{ key: `item:${itemId}`, amount: child.missingAmount, plan: child }] } });
const nativeNpcPlan = plannedPurchase('npc', true, true);
const projectedQueue = [preparedRoot('power:101:7', 101, plannedPurchase(undefined, false, false)),
    preparedRoot('henna:501', 300, nativeNpcPlan), preparedRoot('henna:502', 301, nativeNpcPlan),
    { key: 'resale:501', object: { itemId: 501, kind: 'resale' }, valueHours: 1, ratio: .1,
        plan: { kind: 'craft', recipeId: 401, missingAmount: 1,
            requirements: [{ key: 'item:202', amount: 10, plan: plannedPurchase(undefined, false, false, 10) }] } },
    preparedRoot('stock:shots', 303, plannedPurchase('afk', true, true))];
const preparedNetwork = { quantityPrepared: true, queue: projectedQueue };
const beforeProjection = JSON.stringify(preparedNetwork);
assert.deepEqual(Intent.project({}, preparedNetwork, {}, () => 100).map(row => row.itemId), [101, 202, 303],
    'two native NPC jobs leave existing three public slots for future/player supply and producer inputs');
assert.equal(JSON.stringify(preparedNetwork), beforeProjection, 'public projection does not change queue, funding or native action');
assert.equal(Intent.project({}, { quantityPrepared: true,
    queue: [preparedRoot('henna:501', 300, plannedPurchase('npc', false, false))] }, {}, () => 100)[0].itemId, 300,
    'unknown/unexecutable NPC annotation cannot hide an intended future acquisition');
const nonQuantitativeNpc = { ...network, plans: new Map([['item:101', nativeNpcPlan]]) };
assert.deepEqual(loaded.exports.project({}, nonQuantitativeNpc, projection, () => 100).map(row => row.itemId), [202],
    'native NPC finished-good purchase is omitted while existing craft alternatives still project their inputs');
console.log('PASS public intention source ownership: selected NPC omitted, alternative inputs traversed, future and player quotes retained, unchanged native queue and three-slot bound');

// A supported scroll need must not defer unrelated gear intentions or bid review.
for (const [key, category] of [['stock:shots', 1], ['stock:potions', 2], ['stock:scrolls', 3]]) {
    assert.deepEqual(Intent.rootTuple(key), [2, category, 0]);
    assert.equal(Intent.rootKey(2, category, 0), key);
}
assert.throws(() => Intent.rootKey(2, 4, 0));
const scrollWish = preparedRoot('stock:scrolls', 736, plannedPurchase('afk', true, true));
const mixedPrepared = { quantityPrepared: true, queue: [
    preparedRoot('power:462:11', 462, plannedPurchase('afk', true, true)), scrollWish
] };
const mixedBefore = JSON.stringify(mixedPrepared);
const mixedRows = Intent.project({}, mixedPrepared, {}, () => 124, 40);
assert.deepEqual(mixedRows.map(row => row.itemId), [462, 736]);
for (const row of mixedRows) assert.equal(Intent.decode(Intent.encode({ ...row, price: 100 })).key, row.key);
assert.equal(JSON.stringify(mixedPrepared), mixedBefore);
assert.deepEqual(Intent.project({}, { quantityPrepared: true, queue: [
    mixedPrepared.queue[0], preparedRoot('stock:scrolls', 736, nativeNpcPlan)
] }, {}, () => 124, 40).map(row => row.itemId), [462], 'NPC scroll purchase does not block peer gear or duplicate the NPC job');
assert.equal(Intent.project({}, { quantityPrepared: true, queue: [
    mixedPrepared.queue[0], { ...scrollWish, key: 'stock:food' }
] }, {}, () => 124, 40), null, 'unknown identities still defer instead of granting unsupported spending');
const scrollProjection = { nodes: [
    ...projection.nodes,
    { key: 'stock:scrolls', paths: [{ requirements: [{ key: 'item:736', amount: 10 }] }] },
    { key: 'item:736', paths: [{ kind: 'buy' }] }
] };
const legacyScrollQueue = { queue: [...network.queue, { key: 'stock:scrolls', object: { itemId: 736 }, valueHours: 1, ratio: .01 }] };
assert.equal(loaded.exports.project({ inventory: { 736: { amount: 4 } }, acceptedIncoming: { 736: 2 } },
    legacyScrollQueue, scrollProjection, () => 124, 40).find(row => row.itemId === 736).amount, 4);
console.log('PASS scroll identity preserves existing codes, mixed gear projection, NPC ownership and physical quantity allocation');
