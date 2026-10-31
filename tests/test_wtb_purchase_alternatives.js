'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Alternative = require('../src/GameServer/Bot/Economy/BidPurchaseAlternative');
const Decision = invoke('GameServer/Bot/Economy/PriceDecision');
const Pricing = invoke('GameServer/Bot/Economy/MarketPricing');
const Counters = invoke('GameServer/Bot/Economy/MarketCounters');
const { BoardIndex, SELL, BUY } = require('../src/GameServer/AfkTrade/BoardIndex');
const Party = require('../src/GameServer/Bot/Population/PartyAdmission');
const ITEM = 413, now = 1800000000000;
const buyer = { characterId: 1, activity: 'hunting', stats: {} };
const board = new BoardIndex();
let npc = [], routes = { Dion: { known: true, hours: 0, fees: 0 } };
const ctx = { state: buyer, characterId: 1, hour: 600000, adena: 1000000, board,
    travelDetails: town => routes[town] || { known: false, hours: NaN, fees: NaN },
    npcOffersFor: () => npc, timestamp: now, understanding: .5, knowledgeEnabled: false,
    marketTrades: {}, trader: { wait: 0, assertiveness: .5, caution: .5 }, economy: { worth: () => 34454032 } };
const cap = (units = 1, money = 1000000, extra = {}) => Alternative.cap(ITEM, ctx, { units, money, town: 'Dion', ...extra });
const shop = (id, price, count = 1, extra = {}) => board.put({ id, ownerId: id + 10, revision: 1,
    storeType: SELL, town: 'Dion', ...extra, lines: [{ lineId: id, selfId: ITEM, enchant: extra.enchant || 0, count, price }] });
Party.configureTradeAdmission(() => null);

// The reported gear case: high subjective value cannot beat a real shop.
shop(1, 74136);
assert.equal(cap(), 74136);
routes.Dion = { known: true, hours: 50 / 3600, fees: 7800 };
assert.equal(cap(), 74136, 'identical nonzero trips cancel to the exact shop price');
routes.Dion = { known: true, hours: 0, fees: 0 };
const belief = { mu: Math.log(105000), K: 5.8 };
const market = { units: 1, lot: 1, buyersPerHour: NaN, purchaseCap: cap() };
for (let seed = 0; seed < 30; seed++) {
    const bid = Decision.chooseBid(belief, market, ctx.trader, { worth: 34454032, cap: 1000000 }, ['wtb', seed], 188565);
    assert(bid && bid.price <= 74136, 'new and standing bids obey the outside purchase');
}
assert.equal(Decision.chooseBid(belief, { ...market, purchaseCap: 50000 }, ctx.trader,
    { worth: 34454032, cap: 1000000 }, ['below-grid']).price, 50000, 'cheap supply below the grid is still a priced option');

// Full quantity, one shared trip, affordable cash fees and travel time.
assert.equal(cap(10), Infinity, 'one cheap unit cannot fill a ten-unit order');
npc = [{ sourceType: 'npc', selfId: ITEM, price: 126636, town: 'Dion', available: true }];
assert.equal(cap(2), Math.floor((74136 + 126636) / 2));
board.clear();
assert.equal(cap(), 126636);
assert.equal(cap(10), Infinity, 'an unaffordable NPC basket is not executable');
routes.Giran = { known: true, hours: .01, fees: 1000 };
npc = [{ sourceType: 'npc', selfId: ITEM, price: 116083, town: 'Giran', available: true }];
assert.equal(cap(), 123083, 'NPC price plus fare and foregone hunting');
routes.Dion = { known: true, hours: .005, fees: 500 };
assert.equal(cap(), 119583, 'subtract the WTB meeting trip before setting its unit ceiling');
assert.equal(cap(1, 116500), Infinity, 'price fits the wallet but the fare does not');
assert.equal(cap(1, 499), 0, 'the buyer cannot fund the WTB meeting fare either');
routes.Giran = { known: false, hours: NaN, fees: NaN };
assert.equal(cap(), Infinity, 'unknown routes are never free alternatives');
routes.Dion = { known: true, hours: 0, fees: 0 };
npc = [{ sourceType: 'npc', selfId: ITEM, price: 100, town: 'Dion', available: false }];
assert.equal(cap(), Infinity);
npc = [{ sourceType: 'npc', selfId: ITEM, price: 100, count: 1, town: 'Dion', available: true }];
assert.equal(cap(2), Infinity);
assert.equal(cap(1, 1000000, { enchant: 1 }), Infinity, 'ordinary NPC stock cannot replace enchanted gear');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const disabled = Config.staticShotsDisabled;
try {
    Config.staticShotsDisabled = true;
    assert.equal(Alternative.cap(1463, ctx, { units: 1, money: 1000000, town: 'Dion' }), Infinity,
        'an NPC purchase forbidden by the production policy is not executable');
} finally { Config.staticShotsDisabled = disabled; }
npc = [];
shop(1, 100, 1, { ownerId: 1 });
shop(2, 100, 1, { enchant: 1 });
assert.equal(cap(), Infinity, 'own stock and different enchants do not provide the item');

