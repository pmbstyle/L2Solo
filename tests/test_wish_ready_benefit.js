'use strict';
// Market MVP-4: one horizon H per equipment family; a benefit per hour starts
// when the path is ready (funding delay at net income, then the path hours).
const assert = require('node:assert/strict');
const { WishNetwork } = require('../src/GameServer/Bot/Economy/WishNetwork');
const Valuation = require('../src/GameServer/Bot/Economy/EconomicValuation');
const done = label => console.log('PASS ' + label);
const near = (actual, expected, label) => assert(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} !== ${expected}`);

assert.equal(Valuation.fundingDelay({ requiredCash: 5, spendableCash: 9, incomePerHour: 0 }), 0, 'no shortfall waits nothing');
assert.equal(Valuation.fundingDelay({ requiredCash: 9, spendableCash: 5, incomePerHour: 0 }), null, 'a shortfall without income is unknown');
assert.equal(Valuation.fundingDelay({ requiredCash: 9, spendableCash: 5, incomePerHour: -1 }), null);
assert.equal(Valuation.fundingDelay({ requiredCash: 3e6, spendableCash: 2e6, incomePerHour: 5e5 }), 2);
assert.equal(Valuation.readyBenefit({ valueHours: 12, benefitPerHour: 0.3, horizonHours: 40, delayHours: null }), null);
assert.equal(Valuation.readyBenefit({ valueHours: 12, benefitPerHour: 0.3, horizonHours: 40, delayHours: 100 }), 0, 'never below zero');
done('funding delay and ready benefit readers');

const gear = (key, gain, price, path = {}) => ({ key, need: 'power', object: { itemId: key === 'top' ? 2 : 1 }, price,
    valueHours: gain * 40, benefitPerHour: gain, horizonHours: 40,
    paths: [{ kind: 'board', activity: 'shopping', price, costHours: 0, executable: true, availableUnits: 1, ...path }] });
const build = (name, nodes, extra = {}) => new WishNetwork().build({ actorKey: 'character:5', characterId: 5, inputKey: name,
    wallet: 2e6, hourAdena: 5e5, persona: { traits: { commitment: 0 } }, roots: nodes.map(node => node.key), nodes, ...extra });
const row = (result, key) => result.queue.find(wish => wish.key === key);

// PLAN.md synthetic acceptance: mid C 3m gains 0.3, top C 4m gains 0.5.
const synthetic = build('mid-top', [gear('mid', 0.3, 3e6), gear('top', 0.5, 4e6)]);
for (const [key, value, effort, ready] of [['mid', 11.4, 6, 2], ['top', 18, 8, 4]]) {
    near(row(synthetic, key).valueHours, value, `${key} benefit`);
    near(row(synthetic, key).effort, effort, `${key} cash effort`);
    near(row(synthetic, key).readyHours, ready, `${key} ready delay`);
}
near(row(synthetic, 'mid').valueHours / row(synthetic, 'mid').effort, 1.9, 'mid score');
near(row(synthetic, 'top').valueHours / row(synthetic, 'top').effort, 2.25, 'top score');
done('synthetic mid C 11.4 / 6 and top C 18 / 8');

// The path's own hours follow the funding delay; trips are made once.
const labour = build('labour', [gear('mid', 0.3, 1e6, { costHours: 3 })]);
near(row(labour, 'mid').readyHours, 3, 'labour hours with no shortfall');
near(row(labour, 'mid').valueHours, 0.3 * 37, 'labour delays the benefit');
const trip = build('trip', [gear('mid', 0.3, 1e6, { quoted: true, town: 'Giran', tripHours: 0.5, tripFees: 0 })]);
near(row(trip, 'mid').readyHours, 0.5, 'trip hours');
const reserve = build('reserve', [gear('mid', 0.3, 1e6)], { survivalReserve: 1.5e6 });
near(row(reserve, 'mid').readyHours, 1, 'spendable cash excludes the survival reserve');
done('path hours, trips and reserve in the ready delay');

// A delay past the horizon leaves no benefit; the wish is not a goal.
assert.equal(build('late', [gear('mid', 0.3, 3e7)]).queue.length, 0);
// A shortfall without income: interest kept, no money and no gap.
const unknown = build('no-income', [gear('mid', 0.3, 3e6)], { hourAdena: 0 });
assert.equal(row(unknown, 'mid').resolved, false);
assert.equal(row(unknown, 'mid').funded, false);
assert.equal(unknown.gap, null);
// Zero shortfall: zero delay even without income.
const affordable = build('affordable', [gear('mid', 0.3, 1e6)], { hourAdena: 0 });
assert.equal(row(affordable, 'mid').resolved, true);
near(row(affordable, 'mid').valueHours, 12, 'no shortfall, no delay');
done('delay past H and unknown delay');

// Owned ready gear has zero acquisition delay on the stock re-solve.
const owned = { ...gear('mid', 0.3, 3e6), paths: [{ requirements: [{ key: 'item:1', amount: 1 }] }] };
const item = { key: 'item:1', price: 3e6, paths: [{ kind: 'board', activity: 'shopping', price: 3e6, executable: true, availableUnits: 1 }] };
const held = build('owned', [owned, item], { roots: ['mid'], stockFor: () => ({ owned: 1, incoming: 0 }) });
assert.equal(held.queue.length, 0, 'owned gear needs no money');
assert.equal(held.focus?.[0], 'mid', 'owned gear keeps its interest');
const bought = build('bought', [owned, item], { roots: ['mid'], stockFor: () => ({ owned: 0, incoming: 0 }) });
near(row(bought, 'mid').readyHours, 2, 'stock re-solve applies the same delay');
done('owned gear and the stock re-solve');
