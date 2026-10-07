'use strict';
const assert = require('node:assert/strict');
const v8 = require('node:v8');
const { capture, stateKey, ColdEconomyDecisions, kindCode, kindFor, compact } = require('../src/GameServer/Bot/Population/ColdEconomyDecision');
for (const kind of [undefined, 'improvement', 'book', 'resale', 'shots', 'potions']) assert.equal(kindFor(kindCode(kind)), kind);
assert.equal(kindCode('future-provider'), 255); assert.equal(kindFor(255), undefined);
const state = { characterId: 7, updatedAt: 1000, level: 30, activity: 'hunting', inventory: {}, stats: { classId: 1 } };
const economy = { inputKey: 'fixture', riskWeight: 1.5,
    projection: { values: new Map(Array.from({ length: 40 }, (_, i) => [2000 + i, i + 1])), nodes: [] },
    watchList: Array.from({ length: 3 }, (_, i) => ({ itemId: 100 + i, amount: 1, worth: 12000, kind: 'book' })),
    network: { demands: new Map([['item:2000', 41]]),
        activity: { activity: 'shopping', itemId: 391, amount: 1, price: 30000, rootKey: 'power:391' },
        queue: [{ key: 'power:391', object: { kind: 'book', amount: 1,
            materials: Array.from({ length: 8 }, (_, i) => ({ selfId: 300 + i, amount: 2 })) }, price: 30000 }] } };
const decision = capture(economy, state);
assert.equal(decision.key, stateKey(state)); assert.equal(decision.activity.itemId, 391);
assert.deepEqual(decision.wish, [2, 1, 30000]); assert.equal(decision.usefulness.length, 80);
assert.equal(decision.activity.heldAtDecision, 0);
const partial = capture(economy, { ...state, inventory: { 391: { selfId: 391, amount: 2 } } });
assert.equal(partial.activity.heldAtDecision, 2);
assert.equal(compact(structuredClone(partial)).activity.heldAtDecision, 2, 'the physical bag baseline survives IPC');
assert(v8.serialize(partial).byteLength - v8.serialize(decision).byteLength <= 32);
const largestBaseline = capture(economy, { ...state, inventory: { 391: { selfId: 391, amount: Number.MAX_SAFE_INTEGER } } });
assert.equal(compact(structuredClone(largestBaseline)).activity.heldAtDecision, Number.MAX_SAFE_INTEGER);
assert(v8.serialize(largestBaseline).byteLength - v8.serialize(decision).byteLength <= 32,
    'an exact native inventory baseline adds at most 32 wire bytes');
assert.deepEqual([...decision.usefulness.slice(0, 2)], [2000, 41], 'demands override projected values');
assert.equal(decision.watch.length, 3); assert.equal(decision.materials.length, 8);
const transported = compact(structuredClone(decision));
assert.deepEqual(transported.watch, decision.watch); assert.deepEqual(transported.materials, decision.materials);
assert.deepEqual([...transported.usefulness], [...decision.usefulness]); assert.equal(transported.inputHash, decision.inputHash);
assert(v8.serialize(decision).byteLength <= 800, 'proposal decision fits 0.8 KB including wire metadata');
const decisions = new ColdEconomyDecisions();
decisions.accept(7, structuredClone(decision)); assert(decisions.decided(state), 'main accepts raw wire payload before any prototype rehydration');
assert.equal(decisions.activity({ ...state, updatedAt: 1001 }, () => { throw Error('main fallback'); }), null);
assert.equal(decisions.size(), 1, 'miss keeps last decision');
decisions.accept(7, transported, { settled: [{ selfId: 391 }] });
assert.equal(decisions.decided(state), null); assert.equal(decisions.byId.get(7).stale, true);
decisions.accept(7, transported, { pkDrops: [{ selfId: 1 }] }); assert.equal(decisions.decided(state), null);
decisions.accept(7, transported); decisions.hold(7, transported);
assert(decisions.decided({ ...state, updatedAt: 5000, stats: { classId: 8 } }), 'command holds through bag/class changes');
decisions.release(7); assert.equal(decisions.decided(state), null); assert.equal(decisions.size(), 1);
decisions.accept(7, transported); assert(decisions.decided({ ...state, stats: { ...state.stats, workshop: { entries: [{}] } } }), 'crafter uses decision');
for (const changed of [{ ...state, level: 31 }, { ...state, stats: { classId: 2 } }, { ...state, activity: 'resting' }]) assert.equal(decisions.decided(changed), null);
decisions.forget(7); assert.equal(decisions.size(), 0);
if (global.gc) {
    for (let i = 0; i < 300; i++) capture(economy, state);
    global.gc(); const before = process.memoryUsage();
    const retained = Array.from({ length: 1000 }, (_, i) => compact(structuredClone(capture(economy, { ...state, updatedAt: i }))));
    global.gc(); const after = process.memoryUsage();
    const bytes = after.heapUsed - before.heapUsed + after.arrayBuffers - before.arrayBuffers;
    assert.equal(retained.length, 1000); assert(bytes <= 800000, `1000 maximum decisions retained ${bytes} bytes`);
    console.log('decision size', JSON.stringify({ retainedBytes: bytes, ipcBytes: v8.serialize(decision).byteLength }));
}
console.log('test_cold_economy_decision: ok');
