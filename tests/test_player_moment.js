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
assert.equal(moved({}, { leaf, why: 'goal' }), 'goal_moved', 'main moved the goal');
// A bot at work weighs only the gear it follows; a real review weighs every candidate.
assert.equal(Moment.quiet(hunter, 'wish_dirty'), true, 'a soft event on the spot');
assert.equal(Moment.quiet({ ...hunter, activity: 'traveling' }, 'refresh'), true, 'and on the road');
assert.equal(Moment.quiet({ ...hunter, activity: 'resting' }, 'wish_dirty'), false, 'a rest is a review');
assert.equal(Moment.quiet({ ...hunter, activity: 'shopping' }, 'wish_dirty'), false, 'so is the town');
assert.equal(Moment.quiet({ ...hunter, partyId: 3 }, 'wish_dirty'), false, 'and a party');
assert.equal(Moment.quiet(hunter, 'check:offer'), false, 'a failed goal chooses again');
assert.equal(Moment.quiet(hunter, 'goal'), false, 'a goal main moved too');
assert.equal(Moment.quiet(hunter, undefined), false, 'no card stood: no held build to follow');
assert.equal(Moment.momentOf({ ...hunter, activity: 'shopping' }, facts, facts), 'town', 'in town it reads everything');
assert.equal(Moment.momentOf({ ...hunter, partyId: 'bgp_1' }, facts, facts), 'party');
assert.equal(Moment.momentOf(hunter, null, facts), 'first');

// WTB/WTS on a watched item reaches the bot away from town.
const board = new BoardIndex();
board.put({ id: 1, ownerId: 99, storeType: 1, kind: 'shop', town: 'Giran', lines: [{ lineId: 1, selfId: 1458, count: 10, price: 500, enchant: 0,
    revision: 1, available: true, executable: true }] });
assert.equal(Moment.momentOf(hunter, { ...facts, marketWatch: [[1458, 1, 1000, 0.1]] }, facts, { board, leaf }), 'market');
assert.equal(Moment.momentOf(hunter, { ...facts, marketWatch: [[1459, 1, 1000, 0.1]] }, facts, { board, leaf }), null, 'an item it does not watch is silent');
// Away on a solo hunt only the next wish within reach raises money; in reach of town the drift does too.
const Sections = invoke('GameServer/Bot/Economy/DecisionSections');
const moneyBaseline = { wallet: 1000, moneyError: 100, cashBounds: [0, 5000], funding: 0 };
const hunting = adena => ({ characterId: 7, phase: 'cold', activity: 'hunting', adena, stats: {} });
const soft = (state, leafNow, momentGate = true) => Sections.softEvents(state, moneyBaseline, { buyOrderEscrow: 0, momentGate, timestamp: 1 }, leafNow);
assert(!soft(hunting(1500), leaf).includes('money'), 'a drift away on the hunt is no event');
assert(soft(hunting(6000), leaf).includes('money'), 'the next wish in reach is');
assert(soft(hunting(1500), { activity: 'shopping', town: 'Giran' }).includes('money'), 'a bot on its way to shop reads its money');
assert(soft({ ...hunting(1500), partyId: 'bgp_1' }, leaf).includes('money'), 'a party member keeps the drift');
assert(soft(hunting(1500), leaf, false).includes('money'), 'the gate off changes nothing');
assert(soft(hunting(1500), { ...leaf, funding: true }).includes('money'), 'a hunt for money reads its money');
const incomeMoved = (leafNow, momentGate = true) => Sections.softEvents(hunting(1000), { ...moneyBaseline, share: 0.5, incomeError: 0 },
    { buyOrderEscrow: 0, momentGate, timestamp: 1 }, leafNow);
assert.deepEqual(incomeMoved(leaf), [], 'nor does the income reach it on the hunt');
assert(incomeMoved(leaf, false).includes('occupation'), 'the gate off keeps the income');
assert(incomeMoved({ ...leaf, funding: true }).includes('occupation'), 'a hunt for money reads its income');
console.log('player moment ok');
process.exit(0);
