'use strict';
// One finite sale into one bid (MVP-5): a backed bid buys its count, a
// conditional bid only its buyer's willingness, cheaper foreign asks serve
// the buyer first, own unsold goods count once, an uninspected cheaper tail
// is a limit, and an unknown belief is never revenue.
const assert = require('node:assert/strict');
require('../src/Global');
invoke('GameServer/DataCache').init();
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
const Price = invoke('GameServer/Bot/Economy/PriceDecision');
const PriceBelief = invoke('GameServer/Bot/Economy/PriceBelief');
const Pricing = invoke('GameServer/Bot/Economy/MarketPricing');

const ITEM = 1869, TOWN = 'Dwarven Village', timestamp = 1800000000000;
const seller = { characterId: 42, marketTrades: {} };
const persona = { traits: { assertiveness: 0.5, caution: 0 }, understanding: 0.3 };
let nextId = 100;
function put(board, { ownerId, storeType, count, price, custodyPolicy = 0, enchant = 0 }) {
    const id = nextId++;
    board.put({ id, ownerId, storeType, custodyPolicy, revision: 1, town: TOWN,
        lines: [{ lineId: id + 1000, selfId: ITEM, count, price, enchant }] });
    return board.list(ITEM, storeType).find(line => line.recordId === id);
}
const sale = (board, offer, options) => Price.bidSale(seller, offer,
    { board, persona, timestamp, residualUnitValue: 10, ...options });

// A backed bid buys its count and no more; the rest is residual.
let board = new BoardIndex();
const backed = put(board, { ownerId: 7, storeType: 3, count: 3, price: 500 });
let result = sale(board, backed, { units: 10 });
assert.equal(result.status, 'ready');
assert.equal(result.after.sold, 3, 'a backed buyer takes only its count');
assert.equal(result.after.residual, 7);
assert.equal(result.gross, 3 * 500 + 7 * 10);

// A conditional bid holds no money: only the willingness read from the
// seller's belief at the bid price, fewer than its count.
board = new BoardIndex();
const conditional = put(board, { ownerId: 7, storeType: 3, count: 20, price: 500, custodyPolicy: 1 });
result = sale(board, conditional, { units: 50 });
const belief = PriceBelief.prior(ITEM, { board, characterId: 42, timestamp, understanding: 0.3, marketTrades: {} });
const willing = Price.willingUnitsAt(belief, Price.traderOf(persona), { price: 500, applicableUnits: 20 });
assert.equal(result.status, 'ready');
assert(willing > 0 && willing < 20, `willingness ${willing} is below the advertised count`);
assert.equal(result.forecast.willingUnits, willing);
assert.equal(result.after.sold, willing, 'a conditional bid is never treated as fully paid');

// Own unsold goods (free stock, accepted incoming, own lines) are sold
// first: the same new units add less.
const fresh = sale(board, conditional, { units: 5 });
const crowded = sale(board, conditional, { units: 5, oldUnits: Math.floor(willing) });
assert(crowded.gross < fresh.gross, 'own unsold goods lower the gain of new units');
assert.equal(crowded.before.sold, Math.floor(willing));

// Cheaper foreign asks of the same enchant serve the buyer first; own and
// enchanted asks and dearer asks do not.
board = new BoardIndex();
const bid = put(board, { ownerId: 7, storeType: 3, count: 10, price: 500 });
put(board, { ownerId: 8, storeType: 1, count: 4, price: 400 });
put(board, { ownerId: 42, storeType: 1, count: 3, price: 300 });
put(board, { ownerId: 9, storeType: 1, count: 5, price: 350, enchant: 2 });
put(board, { ownerId: 11, storeType: 1, count: 6, price: 600 });
result = sale(board, bid, { units: 10, asks: board.list(ITEM, 1) });
assert.equal(result.cheaperUnits, 4);
assert.equal(result.after.sold, 6, 'a cheaper competitor takes its share of the bid first');

// A sixth cheaper ask behind five inspected ones that do not cover the bid:
// the competition is unknown, the bid gives no revenue.
board = new BoardIndex();
const deep = put(board, { ownerId: 7, storeType: 3, count: 20, price: 500 });
for (let at = 0; at < 6; at++) put(board, { ownerId: 20 + at, storeType: 1, count: 1, price: 300 + at });
result = sale(board, deep, { units: 5, asks: board.list(ITEM, 1) });
assert.equal(result.status, 'limit', 'an uninspected cheaper tail is a limit, not revenue');
assert.deepEqual(Price.cheaperAsks(board.list(ITEM, 1), { ownerId: 42, price: 500 }), { cheaperUnits: 5, tail: true });

