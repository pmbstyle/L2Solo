'use strict';
const assert = require('node:assert/strict');
// Pins the x50 demand window (an hour).
process.env.L2NODE_PROGRESSION_RATE = 'x50';
require('../src/Global');
invoke('GameServer/DataCache').init();
const Listing = require('../src/GameServer/Bot/Economy/MarketListingPolicy');
const Flow = require('../src/GameServer/Bot/Economy/MarketTradeDemand');
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
const now = Date.now(), board = new BoardIndex();
const recipes = Array.from({ length: 8 }, (_, i) => ({ selfId: 2275 + i, count: 1, price: 100000 + i }));
const crystals = { selfId: 1458, count: 4326, price: 1900 };
const own = { id: 11, ownerId: 1, kind: 'buy_ad', storeType: 3, town: 'Giran',
    lines: [{ id: 111, selfId: 1458, count: 500, price: 2000 }] };
Flow.reset(); board.put(own);
let selected = Listing.prioritizeListings([...recipes, crystals], { board, characterId: 1, timestamp: now }).slice(0, 8);
assert(!selected.includes(crystals), 'a bot cannot manufacture interest with its own bid');
board.put({ ...own, id: 12, ownerId: 2, lines: [{ ...own.lines[0], id: 112 }] });
selected = Listing.prioritizeListings([...recipes, crystals], { board, characterId: 1, timestamp: now }).slice(0, 8);
assert(selected.includes(crystals), 'real public interest frees a crystal slot despite eight expensive unsold recipes');
assert.equal(selected.length, 8);
board.remove(12);
Flow.deal(1458, 500, 'Giran', now - 600000); Flow.deal(1458, 500, 'Giran', now - 300000);
selected = Listing.prioritizeListings([...recipes, crystals], { board, characterId: 1, timestamp: now }).slice(0, 8);
assert(selected.includes(crystals), 'recent completed trades still earn space without a standing bid');
selected = Listing.prioritizeListings([...recipes, crystals], { board, characterId: 1, timestamp: now + 24 * 3600000 }).slice(0, 8);
assert(!selected.includes(crystals), 'old sales do not confer permanent priority');
Flow.reset();
console.log('PASS market slots prefer public interest/recent sales, exclude own bids and decay old evidence');
