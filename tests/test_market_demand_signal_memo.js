const assert = require('assert');

require('../src/Global');

const MarketDemandIndex = invoke('GameServer/Bot/Economy/MarketDemandIndex');

const SHORT_GLOVES = 48;
const LEATHER_SHOES = 37;
const now = 10 * 60 * 60 * 1000;
const later = 3 * 60 * 60 * 1000;
// Private wants are read only for the own bot and its group (71143511).
const scope = { ownerId: 1, groupOwnerIds: [2] };
const signalsFor = (states, timestamp, selfId) => (MarketDemandIndex.indexSignals(states, timestamp, scope).get(selfId) || [])
    .map((signal) => signal.characterId);

const wanting = { characterId: 1, adena: 500, stats: {
    decisionSeq: 4, marketWanted: { itemId: SHORT_GLOVES, amount: 1, lastMissingAt: now, decisionSeq: 4 } } };
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
assert.strictEqual(MarketDemandIndex.indexSignals([richer], now + 2000, scope).get(SHORT_GLOVES)[0].budget, 900,
    'a replaced state carries its new budget');

// A want only the wish card backs lives with the build that held it, however long,
// and the next build (its decisionSeq) drops it: no clock.
assert.deepStrictEqual(signalsFor([wanting], now + later, SHORT_GLOVES), [1], 'it stands while its build is held');
const rebuilt = { ...wanting, stats: { ...wanting.stats, decisionSeq: 5 } };
assert.deepStrictEqual(signalsFor([rebuilt], now + 1, SHORT_GLOVES), [], 'the next build drops it');

// A want the plan backs, a shot stack and a shot recipe live until their clear
// events, however long the bot waits for a seller.
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const planPiece = { characterId: 1, adena: 500, inventory: {}, stats: {
    equipmentPlan: { status: 'active', strategy: 'market', target: { selfId: SHORT_GLOVES } },
    marketWanted: { itemId: SHORT_GLOVES, lastMissingAt: now, held: 1, plan: true },
    shotDemand: { itemId: 1463, amount: 500, maxSpend: 400, at: now },
    shotRecipeDemand: { itemId: 1804, amount: 1, maxSpend: 1000, at: now } } };
const lateSignals = MarketDemandIndex.indexSignals([planPiece], now + later, scope);
assert.deepStrictEqual([SHORT_GLOVES, 1463, 1804].map(id => (lateSignals.get(id) || []).length), [1, 1, 1],
    'three hours later the backed wants still stand');
assert.strictEqual(LifeState.reconcileFulfilledEquipmentPlan(planPiece).stats.marketWanted, planPiece.stats.marketWanted,
    'nothing new: the want stays');
const elsewhere = { ...planPiece, inventory: { [SHORT_GLOVES]: { selfId: SHORT_GLOVES, amount: 1 } },
    stats: { ...planPiece.stats, equipmentPlan: { ...planPiece.stats.equipmentPlan, target: { selfId: LEATHER_SHOES } } } };
assert.strictEqual(LifeState.reconcileFulfilledEquipmentPlan(elsewhere).stats.marketWanted, null,
    'the piece arriving by another path clears its want at the next write');
const dropped = { ...planPiece, stats: { ...planPiece.stats, equipmentPlan: { status: 'active', strategy: 'market',
    target: { selfId: LEATHER_SHOES } } } };
assert.strictEqual(LifeState.reconcileFulfilledEquipmentPlan(dropped).stats.marketWanted, null,
    'a plan that no longer wants the piece clears its want');
assert.deepStrictEqual(LifeState.reconcileFulfilledEquipmentPlan({ ...dropped, stats: { ...dropped.stats,
    marketWanted: { itemId: SHORT_GLOVES, lastMissingAt: now, clanId: 7 } } }).stats.marketWanted,
{ itemId: SHORT_GLOVES, lastMissingAt: now, clanId: 7 }, 'a clan want is the clan signal\'s own');

// Reading an earlier moment (offline tools, tests) is recomputed, not reused.
assert.deepStrictEqual(signalsFor([wanting], now, SHORT_GLOVES), [1]);

console.log('Market demand signal memo checks passed');
