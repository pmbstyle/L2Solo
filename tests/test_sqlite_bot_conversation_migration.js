const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

require('../src/Global');

const Database = invoke('Database');
const databasePath = path.join(process.cwd(), 'tmp', 'test-sqlite-bot-conversation-migration.sqlite');

fs.rmSync(databasePath, { force: true });

// Reproduce a database created before the conversation ordering/compaction
// columns were introduced. The bootstrap SQL must be safe to run before the
// additive migration gets a chance to add those columns.
const legacy = new DatabaseSync(databasePath);
legacy.exec(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, appliedAt INTEGER NOT NULL);
    CREATE TABLE bot_conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        playerId INTEGER NOT NULL,
        botId INTEGER NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        summaryThroughId INTEGER NOT NULL DEFAULT 0,
        version INTEGER NOT NULL DEFAULT 0,
        createdAt INTEGER NOT NULL DEFAULT 0,
        updatedAt INTEGER NOT NULL DEFAULT 0,
        UNIQUE(playerId, botId)
    );
    CREATE TABLE bot_conversation_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversationId INTEGER NOT NULL,
        turnId TEXT NOT NULL,
        role TEXT NOT NULL,
        channel TEXT NOT NULL DEFAULT 'local',
        text TEXT NOT NULL DEFAULT '',
        requestId TEXT,
        delivered INTEGER NOT NULL DEFAULT 1,
        createdAt INTEGER NOT NULL DEFAULT 0,
        metaJson TEXT,
        UNIQUE(conversationId, turnId, role)
    );
    CREATE TABLE bot_life_state (
        characterId INTEGER PRIMARY KEY,
        accountName TEXT NOT NULL,
        characterName TEXT NOT NULL,
        level INTEGER NOT NULL DEFAULT 1,
        exp INTEGER NOT NULL DEFAULT 0,
        sp INTEGER NOT NULL DEFAULT 0,
        adena INTEGER NOT NULL DEFAULT 0,
        homeRegion TEXT,
        currentRegion TEXT,
        spotId TEXT,
        activity TEXT NOT NULL DEFAULT 'hunting',
        phase TEXT NOT NULL DEFAULT 'cold',
        activityStartedAt INTEGER,
        nextResolveAt INTEGER,
        lastResolvedAt INTEGER,
        lastHotAt INTEGER,
        locX INTEGER NOT NULL DEFAULT 0,
        locY INTEGER NOT NULL DEFAULT 0,
        locZ INTEGER NOT NULL DEFAULT 0,
        hp REAL NOT NULL DEFAULT 0,
        maxHp REAL NOT NULL DEFAULT 0,
        mp REAL NOT NULL DEFAULT 0,
        maxMp REAL NOT NULL DEFAULT 0,
        targetLevelBand TEXT,
        deathCount INTEGER NOT NULL DEFAULT 0,
        partyId TEXT,
        inventorySummary TEXT,
        statsJson TEXT,
        updatedAt INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO schema_migrations(version, appliedAt)
    VALUES (1, 0), (2, 0), (3, 0), (4, 0), (5, 0), (6, 0), (7, 0);
    INSERT INTO bot_conversations(playerId, botId, createdAt, updatedAt)
    VALUES (1, 2, 1, 1);
    INSERT INTO bot_conversation_messages(conversationId, turnId, role, text)
    VALUES (1, 'legacy-turn', 'player', 'hello');
    INSERT INTO bot_life_state(characterId, accountName, characterName, statsJson)
    VALUES (42, 'legacy-owner', 'LegacyOwner', '{}');
`);
legacy.close();

options.default.Database.path = path.relative(process.cwd(), databasePath);
Database.init();

(async () => {
    const columns = await Database.execute(['PRAGMA table_info(bot_conversation_messages)'], 'test:migration-columns');
    const names = columns.map((column) => column.name);
    assert(names.includes('turnOrdinal'), 'legacy conversation table must receive turnOrdinal');
    assert(names.includes('messageOrder'), 'legacy conversation table must receive messageOrder');
    assert(names.includes('compacted'), 'legacy conversation table must receive compacted');

    const index = await Database.execute([
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
        ['bot_conversation_messages_order']
    ], 'test:migration-index');
    assert.strictEqual(index.length, 1, 'the ordering index must be created after migration columns exist');

    const migrations = await Database.execute(['SELECT version FROM schema_migrations ORDER BY version'], 'test:migration-versions');
    assert(migrations.at(-1).version >= 12, 'all current additive migrations must complete on a legacy database');
    const itemColumns = await Database.execute(['PRAGMA table_info(items)'], 'test:enchant-item-columns');
    const itemEnchantColumn = itemColumns.find((column) => column.name === 'enchant');
    assert(itemEnchantColumn, 'legacy item table must receive enchant level storage');
    assert.strictEqual(Number(itemEnchantColumn.notnull), 1, 'item enchant storage must remain NOT NULL after migration');
    assert.strictEqual(String(itemEnchantColumn.dflt_value), '0', 'item enchant storage must default to zero after migration');
    const warehouseColumns = await Database.execute(['PRAGMA table_info(warehouse_items)'], 'test:enchant-warehouse-columns');
    const warehouseEnchantColumn = warehouseColumns.find((column) => column.name === 'enchant');
    assert(warehouseEnchantColumn, 'legacy warehouse table must receive enchant level storage');
    assert.strictEqual(Number(warehouseEnchantColumn.notnull), 1, 'warehouse enchant storage must remain NOT NULL after migration');
    assert.strictEqual(String(warehouseEnchantColumn.dflt_value), '0', 'warehouse enchant storage must default to zero after migration');
    await Database.execute([
        'INSERT INTO accounts(username, password) VALUES (?, ?)',
        ['legacy_enchant_test', 'secret']
    ], 'test:enchant-invariant-account');
    const enchantCharacter = await Database.execute([
        `INSERT INTO characters(username, name, classId, race, maxHp, maxMp, sex, face, hair, hairColor, locX, locY, locZ)
         VALUES (?, ?, 0, 0, 100, 100, 0, 0, 0, 0, 0, 0, 0)`,
        ['legacy_enchant_test', 'LegacyEnchantProbe']
    ], 'test:enchant-invariant-character');
    const enchantCharacterId = Number(enchantCharacter.insertId);
    await assert.rejects(
        Database.execute([
            'INSERT INTO items(selfId, name, amount, enchant, characterId) VALUES (?, ?, ?, ?, ?)',
            [1, 'invalid item enchant', 1, -1, enchantCharacterId]
        ], 'test:negative-item-enchant'),
        /CHECK constraint failed|constraint failed/i,
        'items must reject negative enchant levels'
    );
    await assert.rejects(
        Database.execute([
            'INSERT INTO warehouse_items(selfId, name, amount, enchant, characterId) VALUES (?, ?, ?, ?, ?)',
            [1, 'invalid warehouse enchant', 1, -1, enchantCharacterId]
        ], 'test:negative-warehouse-enchant'),
        /CHECK constraint failed|constraint failed/i,
        'warehouse_items must reject negative enchant levels'
    );
    const lifeStateColumns = await Database.execute(['PRAGMA table_info(bot_life_state)'], 'test:owner-migration-columns');
    const lifeStateColumnNames = lifeStateColumns.map((column) => column.name);
    for (const column of ['simulationOwner', 'simulationRevision', 'simulationLeaseId', 'simulationLeaseUntil']) {
        assert(lifeStateColumnNames.includes(column), `legacy lifecycle table must receive ${column}`);
    }
    const ownerIndex = await Database.execute([
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'bot_life_state_simulation_owner_lease'"
    ], 'test:owner-migration-index');
    assert.strictEqual(ownerIndex.length, 1, 'ownership index must be created only after migration columns exist');
    const migratedOwner = (await Database.execute([
        'SELECT simulationOwner, simulationRevision, simulationLeaseId, simulationLeaseUntil FROM bot_life_state WHERE characterId = 42'
    ], 'test:owner-migration-defaults'))[0];
    assert.deepStrictEqual(
        [migratedOwner.simulationOwner, migratedOwner.simulationRevision, migratedOwner.simulationLeaseId, migratedOwner.simulationLeaseUntil],
        ['legacy_main', 0, null, 0],
        'legacy lifecycle rows must remain main-owned with revision zero after migration'
    );

    const migratedMessage = await Database.execute([
        'SELECT turnOrdinal, messageOrder, compacted FROM bot_conversation_messages WHERE turnId = ?',
        ['legacy-turn']
    ], 'test:migration-backfill');
    assert.deepStrictEqual(
        migratedMessage.map((row) => [row.turnOrdinal, row.messageOrder, row.compacted]),
        [[1, 0, 0]],
        'legacy conversation messages must be backfilled with canonical ordering'
    );

    console.log('sqlite legacy bot conversation migration ok');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
