const assert = require('assert');
require('../src/Global');

const ShopPlaces = invoke('GameServer/Bot/Economy/ShopPlaces');
const checkCapturedSquare = require('./helpers/capturedSquareChecks');

const loc = (locX, locY) => ({ locX, locY, locZ: -797 });
const valid = (point) => ShopPlaces.isStallArea('Rune', point);

assert(valid(loc(44100, -48000)), 'the centre of the captured square is usable');
assert(!valid(loc(43300, -47760)), 'the enclosing rectangle includes space outside the slanted edge');
assert(!valid(loc(43270, -48000)), 'keep clearance along the western edge');
assert(!valid(loc(44990, -48000)), 'keep clearance along the eastern edge');
assert(!valid(loc(44100, -48290)), 'keep clearance along the lower edge');
assert(!valid(loc(44100, -47770)), 'keep clearance along the slanted upper edge');
assert(!valid(loc(43824, -47664)), 'the town respawn position is outside this square');
assert(!valid({}), 'missing coordinates cannot become a stall');

// Places take their height from geodata (U19): the captured level ground.
checkCapturedSquare('Rune', {
    useful: 100,
    groundZ: (stall) => assert(Math.abs(stall.locZ - -797) <= 16, 'stalls use the captured level ground')
});

console.log('Rune captured market boundary, edge clearance and occupancy checks passed');
