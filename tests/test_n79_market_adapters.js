const assert = require('assert');
require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const Counters = invoke('GameServer/Bot/Economy/MarketCounters');
const Listings = invoke('GameServer/Bot/Economy/MarketListingPolicy');
const BuyStore = invoke('GameServer/Bot/Economy/ColdMarketBuyStoreService');
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const BotMarket = invoke('GameServer/Bot/Economy/BotAfkMarketService');
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');

DataCache.init();
const now = 1800000000000;
const board = new BoardIndex({ groupOf: Counters.counterOf });
const state = { characterId: 4242, name: 'AdapterTrader', phase: 'cold', level: 40,
    adena: 50000, currentRegion: 'Giran', stats: { generatedCold: true },
    inventory: { 1864: { selfId: 1864, amount: 100, kind: 'Other.Material' } } };
Counters.reset();
for (let deal = 0; deal < 60; deal++) Counters.deal(1864, 3000, 20, now - (60 - deal) * 60000, 1);
let failures = 0;
async function contract(name, work) {
    try { await work(); console.log(`PASS ${name}`); }
    catch (error) { failures++; console.error(`FAIL ${name}: ${error.message}`); }
}

(async () => {
    await contract('sale producer sends line price/cursors without personal item book', () => {
        const sale = Listings.evaluate(state, { now, board, persona: null, npcOffersFor: () => [], findSpot: () => null });
        assert.strictEqual(sale.listings.length, 1, 'active demand yields a selected line');
        const line = sale.listings[0];
        assert(line.pricing, 'selected quote carries its own pricing state');
        assert.strictEqual(line.pricing.price, line.price);
        assert.strictEqual(line.pricing.seenCounter, Counters.counter(Counters.counterOf(1864), now).deals);
        assert.strictEqual(line.pricing.seenItem, Counters.itemDeals(1864).deals);
        assert.strictEqual(line.pricing.seenFills, 0);
        assert.strictEqual('book' in sale, false);
    });
    await contract('BUY producer carries authored worth and no personal book', () => {
        const bid = BuyStore.bidFor(state, { type: 'buy_craft_material', id: 99,
            target: { itemId: 1864, amount: 20, adena: 4000 }, plan: { estimatedCost: 4000, priceSource: 'board' } });
        assert(bid && bid.price > 0, 'the affordable bid exists');
        assert(bid.pricing, 'BUY quote carries pricing state');
        assert.strictEqual(bid.pricing.price, bid.price);
        assert.strictEqual(bid.pricing.worth, 4000);
        assert.strictEqual('book' in bid, false);
    });
    await contract('metadata-only review reaches native adapter', async () => {
        const original = AfkTrade.repriceBotLines;
        let received;
        AfkTrade.repriceBotLines = async (ownerId, reprices, settings) => {
            received = { ownerId, reprices, settings };
            return { changed: 0, updated: 1 };
        };
        const updates = [{ recordId: 7, lineId: 11, expectedRevision: 4,
            previousPricing: { price: 100, seenCounter: 2, seenItem: 1, rival: 0, worth: 0, seenFills: 0 },
            pricing: { price: 100, seenCounter: 3, seenItem: 2, rival: 100, worth: 0, seenFills: 1 } }];
        try {
            const result = await BotMarket.applyReview(4242, { updates, reprices: [], withdrawals: [] });
            assert.deepStrictEqual(received.settings.updates, updates, 'unchanged quote still checkpoints its observations');
            assert.strictEqual(result.updated, 1);
        } finally { AfkTrade.repriceBotLines = original; }
    });
    if (failures) process.exitCode = 1;
})().catch((error) => { console.error(error); process.exitCode = 1; });
