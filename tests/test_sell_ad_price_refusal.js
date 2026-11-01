'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
invoke('GameServer/DataCache').init();
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
const Refusals = require('../src/GameServer/Bot/Economy/MeetingPriceRefusals');
const Choice = require('../src/GameServer/Bot/Economy/ReadyTradeChoice');
const board = new BoardIndex();
const put = (id, ownerId, price, revision, custodyPolicy) => board.put({ id, ownerId, price, revision,
    storeType: 1, kind: custodyPolicy ? 'sell_ad' : 'shop', custodyPolicy, town: 'Giran',
    lines: [{ lineId: id + 1, selfId: 1459, count: 200, price }] });
put(10, 30, 2448, 1, 1); put(20, 40, 2342, 1, 0);
const buyer = { characterId: 1, phase: 'cold', activity: 'shopping', currentRegion: 'Giran',
    loc: { locX: 83396, locY: 147904, locZ: -3400 }, inventory: {}, adena: 1000000,
    stats: { money: [1000, .001, 0, 0] } };
const request = { actorA: 1, actorB: 30, lines: [{ payer: 0, selfId: 1459, enchant: 0,
    adId: 10, adRevision: 1, count: 118, price: 2448 }] };
const purchase = { selfId: 1459, enchant: 0, units: 118, cost: 118 * 2448 };
const witness = [[20, 21, 1, 118, 2342]];
const remember = () => Refusals.remember(buyer, board, request, purchase,
    () => Refusals.witnessCurrent(board, witness, purchase), { fundingDominance: true });
const line = () => board.records.get(10)[0];
const economy = { network: { activity: { activity: 'shopping', kind: 'buy', sourceType: 'afk',
    itemId: 1459, amount: 118, unitPrice: 2448, quoted: true, executable: true, town: 'Giran' } } };
remember();
assert(Refusals.rejects(line(), 118, buyer), 'the same buyer cannot repeat a proven overpriced sale');
assert.equal(Choice.purchase(buyer, economy, board), null, 'worker selection skips the refused seller');
assert(!Refusals.rejects(line(), 117, buyer), 'a different quantity is not covered');
assert(!Refusals.rejects(line(), 118, { ...buyer, characterId: 2 }), 'another buyer keeps its own decision');
assert(!Refusals.rejects(line(), 118, { ...buyer, currentRegion: 'Dion' }), 'a changed route requires a fresh comparison');
remember();
put(20, 40, 2500, 2, 0);
assert(!Refusals.rejects(line(), 118, buyer), 'the refusal expires when the cheaper backed source changes');
put(20, 40, 2342, 1, 0); remember();
put(10, 30, 2400, 2, 1);
assert(!Refusals.rejects(line(), 118, buyer), 'a new revision of the seller offer is evaluated again');
Refusals.clear();
console.log('PASS sell-ad price refusal is buyer, quantity, route, source and revision specific');
