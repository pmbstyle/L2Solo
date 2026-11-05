'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const isolated = require('./helpers/isolatedSocialDatabase')('large-integers');
const sqlite = require('node:sqlite');
const NativeDatabase = sqlite.DatabaseSync;
const allowed = new Set([isolated.world, isolated.history, isolated.world + '.access.sqlite']);
sqlite.DatabaseSync = class extends NativeDatabase {
    constructor(filename, settings) {
        assert(allowed.has(filename), 'only exact fixture databases may open');
        super(filename, settings);
    }
};
require('../src/Global');
isolated.assertConfigured(options.default);
const Database = invoke('Database');
const WarehouseIndex = invoke('GameServer/Bot/Economy/PersonalWarehouseIndex');
const amount = 9606707489433600n; // E223's real warehouse quantity.
let raw;
async function run() {
    try {
        Database.init();
        assert(Database.isReady());
        await Database.createAccount('bot_integer_fixture', 'fixture');
        const characterId = (await Database.createCharacter('bot_integer_fixture', {
            name: 'IntegerFixture', race: 0, classId: 0, maxHp: 100, maxMp: 100,
            sex: 0, face: 0, hair: 0, hairColor: 0, locX: 0, locY: 0, locZ: 0
        })).insertId;
        assert.equal(typeof characterId, 'number');
        await Database.execute(['INSERT INTO bot_life_state(characterId) VALUES (?)', [characterId]]);
        // Seed the pre-existing bad save through a separate fixture connection:
        // its write has no temporary journal triggers, so the first failure
        // on the unfixed code is the actual startup read, not a seed write.
        raw = new sqlite.DatabaseSync(isolated.world);
        const stock = raw.prepare('INSERT INTO warehouse_items(characterId,selfId,name,amount) VALUES (?,?,?,?)')
            .run(characterId, 1896, 'Necklace of Anguish Chain', amount);
        assert.equal(typeof stock.lastInsertRowid, 'number');
        await WarehouseIndex.init(); // Actual startup GROUP BY/SUM that killed the server.
        const [warehouse] = await Database.fetchWarehouseItems(characterId);
        assert.equal(warehouse.amount, Number(amount));
        assert.equal(typeof warehouse.amount, 'number');
        assert.equal(warehouse.id, stock.lastInsertRowid);

        await Database.execute(['INSERT INTO items(characterId,selfId,name,amount) VALUES (?,?,?,?)',
            [characterId, 1864, 'Stem', 9007199254740993n]]);
        assert.equal((await Database.fetchItems(characterId))[0].amount, Number(9007199254740993n));
        const [updated] = await Database.execute([
            'UPDATE items SET enchant=enchant+1 WHERE characterId=? RETURNING amount,enchant',
            [characterId], { read: true }
        ]);
        assert.equal(updated.enchant, 1, 'large-integer RETURNING must execute its mutation exactly once');
        assert.equal(typeof updated.amount, 'number');
        assert.equal(updated.amount, Number(9007199254740993n));
        // one().get() inside a native transaction must read the large row,
        // retain the normal domain refusal, and leave physical stock untouched.
        await assert.rejects(Database.transferWarehouseToInventory(characterId, {
            id: warehouse.id, selfId: 1864, name: 'Stem', amount: 1, stackable: true
        }), /warehouse item changed/);

        const [row] = await Database.execute([
            'SELECT ? AS integerValue, ? AS realValue, ? AS textValue, ? AS blobValue, NULL AS nullValue',
            [7, 1.5, 'text', Buffer.from([1, 2])]
        ]);
        // A read row is a plain object, its columns in the SELECT's order.
        assert.equal(Object.getPrototypeOf(row), Object.prototype);
        assert.deepEqual(Object.keys(row), ['integerValue', 'realValue', 'textValue', 'blobValue', 'nullValue']);
        assert.equal(row.integerValue, 7);
        assert.equal(row.realValue, 1.5);
        assert.equal(row.textValue, 'text');
        assert.deepEqual(Buffer.from(row.blobValue), Buffer.from([1, 2]));
        assert.equal(row.nullValue, null);
        assert.deepEqual(await Database.execute(['SELECT id FROM warehouse_items WHERE id=-1']), []);

        await Database.flushJournals();
        const [flow] = await Database.readHistory([
            "SELECT SUM(delta) AS amount FROM economy_flow_hour WHERE store='inventory' AND selfId=1864"
        ]);
        assert.equal(flow.amount, Number(9007199254740993n), 'large journal deltas can be read through the history adapter');
        const History = invoke('HistoryDatabase');
        assert.equal(History.one("SELECT SUM(delta) AS amount FROM economy_flow_hour WHERE store='inventory' AND selfId=1864").amount,
            Number(9007199254740993n), 'scalar history reads use the same integer normalization');

        const quantities = raw.prepare('SELECT amount FROM warehouse_items WHERE id=?');
        quantities.setReadBigInts(true);
        assert.equal(quantities.get(warehouse.id).amount, amount, 'reads and rollback preserve exact stored quantity');
        const inventory = raw.prepare('SELECT amount FROM items WHERE characterId=?');
        inventory.setReadBigInts(true);
        assert.equal(inventory.get(characterId).amount, 9007199254740993n,
            'Number normalization must never rewrite an imprecisely representable stored integer');
        console.log('PASS E223 startup, warehouse/inventory reads, native refusal, ordinary types and exact stored integers');
    } finally {
        raw?.close();
        await Database.close();
        fs.rmSync(isolated.directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
        assert.equal(fs.existsSync(isolated.directory), false);
    }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
