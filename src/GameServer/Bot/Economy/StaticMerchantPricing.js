const ItemTemplateIndex = require('../../Item/ItemTemplateIndex');
const DataCache = invoke('GameServer/DataCache');
const BotEconomyPricing = invoke('GameServer/Bot/Economy/BotEconomyPricing');
const MerchantStoreConfigs = invoke('GameServer/Bot/MerchantStoreConfigs');
const NpcShopBuyLists = invoke('GameServer/World/Generics/NpcShopBuyLists');

const BUYBACK_RATIO = 0.9;
let npcOffers = new Map();
let npcRate = null;
function refreshNpcOffers() {
    const rate = invoke('GameServer/ProgressionRates').profile().multiplier;
    if (npcRate === rate) return;
    npcRate = rate;
    npcOffers = new Map();
    for (const line of NpcShopBuyLists.allOffers()) {
        const id = Number(line.selfId);
        if (!npcOffers.has(id)) npcOffers.set(id, []);
        npcOffers.get(id).push(line);
    }
}

function basePrice(selfId) {
    return Number(ItemTemplateIndex.find(DataCache.items, selfId)?.template?.price || 0);
}

function configuredPrice(line) {
    if (line.price !== undefined) return Number(line.price);
    const base = basePrice(line.selfId);
    return BotEconomyPricing.scalePrice(base > 0 ? base * (line.priceRate ?? 1) : 1);
}

function cheapestPurchase(selfId) {
    refreshNpcOffers();
    const id = Number(selfId);
    let minimum = Infinity;
    for (const line of npcOffers.get(id) || []) {
        minimum = Math.min(minimum, Number(line.price ?? basePrice(id)));
    }
    for (const store of Object.values(MerchantStoreConfigs)) {
        if (store.storeType !== 1) continue;
        for (const line of store.items || []) {
            if (Number(line.selfId) === id && Number(line.count ?? 1) > 0) {
                minimum = Math.min(minimum, configuredPrice(line));
            }
        }
    }
    return minimum;
}

function priceFor(store, line) {
    const price = configuredPrice(line);
    if (store.storeType !== 3) return price;
    // Bound fixed-buyer payouts below repeatable NPC and fixed-store supply.
    const ceiling = Math.floor(cheapestPurchase(line.selfId) * BUYBACK_RATIO);
    return Math.min(price, ceiling);
}

// The configured city merchants selling an item, by town: [{ town, price,
// sourceName }] (the shots' sellers: NPC shops do not sell them). A static
// table read once per rate; a purchase trip weighs them as the NPC.
let sellers = null;
let sellersRate = null;
function sellersOf(selfId) {
    const rate = invoke('GameServer/ProgressionRates').profile().multiplier;
    if (!sellers || sellersRate !== rate) {
        sellers = new Map();
        sellersRate = rate;
        for (const [name, store] of Object.entries(MerchantStoreConfigs)) {
            if (store?.storeType !== 1 || !store.town) continue;
            for (const line of store.items || []) {
                if (!(Number(line.count ?? 1) > 0)) continue;
                const id = Number(line.selfId);
                if (!sellers.has(id)) sellers.set(id, []);
                sellers.get(id).push({ town: store.town, price: configuredPrice(line), sourceName: name });
            }
        }
    }
    return sellers.get(Number(selfId)) || [];
}

module.exports = { BUYBACK_RATIO, cheapestPurchase, priceFor, sellersOf };
