'use strict';

// The consumable stock target: a bot keeps its use over the hunting hours to
// a full bag plus a tenth. A heavy drop or a heavy stock shortens those hours,
// and the stock never carries the bag to the first weight step.
const assert = require('node:assert/strict');
require('../src/Global');
const ConsumableTarget = invoke('GameServer/Bot/Economy/ConsumableTarget');
const SurvivalFloor = invoke('GameServer/Bot/Population/SurvivalFloor');

const { bagHours, target, RESERVE } = ConsumableTarget;
assert.equal(RESERVE, 0.1);

// Massless stock and no drop load: the slots alone set the hours; 100 an hour over 2 h keeps 220 (2 h and a tenth).
assert.equal(bagHours({ slotHours: 2, freeLoad: 1000, loadPerHour: 0, stock: [{ use: 100, mass: 0 }] }), 2);
assert.equal(target(100, 2), 220, 'a full bag\'s use plus a tenth, no unit added by float error');
assert.equal(target(99.5, 2), 219);
assert.equal(target(0, 5), 0, 'a kind it does not use is not kept');

// A heavy drop shortens the hours: 100 load an hour of drop beside 100 shots an hour of mass 4.
const light = bagHours({ slotHours: 10, freeLoad: 1000, loadPerHour: 0, stock: [{ use: 100, mass: 4 }] });
const heavy = bagHours({ slotHours: 10, freeLoad: 1000, loadPerHour: 100, stock: [{ use: 100, mass: 4 }] });
assert.ok(heavy < light, `a heavy drop shortens the hours (${heavy} < ${light})`);
assert.ok(Math.abs(heavy - 996 / 540) < 1e-9, 'one unit of the stock is kept free for the whole count');
// At those hours the stock (whole, not yet spent) and the drop stay within the free load.
assert.ok(target(100, heavy) * 4 + 100 * heavy <= 1000, 'stock and drop within the load limit');

// A heavy stock alone sets the hours: 100 an hour of mass 5 in 1100 free load (one unit kept free) lasts 1095 / 550 h.
const stockBound = bagHours({ slotHours: 10, freeLoad: 1100, loadPerHour: 0, stock: [{ use: 100, mass: 5 }] });
assert.ok(Math.abs(stockBound - 1095 / 550) < 1e-9);
assert.ok(target(100, stockBound) * 5 <= 1100, 'the stock stays within the free load');
// No drop load and an empty bag of maxLoad 2840: 10 shots an hour of mass 4 stay below the first weight step (1420).
const noDrop = bagHours({ slotHours: Infinity, freeLoad: SurvivalFloor.loadLimit(2840), loadPerHour: 0, stock: [{ use: 10, mass: 4 }] });
assert.ok(target(10, noDrop) * 4 < 1420, `the stock alone stays below the first weight step (${target(10, noDrop) * 4})`);
assert.equal(SurvivalFloor.weightPenalty(target(10, noDrop) * 4, 2840), 0, 'the bag leaves town without a weight penalty');
// Two kinds share the free load: potions beside the shots shorten the shots' hours.
assert.ok(bagHours({ slotHours: 10, freeLoad: 1100, loadPerHour: 0, stock: [{ use: 100, mass: 5 }, { use: 10, mass: 5 }] }) < stockBound);

// No load left below the step (the kit alone reaches it): no hours, nothing kept above the line.
assert.equal(bagHours({ slotHours: 10, freeLoad: 0, loadPerHour: 0, stock: [{ use: 100, mass: 4 }] }), 0);
assert.equal(bagHours({ slotHours: 10, freeLoad: -5, loadPerHour: 0, stock: [{ use: 100, mass: 4 }] }), 0);
// Nothing bounds it (no slot forecast, nothing weighs): Infinity, the caller's case.
assert.equal(bagHours({ slotHours: Infinity, freeLoad: 1000, loadPerHour: 0, stock: [{ use: 100, mass: 0 }] }), Infinity);

// The first weight step is where the first weight penalty starts.
assert.equal(SurvivalFloor.FIRST_WEIGHT_STEP, 0.5);
assert.equal(SurvivalFloor.weightPenalty(500, 1000), 1);
assert.equal(SurvivalFloor.weightPenalty(499, 1000), 0);
// The load limit is the most a bag weighs below the step (whole units).
assert.deepEqual([1000, 1001, 2840, 0].map(SurvivalFloor.loadLimit), [499, 500, 1419, 0]);

console.log('test_consumable_target: ok');
