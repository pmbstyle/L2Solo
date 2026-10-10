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
console.log('PASS bid sale: finite buyers, willingness, competitors, own stock, tail and answers');
