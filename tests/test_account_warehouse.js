const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
require('./helpers/databaseIsolation');
delete process.env.L2NODE_SHARED_CONFIG_FILE;
process.env.L2NODE_CONFIG_FILE = 'config/default.ini';
require('../src/Global');
const { DatabaseSync } = require('node:sqlite');
const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const Item = invoke('GameServer/Item/Item');
const Warehouse = invoke('GameServer/Warehouse/PersonalWarehouse');
const WarehouseWindow = invoke('GameServer/World/Generics/NpcBypasses/Warehouse');
const Request = invoke('GameServer/Network/Request');
const Response = invoke('GameServer/Network/Response');
const World = invoke('GameServer/World/World');
const Limits = require('../src/GameServer/Warehouse/PersonalWarehouseLimits');
const { createActorCollections } = require('../src/WorldObserver/ActorCollections');

const databasePath = path.resolve('tmp', `test-account-warehouse-${process.pid}.sqlite`);
const historyPath = path.resolve('tmp', `test-account-warehouse-${process.pid}-history.sqlite`);
const petData = JSON.stringify({ name: 'SharedWolf', level: 20, hp: 99 });
const templates = [
    { selfId: 1864, name: 'Stem', kind: 'Other.Material', stackable: true, class1: 4, class2: 5, mass: 1 },
    { selfId: 627, name: 'Aspis', kind: 'Armor.Shield', stackable: false, class1: 1, class2: 1, slot: 8, mass: 1350 },
    { selfId: 2375, name: 'Wolf Collar', kind: 'Other', stackable: false, class1: 4, class2: 5, mass: 1 }
];
DataCache.items = templates;
function materialize(row) { return new Item(row.id, { ...templates.find(t => t.selfId === row.selfId), ...row, equipped: false }); }
function session(id, accountId) {
    const result = { accountId, sent: [], activeNpcTalk: { objectId: 9001, selfId: 30001 },
        dataSendToMe(packet) { this.sent.push(packet); } };
    result.actor = { session: result, fetchId: () => id, fetchRace: () => id === 2 ? 4 : 0,
        fetchLocX: () => 0, fetchLocY: () => 0,
        backpack: { items: [], fetchItems() { return this.items; }, fetchTotalAdena: () => 0 } };
    return result;
}
async function reload(current) {
    current.actor.backpack.items = (await Database.fetchItems(current.actor.fetchId())).map(materialize);
}
function packet(id, amount) {
    const result = Buffer.alloc(13);
    result.writeInt32LE(1, 1); result.writeInt32LE(id, 5); result.writeInt32LE(amount, 9);
    return result;
}
function clean() {
    for (const base of [databasePath, historyPath]) {
        for (const suffix of ['', '-wal', '-shm']) fs.rmSync(base + suffix, { force: true });
    }
}
function seed() {
    clean();
    const db = new DatabaseSync(databasePath);
    try {
        db.exec(fs.readFileSync(path.resolve('database/sql/sqlite.sql'), 'utf8'));
        for (const account of ['Shared', 'Other', 'bot_shared', 'LegacyBot']) {
            db.prepare('INSERT INTO accounts VALUES (?, ?)').run(account, 'test-only');
        }
        for (const [id, account] of [[1, 'Shared'], [2, 'shared'], [3, 'Other'], [4, 'bot_shared'], [5, 'bot_shared'], [6, 'LegacyBot']]) {
            db.prepare(`INSERT INTO characters (id, username, name, classId, race, maxHp, maxMp, sex, face, hair, hairColor, locX, locY, locZ)
                VALUES (?, ?, ?, 0, 0, 100, 100, 0, 0, 0, 0, 0, 0, 0)`).run(id, account, `Character${id}`);
        }
        const stock = db.prepare(`INSERT INTO warehouse_items (id, selfId, name, amount, enchant, petData, characterId)
            VALUES (?, ?, 'Legacy stock', ?, ?, ?, ?)`);
        stock.run(101, 1864, 10, 0, null, 1);
        stock.run(102, 627, 1, 7, null, 2);
        stock.run(103, 2375, 1, 0, petData, 1);
        stock.run(104, 1864, 9, 0, null, 3);
        stock.run(105, 1864, 15, 0, null, 4);
        stock.run(106, 1864, 16, 0, null, 5);
        stock.run(107, 1864, 17, 0, null, 6);
        db.exec("INSERT INTO bot_life_state (characterId, accountName) VALUES (6, 'LegacyBot')");
        const bag = db.prepare(`INSERT INTO items (id, selfId, name, amount, enchant, characterId)
            VALUES (?, ?, 'Inventory stock', ?, ?, ?)`);
        bag.run(201, 1864, 5, 0, 1);
        bag.run(202, 627, 1, 4, 1);
        bag.run(203, 627, 1, 3, 1);
    } finally { db.close(); }
}

