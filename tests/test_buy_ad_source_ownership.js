'use strict';
const assert = require('node:assert/strict');
const Packet = require('../src/GameServer/Bot/Economy/StatsPacket');
const fs = require('node:fs');
const filename = require.resolve('../src/GameServer/Bot/Economy/BuyAdPolicy');
const loaded = { exports: {} }, priced = [];
const context = { economy: { moneyPrice: .001, worth: () => 10000 } };
const imports = {
    'GameServer/Items/ItemAcquisitionCatalog': { hasSource: id => [736, 1121].includes(Number(id)) },
    'GameServer/DataCache': { items: [{ selfId: 736, template: { price: 400 }, etc: {} },
        { selfId: 1121, template: { price: 8 }, etc: {} }] },
    'GameServer/Bot/Economy/PurchaseFunding': { budget: state => state.adena, spendable: () => 50000,
        goalTerms: (goal, itemId) => ({ itemId }) },
    'GameServer/Bot/Economy/ItemDisposition': { isQuestItem: () => false },
    'GameServer/Bot/Economy/MarketListingPolicy': { traderContext: () => context },
    'GameServer/Bot/Economy/MarketTownPolicy': { targetTownForItems: () => 'Giran' },
    'GameServer/Bot/Economy/MarketPricing': { bid: id => { priced.push(id); return { price: 3000, pricing: {} }; } }
};
new Function('invoke', 'require', 'module', fs.readFileSync(filename, 'utf8'))(
    name => imports[name] || {}, require('node:module').createRequire(filename), loaded);
const Policy = loaded.exports;
const state = { characterId: 42, adena: 50000 };
const goal = sourceType => ({ type: 'buy_craft_material', target: { itemId: 736, amount: 9 }, plan: { sourceType } });
assert.equal(Policy.bidFor(state, goal('npc')), null, 'direct NPC goal cannot create public demand');
assert.deepEqual(Policy.linesFor(state, goal('npc'), { watchList: [] }), [],
    'an empty public watch must not resurrect the excluded NPC goal');
const watch = [{ itemId: 1121, amount: 1, worth: 10000 }];
assert.deepEqual(Policy.linesFor(state, goal('npc'), { watchList: watch }).map(row => row.selfId), [1121],
    'NPC fallback must not take a public slot away from another item');
for (const source of ['afk', undefined]) {
    assert.equal(Policy.linesFor(state, goal(source), { watchList: [] })[0].selfId, 736,
        'player and future goals retain the existing bid path');
}
assert.deepEqual(Policy.linesFor(state, goal('npc'), { watchList: [{ key: 'stock:scrolls',
    itemId: 736, amount: 2, worth: 10000, valueHours: 1, valueRate: .1 }] }).map(row => row.count), [2],
    'an independently prepared public alternative for the same item remains');
assert.equal(priced.length, 4, 'excluded goals never evaluate a price');

require('../src/Global');
invoke('GameServer/DataCache').init();
const NativePolicy = invoke('GameServer/Bot/Economy/BuyAdPolicy');
const Funding = invoke('GameServer/Bot/Economy/PurchaseFunding');
const retainedState = { characterId: 42, adena: 1000,
    stats: { money: [100, .01, 100, 0, .2, 300, 76, .1, 500, 1458] } };
const retainedIntent = { key: 'power:76:7', itemId: 1458, amount: 10, price: 50,
    recipeId: 0, valueHours: 1, valueRate: .1 };
const requested = { selfId: 1458, count: 10, price: 50, purchaseCap: Infinity, intent: retainedIntent };
const owned = [{ kind: 'buy_ad', storeType: 3, town: 'Dion', selfId: 1458, count: 4, price: 110 }];
const resized = NativePolicy.retainedLines(retainedState, [requested], owned, 'Dion')[0];
assert.equal(Funding.spendable(retainedState, 0, { r: .1 }), 600);
assert.equal(resized.price, 110); assert.equal(resized.count, 5,
    'retained quantities protect both survival money and higher-priority funded wishes');
assert.equal(resized.intent.amount, 5); assert.equal(resized.intent.price, 110);
assert.equal(requested.count, 10); assert.equal(retainedIntent.amount, 10, 'preparation does not mutate its inputs');
assert.equal(owned[0].price, 110, 'quantity preparation never reprices a native line');
assert.equal(NativePolicy.retainedLines(retainedState, [{ ...requested, count: 3 }], owned, 'Dion')[0].count, 3,
    'a cheaper remaining order cannot grow beyond the prepared need');
assert.equal(NativePolicy.retainedLines(retainedState, [requested], [{ ...owned[0], price: 700 }], 'Dion').length, 0,
    'a retained unit that no longer fits the budget withdraws instead of publishing zero units');
assert.equal(NativePolicy.retainedLines(retainedState, [requested], owned, 'Giran')[0].price, 50,
    'a different town is a new native identity, so it uses the prepared opening price');
const capped = NativePolicy.retainedLines(retainedState,
    [{ ...requested, price: 100, purchaseCap: 105 }], owned, 'Dion')[0];
assert.equal(capped.price, 100); assert.equal(capped.count, 6,
    'a finite violated purchase cap sizes the order at the price the fenced writer will install');
const survival = NativePolicy.retainedLines(retainedState,
    [{ ...requested, survivalCost: 250, intent: { ...retainedIntent, valueRate: .001 } }], owned, 'Dion')[0];
