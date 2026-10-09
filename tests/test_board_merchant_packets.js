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
const BoardWindow = invoke('GameServer/AfkTrade/PlayerBoardWindow');
const PrivateStoreBuy = invoke('GameServer/Network/Request/PrivateStoreBuy');
const PrivateStoreSell = invoke('GameServer/Network/Request/PrivateStoreSell');
const HtmlLink = invoke('GameServer/Network/Request/HtmlLink');
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
    await AfkTrade.init();

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

    // Follow the board's actual Buy/Sell links into Select and the native
    // store packets, then submit the C4 transaction payloads to SQLite.
    const click = async (side, label) => {
        BoardWindow.show(customer.session, { side, town: 'Giran' });
        const reply = customer.session.sent.at(-1);
        assert.equal(reply[0], 0x0f);
        const html = reply.toString('utf16le', 5, reply.length - 6);
        const command = new RegExp('action="bypass -h (board answer [^"]+)"><font[^>]*>' + label + '</font>').exec(html)[1];
        customer.session.sent = [];
        HtmlLink(customer.session, Buffer.concat([Buffer.from([0x21]), Buffer.from(command + '\0', 'utf16le')]));
        await new Promise(resolve => setImmediate(resolve));
    };
    await click(AfkTrade.SELL, 'Buy');
    const sellList = customer.session.sent.find(row => row[0] === 0x9b);
    assert(sellList, 'Buy opens the native seller list');
    assert.equal(sellList.readInt32LE(13), 1, 'the native seller list has a purchasable row');
    let projection = AfkTrade.findOwnerProjection(seller.id);
    const lot = projection.actor.fetchPrivateStore().items[0];
    const purchase = packet([projection.actor.fetchId(), 1, lot.objectId, 2, lot.price]);
    purchase[0] = 0x79;
    await PrivateStoreBuy(customer.session, purchase);
    assert.equal(await amount(customer.id, VARNISH), 7);
    assert.equal(await amount(customer.id, 57), 978);
    assert.equal((await Database.fetchAfkTradeShops(seller.id))[0].lines[0].count, 1);

    await click(AfkTrade.BUY, 'Sell');
    assert(customer.session.sent.some(row => row[0] === 0xb8), 'Sell opens the native buyer list');
    projection = AfkTrade.findOwnerProjection(buyer.id);
    const inventory = customer.session.actor.backpack.fetchItemFromSelfId(VARNISH);
    const request = Buffer.alloc(29);
    request[0] = 0x96;
    [projection.actor.fetchId(), 1, inventory.fetchId(), VARNISH].forEach((value, index) => request.writeInt32LE(value, 1 + index * 4));
    request.writeInt32LE(2, 21); request.writeInt32LE(7, 25);
    await PrivateStoreSell(customer.session, request);
    assert.equal(await amount(customer.id, VARNISH), 5);
    assert.equal(await amount(customer.id, 57), 992);
    assert.equal((await Database.fetchAfkTradeShops(buyer.id))[0].lines[0].count, 1);

    // Conditional advertisements expose their meeting point on the offer,
    // not on its trade store. Follow Location from a real SQLite record.
    const point = { locX: 83396, locY: 147904, locZ: -3404 };
    const ad = await Database.createAfkTradeShop(seller.id, { kind: 'sell_ad', storeType: AfkTrade.SELL,
        town: 'Giran', ...point, lines: [{ selfId: VARNISH, count: 1, price: 13 }] });
    AfkTrade.refreshRecord(ad.shop);
    customer.session.actor.setLocXYZ({ locX: 83255, locY: 148069, locZ: -3405 });
    BoardWindow.show(customer.session, { side: AfkTrade.SELL, town: 'Giran', selfId: VARNISH });
    const html = customer.session.sent.at(-1).toString('utf16le', 5, customer.session.sent.at(-1).length - 6);
    const locate = /action="bypass -h (board locate sell_ad [^"]+)"/.exec(html)[1];
    HtmlLink(customer.session, Buffer.concat([Buffer.from([0x21]), Buffer.from(locate + '\0', 'utf16le')]));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(customer.session.playerBoardWaypoint,
        { x: point.locX, y: point.locY, z: point.locZ, name: 'E43Seller' }, 'Location marks the actual advertisement meeting point');
    const marker = customer.session.sent.findLast(row => row[0] === 0xeb);
    assert(marker, 'Location sends a native radar packet');
    assert.deepEqual([9, 13, 17].map(offset => marker.readInt32LE(offset)), [point.locX, point.locY, point.locZ]);
    const buy = locate.replace('board locate ', 'board answer ');
    HtmlLink(customer.session, Buffer.concat([Buffer.from([0x21]), Buffer.from(buy + '\0', 'utf16le')]));
    await new Promise(resolve => setImmediate(resolve));
    const meetPage = customer.session.sent.at(-1);
    assert.equal(meetPage[0], 0x0f);
    assert.match(meetPage.toString('utf16le', 5, meetPage.length - 6), /Go to the meeting point/, 'Buy checks distance before preparing a meeting trade');
    assert.equal(customer.session.playerBoardPreparation, undefined, 'an out-of-range click creates no trade preparation');
    assert.equal(await amount(customer.id, VARNISH), 5);
    assert.equal(await amount(customer.id, 57), 992);

    AfkTrade._resetForTests();
    await Database.close();
    clean();
    console.log('Board: native Buy/Sell links open stores and settle C4 packets; NPC packets cannot bypass escrow (E43)');
})().catch(async (error) => {
    console.error(error);
    AfkTrade._resetForTests();
    try { await Database.close(); } catch (_) { /* cleanup only */ }
    clean();
    process.exitCode = 1;
});
