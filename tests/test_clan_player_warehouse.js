const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

require('../src/Global');

const rootDir = path.resolve(__dirname, '..');
const databasePath = path.join(rootDir, 'tmp', 'test-clan-player-warehouse.sqlite');
const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const ClanService = invoke('GameServer/Clan/ClanService');
const ClanWarehouse = invoke('GameServer/Warehouse/ClanWarehouse');
const Item = invoke('GameServer/Item/Item');
const World = invoke('GameServer/World/World');
const ServerResponse = invoke('GameServer/Network/Response');

function removeDatabaseFiles() {
    [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]
        .forEach((file) => fs.rmSync(file, { force: true }));
}

function seedDatabase() {
    removeDatabaseFiles();
    const seed = new DatabaseSync(databasePath);
    seed.exec(fs.readFileSync(path.join(rootDir, 'database', 'sql', 'sqlite.sql'), 'utf8'));
    seed.prepare('INSERT INTO accounts(username, password) VALUES (?, ?)').run('warehouse_leader', 'test-only');
    seed.prepare('INSERT INTO accounts(username, password) VALUES (?, ?)').run('warehouse_member', 'test-only');
    seed.prepare(`INSERT INTO characters(
        id, username, name, classId, race, level, maxHp, maxMp,
        sex, face, hair, hairColor, locX, locY, locZ, clanId, clanPrivileges
    ) VALUES (?, ?, ?, 4, 0, 40, 500, 250, 0, 0, 0, 0, 0, 0, 0, 6400001, ?)`)
        .run(5400001, 'warehouse_leader', 'WarehouseLeader', 2047);
    seed.prepare(`INSERT INTO characters(
        id, username, name, classId, race, level, maxHp, maxMp,
        sex, face, hair, hairColor, locX, locY, locZ, clanId, clanPrivileges
    ) VALUES (?, ?, ?, 4, 0, 40, 500, 250, 0, 0, 0, 0, 0, 0, 0, 6400001, ?)`)
        .run(5400002, 'warehouse_member', 'WarehouseMember', 4);
    seed.prepare('INSERT INTO clans(id, name, level, leaderId) VALUES (6400001, ?, 3, 5400001)').run('WarehouseClan');
    // Recreate the pre-v30 warehouse shape and one already-merged wearable so
    // this test also proves that startup repairs existing production data.
    seed.exec(`
        ALTER TABLE clan_warehouse_items RENAME TO clan_warehouse_items_new_shape;
        CREATE TABLE clan_warehouse_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            clanId INTEGER NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
            selfId INTEGER NOT NULL,
            name TEXT NOT NULL DEFAULT '',
            kind TEXT NOT NULL DEFAULT '',
            amount INTEGER NOT NULL DEFAULT 1 CHECK(amount > 0),
            enchant INTEGER NOT NULL DEFAULT 0 CHECK(enchant >= 0),
            petData TEXT,
            reservedAmount INTEGER NOT NULL DEFAULT 0 CHECK(reservedAmount >= 0),
            createdAt INTEGER NOT NULL DEFAULT 0,
            updatedAt INTEGER NOT NULL DEFAULT 0,
            UNIQUE(clanId, selfId, enchant)
        );
        DROP TABLE clan_warehouse_items_new_shape;
        INSERT INTO clan_warehouse_items
            (id, clanId, selfId, name, kind, amount, enchant, reservedAmount, createdAt, updatedAt)
            VALUES (7399000, 6400001, 881, 'Elven Ring', 'Armor.Jewel', 2, 0, 0, 1, 1);
    `);
    seed.prepare(`INSERT INTO items(id, selfId, name, amount, enchant, equipped, slot, characterId)
        VALUES (7400001, 1864, 'Stem', 10, 0, 0, 0, 5400001)`).run();
    seed.prepare(`INSERT INTO items(id, selfId, name, amount, enchant, equipped, slot, characterId)
        VALUES (7400002, 850, 'Elven Earring', 1, 0, 0, 0, 5400001)`).run();
    seed.prepare(`INSERT INTO items(id, selfId, name, amount, enchant, equipped, slot, characterId)
        VALUES (7400003, 850, 'Elven Earring', 1, 0, 0, 0, 5400001)`).run();
    seed.prepare(`INSERT INTO items(id, selfId, name, amount, enchant, equipped, slot, characterId)
        VALUES (7400004, 352, 'Brigandine Tunic', 1, 0, 0, 0, 5400001)`).run();
    seed.close();
}

