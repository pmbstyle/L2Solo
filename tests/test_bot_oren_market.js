const assert = require('assert');
require('../src/Global');

const ShopPlaces = invoke('GameServer/Bot/Economy/ShopPlaces');
const checkCapturedSquare = require('./helpers/capturedSquareChecks');

const loc = (locX, locY) => ({ locX, locY, locZ: -1496 });
const valid = (point) => ShopPlaces.isStallArea('Oren', point);

assert(valid(loc(81900, 53400)), 'the wider lower part of the captured plaza is usable');
assert(valid(loc(82500, 54000)), 'the upper part of the captured plaza is usable');
assert(!valid(loc(81900, 53900)), 'the concave cutout must remain clear');
assert(!valid(loc(82200, 53800)), 'the inset edge needs clearance too');
assert(!valid(loc(82895, 53500)), 'the outer edge needs clearance');
assert(!valid(loc(83500, 53500)), 'stalls cannot stand outside the captured plaza');
assert(!valid({}), 'missing coordinates are not a stall');

// Places take their height from geodata (U19): the captured level ground.
checkCapturedSquare('Oren', {
    useful: 80,
    groundZ: (stall) => assert(Math.abs(stall.locZ - -1496) <= 16, 'use the captured level ground')
});

console.log('Oren captured market boundary, clearance, occupancy and full-plaza checks passed');
