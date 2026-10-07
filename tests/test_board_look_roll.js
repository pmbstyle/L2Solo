'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Pricing = invoke('GameServer/Bot/Economy/MarketPricing');
assert.equal(typeof Pricing.lookOwn, 'function', 'own resolves must use the shared board look roll');
const Look = invoke('GameServer/Bot/Economy/BoardLook');
const Counters = invoke('GameServer/Bot/Economy/MarketCounters');
const Roll = invoke('GameServer/Bot/AI/TendencyRoll');
const at = 1800000000000;
const state = { characterId: 42, stats: { money: [76797, 1, 0, 900000] } };
const line = { ownerId: 42, lineId: 7, recordId: 8, selfId: 1864, price: 120000, count: 1,
    storeType: 1, revision: 4, pricing: { seenCounter: 3, seenAt: at - 4 * 3600000 } };
const counter = { deals: 4, move: 0.05 };
const ctx = { characterId: 42, timestamp: at, understanding: 0.3, hour: 76797 };
const saved = { counter: Counters.counter, move: Counters.moveOf, roll: Roll.roll, look: Pricing.look };
try {
    Counters.counter = () => counter;
    Counters.moveOf = () => 0.05;
    const rich = Look.attention(state, line, ctx);
    assert.equal(rich.value, 14400);
    assert(Math.abs(rich.probability - 0.92) < 0.005);
    const funded = { ...state, stats: { money: [76797, 1, 0, 0] } };
    const shots = Look.attention(funded, { ...line, price: 20, count: 100,
        pricing: { seenCounter: 3, seenAt: at - 0.5 * 3600000 } }, ctx);
    assert.equal(shots.value, 15);
    assert(Math.abs(shots.probability - 0.012) < 0.005);
    assert.equal(rich.value, 2 * Look.attention(funded, line, ctx).value);
    assert.equal(Look.attention(state, line, { ...ctx, hour: 0 }).probability, 1);
    assert.equal(Look.attention(state, { ...line, price: 0 }, { ...ctx, hour: 0 }).probability, 0);
    assert.equal(Look.attention(state, { ...line, pricing: { ...line.pricing, seenCounter: 4 } }, ctx), null);
    const seen = new Map();
    const rolls = [], examined = [];
    Roll.roll = (...parts) => { rolls.push(parts); return 0; };
    Pricing.look = (_, lines) => { examined.push(lines.map(x => x.lineId)); return null; };
    assert.equal(Pricing.lookOwn(state, [], ctx, seen), null);
    assert.equal(rolls.length, 0);
    assert.equal(Pricing.lookOwn(state, [line], ctx, seen), null, 'same-price look has no row or command');
    assert.deepEqual(rolls, [['board_look', 42, '7:4']]);
    assert.deepEqual(seen.get(7), { deals: 4, at });
    assert.equal(Pricing.lookOwn(state, [line], ctx, seen), null);
    assert.equal(rolls.length, 1, 'same observed edge cannot roll twice');
    const next = { ...line, lineId: 9 };
    Pricing.look = () => ({ reprices: [{ lineId: 9, pricing: { seenCounter: 4, seenAt: at } }], withdrawals: [] });
    assert.equal(Pricing.lookOwn(state, [next], ctx, seen).reprices[0].pricing.seenAt, at);
    assert(!seen.has(7), 'removed line loses its worker look entry');
    assert(!seen.has(9), 'proposed reprice waits for its native commit rather than suppressing a retry');
    const many = Array.from({ length: 14 }, (_, i) => ({ ...line, lineId: 100 + i }));
    Pricing.look = () => null;
    const oldRolls = rolls.length;
    const all = new Set();
    for (let step = 0; step < 14; step++) {
        const count = rolls.length;
        Pricing.lookOwn(state, many, { ...ctx, timestamp: at + step * 60000 }, seen);
        assert(rolls.length - count <= 8);
        assert(seen.size <= 8);
        for (const [, , key] of rolls.slice(count)) all.add(key.split(':')[0]);
    }
    assert.equal(all.size, 14, 'owners with the existing 14-line cap eventually inspect every line');
    assert(rolls.length > oldRolls);
} finally {
    Counters.counter = saved.counter; Counters.moveOf = saved.move; Roll.roll = saved.roll; Pricing.look = saved.look;
}
console.log('PASS own board look value, named rolls, no-change memory and fixed eight-line budget');

const packed = new Look.SeenLines();
for (let id = 1; id <= 8; id++) packed.set(id, { deals: id * 2, at: at });
assert.equal(packed.byteLength, 192);
assert.equal(packed.size, 8);
assert.deepEqual(packed.get(4), { deals: 8, at: at });
packed.set(9, { deals: Number.MAX_SAFE_INTEGER, at: at + 1 });
assert.equal(packed.get(1), undefined);
assert.deepEqual([...packed.keys()], [2,3,4,5,6,7,8,9]);
assert.equal(packed.get(9).deals, Number.MAX_SAFE_INTEGER);
for (const id of [...packed.keys()]) packed.delete(id);
assert.equal(packed.size, 0);
console.log('Packed owner observations preserve exact numbers in 192 B: PASS');
