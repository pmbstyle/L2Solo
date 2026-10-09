'use strict';

const Database = invoke('Database');
const ShopPlaces = invoke('GameServer/Bot/Economy/ShopPlaces');

const MIGRATION_KEY = 'giranShopDistributionV1';

// Before projections or players exist, move the old centre-filled bot shops
// once. Players and crafting stations reserve their original positions first.
// Native storage changes only coordinates/revisions, never shop stock or bags.
async function restore(shops) {
    const [marker] = await Database.execute(['SELECT value FROM world_meta WHERE key = ?', [MIGRATION_KEY]]);
    if (marker) return { skipped: true };

    const physical = shops.filter(shop => (shop.kind || 'shop') === 'shop');
    physical.forEach(shop => ShopPlaces.occupy(ShopPlaces.afkOwner(shop.ownerId), shop.town, shop));
    // LifeState's initial cache may not be loaded until BotManager starts.
    const crafters = await Database.execute([`SELECT characterId, locX, locY, locZ, statsJson FROM bot_life_state
        WHERE activity = 'crafting' AND json_extract(statsJson, '$.craftShop.town') = 'Giran'`]);
    crafters.forEach(row => ShopPlaces.syncState(row.characterId, {
        activity: 'crafting', loc: row, stats: JSON.parse(row.statsJson)
    }));

    const moving = physical.filter(shop => shop.town === 'Giran' && String(shop.ownerAccount || '').startsWith('bot_'))
        .sort((a, b) => Number(a.id) - Number(b.id));
    moving.forEach(shop => ShopPlaces.release(ShopPlaces.afkOwner(shop.ownerId)));
    let committed = false;
    try {
        const placements = [];
        for (const shop of moving) {
            const loc = ShopPlaces.take('Giran', ShopPlaces.afkOwner(shop.ownerId));
            if (!loc) {
                utils.infoWarn('AfkTrade', 'Giran shop distribution deferred: plaza is full');
                return { skipped: true, reason: 'plaza_full:Giran' };
            }
            placements.push({ id: Number(shop.id), ownerId: Number(shop.ownerId),
                expectedRevision: Number(shop.revision), ...loc });
        }
        const result = await Database.relocateBotAfkTradeShops('Giran', placements, MIGRATION_KEY);
        if (result.skipped) return result;
        const byId = new Map(result.placements.map(loc => [loc.id, loc]));
        moving.forEach(shop => Object.assign(shop, byId.get(Number(shop.id))));
        committed = true;
        if (result.moved) utils.infoSuccess('AfkTrade', 'distributed %d Giran bot shops across the trading square', result.moved);
        return result;
    } finally {
        // A refused/full migration leaves every old position reserved.
        if (!committed) moving.forEach(shop => ShopPlaces.occupy(ShopPlaces.afkOwner(shop.ownerId), shop.town, shop));
    }
}

module.exports = { MIGRATION_KEY, restore };
