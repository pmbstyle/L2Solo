const assert = require('node:assert/strict');
const { BoardIndex, SELL, BUY, rowOf, recordOf } = require('../src/GameServer/AfkTrade/BoardIndex');

const groupOf = id => id < 100 ? 'material none' : 'gear d';
const index = new BoardIndex({ groupOf });
const pricing = { price: 20, seenCounter: 4, seenItem: 2, rival: 25, worth: 0, seenFills: 1 };
const line = (lineId, selfId, fields = {}) => ({ lineId, selfId, count: 3, price: 20, pricing, fills: 2, ...fields });
const record = (id, ownerId, lines, fields = {}) => ({ id, ownerId, storeType: SELL, kind: 'sell_ad',
    botOwned: true, town: 'Dion', lines, ...fields });
const owners = key => [...index.ownersForCounter(key)].sort((a, b) => a - b);

// One owner has several lines and records on both sides; players and old
// unpriced offers remain on the board but never become review recipients.
index.put(record(1, 10, [line(11, 7), line(12, 8), line(13, 107)]));
index.put(record(2, 10, [line(21, 9)], { storeType: BUY, kind: 'buy_ad' }));
index.put(record(3, 20, [line(31, 7)], { botOwned: false }));
index.put(record(4, 30, [line(41, 7, { pricing: null })]));
index.put(record(5, 40, [line(51, 7, { count: 0 })]));
index.put(record(6, 50, [line(61, 108)], { storeType: BUY }));
assert.deepEqual(owners('material none'), [10], 'only priced bot owners of this counter');
assert.deepEqual(owners('gear d'), [10, 50], 'BUY lines are review recipients too');
assert.deepEqual(owners('shot d'), [], 'an unrelated counter has no recipients');
assert.equal(index.list(7, SELL).length, 3, 'player and unpriced offers stay executable offers');
assert.equal(index.linesIn('material none'), 4, 'existing group counts include only SELL offers');

index.put(record(1, 10, [line(13, 107)]));
assert.deepEqual(owners('material none'), [10], 'the surviving BUY record retains membership');
index.remove(2);
assert.deepEqual(owners('material none'), [], 'last reference removal removes membership');
assert.deepEqual(owners('gear d'), [10, 50]);
index.put(record(1, 60, [line(13, 7)]));
assert.deepEqual(owners('material none'), [60], 'replacement moves the record to its new owner and counter');
assert.deepEqual(owners('gear d'), [50], 'old owner and counter have no phantom references');
index.put(record(1, 60, [line(13, 7, { pricing: null })]));
assert.deepEqual(owners('material none'), [], 'removing pricing removes the review reference only');
assert.equal(index.ownerLines(60).length, 1);
index.put(record(1, 60, [line(13, 7), line(14, 8)]));
index.put(record(1, 60, [line(14, 8)]));
assert.deepEqual(owners('material none'), [60], 'one remaining line retains the owner');
index.remove(1);
index.remove(1);
assert.deepEqual(owners('material none'), [], 'idempotent removal cannot underflow references');

// Worker transport keeps the existing exact pricing/fills fields and reset
// clears the new index together with all normal offer indexes.
const follower = index.follower();
const store = { shopId: 9, ownerId: 70, kind: 'buy_ad', storeType: BUY, botOwned: true, revision: 12,
    items: [{ afkTradeLineId: 91, selfId: 7, count: 2, price: 20, pricing, fills: 2 }] };
const row = rowOf(store);
assert.equal(row.length, 9, 'id, kind, side, owner, town, bot, lines, revision, custody policy');
assert.equal(row[8], 0, 'an ordinary backed record has custody policy 0');
assert.deepEqual(row[6][0], [91, 7, 0, 2, 20, pricing, 2]);
follower.put(9, row);
assert.deepEqual(owners('material none'), [70]);
assert.deepEqual(index.ownerLines(70)[0].pricing, pricing);
assert.equal(index.ownerLines(70)[0].fills, 2);
assert.equal(recordOf(row).lines[0].fills, 2);
follower.reset();
assert.deepEqual(owners('material none'), []);
assert.deepEqual(owners('gear d'), []);
assert.equal(index.size, 0);
assert.equal(index.linesIn('material none'), 0);
assert.deepEqual(index.ownerLines(70), []);
follower.put(9, row);
follower.remove(9);
assert.deepEqual(owners('material none'), []);

console.log('Board counter owner index checks passed');
