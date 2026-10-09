'use strict';
const assert = require('node:assert/strict');
const { BoardIndex, SELL, BUY } = require('../src/GameServer/AfkTrade/BoardIndex');
const { create } = require('../src/GameServer/AfkTrade/PlayerBoardService');

async function main() {
    const board = new BoardIndex();
    let selects = 0, crafts = 0, x = 0, prepares = 0, agreements = 0, lostAck = false, durableReceipt = false, terminal = false, stagedReceipt = false;
    const merchant = { fetchId: () => 900000045, fetchLocX: () => 1000, fetchLocY: () => 0, fetchLocZ: () => 0 };
    const player = { accountId: 'player_board', actor: { fetchId: () => 8, fetchHp: () => 100,
        fetchClanId: () => 0, fetchLocX: () => x, fetchLocY: () => 0, fetchLocZ: () => 0,
        select: (data) => { assert.equal(data.id, merchant.fetchId()); selects++; },
        backpack: { items: [], insertItem(id, selfId, row) { this.items.push(row); }, fetchItems() { return this.items; } } },
        dataSendToMe() {} };
    const record = { id: 1, kind: 'shop', storeType: SELL, ownerId: 45, town: 'Dion', revision: 4,
        lines: [{ lineId: 11, selfId: 1152, enchant: 0, count: 2, price: 600 }] };
    board.put(record, { projection: { actor: merchant } });
    board.put({ ...record, id: 2, kind: 'ad', storeType: BUY, ownerId: 46,
        lines: [{ lineId: 12, selfId: 1864, count: 10, price: 90 }] }, {});
    board.put({ ...record, id: 3, ownerId: 8, lines: [{ lineId: 13, selfId: 1152, count: 1, price: 500 }] }, {});
    board.put({ ...record, id: 4, ownerId: 47, lines: [{ lineId: 14, selfId: 1152, count: 1, price: 550 }] }, {});
    const shop = { characterId: 55, currentRegion: 'Dion', loc: { locX: 5000, locY: 0, locZ: 0 }, simulation: { revision: 2 } };
    const service = create({ afk: () => ({ isBoardReady: () => true, boardIndex: () => board,
        offerOf: (line) => line.ownerId === 47 ? null
            : ({ sourceName: `Trader${line.ownerId}`, itemName: `Item${line.selfId}`, projection: line.ref.projection, store: { locX: 1000, locY: 0, locZ: 0 } }),
        buyFromShop() { throw Error('remote purchase forbidden'); }, sellToShop() { throw Error('remote sale forbidden'); } }),
    meetings: () => ({ discard() {}, prepareTrade: async () => { prepares++; return { preparationId: 'prepared', total: 180 }; },
        receipt: async (token, id) => { assert.equal(id, 8); return durableReceipt && token === 'prepared' ? { pending: !terminal, outcome: terminal ? 'completed' : 'accepted' }
            : stagedReceipt ? { pending: true, outcome: 'preparing', preparationId: token } : null; },
        accept: async id => { assert.equal(id, 'prepared'); agreements++; if (lostAck) { durableReceipt = true; throw Error('reply_lost_after_commit'); } return { pending: true }; } }),
    life: () => ({ cachedState: (id) => ({ characterId: id, loc: { locX: 7000, locY: 0, locZ: 0 }, currentRegion: 'Dion' }) }),
    workshops: () => ({ boardRecords: () => [{ id: 'workshop_55', kind: 'workshop', ownerId: 55, ownerName: 'Maker',
        town: 'Dion', loc: shop.loc, revision: 2, entries: [{ recipeId: 17, price: 150 }] }],
    lookup: () => ({ state: shop, recipe: { productId: 1835 }, price: 150 }), craft: async (owner, recipe, customer, options) => {
        assert.deepEqual([owner, recipe, customer, options.expectedPrice], [55, 17, 8, 150]); crafts++;
        return { product: { id: 91, amount: 1 } };
    } }), database: () => ({ fetchItems: async () => [{ id: 91, selfId: 1835, amount: 1 }] }),
    response: () => ({ itemsList: (items) => items }) });
    const listed = service.entries(player, { selfId: 1152, side: SELL });
    assert.equal(listed.entries.length, 1); assert.equal(listed.entries[0].price, 600);
    assert.equal(listed.entries[0].cursor.n, 2, 'own and unavailable lines count in the raw list cursor');
    const firstPage = service.entries(player, { limit: 1 });
    assert(firstPage.next !== null);
    assert.equal(service.entries(player, { limit: 1, cursor: firstPage.next }).entries[0].id, 2,
        'a cursor starts at the first line not shown on the previous page');
    const request = { id: 1, lineId: 11, selfId: 1152, price: 600, revision: 4 };
    assert.equal((await service.answer(player, request)).action, 'meet'); assert.equal(selects, 0);
    x = 1000; assert.equal((await service.answer(player, request)).action, 'store_opened'); assert.equal(selects, 2);
    board.put({ ...record, revision: 5, lines: [{ ...record.lines[0], price: 700 }] }, { projection: { actor: merchant } });
    assert.equal((await service.answer(player, request)).reason, 'record_changed'); assert.equal(selects, 2);
    assert.equal((await service.answer(player, { id: 3, lineId: 13, selfId: 1152, price: 500, revision: 4 })).reason, 'own_record');
    assert.equal((await service.answer(player, { id: 2, lineId: 12, selfId: 1864, price: 90, revision: 4 })).action, 'contact');
    board.put({ ...record, id: 5, kind: 'sell_ad', custodyPolicy: 1,
        lines: [{ lineId: 15, selfId: 1864, count: 10, price: 90 }] }, {});
    const conditional = { id: 5, lineId: 15, selfId: 1864, price: 90, revision: 4, amount: 2 };
    x = 7000; assert.equal((await service.answer(player, conditional)).action, 'meet');
    assert.equal(prepares, 0); assert.equal(agreements, 0);
    x = 1000; assert.equal((await service.answer(player, conditional)).action, 'confirm_trade');
    assert.equal(prepares, 1); assert.equal(agreements, 0);
    x = 1300; assert.equal((await service.answer(player, { ...conditional, confirmed: true })).action, 'meet');
    assert.equal(agreements, 0);
    x = 1000; assert.equal((await service.answer(player, { ...conditional, amount: 3, confirmed: true })).reason, 'record_changed');
    assert.equal(agreements, 0);
    stagedReceipt = true;
    assert.equal((await service.answer(player, { ...conditional, confirmed: true })).action, 'agreed');
    assert.equal(agreements, 1, 'Agree must accept a staged preparation, not mistake it for an already reserved trade');
    assert.equal(player.playerBoardPreparation, undefined);
    stagedReceipt = false;
    assert.equal((await service.answer(player, { ...conditional, confirmed: true })).reason, 'record_changed');
    await service.answer(player, conditional);
    lostAck = true;
    assert.equal((await service.answer(player, { ...conditional, confirmed: true })).reason, 'record_changed');
    assert(player.playerBoardPreparation, 'lost native reply preserves the original consent identity');
    board.remove(5);
    terminal = true;
    assert.equal((await service.answer(player, { ...conditional, confirmed: true })).action, 'completed', 'the replay shows completion rather than asking the player to wait again');
    assert.equal(agreements, 2, 'receipt replay after quote removal never creates a second native acceptance');
    assert.equal(player.playerBoardPreparation, undefined);
    lostAck = false; durableReceipt = false;
    assert.equal((await service.answer(player, { ...conditional, amount: 0 })).reason, 'record_changed');
    assert.equal((await service.answer(player, { ...conditional, amount: 11 })).reason, 'record_changed');
    assert.equal((await service.answer(player, { ...conditional, amount: 1.5 })).reason, 'record_changed');
    const workshop = service.entries(player, { kind: 'workshop' }).entries[0];
    assert.equal(workshop.price, 150);
    const order = { ...workshop, kind: 'workshop' };
    assert.equal((await service.answer(player, order)).action, 'meet'); assert.equal(crafts, 0);
    x = 5000; assert.equal((await service.answer(player, { ...order, price: 151 })).reason, 'record_changed');
    const confirm = await service.answer(player, order);
    assert.equal(confirm.action, 'confirm'); assert.equal(confirm.productId, 1835); assert.equal(crafts, 0);
    assert.equal((await service.answer(player, { ...order, confirmed: true })).action, 'crafted'); assert.equal(crafts, 1);
    assert.equal(player.actor.backpack.fetchItems()[0].id, 91);
    assert.equal(service.entries({ ...player, accountId: 'bot_board' }).available, false);
    // A native craft can finish after character selection changes. Its old
    // character transaction must never replace the new character's backpack.
    let finishCraft;
    const originalActor = player.actor;
    const switched = create({ workshops: () => ({ lookup: () => ({ state: shop, recipe: { productId: 1835 }, price: 150 }),
        craft: () => new Promise(resolve => { finishCraft = resolve; }) }),
        database: () => ({ fetchItems: async () => [{ id: 99, selfId: 1835, amount: 1 }] }),
        response: () => ({ itemsList: () => { throw Error('old craft cannot redraw new inventory'); } }) });
    const pendingCraft = switched.answer(player, { ...order, confirmed: true });
    const newActor = { ...originalActor, backpack: { items: [{ id: 500 }] } };
    player.actor = newActor; finishCraft({ product: { id: 99, amount: 1 } });
    assert.equal((await pendingCraft).reason, 'player_unavailable');
    assert.deepEqual(newActor.backpack.items, [{ id: 500 }]); player.actor = originalActor;
    console.log('Player board server contract: native index/read pages, current quote, own record, physical store interaction, workshop adapter and no remote purchase passed');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