async function main() {
    seed();
    options.default.Database.path = databasePath;
    options.default.Database.historyPath = historyPath;
    Database.init();
    World.npc = { spawns: [{ fetchId: () => 9001, fetchSelfId: () => 30001,
        fetchTitle: () => 'Warehouse Keeper', fetchLocX: () => 0, fetchLocY: () => 0 }] };
    const first = session(1, 'SHARED'), second = session(2, 'shared'), outsider = session(3, 'Other');
    try {
        assert.deepEqual((await Warehouse.list(first)).map(item => item.fetchId()), [101, 102, 103]);
        assert.deepEqual((await Warehouse.list(second)).map(item => item.fetchId()), [101, 102, 103]);
        assert.deepEqual((await Warehouse.list(outsider)).map(item => item.fetchId()), [104]);
        assert.deepEqual((await Database.fetchWarehouseItems(4)).map(row => row.id), [105]);
        assert.deepEqual((await Database.fetchWarehouseItems(5)).map(row => row.id), [106], 'bots on one account keep separate stock');
        assert.deepEqual((await Database.fetchWarehouseItems(6)).map(row => row.id), [107], 'lifecycle bots with old account names stay isolated');
        assert.equal((await Database.fetchWarehouseItems(1)).length, 0, 'migration removes the original copies');
        assert.equal(Response.exStorageMaxCount(first.actor).readInt32LE(7), 300);
        assert.equal(Response.exStorageMaxCount(second.actor).readInt32LE(7), 300, 'dwarf and human share the same account limit');
        const bot = session(4, 'bot_shared');
        bot.actor.skillset = { fetchSkill: id => id === 1371 ? { fetchLevel: () => 2 } : null };
        assert.equal(Response.exStorageMaxCount(bot.actor).readInt32LE(7), 112, 'bots keep C4 race and skill limits');
        assert.equal((await Warehouse.list(bot))[0].fetchId(), 105);

        await reload(first);
        await WarehouseWindow(first, ['warehouse', 'deposit']);
        await Request.warehouseDeposit(first, packet(201, 3));
        assert.equal(first.actor.backpack.items.find(item => item.fetchId() === 201).fetchAmount(), 2);
        assert.equal((await Warehouse.list(second)).find(item => item.fetchId() === 101).fetchAmount(), 13);
        await WarehouseWindow(second, ['warehouse', 'withdraw']);
        const offered = second.sent.findLast(buffer => buffer[0] === 0x42);
        assert.equal(offered.readInt16LE(1), 1);
        assert.equal(offered.readInt16LE(7), 3, 'native withdrawal window shows account stock');
        await Request.warehouseWithdraw(second, packet(101, 4));
        assert.equal(second.actor.backpack.items.find(item => item.fetchSelfId() === 1864).fetchAmount(), 4);
        assert.equal((await Warehouse.list(first)).find(item => item.fetchId() === 101).fetchAmount(), 9);
        await Warehouse.withdraw(second, [{ objectId: 102, amount: 1 }, { objectId: 103, amount: 1 }]);
        assert.equal(second.actor.backpack.items.find(item => item.fetchSelfId() === 627).fetchEnchantLevel(), 7);
        assert.deepEqual(second.actor.backpack.items.find(item => item.fetchSelfId() === 2375).fetchPetData(), JSON.parse(petData));
        await assert.rejects(Warehouse.withdraw(outsider, [{ objectId: 101, amount: 1 }]), /invalid warehouse/);
        await assert.rejects(Database.transferPlayerWarehouseBatch(3, 'Other', [
            { id: 101, selfId: 1864, amount: 1, stackable: true }
        ], 'withdraw'), /warehouse item changed/);
        await assert.rejects(Database.fetchPlayerWarehouseItems(1, 'Other'), /owner changed/);
        await assert.rejects(Database.fetchPlayerWarehouseItems(4, 'bot_shared'), /owner changed/);
        await assert.rejects(Database.fetchPlayerWarehouseItems(6, 'LegacyBot'), /owner changed/);

        options.default.GameServer.playerWarehouseSlots = 1;
        await Warehouse.deposit(first, [{ objectId: 201, amount: 1 }]);
        assert.equal(first.actor.backpack.items.find(item => item.fetchId() === 201).fetchAmount(), 1,
            'a full warehouse accepts an existing stack');
        await assert.rejects(Warehouse.deposit(first, [{ objectId: 202, amount: 1 }]), /warehouse is full/);
        assert.equal(first.actor.backpack.items.find(item => item.fetchId() === 202).fetchAmount(), 1);
        options.default.GameServer.playerWarehouseSlots = 2;
        await assert.rejects(Warehouse.deposit(first, [
            { objectId: 202, amount: 1 }, { objectId: 203, amount: 1 }
        ]), /warehouse is full/, 'capacity failure rolls back the entire selection');
        assert.equal((await Warehouse.list(first)).length, 1);
        assert.equal((await Database.fetchItems(1)).find(row => row.id === 202).amount, 1);
        assert.equal(first.actor.backpack.items.find(item => item.fetchId() === 202).fetchAmount(), 1);
        options.default.GameServer.playerWarehouseSlots = 300;
        // A live backpack can lag another committed inventory operation.
        await Database.execute(['DELETE FROM items WHERE id = 203']);
        await assert.rejects(Warehouse.deposit(first, [
            { objectId: 202, amount: 1 }, { objectId: 203, amount: 1 }
        ]), /inventory item changed/);
        assert.equal((await Warehouse.list(first)).length, 1, 'stale-line failure cannot partly deposit the first item');
        await Warehouse.deposit(first, [{ objectId: 202, amount: 1 }]);
        assert.equal((await Warehouse.list(second)).find(item => item.fetchSelfId() === 627).fetchEnchantLevel(), 4);

        // A shot spent (buffered bag amount) while the deposit waits behind a
        // DB drain slice is in the bag the deposit reads and is not written
        // over it later: 1000 - 1 - 500 = 499 in the bag, 500 more stored. Also
        // when the flush timer takes that amount while the deposit waits.
        const WriteQueue = invoke('GameServer/Persistence/CharacterWriteQueue');
        for (const timerFlush of [false, true]) {
            await Database.execute(['UPDATE items SET amount = 1000 WHERE id = 201']);
            const stockBefore = (await Database.fetchPlayerWarehouseItems(1, 'Shared')).find(row => row.selfId === 1864).amount;
            const slowJobs = Array.from({ length: 6 }, () => Database.execute(['SELECT 1', [], { onTiming() {
                const end = Date.now() + 3;
                while (Date.now() < end) { /* a 3 ms job */ }
            } }]));
            setImmediate(() => {
                WriteQueue.itemAmount(1, 201, 999);
                if (timerFlush) WriteQueue.flushAll();
            });
            const deposited = Database.transferPlayerWarehouseBatch(1, 'Shared', [
                { id: 201, selfId: 1864, amount: 500, stackable: true }
            ], 'deposit');
            await Promise.all(slowJobs);
            assert.equal((await deposited)[0].inventoryAmount, 499, 'the deposit reads the buffered amount');
            await WriteQueue.flushCharacter(1);
            assert.equal((await Database.fetchItems(1)).find(row => row.id === 201).amount, 499,
                'no buffered amount lands after the deposit');
            assert.equal((await Database.fetchPlayerWarehouseItems(1, 'Shared')).find(row => row.selfId === 1864).amount,
                stockBefore + 500);
        }

        // Two stale windows cannot withdraw the same remaining stack twice.
        const [stored] = (await Database.fetchPlayerWarehouseItems(1, 'Shared')).filter(row => row.selfId === 1864);
        const competing = await Promise.allSettled([1, 2].map(id => Database.transferPlayerWarehouseBatch(id, 'Shared', [
            { id: stored.id, selfId: 1864, amount: stored.amount, stackable: true }
        ], 'withdraw')));
        assert.equal(competing.filter(result => result.status === 'fulfilled').length, 1);
        assert.equal(competing.filter(result => result.status === 'rejected').length, 1);

        const collections = createActorCollections({ subjectFor: async () => ({ actor: second.actor }),
            execute: Database.execute.bind(Database), itemFor: selfId => ({ selfId }) });
        assert.equal((await collections('player', 2, 'warehouse')).rows[0].enchant, 4,
            'observer reads the same account warehouse as the client');
        await Database.deleteCharacter('Shared', 'Character1');
        await Database.deleteCharacter('shared', 'Character2');
        assert.equal((await Database.execute(['SELECT * FROM account_warehouse_items WHERE accountName = ?', ['Shared']])).length, 1,
            'deleting every character must retain account stock');
        await Database.createCharacter('Shared', { name: 'Replacement', race: 0, classId: 0, maxHp: 100, maxMp: 100,
            sex: 0, face: 0, hair: 0, hairColor: 0, locX: 0, locY: 0, locZ: 0 });
        const [replacement] = await Database.fetchCharacters('shared');
        await Database.close();
        Database.init();
        const afterRestart = await Warehouse.list(session(replacement.id, 'shared'));
        assert.equal(afterRestart.length, 1, 'migration is durable and does not duplicate stock on restart');
        assert.equal(afterRestart[0].fetchEnchantLevel(), 4);
        assert.equal((await Database.fetchWarehouseItems(4))[0].amount, 15);
        // Capacity expands the complete list, independently of the 100-line
        // maximum for an individual client deposit/withdrawal request.
        await Database.execute([`WITH RECURSIVE slots(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM slots WHERE n < 299)
            INSERT INTO account_warehouse_items (accountName, selfId, name, amount, enchant)
            SELECT 'Shared', 627, 'Aspis', 1, 0 FROM slots`]);
        const replacementSession = session(replacement.id, 'shared');
        await WarehouseWindow(replacementSession, ['warehouse', 'withdraw']);
        const expanded = replacementSession.sent.find(buffer => buffer[0] === 0x42);
        assert.equal(expanded.readInt16LE(7), 300, 'all 300 slots are sent through the native list packet');
        options.default.GameServer.playerWarehouseSlots = 100;
        await Warehouse.withdraw(replacementSession, [{ objectId: afterRestart[0].fetchId(), amount: 1 }]);
        assert.equal(replacementSession.actor.backpack.items[0].fetchEnchantLevel(), 4,
            'stock above a reduced capacity remains withdrawable');
        options.default.GameServer.playerWarehouseSlots = 1001;
        assert.equal(Limits.playerCapacity(), 300, 'invalid limits use the safe default');
        console.log('Account warehouse checks passed');
    } finally {
        await Database.close();
        clean();
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
