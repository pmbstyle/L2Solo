const assert = require('assert/strict');
const Intent = require('../src/GameServer/Bot/Economy/TradeIntent');
const keys = ['power:101:7', 'stock:shots', 'stock:potions', 'stock:scrolls', 'book:123', 'enchant:123:4',
    'sa:123:555', 'henna:10', 'status:101', 'resale:101'];
for (const key of keys) {
    const row = { key, itemId: 202, amount: 6, price: 11, recipeId: 301, valueHours: 2, valueRate: .01 };
    assert.deepEqual(Intent.decode(Intent.encode(row)), row);
}
for (const key of ['unknown:1', 'stock:food', 'power:1', 'book:1:2', 'power:NaN:7']) assert.throws(() => Intent.rootTuple(key));
for (const bad of [NaN, Infinity, -1]) assert.throws(() => Intent.encode({ key: 'book:1', itemId: 1, amount: 1, price: 1, valueHours: bad, valueRate: 1 }));

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
// Batch rounding and the single stock pool are WishNetwork's (test_wish_quantity_allocation);
// a network without that stock reader has no remaining amounts and defers.
assert.equal(Intent.project({ inventory: { 202: { amount: 4 } } }, { queue: projectedQueue }, {}, () => 100), null,
    'an unprepared network is never projected by a second stock subtraction');
const npcWithCraft = { ...nativeNpcPlan, intentionPath: { kind: 'craft', recipeId: 301,
    requirements: [{ key: 'item:202', amount: 10, plan: plannedPurchase(undefined, false, false, 10) }] } };
assert.deepEqual(Intent.project({}, { quantityPrepared: true, queue: [preparedRoot('power:101:7', 101, npcWithCraft)] }, {}, () => 100)
    .map(row => [row.itemId, row.amount, row.recipeId]), [[202, 10, 301]],
    'native NPC finished-good purchase is omitted while existing craft alternatives still project their inputs');
const sharedInput = (count) => plannedPurchase(undefined, false, false, count);
const repeated = Intent.project({}, { quantityPrepared: true, queue: [{ key: 'power:101:7', object: { itemId: 101 }, valueHours: 2, ratio: .01,
    plan: { missingAmount: 1, requirements: [{ key: 'item:101', amount: 1, plan: { kind: 'craft', recipeId: 301, missingAmount: 1,
        requirements: [{ key: 'item:202', amount: 6, plan: sharedInput(6) }, { key: 'item:203', amount: 1,
            plan: { kind: 'craft', recipeId: 302, missingAmount: 1, requirements: [{ key: 'item:202', amount: 6, plan: sharedInput(6) }] } }] } }] } }] },
    {}, () => 100).find(row => row.itemId === 202);
assert.equal(repeated.amount, 12, 'repeated input quantities are summed before publication');
assert(repeated.valueHours <= 2);
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
console.log('PASS scroll identity preserves existing codes, mixed gear projection and NPC ownership');
