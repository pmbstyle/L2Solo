const BotEconomyPricing = invoke('GameServer/Bot/Economy/BotEconomyPricing');
let snapshotPrices = null, snapshotRows = null;

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
    snapshotRows = Object.freeze([...snapshotPrices].map(([selfId, price]) => Object.freeze({ selfId, price })));
}

// Lazy: loaded on first use (load order), then kept; a require per call was ~3% of main busy (perf-map 2026-10-14).
let catalogue = null;
// Main's NPC price table as plain rows, for a worker's useNpcOfferSnapshot: one
// row per item a town NPC sells (gear, shots, potions, craft materials), so a
// worker prices every item as main does. Both workers get it (cold: the
// npc_offers catalogue, ColdSimulationCoordinator; clan: the planning context).
// A worker gets the rows of its snapshot. The array is kept while the table
// stands, so a reader may hold it as its own index's key (ShotMarketIndex).
let priceRows = { table: null, rows: null };
function npcPriceRows() {
    if (snapshotRows) return snapshotRows;
    const table = (catalogue ||= require('../../Knowledge/GameDataCatalogue')).native().npcPrices();
    if (priceRows.table !== table) priceRows = { table, rows: Object.freeze([...(table || new Map())]
        .map(([selfId, price]) => Object.freeze({ selfId, price }))) };
    return priceRows.rows;
}
function npcPrice(item) {
    // An enchanted item is not equivalent to the ordinary NPC stock.
    if (item?.npcComparable === false || Number(item?.enchant || 0) > 0) return Infinity;
    return npcPriceOf(item?.selfId);
}
// The table's price of an item id (the cheapest town NPC row), Infinity where
// no town NPC sells it.
function npcPriceOf(selfId) {
    if (snapshotPrices) return snapshotPrices.get(Number(selfId)) ?? Infinity;
    return (catalogue ||= require('../../Knowledge/GameDataCatalogue')).native().npcPriceForItem(selfId) ?? Infinity;
}

function referencePrice(item) {
    return Math.min(BotEconomyPricing.scalePrice(item?.basePrice), npcPrice(item));
}

function priceAt(item, ratio) {
    return Math.max(1, Math.floor(referencePrice(item) * ratio));
}

module.exports = { npcPrice, npcPriceOf, npcPriceRows, referencePrice, priceAt, useNpcOfferSnapshot };
