'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
const Data = invoke('GameServer/DataCache');
Data.init();
const Pricing = invoke('GameServer/Bot/Economy/MarketPricing');
const Belief = invoke('GameServer/Bot/Economy/PriceBelief');
const prior = Belief.prior;
Belief.prior = () => ({ mu: Math.log(1000), K: 0 });
try {
    const item = { selfId: 1865, count: 100, enchant: 0 };
    const ctx = { characterId: 7, timestamp: 1800000000000,
        board: { list: () => [], itemRevision: () => 1 }, npcOffersFor: () => [],
        trader: { wait: 0, assertiveness: .5, caution: .5 }, moneyPrice: .001,
        economy: { worth: () => 0 }, travel: () => 0,
        travelDetails: () => ({ known: true, hours: 0, fees: 0 }) };
    const decide = (stockQuote, seed, extra = {}, context = ctx) => Pricing.disposition(item, context,
        { stockQuote, rollKey: ['owned-stock-test', seed], ...extra });
    assert.notEqual(decide(false, 1).action, 'list', 'unknown forecast does not enable a backed sale');
    let listed = 0;
    for (let seed = 0; seed < 100; seed++) {
        const result = decide(true, seed);
        assert.deepEqual(result, decide(true, seed), 'a repeated decision keeps the same roll');
        assert.equal(result.priced.market.known, false, 'no invented buyer forecast');
        assert.equal(result.priced.ask.known, false, 'quote does not promise revenue');
        assert.equal(result.priced.ask.stockQuote, true);
        assert(Number.isNaN(result.priced.ask.money));
        assert.equal(result.gain, 0, 'quote is not predicted income');
        assert.equal(result.priced.ask.price, 1000, 'price uses the permitted personal estimate');
        if (result.action === 'list') listed++;
        assert.notEqual(decide(true, seed, { room: 0 }).action, 'list', 'cannot retain unavailable capacity');
        assert.notEqual(decide(true, seed, { smallLot: true }).action, 'list', 'ordinary lot restriction still applies');
    }
    assert(listed > 0 && listed < 100, 'a first conditional offer is possible, not compulsory');
    assert.notEqual(decide(true, 77, {}, { ...ctx, ownStock: { known: false } }).action, 'list',
        'failed physical preparation cannot support a quote');
    const demandFor = applicableUnits => () => ({ known: true, origin: 'fixture', authority: { id: 1 },
        selfId: 1865, applicableUnits, delayHours: 0,
        availability: { from: ctx.timestamp, until: ctx.timestamp } });
    for (const applicableUnits of [0, 1000]) {
        const known = { ...ctx, demandFor: demandFor(applicableUnits) };
        assert.deepEqual(decide(true, 77, {}, known), decide(false, 77, {}, known),
            'known zero or positive demand keeps its existing finite outcome');
    }
    const Listing = invoke('GameServer/Bot/Economy/MarketListingPolicy');
    const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
    const ids = [1864, 1865, 1866, 1867, 1868, 1869, 1870, 1871, 1872, 1873];
    const state = { characterId: 4242, level: 40, adena: 50000, stats: { generatedCold: true },
        inventory: Object.fromEntries(ids.map(selfId => [selfId, { selfId, amount: 100, kind: 'Other.Material' }])) };
    const options = { now: ctx.timestamp, board: new BoardIndex(), persona: null,
        npcOffersFor: () => [], findSpot: () => null };
    assert.equal(Listing.evaluate(state, options).listings.length, 0, 'backed shop policy remains unchanged');
    const offered = Listing.evaluate(state, { ...options, stockQuotes: true });
    assert(offered.listings.length > 0, 'native stock/lot/price/slot policy admits a first field offer');
    assert(offered.listings.length <= Listing.BOARD_SLOTS);
    for (const row of offered.listings) {
        assert.equal(row.marketReason, 'stock_quote');
        assert.equal(row.count, state.inventory[row.selfId].amount);
        const decision = offered.decisions.find(d => d.item.selfId === row.selfId);
        assert.equal(decision.gain, 0, 'slot attention cannot become income');
        assert.equal(decision.priced.market.known, false);
    }
    assert.deepEqual(offered.listings, Listing.evaluate(state, { ...options, stockQuotes: true }).listings);
    console.log('Owned-stock quote decisions and native listing slots passed');
} finally { Belief.prior = prior; }
