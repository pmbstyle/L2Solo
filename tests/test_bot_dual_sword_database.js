const assert = require('assert');
const fs = require('fs');
const path = require('path');

require('../src/Global');

const Database = invoke('Database');

const databasePath = path.join(process.cwd(), 'tmp', 'test-bot-dual-sword.sqlite');

async function run() {
    fs.rmSync(databasePath, { force: true });
    fs.rmSync(`${databasePath}-wal`, { force: true });
    fs.rmSync(`${databasePath}-shm`, { force: true });
    options.default.Database.path = path.relative(process.cwd(), databasePath);
    Database.init();

    await Database.createAccount('dual_sword_db', 'secret');
    await Database.createCharacter('dual_sword_db', {
        name: 'DualSwordDb', race: 0, classId: 2, maxHp: 50, maxMp: 25,
        sex: 0, face: 0, hair: 0, hairColor: 0, locX: 0, locY: 0, locZ: 0
    });
    const characterId = Number((await Database.fetchCharacterName('DualSwordDb'))[0].id);
    await Database.setItem(characterId, { selfId: 123, name: 'Saber', amount: 1, equipped: true, slot: 7 });
    await Database.setItem(characterId, { selfId: 123, name: 'Saber', amount: 1, equipped: false, slot: 0 });
    await Database.setItem(characterId, { selfId: 57, name: 'Adena', amount: 5000000, equipped: false, slot: 0 });

    await Database.combineInventoryItems(characterId, {
        ingredients: [{ selfId: 123, amount: 2 }],
        product: { selfId: 2516, name: 'Saber*Saber', amount: 1, slot: 14 }
    });
    const combined = await Database.fetchItems(characterId);
    assert.strictEqual(combined.filter((item) => Number(item.selfId) === 123).length, 0,
        'two separate non-stackable source rows must both be consumed');
    assert.strictEqual(combined.filter((item) => Number(item.selfId) === 2516).length, 1);
    assert.strictEqual(Number(combined.find((item) => Number(item.selfId) === 57).amount), 5000000,
        'bot-only combination must leave Adena untouched');

    await Database.setItem(characterId, { selfId: 123, name: 'Saber', amount: 1, equipped: false, slot: 0 });
    await assert.rejects(Database.combineInventoryItems(characterId, {
        ingredients: [{ selfId: 123, amount: 2 }],
        product: { selfId: 2516, name: 'Saber*Saber', amount: 1, slot: 14 }
    }), /combination ingredient changed/);
    const rolledBack = await Database.fetchItems(characterId);
    assert.strictEqual(rolledBack.filter((item) => Number(item.selfId) === 123).length, 1,
        'a rejected combination must not consume the one available source sword');
    assert.strictEqual(rolledBack.filter((item) => Number(item.selfId) === 2516).length, 1,
        'a rejected combination must not create another result');
    console.log('Bot dual-sword database checks passed');
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(async () => {
    await Database.close();
    fs.rmSync(databasePath, { force: true });
    fs.rmSync(`${databasePath}-wal`, { force: true });
    fs.rmSync(`${databasePath}-shm`, { force: true });
});
