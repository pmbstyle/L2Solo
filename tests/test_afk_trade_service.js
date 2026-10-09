const assert = require('assert');
const fs = require('fs');
const path = require('path');
require('../src/Global');

const Actor = invoke('GameServer/Actor/Actor');
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const DataCache = invoke('GameServer/DataCache');
const Database = invoke('Database');
const PrivateStore = invoke('GameServer/PrivateStore');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const World = invoke('GameServer/World/World');
const databasePath = path.join(process.cwd(), 'tmp', 'test-afk-trade-service.sqlite');

function clean() {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(databasePath + suffix, { force: true });
}

function character(name) {
    return {
        name,
        race: 0,
        classId: 0,
        maxHp: 100,
        maxMp: 100,
        sex: 0,
        face: 0,
        hair: 0,
        hairColor: 0,
        locX: 83000,
        locY: 148000,
        locZ: -3400
    };
}

function sessionFor(accountId, row, items) {
    const sent = [];
    const session = {
        accountId,
        sent,
        socket: { write() {} },
        fetchAccountId() { return this.accountId; },
        dataSendToMe(packet) { sent.push(packet); },
        dataSendToOthers() {},
        dataSendToMeAndOthers(packet) { sent.push(packet); }
    };
    const classInfo = DataCache.classTemplates.find((entry) => Number(entry.classId) === Number(row.classId));
    session.actor = new Actor(session, {
        ...row,
        ...utils.crushOb(classInfo),
        items,
        paperdoll: utils.tupleAlloc(16, {})
    });
    session.actor.setIsOnline(true);
    return session;
}

