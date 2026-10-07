const assert = require('assert');
require('./helpers/databaseIsolation');
const isolated = require('./helpers/isolatedSocialDatabase')('rule-market-hunters_village');
require('../src/Global');
isolated.assertConfigured(options.default);

const ShopPlaces = invoke('GameServer/Bot/Economy/ShopPlaces');
const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');
const checkCapturedSquare = require('./helpers/capturedSquareChecks');

const TOWN = "Hunter's Village";
const valid = (point) => ShopPlaces.isStallArea(TOWN, point);
const loc = (locX, locY) => ({ locX, locY, locZ: -2717 });

assert(valid(loc(116500, 76200)), 'the centre of the captured plaza is usable');
assert(valid(loc(117000, 76400)), 'the eastern part of the captured plaza is usable');
assert(!valid(loc(117200, 75600)), 'the enclosing rectangle includes space outside the diagonal boundary');
assert(!valid(loc(115930, 76188)), 'stalls need clearance from the western corner');
assert(!valid(loc(116600, 75500)), 'stalls need clearance from diagonal edges');
assert(!valid({}), 'missing coordinates cannot become a stall');

const originalHeight = GeodataEngine.getHeight;
const originalHasGeo = GeodataEngine.hasGeo;
const height = (x, y) => -2704 - 8 * ((Math.floor(x / 16) + Math.floor(y / 16)) % 4);
try {
    GeodataEngine.hasGeo = () => false;
    GeodataEngine.getHeight = (x, y, referenceZ) => {
        assert.strictEqual(referenceZ, -2717);
        // Rejected candidates do not load geodata.
        assert(valid(loc(x, y)), 'resolve height only for a place in the stall area');
        return height(x, y);
    };
    checkCapturedSquare(TOWN, {
        useful: 100,
        groundZ: (stall) => assert.strictEqual(stall.locZ, height(stall.locX, stall.locY), 'every stall follows its own ground height')
    });
} finally {
    GeodataEngine.getHeight = originalHeight;
    GeodataEngine.hasGeo = originalHasGeo;
    ShopPlaces._resetForTests();
}

console.log("Hunter's Village boundary, edge clearance, ground height and occupancy checks passed");

require('node:fs').rmSync(isolated.directory, { recursive: true, force: true });
