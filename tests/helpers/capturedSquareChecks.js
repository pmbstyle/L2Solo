'use strict';
// Checks shared by the author's captured-square tests (2fa4508b) on the one
// table of shop places (ShopPlaces, U19): a useful number of stores fit, every
// store stands in the stall area, SPACING from every other store and from the
// town's fixed merchants, and a square covered by shops has no place left.
const assert = require('assert');

const ShopPlaces = invoke('GameServer/Bot/Economy/ShopPlaces');
const MerchantStoreConfigs = invoke('GameServer/Bot/MerchantStoreConfigs');

const distance = (a, b) => Math.hypot(a.locX - b.locX, a.locY - b.locY);

module.exports = function checkCapturedSquare(town, { useful, groundZ = null }) {
    // The author recorded these squares for later market routing: bots do
    // not open shops here until that routing is decided.
    assert(!ShopPlaces.SHOP_TOWNS.includes(town), `${town} is not a bot shop town yet`);

    ShopPlaces._resetForTests();
    const fixed = Object.values(MerchantStoreConfigs).filter((store) => store.town === town);
    const taken = [];
    for (let index = 0; index < useful; index++) {
        const stall = ShopPlaces.take(town, `test:${town}:${index}`);
        assert(stall && ShopPlaces.isStallArea(town, stall), `the captured ${town} square must accommodate a useful market`);
        if (groundZ !== null) groundZ(stall);
        assert(fixed.concat(taken).every((other) => distance(stall, other) >= ShopPlaces.SPACING), 'keep every stall separate');
        taken.push(stall);
    }

    // Shops 20 apart over the whole square leave no place free.
    ShopPlaces._resetForTests();
    const box = ShopPlaces.stallBounds(town);
    const margin = ShopPlaces.PLAZAS[town].margin;
    let owner = 0;
    for (let locX = box.minX - margin - 20; locX <= box.maxX + margin + 20; locX += 20) {
        for (let locY = box.minY - margin - 20; locY <= box.maxY + margin + 20; locY += 20) {
            ShopPlaces.occupy(ShopPlaces.afkOwner(100000 + owner++), town, { locX, locY });
        }
    }
    assert.strictEqual(ShopPlaces.take(town, 'test:overflow'), null, 'a full plaza cannot overlap existing shops');
    ShopPlaces._resetForTests();
    return taken;
};