// No buyer left after cheaper sellers: only the NPC residual.
board = new BoardIndex();
const covered = put(board, { ownerId: 7, storeType: 3, count: 2, price: 500 });
put(board, { ownerId: 8, storeType: 1, count: 5, price: 400 });
result = sale(board, covered, { units: 4, asks: board.list(ITEM, 1) });
assert.equal(result.after.sold, 0);
assert.equal(result.gross, 4 * 10, 'with no buyer left only the residual value remains');

// A conditional bid the seller cannot read (an edited record) is unknown.
board = new BoardIndex();
const stale = { ...put(board, { ownerId: 7, storeType: 3, count: 5, price: 500, custodyPolicy: 1 }), revision: 0 };
assert.equal(sale(board, stale, { units: 1 }).status, 'unknown', 'an unreadable buyer is not revenue');

// Answering a bid now: a conditional bid is valued by its buyer's expected
// willingness while the physical answer offers the bid's count; one buyer
// with two lines is answered once, at its best line.
board = new BoardIndex();
const answerBid = put(board, { ownerId: 7, storeType: 3, count: 4, price: 500, custodyPolicy: 1 });
put(board, { ownerId: 7, storeType: 3, count: 1, price: 450, custodyPolicy: 1 });
const trip = () => 0; trip.details = () => ({ known: true, hours: 0, fees: 0 });
const ctx = Pricing.traderContext({ characterId: 42, adena: 0, inventory: {}, stats: {} }, { board, timestamp, persona,
    economy: { hourAdena: 10000, moneyPrice: 0.001, worth: () => 0, trip, board } });
const answer = Pricing.bestAnswer(ITEM, ctx, { units: 6, residualUnitValue: 10 });
const expected = sale(board, answerBid, { units: 6 });
assert.equal(answer.line.lineId, answerBid.lineId);
assert.equal(answer.count, 4, 'the physical answer offers the bid count; the trade checks the money');
assert(answer.outcome.sold < 4, 'its value counts only the expected paid units');
assert.equal(answer.outcome.sold, expected.after.sold);
// A bilateral rejection is scoped to the actual quantity and buyer's exact
// state and market sources. Other bids and larger fills remain candidates.
const Refusals = invoke('GameServer/Bot/Economy/MeetingPriceRefusals');
const Admission = invoke('GameServer/Bot/Population/PartyAdmission');
let buyer = { characterId: 7, phase: 'cold', updatedAt: 10, simulation: { revision: 2 } };
Admission.configureTradeAdmission(id => Number(id) === 7 ? buyer : null);
let sourcesCurrent = true;
const request = { actorA: 7, actorB: 42, lines: [{ payer: 0, selfId: ITEM, enchant: 0,
    count: 4, price: 500, adId: answerBid.recordId, adRevision: answerBid.revision }] };
Refusals.remember(buyer, board, request, { selfId: ITEM, enchant: 0, units: 4, cost: 2000 }, () => sourcesCurrent);
assert.equal(Pricing.bestAnswer(ITEM, ctx, { units: 6, residualUnitValue: 10 }).line.price, 450,
    'a rejected full fill chooses the next bid instead of starting the same meeting');
assert.equal(Pricing.bestAnswer(ITEM, ctx, { units: 3, residualUnitValue: 10 }).line.price, 500,
    'another quantity retains its own fresh consent');
sourcesCurrent = false;
assert.equal(Pricing.bestAnswer(ITEM, ctx, { units: 6, residualUnitValue: 10 }).line.price, 500,
    'changed market sources reopen the previously refused fill');
sourcesCurrent = true;
Refusals.remember(buyer, board, request, { selfId: ITEM, enchant: 0, units: 4, cost: 2000 }, () => sourcesCurrent);
buyer = { ...buyer, simulation: { revision: 3 } };
assert.equal(Pricing.bestAnswer(ITEM, ctx, { units: 6, residualUnitValue: 10 }).line.price, 500,
    'a new buyer authority reopens the fill');
buyer = { ...buyer, adena: 10000, stats: { money: [100, 0, 0, 0] }, loc: { locX: 1, locY: 1, locZ: 0 } };
Refusals.remember(buyer, board, request, { selfId: ITEM, enchant: 0, units: 4, cost: 2000 }, () => true,
    { minimumFree: 1000 });
