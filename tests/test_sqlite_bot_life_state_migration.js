const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const rootDir = path.resolve(__dirname, '..');
const outputDir = path.join(rootDir, 'tmp', 'test-sqlite-bot-life-state-migration');
// v10 added the loan columns with the revision; v72 drops them again.
const loanColumns = ['simulationOwner', 'simulationLeaseId', 'simulationLeaseUntil'];
const ownerColumns = ['simulationRevision', ...loanColumns];
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
        /updatedAt INTEGER NOT NULL DEFAULT 0,\r?\n\s*simulationRevision INTEGER NOT NULL DEFAULT 0/,
        'updatedAt INTEGER NOT NULL DEFAULT 0'
    );
    assert(!preV10Schema.includes('simulationRevision'), 'test fixture must reproduce the pre-v10 lifecycle schema');
    assert(!currentSchema.includes('simulationOwner'), 'the current schema has no loan columns');
    // Before v51 an inactive gear plan's next spot set the objective spot.
    const preV51Schema = currentSchema.replace(
        /CASE WHEN json_extract\(statsJson, '\$\.equipmentPlan\.status'\) = 'active'\r?\n\s*THEN (json_extract\(statsJson, '\$\.equipmentPlan\.next\.spotId'\)) END/,
        '$1'
    );
    assert(!preV51Schema.includes('equipmentPlan.status'), 'test fixture must reproduce the pre-v51 objective spot');
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
        },
        {
            characterId: 71004,
            accountName: 'migration-plan-wait',
            characterName: 'MigrationPlanWait',
            level: 44,
            exp: 1843210,
            sp: 10021,
            adena: 45000,
            homeRegion: 'Giran',
            currentRegion: 'Dragon Valley',
            spotId: 'dragon_valley_hunt',
            activity: 'hunting',
            phase: 'cold',
            partyId: null,
            inventorySummary: JSON.stringify({ 57: { selfId: 57, name: 'Adena', amount: 45000 } }),
            statsJson: JSON.stringify({ equipmentPlan: { status: 'component_ready', next: { spotId: 'inactive-plan-spot' } } }),
            updatedAt: 1812345710000
        },
        {
            characterId: 71005,
            accountName: 'migration-plan-go',
            characterName: 'MigrationPlanGo',
            level: 45,
            exp: 1943210,
            sp: 11021,
            adena: 46000,
            homeRegion: 'Giran',
            currentRegion: 'Dragon Valley',
            spotId: 'dragon_valley_hunt',
            activity: 'hunting',
            phase: 'cold',
            partyId: null,
            inventorySummary: JSON.stringify({ 57: { selfId: 57, name: 'Adena', amount: 46000 } }),
            statsJson: JSON.stringify({ equipmentPlan: { status: 'active', next: { spotId: 'active-plan-spot' } } }),
            updatedAt: 1812345720000
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
            // A world of this age has the loan columns v10 added.
            db.exec(`
                ALTER TABLE bot_life_state ADD COLUMN simulationOwner TEXT NOT NULL DEFAULT 'legacy_main';
                ALTER TABLE bot_life_state ADD COLUMN simulationLeaseId TEXT;
                ALTER TABLE bot_life_state ADD COLUMN simulationLeaseUntil INTEGER NOT NULL DEFAULT 0;
            `);
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
        insertBots(db);
        db.close();
    }

    const insertBots = (db, rows = realisticRows) => {
        const insertAccount = db.prepare('INSERT INTO accounts(username, password) VALUES (?, ?)');
        const insertCharacter = db.prepare(`INSERT INTO characters(
            id, username, name, classId, race, level, maxHp, maxMp,
            sex, face, hair, hairColor, locX, locY, locZ
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        rows.forEach((row) => {
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
        rows.forEach((row) => insert.run(
            row.characterId, row.accountName, row.characterName, row.level, row.exp, row.sp, row.adena,
            row.homeRegion, row.currentRegion, row.spotId, row.activity, row.phase, row.partyId,
            row.inventorySummary, row.statsJson, row.updatedAt
        ));
    };

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

    function assertMigrated(databasePath, expectedRows = realisticRows, expectedRevisions = expectedRows.map(() => 0)) {
        const db = open(databasePath);
        const columns = db.prepare('PRAGMA table_info(bot_life_state)').all();
        assert.strictEqual(columns.filter((column) => column.name === 'simulationRevision').length, 1, 'simulationRevision must exist exactly once');
        loanColumns.forEach((name) => assert(!columns.some((column) => column.name === name), `v72 must drop ${name}`));
        assert(!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'bot_life_state_simulation_owner_lease'").get(),
            'v72 must drop the owner/lease index');
        assert.deepStrictEqual(db.prepare(`SELECT name FROM sqlite_master WHERE ${loanColumns.map((name) => `sql LIKE '%${name}%'`).join(' OR ')}`).all(), [],
            'no index or trigger names a loan column');
        const partyOwnerIndex = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'bot_life_state_party_owner_filter'").get();
        assert(partyOwnerIndex?.sql?.includes('(phase, partyId, activity, spotId, updatedAt)'), 'party candidate index must cover formation scans');
        ['bot_life_state_warehouse_release', 'bot_life_state_warehouse_demand'].forEach((name) => {
            const partial = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(name);
            assert(partial?.sql?.includes("WHERE phase = 'cold'"), `${name} must stay a partial index on far bots`);
        });
        ['bot_party_candidate_insert', 'bot_party_candidate_metadata', 'bot_party_candidate_ordinary', 'bot_party_candidate_stats'].forEach((name) => assert(
            db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(name), `migrations must leave ${name}`));
        ['bot_party_candidate_payload', 'bot_party_candidate_identity'].forEach((name) => assert(
            !db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(name), `v74 must merge ${name} into the stats trigger`));
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
            WHERE phase = 'cold'
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
        assert.strictEqual(Number(db.prepare('SELECT COUNT(*) count FROM schema_migrations WHERE version = 25').get().count), 1, 'v25 must be recorded exactly once');
        const marketIndex = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'bot_life_state_market_reconcile'").get();
        assert(marketIndex?.sql?.includes('phase, updatedAt, characterId'), 'market rotation must have a keyset-compatible lifecycle index');
        assert.deepStrictEqual(legacyRows(db), expectedRows, 'migration must preserve every pre-v10 bot lifecycle value');
        assert.deepStrictEqual(
            db.prepare('SELECT simulationRevision FROM bot_life_state ORDER BY characterId').all().map((row) => Number(row.simulationRevision)),
            expectedRevisions,
            'every bot row keeps its revision; a row handed back from a loan moves it once'
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
        // As PartyRequestPlanner.objectiveSpot: only an active gear plan names the spot.
        assert.deepStrictEqual(db.prepare(`SELECT characterId, partyObjectiveSpot FROM bot_life_state
            WHERE characterId IN (71001, 71004, 71005) ORDER BY characterId`).all().map((row) => [Number(row.characterId), row.partyObjectiveSpot]), [
            [71001, 'death_pass_harpy'],
            [71004, 'dragon_valley_hunt'],
            [71005, 'active-plan-spot']
        ], 'an inactive gear plan must not set the party objective spot');
        assert.strictEqual(Number(db.prepare('SELECT COUNT(*) count FROM schema_migrations WHERE version = 51').get().count), 1, 'v51 must be recorded exactly once');
        assert.strictEqual(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
        assert.deepStrictEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
        db.close();
    }

    // The candidate row of bot 71001 (realisticRows[0]: a far bot hunting at its
    // spot, no party, not a population account) follows each of its inputs:
    // the stats keys it projects or judges eligibility by, and the life columns.
    const assertCandidateFollowsLifeRow = (databasePath) => {
        const db = open(databasePath);
        const read = () => {
            const row = db.prepare(`SELECT payloadJson, ordinaryEligible, joinAvailability, level
                FROM bot_party_candidate_projection WHERE characterId = 71001`).get();
            return { payload: JSON.parse(row.payloadJson), ordinary: Number(row.ordinaryEligible), join: Number(row.joinAvailability), level: Number(row.level) };
        };
        let stats = JSON.parse(realisticRows[0].statsJson);
        // JSON.stringify drops a key set to undefined: the edit removes it.
        const edit = (change, columns = {}) => {
            stats = { ...stats, ...change };
            const names = Object.keys(columns);
            db.prepare(`UPDATE bot_life_state SET ${['statsJson', ...names].map((name) => `${name} = ?`).join(', ')} WHERE characterId = 71001`)
                .run(JSON.stringify(stats), ...names.map((name) => columns[name]));
        };
        const expect = (payload, ordinary, join, level, message) => assert.deepStrictEqual(read(), { payload, ordinary, join, level }, message);
        const request = { status: 'open', priority: 'required', spotId: 'death_pass_harpy' };
        const plan = { status: 'active', next: { spotId: 'death_pass_harpy' } };
        expect(['dps', null, null, null, null, null], 0, 0, 38, 'a bot of a named account is no ordinary candidate');
        edit({ generatedCold: 1 });
        expect(['dps', null, null, null, null, null], 1, 1, 38, 'a generated far bot at its spot can join');
        edit({ role: 'tank', partyRequest: request });
        expect(['tank', null, request, null, null, null], 1, 1, 38, 'the role and the party request reach the payload');
        edit({ equipmentPlan: plan });
        expect(['tank', null, request, null, plan, null], 1, 1, 38, 'the gear plan reaches the payload');
        edit({ craftShop: { recipeId: 7 } });
        expect(['tank', null, request, null, plan, null], 0, 0, 38, 'a craft shop keeper is no candidate');
        edit({ craftShop: undefined, craftStationId: 3 });
        expect(['tank', null, request, null, plan, null], 0, 0, 38, 'a bot at a craft station is no candidate');
        edit({ craftStationId: undefined, playerPartyTakeover: { partyId: 'player-party' } });
        expect(['tank', null, request, null, plan, null], 0, 0, 38, 'a bot taken over by the player party is no candidate');
        edit({ playerPartyTakeover: undefined });
        expect(['tank', null, request, null, plan, null], 1, 1, 38, 'the bot is a candidate again once every flag is gone');
        edit({ deathCount: 3 });
        expect(['tank', null, request, null, plan, null], 1, 1, 38, 'an unrelated stats key leaves the candidate as it was');
        edit({ deathCount: 4 }, { phase: 'hot' });
        expect(['tank', null, request, null, plan, null], 1, 0, 38, 'a bot near the player cannot join');
        edit({ craftShop: { recipeId: 8 } }, { phase: 'cold' });
        expect(['tank', null, request, null, plan, null], 0, 0, 38, 'a flag and the phase in one write: the flag wins');
        edit({ craftShop: undefined }, { partyId: 'party-71001' });
        expect(['tank', null, request, null, plan, null], 1, 0, 38, 'a bot in a party cannot join');
        edit({}, { partyId: null, activity: 'selling' });
        expect(['tank', null, request, null, plan, null], 1, 0, 38, 'a selling bot cannot join');
        edit({ role: 'dps' }, { activity: 'party_wait', spotId: null });
        expect(['dps', null, request, null, plan, null], 1, 0, 38, 'a bot without a spot cannot join');
        edit({}, { spotId: 'death_pass_harpy', level: 39 });
        expect(['dps', null, request, null, plan, null], 1, 1, 39, 'a waiting bot at its spot can join and its level follows');
        db.close();
    };

    const version9Path = path.join(outputDir, 'version-9.sqlite');
    seed(version9Path, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    bootstrap(version9Path);
    assertMigrated(version9Path);
    bootstrap(version9Path);
    assertMigrated(version9Path);
    assertCandidateFollowsLifeRow(version9Path);

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

    // A world created from the pre-v51 schema: v39 (run here) builds the
    // projection index on the old column; v14 and v15 left their indexes.
    const version50Path = path.join(outputDir, 'version-50.sqlite');
    seed(version50Path, Array.from({ length: 50 }, (_, index) => index + 1).filter((version) => version !== 39),
        { schema: preV51Schema });
    const before51 = open(version50Path);
    before51.exec(`DROP INDEX bot_life_state_party_request_filter;
        DROP INDEX bot_life_state_party_objective_spot;
        CREATE INDEX bot_life_state_party_request_expiry ON bot_life_state(
            simulationOwner, phase, partyRequestStatus, partyRequestedAt, partyRequestPriority);`);
    assert.strictEqual(before51.prepare('SELECT partyObjectiveSpot FROM bot_life_state WHERE characterId = 71004').get().partyObjectiveSpot,
        'inactive-plan-spot', 'test fixture must reproduce the pre-v51 objective spot');
    before51.close();
    bootstrap(version50Path);
    assertMigrated(version50Path);
    bootstrap(version50Path);
    assertMigrated(version50Path);

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
    // Worlds of this age kept bot_life_events in the world file.
    compactionSeed.exec(`CREATE TABLE bot_life_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        characterId INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        eventType TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        weight INTEGER NOT NULL DEFAULT 1,
        createdAt INTEGER NOT NULL DEFAULT 0,
        metaJson TEXT
    )`);
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
    // The compacted events then moved to the history file.
    const compactedHistory = open(compactionPath.replace(/\.sqlite$/, '.history.sqlite'));
    assert.deepStrictEqual(compactedHistory.prepare(`SELECT eventType, summary FROM bot_life_events
        WHERE characterId = 71001 ORDER BY eventType`).all().map((row) => ({ ...row })), [
        { eventType: 'death', summary: 'major event' },
        { eventType: 'hunt', summary: 'new hunt' },
        { eventType: 'rest', summary: 'new rest' }
    ], 'v17 must retain major events and only the newest routine event of each type');
    compactedHistory.close();
    assert.strictEqual(Number(compacted.prepare('SELECT COUNT(*) count FROM schema_migrations WHERE version = 17').get().count), 1);
    compacted.close();
    bootstrap(compactionPath);
    const compactedAgain = open(compactionPath);
    assert.strictEqual(Number(compactedAgain.prepare('SELECT COUNT(*) count FROM schema_migrations WHERE version = 17').get().count), 1,
        'v17 compaction must be one-time and idempotent');
    compactedAgain.close();

    // v70: the generated name and look versions move from the stats into
    // their own columns; the stats lose them and the unread copy of sex.
    const versionsPath = path.join(outputDir, 'version-16-generated-versions.sqlite');
    seed(versionsPath, Array.from({ length: 16 }, (_, index) => index + 1), { schema: currentSchema });
    const versionsSeed = open(versionsPath);
    versionsSeed.prepare('UPDATE bot_life_state SET statsJson = ? WHERE characterId = ?').run(
        JSON.stringify({ role: 'dps', nameGeneratorVersion: 3, appearanceVersion: 2, sex: 1 }), 71001);
    versionsSeed.close();
    bootstrap(versionsPath);
    const versioned = open(versionsPath);
    const versionRows = () => versioned.prepare(`SELECT characterId, nameGeneratorVersion, appearanceVersion, statsJson
        FROM bot_life_state WHERE characterId IN (71001, 71002) ORDER BY characterId`).all()
        .map((row) => [Number(row.characterId), Number(row.nameGeneratorVersion), Number(row.appearanceVersion), JSON.parse(row.statsJson)]);
    assert.deepStrictEqual(versionRows(), [
        [71001, 3, 2, { role: 'dps' }],
        [71002, 0, 0, JSON.parse(realisticRows[1].statsJson)]
    ], 'v70 copies the versions into their columns and removes them and sex from the stats');
    versioned.close();

    // v80: the build hint and the per-target fight lists leave the stats;
    // an entry that is not an object stays as stored and boot still succeeds.
    const slimPath = path.join(outputDir, 'version-16-slim-stats.sqlite');
    seed(slimPath, Array.from({ length: 16 }, (_, index) => index + 1), { schema: currentSchema });
    const slimStats = {
        role: 'healer',
        build: { role: 'healer', grade: 'c' },
        targetCombat: {
            lastDefeatedNpcIds: [20101],
            populationTargets: {
                5: 'abc',
                6: { resolves: 2, lastDefeatedNpcIds: [20101, 20102], lastResolvedAt: 1812345678000 },
                7: true,
                8: { resolves: 1, threat: 0.30000000000000004 }
            }
        },
        big: 1e21
    };
    const slimSeed = open(slimPath);
    slimSeed.prepare('UPDATE bot_life_state SET statsJson = ? WHERE characterId = ?').run(JSON.stringify(slimStats), 71001);
    slimSeed.close();
    bootstrap(slimPath);
    const slimmed = open(slimPath);
    const slimRow = slimmed.prepare('SELECT statsJson FROM bot_life_state WHERE characterId = 71001').get().statsJson;
    slimmed.close();
    const expectedSlim = JSON.parse(JSON.stringify(slimStats));
    delete expectedSlim.build;
    delete expectedSlim.targetCombat.populationTargets[6].lastDefeatedNpcIds;
    assert.strictEqual(slimRow, JSON.stringify(expectedSlim),
        'v80 drops the build hint and the per-target lists and keeps every other value as stored');

    const freshPath = path.join(outputDir, 'fresh.sqlite');
    bootstrap(freshPath);
    const fresh = open(freshPath);
    const partyTriggers = (db) => db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'bot_party_candidate_%' ORDER BY name").all()
        .map((row) => [row.name, row.sql.replace(/\s+/g, ' ')]);
    const migrated = open(version9Path);
    assert.deepStrictEqual(partyTriggers(fresh), partyTriggers(migrated), 'fresh and migrated worlds keep the same party candidate triggers');
    migrated.close();
    const freshColumns = fresh.prepare('PRAGMA table_xinfo(bot_life_state)').all().map((column) => column.name);
    assert(freshColumns.includes('simulationRevision'), 'fresh bootstrap must include simulationRevision');
    loanColumns.forEach((name) => assert(!freshColumns.includes(name), `fresh bootstrap must not keep ${name}`));
    partyProjectionColumns.forEach((name) => assert(freshColumns.includes(name), `fresh bootstrap must include ${name}`));
    assert(!fresh.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'bot_life_state_simulation_owner_lease'").get());
    assert(fresh.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'bot_life_state_party_candidate_projection'").get());
    assert(fresh.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'bot_life_state_party_request_expiry'").get());
    assert.strictEqual(Number(fresh.prepare('SELECT COUNT(*) count FROM schema_migrations WHERE version = 10').get().count), 1);
    assert.strictEqual(Number(fresh.prepare('SELECT COUNT(*) count FROM schema_migrations WHERE version = 14').get().count), 1);
    assert.strictEqual(Number(fresh.prepare('SELECT COUNT(*) count FROM schema_migrations WHERE version = 15').get().count), 1);
    assert.strictEqual(Number(fresh.prepare('SELECT COUNT(*) count FROM schema_migrations WHERE version = 17').get().count), 1);
    assert.strictEqual(Number(fresh.prepare('SELECT COUNT(*) count FROM schema_migrations WHERE version = 72').get().count), 1);
    insertBots(fresh, realisticRows.slice(0, 1));
    fresh.close();
    assertCandidateFollowsLifeRow(freshPath);

    // v72 on a world saved while a far bot was on loan: the loan columns,
    // the owner index and an owner-naming trigger are back as before v72.
    // The row is handed back (revision + 1) and can join a party again.
    const loanPath = path.join(outputDir, 'version-71-loan.sqlite');
    seed(loanPath, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    bootstrap(loanPath);
    const rewind = open(loanPath);
    const metadataSql = rewind.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'bot_party_candidate_metadata'").get().sql;
    rewind.exec(`
        ALTER TABLE bot_life_state ADD COLUMN simulationOwner TEXT NOT NULL DEFAULT 'legacy_main';
        ALTER TABLE bot_life_state ADD COLUMN simulationLeaseId TEXT;
        ALTER TABLE bot_life_state ADD COLUMN simulationLeaseUntil INTEGER NOT NULL DEFAULT 0;
        CREATE INDEX bot_life_state_simulation_owner_lease ON bot_life_state(simulationOwner, simulationLeaseUntil, phase, activity);
        DROP INDEX bot_life_state_party_owner_filter;
        CREATE INDEX bot_life_state_party_owner_filter ON bot_life_state(simulationOwner, phase, partyId, activity, spotId, updatedAt);
        DROP TRIGGER bot_party_candidate_metadata;
        ${metadataSql.replace('level,phase,', 'level,phase,simulationOwner,')
        .replaceAll("NEW.phase = 'cold'", "NEW.phase = 'cold' AND NEW.simulationOwner = 'legacy_main'")};
        DELETE FROM schema_migrations WHERE version = 72;
    `);
    const loanStats = JSON.stringify({ ...JSON.parse(realisticRows[0].statsJson), generatedCold: 1 });
    rewind.prepare('UPDATE bot_life_state SET statsJson = ? WHERE characterId = 71001').run(loanStats);
    const joinAvailability = (db) => Number(db.prepare('SELECT joinAvailability FROM bot_party_candidate_projection WHERE characterId = 71001').get().joinAvailability);
    assert.strictEqual(joinAvailability(rewind), 1, 'test fixture: an ordinary far bot at its spot can join');
    rewind.exec(`UPDATE bot_life_state SET simulationOwner = 'cold_simulation_owner', simulationLeaseId = 'lease-71001',
        simulationLeaseUntil = 1812345999000 WHERE characterId = 71001`);
    assert.strictEqual(joinAvailability(rewind), 0, 'test fixture: the bot on loan cannot join');
    rewind.close();
    bootstrap(loanPath);
    const loanRows = realisticRows.map((row, index) => (index === 0 ? { ...row, statsJson: loanStats } : row));
    assertMigrated(loanPath, loanRows, loanRows.map((row, index) => (index === 0 ? 1 : 0)));
    const handedBack = open(loanPath);
    assert.strictEqual(joinAvailability(handedBack), 1, 'the bot handed back from its loan can join a party again');
    handedBack.prepare("UPDATE bot_life_state SET phase = 'hot' WHERE characterId = 71001").run();
    assert.strictEqual(joinAvailability(handedBack), 0, 'the re-created trigger still follows the phase');
    handedBack.close();

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