function actor(id, privileges, items = []) {
    return {
        fetchId: () => id,
        fetchClanId: () => 6400001,
        fetchClanPrivileges: () => privileges,
        fetchLocX: () => 0,
        fetchLocY: () => 0,
        backpack: {
            items,
            fetchItems() { return this.items; },
            fetchTotalAdena: () => 0
        }
    };
}

function sessionFor(currentActor, mode) {
    return {
        actor: currentActor,
        activeNpcTalk: { objectId: 9000001, selfId: 30001, title: 'Warehouse Keeper' },
        activeWarehouse: { type: 'clan', mode, clanId: 6400001 }
    };
}

async function main() {
    seedDatabase();
    options.default.Database.path = path.relative(rootDir, databasePath);
    Database.init();
    DataCache.init();
    await ClanService.init();
    const stemTemplate = DataCache.items.find((item) => Number(item.selfId) === 1864);
    const stem = new Item(7400001, { ...utils.crushOb(stemTemplate), amount: 10, equipped: false, slot: 0 });
    const earringTemplate = DataCache.items.find((item) => Number(item.selfId) === 850);
    const tunicTemplate = DataCache.items.find((item) => Number(item.selfId) === 352);
    const shirtTemplate = DataCache.items.find((item) => Number(item.selfId) === 354);
    const earringOne = new Item(7400002, { ...utils.crushOb(earringTemplate), amount: 1, equipped: false, slot: 0 });
    const earringTwo = new Item(7400003, { ...utils.crushOb(earringTemplate), amount: 1, equipped: false, slot: 0 });
    const tunic = new Item(7400004, { ...utils.crushOb(tunicTemplate), amount: 1, equipped: false, slot: 0 });
    const missingShirt = new Item(7400005, { ...utils.crushOb(shirtTemplate), amount: 1, equipped: false, slot: 0 });
    World.npc = { spawns: [{
        fetchId: () => 9000001,
        fetchSelfId: () => 30001,
        fetchTitle: () => 'Warehouse Keeper',
        fetchLocX: () => 0,
        fetchLocY: () => 0
    }] };

    try {
        const migratedRings = await Database.execute([`SELECT id, amount FROM clan_warehouse_items
            WHERE clanId = 6400001 AND selfId = 881 ORDER BY id`]);
        assert.deepStrictEqual(migratedRings.map((row) => Number(row.amount)), [1, 1],
            'migration must split already-merged wearable equipment into distinct object rows');
        assert.notStrictEqual(Number(migratedRings[0].id), Number(migratedRings[1].id));

        const depositPacket = ServerResponse.wareHouseDepositList([stem], 0, 2);
        const withdrawPacket = ServerResponse.wareHouseWithdrawalList([stem], 0, 2);
        assert.strictEqual(depositPacket.readInt16LE(1), 2, 'clan deposit list must use native C4 warehouse type 2');
        assert.strictEqual(withdrawPacket.readInt16LE(1), 2, 'clan withdrawal list must use native C4 warehouse type 2');

        const leader = actor(5400001, 2047, [stem, earringOne, earringTwo, tunic, missingShirt]);
        const depositSession = sessionFor(leader, 'deposit');
        await ClanWarehouse.deposit(depositSession, [{ objectId: 7400001, amount: 6 }]);
        assert.strictEqual(stem.fetchAmount(), 4, 'successful clan deposit must update the live backpack');
        let [stored] = await Database.execute([`SELECT id, amount, reservedAmount FROM clan_warehouse_items
            WHERE clanId = 6400001 AND selfId = 1864`]);
        assert.strictEqual(Number(stored.amount), 6);
        let [inventory] = await Database.execute(['SELECT amount FROM items WHERE id = 7400001']);
        assert.strictEqual(Number(inventory.amount), 4);

        await ClanWarehouse.deposit(depositSession, [
            { objectId: 7400002, amount: 1 },
            { objectId: 7400003, amount: 1 }
        ]);
        const storedEquipment = await Database.execute([`SELECT id, amount FROM clan_warehouse_items
            WHERE clanId = 6400001 AND selfId = 850 AND enchant = 0 ORDER BY id`]);
        assert.deepStrictEqual(storedEquipment.map((row) => Number(row.amount)), [1, 1],
            'identical non-stackable equipment must retain separate client object rows');
        assert.notStrictEqual(Number(storedEquipment[0].id), Number(storedEquipment[1].id));
        assert.strictEqual(leader.backpack.fetchItems().some((item) => [7400002, 7400003].includes(Number(item.fetchId()))), false,
            'a successful duplicate-equipment batch must update the live backpack after commit');

        await assert.rejects(
            ClanWarehouse.deposit(depositSession, [
                { objectId: 7400004, amount: 1 },
                { objectId: 7400005, amount: 1 }
            ]),
            /inventory item changed/,
            'a stale line must reject the entire selected deposit batch'
        );
        const [retainedTunic] = await Database.execute(['SELECT amount FROM items WHERE id = 7400004']);
        assert.strictEqual(Number(retainedTunic.amount), 1, 'a rejected mixed batch must not partially debit valid inventory');
        const [storedTunic] = await Database.execute([`SELECT id FROM clan_warehouse_items
            WHERE clanId = 6400001 AND selfId = 352`]);
        assert.strictEqual(storedTunic, undefined, 'a rejected mixed batch must not partially create warehouse rows');
        assert(leader.backpack.fetchItems().includes(tunic), 'a rejected mixed batch must leave the live backpack unchanged');

        const member = actor(5400002, 4, []);
        await assert.rejects(
            ClanWarehouse.withdraw(sessionFor(member, 'withdraw'), [{ objectId: stored.id, amount: 1 }]),
            /only the clan leader/,
            'a privileged non-leader must still fail the C4 withdrawal request check'
        );

        await Database.execute(['UPDATE clan_warehouse_items SET reservedAmount = 2 WHERE id = ?', [stored.id]]);
        const visible = await ClanWarehouse.list(6400001);
        const visibleStem = visible.find((item) => Number(item.fetchSelfId()) === 1864);
        assert.strictEqual(visibleStem.fetchAmount(), 4, 'reserved autonomous stock must not be exposed to native withdrawal');
        await assert.rejects(
            ClanWarehouse.withdraw(sessionFor(leader, 'withdraw'), [{ objectId: stored.id, amount: 5 }]),
            /invalid clan warehouse withdrawal/,
            'native withdrawal must not consume reserved stock'
        );

        await ClanWarehouse.withdraw(sessionFor(leader, 'withdraw'), [{ objectId: stored.id, amount: 4 }]);
        const restored = leader.backpack.fetchItems().find((item) => Number(item.fetchSelfId()) === 1864);
        assert.strictEqual(restored.fetchAmount(), 8, 'withdrawal must merge with the live stack and preserve deposited units');
        [stored] = await Database.execute(['SELECT amount, reservedAmount FROM clan_warehouse_items WHERE id = ?', [stored.id]]);
        assert.deepStrictEqual(stored, { amount: 2, reservedAmount: 2 });
        const [ledger] = await Database.execute([`SELECT
            SUM(CASE WHEN operation = 'deposit' THEN amount ELSE 0 END) AS deposited,
            SUM(CASE WHEN operation = 'withdraw' THEN amount ELSE 0 END) AS withdrawn
            FROM clan_warehouse_ledger WHERE clanId = 6400001 AND characterId = 5400001 AND selfId = 1864`]);
        assert.deepStrictEqual(ledger, { deposited: 6, withdrawn: 4 }, 'player clan transfers must remain auditable');
        console.log('Clan player warehouse checks passed');
    } finally {
        await Database.close();
        removeDatabaseFiles();
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
