'use strict';
const assert = require('node:assert/strict');
const { BoardIndex, SELL, BUY } = require('../src/GameServer/AfkTrade/BoardIndex');
const { create } = require('../src/GameServer/AfkTrade/PlayerBoardService');

async function main() {
    const board = new BoardIndex();
    let selects = 0, crafts = 0, x = 0;
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
    const shop = { characterId: 55, currentRegion: 'Dion', loc: { locX: 5000, locY: 0, locZ: 0 }, simulation: { revision: 2 } };
    const service = create({ afk: () => ({ isBoardReady: () => true, boardIndex: () => board,
        offerOf: (line) => ({ sourceName: `Trader${line.ownerId}`, itemName: `Item${line.selfId}`, projection: line.ref.projection }),
        buyFromShop() { throw Error('remote purchase forbidden'); }, sellToShop() { throw Error('remote sale forbidden'); } }),
    life: () => ({ cachedState: (id) => ({ characterId: id, loc: { locX: 7000, locY: 0, locZ: 0 }, currentRegion: 'Dion' }) }),
    workshops: () => ({ boardRecords: () => [{ id: 'workshop_55', kind: 'workshop', ownerId: 55, ownerName: 'Maker',
        town: 'Dion', loc: shop.loc, revision: 2, entries: [{ recipeId: 17, price: 150 }] }],
    lookup: () => ({ state: shop, price: 150 }), craft: async (owner, recipe, customer, options) => {
        assert.deepEqual([owner, recipe, customer, options.expectedPrice], [55, 17, 8, 150]); crafts++;
        return { product: { id: 91, amount: 1 } };
    } }), database: () => ({ fetchItems: async () => [{ id: 91, selfId: 1835, amount: 1 }] }),
    response: () => ({ itemsList: (items) => items }) });
    const listed = service.entries(player, { selfId: 1152, side: SELL });
    assert.equal(listed.entries.length, 1); assert.equal(listed.entries[0].price, 600);
    assert.equal(service.entries(player, { limit: 1 }).more, true);
    const request = { id: 1, lineId: 11, selfId: 1152, price: 600, revision: 4 };
    assert.equal((await service.answer(player, request)).action, 'meet'); assert.equal(selects, 0);
    x = 1000; assert.equal((await service.answer(player, request)).action, 'store_opened'); assert.equal(selects, 2);
    board.put({ ...record, revision: 5, lines: [{ ...record.lines[0], price: 700 }] }, { projection: { actor: merchant } });
    assert.equal((await service.answer(player, request)).reason, 'record_changed'); assert.equal(selects, 2);
    assert.equal((await service.answer(player, { id: 3, lineId: 13, selfId: 1152, price: 500, revision: 4 })).reason, 'own_record');
    assert.equal((await service.answer(player, { id: 2, lineId: 12, selfId: 1864, price: 90, revision: 4 })).action, 'contact');
    const workshop = service.entries(player, { kind: 'workshop' }).entries[0];
    assert.equal(workshop.price, 150);
    const order = { ...workshop, kind: 'workshop' };
    assert.equal((await service.answer(player, order)).action, 'meet'); assert.equal(crafts, 0);
    x = 5000; assert.equal((await service.answer(player, { ...order, price: 151 })).reason, 'record_changed');
    assert.equal((await service.answer(player, order)).action, 'crafted'); assert.equal(crafts, 1);
    assert.equal(player.actor.backpack.fetchItems()[0].id, 91);
    assert.equal(service.entries({ ...player, accountId: 'bot_board' }).available, false);
    console.log('Player board server contract: native index/read pages, current quote, own record, physical store interaction, workshop adapter and no remote purchase passed');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