// Public conditional quantities are not reservations. The buyer's accepted
// executable quote and party admission are required before using one.
board.clear();
shop(3, 100, 1, { custodyPolicy: 1, kind: 'sell_ad' });
assert.equal(cap(), Infinity);
ctx.economy.activity = { activity: 'shopping', kind: 'buy', sourceType: 'afk', quoted: true,
    executable: true, itemId: ITEM, town: 'Dion', unitPrice: 100, amount: 1 };
assert.equal(cap(), 100);
Party.configureTradeAdmission(() => ({ partyId: 'busy' }));
assert.equal(cap(), Infinity, 'a party-bound seller cannot attend the meeting');
Party.configureTradeAdmission(() => null);
delete ctx.economy.activity;

// A small source change still retires an overpriced accepted bid, even when
// personal noise would normally keep the previous quote untouched.
board.clear();
shop(1, 74000);
Counters.reset();
const line = { ownerId: 1, recordId: 2, lineId: 2, revision: 1, storeType: BUY, selfId: ITEM,
    town: 'Dion', custodyPolicy: 1, count: 1, price: 188565, enchant: 0, fills: 0,
    pricing: { price: 188565, seenCounter: 0, seenItem: 0, seenFills: 0, rival: 188564,
        worth: 34454032, sigma: 1, seenAt: now, seenCount: 1 } };
board.put({ id: 3, ownerId: 99, storeType: BUY, town: 'Dion', lines: [{ lineId: 3, selfId: ITEM, count: 1, price: 188565 }] });
const review = Pricing.look(buyer, [line], { ...ctx, preparedWorth: () => 34454032, reviewReasons: new Map([[2, 1]]) });
assert(review?.reprices?.[0]?.price <= 74000, 'outside option overrides the small-movement hold');
const pendingWorth = Pricing.look(buyer, [line], { ...ctx, preparedWorth: () => NaN, reviewReasons: new Map([[2, 4]]) });
assert.equal(pendingWorth.reprices[0].price, 74000,
    'unknown new usefulness cannot preserve an old bid above a confirmed cheaper purchase');
assert.equal(pendingWorth.reprices[0].pricing.worth, line.pricing.worth,
    'a downward correction retains the original authored worth');
const fresh = Pricing.bid(ITEM, ctx, { units: 1, worth: 34454032, cap: 1000000,
    town: 'Dion', money: 1000000, rollKey: ['new-ad'] });
assert(fresh?.price <= 74000, 'publication and review use the same executable outside option');
const RetryLook = invoke('GameServer/Bot/Economy/BoardLook'), retrySeen = new RetryLook.SeenLines();
const lookCtx = { ...ctx, preparedWorth: () => 34454032 };
assert(RetryLook.review(buyer, [line], lookCtx, retrySeen)?.reprices?.[0]?.price <= 74000);
assert(RetryLook.review(buyer, [line], lookCtx, retrySeen)?.reprices?.[0]?.price <= 74000,
    'an undelivered correction retries at the next own look without another source change');

// A useful, funded item still needs fresh consent at the actual agreed price.
const agreed = (price, count = 1) => ({ payer: 0, selfId: ITEM, enchant: 0, count, price });
assert.throws(() => Alternative.assertMeetingPurchase([agreed(188565)], 0, 'Dion', ctx),
    /trade_meeting_purchase_price_changed/);
