'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
const originalInvoke = global.invoke;
const Diagnostics = require('../src/GameServer/Bot/Economy/EconomyDiagnostics');
const originalCount = Diagnostics.count, originalActive = Diagnostics.active;
Diagnostics.active = () => true;
let builds = 0, hits = 0, reads = 0;
Diagnostics.count = (layer, outcome) => { if (layer === 'price_mixture') { if (outcome === 'build') builds++; else if (outcome === 'hit') hits++; } };
let median = Math.log(100), deals = 2, first = 80, index = .1;
const counters = { itemPriceEvidence: () => { reads++; return { logMedian: median, deals }; },
    firstPrice: () => first, counterOf: () => 'gear d', counter: () => ({ index }) };
const learning = { knowledgeEnabled: () => true, errorOf: (understanding, experience) => .2 * (1 - understanding) / (1 + experience) };
global.invoke = name => name === 'GameServer/Bot/Economy/MarketCounters' ? counters
    : name === 'GameServer/Bot/Economy/PriceLearning' ? learning : originalInvoke(name);
const Belief = require('../src/GameServer/Bot/Economy/PriceBelief');
global.invoke = originalInvoke;
let ask = 120, bid = 90;
const board = { first: (_id, storeType, options) => ({ price: storeType === 1 ? (options.excludeOwner === 2 ? ask + 20 : ask) : bid }) };
const ctx = { board, characterId: 1, timestamp: 123, knowledgeEnabled: false, understanding: .3, marketTrades: {} };
try {
    Belief.resetCaches();
    const a = Belief.prior(100, ctx), b = Belief.prior(100, { ...ctx });
    assert.deepEqual(a, b); assert.equal(builds, 1); assert.equal(hits, 1); assert.equal(reads, 2, 'reuse still reads current evidence');
    const expected = (median * 2 + Math.log(120) + Math.log(90) + (Math.log(80) + .1) * .5 + Math.log(80) * .3) / 4.8;
    assert.equal(a.mu, expected, 'native source order and numeric weights stay exact');
    const changes = [() => ask++, () => bid++, () => median += .1, () => deals++, () => first++, () => index += .2];
    for (const change of changes) { const previous = builds; change(); Belief.prior(100, ctx); assert.equal(builds, previous + 1, 'changed public source recomputes'); }
    const publicValue = Belief.prior(100, ctx);
    const another = Belief.prior(100, { ...ctx, characterId: 2 });
    assert.notEqual(another.mu, publicValue.mu, 'owner exclusions remain current, no other owner price leak');
    const demand = { ...ctx, derivedDemandValue: { known: true, value: 500, ownerId: 1 } };
    const supported = Belief.prior(100, demand);
    assert.equal(supported.K, publicValue.K + .3);
    assert.deepEqual(Belief.prior(100, { ...demand, characterId: 3 }), publicValue, 'unsupported owner demand is excluded');
    Belief.prior(100, ctx);
    const beforeKnowledge = builds;
    const personal = Belief.prior(100, { ...ctx, knowledgeEnabled: true });
    assert.equal(builds, beforeKnowledge, 'personal error is applied after shared public mixture');
    assert.equal(personal.mu, publicValue.mu + Math.log1p(personal.bias));
    const learned = Belief.prior(100, { ...ctx, knowledgeEnabled: true, marketTrades: { 'gear d': 20 } });
    assert.notEqual(personal.bias, learned.bias, 'own new experience immediately changes the personal error');
    const trained = Belief.prior(100, { ...ctx, knowledgeEnabled: true, understanding: 1 });
    assert.equal(trained.bias, 0); assert.equal(trained.mu, publicValue.mu);
    // Fixed item bound, independent of number of bots: eviction changes cost only.
    Belief.resetCaches(); Belief.prior(100, ctx);
    for (let id = 1000; id < 2024; id++) Belief.prior(id, ctx);
    const beforeEviction = builds; assert.deepEqual(Belief.prior(100, ctx), publicValue);
    assert.equal(builds, beforeEviction + 1, 'oldest item is evicted after 1024 other items');
    Belief.resetCaches(); const beforeReset = builds; Belief.prior(100, ctx); assert.equal(builds, beforeReset + 1);
    console.log('price mixture reuse/source freshness/owner knowledge/bounded lifecycle passed');
} finally { Diagnostics.count = originalCount; Diagnostics.active = originalActive; Belief.resetCaches(); }
