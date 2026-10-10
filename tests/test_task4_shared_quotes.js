'use strict';
// Task 4 B1: one depth-capped purchase quote (OfferQuery.cheapestTown
// quoteDepth) and one exit competition rule (PriceDecision.exitCompetition)
// for the planners, their rechecks and bidSale.
require('../src/Global');
const assert = require('assert');
const OfferQuery = require('../src/GameServer/Bot/Economy/OfferQuery');
const Price = require('../src/GameServer/Bot/Economy/PriceDecision');

const line = (town, price, count, ownerId = 2) => ({ town, price, count, ownerId, selfId: 7, enchant: 0 });
const sells = [line('Giran', 10, 1), line('Dion', 11, 1), line('Dion', 12, 1, 9), line('Giran', 13, 1), line('Dion', 14, 1),
    line('Giran', 1, 50)].sort((a, b) => a.price - b.price);
const index = { list: (id, side, town) => sells.filter(row => !town || row.town === town),
    towns: () => ['Giran', 'Dion'] };

// The whole board: the cheap Giran stack fills the order.
assert.equal(OfferQuery.cheapestTown(index, 7, { amount: 3 }).town, 'Giran');
// Only the first lines a trader inspects: same as the board here (the stack is first).
const depth = OfferQuery.cheapestTown(index, 7, { amount: 3, quoteDepth: 5, excludeOwner: 9 });
assert.equal(depth.town, 'Giran'); assert.equal(depth.whole, true);
// The 6th line is never seen: without the stack Giran holds 2 inspected lines.
sells.shift(); sells.push(line('Giran', 1.5, 50)); sells.sort((a, b) => a.price - b.price);
sells.push(line('Giran', 20, 50));
const capped = OfferQuery.cheapestTown(index, 7, { amount: 3, quoteDepth: 5, excludeOwner: 9 });
assert.equal(capped.units, 3); assert.equal(capped.town, 'Giran');
const narrow = OfferQuery.cheapestTown(index, 7, { amount: 60, quoteDepth: 5, excludeOwner: 9 });
assert.equal(narrow.whole, false, 'a line past the inspected depth never fills the order');
// A town of an uninspected line is not a candidate; the NPC shop is.
const npc = OfferQuery.cheapestTown(index, 7, { amount: 2, quoteDepth: 1, npcOffers: [{ town: 'Oren', price: 1 }] });
assert.equal(npc.town, 'Oren'); assert.equal(npc.npc, 2);

// Exit competition: foreign cheaper asks within the inspected depth; the
// tail may cover the bid -> limit (bidSale's 'limit').
const asks = [1, 2, 3, 4, 5, 6].map(price => ({ price, count: 1, ownerId: price === 2 ? 5 : 3, enchant: 0 }));
assert.deepEqual(Price.exitCompetition(asks, { ownerId: 5, price: 10, count: 9 }), { cheaperUnits: 4, limit: true });
assert.deepEqual(Price.exitCompetition(asks, { ownerId: 5, price: 10, count: 4 }), { cheaperUnits: 4, limit: false });
assert.deepEqual(Price.exitCompetition(asks, { ownerId: 5, price: 3, count: 9 }), { cheaperUnits: 1, limit: false });
console.log('PASS task4 shared quotes: depth-capped cheapest town, exit competition limit');
