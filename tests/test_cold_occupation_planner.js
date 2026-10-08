'use strict';
const assert = require('node:assert/strict');
const { ColdOccupationPlanner } = require('../src/GameServer/Bot/Population/ColdOccupationPlanner');
const { compact, capture, ColdEconomyDecisions, stateKey } = require('../src/GameServer/Bot/Population/ColdEconomyDecision');

const posted = [], tokens = new Map(), callbacks = [];
const planner = new ColdOccupationPlanner({ schedule: callback => callbacks.push(callback), now: () => 0,
    sourceToken: id => tokens.get(id) || 0, capture: (id, input, read) => { read(id); return { id, input }; },
    create: captured => ({ captured, stage: 1, units: 0 }), step: cursor => ++cursor.units === 100,
    result: cursor => ({ known: true, recipeId: cursor.captured.id, productId: 100 + cursor.captured.id,
        incomePerHour: 10, cycleHours: 1 }), publish: (...args) => posted.push(args) });
for (let id = 1; id <= 65; id++) planner.request(id, { id }, { awaitResult: false });
for (let portion = 0; portion < 8; portion++) {
    callbacks.shift()();
    assert(planner.stats.maxPortionUnits <= 32);
    assert(planner.slots.size <= 64);
}
assert.equal(planner.slots.size, 64);
assert.equal(planner.waiting.size, 1, 'incomplete contexts remain pinned');
const first = planner.slots.get(1).work;
callbacks.shift()();
assert.strictEqual(planner.slots.get(1).work, first, 'capacity pressure cannot evict incomplete scratch');
assert(planner.stats.capacityDeferrals > 0);
tokens.set(999, 1); planner.sourceChanged(999);
assert.equal(planner.stats.invalidations, 0, 'an unrelated item is not a dependency');
tokens.set(1, 1); planner.sourceChanged(1); planner.sourceChanged(1);
assert.equal(planner.stats.invalidations, 1);
tokens.set(1, 2); planner.sourceChanged(1);
assert.equal(planner.stats.invalidations, 2, 'each distinct newer used revision restarts scratch');
let guard = 0;
while (planner.slots.get(1).work === first && guard++ < 64) callbacks.shift()();
assert.notStrictEqual(planner.slots.get(1).work, first);
assert.equal(planner.slots.get(1).cursor.byteLength, 128);
while ((planner.ready.size || planner.waiting.size) && guard++ < 2000) callbacks.shift()();
assert.equal(planner.ready.size, 0); assert.equal(planner.waiting.size, 0);
assert.equal(posted.filter(row => row[0] === 65).length, 1, 'FIFO waiter eventually progresses');
assert(planner.slots.size <= 64);
planner.stop(); assert.equal(planner.slots.size, 0); assert.equal(planner.dependencies.size, 0);

const state = { characterId: 7, updatedAt: 1000, level: 30, activity: 'hunting',
    adena: 100, vitals: { mp: 50 }, inventory: {}, stats: { classId: 1 } };
for (const workshop of [{ known: false }, { known: true, recipeId: 0, productId: 0, incomePerHour: 0, cycleHours: 0 },
    { known: true, recipeId: 25, productId: 1864, incomePerHour: 150.125, cycleHours: .25 }]) {
    const decision = compact(structuredClone(capture({ workshop }, state)));
    if (workshop.known === false) assert(Number.isNaN(decision.workshop.incomePerHour));
    else { assert.equal(decision.workshop.incomePerHour, workshop.incomePerHour); assert.equal(decision.workshop.cycleHours, workshop.cycleHours); }
    const decisions = new ColdEconomyDecisions(); decisions.accept(7, decision);
    assert.equal(decisions.workshopFor(state).known, workshop.known);
    assert.equal(decisions.workshopFor({ ...state, adena: 0 }).known, false, 'wallet changes invalidate captured occupation');
    assert.equal(decisions.workshopFor({ ...state, vitals: { mp: 0 } }).known, false, 'MP changes invalidate captured occupation');
    decisions.staleWorkshop(7, { key: stateKey(state), updatedAt: state.updatedAt });
    assert.equal(decisions.workshopFor(state).known, false, 'used-source retirement preserves explicit unknown');
}
console.log('PASS pinned FIFO contexts, exact resumable progress, used-source restarts, 32-unit portions and binary workshop NaN');
