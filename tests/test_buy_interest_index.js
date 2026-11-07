'use strict';
const assert = require('node:assert/strict');
const { BoardIndex, rowOf } = require('../src/GameServer/AfkTrade/BoardIndex');
const { quantities } = require('../src/GameServer/AfkTrade/BuyInterestIndex');
const board = new BoardIndex(), records = new Map();
const record = (id, owner, price, count, custody = 1, town = 'Giran', enchant = 0) => ({
    id, ownerId: owner, storeType: 3, kind: custody ? 'buy_ad' : 'shop', custodyPolicy: custody,
    revision: id + count, town, lines: [{ id: id * 10, lineId: id * 10, selfId: 1464, price, count, enchant }] });
function put(row) { records.set(row.id, row); board.put(row); }
function oracle(town, price, excluded) {
    const owners = new Map();
    for (const row of records.values()) for (const line of row.lines) {
        if (row.ownerId === excluded || row.town !== town || line.enchant || line.price < price || line.count <= 0) continue;
        const value = owners.get(row.ownerId) || [0, 0];
        value[0] = Math.max(value[0], line.count);
        if (row.custodyPolicy !== 1) value[1] = Math.max(value[1], line.count);
        owners.set(row.ownerId, value);
    }
    if (owners.size < 2) return null;
    let backedUnits = 0, conditionalUnits = 0;
    for (const [total, backed] of owners.values()) { backedUnits += backed; conditionalUnits += total - backed; }
    return { applicableUnits: backedUnits + conditionalUnits, backedUnits, conditionalUnits, buyers: owners.size };
}
put(record(1, 10, 600, 100)); put(record(2, 10, 500, 40, 0)); put(record(3, 10, 400, 120));
assert.equal(quantities(board.buyInterest.snapshot(1464, 'Giran'), 1), null, 'one buyer cannot manufacture a multi-buyer forecast');
put(record(4, 20, 550, 70));
assert.deepEqual(quantities(board.buyInterest.snapshot(1464, 'Giran'), 500),
    { applicableUnits: 170, backedUnits: 40, conditionalUnits: 130, buyers: 2 });
assert.equal(quantities(board.buyInterest.snapshot(1464, 'Giran', 10), 1), null, 'own requests create no external demand');
const frozen = board.buyInterest.snapshot(1464, 'Giran'), old = quantities(frozen, 500);
put(record(4, 20, 550, 20));
assert.deepEqual(quantities(frozen, 500), old, 'a prepared forecast is an immutable snapshot');
assert.notEqual(board.buyInterest.snapshot(1464, 'Giran').revision, frozen.revision);
const excluding = board.buyInterest.snapshot(1464, 'Giran', 10).revision;
put(record(1, 10, 900, 500));
assert.equal(board.buyInterest.snapshot(1464, 'Giran', 10).revision, excluding,
    'an excluded actor changing its own bid cannot invalidate foreign demand authority');
let seed = 71;
const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
for (let i = 0; i < 350; i++) {
    const id = 1 + random(35);
    if (random(5) === 0) { records.delete(id); board.remove(id); }
    else put(record(id, 1 + random(12), 100 + random(8) * 100, random(200), random(2),
        ['Giran', 'Dion'][random(2)], random(9) === 0 ? 1 : 0));
    for (const town of ['Giran', 'Dion']) for (const price of [1, 250, 500, 900]) for (const owner of [0, 3])
        assert.deepEqual(quantities(board.buyInterest.snapshot(1464, town, owner), price), oracle(town, price, owner));
}
const mirror = new BoardIndex(), follower = mirror.follower();
for (const row of [...records.values()].reverse()) follower.put(row.id, rowOf(row));
for (const town of ['Giran', 'Dion']) for (const owner of [0, 3]) {
    const a = board.buyInterest.snapshot(1464, town, owner), b = mirror.buyInterest.snapshot(1464, town, owner);
    assert.equal(a?.revision, b?.revision, 'main and worker have the same public content authority');
    assert.deepEqual(quantities(a, 250), quantities(b, 250));
}
follower.reset(); assert.equal(mirror.buyInterest.items.size, 0);
board.clear(); assert.equal(board.buyInterest.items.size, 0);
console.log('PASS incremental public demand curve, buyer deduplication, custody, own exclusion and table resync');