assert.equal(survival.count, 2, 'an unfunded stock root may spend only its explicitly prepared survival tranche');
const alternatives = NativePolicy.retainedLines(retainedState,
    [requested, { ...requested, selfId: 1459, intent: { ...retainedIntent, itemId: 1459 } }],
    [...owned, { ...owned[0], selfId: 1459 }], 'Dion');
assert.deepEqual(alternatives.map(row => row.count), [5, 5],
    'conditional alternatives each use their root allowance without reserving cash for another ad');
const Intent = require('../src/GameServer/Bot/Economy/TradeIntent');
const Pricing = invoke('GameServer/Bot/Economy/MarketPricing');
const Counters = invoke('GameServer/Bot/Economy/MarketCounters');
const npc = { sourceType: 'npc', quoted: true, executable: true };
const economy = { network: { plans: new Map([['item:736', npc]]) }, watchList: [],
    hourAdena: 10000, moneyPrice: .001, worth: () => 10000 };
assert.equal(Intent.npcOwnsPurchase(economy, 736), true);
for (const deferred of [{ intentPending: true }, { watchList: undefined },
    { watchList: [{ itemId: 736 }] }, { network: { plans: new Map([['item:736', { ...npc, executable: false }]]) } },
    { network: { plans: new Map([['item:736', { ...npc, quoted: false }]]) } }, { network: {} }]) {
    assert.equal(Intent.npcOwnsPurchase({ ...economy, ...deferred }, 736), false,
        'unknown preparation and independently projected alternatives never retire an ad');
}
const trip = () => 0; trip.details = () => ({ known: true, hours: 0, fees: 0 });
const board = { first: () => null, list: () => [], itemRevision: () => 0 };
const ctx = Pricing.traderContext(state, { economy, board, tripCost: trip,
    persona: { traits: {} }, findSpot: () => null, timestamp: 1800000000000 });
assert.equal(Pricing.bid(736, ctx, { units: 9, worth: 10000, cap: 10000, rollKey: ['test'] }), null);
assert.equal(ctx.canBuy({ selfId: 736, enchant: 1 }), true, 'enchanted goods are not equivalent to NPC stock');
const line = { ownerId: 42, lineId: 7, recordId: 8, selfId: 736, enchant: 0,
    storeType: 3, count: 9, price: 3056, revision: 4,
    pricing: { worth: 10000, seenCounter: 0, seenCount: 9, seenFills: 0, seenAt: ctx.timestamp } };
const original = Counters.counter;
try {
    Counters.counter = () => ({ deals: 0 });
    const moved = Pricing.lookOwn(state, [line], ctx);
    assert.deepEqual(moved.withdrawals.map(row => row.lineId), [7],
        'source ownership itself retires a stale bid without price movement, deals or a new roll');
    assert.equal(moved.withdrawals[0].expectedRevision, 4);
    assert.deepEqual(moved.withdrawals[0].previousPricing, line.pricing);
    const unknown = Pricing.traderContext(state, { economy: { ...economy, intentPending: true },
        board, tripCost: trip, persona: { traits: {} }, findSpot: () => null, timestamp: ctx.timestamp });
    // (A bid above a confirmed cheaper purchase is still lowered: MarketPricing.look's cap rule.)
    assert.equal(Pricing.lookOwn(state, [line], unknown)?.withdrawals?.length || 0, 0,
        'pending source preparation cannot withdraw a line');
} finally { Counters.counter = original; }
const Listing = invoke('GameServer/Bot/Economy/MarketListingPolicy');
const priorContext = Listing.traderContext, priorBid = Pricing.bid;
try {
    Listing.traderContext = () => ({ economy: { moneyPrice: .00001, worth: () => 10000 } });
    for (const sample of [
        { id: 2004571, name: 'PoleFarm', wallet: 988520, price: 2948, count: 331, oldPrice: 3033, oldCount: 318,
            expected: 325, money: [47353, .0000212, 0, 0, .000591, 345648, 76] },
        { id: 2005478, name: 'clo4k', wallet: 5831800, price: 2386, count: 2440, oldPrice: 2455, oldCount: 2371,
            expected: 2375, money: [12453, .0000803, 0, 0, .000423, 3965896, 76] }
    ]) {
        Pricing.bid = () => ({ price: sample.price, count: sample.count, purchaseCap: Infinity, pricing: {} });
        const liveCase = { characterId: sample.id, adena: sample.wallet, stats: { money: sample.money } };
        const [prepared] = NativePolicy.linesFor(liveCase, null, {
            watchList: [{ itemId: 1458, amount: sample.count, key: 'power:76:7', recipeId: 0,
                worth: sample.price, valueHours: 202, valueRate: Packet.fundedRatio(sample.money, 0) }],
            board: { ownerLines: () => [{ kind: 'buy_ad', storeType: 3, town: 'Dion', selfId: 1458,
                count: sample.oldCount, price: sample.oldPrice }] }, townFor: () => 'Dion'
        });
        assert.equal(prepared.price, sample.oldPrice); assert.equal(prepared.count, sample.expected,
            `worker preparation sizes ${sample.name}'s observed crystal order at the retained native price`);
        assert.equal(prepared.intent.amount, sample.expected); assert.equal(prepared.intent.price, sample.oldPrice);
        assert(prepared.count * prepared.price <= liveCase.adena);
    }
} finally { Listing.traderContext = priorContext; Pricing.bid = priorBid; }
console.log('PASS source ownership: NPC fallback/direct bids excluded, player/future alternatives retained, native look withdrawal fenced');
