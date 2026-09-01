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
        MarketOpportunity.findOffers(1865, { town: shops[0].town, buyerCharacterId: customerId })[0].sourceType,
        'afk_player_store',
        'equal-price bot offer must yield to the player AFK shop'
    );

    const trade = await AfkTrade.buyFromShop(
        customerId,
        projection.actor.fetchPrivateStore(),
        1865,
        1,
        { expectedPrice: 11 }
    );
    assert.strictEqual(trade.totalPrice, 11);
    assert.strictEqual(customer.actor.backpack.fetchItemFromSelfId(1865).fetchAmount(), 1);
    assert.strictEqual(customer.actor.backpack.fetchTotalAdena(), 89);
    assert.strictEqual(owner.actor.backpack.fetchTotalAdena(), 111);
    assert.strictEqual(AfkTrade.findProjection(projectionId).actor.fetchPrivateStore().items[0].count, 2);
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
    assert.strictEqual(owner.actor.backpack.fetchTotalAdena(), 97, 'buy shop must reserve its complete budget');
    const customerVarnish = customer.actor.backpack.fetchItemFromSelfId(1865);
    const saleToBuyer = await AfkTrade.sellToShop(
        customerId,
        buyProjection.actor.fetchPrivateStore(),
        1865,
        1,
        { objectId: customerVarnish.fetchId(), expectedPrice: 7 }
    );
    assert.strictEqual(saleToBuyer.totalPrice, 7);
    assert.strictEqual(customer.actor.backpack.fetchTotalAdena(), 96);
    assert.strictEqual(owner.actor.backpack.fetchItemFromSelfId(1865).fetchAmount(), 5);
    assert.strictEqual(AfkTrade.findProjection(buyProjectionId).actor.fetchPrivateStore().items[0].count, 1);
    await AfkTrade.stop(owner);
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
