// Native same-record publication is one mutation; removals still notify all
// affected items and malformed replacements cannot leave an orphan offer.
const assert = require('node:assert/strict');
require('../src/Global');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
invoke('GameServer/DataCache').init();
const changes = [], mutations = [];
const unsubscribe = Afk.subscribeBoardChanges(change => changes.push(change));
const board = Afk.boardIndex();
board.setOwnerChangeObserver((previous, next) => mutations.push([previous.length, next.length]));
const record = { id: 500, ownerId: 42, kind: 'sell_ad', storeType: Afk.SELL, status: 'active',
    botOwned: true, town: 'Giran', revision: 1, custodyPolicy: 1,
    lines: [1864, 1865].map((selfId, i) => ({ id: 501 + i, selfId, name: 'Material', count: 10, price: 8 })) };
try {
    Afk.refreshRecord(record);
    changes.length = 0; mutations.length = 0;
    Afk.refreshRecord({ ...record, revision: 2, lines: record.lines.slice(1) });
    assert.deepEqual(mutations, [[2, 1]], 'replacement delivers exact old/new rows in one mutation');
    assert.deepEqual(changes[0].selfIds.sort(), [1864, 1865], 'removed and surviving items both notify existing listeners');
    assert.equal(board.ownerLines(42).length, 1);
    Afk.refreshRecord({ ...record, revision: 3, storeType: 0 });
    assert.equal(board.ownerLines(42).length, 0, 'invalid replacement removes the previous public offer');
    Afk.refreshRecord({ ...record, revision: 4 });
    Afk.refreshRecord({ ...record, revision: 5, status: 'closed' });
    assert.equal(board.ownerLines(42).length, 0, 'closed records still leave the public index');
    console.log('PASS native atomic replacement, removed-item notification, invalid/closed removal');
} finally {
    board.setOwnerChangeObserver(null); unsubscribe(); Afk._resetForTests();
}
