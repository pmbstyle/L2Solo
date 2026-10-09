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
for (const patch of [{ routePending: true }, { intentPending: true }]) {
    assert.equal(Choice.purchase(state, { ...economy, ...patch }, board), null);
}
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