(async () => {
    clean();
    options.default.Database.path = path.relative(process.cwd(), databasePath);
    Database.init();
    DataCache.init();
    World.user = { sessions: [], revision: 0 };

    await Database.createAccount('afk_service_owner', 'pw');
    await Database.createAccount('afk_service_customer', 'pw');
    const ownerId = Number((await Database.createCharacter('afk_service_owner', character('ServiceOwner'))).insertId);
    const customerId = Number((await Database.createCharacter('afk_service_customer', character('ServiceCustomer'))).insertId);
    const stockId = Number((await Database.setItem(ownerId, {
        selfId: 1865,
        name: 'Varnish',
        amount: 5,
        enchant: 0,
        equipped: false,
        slot: 0
    })).insertId);
    await Database.setItem(ownerId, {
        selfId: 57,
        name: 'Adena',
        amount: 100,
        enchant: 0,
        equipped: false,
        slot: 0
    });
    await Database.setItem(customerId, {
        selfId: 57,
        name: 'Adena',
        amount: 100,
        enchant: 0,
        equipped: false,
        slot: 0
    });
    const ownerRow = (await Database.fetchCharacters('afk_service_owner'))[0];
    const customerRow = (await Database.fetchCharacters('afk_service_customer'))[0];
    const owner = sessionFor('afk_service_owner', ownerRow, await Database.fetchItems(ownerId));
    const customer = sessionFor('afk_service_customer', customerRow, await Database.fetchItems(customerId));
    World.user.sessions.push(owner, customer);

    for (const town of Object.values(invoke('GameServer/World/TownRespawn').towns)) {
        owner.actor.setLocXYZ(town);
        for (const type of [AfkTrade.SELL, AfkTrade.BUY]) {
            assert.strictEqual(await AfkTrade.begin(owner, type), true, `${town.name}: AFK shop window opens`);
            assert.strictEqual(owner.afkTradeDraft, type);
            assert.strictEqual(PrivateStore.quit(owner, type), true);
        }
    }
    owner.actor.setLocXYZ({ locX: 0, locY: 0, locZ: 0 });
    for (const type of [AfkTrade.SELL, AfkTrade.BUY]) {
        assert.strictEqual(await AfkTrade.begin(owner, type), false, 'AFK shops remain blocked outside towns');
        assert.strictEqual(owner.afkTradeDraft, null);
    }
    owner.actor.setLocXYZ(character('ServiceOwner'));

    assert.strictEqual(await AfkTrade.begin(owner, AfkTrade.SELL), true);
    assert.strictEqual(owner.afkTradeDraft, AfkTrade.SELL);
    assert.strictEqual(PrivateStore.setTitle(owner, AfkTrade.SELL, 'AFK materials'), true);
    assert.strictEqual(
        await PrivateStore.publishSell(owner, true, [{ objectId: stockId, count: 3, price: 11 }]),
        false,
        'package sale must be rejected before any escrow changes'
    );
    assert.strictEqual(owner.actor.backpack.fetchItemRaw(stockId).fetchAmount(), 5);
    const published = await PrivateStore.publishSell(owner, false, [{ objectId: stockId, count: 3, price: 11 }]);
    assert.strictEqual(published, true);
    assert.strictEqual(owner.actor.fetchPrivateStoreType(), 0, 'live owner must leave store mode');
    assert.strictEqual(owner.actor.backpack.fetchItemRaw(stockId).fetchAmount(), 2, 'escrowed stock must leave live inventory');

    const shops = await Database.fetchAfkTradeShops(ownerId);
    assert.strictEqual(shops.length, 1);
    const projectionId = 900000000 + shops[0].id;
    const projection = AfkTrade.findProjection(projectionId);
    assert(projection, 'AFK projection must be registered');
    assert.strictEqual(projection.actor.fetchName(), 'ServiceOwner');
    assert.strictEqual(projection.actor.fetchPrivateStoreType(), 1);
    assert.strictEqual(projection.actor.fetchPrivateStore().items[0].count, 3);
    assert.strictEqual(AfkTrade.offers(1865, 1, { town: shops[0].town })[0].playerPriority, true);
    assert.deepStrictEqual(AfkTrade.offers(1864, 1, { town: shops[0].town }), [],
        'item-indexed lookup must not return unrelated AFK shops');
    World.user.sessions.push({
        accountId: 'bot_equal_market_offer',
        actor: {
            fetchId: () => 700001,
            fetchName: () => 'EqualBotSeller',
            fetchPrivateStore: () => ({
                storeType: 1,
                town: shops[0].town,
                items: [{ selfId: 1865, count: 3, price: 11 }]
            })
        }
    });
    assert.strictEqual(
        MarketOpportunity.bestOffer(1865, { town: shops[0].town, buyerCharacterId: customerId }).sourceType,
        'afk_player_store',
        'equal-price bot offer must yield to the player AFK shop'
    );

    owner.sent.length = 0;
    const trade = await AfkTrade.buyFromShop(
        customerId,
        projection.actor.fetchPrivateStore(),
        1865,
        1,
        { expectedPrice: 11 }
    );
    assert.strictEqual(trade.totalPrice, 11);
    assert(owner.sent.some(packet => packet[0] === 0x64 && packet.toString('utf16le', 13).includes('[AFK SALE] Sold 1x Varnish for 11 Adena.')));
    assert.strictEqual(owner.sent.filter(packet => packet[0] === 0x98).length, 1, 'committed sale plays one sound');
    assert(!owner.sent.some(packet => packet[0] === 0x4a), 'sale notification is not overhead speech');
    assert.strictEqual(customer.actor.backpack.fetchItemFromSelfId(1865).fetchAmount(), 1);
    assert.strictEqual(customer.actor.backpack.fetchTotalAdena(), 89);
    assert.strictEqual(owner.actor.backpack.fetchTotalAdena(), 111);
    assert.strictEqual(AfkTrade.findProjection(projectionId).actor.fetchPrivateStore().items[0].count, 2);
    assert.strictEqual(AfkTrade.findProjection(projectionId).actor.fetchPrivateStore().title, 'AFK materials',
        'player-authored shop titles must remain untouched');
    assert.strictEqual((await Database.fetchAfkTradeNotifications(ownerId)).length, 0, 'online owner notification must be marked delivered');

    await AfkTrade.stop(owner);
    assert.strictEqual(AfkTrade.findProjection(projectionId), null);
    assert.strictEqual(owner.actor.backpack.fetchItemRaw(stockId).fetchAmount(), 4, 'stop must return only unsold escrow');

    assert.strictEqual(await AfkTrade.begin(owner, AfkTrade.BUY), true);
    assert.strictEqual(PrivateStore.setTitle(owner, AfkTrade.BUY, 'AFK demand'), true);
    assert.strictEqual(await PrivateStore.publishBuy(owner, [{ selfId: 1865, enchant: 0, count: 2, price: 7 }]), true);
    const buyShop = (await Database.fetchAfkTradeShops(ownerId))[0];
    const buyProjectionId = 900000000 + buyShop.id;
    const buyProjection = AfkTrade.findProjection(buyProjectionId);
    assert.strictEqual(buyProjection.actor.fetchPrivateStoreType(), 3);
    assert(AfkTrade.activeDemandSelfIds().includes(1865), 'active AFK WTB stock must enter the demand index');
    assert.strictEqual(owner.actor.backpack.fetchTotalAdena(), 97, 'buy shop must reserve its complete budget');
    const customerVarnish = customer.actor.backpack.fetchItemFromSelfId(1865);
    owner.sent.length = 0;
    const saleToBuyer = await AfkTrade.sellToShop(
        customerId,
        buyProjection.actor.fetchPrivateStore(),
        1865,
        1,
        { objectId: customerVarnish.fetchId(), expectedPrice: 7 }
    );
    assert.strictEqual(saleToBuyer.totalPrice, 7);
    assert(owner.sent.some(packet => packet[0] === 0x64 && packet.toString('utf16le', 13).includes('[AFK BUY] Bought 1x Varnish for 7 Adena.')));
    assert.strictEqual(owner.sent.filter(packet => packet[0] === 0x98).length, 1, 'committed purchase plays one sound');
    assert(!owner.sent.some(packet => packet[0] === 0x4a), 'purchase notification is not overhead speech');
    assert.strictEqual(customer.actor.backpack.fetchTotalAdena(), 96);
    assert.strictEqual(owner.actor.backpack.fetchItemFromSelfId(1865).fetchAmount(), 5);
    assert.strictEqual(AfkTrade.findProjection(buyProjectionId).actor.fetchPrivateStore().items[0].count, 1);
    await AfkTrade.stop(owner);
    assert(!AfkTrade.activeDemandSelfIds().includes(1865), 'closing an AFK WTB must remove its indexed demand');
    assert.strictEqual(owner.actor.backpack.fetchTotalAdena(), 104, 'unused buy reserve must return after stop');

    assert.strictEqual(await AfkTrade.begin(owner, AfkTrade.SELL), true);
    const restartStock = owner.actor.backpack.fetchItemFromSelfId(1865);
    assert.strictEqual(await PrivateStore.publishSell(owner, false, [{
        objectId: restartStock.fetchId(), count: 1, price: 13
    }]), true);
    const restartShop = (await Database.fetchAfkTradeShops(ownerId))[0];
    const restartProjectionId = 900000000 + restartShop.id;
    AfkTrade._resetForTests();
    await Database.close();
    Database.init();
    assert.strictEqual(await AfkTrade.init(), 1);
    assert(AfkTrade.findProjection(restartProjectionId), 'active projection must survive a database restart');
    assert.strictEqual(await PrivateStore.open(owner, AfkTrade.BUY), true, 'native store opening must close an active AFK shop');
    assert.strictEqual(AfkTrade.findProjection(restartProjectionId), null);
    assert.strictEqual(owner.actor.fetchPrivateStoreType(), 4);
    assert.strictEqual(PrivateStore.quit(owner, AfkTrade.BUY), true);

    await Database.setSkill({ selfId: 1370, name: 'Expand Trade', passive: true, level: 3 }, ownerId);
    await owner.actor.skillset.populate(ownerId);
    assert.strictEqual(owner.actor.skillset.fetchSkill(1370).fetchLevel(), 3, 'Expand Trade loads from persisted skills');
    assert.strictEqual(await AfkTrade.begin(owner, AfkTrade.BUY), true);
    const sixRows = [1865, 1864, 1866, 1867, 1868, 1869].map(selfId => ({ selfId, count: 1, price: 1 }));
    assert.strictEqual(await PrivateStore.publishBuy(owner, sixRows), true);
    assert.strictEqual((await Database.fetchAfkTradeShops(ownerId))[0].lines.length, 6);
    assert.strictEqual(AfkTrade.findOwnerProjection(ownerId).actor.fetchPrivateStore().items.length, 6);
    await AfkTrade.stop(owner);

    await Database.createAccount('bot_title_owner', 'pw');
    const botId = Number((await Database.createCharacter('bot_title_owner', character('TitleOwner'))).insertId);
    const titleRows = [];
    for (const [selfId, name, count] of [[1804, 'Alpha', 3], [1805, 'Beta', 2]]) {
        const objectId = Number((await Database.setItem(botId, { selfId, name, amount: count })).insertId);
        titleRows.push({ objectId, selfId, name, count, price: 1, stackable: true });
    }
    await Database.setItem(botId, { selfId: 57, name: 'Adena', amount: 100 });
    const placement = { town: 'Giran', locX: 83000, locY: 148000, locZ: -3400,
        appearance: { model: { ...character('TitleOwner'), title: '' } } };
    await AfkTrade.publishBot(botId, { ...placement, storeType: AfkTrade.SELL,
        title: 'Alpha x3, Beta x2', lines: titleRows });
    const titleProjection = AfkTrade.findOwnerProjection(botId);
    const Response = invoke('GameServer/Network/Response');
    customer.sent.length = 0;
    await AfkTrade.repriceBot(botId, titleProjection.shop.lines[0].id, 1);
    assert(!customer.sent.some(packet => packet[0] === Response.privateStoreMsg(titleProjection.actor, '').at(0)),
        'an unchanged title must not produce an extra title packet');
    await AfkTrade.buyFromShop(customerId, titleProjection.actor.fetchPrivateStore(), 1804, 1);
    assert.strictEqual(titleProjection.shop.title, 'Alpha x2, Beta x2');
    assert(customer.sent.some(packet => packet.equals(Response.privateStoreMsg(titleProjection.actor, 'Alpha x2, Beta x2'))),
        'a nearby viewer must receive the changed native sell title');
    await AfkTrade.buyFromShop(customerId, titleProjection.actor.fetchPrivateStore(), 1804, 2);
    assert.strictEqual(titleProjection.shop.title, 'Beta x2', 'sold-out first item must disappear from the title');
    assert.strictEqual((await Database.fetchAfkTradeShops(botId))[0].title, 'Beta x2', 'new title must be durable');
    await Database.execute(["UPDATE afk_trade_shops SET title = 'Stale sold-out item' WHERE ownerId = ? AND status = 'active'", [botId]]);
    await AfkTrade.repriceBot(botId, titleProjection.shop.lines.find(line => line.count > 0).id, 1);
    assert.strictEqual((await Database.fetchAfkTradeShops(botId))[0].title, 'Beta x2',
        'an unchanged reprice repairs legacy stale titles without changing stock');
    const betaLine = titleProjection.shop.lines.find(line => line.selfId === 1805);
    await AfkTrade.repriceBot(botId, betaLine.id, 1, null, 1);
    assert.strictEqual(titleProjection.shop.title, 'Beta', 'reducing listed quantity must refresh its title too');
    await AfkTrade.stop(botId);
    await AfkTrade.publishBot(botId, { ...placement, storeType: AfkTrade.BUY,
        title: 'WTB Alpha x2, Beta x2', lines: titleRows.map(line => ({ ...line, count: 2 })) });
    const titleBuyer = AfkTrade.findOwnerProjection(botId);
    customer.sent.length = 0;
    await AfkTrade.sellToShop(customerId, titleBuyer.actor.fetchPrivateStore(), 1804, 2,
        { objectId: customer.actor.backpack.fetchItemFromSelfId(1804).fetchId() });
    assert.strictEqual(titleBuyer.shop.title, 'WTB Beta x2', 'filled buy request must disappear from the title');
    assert(customer.sent.some(packet => packet.equals(Response.privateStoreBuyMsg(titleBuyer.actor, 'WTB Beta x2'))),
        'a nearby viewer must receive the changed native buy title');
    await AfkTrade.stop(botId);
    const shotObject = Number((await Database.setItem(botId, { selfId: 1464, name: 'Soulshot: C-grade', amount: 1000 })).insertId);
    await Database.execute(['UPDATE items SET amount = amount + 10000 WHERE characterId = ? AND selfId = 57', [customerId]]);
    await AfkTrade.publishBot(botId, { ...placement, storeType: AfkTrade.SELL,
        title: 'Soulshot: C-grade x1000', lines: [{ objectId: shotObject, selfId: 1464,
            name: 'Soulshot: C-grade', count: 1000, price: 1, stackable: true }] });
    await AfkTrade.buyFromShop(customerId, AfkTrade.findOwnerProjection(botId).actor.fetchPrivateStore(), 1464, 501);
    const remainderShop = AfkTrade.findOwnerProjection(botId);
    assert(remainderShop, 'a positive residual lot remains listed until its owner reviews or closes it');
    assert.strictEqual(remainderShop.shop.lines.find(line => line.selfId === 1464).count, 499,
        'the current lot policy has no hard minimum of 500 shots');
    await AfkTrade.stop(botId);
    assert.strictEqual((await Database.fetchItems(botId)).filter(row => row.selfId === 1464)
        .reduce((sum, row) => sum + row.amount, 0), 499, 'closing the shop returns the small remainder intact to its owner');
    await Database.createAccount('bot_shot_order', 'pw');
    const orderOwner = Number((await Database.createCharacter('bot_shot_order', character('ShotOrder'))).insertId);
    await Database.setItem(orderOwner, { selfId: 57, name: 'Adena', amount: 1000 });
    const matchObject = Number((await Database.setItem(botId, { selfId: 1463, name: 'Soulshot: D-grade', amount: 1000 })).insertId);
    await AfkTrade.publishBot(botId, { ...placement, storeType: AfkTrade.SELL, title: 'D shots',
        lines: [{ objectId: matchObject, selfId: 1463, name: 'Soulshot: D-grade', count: 1000, price: 1, stackable: true }] });
    await AfkTrade.publishBot(orderOwner, { ...placement, storeType: AfkTrade.BUY, title: 'WTB shots',
        lines: [{ selfId: 1463, name: 'Soulshot: D-grade', count: 501, price: 1, stackable: true }] });
    // A crossing buy ad and sell line make no deal by themselves: someone
    // must come to the town (E45).
    assert(AfkTrade.findOwnerProjection(botId), 'the shop stands');
    assert.strictEqual(AfkTrade.ownerRecords(orderOwner).length, 1, 'the buy ad stands');
    await AfkTrade._resetForTests();
    await Database.close();
    clean();
    console.log('AFK trade service checks passed');
})().catch(async (error) => {
    console.error(error);
    try { AfkTrade._resetForTests(); } catch (_) {}
    try { await Database.close(); } catch (_) {}
    clean();
    process.exitCode = 1;
});
