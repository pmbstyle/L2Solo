const assert = require('node:assert/strict');
const { BoardIndex, SELL, BUY } = require('../src/GameServer/AfkTrade/BoardIndex');
const BoardReviewEvents = require('../src/GameServer/Bot/Economy/BoardReviewEvents');

const groupOf = id => id < 100 ? 'material none' : 'gear d';
const board = new BoardIndex({ groupOf });
const counts = new Map([['material none', 10], ['gear d', 5]]);
const queue = new BoardReviewEvents({ board, counter: key => counts.get(key) || 0 });
const line = (lineId, selfId, seenCounter, fields = {}) => ({ lineId, selfId, count: 3, price: 20, fills: 1,
    pricing: { price: 20, seenCounter, seenItem: 1, rival: 25, worth: 0, seenFills: 1 }, ...fields });
const record = (id, ownerId, lines, fields = {}) => ({ id, ownerId, storeType: SELL, botOwned: true, lines, ...fields });

board.put(record(1, 10, [line(11, 7, 9), line(12, 8, 9)]));
board.put(record(2, 10, [line(21, 107, 4)], { storeType: BUY }));
board.put(record(3, 20, [line(31, 7, 10)], { storeType: BUY }));
board.put(record(4, 30, [line(41, 7, 0)], { botOwned: false }));
board.put(record(5, 40, [line(51, 7, 0, { pricing: null })]));
board.put(record(6, 50, [line(61, 107, 5)]));

// Startup reads only the changed owner's durable cursor, without a deal
// replay or a normal combat resolve. Caught-up/player/unpriced owners sleep.
for (const ownerId of [10, 20, 30, 40, 50]) queue.ownerChanged(ownerId);
assert.deepEqual(queue.take(10), [10]);
queue.defer(10);
assert.deepEqual(queue.take(10), [], 'busy/unloaded owner is retained without a tight retry loop');
queue.rearm(10);
assert.deepEqual(queue.take(10), [10], 'a state refresh can retry retained work');
queue.forget(10);

// Actual counter delivery wakes affected priced owners even when ordinary
// combat resolution is far away; several lines/sides/counters dedupe ids.
const farDue = new Map([[10, { nextResolveAt: 9_999_999_999_999 }], [20, { nextResolveAt: 9_999_999_999_999 }]]);
queue.counterChanged('material none', 10);
queue.counterChanged('material none', 10);
queue.counterChanged('material none', 9);
queue.counterChanged('gear d', 5);
const changed = queue.take(2);
assert.deepEqual(changed, [10, 20], 'counter→indexed recipients does not depend on combat due');
assert(changed.every(id => farDue.get(id).nextResolveAt > 1_000_000));
assert.deepEqual(queue.take(2), [50], 'bounded FIFO drain keeps the remaining ready owner');
assert.deepEqual(queue.take(2), []);
counts.set('material none', 11);
queue.counterChanged('material none', 11);
assert.deepEqual(queue.take(10), [], 'a fresh deal never duplicates a taken command');
queue.defer(20);
queue.rearm(20);
assert.deepEqual(queue.take(10), [20], 'new evidence remains pending after busy deferral');

// Acknowledged metadata must reach the index before rearm. No-price-change
// cursor updates are enough to clear work; one still-lagging line keeps it.
board.put(record(1, 10, [line(11, 7, 11), line(12, 8, 10)]));
board.put(record(2, 10, [line(21, 107, 5)], { storeType: BUY }));
queue.rearm(10);
assert.deepEqual(queue.take(10), [10], 'one unobserved line is sufficient');
board.put(record(1, 10, [line(11, 7, 11), line(12, 8, 11)]));
queue.ownerChanged(10);
counts.set('material none', 12);
queue.counterChanged('material none', 12);
assert.deepEqual(queue.take(10), [], 'caught-up board refresh retains the taken token until ack');
queue.rearm(10);
assert.deepEqual(queue.take(10), [10], 'a deal arriving before ack is not lost');
board.put(record(1, 10, [line(11, 7, 12)]));
queue.rearm(10);
queue.rearm(20);
queue.rearm(50);
assert.deepEqual(queue.take(10), [20], 'only the owner whose durable cursor still lags remains');
queue.forget(20);
queue.rearm(20);
assert.deepEqual(queue.take(10), [], 'forgotten command cannot be revived by an old ack');

// Removal/transfer and board full copy use owner signals; resetting only
// the board does not lose pending work or market replay watermarks.
queue.ownerChanged(20);
assert.deepEqual(queue.take(1), [20]);
board.remove(3);
queue.ownerChanged(20);
queue.rearm(20);
assert.deepEqual(queue.take(10), [], 'empty old owner is forgotten');
board.put(record(7, 60, [line(71, 7, 11)]));
queue.ownerChanged(60);
assert.deepEqual(queue.take(1), [60]);
queue.defer(60);
board.clear();
board.put(record(7, 60, [line(71, 7, 11)]));
queue.counterChanged('material none', 12);
assert.deepEqual(queue.take(1), [], 'board reset does not forget the market watermark');
queue.ownerChanged(60);
assert.deepEqual(queue.take(1), [60], 'new full-copy rows re-evaluate pending evidence');
queue.defer(60);
queue.resetCounterHistory();
queue.counterChanged('material none', 12);
assert.deepEqual(queue.take(1), [60], 'market reset accepts delivered history again');
queue.defer(60);
queue.resetCounterHistory();
queue.rearm(60);
assert.deepEqual(queue.take(1), [60], 'history reset alone does not erase pending work');
queue.clear();
queue.rearm(60);
assert.deepEqual(queue.take(10), []);
queue.counterChanged('material none', 12);
assert.deepEqual(queue.take(10), [60], 'full clear also clears delivered watermarks');
queue.clear();

// A blocked/rejected native review is deferred after ack, rather than
// immediately spun again. A genuinely newer event must reactivate it.
queue.ownerChanged(60);
assert.deepEqual(queue.take(1), [60]);
queue.defer(60);
assert.deepEqual(queue.take(1), []);
counts.set('material none', 13);
queue.counterChanged('material none', 13);
queue.counterChanged('material none', 13);
assert.deepEqual(queue.take(10), [60], 'fresh counter wakes a deferred owner exactly once');
counts.set('material none', 14);
queue.counterChanged('material none', 14);
assert.deepEqual(queue.take(1), [], 'fresh counter while taken still waits for the ack');
board.put(record(7, 60, [line(71, 7, 14)]));
queue.rearm(60);
assert.deepEqual(queue.take(1), [], 'successful cursor ack clears the accumulated evidence');
board.put(record(7, 60, [line(71, 7, 13)]));
queue.ownerChanged(60);
assert.deepEqual(queue.take(1), [60]);
queue.defer(60);
queue.ownerChanged(60);
assert.deepEqual(queue.take(1), [60], 'fresh owner/state/board signal also wakes deferred work');
queue.clear();

// The counter hot path must not traverse all board records/owners or even
// an affected owner's lines; only the indexed counter recipient iterable.
board.records[Symbol.iterator] = () => { throw new Error('all records scanned'); };
board.owners[Symbol.iterator] = () => { throw new Error('all owners scanned'); };
board.ownerLines = () => { throw new Error('counter wake scanned owner lines'); };
queue.counterChanged('material none', 14);
assert.deepEqual(queue.take(1), [60]);
assert.deepEqual(queue.take(0), []);
assert.deepEqual(queue.take(-1), []);
assert.deepEqual(queue.take(Infinity), []);

console.log('Board review event queue checks passed');
