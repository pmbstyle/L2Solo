'use strict';

const assert = require('node:assert/strict');
const Index = require('../src/GameServer/World/CharacterLocationIndex');
const point = (locX = 0) => ({ locX, locY: 0, locZ: 10 });
const record = (id, extra = {}) => ({ id, source: {}, phase: 'hot', spotId: 'live_spot', loc: point(), ...extra });
const index = new Index();
const actor = record(1, { realPlayer: true });
const state = record(1, { phase: 'cold' });
index.put(actor);
index.setSource(1, 'state', state);
assert.deepEqual(index.near(point(), 0), [actor]);
assert.deepEqual(index.nearSources(point(), 0, { view: 'state' }), [state]);
assert.deepEqual(index.inSpot('live_spot'), [actor]);
assert.deepEqual(index.inSpotSources('live_spot', { view: 'state' }), [state]);
console.log('PASS actual default indexed actor/state/cell/spot positives before raw source contract');

let pointReads = 0;
const raw = record(1, { spotId: 'raw_spot' });
Object.defineProperty(raw, 'loc', { get() { pointReads++; throw new Error('raw_point_read'); } });
assert.doesNotThrow(() => index.setSource(1, 'actor', raw, { indexed: false }),
    'explicit raw source publication must not access its location');
assert.equal(index.get(1), raw);
assert.equal(index.getSource(1, 'actor'), raw);
assert.equal(index.getSource(1, 'state'), state);
assert.equal(pointReads, 0);
assert.deepEqual(index.near(point(), 100), []);
assert.deepEqual(index.inSpot('live_spot'), []);
assert.deepEqual(index.inSpot('raw_spot'), []);
assert.deepEqual(index.inSpotSources('live_spot', { view: 'state' }), [state]);
assert.equal(index.update(1, raw.source), true, 'compatible actor update inherits inactive mode');
assert.equal(index.updateSource(1, 'actor', raw.source), true);
assert.equal(pointReads, 0);
assert.equal(index.updateSource(1, 'actor', actor.source, { indexed: true }), false);
assert.equal(index.remove(1, actor.source), false, 'late former indexed source cannot remove raw replacement');

const originalRow = index.records.get(1), originalEntry = originalRow.actor;
const malformed = record(1, { loc: { ...point(), locZ: NaN } });
assert.throws(() => index.setSource(1, 'actor', malformed), RangeError, 'default indexed remains strict');
assert.throws(() => index.setSource(1, 'actor', malformed, { indexed: true }), RangeError);
assert.equal(index.get(1), raw, 'point validation completes before evicting inactive source');
assert.equal(index.records.get(1), originalRow);
assert.throws(() => index.updateSource(1, 'actor', raw.source, { indexed: true }), /raw_point_read/);
assert.equal(index.records.get(1).actor, originalEntry);
assert.deepEqual(index.near(point(), 100), []);
assert.equal(pointReads, 1, 'only explicit enable evaluated the throwing point');

for (const [id, view, candidate, options] of [
    [0, 'actor', record(0), { indexed: false }],
    [0, 'state', record(0, { phase: 'cold' }), { indexed: false }],
    [1, 'other', raw, { indexed: false }],
    [1, 'actor', { ...actor, source: null }, { indexed: false }],
    [1, 'actor', { ...actor, phase: 'offline' }, { indexed: false }],
    [1, 'actor', { ...actor, spotId: 42 }, { indexed: false }],
    [1, 'actor', { ...actor, id: 2 }, { indexed: false }],
    [1, 'actor', actor, { indexed: 0 }],
    [1, 'actor', actor, { indexed: 'false' }]
]) {
    assert.throws(() => index.setSource(id, view, candidate, options));
    assert.equal(index.get(1), raw, 'invalid raw identity/tags/mode cannot alter existing source');
    assert.equal(index.getSource(1, 'state'), state);
    assert.equal(index.records.get(1).actor, originalEntry);
}
assert.throws(() => index.updateSource(1, 'actor', raw.source, { indexed: 'true' }), TypeError);
assert.equal(index.records.get(1).actor, originalEntry);

