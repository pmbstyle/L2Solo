'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('non-stackable-awards');
require('../src/Global');
fixture.assertConfigured(options.default);
const Database = invoke('Database');
const Data = invoke('GameServer/DataCache');
const Backpack = invoke('GameServer/Actor/Backpack');
const Award = invoke('GameServer/World/Generics/PurchaseItem');
const PurchaseItems = invoke('GameServer/World/Generics/PurchaseItems');
const Limits = require('../src/GameServer/Inventory/InventoryLimits');
const Warehouse = invoke('GameServer/Warehouse/PersonalWarehouse');
const World = invoke('GameServer/World/World');
const Response = invoke('GameServer/Network/Response');
const Native = require('./helpers/nativeMarketFixture');
Data.init();
const id = 9401, account = 'spoil_instances';
const templates = Data.items.filter(item => item.etc?.stackable !== true).map(item => item.selfId);
const bag = async () => new Backpack({ id, items: await Database.fetchItems(id), paperdoll: utils.tupleAlloc(16, {}) });
const original = { userInfo: Response.userInfo, npc: World.npc };

(async () => {
    Database.init();
    try {
        await Native.character(Database, id, 'SpoilInstances', account);
        Response.userInfo = () => Buffer.alloc(0);
        const session = { accountId: account, dataSendToMe() {},
            activeNpcTalk: { objectId: 9001, selfId: 30001 },
            actor: { fetchId: () => id, fetchLocX: () => 0, fetchLocY: () => 0, backpack: await bag() } };
        World.npc = { spawns: [{ fetchId: () => 9001, fetchSelfId: () => 30001,
            fetchTitle: () => 'Warehouse Keeper', fetchLocX: () => 0, fetchLocY: () => 0 }] };
        await Award(session, 1, 3, { enchant: 7 });
        const swords = session.actor.backpack.fetchItems();
        assert.equal(swords.length, 3);
        assert.equal(new Set(swords.map(item => item.fetchId())).size, 3);
        assert(swords.every(item => item.fetchAmount() === 1 && item.fetchEnchantLevel() === 7));
        assert.deepEqual((await Database.fetchItems(id)).map(row => [row.amount, row.enchant]), [[1, 7], [1, 7], [1, 7]]);
        await Promise.all([Award(session, 1864, 10), Award(session, 1864, 5)]);
        assert.equal((await Database.fetchItems(id)).find(row => row.selfId === 1864).amount, 15);
        assert.equal(session.actor.backpack.fetchItems().filter(item => item.fetchSelfId() === 1864).length, 1);
        for (const amount of [0, -1, 1.5, NaN]) assert.equal(Award(session, 1, amount), false);
        const beforeLimit = (await Database.fetchItems(id)).length;
        await assert.rejects(Database.setItemInstances(id, { selfId: 1, amount: 0x7fffffff }), /exceeds inventory capacity/);
        assert.equal((await Database.fetchItems(id)).length, beforeLimit, 'an excessive equipment award writes no rows');
        let charged = 0, awards = 0;
        const buyer = { ...session, actor: { ...session.actor, backpack: {
            fetchItems: () => [], fetchTotalAdena: () => 1e9,
            deleteItem() { charged++; }, fetchItemFromSelfId: () => ({ fetchId: () => 77 })
        } } };
        const shop = { purchaseItem() { awards++; } };
        for (const free of [false, true]) {
            assert.equal(PurchaseItems.call(shop, buyer, [{ selfId: 307, amount: 0x7fffffff }], { free }), false);
            assert.equal(PurchaseItems.call(shop, buyer,
                [{ selfId: 1, amount: Limits.forActor(buyer.actor) }, { selfId: 19, amount: 1 }], { free }), false,
            'multiple valid lines cannot exceed the basket capacity');
        }
        assert.equal(charged, 0, 'a rejected equipment basket never takes payment');
        assert.equal(awards, 0, 'a rejected equipment basket schedules no item creation');

        const movedId = swords[0].fetchId();
        const stored = await Warehouse.deposit(session, [{ objectId: movedId, amount: 1 }]);
        assert(!session.actor.backpack.fetchItems().some(item => item.fetchId() === movedId), 'the deposited object leaves the bag');
        assert.equal(session.actor.backpack.fetchItems().filter(item => item.fetchSelfId() === 1).length, 2);
        assert.equal(stored.length, 1);
        assert.equal(stored[0].fetchAmount(), 1);
        assert.equal(stored[0].fetchEnchantLevel(), 7);
        await Warehouse.withdraw(session, [{ objectId: stored[0].fetchId(), amount: 1 }]);
        assert.equal((await Warehouse.list(session)).length, 0);
        assert.equal(session.actor.backpack.fetchItems().filter(item => item.fetchSelfId() === 1).length, 3);

        await Database.execute([`CREATE TRIGGER fail_second_shield BEFORE INSERT ON items
            WHEN NEW.selfId = 19 AND (SELECT COUNT(*) FROM items WHERE selfId = 19) >= 1
            BEGIN SELECT RAISE(ABORT, 'fixture award failure'); END`]);
        await assert.rejects(Database.setItemInstances(id, { selfId: 19, name: 'Shield', amount: 3 }), /fixture award failure/);
        assert(!(await Database.fetchItems(id)).some(row => row.selfId === 19), 'an award failure rolls back every copy');
        await Database.execute(['DROP TRIGGER fail_second_shield']);

        // Legacy hidden stacks in a bag and both personal warehouse tables.
        const legacy = await Database.setItem(id, { selfId: 19, name: 'Shield', amount: 3, enchant: 4, equipped: true, slot: 8 });
        await Database.setWarehouseItem(id, { selfId: 1, name: 'Sword', amount: 4, enchant: 6 });
        await Database.execute([`INSERT INTO account_warehouse_items(accountName,selfId,name,amount,enchant)
            VALUES (?,1,'Sword',2,5)`, [account]]);
        await Database.setItem(id, { selfId: 2375, name: 'Wolf', amount: 2, petData: { name: 'Existing pet' } });
        await Database.setItem(id, { selfId: 999999, name: 'Unknown', amount: 7 });
        await Database.execute([`CREATE TRIGGER fail_warehouse_repair BEFORE INSERT ON warehouse_items
            BEGIN SELECT RAISE(ABORT, 'fixture repair failure'); END`]);
        await assert.rejects(Database.splitNonStackableItems(templates), /fixture repair failure/);
        assert.equal((await Database.fetchItems(id)).find(row => row.id === Number(legacy.insertId)).amount, 3,
            'a later warehouse failure rolls back the earlier inventory repair');
        await Database.execute(['DROP TRIGGER fail_warehouse_repair']);
        const split = await Database.splitNonStackableItems(templates);
        assert.deepEqual(split, { rowsSplit: 3, copiesCreated: 6 });
        const shields = (await Database.fetchItems(id)).filter(row => row.selfId === 19);
        assert.equal(shields.length, 3);
        assert(shields.every(row => row.amount === 1 && row.enchant === 4));
        assert.equal(shields.find(row => row.id === Number(legacy.insertId)).equipped, 1, 'paperdoll object ID survives');
        assert.equal(shields.filter(row => row.equipped).length, 1, 'extra copies remain unequipped');
        assert.equal((await Database.fetchWarehouseItems(id)).length, 4);
        assert((await Database.fetchWarehouseItems(id)).every(row => row.amount === 1 && row.enchant === 6));
        assert.equal((await Warehouse.list(session)).length, 2);
        assert((await Warehouse.list(session)).every(item => item.fetchAmount() === 1 && item.fetchEnchantLevel() === 5));
        assert.equal((await Database.fetchItems(id)).find(row => row.selfId === 1864).amount, 15, 'materials stay stacked');
        assert.equal((await Database.fetchItems(id)).filter(row => row.selfId === 2375).length, 1, 'repair cannot clone pet identities');
        assert.equal((await Database.fetchItems(id)).find(row => row.selfId === 999999).amount, 7, 'unknown templates stay untouched');
        assert.deepEqual(await Database.splitNonStackableItems(templates), { rowsSplit: 0, copiesCreated: 0 });
        await Database.close(); Database.init();
        assert.equal((await bag()).fetchItems().filter(item => item.fetchSelfId() === 19).length, 3, 'separate objects survive reload');
        assert.deepEqual(await Database.splitNonStackableItems(templates), { rowsSplit: 0, copiesCreated: 0 }, 'restart cannot duplicate copies');
        console.log('PASS item instances: atomic awards, warehouse round trip and durable hidden-stack repair');
    } finally {
        Response.userInfo = original.userInfo; World.npc = original.npc;
        await Database.close();
        fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
