'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Pricing = invoke('GameServer/Bot/Economy/MarketPricing');
const Look = invoke('GameServer/Bot/Economy/BoardLook');
const Belief = invoke('GameServer/Bot/Economy/PriceBelief');
const Counters = invoke('GameServer/Bot/Economy/MarketCounters');
const Decision = invoke('GameServer/Bot/Economy/PriceDecision');
const saved = { prior: Belief.prior, learn: Belief.learn, observations: Belief.lineObservations,
    market: Decision.marketFor, counter: Counters.counter };
let centre = 6;
const state = { characterId: 42, stats: {}, inventory: {} };
const line = { ownerId: 42, lineId: 7, recordId: 8, selfId: 1835, price: 9, count: 100,
    storeType: 3, custodyPolicy: 1, revision: 1, fills: 0,
    pricing: { price: 9, worth: 100, seenCounter: 0, seenAt: 1, seenCount: 100,
        seenFills: 0, sigma: .2, rival: 0 } };
const ctx = worth => ({ characterId: 42, timestamp: 1000, adena: 10000,
    economy: { worth: () => worth }, trader: { assertiveness: .5, caution: .5, wait: 0 },
    board: { itemRevision: () => 1, first: () => null }, npcOffersFor: () => [],
    reviewReasons: new Map([[7, 4]]) });
try {
    Belief.prior = () => ({ mu: Math.log(centre), K: 3 });
    Belief.learn = () => false; Belief.lineObservations = () => [];
    Counters.counter = () => ({ deals: 0 });
    Decision.marketFor = () => ({ known: false, units: 100, lot: 100, buyback: 1,
        buyersPerHour: NaN, truncated: false, demand: null });
    assert.equal(Pricing.look(state, [line], ctx(0)).withdrawals.length, 1,
        'current zero usefulness withdraws a formerly valuable bid');
    assert.equal(Pricing.look(state, [line], ctx(1)).withdrawals.length, 1,
        'current low positive usefulness cannot retain the saved high bid');
    assert.equal(Pricing.look(state, [line], ctx(null)), null,
        'unknown preparation is neither zero need nor permission to bid');
    const repriced = Pricing.look(state, [line], ctx(4));
    assert(repriced.reprices[0].price < 4);
    assert.equal(repriced.reprices[0].pricing.worth, 4, 'new quote checkpoints current usefulness');
    const seen = new Look.SeenLines();
    Look.review(state, [line], ctx(100), seen);
    const dropped = Look.review(state, [line], ctx(1), seen);
    assert.equal(dropped.withdrawals.length, 1, 'positive usefulness decline wakes quiet board review');
    const recovered = { ...line, pricing: { ...line.pricing, worth: 0 } };
    const repaired = Look.review(state, [recovered], ctx(4), new Look.SeenLines());
    assert.equal(repaired.reprices[0].pricing.worth, 4, 'lost cold checkpoint uses current prepared value');
    const sell = { ...line, storeType: 1, price: 4, pricing: { ...line.pricing, price: 4, worth: 0 } };
    centre = 8;
    const sale = Pricing.look(state, [sell], ctx(100));
    assert.equal(sale.reprices[0].price, 8, 'old conditional stock quote follows current evidence');
    assert.equal(sale.reprices[0].previousPricing.price, 4, 'native previous-pricing fence remains');
    assert.equal(Pricing.look(state, [{ ...sell, custodyPolicy: 0 }], ctx(100)), null,
        'unknown forecast cannot reprice a backed shop as an unreserved advert');
    assert.equal(Pricing.look(state, [sell], { ...ctx(100), ownStock: { known: false } }), null,
        'unknown joint physical stock cannot create a replacement quote');
    assert.equal(Decision.chooseAsk({ mu: Math.log(8), K: 3 }, Decision.marketFor(),
        ctx(100).trader, ['test'], 4).known, false,
        'conditional quote repair never manufactures supported production income');
    assert.equal(Pricing.look(state, [sell], { ...ctx(100), canSell: () => false }).withdrawals.length, 1,
        'protected goods remain withdrawn rather than repriced');
    console.log('PASS current BUY usefulness, positive-change wake, unknown preparation, conditional SELL refresh and custody/forecast guards');
} finally {
    Belief.prior = saved.prior; Belief.learn = saved.learn; Belief.lineObservations = saved.observations;
    Decision.marketFor = saved.market; Counters.counter = saved.counter;
}
