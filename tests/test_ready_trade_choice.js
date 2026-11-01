'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
const Data = invoke('GameServer/DataCache');
Data.init();
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
const Admission = require('../src/GameServer/Bot/Population/PartyAdmission');
const Choice = require('../src/GameServer/Bot/Economy/ReadyTradeChoice');
const board = new BoardIndex();
board.put({ id: 77, ownerId: 99, kind: 'sell_ad', custodyPolicy: 1, revision: 4,
    storeType: 1, town: 'Dwarven Village', lines: [{ lineId: 78, selfId: 1869, count: 2, price: 237 }] });
const state = { characterId: 42, inventory: {} };
const leaf = { activity: 'shopping', kind: 'buy', sourceType: 'afk', itemId: 1869, amount: 2,
    unitPrice: 237, quoted: true, executable: true, town: 'Dwarven Village' };
const economy = { network: { activity: leaf } };
assert.deepEqual(Choice.purchase(state, economy, board), [1, 1869, 2, 77, 78, 4, 237]);
for (const patch of [{ quoted: false }, { executable: false }, { sourceType: 'npc' },
    { activity: 'hunting' }, { unitPrice: 300 }, { amount: 3 }, { town: 'Giran' }, { amount: 0 }]) {
    assert.equal(Choice.purchase(state, { network: { activity: { ...leaf, ...patch } } }, board), null);
}
assert.equal(Choice.purchase(state, { ...economy, intentPending: true }, board), null);
assert.equal(Choice.purchase({ ...state, characterId: 99 }, economy, board), null);
assert.equal(Choice.purchase({ ...state, inventory: { 1869: { amount: 2 } } },
    { network: { activity: { ...leaf, heldAtDecision: 0 } } }, board), null,
    'the prepared need is not bought again after acquiring it');
assert.deepEqual(Choice.purchase({ ...state, inventory: { 1869: { amount: 1 } } },
    { network: { activity: { ...leaf, heldAtDecision: 0 } } }, board), [1, 1869, 1, 77, 78, 4, 237]);
for (const phase of ['hot', 'cold']) {
    assert.equal(Choice.purchase({ ...state, phase, party: { partyId: 'buyer-party' } }, economy, board), null);
    Admission.configureTradeAdmission(id => id === 99 ? { phase, partyId: 'seller-party' } : null);
    assert.equal(Choice.purchase({ ...state, phase }, economy, board), null, 'grouped seller is never selected');
    assert.equal(Choice.resolve([1, 1869, 2, 77, 78, 4, 237], board, 42), null, 'a selected seller who joined a party is invalidated');
}
Admission.configureTradeAdmission(() => null);
{
    const seller = { characterId: 99, phase: 'cold', activity: 'hunting', adena: 1000000,
        loc: { locX: 83396, locY: 147904, locZ: -3400 }, stats: { money: [1000, .001, 0, 500] } };
    Admission.configureTradeAdmission(id => id === 99 ? seller : null);
    assert.equal(Choice.purchase(state, economy, board), null, 'a seller cannot offer a paid trip using protected funds');
    assert.equal(Choice.resolve([1, 1869, 2, 77, 78, 4, 237], board, 42), null, 'the main thread also skips the unaffordable quote');
    seller.stats.money = [1000, .001, 0, 0];
    assert(Choice.purchase(state, economy, board), 'the unchanged ad becomes available when the owner can pay');
    seller.stats.money = [1000, .001, 0, 500];
    seller.loc = { locX: 115072, locY: -178176, locZ: -800 };
    assert(Choice.purchase(state, economy, board), 'a free local trip remains possible even with protected funds');
    Admission.configureTradeAdmission(() => null);
}
const Plan = require('../src/GameServer/Bot/Population/ColdEconomyPlan');
function prepared(input) {
    const iterator = Plan.prepare(input, economy, { board });
    let next; do { next = iterator.next(); } while (!next.done);
    return next.value;
}
for (const phase of ['hot', 'cold']) assert.deepEqual(prepared({ ...state, phase, activity: 'hunting' }),
    { take: [1, 1869, 2, 77, 78, 4, 237], sell: [], withdraw: [], travel: null },
    'the actual shared plan takes the selected quote before evaluating a new public bid');
assert.equal(Choice.resolve([1, 1869, 2, 77, 78, 4, 237], board, 42).ownerId, 99);
for (const tuple of [[1, 1869, 3, 77, 78, 4, 237], [1, 1869, 2, 77, 78, 5, 237],
    [1, 1869, 2, 77, 78, 4, 238], [3, 1869, 2, 77, 78, 4, 237], [1, 1869, 2, 77, 79, 4, 237],
    [1, 1869, 2, 77, 78, 4, Infinity], [1, 1869, 2]]) assert.equal(Choice.resolve(tuple, board, 42), null);
assert.equal(Choice.resolve([1, 1869, 2, 77, 78, 4, 237], board, 99), null);
let inspected = 0;
const observed = board.heads.bind(board);
board.heads = (id, side, options) => { assert.equal(options.maxInspected, 20); inspected++;
    return observed(id, side, options); };
