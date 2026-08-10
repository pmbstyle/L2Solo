const assert = require('assert');
const fs = require('fs');
const path = require('path');

require('../src/Global');

const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const BotLifeState = invoke('GameServer/Bot/Population/BotLifeState');
const databasePath = path.join(process.cwd(), 'tmp', 'test-stackable-inventory-persistence.sqlite');

fs.rmSync(databasePath, { force: true });
options.default.Database.path = path.relative(process.cwd(), databasePath);
Database.init();
DataCache.init();

(async () => {
    await Database.execute(['INSERT INTO accounts(username, password) VALUES (?, ?)', ['stackable_test', 'test']], 'test:account');
    const character = await Database.execute([
        `INSERT INTO characters(username, name, classId, race, maxHp, maxMp, sex, face, hair, hairColor, locX, locY, locZ)
         VALUES (?, ?, 0, 0, 100, 100, 0, 0, 0, 0, 0, 0, 0)`,
        ['stackable_test', 'StackableProbe']
    ], 'test:character');
    const characterId = Number(character.insertId);

    await Database.setItem(characterId, { selfId: 1835, name: 'Soulshot: No Grade', amount: 2 });
    await Database.setItem(characterId, { selfId: 1835, name: 'Soulshot: No Grade', amount: 3 });
    await Database.setItem(characterId, { selfId: 1835, name: 'Soulshot: No Grade', amount: 5 });
    await Database.setItem(characterId, { selfId: 1, name: 'Short Sword', amount: 1 });
    await Database.setItem(characterId, { selfId: 1, name: 'Short Sword', amount: 1 });

    const rawSummary = BotLifeState.inventorySummaryFromItems([
        { selfId: 1835, name: 'Soulshot: No Grade', amount: 10, equipped: 0, slot: 0 },
        { selfId: 1, name: 'Short Sword', amount: 1, equipped: 0, slot: 0 }
    ]);
    assert.strictEqual(rawSummary['1835'].stackable, true, 'raw SQLite rows must inherit stackability from the datapack');
    assert.strictEqual(rawSummary['1'].stackable, false, 'equipment rows must remain non-stackable');

    const legacySummary = BotLifeState.normalizeInventoryStackability({
        1835: { selfId: 1835, name: 'Soulshot: No Grade', amount: 10, stackable: false },
        1: { selfId: 1, name: 'Short Sword', amount: 1, stackable: true }
    });
    assert.strictEqual(legacySummary['1835'].stackable, true, 'persisted false flags must be repaired for known stackables');
    assert.strictEqual(legacySummary['1'].stackable, false, 'persisted true flags must not override equipment metadata');

    const result = await Database.compactStackableInventory([1835], 'test-stackable-compaction-v1');
    assert.strictEqual(result.rowsRemoved, 2, 'one-time maintenance must remove duplicate stackable rows');
    const rows = await Database.fetchItems(characterId);
    const shots = rows.filter((item) => Number(item.selfId) === 1835);
    const swords = rows.filter((item) => Number(item.selfId) === 1);
    assert.strictEqual(shots.length, 1, 'stackable inventory must use one physical row');
    assert.strictEqual(Number(shots[0].amount), 10, 'stackable compaction must preserve the total amount');
    assert.strictEqual(swords.length, 2, 'non-stackable inventory must preserve separate object rows');

    const repeated = await Database.compactStackableInventory([1835], 'test-stackable-compaction-v1');
    assert.strictEqual(repeated.skipped, true, 'completed maintenance must not rescan the live inventory every startup');
    const reclaimed = await Database.reclaimUnusedSpace({ minFreePages: 0, minFreeRatio: 0 });
    assert.strictEqual(reclaimed.reclaimed, true, 'startup maintenance must be able to reclaim pages after compaction');
    assert.strictEqual(reclaimed.nextFreePages, 0, 'VACUUM must leave no unused pages in the compacted test database');
    console.log('stackable inventory persistence ok');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
