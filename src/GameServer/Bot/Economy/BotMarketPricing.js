const BotEconomyPricing = invoke('GameServer/Bot/Economy/BotEconomyPricing');
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

// Lazy: loaded on first use (load order), then kept; a require per call was ~3% of main busy (perf-map 2026-10-14).
let catalogue = null;
// Main's NPC price table as plain rows, for a worker's useNpcOfferSnapshot: one
// row per item a town NPC sells (gear, shots, potions, craft materials), so a
// worker prices every item as main does. Both workers get it (cold: the
// npc_offers catalogue, ColdSimulationCoordinator; clan: the planning context).
// Main only: a worker reads its snapshot instead.
let priceRows = { table: null, rows: null };
function npcPriceRows() {
    const table = (catalogue ||= require('../../Knowledge/GameDataCatalogue')).native().npcPrices();
    if (priceRows.table !== table) priceRows = { table, rows: Object.freeze([...(table || new Map())]
        .map(([selfId, price]) => Object.freeze({ selfId, price }))) };
    return priceRows.rows;
}
function npcPrice(item) {
    // An enchanted item is not equivalent to the ordinary NPC stock.
    if (item?.npcComparable === false || Number(item?.enchant || 0) > 0) return Infinity;
    if (snapshotPrices) return snapshotPrices.get(Number(item?.selfId)) ?? Infinity;
    return (catalogue ||= require('../../Knowledge/GameDataCatalogue')).native().npcPriceForItem(item?.selfId) ?? Infinity;
}

function referencePrice(item) {
    return Math.min(BotEconomyPricing.scalePrice(item?.basePrice), npcPrice(item));
}

function priceAt(item, ratio) {
    return Math.max(1, Math.floor(referencePrice(item) * ratio));
}

module.exports = { npcPrice, npcPriceRows, referencePrice, priceAt, useNpcOfferSnapshot };
