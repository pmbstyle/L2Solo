const assert = require('assert');

require('../src/Global');

const SpotIndex = invoke('GameServer/Bot/AI/SpotIndex');

// One id table per spot list, shared by every lookup of a spot by its id.
const spots = [{ id: '7_18', name: 'a' }, { id: 'raid:10305', name: 'b' }];
assert.strictEqual(SpotIndex.spotById(spots, '7_18'), spots[0]);
assert.strictEqual(SpotIndex.spotById(spots, 'raid:10305'), spots[1]);
assert.strictEqual(SpotIndex.spotById(spots, 'missing'), null);
assert.strictEqual(SpotIndex.spotById(spots, undefined), null);
assert.strictEqual(SpotIndex.spotById(null, '7_18'), null, 'no list, no spot');
assert.strictEqual(SpotIndex.tableFor(spots), SpotIndex.tableFor(spots), 'the table is built once per list');

// The cold worker fills its planning list in place: the table follows it.
spots.push({ id: 42, name: 'c' });
assert.strictEqual(SpotIndex.spotById(spots, '42'), spots[2], 'a list grown in place gets a new table');
assert.strictEqual(SpotIndex.spotById(spots, 42), spots[2], 'ids are compared as strings');

console.log('spot index tests passed');
