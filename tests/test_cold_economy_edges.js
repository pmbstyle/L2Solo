const assert = require('node:assert/strict');
require('../src/Global');
const Plan = require('../src/GameServer/Bot/Population/ColdEconomyPlan');
const before = { characterId: 1, activity: 'hunting', level: 30, adena: 1000,
    timing: { lastResolvedAt: 100 }, stats: { money: [100, .01, 100, 1000] },
    inventory: { 57: { selfId: 57, amount: 1000 }, 1870: { selfId: 1870, amount: 12 }, 1463: { selfId: 1463, amount: 1200 } } };
const options = { stockFor: (state, kind) => ({ itemId: kind === 'shots' ? 1463 : 1061, keep: 1000 }) };
const clone = () => structuredClone(before);
let after = clone(); after.adena += 1000; after.inventory[57].amount += 1000;
// No crossing: this packet says its next wish costs more than this wallet.
before.stats.money[3] = after.stats.money[3] = 10000;
after.exp = 100; after.inventory[1870].amount += 12;
assert.equal(Plan.edges(before, after, {}, 200, options), 0, 'ordinary loot does not build a plan');
after.inventory[1871] = { selfId: 1871, amount: 1 };
assert.equal(Plan.edges(before, after, {}, 200, options), 1, 'first new item type fires exactly one edge');
after = clone(); after.inventory[1463].amount = 900;
assert.equal(Plan.edges(before, after, {}, 200, options), 2);
assert.equal(Plan.edges(after, before, {}, 200, options), 2, 'stock recovery crosses in the other direction too');
after = clone(); after.stats.money[3] = 1000; after.adena = 1200;
assert.equal(Plan.edges(before, after, {}, 200, options), 4, 'money uses the real E4 packet predicate');
after = clone(); assert.equal(Plan.edges(before, after, { goalReviewAt: 150 }, 200, options), 8);
assert.equal(Plan.edges(before, after, { goalReviewAt: 100 }, 200, options), 0, 'already-due goal is not a new edge');
after.level++; assert.equal(Plan.edges(before, after, {}, 200, options), 16);
after = clone(); after.activity = 'dead'; assert.equal(Plan.edges(before, after, {}, 200, options), 32);
for (const blocked of [{ activity: 'resting' }, { activity: 'traveling' }, { party: { partyId: 'p' } }, { partyId: 'p' }]) {
    after = { ...clone(), level: 31, ...blocked }; after.inventory[1871] = { selfId: 1871, amount: 1 };
    assert.equal(Plan.edges(before, after, { goalReviewAt: 150 }, 200, options), 0);
}
console.log('Cold economy edges passed');
