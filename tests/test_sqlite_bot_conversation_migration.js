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
    INSERT INTO schema_migrations(version, appliedAt)
    VALUES (1, 0), (2, 0), (3, 0), (4, 0), (5, 0), (6, 0), (7, 0);
    INSERT INTO bot_conversations(playerId, botId, createdAt, updatedAt)
    VALUES (1, 2, 1, 1);
    INSERT INTO bot_conversation_messages(conversationId, turnId, role, text)
    VALUES (1, 'legacy-turn', 'player', 'hello');
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
    assert.strictEqual(migrations.at(-1).version, 9, 'raid-boss persistence migration must complete on a legacy database');

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
