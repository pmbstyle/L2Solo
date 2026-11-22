const assert = require('assert');
require('./helpers/databaseIsolation');
const isolated = require('./helpers/isolatedSocialDatabase')('rule-market-gludin-heine');
require('../src/Global');
isolated.assertConfigured(options.default);

const ShopPlaces = invoke('GameServer/Bot/Economy/ShopPlaces');
const TownRespawn = invoke('GameServer/World/TownRespawn');
const MarketTownPolicy = invoke('GameServer/Bot/Economy/MarketTownPolicy');
const MerchantStoreConfigs = invoke('GameServer/Bot/MerchantStoreConfigs');
const checkCapturedSquare = require('./helpers/capturedSquareChecks');

// Gludin and Heine have a square for bot shops, as every other market town, so the
// crafters who take their shots there can list them there.
for (const [town, z] of [['Gludin', -3040], ['Heine', -3544]]) {
    const valid = (locX, locY) => ShopPlaces.isStallArea(town, { locX, locY, locZ: z });
    const box = ShopPlaces.stallBounds(town);
    assert(valid((box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2), `${town}: the centre of its square is usable`);
    assert(!valid(box.minX - 10, (box.minY + box.maxY) / 2), `${town}: keep clearance along the western edge`);
    assert(!valid((box.minX + box.maxX) / 2, box.maxY + 10), `${town}: keep clearance along the northern edge`);
    assert(!valid(), `${town}: missing coordinates are not a stall`);
    // Its fixed traders stand on it; travel to the town still arrives at its respawn point.
    assert(Object.values(MerchantStoreConfigs).some(store => store.town === town && ShopPlaces.isOnSquare(town, store)),
        `${town}: its shot merchant stands on the square`);
    const respawn = Object.values(TownRespawn.towns).find(row => row.name === town);
    assert.deepStrictEqual(MarketTownPolicy.marketTown(town).center, { locX: respawn.locX, locY: respawn.locY, locZ: respawn.locZ },
        `${town}: its market centre stays the respawn point`);
    checkCapturedSquare(town, {
        useful: 80,
        groundZ: (stall) => assert(Math.abs(stall.locZ - z) <= 16, `${town}: stalls use the level ground`)
    });
}

console.log('Gludin and Heine market boundary, clearance, occupancy and full-plaza checks passed');

require('node:fs').rmSync(isolated.directory, { recursive: true, force: true });