assert.doesNotThrow(() => Alternative.assertMeetingPurchase([agreed(74000)], 0, 'Dion', ctx));
assert.doesNotThrow(() => Alternative.assertMeetingPurchase([agreed(188565), agreed(188565)], 0, 'Dion', ctx),
    'one reserved cheap unit cannot supply two physical stacks in the same purchase');
npc = [{ sourceType: 'npc', town: 'Dion', price: 80000 }];
assert.throws(() => Alternative.assertMeetingPurchase([agreed(188565), agreed(188565)], 0, 'Dion', ctx),
    /trade_meeting_purchase_price_changed/, 'split physical stacks share one full-quantity price check');
board.clear();
assert.throws(() => Alternative.assertMeetingPurchase([agreed(80001)], 0, 'Dion', ctx),
    /trade_meeting_purchase_price_changed/, 'NPC stock also bounds fresh bilateral consent');
assert.doesNotThrow(() => Alternative.assertMeetingPurchase([agreed(80000)], 0, 'Dion', ctx));
assert.doesNotThrow(() => Alternative.assertMeetingPurchase([agreed(188565)], 1, 'Dion', ctx),
    'a seller does not prepare the counterparty purchase');
const witnessed = extra => {
    try { Alternative.assertMeetingPurchase([agreed(188565)], 0, 'Dion', { ...ctx, ...extra }); }
    catch (error) { return error.independentPriceProof; }
    return false;
};
assert.equal(witnessed({ proofMoney: 1000000 }), true, 'free cash and a local NPC prove the partial fill overpriced');
assert.equal(witnessed({ proofMoney: 100 }), false, 'money committed to other wishes cannot prove the outside option');
board.clear(); npc = [];
shop(30, 74000, 1, { custodyPolicy: 1, kind: 'sell_ad' });
assert.equal(witnessed({ proofMoney: 1000000, economy: { activity: { activity: 'shopping', kind: 'buy',
    sourceType: 'afk', quoted: true, executable: true, itemId: ITEM, town: 'Dion', unitPrice: 74000, amount: 1 } } }), false,
    'unreserved conditional stock never proves a persistent refusal');
