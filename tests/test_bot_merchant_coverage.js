const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const MerchantStoreConfigs = invoke('GameServer/Bot/MerchantStoreConfigs');
const ShopPlaces = invoke('GameServer/Bot/Economy/ShopPlaces');

DataCache.init();

const STARTER_MARKETS = [
    { town: 'Talking Island', isStall: (loc) => ShopPlaces.isOnSquare('Talking Island', loc) },
    { town: 'Elven Village', isStall: (loc) => ShopPlaces.isOnSquare('Elven Village', loc) },
    { town: 'Dark Elven Village', isStall: (loc) => ShopPlaces.isOnSquare('Dark Elven Village', loc) },
    { town: 'Orc Village', isStall: (loc) => ShopPlaces.isOnSquare('Orc Village', loc) },
    { town: 'Dwarven Village', isStall: (loc) => ShopPlaces.isOnSquare('Dwarven Village', loc) }
];
const SHOTS = new Set([1835, 2509, 3947]);

for (const market of STARTER_MARKETS) {
    const stores = Object.entries(MerchantStoreConfigs)
        .filter(([, store]) => store.town === market.town)
        .map(([name, store]) => ({ name, ...store }));
    const generalSellers = stores.filter((store) => store.storeType === 1 && store.items.some((item) => !SHOTS.has(Number(item.selfId))));
    const buyers = stores.filter((store) => store.storeType === 3);
    const shotSellers = stores.filter((store) => store.storeType === 1 && store.items.some((item) => SHOTS.has(Number(item.selfId))));

    assert(generalSellers.length > 0, `${market.town} must have a useful fixed WTS seller`);
    assert(buyers.length > 0, `${market.town} must have a fixed WTB liquidity buyer`);
    assert(shotSellers.length > 0, `${market.town} must have a no-grade shot seller`);
    for (const store of [...generalSellers, ...buyers]) {
        assert(market.isStall(store), `${store.name} must stand inside the captured ${market.town} market polygon`);
        assert(store.items.length > 0, `${store.name} must have configured stock or demand`);
        for (const item of store.items) {
            assert(DataCache.items.some((template) => Number(template.selfId) === Number(item.selfId)), `${store.name} references unknown item ${item.selfId}`);
        }
    }
}

console.log('Bot merchant coverage checks passed');
