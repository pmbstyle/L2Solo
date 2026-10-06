'use strict';

const assert = require('node:assert/strict');
require('../src/Global');
const Generator = require('../scripts/generate-spot-table');
const definitions = [
    { selfId: 1864, etc: { stackable: true } },
    { selfId: 1865, etc: { stackable: true } },
    { selfId: 2, etc: { stackable: false } }
];
let resolves = 0;
const simulation = {
    items: definitions,
    BotGear: { planFor: () => ({ items: [{ selfId: 1864, slot: 0 }] }) },
    Potions: { purchasePotionFor: () => null },
    CCP: { profileFor: () => ({ maxHp: 100, maxMp: 100 }) },
    HuntEfficiency: { lootValue: () => 0 },
    BR: { resolveSolo({ timestamp }) {
        resolves++;
        return { materialize: { items: [
            { selfId: 57, amount: 100 },
            { selfId: 1864, amount: 10 },
            { selfId: 1865, amount: 20 },
            { selfId: 2, amount: resolves === 1 ? 3 : 2 }
        ] }, debug: { wins: 300, combatMs: 1000 }, patch: {}, nextResolveAt: timestamp + 3600000 };
    } }
};
const sum = Generator.hunt({ id: 'fixture', center: {}, density: 1 }, 'dps', 20, false, 2, simulation);
assert.equal(resolves, 2);
assert.equal(sum.kills, 600);
assert.equal(sum.stacks, 6, 'one new stackable kind + five physical weapons; starting kinds and adena use no new slots');
assert.equal(Generator.perKill(sum, 2).stacks, .01);
const seen = new Set();
assert.equal(Generator.countNewStacks([{ selfId: 1865, amount: 2 }, { selfId: 1865, amount: 7 }], seen, definitions), 1);
assert.equal(Generator.countNewStacks([{ selfId: 1865, amount: 9 }], seen, definitions), 0);
assert.equal(Generator.countNewStacks([{ selfId: 2, amount: 4 }, { selfId: 2, amount: 3 }], seen, definitions), 7);
assert.equal(Generator.countNewStacks([{ selfId: 2, amount: 0 }, { selfId: 57, amount: 1e6 }], seen, definitions), 0);
const old = { header: { revision: 'old', inputs: { seed: 123 } }, gaps: [0], roles: ['dps'], shots: [1],
    rowFields: ['kph', 'loot'], spots: [['A'], ['B']], rows: [[[10, 20]], [[11, 21]]] };
const measured = { header: { revision: 'measured', counts: { simulatedHours: 2 } }, gaps: [0], roles: ['dps'], shots: [1],
    rowFields: ['kph', 'loot', 'stacks'], spots: [['A']], rows: [[[999, 888, .02]]] };
const merged = Generator.mergeStacks(old, measured);
assert.deepEqual(merged.rows, [[[10, 20, .02]], [[11, 21, null]]], 'merge accepts only measured stacks, preserving old values and unknown rows');
assert.deepEqual(merged.header.inputs, old.header.inputs, 'seeds and generator inputs remain authored');
assert.deepEqual(old.rows, [[[10, 20]], [[11, 21]]], 'merging never mutates the source table');
assert.equal(merged.header.stacksSource.oldColumnsRevision, 'old');
assert.equal(invoke('Database').isReady(), false);
Generator.runPool('', [], 6).then(results => {
    assert.deepEqual(results, [], 'an empty curve pool completes instead of silently abandoning table output');
    console.log('Spot table generator: two-hour fixture hunt counts distinct kinds and native physical bag slots; empty pools complete');
}).catch(error => { console.error(error); process.exitCode = 1; });