board.clear(); npc = [{ sourceType: 'npc', town: 'Giran', price: 80000 }];
routes.Giran = { known: true, hours: 0.01, fees: 100 };
assert.equal(witnessed({ proofMoney: 1000000 }), false, 'a longer trip depends on the buyer income and needs the full evidence');
routes.Giran = { known: true, hours: 0, fees: 0 };
assert.equal(witnessed({ proofMoney: 1000000 }), true, 'a no-longer, no-dearer trip proves the alternate purchase');
// Live NUK3R case: one material costs more at the backed shop, but reaching
// it is 8100 Adena cheaper than the Giran meeting. The buyer's cash is fully
// committed to wishes, yet any funded meeting also funds this better option.
board.clear(); npc = [];
shop(41, 6004, 1, { town: 'Dion', custodyPolicy: 0, kind: 'shop' });
routes.Dion = { known: true, hours: .013888888888888888, fees: 0 };
routes.Giran = { known: true, hours: .013888888888888888, fees: 8100 };
let dominated;
try { Alternative.assertMeetingPurchase([agreed(5174)], 0, 'Giran', { ...ctx, proofMoney: 13274 }, 13274); }
catch (error) { dominated = error; }
assert.equal(dominated?.message, 'trade_meeting_purchase_price_changed');
assert.equal(dominated?.fundingDominance, true, 'the cheaper total and no-longer route prove the rejection');
routes.Dion = { known: true, hours: .02, fees: 0 };
dominated = null;
try { Alternative.assertMeetingPurchase([agreed(5174)], 0, 'Giran', { ...ctx, proofMoney: 13274 }, 13274); }
catch (error) { dominated = error; }
assert.notEqual(dominated?.fundingDominance, true, 'a longer trip needs fresh income evidence');
routes.Dion = { known: true, hours: 0, fees: 0 };
routes.Giran = { known: true, hours: 0, fees: 0 };
board.clear();
npc = [{ sourceType: 'npc', town: 'Dion', price: 80000 }];
const absentTrip = { ...ctx, travelDetails: () => ({ known: false, hours: NaN, fees: NaN }) };
assert.throws(() => Alternative.assertMeetingPurchase([agreed(80000)], 0, 'Dion', absentTrip), /trade_meeting_route/);
npc = []; shop(1, 74000);
const BuyAds = invoke('GameServer/Bot/Economy/BuyAdPolicy');
const completeTrip = town => {
    const route = ctx.travelDetails(town); return route.known ? route.fees + route.hours * ctx.hour : Infinity;
};
completeTrip.details = ctx.travelDetails;
const partialTrip = () => Infinity;
partialTrip.details = () => ({ known: false, hours: NaN, fees: NaN });
const preparedBid = BuyAds.bidFor({ ...buyer, phase: 'cold', adena: 1000000,
    stats: { money: [600000, 1 / 600000, 0, 0, .01, 100000, ITEM] } },
{ type: 'buy_craft_material', target: { itemId: ITEM, amount: 1 } }, {
    town: 'Dion', board, persona: { traits: {} }, findSpot: () => null, tripCost: partialTrip,
    economy: { ...ctx.economy, trip: completeTrip, hourAdena: ctx.hour, moneyPrice: 1 / ctx.hour }, npcOffersFor: () => []
});
assert(preparedBid?.price <= 74000, 'a partial recipe route cannot hide the complete prepared WTB alternatives');
const retainedBid = BuyAds.bidFor({ ...buyer, phase: 'cold', adena: 1000000,
    stats: { money: [600000, 1 / 600000, 0, 0, .01, 100000, ITEM] } },
{ type: 'buy_craft_material', target: { itemId: ITEM, amount: 1 }, intent: {
    key: 'power:123:11', amount: 1, worth: 34454032, valueHours: 34454032 / ctx.hour,
    valueRate: .01, retainedProject: true
} }, { town: 'Dion', board, persona: { traits: {} }, findSpot: () => null, tripCost: partialTrip,
    economy: { ...ctx.economy, worth: () => 0, trip: completeTrip, hourAdena: ctx.hour, moneyPrice: 1 / ctx.hour }, npcOffersFor: () => [] });
assert(retainedBid?.price > 0 && retainedBid.price <= 74000,
    'a retained project uses its current funded value even while the active goal values the input at zero');
assert.deepEqual(require('../src/GameServer/Bot/Population/ColdEconomyPlan').buyBatch([preparedBid]).buyCaps, [74000],
    'native publication receives the prepared limit without rebuilding routes or pricing');
assert.equal(Pricing.bid(ITEM, { ...ctx, travelDetails: partialTrip.details }, { units: 1,
    worth: 34454032, cap: 1000000, town: 'Dion', money: 1000000, rollKey: ['unknown-meeting'] }), null,
    'a new bid waits until its own meeting route is executable');
const tradeBoard = new BoardIndex();
tradeBoard.put({ id: 10, ownerId: buyer.characterId, revision: 1, storeType: BUY, town: 'Dion',
    custodyPolicy: 1, kind: 'buy_ad', lines: [{ lineId: 10, selfId: ITEM, enchant: 0,
        count: 1, price: 188565, pricing: { price: 188565, worth: 34454032 } }] });
for (const [id, price, custodyPolicy] of [[11, 80000, 1], [12, 74000, 0]])
    tradeBoard.put({ id, ownerId: id + 10, revision: 1, storeType: SELL, town: 'Dion', custodyPolicy,
        lines: [{ lineId: id, selfId: ITEM, enchant: 0, count: 1, price }] });
const planEconomy = { ...ctx.economy, trip: completeTrip, hourAdena: ctx.hour, moneyPrice: 1 / ctx.hour,
    network: { activity: { activity: 'shopping', kind: 'buy', sourceType: 'afk', quoted: true,
        executable: true, itemId: ITEM, amount: 1, unitPrice: 80000, town: 'Dion' } } };
