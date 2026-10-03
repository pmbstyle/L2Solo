const assert = require('assert');

require('../src/Global');

const MarketDemandIndex = invoke('GameServer/Bot/Economy/MarketDemandIndex');

const SHORT_GLOVES = 48;
const LEATHER_SHOES = 37;
const now = 10 * 60 * 60 * 1000;
const ttl = MarketDemandIndex.WANTED_TTL_MS;
const signalsFor = (states, timestamp, selfId) => (MarketDemandIndex.indexSignals(states, timestamp).get(selfId) || [])
    .map((signal) => signal.characterId);

const wanting = { characterId: 1, adena: 500, stats: {
    marketWanted: { itemId: SHORT_GLOVES, amount: 1, lastMissingAt: now } } };
const planning = { characterId: 2, adena: 5000, stats: {
    equipmentPlan: { status: 'active', strategy: 'market', target: { selfId: LEATHER_SHOES } } } };

// The same state objects give the same demand, review after review.
assert.deepStrictEqual(signalsFor([wanting, planning], now, SHORT_GLOVES), [1]);
assert.deepStrictEqual(signalsFor([wanting, planning], now + 1000, SHORT_GLOVES), [1]);
assert.deepStrictEqual(signalsFor([wanting, planning], now + 1000, LEATHER_SHOES), [2]);

// An update replaces the state object; the new object is indexed afresh.
const bought = { ...planning, stats: { ...planning.stats, equipmentPlan: { status: 'complete' } } };
assert.deepStrictEqual(signalsFor([wanting, bought], now + 2000, LEATHER_SHOES), [],
    'a replaced state drops its old demand at once');
const richer = { ...wanting, adena: 900 };
assert.strictEqual(MarketDemandIndex.indexSignals([richer], now + 2000).get(SHORT_GLOVES)[0].budget, 900,
    'a replaced state carries its new budget');

// A timed want expires without any state update.
assert.deepStrictEqual(signalsFor([wanting], now + ttl - 1, SHORT_GLOVES), [1]);
assert.deepStrictEqual(signalsFor([wanting], now + ttl, SHORT_GLOVES), [], 'the want expires on time');

// Reading an earlier moment (offline tools, tests) is recomputed, not reused.
assert.deepStrictEqual(signalsFor([wanting], now, SHORT_GLOVES), [1]);

console.log('Market demand signal memo checks passed');
