// T174: which builds a player's moment asks for. Real facts and board reader.
'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
require('../src/Global');
const Moment = invoke('GameServer/Bot/Population/PlayerMoment');
const { BoardIndex } = invoke('GameServer/AfkTrade/BoardIndex');

const facts = { build: 1, recipes: 2, relations: 3, occupation: 4, dead: false, riskDeaths: 0, supply: 5, stores: 6, bag: 7 };
const hunter = { characterId: 7, activity: 'hunting', spotId: 's', stats: {} };
const leaf = { activity: 'hunting', spotId: 's' };
const moved = (change, options = { leaf }) => Moment.momentOf(hunter, facts, { ...facts, ...change }, options);

assert.equal(moved({}), null, 'money, bag counts and loot are no moment on the spot');
assert.equal(moved({ occupation: 9 }), null, 'its own planned move is none');
assert.equal(moved({ occupation: 9 }, { leaf: null }), 'occupation', 'a flight or a recall stays a fact');
assert.equal(moved({ dead: true }), 'dead');
assert.equal(moved({ build: 9 }), 'build', 'worn gear');
assert.equal(moved({ recipes: 9 }), 'recipes');
assert.equal(moved({ supply: 9 }), 'supply', 'out of shots, potions or the scroll');
assert.equal(moved({ bag: 9 }), 'bag', 'a full bag');
assert.equal(moved({}, { leaf, why: 'check:offer' }), 'goal_failed', 'the held goal failed');
assert.equal(moved({}, { leaf, nativeHolds: false }), 'native', 'the native plan failed or woke');
assert.equal(Moment.momentOf({ ...hunter, activity: 'shopping' }, facts, facts), 'town', 'in town it reads everything');
assert.equal(Moment.momentOf({ ...hunter, partyId: 'bgp_1' }, facts, facts), 'party');
assert.equal(Moment.momentOf(hunter, null, facts), 'first');

// WTB/WTS on a watched item reaches the bot away from town.
const board = new BoardIndex();
board.put({ id: 1, ownerId: 99, storeType: 1, kind: 'shop', town: 'Giran', lines: [{ lineId: 1, selfId: 1458, count: 10, price: 500, enchant: 0,
    revision: 1, available: true, executable: true }] });
assert.equal(Moment.momentOf(hunter, { ...facts, marketWatch: [[1458, 1, 1000, 0.1]] }, facts, { board, leaf }), 'market');
assert.equal(Moment.momentOf(hunter, { ...facts, marketWatch: [[1459, 1, 1000, 0.1]] }, facts, { board, leaf }), null, 'an item it does not watch is silent');
console.log('player moment ok');
process.exit(0);
