// E43 (step 3.3 group B): a shop on the board trades only through the board.
// Select opens a trade window on an AFK projection too (activeMerchantTrade);
// the NPC buy and sell packets (Purchase 0x1f, Sell 0x1e) sent to it must not
// trade the projection's in-memory store around the record and its escrow.
// The board's own path is PrivateStoreBuy / PrivateStoreSell.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
require('../src/Global');

const Actor = invoke('GameServer/Actor/Actor');
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const DataCache = invoke('GameServer/DataCache');
const Database = invoke('Database');
const World = invoke('GameServer/World/World');
const Purchase = invoke('GameServer/Network/Request/Purchase');
const Sell = invoke('GameServer/Network/Request/Sell');
const databasePath = path.join(process.cwd(), 'tmp', 'test-board-merchant-packets.sqlite');
const VARNISH = 1865;

function clean() {
    const history = databasePath.replace(/\.sqlite$/, '.history.sqlite');
    for (const file of [databasePath, history]) {
        for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
    }
}

function character(name) {
    return { name, race: 0, classId: 0, maxHp: 100, maxMp: 100, sex: 0, face: 0, hair: 0, hairColor: 0,
        locX: 83000, locY: 148000, locZ: -3400 };
}

async function player(account, name, items) {
    await Database.createAccount(account, 'pw');
    const id = Number((await Database.createCharacter(account, character(name))).insertId);
    for (const item of items) {
        await Database.setItem(id, { name: `Item ${item.selfId}`, enchant: 0, equipped: false, slot: 0, ...item });
    }
    const row = (await Database.fetchCharacters(account))[0];
    const session = { accountId: account, sent: [], socket: { write() {} }, fetchAccountId() { return this.accountId; },
        dataSendToMe(packet) { this.sent.push(packet); }, dataSendToOthers() {}, dataSendToMeAndOthers() {} };
    const classInfo = DataCache.classTemplates.find((entry) => Number(entry.classId) === 0);
    session.actor = new Actor(session, { ...row, ...utils.crushOb(classInfo), items: await Database.fetchItems(id),
        paperdoll: utils.tupleAlloc(16, {}) });
    session.actor.setIsOnline(true);
    return { id, session };
}

async function amount(characterId, selfId) {
    const [row] = await Database.execute(['SELECT COALESCE(SUM(amount), 0) AS amount FROM items WHERE characterId = ? AND selfId = ?',
        [characterId, selfId]]);
    return Number(row.amount);
}

// What Select leaves on a session that clicked the projection.
function openWindow(session, projection) {
    const store = projection.actor.fetchPrivateStore();
    session.activeMerchantTrade = { merchant: projection.actor, store, revision: store.revision,
        prices: Object.fromEntries(store.items.map((line) => [Number(line.selfId), Number(line.price)])) };
}

function packet(values) {
    const buffer = Buffer.alloc(1 + values.length * 4);
    values.forEach((value, index) => buffer.writeInt32LE(value, 1 + index * 4));
    return buffer;
}

(async () => {
    clean();
    options.default.Database.path = path.relative(process.cwd(), databasePath);
    Database.init();
    DataCache.init();
    World.user = { sessions: [], revision: 0 };

    const seller = await player('bot_e43_seller', 'E43Seller', [{ selfId: VARNISH, amount: 5 }]);
    const buyer = await player('bot_e43_buyer', 'E43Buyer', [{ selfId: 57, amount: 1000 }]);
    const customer = await player('e43_customer', 'E43Customer', [{ selfId: 57, amount: 1000 }, { selfId: VARNISH, amount: 5 }]);
    const stock = (await Database.fetchItems(seller.id)).find((row) => Number(row.selfId) === VARNISH);
    const sale = await Database.createAfkTradeShop(seller.id, { kind: 'shop', storeType: AfkTrade.SELL, town: 'Giran',
        locX: 83000, locY: 148000, locZ: -3400, lines: [{ objectId: stock.id, selfId: VARNISH, count: 3, price: 11 }] });
    AfkTrade.refreshRecord(sale.shop);
    const wanted = await Database.createAfkTradeShop(buyer.id, { kind: 'shop', storeType: AfkTrade.BUY, town: 'Giran',
        locX: 83000, locY: 148000, locZ: -3400, lines: [{ selfId: VARNISH, count: 3, price: 7 }] });
    AfkTrade.refreshRecord(wanted.shop);
    World.user.sessions.push(customer.session);

    // Purchase (0x1f) on a sell projection.
    openWindow(customer.session, AfkTrade.findOwnerProjection(seller.id));
    await Purchase(customer.session, packet([0, 1, VARNISH, 2]));
    const failures = [];
    const customerVarnish = await amount(customer.id, VARNISH);
    const customerAdena = await amount(customer.id, 57);
    const [saleLine] = (await Database.fetchAfkTradeShops(seller.id))[0].lines;
    if (customerVarnish !== 5 || customerAdena !== 1000 || Number(saleLine.count) !== 3) {
        failures.push(`Purchase: customer varnish ${customerVarnish} adena ${customerAdena}, board line ${saleLine.count}`);
    }

    // Sell (0x1e) to a buy projection.
    openWindow(customer.session, AfkTrade.findOwnerProjection(buyer.id));
    const own = customer.session.actor.backpack.fetchItems().find((item) => item.fetchSelfId() === VARNISH);
    await Sell.consumeMerchant(customer.session, [{ objectId: own.fetchId(), selfId: VARNISH, amount: 2 }]);
    const afterVarnish = await amount(customer.id, VARNISH);
    const afterAdena = await amount(customer.id, 57);
    const buyRecord = (await Database.fetchAfkTradeShops(buyer.id))[0];
    if (afterVarnish !== customerVarnish || afterAdena !== customerAdena || Number(buyRecord.lines[0].count) !== 3) {
        failures.push(`Sell: customer varnish ${customerVarnish}->${afterVarnish} adena ${customerAdena}->${afterAdena}, `
            + `board line ${buyRecord.lines[0].count}, escrow ${buyRecord.escrowAdena}`);
    }
    assert.deepStrictEqual(failures, [], 'E43: an AFK projection trades only through the board');

    AfkTrade._resetForTests();
    await Database.close();
    clean();
    console.log('Board: the NPC trade packets never trade an AFK projection (E43)');
})().catch(async (error) => {
    console.error(error);
    try { await Database.close(); } catch (_) { /* cleanup only */ }
    clean();
    process.exitCode = 1;
});
