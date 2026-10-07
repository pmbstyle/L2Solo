const assert = require('assert');
require('./helpers/databaseIsolation');
const isolated = require('./helpers/isolatedSocialDatabase')('rule-market-aden');
require('../src/Global');
isolated.assertConfigured(options.default);

const ShopPlaces = invoke('GameServer/Bot/Economy/ShopPlaces');
const checkCapturedSquare = require('./helpers/capturedSquareChecks');

const loc = (locX, locY) => ({ locX, locY, locZ: -2205 });
const valid = (point) => ShopPlaces.isStallArea('Aden', point);

assert(valid(loc(147450, 26950)), 'the captured lower trading square is usable');
assert(!valid(loc(147450, 25807)), 'the town respawn terrace is outside this market');
assert(!valid(loc(146770, 26950)), 'keep clearance along the western edge');
assert(!valid(loc(148140, 26950)), 'keep clearance along the eastern edge');
assert(!valid(loc(147450, 26620)), 'keep clearance along the southern edge');
assert(!valid(loc(147450, 27290)), 'keep clearance along the northern edge');
assert(!valid({}), 'missing coordinates cannot become a stall');

// Places take their height from geodata (U19): the lower square, not the terrace.
checkCapturedSquare('Aden', {
    useful: 100,
    groundZ: (stall) => assert(Math.abs(stall.locZ - -2205) <= 16, 'stalls use the measured lower square level')
});

console.log('Aden captured market boundary, lower ground level and occupancy checks passed');

require('node:fs').rmSync(isolated.directory, { recursive: true, force: true });
