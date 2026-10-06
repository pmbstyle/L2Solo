'use strict';

const assert = require('node:assert/strict');
const CharacterLocationIndex = require('../src/GameServer/World/CharacterLocationIndex');
const location = (locX, locY = 0, locZ = 0) => ({ locX, locY, locZ });
const record = (id, source, tags = {}) => ({ id, source, loc: () => source.loc,
    phase: 'hot', realPlayer: false, spotId: null, ...tags });

// Before the new API exists, exercise the real existing put method with both
// records. The baseline fails on its last-put loss, not a missing-method error.
function publish(index, view, value) {
    return typeof index.setSource === 'function' ? index.setSource(value.id, view, value) : index.put(value);
}

const index = new CharacterLocationIndex();
const previous = record(9, { loc: location(-1, -1) }, { phase: 'cold', spotId: 'old' });
index.put(previous);
assert.equal(index.get(9), previous);
assert.deepEqual(index.near(location(-1, -1), 0, { kind: 'cold' }), [previous]);
assert.equal(index.remove(9, {}), false);
assert.equal(index.remove(9, previous.source), true);
assert.deepEqual(index.inSpot('old'), []);
console.log('PASS current native generic put/get/near/remove controls before dual-source acceptance');

const actorSource = { loc: location(10, 20, 30) };
const stateSource = { characterId: 1, loc: location(12010, 20, -4000) };
const actor = record(1, actorSource, { realPlayer: true, spotId: 'actor_spot' });
const state = record(1, stateSource, { phase: 'cold', spotId: 'state_spot' });
publish(index, 'actor', actor);
publish(index, 'state', state);
assert.equal(index.get(1), actor, 'legacy actor view must survive same-id state publication at another native location');
assert.equal(index.getSource(1, 'state'), state);
assert.equal(index.records.size, 1, 'one id row retains the two original source views');
assert.deepEqual(index.near(location(10, 20), 0), [actor]);
assert.deepEqual(index.nearSources(location(12010, 20), 0, { view: 'state', kind: 'cold' }), [state]);
assert.deepEqual(index.near(location(12010, 20), 0), [], 'legacy query reads only actor view');
assert.deepEqual(index.inSpot('actor_spot'), [actor]);
assert.deepEqual(index.inSpot('state_spot'), []);
assert.deepEqual(index.inSpotSources('state_spot', { view: 'state' }), [state]);
assert.equal(index.getSource(1, 'actor'), actor);
assert.equal(index.getSource(99, 'state'), null);

const row = index.records.get(1), actorSlot = row.actor, stateSlot = row.state;
const actorCell = index.cells.get('0_0'), actorMembers = actorCell.actor.all;
const actorSpot = index.spots.get('actor_spot').actor;
actorSource.loc.locX = 60;
assert.equal(index.updateSource(1, 'actor', actorSource), true);
assert.equal(index.records.get(1), row);
assert.equal(row.actor, actorSlot);
assert.equal(row.state, stateSlot);
assert.equal(index.cells.get('0_0'), actorCell);
assert.equal(actorCell.actor.all, actorMembers, 'same-cell movement retains the membership Set');
assert.equal(index.spots.get('actor_spot').actor, actorSpot);
assert.deepEqual(index.near(location(60, 20, -9999), 0), [actor], 'read original live coordinates and keep XY floor policy');
assert.deepEqual(index.near(location(10, 20), 0), []);

const refreshed = { ...actor };
assert.equal(index.setSource(1, 'actor', refreshed), refreshed);
assert.equal(row.actor, actorSlot, 'same-source normalized record refresh retains its membership entry');
assert.equal(index.get(1), refreshed);
assert.equal(index.getSource(1, 'state'), state);
assert.deepEqual(index.nearSources(location(60, 20), 0), [refreshed]);
assert.equal(actorCell.actor.all, actorMembers);

actorSource.loc = location(24010, 20, 50);
refreshed.phase = 'cold'; refreshed.realPlayer = false; refreshed.spotId = 'actor_new';
assert.equal(index.update(1, actorSource), true);
assert.deepEqual(index.near(location(60, 20), 0), []);
assert.deepEqual(index.near(location(24010, 20), 0, { kind: 'cold' }), [refreshed],
    'legacy phase cold is a tag within actor view, not another state publication');
assert.deepEqual(index.near(location(24010, 20), 0, { kind: 'hot' }), []);
assert.deepEqual(index.near(location(24010, 20), 0, { kind: 'player' }), []);
assert.deepEqual(index.inSpot('actor_spot'), []);
assert.deepEqual(index.inSpot('actor_new'), [refreshed]);
assert.equal(row.state, stateSlot);
assert.deepEqual(index.nearSources(location(12010, 20), 0, { view: 'state', kind: 'cold' }), [state]);

stateSource.loc = location(24020, 20, -5000);
state.phase = 'hot'; state.realPlayer = true; state.spotId = 'state_new';
assert.equal(index.updateSource(1, 'state', stateSource), true);
assert.deepEqual(index.nearSources(location(24020, 20), 0, { view: 'state', kind: 'hot' }), [state],
    'state view and current phase are independent dimensions');
assert.deepEqual(index.nearSources(location(24020, 20), 0, { view: 'state', kind: 'cold' }), []);
assert.deepEqual(index.nearSources(location(24020, 20), 0, { view: 'state', kind: 'player' }), [state]);
assert.deepEqual(index.inSpotSources('state_spot', { view: 'state' }), []);
assert.deepEqual(index.inSpotSources('state_new', { view: 'state' }), [state]);
assert.equal(index.get(1), refreshed);

