'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Market = invoke('GameServer/Bot/Economy/MarketCounters');
const Belief = invoke('GameServer/Bot/Economy/PriceBelief');
const { BoardIndex, SELL, BUY } = require('../src/GameServer/AfkTrade/BoardIndex');
const Learning = invoke('GameServer/Bot/Economy/PriceLearning');
const Rolls = require('../src/GameServer/Bot/AI/TendencyRoll');
const now = 1800000000000, id = 1864;
function legacyPrior(ctx) {
    const observations = [], deals = Market.itemDeals(id);
    if (deals.prices.length) {
        const prices = [...deals.prices].sort((a, b) => a - b);
        observations.push([Math.log(prices[Math.floor(prices.length / 2)]), Math.min(10, deals.deals)]);
    }
    const ask = ctx.board?.first(id, SELL, { excludeOwner: ctx.characterId, enchant: 0 });
    if (ask?.price > 0) observations.push([Math.log(ask.price), 1]);
    const bid = ctx.board?.first(id, BUY, { excludeOwner: ctx.characterId, enchant: 0 });
    if (bid?.price > 0) observations.push([Math.log(bid.price), 1]);
    const first = Market.firstPrice(id, ctx.timestamp), counter = Market.counterOf(id);
    const index = Market.counter(counter, ctx.timestamp).index;
    if (first > 0 && index !== null) observations.push([Math.log(first) + index, .5]);
    const demand = Belief.demandValue(id, ctx);
    if (demand > 0) observations.push([Math.log(demand), .3]);
    if (first > 0) observations.push([Math.log(first), .3]);
    if (!observations.length) return null;
    let weight = 0, sum = 0;
    for (const [value, w] of observations) { weight += w; sum += value * w; }
    const bias = ctx.knowledgeEnabled
        ? (2 * Rolls.roll('n45e', ctx.characterId, id) - 1)
            * Learning.errorOf(ctx.understanding, Number(ctx.marketTrades?.[counter]) || 0, counter) : 0;
    return { selfId: id, mu: sum / weight + Math.log1p(bias), K: weight, bias };
}
Market.reset();
assert.deepEqual(Market.itemPriceEvidence(id), { deals: 0, logMedian: null });
for (const price of [10, 30, 20]) Market.deal(id, price, 1, now);
const first = Market.itemPriceEvidence(id);
assert.deepEqual(first, { deals: 3, logMedian: Math.log(20) });
assert(Object.isFrozen(first));
for (let n = 0; n < 100; n++) assert.strictEqual(Market.itemPriceEvidence(id), first);
Market.deal(id, 40, 1, now + 1);
assert.deepEqual(Market.itemPriceEvidence(id), { deals: 4, logMedian: Math.log(30) });
assert.notStrictEqual(Market.itemPriceEvidence(id), first);
for (let n = 0; n < 30; n++) Market.deal(id, 100 + n, 1, now + n + 2);
const kept = Market.itemDeals(id).prices;
assert.equal(kept.length, 21);
assert.equal(Market.itemPriceEvidence(id).logMedian, Math.log([...kept].sort((a, b) => a - b)[10]));
const board = new BoardIndex({ groupOf: Market.counterOf });
for (const [ownerId, price] of [[1, 50], [2, 60]]) board.put({ id: ownerId, ownerId, storeType: SELL,
    town: 'Giran', lines: [{ lineId: ownerId, selfId: id, price, count: 1 }] });
board.put({ id: 3, ownerId: 3, storeType: BUY, town: 'Giran', lines: [{ lineId: 3, selfId: id, price: 45, count: 1 }] });
for (const characterId of [1, 2, 3]) for (const knowledgeEnabled of [true, false]) {
    for (const timestamp of [now, now + 3600000]) for (const experience of [0, 3, 100]) {
        const ctx = { characterId, board, timestamp, understanding: .7, knowledgeEnabled,
            marketTrades: { [Market.counterOf(id)]: experience },
            derivedDemandValue: { known: true, supported: true, value: 500, ownerId: characterId } };
        assert.deepEqual(Belief.prior(id, ctx), legacyPrior(ctx));
    }
}
const rows = new Map([[`i:${id}`, [`i:${id}`, 2, 1, 11, 21, 0, 0, 0, 0]]]);
Market.useTable(() => rows);
const mirrored = Market.itemPriceEvidence(id);
assert.deepEqual(mirrored, { deals: 2, logMedian: Math.log(21) });
assert.strictEqual(Market.itemPriceEvidence(id), mirrored);
// Replacement with the SAME count still changes public evidence.
rows.set(`i:${id}`, [`i:${id}`, 2, 1, 13, 23, 0, 0, 0, 0]);
assert.deepEqual(Market.itemPriceEvidence(id), { deals: 2, logMedian: Math.log(23) });
rows.delete(`i:${id}`);
assert.deepEqual(Market.itemPriceEvidence(id), { deals: 0, logMedian: null });
Market.reset();
Market.load([{ selfId: id, unitPrice: 7, quantity: 1, occurredAt: now }]);
assert.deepEqual(Market.itemPriceEvidence(id), { deals: 1, logMedian: Math.log(7) });
console.log('PASS shared native/mirror deal evidence, local invalidation/release and 72 exact personal prior checks');