Choice.purchase(state, economy, board);
assert.equal(inspected, 1, 'one indexed query for the already selected item');
assert(Buffer.byteLength(JSON.stringify(prepared(state))) < 256);
{
    // A buy part not prepared is absent from the packet, not a page (no d):
    // main's next state copy holds the same build, so a refresh cannot prepare it.
    const iterator = Plan.prepare({ ...state, activity: 'hunting', stats: {} }, { network: {}, intentPending: true }, { board });
    let next; do { next = iterator.next(); } while (!next.done);
    assert.equal(next.value.buyAds, undefined);
    assert.equal(next.value.d, undefined);
    // A pending incoming delivery is main's: its settlement continues the page.
    const incoming = Plan.prepare({ ...state, activity: 'hunting', stats: {}, incomingPending: true },
        { network: {}, intentPending: true }, { board });
    do { next = incoming.next(); } while (!next.done);
    assert.equal(next.value.buyAds, undefined);
    assert.equal(next.value.d, 1);
}
const Survival = invoke('GameServer/Bot/Population/SurvivalFloor');
const oldFloor = Survival.forState;
const oldEvaluate = invoke('GameServer/Bot/Economy/MarketListingPolicy').evaluate;
try {
    Survival.forState = () => ({ action: 'rest' });
    invoke('GameServer/Bot/Economy/MarketListingPolicy').evaluate = () => { throw Error('after_survival_gate'); };
    assert.throws(() => prepared(state), /after_survival_gate/,
        'a ready quote does not bypass the existing survival floor');
} finally { Survival.forState = oldFloor;
    invoke('GameServer/Bot/Economy/MarketListingPolicy').evaluate = oldEvaluate; }
console.log('PASS ready trade selection');

// Surplus sales may interrupt a prepared personal purchase, while the wish
// and its selected quote remain ready after the physical sale is fulfilled.
const Listing = invoke('GameServer/Bot/Economy/MarketListingPolicy');
const evaluate = Listing.evaluate;
const buying = structuredClone(economy);
buying.network.focus = ['power:283:14', 1, 0, 0, 0];
const original = structuredClone(buying);
board.put({ id: 88, ownerId: 100, kind: 'buy_ad', custodyPolicy: 1, revision: 2,
    storeType: 3, town: 'Dwarven Village', lines: [{ lineId: 89, selfId: 1864, count: 2, price: 100 }] });
const bid = board.first(1864, 3);
try {
    Listing.evaluate = input => ({ listings: [], answers: Number(input.inventory?.[1864]?.amount) > 0
        ? [{ line: bid, count: 2 }] : [] });
    const prepare = input => {
        const iterator = Plan.prepare(input, buying, { board });
        let next; do { next = iterator.next(); } while (!next.done);
        return next.value;
    };
    for (const phase of ['hot', 'cold']) {
        const seller = { ...state, phase, activity: 'hunting', inventory: { 1864: { amount: 2 } } };
        assert.deepEqual(prepare(seller).take, [3, 1864, 2, 88, 89, 2, 100],
            'the profitable surplus sale is allowed while the personal purchase is selected');
        assert.deepEqual(prepare({ ...seller, inventory: {} }).take, [1, 1869, 2, 77, 78, 4, 237],
            'after the sale the same personal purchase resumes');
        assert.deepEqual(buying, original, 'the temporary deal never replaces the wish or selected purchase');
    }
} finally { Listing.evaluate = evaluate; }
console.log('PASS trade detour preserves and resumes the selected purchase');

const Pricing = invoke('GameServer/Bot/Economy/MarketPricing');
const stockState = { ...state, level: 30, activity: 'hunting', stats: {},
    inventory: { 1463: { selfId: 1463, amount: 100, kind: 'Other.Shot' } } };
const stockEconomy = { hourAdena: 1000, moneyPrice: .001, persona: { traits: {}, understanding: .3 },
    network: {}, stock: kind => kind === 'shots' ? { itemId: 1463, target: 60 }
        : { itemId: 1060, target: 0 } };
const trip = () => 0; trip.details = () => ({ known: true, fees: 0, hours: 0 });
const context = input => Pricing.traderContext(input, { economy: stockEconomy, board, tripCost: trip });
const advertised = { storeType: 1, custodyPolicy: 1, selfId: 1463, count: 100, enchant: 0 };
assert.equal(context(stockState).saleCount(advertised), 40, 'the board offers only surplus over personal ammunition');
assert.equal(context({ ...stockState, inventory: { 1463: { ...stockState.inventory[1463], amount: 20 } } })
    .saleCount(advertised), 0, 'consumed stock below the personal reserve has no saleable remainder');
assert.equal(context({ ...stockState, stats: { tradeMeeting: [1, 1] } }).saleCount(advertised), 100,
    'accepted meeting custody keeps its quote until completion');
assert.equal(context(stockState).saleCount({ ...advertised, custodyPolicy: 0 }), 100,
    'backed shop stock is independent of ammunition still in the bag');
console.log('PASS own conditional quantities respect current ammunition and accepted custody');
