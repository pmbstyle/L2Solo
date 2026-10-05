const assert = require('assert');
require('../src/Global');

const ListingService = invoke('GameServer/Bot/Economy/ColdMarketListingService');
const MerchantStoreConfigs = invoke('GameServer/Bot/MerchantStoreConfigs');

const valid = ListingService.isRuneMarketStallLocation;
const choose = ListingService.chooseRuneMarketStall;
const spacing = ListingService.RUNE_STALL_MIN_DISTANCE;
const loc = (locX, locY) => ({ locX, locY, locZ: -797 });
const distance = (a, b) => Math.hypot(a.locX - b.locX, a.locY - b.locY);

assert(valid(loc(44100, -48000)), 'the centre of the captured square is usable');
assert(!valid(loc(43300, -47760)), 'the enclosing rectangle includes space outside the slanted edge');
assert(!valid(loc(43270, -48000)), 'keep clearance along the western edge');
assert(!valid(loc(44990, -48000)), 'keep clearance along the eastern edge');
assert(!valid(loc(44100, -48290)), 'keep clearance along the lower edge');
assert(!valid(loc(44100, -47770)), 'keep clearance along the slanted upper edge');
assert(!valid(loc(43824, -47664)), 'the town respawn position is outside this square');
assert(!valid({}), 'missing coordinates cannot become a stall');

const fixed = Object.values(MerchantStoreConfigs).filter((store) => store.town === 'Rune');
const occupied = [...fixed];
let seed = 43;
const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
};
for (let index = 0; index < 100; index++) {
    const stall = choose(random, occupied);
    assert(stall && valid(stall), 'the square must accommodate a useful market');
    assert.strictEqual(stall.locZ, -797, 'stalls use the captured level ground');
    assert(occupied.every((other) => distance(stall, other) >= spacing));
    occupied.push(stall);
}
assert(valid(choose(() => 0)), 'grid placement must handle repeated invalid random samples');

const blocked = [];
for (let x = 43240; x <= 45020; x += 20) {
    for (let y = -48320; y <= -47700; y += 20) blocked.push(loc(x, y));
}
assert.strictEqual(choose(() => 0.5, blocked), null, 'a full zone has no overlapping candidate');

console.log('Rune captured market boundary, edge clearance and occupancy checks passed');
