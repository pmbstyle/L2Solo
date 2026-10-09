'use strict';
const assert = require('node:assert/strict');
const { compact, compactState } = require('../src/GameServer/Bot/Population/SparseNumericStorage');
const item = { selfId: 4445, amount: 10 };
const bag = structuredClone({ 57: { selfId: 57, amount: 100 }, 736: { selfId: 736, amount: 1 }, 4445: item });
const original = Object.getOwnPropertyDescriptors(bag), keys = Reflect.ownKeys(bag), json = JSON.stringify(bag);
const held = bag[4445], prototype = Object.getPrototypeOf(bag);
assert.equal(compact(bag), true);
assert.deepEqual(Object.getOwnPropertyDescriptors(bag), original);
assert.deepEqual(Reflect.ownKeys(bag), keys);
assert.equal(JSON.stringify(bag), json);
assert.strictEqual(bag[4445], held);
assert.strictEqual(Object.getPrototypeOf(bag), prototype);
assert.equal(compact(bag), false, 'a live dictionary receives the storage hint once');
bag[10000] = item; delete bag[736];
assert.strictEqual(bag[10000], item, 'normal mutation and deletion stay available');
const state = { inventory: structuredClone({ 57: {}, 4445: {} }), stats: {
    coldCombat: { cooldowns: structuredClone({ 245: 1, 1234: 2 }) },
    targetCombat: { populationTargets: structuredClone({ 1: { kills: 1 }, 1747: { kills: 2 } }) } } };
const before = structuredClone(state);
compactState(state); assert.deepEqual(state, before);
for (const unsupported of [null, [], Object.create(null), new Map(), Object.freeze({ 736: 1 }),
    { 1: 1, 2: 2 }, { name: 1, 736: 1 }]) assert.equal(compact(unsupported), false);
let traps = 0;
assert.equal(compact(new Proxy({}, { getPrototypeOf() { traps++; throw Error('proxy'); }, ownKeys() { traps++; throw Error('proxy'); } })), false);
assert.equal(traps, 0);
const accessor = {};
Object.defineProperty(accessor, '736', { enumerable: true, configurable: true, get() { throw Error('getter'); } });
assert.equal(compact(accessor), false, 'no accessor is evaluated');
compactState({ get inventory() { throw Error('inventory getter'); },
    stats: { get coldCombat() { throw Error('combat getter'); } } });
compactState(new Proxy({}, { getOwnPropertyDescriptor() { throw Error('state proxy'); } }));
if (global.gc) {
    global.gc();
    const start = process.memoryUsage().heapUsed;
    // This ascending NPC-key distribution comes from a retained worker map.
    // A four-key fixture with a large final jump is already sparse in V8 and
    // cannot demonstrate the structured-clone allocation we are fixing.
    const source = Object.fromEntries([1, 121, 450, 568, 587, 592, 620, 636,
        651, 656, 671, 685, 720, 1024, 1747].map(id => [id, 1]));
    const rows = Array.from({ length: 1000 }, () => structuredClone(source));
    global.gc();
    const dense = process.memoryUsage().heapUsed - start;
    for (const row of rows) compact(row);
    global.gc();
    const sparse = process.memoryUsage().heapUsed - start;
    assert(rows.every(row => row[1747] === 1));
    console.log(JSON.stringify({ dictionaries: rows.length, denseBytes: dense, sparseBytes: sparse, savedBytes: dense - sparse }));
    assert(sparse < dense / 4, 'native structured-clone sparse keys release their empty backing slots');
}
console.log('PASS sparse numeric storage preserves identity, descriptors, values, JSON/order, mutation and unsupported input safety');
