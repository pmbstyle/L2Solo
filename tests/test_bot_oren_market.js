const assert = require('assert');
require('../src/Global');

const ListingService = invoke('GameServer/Bot/Economy/ColdMarketListingService');
const MerchantStoreConfigs = invoke('GameServer/Bot/MerchantStoreConfigs');

const loc = (locX, locY) => ({ locX, locY, locZ: -1496 });
const valid = ListingService.isOrenMarketStallLocation;
const choose = ListingService.chooseOrenMarketStall;
const spacing = ListingService.OREN_STALL_MIN_DISTANCE;
const distance = (a, b) => Math.hypot(a.locX - b.locX, a.locY - b.locY);

assert(valid(loc(81900, 53400)), 'the wider lower part of the captured plaza is usable');
assert(valid(loc(82500, 54000)), 'the upper part of the captured plaza is usable');
assert(!valid(loc(81900, 53900)), 'the concave cutout must remain clear');
assert(!valid(loc(82200, 53800)), 'the inset edge needs clearance too');
assert(!valid(loc(82895, 53500)), 'the outer edge needs clearance');
assert(!valid(loc(83500, 53500)), 'stalls cannot stand outside the captured plaza');
assert(!valid({}), 'missing coordinates are not a stall');

const fixed = Object.values(MerchantStoreConfigs).filter((store) => store.town === 'Oren');
const occupied = [...fixed];
let seed = 17;
const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
};
for (let index = 0; index < 80; index++) {
    const stall = choose(random, occupied);
    assert(stall, 'the captured plaza must accommodate a useful market');
    assert(valid(stall));
    assert.strictEqual(stall.locZ, -1496, 'use the captured level ground');
    assert(occupied.every((other) => distance(stall, other) >= spacing), 'keep every stall separate');
    occupied.push(stall);
}

// Constant random sampling lands on the slanted edge; the grid must still
// find a valid free location instead of falling back to Oren's town centre.
const fallback = choose(() => 0, []);
assert(fallback && valid(fallback));
const blocked = [];
for (let x = 81660; x <= 82960; x += 20) {
    for (let y = 53240; y <= 54180; y += 20) blocked.push(loc(x, y));
}
assert.strictEqual(choose(() => 0.5, blocked), null, 'a full plaza cannot overlap existing shops');

console.log('Oren captured market boundary, clearance, occupancy and full-plaza checks passed');
