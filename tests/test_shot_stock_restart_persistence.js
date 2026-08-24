const assert = require('assert');
const fs = require('fs');
const path = require('path');

require('../src/Global');

const Database = invoke('Database');
const Shared = invoke('GameServer/Network/Shared');
const ShotStock = invoke('GameServer/Inventory/ShotStock');
const databasePath = path.join(process.cwd(), 'tmp', 'test-shot-stock-restart.sqlite');
const databaseFiles = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`];

const plan = {
    kind: 'soulshot',
    rank: 'none',
    selfId: 1835,
    name: 'Soulshot: No Grade',
    price: 7
};

function runtimeItem(row) {
    return {
        amount: Number(row.amount),
        fetchId: () => Number(row.id),
        fetchAmount() { return this.amount; },
        setAmount(amount) { this.amount = Number(amount); }
    };
}

async function main() {
    databaseFiles.forEach((file) => fs.rmSync(file, { force: true }));
    options.default.Database.path = path.relative(process.cwd(), databasePath);
    Database.init();

    await Database.execute(['INSERT INTO accounts(username, password) VALUES (?, ?)', ['shot_restart', 'test']], 'test:account');
    const character = await Database.execute([
        `INSERT INTO characters(username, name, classId, race, maxHp, maxMp, sex, face, hair, hairColor, locX, locY, locZ)
         VALUES (?, ?, 0, 0, 100, 100, 0, 0, 0, 0, 0, 0, 0)`,
        ['shot_restart', 'ShotRestartProbe']
    ], 'test:character');
    const characterId = Number(character.insertId);

    await Database.setItem(characterId, { selfId: 1835, name: plan.name, amount: 1000 });
    await Database.setItem(characterId, { selfId: 57, name: 'Adena', amount: 7000 });
    const rows = await Database.fetchItems(characterId);
    const runtimeItems = new Map(rows.map((row) => [Number(row.selfId), runtimeItem(row)]));
    const actor = {
        fetchId: () => characterId,
        backpack: {
            fetchItemFromSelfId: (selfId) => runtimeItems.get(Number(selfId))
        }
    };

    const purchased = await ShotStock.purchaseActorRestock(actor, { plan });
    assert.strictEqual(purchased.amount, 2000,
        'the persisted test bot should make an affordable partial purchase before restart');
    assert.strictEqual(purchased.adena, 0);

    await Database.close();
    Database.init();

    const initiallyLoaded = await Shared.fetchCharacters('shot_restart');
    const loadedShots = initiallyLoaded[0].items.find((row) => Number(row.selfId) === plan.selfId);
    assert.strictEqual(Number(loadedShots.amount), 2000,
        'the paid shot amount must load unchanged from SQLite after database restart');

    const reconciled = await ShotStock.ensureCharacterStock(characterId, {
        plan,
        targetAmount: ShotStock.DEFAULT_TARGET_AMOUNT
    });
    assert.strictEqual(reconciled.changed, false,
        'bot startup reconciliation must treat 1000 as a minimum and preserve extra paid shots');

    const readyCharacters = await Shared.fetchCharacters('shot_restart');
    const readyShots = readyCharacters[0].items.find((row) => Number(row.selfId) === plan.selfId);
    assert.strictEqual(Number(readyShots.amount), 2000,
        'the final bot actor input must retain the extra shots after startup reconciliation');

    console.log('Shot stock restart persistence checks passed');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(async () => {
    await Database.close();
    databaseFiles.forEach((file) => fs.rmSync(file, { force: true }));
});
