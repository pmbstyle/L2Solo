const assert = require('assert');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const isolated = require('./helpers/isolatedSocialDatabase')('market-adapter-worth');
require('../src/Global');
isolated.assertConfigured(options.default);

const DataCache = invoke('GameServer/DataCache');
const Counters = invoke('GameServer/Bot/Economy/MarketCounters');
const Listings = invoke('GameServer/Bot/Economy/MarketListingPolicy');
const BuyStore = invoke('GameServer/Bot/Economy/ColdMarketBuyStoreService');
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const BotMarket = invoke('GameServer/Bot/Economy/BotAfkMarketService');
const { BoardIndex, SELL, BUY } = require('../src/GameServer/AfkTrade/BoardIndex');

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
        // FX-E1/E3: a caller's requested4000 is not the bot's own worth.
        // Independently combine the public observations and its personal error;
        // never read the bid/pricing/context quote to manufacture the oracle.
        const Belief = invoke('GameServer/Bot/Economy/PriceBelief');
        const Learning = invoke('GameServer/Bot/Economy/PriceLearning');
        const Tendency = invoke('GameServer/Bot/AI/TendencyRoll');
        const persona = invoke('GameServer/Bot/AI/BotPersona').of(state);
        const key = Counters.counterOf(1864);
        const first = Counters.firstPrice(1864, now);
        const index = Counters.counter(key, now).index;
        const demand = Belief.demandValue(1864, now);
        // The original board is empty and all60 authored deals are3000.
        assert.strictEqual(board.list(1864, SELL).length, 0);
        assert.strictEqual(board.list(1864, BUY).length, 0);
        assert.deepStrictEqual(Counters.itemDeals(1864).prices, Array(21).fill(3000));
        const observations = [[Math.log(3000), 10]];
        if (first > 0 && index !== null) observations.push([Math.log(first) + index, .5]);
        if (demand > 0) observations.push([Math.log(demand), .3]);
        if (first > 0) observations.push([Math.log(first), .3]);
        const weight = observations.reduce((sum, row) => sum + row[1], 0);
        const centre = observations.reduce((sum, row) => sum + row[0] * row[1], 0) / weight;
        const bias = Learning.knowledgeEnabled()
            ? (2 * Tendency.roll('n45e', state.characterId, 1864) - 1)
                * Learning.errorOf(persona?.understanding ?? .3, 0, key) : 0;
        const ownWorth = Math.exp(centre + Math.log1p(bias));
        assert(Number.isFinite(ownWorth) && ownWorth > 0);
        const bid = BuyStore.bidFor(state, { type: 'buy_craft_material', id: 99,
            target: { itemId: 1864, amount: 20, adena: 4000 }, plan: { estimatedCost: 4000, priceSource: 'board' } }, { now, board });
        assert(bid && bid.price > 0, 'the affordable bid exists');
        assert(bid.pricing, 'BUY quote carries pricing state');
        assert.strictEqual(bid.pricing.price, bid.price);
        assert.strictEqual(bid.pricing.worth, ownWorth, 'BUY metadata preserves its own public/personal estimate');
        assert(bid.price < ownWorth, 'the quoted bid retains positive gain below its own worth');
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
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(isolated.directory, { recursive: true, force: true }));
