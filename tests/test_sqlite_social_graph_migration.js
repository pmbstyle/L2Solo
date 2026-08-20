const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const databasePath = path.join(process.cwd(), 'tmp', 'test-sqlite-social-graph-migration.sqlite');
[databasePath, `${databasePath}-wal`, `${databasePath}-shm`].forEach((file) => fs.rmSync(file, { force: true }));

const legacy = new DatabaseSync(databasePath);
legacy.exec(`
    CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        appliedAt INTEGER NOT NULL
    );
`);
const seedMigration = legacy.prepare('INSERT INTO schema_migrations(version, appliedAt) VALUES (?, 0)');
for (let version = 1; version <= 17; version += 1) seedMigration.run(version);
legacy.close();

require('../src/Global');
const Database = invoke('Database');
options.default.Database.path = path.relative(process.cwd(), databasePath);
Database.init();

(async () => {
    try {
        const migration = await Database.execute([
            'SELECT version FROM schema_migrations WHERE version = 18'
        ], 'test:social-migration-version');
        assert.strictEqual(migration.length, 1, 'existing worlds must receive social graph migration v18 automatically');

        const tables = await Database.execute([
            `SELECT name FROM sqlite_master
             WHERE type = 'table' AND name IN (
                'social_entities', 'social_events', 'social_relations', 'social_projection_cursors'
             ) ORDER BY name`
        ], 'test:social-migration-tables');
        assert.deepStrictEqual(tables.map((row) => row.name), [
            'social_entities',
            'social_events',
            'social_projection_cursors',
            'social_relations'
        ]);

        const indexes = await Database.execute([
            `SELECT name FROM sqlite_master
             WHERE type = 'index' AND name IN (
                'social_events_source_recent', 'social_events_target_recent',
                'social_events_context_recent', 'social_events_retention',
                'social_relations_source_updated', 'social_relations_target_updated'
             ) ORDER BY name`
        ], 'test:social-migration-indexes');
        assert.strictEqual(indexes.length, 6, 'v18 must create every bounded social lookup and retention index');

        const entityColumns = await Database.execute(['PRAGMA table_info(social_entities)'], 'test:social-entity-columns');
        assert.deepStrictEqual(entityColumns.map((column) => column.name), [
            'id', 'kind', 'externalKey', 'displayName', 'createdAt', 'updatedAt', 'retiredAt'
        ]);
        const relationColumns = await Database.execute(['PRAGMA table_info(social_relations)'], 'test:social-relation-columns');
        for (const name of ['affinity', 'trust', 'respect', 'fear', 'hostility', 'familiarity', 'revision']) {
            assert(relationColumns.some((column) => column.name === name), `v18 must include ${name}`);
        }

        const source = await Database.ensureSocialEntity({ kind: 'character', externalKey: 'migration-source', displayName: '' });
        const target = await Database.ensureSocialEntity({ kind: 'clan', externalKey: 'migration-target', displayName: '' });
        await assert.rejects(
            Database.execute([
                `INSERT INTO social_relations(sourceEntityId, targetEntityId, affinity)
                 VALUES (?, ?, 101)`,
                [source.id, target.id]
            ], 'test:social-relation-constraint'),
            /CHECK constraint failed|constraint failed/i,
            'persisted relation dimensions must reject values outside the canonical range'
        );

        const integrity = await Database.execute(['PRAGMA integrity_check'], 'test:social-migration-integrity');
        assert.strictEqual(integrity[0].integrity_check, 'ok');
        const foreignKeys = await Database.execute(['PRAGMA foreign_key_check'], 'test:social-migration-foreign-keys');
        assert.deepStrictEqual(foreignKeys, []);

        console.log('SQLite social graph migration checks passed');
    } finally {
        await Database.close();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