const iterator = require('../src/GameServer/Bot/Population/ColdEconomyPlan').prepare({ ...buyer,
    level: 30, phase: 'cold', adena: 1000000, inventory: {}, vitals: { hp: 1000, mp: 1000 }, stats: { classId: 0 } },
planEconomy, { now, board: tradeBoard, persona: { traits: {} }, tripCost: partialTrip, npcOffersFor: () => [] });
let plan;
do { plan = iterator.next(); } while (!plan.done);
assert.deepEqual(plan.value.take, [SELL, ITEM, 1, 11, 11, 1, 80000]);
assert.deepEqual(plan.value.bidLimits, [[10, 10, 1, 1, 188565, 74000]],
    'an immediately selected trade still corrects the owner\'s old bids using the complete routes');
const smallWallet = Pricing.bid(ITEM, { ...ctx, adena: 100000 }, { units: 2, worth: 34454032, cap: 100000,
    town: 'Dion', money: 100000, rollKey: ['short-wallet'] });
assert.equal(smallWallet.count, 1);
assert(smallWallet.price <= 74000, 'the smaller funded order sees the one cheap available unit');
routes.Dion = { known: true, hours: 0, fees: 500 };
assert.equal(Alternative.cashCap(line, { ...ctx, adena: 60000 }), 59500,
    'a conditional bid has no escrow to add to its actual wallet');
assert.equal(Alternative.cashCap({ ...line, custodyPolicy: 0 }, { ...ctx, adena: 60000 }), 248065,
    'a backed bid recovers its real escrow and still pays the meeting fare');
const underfunded = Pricing.look(buyer, [line], { ...ctx, adena: 60000, preparedWorth: () => 34454032,
    reviewReasons: new Map([[2, 4]]) });
assert(underfunded?.reprices?.[0]?.price <= 59500, 'standing bids can fund the entire meeting');
routes.Dion = { known: true, hours: 0, fees: 0 };

// A changed route invalidates the scalar attention cache without new deals
// or a moved public quote. The native pricing cursor is applied between looks.
board.clear();
npc = [{ sourceType: 'npc', selfId: ITEM, price: 80000, town: 'Giran', available: true }];
routes.Giran = { known: true, hours: .1, fees: 0 };
const Look = require('../src/GameServer/Bot/Economy/BoardLook');
const seen = new Look.SeenLines();
const naturalCtx = { ...ctx, preparedWorth: () => 34454032 };
const firstReview = Pricing.lookOwn(buyer, [line], naturalCtx, seen);
if (firstReview?.reprices?.length) Object.assign(line, firstReview.reprices[0]);
assert(line.price > 80000);
routes.Giran = { known: true, hours: 0, fees: 0 };
const cheaperRoute = Pricing.lookOwn(buyer, [line], naturalCtx, seen);
assert(cheaperRoute?.reprices?.[0]?.price <= 80000, 'a cheaper route triggers a natural reprice without a new trade');

const Town = invoke('GameServer/Bot/Economy/MarketTownPolicy');
assert.equal(Town.buyAdTown(buyer, [{ selfId: ITEM }], [
    { kind: 'buy_ad', storeType: BUY, selfId: ITEM, count: 1, recordId: 8, town: 'Gludio' },
    { kind: 'buy_ad', storeType: BUY, selfId: ITEM, count: 1, recordId: 7, town: 'Dion' }
]), 'Dion', 'worker preparation and native publication retain the same matching meeting town');
const Refusals = invoke('GameServer/Bot/Economy/MeetingPriceRefusals');
const admissionBoard = new BoardIndex({ groupOf: Counters.counterOf });
const index = invoke('GameServer/Bot/Population/ColdOccupationSources').recipeIndex(admissionBoard);
const recipe = index.catalog.rows.find(row => row.level <= 9 && index.accept(row));
assert(recipe);
const scopeBefore = Refusals.admissionFingerprint(admissionBoard, 'recipe-production:9');
admissionBoard.put({ id: 900, ownerId: 901, revision: 1, storeType: BUY, town: 'Dion',
    lines: [{ lineId: 902, selfId: recipe.productId, count: 1, price: 100 }] });
assert.notEqual(Refusals.admissionFingerprint(admissionBoard, 'recipe-production:9'), scopeBefore,
    'public recipe admission changes retire price refusals on both board mirrors');
console.log('WTB alternatives: publication, review, quantities, routes, funding and conditional execution passed');
