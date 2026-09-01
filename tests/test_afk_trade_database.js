const assert = require('assert');
const fs = require('fs');
const path = require('path');
require('../src/Global');

const Database = invoke('Database');
const databasePath = path.join(process.cwd(), 'tmp', 'test-afk-trade.sqlite');

function clean() {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(databasePath + suffix, { force: true });
}

function character(name, locX = 83000) {
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
        locX,
        locY: 148000,
        locZ: -3400
    };
}

async function inventory(characterId) {
    return Database.fetchItems(characterId);
}

function amountOf(rows, selfId) {
    return rows.filter((row) => Number(row.selfId) === Number(selfId))
        .reduce((sum, row) => sum + Number(row.amount), 0);
}

(async () => {
    clean();
    options.default.Database.path = path.relative(process.cwd(), databasePath);
    Database.init();

    await Database.createAccount('afk_owner', 'pw');
    await Database.createAccount('afk_customer', 'pw');
    const ownerId = Number((await Database.createCharacter('afk_owner', character('AfkOwner'))).insertId);
    const customerId = Number((await Database.createCharacter('afk_customer', character('AfkCustomer'))).insertId);
    const stockId = Number((await Database.setItem(ownerId, {
        selfId: 1001, name: 'Test Material', amount: 10, enchant: 0, equipped: false, slot: 0
    })).insertId);
    await Database.setItem(customerId, {
        selfId: 57, name: 'Adena', amount: 1000, enchant: 0, equipped: false, slot: 0
    });

    const sale = await Database.createAfkTradeShop(ownerId, {
        storeType: 1,
        title: 'Persistent sale',
        town: 'Giran',
        locX: 83000,
        locY: 148000,
        locZ: -3400,
        appearance: { model: { name: 'AfkOwner' } },
        lines: [{ objectId: stockId, selfId: 1001, name: 'Test Material', count: 4, price: 10, stackable: true }]
    });
    assert.strictEqual(amountOf(sale.ownerInventory, 1001), 6, 'sale stock must leave usable inventory');
    assert.strictEqual((await Database.fetchAfkTradeShops(ownerId))[0].lines[0].count, 4);

    const purchased = await Database.buyFromAfkTradeShop(customerId, {
        shopId: sale.shop.id,
        ownerId,
        lineId: sale.shop.lines[0].id,
        amount: 2,
        expectedPrice: 10,
        expectedRevision: 1
    });
    assert.strictEqual(purchased.filled, false);
    assert.strictEqual(amountOf(purchased.ownerInventory, 57), 20);
    assert.strictEqual(amountOf(purchased.counterpartyInventory, 57), 980);
    assert.strictEqual(amountOf(purchased.counterpartyInventory, 1001), 2);
    assert.strictEqual(purchased.shop.lines[0].count, 2);

    const stoppedSale = await Database.closeAfkTradeShop(ownerId);
    assert.strictEqual(stoppedSale.closed, true);
    assert.strictEqual(amountOf(stoppedSale.ownerInventory, 1001), 8, 'unsold escrow must return to owner');

    await Database.setItem(ownerId, {
        selfId: 57, name: 'Adena', amount: 100, enchant: 0, equipped: false, slot: 0
    });
    const customerStockId = Number((await Database.setItem(customerId, {
        selfId: 2002, name: 'Wanted Material', amount: 3, enchant: 0, equipped: false, slot: 0
    })).insertId);
    const purchaseShop = await Database.createAfkTradeShop(ownerId, {
        storeType: 3,
        title: 'Persistent purchase',
        town: 'Giran',
        locX: 83000,
        locY: 148000,
        locZ: -3400,
        appearance: { model: { name: 'AfkOwner' } },
        lines: [{ selfId: 2002, name: 'Wanted Material', count: 3, price: 5, stackable: true }]
    });
    assert.strictEqual(amountOf(purchaseShop.ownerInventory, 57), 105, 'buy escrow must reserve exact Adena');

    const sold = await Database.sellToAfkTradeShop(customerId, {
        shopId: purchaseShop.shop.id,
        ownerId,
        lineId: purchaseShop.shop.lines[0].id,
        objectId: customerStockId,
        amount: 2,
        expectedPrice: 5,
        expectedRevision: 1
    });
    assert.strictEqual(amountOf(sold.ownerInventory, 2002), 2);
    assert.strictEqual(amountOf(sold.counterpartyInventory, 2002), 1);
    assert.strictEqual(amountOf(sold.counterpartyInventory, 57), 990);
    assert.strictEqual(sold.shop.escrowAdena, 5);

    const stoppedPurchase = await Database.closeAfkTradeShop(ownerId);
    assert.strictEqual(amountOf(stoppedPurchase.ownerInventory, 57), 110, 'unused buy escrow must return');
    const events = await Database.fetchAfkTradeNotifications(ownerId);
    assert.strictEqual(events.length, 2);
    assert.deepStrictEqual(events.map((event) => event.kind), ['sale', 'purchase']);
    await Database.markAfkTradeNotificationsDelivered(ownerId, events.map((event) => event.id));
    assert.strictEqual((await Database.fetchAfkTradeNotifications(ownerId)).length, 0);

    const currentStock = (await inventory(ownerId)).find((row) => row.selfId === 1001);
    await Database.createAfkTradeShop(ownerId, {
        storeType: 1,
        title: 'Restart sale',
        town: 'Giran',
        locX: 83000,
        locY: 148000,
        locZ: -3400,
        appearance: { model: { name: 'AfkOwner' } },
        lines: [{ objectId: currentStock.id, selfId: 1001, name: 'Test Material', count: 1, price: 12, stackable: true }]
    });
    await Database.close();
    Database.init();
    const restored = await Database.fetchAfkTradeShops(ownerId);
    assert.strictEqual(restored.length, 1);
    assert.strictEqual(restored[0].title, 'Restart sale');
    assert.strictEqual(restored[0].lines[0].count, 1);
    await Database.closeAfkTradeShop(ownerId);
    await Database.close();
    clean();
    console.log('AFK trade database checks passed');
})().catch(async (error) => {
    console.error(error);
    try { await Database.close(); } catch (_) {}
    clean();
    process.exitCode = 1;
});
