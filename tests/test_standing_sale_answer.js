'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
invoke('GameServer/DataCache').init();
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
const Listing = invoke('GameServer/Bot/Economy/MarketListingPolicy');
const Rolls = require('../src/GameServer/Bot/AI/TendencyRoll');
const board = new BoardIndex();
board.put({ id: 77, ownerId: 99, kind: 'buy_ad', custodyPolicy: 1, revision: 4,
    storeType: 3, town: 'Dwarven Village', lines: [{ lineId: 78, selfId: 1869, count: 5, price: 657 }] });
const state = { characterId: 42, level: 30, adena: 10000, stats: {}, activity: 'shopping',
    currentRegion: 'Dwarven Village', inventory: { 1869: { selfId: 1869, amount: 2, kind: 'Other.Material' } } };
const trip = () => 0; trip.details = () => ({ known: true, hours: 0, fees: 0 });
const options = { board, now: 1800000000000, stockQuotes: true, tripCost: trip,
    economy: { hourAdena: 10000, moneyPrice: .001, worth: () => 0, trip, board },
    persona: { traits: { caution: 0 }, understanding: .3 }, npcOffersFor: () => [],
    keptAmounts: {}, preparedReservations: {}, kept: new Map([['1869:0', 237]]),
    conditionalKept: new Set(['1869:0']) };
const original = Rolls.roll;
try {
    Rolls.roll = () => .5;
    const sale = Listing.evaluate(state, options);
    assert.equal(sale.answers.length, 1, 'a conditional standing quote must still consider the profitable ready bid');
    assert.equal(sale.answers[0].count, 2);
    assert.equal(sale.listings.length, 0);
    assert.equal(Listing.evaluate(state, { ...options, conditionalKept: new Set() }).answers.length, 0,
        'escrow-backed shop stock retains the physical custody path');
    const Plan = require('../src/GameServer/Bot/Population/ColdEconomyPlan');
    board.put({ id: 87, ownerId: 42, kind: 'sell_ad', custodyPolicy: 1, revision: 2,
        storeType: 1, town: 'Dwarven Village', lines: [{ lineId: 88, selfId: 1869, count: 2, price: 237 }] });
    const iterator = Plan.prepare(state, { ...options.economy, network: { activity: { activity: 'hunting' } } }, options);
    let next; do { next = iterator.next(); } while (!next.done);
    assert.deepEqual(next.value.take, [3, 1869, 2, 77, 78, 4, 657],
        'the worker retains and executes its chosen sale rather than discarding the answer');
    assert.deepEqual(next.value.withdraw, [], 'the held quote is not withdrawn before acceptance');
    const Pricing = invoke('GameServer/Bot/Economy/MarketPricing');
    const finite = new BoardIndex();
    finite.put({ id: 91, ownerId: 95, storeType: 3, town: 'Dwarven Village',
        lines: [{ lineId: 92, selfId: 1869, count: 1, price: 700 }] });
    finite.put({ id: 93, ownerId: 96, storeType: 3, town: 'Dwarven Village',
        lines: [{ lineId: 94, selfId: 1869, count: 5, price: 600 }] });
    const ctx = Listing.traderContext(state, { ...options, board: finite });
    assert.equal(Pricing.bestAnswer(1869, ctx, { units: 5 }).line.lineId, 94,
        'bounded comparison uses actual available volume, not only the highest bid');
    const Price = invoke('GameServer/Bot/Economy/PriceDecision');
    let rowsRead = 0;
    const crowded = new Proxy(Array.from({ length: 1000 }, (_, at) => ({ ownerId: at + 1000,
        enchant: 0, price: 500, count: 1, town: 'Dwarven Village' })), {
        get(target, key) { if (/^\d+$/.test(String(key))) rowsRead++; return target[key]; }
    });
    const forecast = Price.marketFor(1869, { board: { list: () => crowded, itemRevision: () => 1 }, ownerId: 42 });
    assert.equal(rowsRead, 40, 'rival attention does not scan a growing crowd of listings');
    assert.equal(forecast.truncated, true);
    assert.equal(forecast.known, false, 'uninspected stock does not manufacture a forecast');
} finally { Rolls.roll = original; }
console.log('PASS standing conditional sale uses shared disposition');
