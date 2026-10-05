const assert = require('assert');
require('../src/Global');

const ListingService = invoke('GameServer/Bot/Economy/ColdMarketListingService');
const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');

const valid = ListingService.isHuntersVillageMarketStallLocation;
const choose = ListingService.chooseHuntersVillageMarketStall;
const spacing = ListingService.HUNTERS_VILLAGE_STALL_MIN_DISTANCE;
const loc = (locX, locY) => ({ locX, locY, locZ: -2717 });
const distance = (a, b) => Math.hypot(a.locX - b.locX, a.locY - b.locY);

assert(valid(loc(116500, 76200)), 'the centre of the captured plaza is usable');
assert(valid(loc(117000, 76400)), 'the eastern part of the captured plaza is usable');
assert(!valid(loc(117200, 75600)), 'the enclosing rectangle includes space outside the diagonal boundary');
assert(!valid(loc(115930, 76188)), 'stalls need clearance from the western corner');
assert(!valid(loc(116600, 75500)), 'stalls need clearance from diagonal edges');
assert(!valid({}), 'missing coordinates cannot become a stall');

const originalHeight = GeodataEngine.getHeight;
let heightCalls = 0;
const height = (x, y) => -2704 - 8 * ((Math.floor(x / 16) + Math.floor(y / 16)) % 4);
try {
    GeodataEngine.getHeight = (x, y, referenceZ) => {
        assert.strictEqual(referenceZ, -2717);
        assert(valid(loc(x, y)), 'resolve height only after finding a valid free stall');
        heightCalls++;
        return height(x, y);
    };
    const occupied = [];
    let seed = 29;
    const random = () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 0x100000000;
    };
    for (let index = 0; index < 100; index++) {
        const stall = choose(random, occupied);
        assert(stall && valid(stall), 'the captured square must accommodate a useful market');
        assert.strictEqual(stall.locZ, height(stall.locX, stall.locY), 'every stall follows its own ground height');
        assert(occupied.every((other) => distance(stall, other) >= spacing));
        occupied.push(stall);
    }
    assert.strictEqual(heightCalls, 100, 'rejected candidates should not load geodata');
    const fallback = choose(() => 0, []);
    assert(fallback && valid(fallback), 'grid placement works when random samples fall outside the polygon');
    assert.strictEqual(fallback.locZ, height(fallback.locX, fallback.locY));

    const blocked = [];
    for (let x = 115900; x <= 117460; x += 20) {
        for (let y = 75400; y <= 76940; y += 20) blocked.push(loc(x, y));
    }
    const beforeFull = heightCalls;
    assert.strictEqual(choose(() => 0.5, blocked), null, 'a full plaza cannot overlap existing shops');
    assert.strictEqual(heightCalls, beforeFull, 'a full plaza has no accepted ground position');
} finally {
    GeodataEngine.getHeight = originalHeight;
}

console.log("Hunter's Village boundary, edge clearance, ground height and occupancy checks passed");
