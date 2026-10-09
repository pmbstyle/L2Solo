'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const filename = require.resolve('../src/GameServer/Bot/Economy/BuyAdPolicy');
const loaded = { exports: {} }, priced = [];
const context = { economy: { moneyPrice: .001, worth: () => 10000 } };
const imports = {
    'GameServer/Items/ItemAcquisitionCatalog': { hasSource: id => [736, 1121].includes(Number(id)) },
    'GameServer/DataCache': { items: [{ selfId: 736, template: { price: 400 }, etc: {} },
        { selfId: 1121, template: { price: 8 }, etc: {} }] },
    'GameServer/Bot/Economy/PurchaseFunding': { spendable: () => 50000 },
    'GameServer/Bot/Economy/ItemDisposition': { isQuestItem: () => false },
    'GameServer/Bot/Economy/MarketListingPolicy': { traderContext: () => context },
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
const Intent = require('../src/GameServer/Bot/Economy/TradeIntent');
const Pricing = invoke('GameServer/Bot/Economy/MarketPricing');
const Look = require('../src/GameServer/Bot/Economy/BoardLook');
const Counters = invoke('GameServer/Bot/Economy/MarketCounters');
const npc = { sourceType: 'npc', quoted: true, executable: true };
const economy = { network: { plans: new Map([['item:736', npc]]) }, watchList: [],
    hourAdena: 10000, moneyPrice: .001, worth: () => 10000 };
assert.equal(Intent.npcOwnsPurchase(economy, 736), true);
for (const deferred of [{ intentPending: true }, { routePending: true }, { watchList: undefined },
    { watchList: [{ itemId: 736 }] }, { network: { plans: new Map([['item:736', { ...npc, executable: false }]]) } },
    { network: { plans: new Map([['item:736', { ...npc, quoted: false }]]) } }, { network: {} }]) {
    assert.equal(Intent.npcOwnsPurchase({ ...economy, ...deferred }, 736), false,
        'unknown preparation and independently projected alternatives never retire an ad');
}
const trip = () => 0; trip.details = () => ({ known: true, hours: 0, fees: 0 });
const board = { first: () => null, itemRevision: () => 0 };
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
    const seen = new Look.SeenLines();
    const moved = Pricing.lookOwn(state, [line], ctx, seen);
    assert.deepEqual(moved.withdrawals.map(row => row.lineId), [7],
        'source ownership itself retires a stale bid without price movement, deals or a new roll');
    assert.equal(moved.withdrawals[0].expectedRevision, 4);
    assert.deepEqual(moved.withdrawals[0].previousPricing, line.pricing);
    const unknown = Pricing.traderContext(state, { economy: { ...economy, intentPending: true },
        board, tripCost: trip, persona: { traits: {} }, findSpot: () => null, timestamp: ctx.timestamp });
    assert.equal(Pricing.lookOwn(state, [line], unknown, new Look.SeenLines()), null,
        'pending source preparation cannot withdraw or reprice a line');
} finally { Counters.counter = original; }
console.log('PASS source ownership: NPC fallback/direct bids excluded, player/future alternatives retained, native look withdrawal fenced');
