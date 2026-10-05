const DataCache = invoke('GameServer/DataCache');
const BotEconomyPricing = invoke('GameServer/Bot/Economy/BotEconomyPricing');

let cachedSpawns = null;
let cachedNpcRate = null;
let npcPrices = new Map();
let snapshotPrices = null;

function indexOffers(offers) {
    const prices = new Map();
    for (const offer of offers) {
        const price = Number(offer.price || 0);
        if (price > 0) prices.set(Number(offer.selfId), Math.min(
            price, prices.get(Number(offer.selfId)) ?? Infinity
        ));
    }
    return prices;
}

function useNpcOfferSnapshot(offers) {
    // Workers receive immutable offers from the main process and must never
    // load town/world services to evaluate an item.
    snapshotPrices = indexOffers(offers || []);
}

let ProgressionRates; // resolved on first use; workers price from the offer snapshot

function npcPrice(item) {
    // An enchanted item is not equivalent to the ordinary NPC stock.
    if (item?.npcComparable === false || Number(item?.enchant || 0) > 0) return Infinity;
    if (snapshotPrices) return snapshotPrices.get(Number(item?.selfId)) ?? Infinity;
    const npcRate = (ProgressionRates ||= invoke('GameServer/ProgressionRates')).profile().multiplier;
    if (cachedSpawns !== DataCache.npcSpawns || cachedNpcRate !== npcRate) {
        const NpcShopBuyLists = invoke('GameServer/World/Generics/NpcShopBuyLists');
        const TownNpcCatalog = invoke('GameServer/Bot/Economy/TownNpcCatalog');
        cachedSpawns = DataCache.npcSpawns;
        cachedNpcRate = npcRate;
        const sellers = new Set(TownNpcCatalog.rows().map((row) => Number(row.npcSelfId)));
        npcPrices = indexOffers([...sellers].flatMap((seller) => NpcShopBuyLists.fetchForNpc(seller)));
    }
    return npcPrices.get(Number(item?.selfId)) ?? Infinity;
}

function referencePrice(item) {
    return Math.min(BotEconomyPricing.scalePrice(item?.basePrice), npcPrice(item));
}

function priceAt(item, ratio) {
    return Math.max(1, Math.floor(referencePrice(item) * ratio));
}

module.exports = { npcPrice, referencePrice, priceAt, useNpcOfferSnapshot };