let currentPoint = point(5), transitionsRead = 0;
const moving = record(2, { loc: () => { transitionsRead++; return currentPoint; } });
index.put(moving);
const movingRow = index.records.get(2), movingEntry = movingRow.actor;
const state2 = record(2, { phase: 'cold', loc: point(5) });
index.setSource(2, 'state', state2);
const stateMembers = index.cells.get(movingEntry.key).state.all;
assert(index.inSpot('live_spot').includes(moving));
transitionsRead = 0;
index.setSource(2, 'actor', moving, { indexed: false });
assert.equal(index.records.get(2), movingRow);
assert.equal(index.records.get(2).actor, movingEntry);
assert.equal(transitionsRead, 0);
assert(!index.inSpot('live_spot').includes(moving));
assert.deepEqual(index.near(point(5), 0), []);
assert.equal(index.cells.get(index.records.get(2).state.key).state.all, stateMembers);
assert.equal(index.updateSource(2, 'actor', moving.source), true);
assert.equal(transitionsRead, 0);
currentPoint = { ...point(5), locZ: NaN };
assert.throws(() => index.updateSource(2, 'actor', moving.source, { indexed: true }), RangeError);
assert.deepEqual(index.near(point(5), 0), []);
assert.equal(index.records.get(2).actor, movingEntry);
currentPoint = point(5);
index.updateSource(2, 'actor', moving.source, { indexed: true });
assert.equal(index.records.get(2).actor, movingEntry);
assert.deepEqual(index.near(point(5), 0), [moving], 'enable at the SAME former cell restores membership');
assert(index.inSpot('live_spot').includes(moving));
assert.equal(index.cells.get(movingEntry.key).state.all, stateMembers);
const activeMembers = index.cells.get(movingEntry.key).actor.all;
currentPoint = point(6);
index.updateSource(2, 'actor', moving.source);
assert.equal(index.cells.get(movingEntry.key).actor.all, activeMembers, 'default active update retains same-cell membership');
assert.deepEqual(index.near(point(6), 0), [moving]);
index.updateSource(2, 'actor', moving.source, { indexed: false });
currentPoint = point(12000);
index.setSource(2, 'actor', moving, { indexed: true });
assert.deepEqual(index.near(point(6), 0), []);
assert.deepEqual(index.near(point(12000), 0), [moving]);
assert.equal(index.getSource(2, 'state'), state2);

const rawState = record(2, { phase: 'cold', loc: () => { throw new Error('inactive_state_point_read'); } });
index.setSource(2, 'state', rawState, { indexed: false });
assert.equal(index.getSource(2, 'state'), rawState);
assert.deepEqual(index.nearSources(point(), 20000, { view: 'state' }), [state]);
assert.deepEqual(index.inSpotSources('live_spot', { view: 'state' }), [state]);
assert.equal(index.updateSource(2, 'state', rawState.source), true);
assert.equal(index.updateSource(2, 'state', state2.source), false);
assert.equal(index.removeSource(2, 'state', state2.source), false);
assert.deepEqual(index.near(point(12000), 0), [moving]);

const legacy = new Index({ legacyStateCache: true });
const zero = record(0, { phase: 'cold', loc: null });
legacy.setSource(0, 'state', zero, { indexed: false });
assert.equal(legacy.getSource(0, 'state'), zero, 'raw mode retains existing legacy state key compatibility');
assert.equal(legacy.updateSource(0, 'state', zero.source), true);
assert.throws(() => legacy.setSource(0, 'actor', zero, { indexed: false }), RangeError);
assert.throws(() => legacy.setSource(3, 'actor', record(3, { loc: { ...point(), locZ: NaN } })), RangeError);
assert.deepEqual(legacy.nearSources(point(), 1, { view: 'state' }), []);

pointReads = 0;
assert.equal(index.removeSource(1, 'actor', raw.source), true);
assert.equal(index.getSource(1, 'state'), state);
assert.equal(pointReads, 0);
index.clearSourceView('state');
assert.equal(index.getSource(2, 'state'), null);
assert.equal(index.get(2), moving);
assert.deepEqual(index.near(point(12000), 0), [moving]);
assert.equal(index.records.has(1), false);
index.setSource(2, 'state', rawState, { indexed: false });
index.clearSourceView('actor');
assert.equal(index.get(2), null);
assert.equal(index.getSource(2, 'state'), rawState);
index.clear(); legacy.clear();
assert.equal(index.records.size, 0);
assert.equal(index.cells.size, 0);
assert.equal(index.spots.size, 0);
assert.equal(pointReads, 0);
assert.equal(legacy.records.size, 0);
console.log('PASS raw source/default strict/true-false-true/identity/expected-source/cross-view/reset/zero-point-read contracts');
