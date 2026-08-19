const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const rootDir = path.resolve(__dirname, '..');
const outputDir = path.join(rootDir, 'tmp', 'test-sqlite-bot-life-state-migration');
const ownerColumns = [
    'simulationOwner',
    'simulationRevision',
    'simulationLeaseId',
    'simulationLeaseUntil'
];
const partyProjectionColumns = [
    'partyRequestStatus',
    'partyRequestPriority',
    'partyRequestedAt',
    'partyObjectiveSpot'
];

if (process.argv[2] === '--bootstrap') {
    require('../src/Global');
    const Database = invoke('Database');
    const databasePath = path.resolve(process.argv[3]);
    options.default.Database.path = databasePath;
    let initialized = false;
    Database.init(() => {
        initialized = true;
    });
    console.log(`MIGRATION_BOOTSTRAP=${initialized ? 'ok' : 'failed'}`);
    Promise.resolve()
        .then(() => Database.close())
        .catch((error) => {
            console.error(error);
            process.exitCode = 3;
        });
} else {
    fs.rmSync(outputDir, { recursive: true, force: true });
    fs.mkdirSync(outputDir, { recursive: true });

    const currentSchema = fs.readFileSync(path.join(rootDir, 'database', 'sql', 'sqlite.sql'), 'utf8');
    const preV10Schema = currentSchema.replace(
        /updatedAt INTEGER NOT NULL DEFAULT 0,\r?\n\s*simulationOwner TEXT NOT NULL DEFAULT 'legacy_main',\r?\n\s*simulationRevision INTEGER NOT NULL DEFAULT 0,\r?\n\s*simulationLeaseId TEXT,\r?\n\s*simulationLeaseUntil INTEGER NOT NULL DEFAULT 0/,
        'updatedAt INTEGER NOT NULL DEFAULT 0'
    );
    assert(!preV10Schema.includes('simulationOwner'), 'test fixture must reproduce the pre-v10 lifecycle schema');
    const preV14Schema = currentSchema.replace(
        /,\r?\n\s*partyRequestStatus TEXT GENERATED ALWAYS AS \([\s\S]*?\r?\n\s*\) VIRTUAL\r?\n\);/,
        '\n);'
    );
    partyProjectionColumns.forEach((name) => {
        assert(!preV14Schema.includes(name), `test fixture must reproduce the pre-v14 schema without ${name}`);
    });

    const realisticRows = [
        {
            characterId: 71001,
            accountName: 'migration-solo',
            characterName: 'MigrationSolo',
            level: 38,
            exp: 812345,
            sp: 4412,
            adena: 78215,
            homeRegion: 'Giran',
            currentRegion: 'Death Pass',
            spotId: 'death_pass_harpy',
            activity: 'hunting',
            phase: 'cold',
            partyId: null,
            inventorySummary: JSON.stringify({ 57: { selfId: 57, name: 'Adena', amount: 78215 } }),
            statsJson: JSON.stringify({ role: 'dps', deathCount: 2, travel: { from: 'Giran', to: 'Death Pass' } }),
            updatedAt: 1812345678000
        },
        {
            characterId: 71002,
            accountName: 'migration-party',
            characterName: 'MigrationParty',
            level: 42,
            exp: 1543210,
            sp: 9921,
            adena: 155001,
            homeRegion: 'Oren',
            currentRegion: 'Sea of Spores',
            spotId: 'sea_of_spores_party',
            activity: 'party_wait',
            phase: 'cold',
            partyId: 'party-migration-17',
            inventorySummary: JSON.stringify({ 734: { selfId: 734, name: 'Greater Healing Potion', amount: 14 } }),
            statsJson: JSON.stringify({
                role: 'buffer',
                partyRequest: {
                    status: 'open',
                    priority: 'required',
                    requestedAt: 1812345680000,
                    role: 'support',
                    spotId: 'party-request-spot'
                }
            }),
            updatedAt: 1812345689000
        },
        {
            characterId: 71003,
            accountName: 'migration-market',
            characterName: 'MigrationMarket',
            level: 31,
            exp: 512345,
            sp: 3122,
            adena: 991233,
            homeRegion: 'Dion',
            currentRegion: 'Giran',
            spotId: null,
            activity: 'selling',
            phase: 'cold',
            partyId: null,
            inventorySummary: JSON.stringify({ 1458: { selfId: 1458, name: 'Mithril Ore', amount: 80 } }),
            statsJson: JSON.stringify({ marketStore: { kind: 'sell', town: 'Giran', listings: 3 } }),
            updatedAt: 1812345700000
        }
    ];

    function open(databasePath) {
        return new DatabaseSync(databasePath);
    }

    function seed(databasePath, versions, { partial = false, collision = false, schema = preV10Schema } = {}) {
        const db = open(databasePath);
        db.exec(schema);
        const migration = db.prepare('INSERT INTO schema_migrations(version, appliedAt) VALUES (?, 0)');
        versions.forEach((version) => migration.run(version));
        if (versions.includes(10)) {
            db.exec(`CREATE INDEX IF NOT EXISTS bot_life_state_simulation_owner_lease
                ON bot_life_state(simulationOwner, simulationLeaseUntil, phase, activity)`);
        }
        if (versions.includes(13)) {
            db.exec(`
                CREATE INDEX IF NOT EXISTS bot_life_state_party_owner_filter
                    ON bot_life_state(simulationOwner, phase, partyId, activity, spotId, updatedAt);
                CREATE INDEX IF NOT EXISTS bot_life_state_party_request_filter
                    ON bot_life_state(
                        phase, partyId, activity,
                        json_extract(statsJson, '$.partyRequest.status'),
                        json_extract(statsJson, '$.partyRequest.priority')
                    );
                CREATE INDEX IF NOT EXISTS bot_life_state_party_objective_spot
                    ON bot_life_state(
                        phase, partyId, activity,
                        COALESCE(
                            json_extract(statsJson, '$.partyRequest.spotId'),
                            json_extract(statsJson, '$.equipmentPlan.next.spotId'),
                            spotId
                        )
                    );
            `);
        }
        if (partial) {
            db.exec(`
                ALTER TABLE bot_life_state ADD COLUMN simulationOwner TEXT NOT NULL DEFAULT 'legacy_main';
                ALTER TABLE bot_life_state ADD COLUMN simulationRevision INTEGER NOT NULL DEFAULT 0;
            `);
        }
        if (collision) {
            db.exec('CREATE TABLE bot_life_state_simulation_owner_lease (sentinel TEXT NOT NULL)');
            db.prepare('INSERT INTO bot_life_state_simulation_owner_lease(sentinel) VALUES (?)').run('keep-me');
        }
        const insertAccount = db.prepare('INSERT INTO accounts(username, password) VALUES (?, ?)');
        const insertCharacter = db.prepare(`INSERT INTO characters(
            id, username, name, classId, race, level, maxHp, maxMp,
            sex, face, hair, hairColor, locX, locY, locZ
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        realisticRows.forEach((row) => {
            insertAccount.run(row.accountName, 'test-only');
            insertCharacter.run(
                row.characterId, row.accountName, row.characterName, 1, 0, row.level, 500, 250,
                0, 0, 0, 0, 83400, 148600, -3400
            );
        });
        const insert = db.prepare(`INSERT INTO bot_life_state(
            characterId, accountName, characterName, level, exp, sp, adena,
            homeRegion, currentRegion, spotId, activity, phase, partyId,
            inventorySummary, statsJson, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        realisticRows.forEach((row) => insert.run(
            row.characterId, row.accountName, row.characterName, row.level, row.exp, row.sp, row.adena,
            row.homeRegion, row.currentRegion, row.spotId, row.activity, row.phase, row.partyId,
            row.inventorySummary, row.statsJson, row.updatedAt
        ));
        db.close();
    }

    function bootstrap(databasePath, expectedSuccess = true) {
        const result = spawnSync(process.execPath, [__filename, '--bootstrap', databasePath], {
            cwd: rootDir,
            encoding: 'utf8'
        });
        if (expectedSuccess) {
            assert.strictEqual(result.status, 0, `database bootstrap process failed; stdout=${result.stdout}; stderr=${result.stderr}`);
            assert(result.stdout.includes('MIGRATION_BOOTSTRAP=ok'), `bootstrap callback did not run; stdout=${result.stdout}; stderr=${result.stderr}`);
        } else {
            assert.strictEqual(result.status, 1, `failed migration must terminate initialization with an error; stdout=${result.stdout}; stderr=${result.stderr}`);
            assert(result.stdout.includes('SQLite initialization failed'), `migration failure must be explicit; stdout=${result.stdout}; stderr=${result.stderr}`);
        }
    }

    function legacyRows(db) {
        return db.prepare(`SELECT
            characterId, accountName, characterName, level, exp, sp, adena,
            homeRegion, currentRegion, spotId, activity, phase, partyId,
            inventorySummary, statsJson, updatedAt
            FROM bot_life_state ORDER BY characterId`).all().map((row) => Object.fromEntries(
            Object.entries(row).map(([key, value]) => [key, typeof value === 'bigint' ? Number(value) : value])
        ));
    }

    function assertMigrated(databasePath, expectedRows = realisticRows) {
        const db = open(databasePath);
        const columns = db.prepare('PRAGMA table_info(bot_life_state)').all();
        ownerColumns.forEach((name) => {
            assert.strictEqual(columns.filter((column) => column.name === name).length, 1, `${name} must exist exactly once`);
        });
        const index = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'bot_life_state_simulation_owner_lease'").get();
        assert(index?.sql?.includes('(simulationOwner, simulationLeaseUntil, phase, activity)'), 'owner/lease index must use the intended key order');
        const partyOwnerIndex = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'bot_life_state_party_owner_filter'").get();
        assert(partyOwnerIndex?.sql?.includes('(simulationOwner, phase, partyId, activity, spotId, updatedAt)'), 'party candidate index must cover owner-filtered formation scans');
        const projectionColumns = db.prepare('PRAGMA table_xinfo(bot_life_state)').all();
        partyProjectionColumns.forEach((name) => {
            assert.strictEqual(projectionColumns.filter((column) => column.name === name).length, 1, `${name} must exist exactly once`);
        });
        const projectionIndex = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'bot_life_state_party_candidate_projection'").get();
        assert(projectionIndex?.sql?.includes('partyObjectiveSpot'), 'party candidate projection must have an indexed objective');
        assert(!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'bot_life_state_party_request_filter'").get(),
            'migration must remove the legacy JSON request index');
        assert(!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'bot_life_state_party_objective_spot'").get(),
            'migration must remove the legacy JSON objective index');
        const expiryIndex = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'bot_life_state_party_request_expiry'").get();
        assert(expiryIndex?.sql?.includes('partyRequestedAt'), 'party request expiry must use the generated request timestamp');
        const expiryPlan = db.prepare(`EXPLAIN QUERY PLAN SELECT characterId FROM bot_life_state
            WHERE simulationOwner = 'legacy_main' AND phase = 'cold'
            AND partyRequestStatus = 'open' AND partyRequestedAt <= ?
            AND (COALESCE(partyRequestPriority, '') <> 'required' OR partyRequestedAt <= ?)`)
            .all(1812345690000, 1812345685000);
        assert(
            expiryPlan.some((row) => row.detail.includes('bot_life_state_party_request_expiry')
                && row.detail.includes('partyRequestedAt<?')),
            'party request expiry must use the timestamp range from its projection index'
        );
        assert.strictEqual(Number(db.prepare('SELECT COUNT(*) count FROM schema_migrations WHERE version = 10').get().count), 1, 'v10 must be recorded exactly once');
        assert.strictEqual(Number(db.prepare('SELECT COUNT(*) count FROM schema_migrations WHERE version = 14').get().count), 1, 'v14 must be recorded exactly once');
        assert.strictEqual(Number(db.prepare('SELECT COUNT(*) count FROM schema_migrations WHERE version = 15').get().count), 1, 'v15 must be recorded exactly once');
        assert.strictEqual(Number(db.prepare('SELECT COUNT(*) count FROM schema_migrations WHERE version = 17').get().count), 1, 'v17 must be recorded exactly once');
        assert.deepStrictEqual(legacyRows(db), expectedRows, 'migration must preserve every pre-v10 bot lifecycle value');
        const owners = db.prepare(`SELECT simulationOwner, simulationRevision, simulationLeaseId, simulationLeaseUntil
            FROM bot_life_state ORDER BY characterId`).all();
        assert.deepStrictEqual(
            owners.map((row) => [row.simulationOwner, Number(row.simulationRevision), row.simulationLeaseId, Number(row.simulationLeaseUntil)]),
            expectedRows.map(() => ['legacy_main', 0, null, 0]),
            'all legacy bot rows must receive safe main-owner defaults'
        );
        const projected = db.prepare(`SELECT partyRequestStatus, partyRequestPriority, partyRequestedAt, partyObjectiveSpot
            FROM bot_life_state WHERE characterId = 71002`).get();
        assert.deepStrictEqual(
            { ...projected },
            {
                partyRequestStatus: 'open',
                partyRequestPriority: 'required',
                partyRequestedAt: 1812345680000,
                partyObjectiveSpot: 'party-request-spot'
            },
            'party candidate projections must reflect existing JSON state without a backfill rewrite'
        );
        assert.strictEqual(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
        assert.deepStrictEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
        db.close();
    }

    const version9Path = path.join(outputDir, 'version-9.sqlite');
    seed(version9Path, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    bootstrap(version9Path);
    assertMigrated(version9Path);
    bootstrap(version9Path);
    assertMigrated(version9Path);

    const version7Path = path.join(outputDir, 'version-7.sqlite');
    seed(version7Path, [1, 2, 3, 4, 5, 6, 7]);
    bootstrap(version7Path);
    assertMigrated(version7Path);

    const partialPath = path.join(outputDir, 'partial-v10.sqlite');
    seed(partialPath, [1, 2, 3, 4, 5, 6, 7, 8, 9], { partial: true });
    bootstrap(partialPath);
    assertMigrated(partialPath);

    const version13Path = path.join(outputDir, 'version-13.sqlite');
    seed(version13Path, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13], { schema: preV14Schema });
    bootstrap(version13Path);
    assertMigrated(version13Path);
    bootstrap(version13Path);
    assertMigrated(version13Path);

    const compactionPath = path.join(outputDir, 'version-16-compaction.sqlite');
    seed(compactionPath, Array.from({ length: 16 }, (_, index) => index + 1), { schema: currentSchema });
    const compactionSeed = open(compactionPath);
    compactionSeed.prepare(`UPDATE bot_life_state SET inventorySummary = ?, statsJson = ? WHERE characterId = ?`).run(
        JSON.stringify({
            57: { selfId: 57, name: 'Adena', amount: 78215 },
            100: { selfId: 100, name: 'Consumed', amount: 0 },
            101: { selfId: 101, name: 'Invalid', amount: -2 }
        }),
        JSON.stringify({
            targetCombat: {
                targets: { 20001: { resolves: 5 } },
                populationTargets: { 20001: { resolves: 5 } }
            }
        }),
        71001
    );
    const insertLifeEvent = compactionSeed.prepare(`INSERT INTO bot_life_events(
        characterId, eventType, summary, weight, createdAt, metaJson
    ) VALUES (?, ?, ?, ?, ?, '{}')`);
    insertLifeEvent.run(71001, 'rest', 'old rest', 2, 1000);
    insertLifeEvent.run(71001, 'rest', 'new rest', 2, 2000);
    insertLifeEvent.run(71001, 'hunt', 'old hunt', 1, 1100);
    insertLifeEvent.run(71001, 'hunt', 'new hunt', 1, 2100);
    insertLifeEvent.run(71001, 'death', 'major event', 4, 1500);
    compactionSeed.close();

    bootstrap(compactionPath);
    const compacted = open(compactionPath);
    const compactedState = compacted.prepare(`SELECT inventorySummary, statsJson
        FROM bot_life_state WHERE characterId = 71001`).get();
    const compactedInventory = JSON.parse(compactedState.inventorySummary);
    const compactedStats = JSON.parse(compactedState.statsJson);
    assert.deepStrictEqual(Object.keys(compactedInventory), ['57'], 'v17 must remove non-positive inventory entries');
    assert.strictEqual(compactedStats.targetCombat.targets, undefined, 'v17 must remove obsolete target maps');
    assert.deepStrictEqual(compactedStats.targetCombat.populationTargets, { 20001: { resolves: 5 } },
        'v17 must preserve population target telemetry');
    assert.deepStrictEqual(compacted.prepare(`SELECT eventType, summary FROM bot_life_events
        WHERE characterId = 71001 ORDER BY eventType`).all().map((row) => ({ ...row })), [
        { eventType: 'death', summary: 'major event' },
        { eventType: 'hunt', summary: 'new hunt' },
        { eventType: 'rest', summary: 'new rest' }
    ], 'v17 must retain major events and only the newest routine event of each type');
    assert.strictEqual(Number(compacted.prepare('SELECT COUNT(*) count FROM schema_migrations WHERE version = 17').get().count), 1);
    compacted.close();
    bootstrap(compactionPath);
    const compactedAgain = open(compactionPath);
    assert.strictEqual(Number(compactedAgain.prepare('SELECT COUNT(*) count FROM schema_migrations WHERE version = 17').get().count), 1,
        'v17 compaction must be one-time and idempotent');
    compactedAgain.close();

    const freshPath = path.join(outputDir, 'fresh.sqlite');
    bootstrap(freshPath);
    const fresh = open(freshPath);
    const freshColumns = fresh.prepare('PRAGMA table_xinfo(bot_life_state)').all().map((column) => column.name);
    ownerColumns.forEach((name) => assert(freshColumns.includes(name), `fresh bootstrap must include ${name}`));
    partyProjectionColumns.forEach((name) => assert(freshColumns.includes(name), `fresh bootstrap must include ${name}`));
    assert(fresh.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'bot_life_state_simulation_owner_lease'").get());
    assert(fresh.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'bot_life_state_party_candidate_projection'").get());
    assert(fresh.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'bot_life_state_party_request_expiry'").get());
    assert.strictEqual(Number(fresh.prepare('SELECT COUNT(*) count FROM schema_migrations WHERE version = 10').get().count), 1);
    assert.strictEqual(Number(fresh.prepare('SELECT COUNT(*) count FROM schema_migrations WHERE version = 14').get().count), 1);
    assert.strictEqual(Number(fresh.prepare('SELECT COUNT(*) count FROM schema_migrations WHERE version = 15').get().count), 1);
    assert.strictEqual(Number(fresh.prepare('SELECT COUNT(*) count FROM schema_migrations WHERE version = 17').get().count), 1);
    fresh.close();

    const failedPath = path.join(outputDir, 'failed-v10.sqlite');
    seed(failedPath, [1, 2, 3, 4, 5, 6, 7, 8, 9], { collision: true });
    bootstrap(failedPath, false);
    const failed = open(failedPath);
    const failedColumns = failed.prepare('PRAGMA table_info(bot_life_state)').all().map((column) => column.name);
    ownerColumns.forEach((name) => assert(!failedColumns.includes(name), `failed v10 must roll back ${name}`));
    assert.strictEqual(Number(failed.prepare('SELECT COUNT(*) count FROM schema_migrations WHERE version = 10').get().count), 0, 'failed v10 must not be recorded');
    assert.deepStrictEqual(legacyRows(failed), realisticRows, 'failed v10 must leave lifecycle data unchanged');
    assert.strictEqual(failed.prepare('SELECT sentinel FROM bot_life_state_simulation_owner_lease').get().sentinel, 'keep-me');
    failed.exec('DROP TABLE bot_life_state_simulation_owner_lease');
    failed.close();
    bootstrap(failedPath);
    assertMigrated(failedPath);

    console.log('sqlite bot life state migration compatibility checks passed');
}