buyer = { ...buyer, adena: 9000, updatedAt: 20, simulation: { revision: 4 } };
assert.equal(Pricing.bestAnswer(ITEM, ctx, { units: 6, residualUnitValue: 10 }).line.price, 450,
    'a guaranteed alternative remains valid across an unrelated buyer step with sufficient free money');
buyer = { ...buyer, adena: 500 };
assert.equal(Pricing.bestAnswer(ITEM, ctx, { units: 6, residualUnitValue: 10 }).line.price, 500,
    'the guaranteed alternative reopens when free money no longer covers it');
buyer = { ...buyer, adena: 9000 };
Refusals.remember(buyer, board, request, { selfId: ITEM, enchant: 0, units: 4, cost: 2000 }, () => true,
    { minimumFree: 1000 });
buyer = { ...buyer, loc: { locX: 2, locY: 1, locZ: 0 } };
assert.equal(Pricing.bestAnswer(ITEM, ctx, { units: 6, residualUnitValue: 10 }).line.price, 500,
    'a changed route reopens the fill');
buyer = { ...buyer, loc: { locX: 1, locY: 1, locZ: 0 } };
let specificSource = true;
Refusals.remember(buyer, board, request, { selfId: ITEM, enchant: 0, units: 4, cost: 2000 }, () => specificSource,
    { fundingDominance: true });
buyer = { ...buyer, adena: 500, stats: { money: [100, 0, 0, 500] }, updatedAt: 30, simulation: { revision: 5 } };
assert.equal(Pricing.bestAnswer(ITEM, ctx, { units: 6, residualUnitValue: 10 }).line.price, 450,
    'a strictly cheaper funded alternative dominates even when buyer funds or revision change');
specificSource = false;
assert.equal(Pricing.bestAnswer(ITEM, ctx, { units: 6, residualUnitValue: 10 }).line.price, 500,
    'a change to the actual alternative immediately reopens the bid');
Refusals.clear();
Admission.configureTradeAdmission(() => null);
// A seller answering a remote buy ad is the traveler. Its own protected
// funding, not the buyer's wallet, decides whether it can pay the fare.
const distantSeller = { characterId: 42, phase: 'cold', activity: 'hunting', adena: 1000000,
    loc: { locX: 83396, locY: 147904, locZ: -3400 }, stats: { money: [1000, .001, 0, 500] } };
const fareCtx = Pricing.traderContext(distantSeller, { board, timestamp, persona,
    economy: { hourAdena: 10000, moneyPrice: .001, worth: () => 0, trip, board } });
assert.equal(Pricing.bestAnswer(ITEM, fareCtx, { units: 6, residualUnitValue: 10 }), null,
    'a distant conditional bid cannot select a seller whose goal protects its fare');
const fundedCtx = Pricing.traderContext({ ...distantSeller, stats: { money: [1000, .001, 0, 0] } }, { board, timestamp, persona,
    economy: { hourAdena: 10000, moneyPrice: .001, worth: () => 0, trip, board } });
assert(Pricing.bestAnswer(ITEM, fundedCtx, { units: 6, residualUnitValue: 10 }),
    'the same bid is immediately eligible once the seller has free fare');
// The caller's own belief of the item is used for the willingness read: a
// seller who believes the item is worth more expects more buyers at a bid.
const dearer = { ...belief, mu: belief.mu + 1 };
board = new BoardIndex();
const readOnce = put(board, { ownerId: 7, storeType: 3, count: 20, price: 500, custodyPolicy: 1 });
assert.equal(sale(board, readOnce, { units: 50 }).forecast.willingUnits, willing);
assert(sale(board, readOnce, { units: 50, belief: dearer }).forecast.willingUnits > willing,
    'a passed belief replaces the belief read again');

// A backed bid is answered with its count and valued in full.
board = new BoardIndex();
const backedAnswer = put(board, { ownerId: 7, storeType: 3, count: 4, price: 500 });
const backedCtx = Pricing.traderContext({ characterId: 42, adena: 0, inventory: {}, stats: {} }, { board, timestamp, persona,
    economy: { hourAdena: 10000, moneyPrice: 0.001, worth: () => 0, trip, board } });
const paid = Pricing.bestAnswer(ITEM, backedCtx, { units: 6, residualUnitValue: 10 });
assert.equal(paid.line.lineId, backedAnswer.lineId);
assert.equal(paid.count, 4);
assert.equal(paid.outcome.sold, 4);
assert.equal(paid.outcome.receipts, 4 * 500, 'a backed bid pays its whole count');
console.log('PASS bid sale: finite buyers, willingness, competitors, own stock, tail and answers');