const replacementSource = { loc: location(-6001, -1) };
const replacement = record(1, replacementSource, { spotId: 'replacement' });
index.put(replacement);
assert.equal(index.get(1), replacement);
assert.equal(index.getSource(1, 'state'), state);
assert.equal(index.updateSource(1, 'actor', actorSource), false);
assert.equal(index.removeSource(1, 'actor', actorSource), false);
assert.equal(index.removeSource(1, 'state', replacementSource), false, 'wrong-view source cannot evict another producer');
assert.deepEqual(index.inSpot('actor_new'), []);
assert.deepEqual(index.near(location(-6001, -1), 0), [replacement]);

for (const invalid of [record(2, { loc: location(1) }), record(1, { loc: location(1, 1, NaN) }),
    record(1, { loc: location(1) }, { phase: 'unknown' }), record(1, { loc: location(1) }, { spotId: '' })]) {
    assert.throws(() => index.setSource(1, 'state', invalid), RangeError);
    assert.equal(index.getSource(1, 'state'), state, 'invalid replacement validates before source eviction');
    assert.equal(index.get(1), replacement);
}
for (const view of ['unknown', null]) {
    assert.throws(() => index.setSource(1, view, state), RangeError);
    assert.throws(() => index.getSource(1, view), RangeError);
    assert.throws(() => index.updateSource(1, view, stateSource), RangeError);
    assert.throws(() => index.removeSource(1, view, stateSource), RangeError);
    assert.throws(() => index.nearSources(location(0), 1, { view }), RangeError);
    assert.throws(() => index.inSpotSources('state_new', { view }), RangeError);
}
assert.throws(() => index.nearSources(location(0, 0, NaN), 1, { view: 'state' }), RangeError,
    'new pure queries retain the strict XYZ contract');
assert.throws(() => index.nearSources(location(0), Infinity, { view: 'state' }), RangeError);
assert.throws(() => index.nearSources(location(0), 1, { view: 'state', kind: 'unknown' }), RangeError);

assert.equal(index.remove(1, replacementSource), true);
assert.equal(index.get(1), null);
assert.equal(index.records.size, 1, 'removing actor keeps the current state slot');
assert.deepEqual(index.nearSources(location(24020, 20), 0, { view: 'state' }), [state]);
assert.equal(index.removeSource(1, 'state', stateSource), true);
assert.equal(index.records.size, 0);
assert.equal(index.cells.size, 0);
assert.equal(index.spots.size, 0);
assert.equal(index.removeSource(1, 'state', stateSource), false);

const sharedCell = new CharacterLocationIndex();
const sharedActor = record(2, { loc: location(1) }, { spotId: 'shared' });
const oldState = record(2, { loc: location(2) }, { phase: 'cold', spotId: 'shared' });
sharedCell.setSource(2, 'actor', sharedActor); sharedCell.setSource(2, 'state', oldState);
const newState = record(2, { loc: location(3) }, { phase: 'cold', spotId: 'shared' });
sharedCell.setSource(2, 'state', newState);
assert.equal(sharedCell.get(2), sharedActor, 'state replacement in the same cell/spot cannot evict actor membership');
assert.equal(sharedCell.updateSource(2, 'state', oldState.source), false);
assert.equal(sharedCell.removeSource(2, 'state', oldState.source), false);
assert.deepEqual(sharedCell.inSpotSources('shared', { view: 'state' }), [newState]);
assert.equal(sharedCell.removeSource(2, 'state', newState.source), true);
assert.deepEqual(sharedCell.near(location(1), 0), [sharedActor]);
assert.deepEqual(sharedCell.inSpot('shared'), [sharedActor], 'removing state preserves shared actor cell/spot Sets');
assert.equal(sharedCell.remove(2, sharedActor.source), true);
assert.equal(sharedCell.records.size, 0);
assert.equal(sharedCell.cells.size, 0);
assert.equal(sharedCell.spots.size, 0);

let unrelatedReads = 0;
const observed = (loc) => ({ get loc() { unrelatedReads++; return loc; } });
for (let id = 100; id < 132; id++) {
    index.setSource(id, 'actor', record(id, observed(location(0))));
    index.setSource(id, 'state', record(id, observed(location(0)), { realPlayer: true }));
    index.setSource(id + 1000, 'actor', record(id + 1000, observed(location(100000)), { realPlayer: true }));
    index.setSource(id + 1000, 'state', record(id + 1000, observed(location(100000)), { phase: 'cold' }));
}
const ownActor = record(500, { loc: location(1) }, { realPlayer: true });
const ownState = record(500, { loc: location(2) }, { phase: 'cold', spotId: 'own_state' });
index.setSource(500, 'actor', ownActor); index.setSource(500, 'state', ownState);
unrelatedReads = 0;
assert.deepEqual(index.nearSources(location(0), 5, { view: 'actor', kind: 'player' }), [ownActor]);
assert.equal(unrelatedReads, 0, 'actor/player query skips local state players, local bots and distant owners');
assert.deepEqual(index.nearSources(location(0), 5, { view: 'state', kind: 'cold' }), [ownState]);
assert.equal(unrelatedReads, 0, 'state/cold query skips actor view, other phases and distant owners');
assert.deepEqual(index.inSpotSources('own_state', { view: 'state' }), [ownState]);
index.clear();
assert.equal(index.records.size, 0);
assert.equal(index.cells.size, 0);
assert.equal(index.spots.size, 0);
assert.equal(index.getSource(500, 'state'), null);
assert.equal(index.updateSource(500, 'state', ownState.source), false);
assert.deepEqual(index.nearSources(location(0), 5, { view: 'state' }), []);
console.log('PASS independent actor/state source views, legacy adapter parity, live membership and bounded query access');
