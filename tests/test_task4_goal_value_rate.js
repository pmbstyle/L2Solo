'use strict';
// Task 4 B2: a buy goal carries its funded root's place in the money queue
// (plan.valueRate), from the card's r on main or the full network's root in
// the worker, and every funding check reads it through one goalTerms.
require('../src/Global');
const assert = require('node:assert/strict');
invoke('GameServer/DataCache').init();
const Needs = invoke('GameServer/Bot/Goals/NeedsEvaluator');
const Funding = invoke('GameServer/Bot/Economy/PurchaseFunding');
const { capture, remainingToOrder } = require('../src/GameServer/Bot/Population/ColdEconomyDecision');

const itemId = 1864; // Stem: a craft material, no equipment slot
const state = { characterId: 9101, phase: 'cold', level: 30, adena: 50000, updatedAt: 1000, currentRegion: 'Dion',
    vitals: { hp: 900, maxHp: 1000, mp: 400, maxMp: 500 },
    inventory: { 57: { selfId: 57, amount: 50000 }, [itemId]: { selfId: itemId, amount: 2 } } };
const leaf = () => ({ activity: 'shopping', kind: 'market_buy', rootKey: 'item:49', itemId, amount: 5, price: 50,
    unitPrice: 10, town: 'Giran', sourceType: 'afk' });
const wish = (funded, ratio) => ({ key: 'item:49', funded, ratio, price: 900, object: { itemId: 49, amount: 1 } });
const goalOf = economy => Needs.evaluate(state, { now: 1000, errand: null, economy })
    .find(goal => goal.target?.itemId === itemId);

// Worker: the full network's funded root gives the ratio, rounded up once.
let goal = goalOf({ network: { activity: leaf(), queue: [wish(true, 0.123456)] }, inputKey: 'w' });
assert.equal(goal.plan.valueRate, Funding.significant(0.123456));
assert.deepEqual(Funding.goalTerms(goal), { r: 0.124 });
assert.equal(goal.target.amount, 5, 'no held-at-decision on a worker leaf: read against its own state');
assert.equal(goal.plan.marketTown, 'Giran'); assert.equal(goal.plan.sourceType, 'afk');

// Unfunded root: no queue place, the money packet row of the item funds it.
goal = goalOf({ network: { activity: leaf(), queue: [wish(false, 0.5)] }, inputKey: 'w' });
assert.equal(goal.plan.valueRate, undefined);
assert.deepEqual(Funding.goalTerms(goal), { itemId });
assert.deepEqual(Funding.goalTerms(goal, 77), { itemId: 77 }, 'an explicit item names the packet row');

// Main: the card keeps r and heldAtDecision; the goal reads them, no wish needed.
const decision = capture({ network: { activity: leaf(), queue: [wish(true, 0.0421)] }, inputKey: 'c' }, state);
const card = decision.activity;
assert.equal(card.r, Funding.significant(0.0421));
assert.equal(card.heldAtDecision, 2, 'bag at the decision');
goal = goalOf({ network: { activity: card }, wish: null, inputHash: decision.inputHash, state });
assert.equal(goal.plan.valueRate, card.r);
assert.deepEqual(Funding.goalTerms(goal), { r: card.r });
// Units that reached the bag or accepted incoming since the decision fill the order once.
const later = { ...state, inventory: { ...state.inventory, [itemId]: { selfId: itemId, amount: 3 } },
    acceptedIncoming: { [itemId]: 1 } };
assert.equal(remainingToOrder(card, later, state, itemId), 3);
assert.equal(Needs.evaluate(later, { now: 1000, errand: null, economy: { network: { activity: card }, inputHash: 1, state } })
    .find(row => row.target?.itemId === itemId).target.amount, 3);

// An unfunded card root writes no r; its goal falls back to the item row.
const plain = capture({ network: { activity: leaf(), queue: [wish(false, 0.3)] }, inputKey: 'c' }, state).activity;
assert.equal(plain.r, undefined);
goal = goalOf({ network: { activity: plain }, inputHash: 1, state });
assert.equal(goal.plan.valueRate, undefined);
// A card leaf without its own root carries no other root's ratio (MVP-1).
const orphan = capture({ network: { activity: { ...leaf(), rootKey: 'item:50' }, queue: [wish(true, 0.2)] }, inputKey: 'c' }, state);
assert.equal(orphan.activity.r, undefined);
assert.equal(orphan.wish, null);
assert(orphan.urgency > 0, 'the urgent root still sets the waiting horizon without lending its amount');
console.log('test_task4_goal_value_rate: ok');
