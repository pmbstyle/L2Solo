const assert = require('assert');
require('../src/Global');

const ListingService = invoke('GameServer/Bot/Economy/ColdMarketListingService');
const MerchantStoreConfigs = invoke('GameServer/Bot/MerchantStoreConfigs');

const valid = ListingService.isAdenMarketStallLocation;
const choose = ListingService.chooseAdenMarketStall;
const spacing = ListingService.ADEN_STALL_MIN_DISTANCE;
const loc = (locX, locY) => ({ locX, locY, locZ: -2205 });
const distance = (a, b) => Math.hypot(a.locX - b.locX, a.locY - b.locY);

assert(valid(loc(147450, 26950)), 'the captured lower trading square is usable');
assert(!valid(loc(147450, 25807)), 'the town respawn terrace is outside this market');
assert(!valid(loc(146770, 26950)), 'keep clearance along the western edge');
assert(!valid(loc(148140, 26950)), 'keep clearance along the eastern edge');
assert(!valid(loc(147450, 26620)), 'keep clearance along the southern edge');
assert(!valid(loc(147450, 27290)), 'keep clearance along the northern edge');
assert(!valid({}), 'missing coordinates cannot become a stall');

const fixed = Object.values(MerchantStoreConfigs).filter((store) => store.town === 'Aden');
const occupied = [...fixed];
let seed = 41;
const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
};
for (let index = 0; index < 100; index++) {
    const stall = choose(random, occupied);
    assert(stall && valid(stall), 'the captured square must accommodate a useful market');
    assert.strictEqual(stall.locZ, -2205, 'stalls use the measured lower square level');
    assert(occupied.every((other) => distance(stall, other) >= spacing));
    occupied.push(stall);
}
assert(valid(choose(() => 0)), 'grid placement must handle repeated invalid random samples');

const blocked = [];
for (let x = 146720; x <= 148180; x += 20) {
    for (let y = 26580; y <= 27320; y += 20) blocked.push(loc(x, y));
}
assert.strictEqual(choose(() => 0.5, blocked), null, 'a full zone has no overlapping candidate');

console.log('Aden captured market boundary, lower ground level and occupancy checks passed');
