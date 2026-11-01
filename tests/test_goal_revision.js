// A goal's revision tells a new goal from a review of the same one: price and build drift move nothing.
'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
require('../src/Global');
const GoalState = invoke('GameServer/Bot/Goals/GoalState');

const goal = (change = {}, plan = {}, target = {}) => JSON.stringify({ type: 'buy_craft_material', status: 'active',
    priority: 50, blockers: [], createdAt: 1, reviewedAt: 1, nextReviewAt: 2,
    target: { itemId: 1864, amount: 5, adena: 100, ...target },
    plan: { kind: 'buy', wishKey: 'power:1:7', marketTown: 'Giran', estimatedCost: 500, valueHours: 1, valueRate: 2, ...plan }, ...change });
const revision = json => { GoalState.prime(7, json); return GoalState.revision(7); };

const first = revision(goal());
assert(first > 0, 'fixture: a goal has a revision');
assert.equal(revision(goal({ reviewedAt: 9, nextReviewAt: 99 })), first, 'a review keeps it');
assert.equal(revision(goal({}, { estimatedCost: 700, valueHours: 3, valueRate: 5, reserve: 9 }, { adena: 140 })), first, 'a moved price keeps it');
assert.notEqual(revision(goal({}, {}, { itemId: 1865 })), first, 'another item is another goal');
assert.notEqual(revision(goal({}, {}, { amount: 4 })), first, 'a bought unit moves it');
assert.notEqual(revision(goal({}, { marketTown: 'Dion' })), first, 'another town moves it');
console.log('goal revision ok');
process.exit(0);
