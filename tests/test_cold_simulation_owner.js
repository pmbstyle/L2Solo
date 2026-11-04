process.env.BOT_DEVELOPER_DIAGNOSTICS = 'true'; // This fixture inspects optional developer metrics.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

require('../src/Global');

const Database = invoke('Database');
const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const BotLifeState = invoke('GameServer/Bot/Population/BotLifeState');
const databasePath = path.join(process.cwd(), 'tmp', 'test-cold-simulation-owner.sqlite');

fs.rmSync(databasePath, { force: true });
options.default.Database.path = path.relative(process.cwd(), databasePath);
Database.init();

function state(characterId, revision, activity = 'hunting') {
    return {
        characterId,
        accountName: 'owner_probe',
        name: 'OwnerProbe',
        level: 20,
        exp: 1000,
        sp: 100,
        adena: 500,
        phase: 'cold',
        activity,
        loc: { locX: 10, locY: 20, locZ: -30 },
        vitals: { hp: 100, maxHp: 100, mp: 50, maxMp: 50 },
        timing: { activityStartedAt: 100, nextResolveAt: 1000, lastResolvedAt: 500, lastHotAt: null },
        party: { partyId: null },
        stats: {},
        inventory: {},
        simulation: { revision },
        updatedAt: 1000
    };
}

(async () => {
    await Database.createAccount('owner_probe', 'secret');
    await Database.createCharacter('owner_probe', {
        name: 'OwnerProbe', race: 0, classId: 0, maxHp: 100, maxMp: 50,
        sex: 0, face: 0, hair: 0, hairColor: 0, locX: 10, locY: 20, locZ: -30
    });
    const character = (await Database.fetchCharacters('owner_probe'))[0];
    const characterId = Number(character.id);
    await Database.execute([
        `INSERT INTO bot_life_state (
            characterId, accountName, characterName, level, activity, phase,
            locX, locY, locZ, hp, maxHp, mp, maxMp, statsJson, inventorySummary, updatedAt
        ) VALUES (?, ?, ?, 20, 'hunting', 'cold', 10, 20, -30, 100, 100, 50, 50, '{}', '{}', 1000)`,
        [characterId, 'owner_probe', 'OwnerProbe']
    ]);

    const columns = await Database.execute(['PRAGMA table_info(bot_life_state)', []]);
    assert(columns.some((entry) => entry.name === 'simulationRevision'), 'migration must add simulationRevision');
    for (const column of ['simulationOwner', 'simulationLeaseId', 'simulationLeaseUntil']) {
        assert(!columns.some((entry) => entry.name === column), `migration 72 must drop ${column}`);
    }
    const migrations = await Database.execute(['SELECT version FROM schema_migrations WHERE version = 10', []]);
    assert.strictEqual(migrations.length, 1, 'ownership schema migration must be recorded exactly once');

    for (const activity of ['hunting', 'resting', 'traveling', 'dead']) {
        assert.strictEqual(Owner.eligibility(state(characterId, 0, activity)).ok, true, `${activity} is a simple solo cold path`);
    }
    assert.strictEqual(Owner.eligibility({ ...state(characterId, 0), party: { partyId: 'bgp_1' } }).reason, 'background_party');
    assert.strictEqual(Owner.eligibility({ ...state(characterId, 0), activity: 'merchant', stats: { marketStore: {} } }).reason, 'legacy_activity');
    assert.strictEqual(Owner.eligibility({ ...state(characterId, 0), activity: 'crafting', stats: { craftShop: {} } }).reason, 'legacy_activity');
    assert.strictEqual(Owner.eligibility({ ...state(characterId, 0), activity: 'party_wait' }).reason, 'legacy_activity');
    assert.strictEqual(Owner.eligibility({ ...state(characterId, 0), stats: { supplyErrand: {} } }).reason, 'player_workflow');
    assert.strictEqual(Owner.eligibility({ ...state(characterId, 0), stats: { equipmentPlan: { strategy: 'market' } } }).reason, 'market_plan');
    assert.strictEqual(Owner.eligibility({ ...state(characterId, 0), stats: { equipmentPlan: { strategy: 'craft' } } }).reason, 'craft_plan');
    assert.strictEqual(Owner.eligibility({
        ...state(characterId, 0, 'traveling'),
        stats: { travel: { arrivalActivity: 'shopping', reason: 'market_search_for_weapon' } }
    }).reason, 'legacy_travel');
    assert.strictEqual(Owner.eligibility(state(characterId, 0), { hasWarehouseWorkflow: true }).reason, 'warehouse_state');
    assert.strictEqual(Owner.eligibility({ ...state(characterId, 0), stats: { warehouseErrand: {} } }).reason, 'warehouse_state');
    assert(Owner.eligibility({ ...state(characterId, 0), stats: { craftReturn: { loc: {} },
        equipmentPlan: { status: 'deferred', strategy: 'none' } } }).ok,
    'an abandoned craft return point is not an active crafting service');

    // The load (its startup repair save) lands before the counted writes.
    await BotLifeState.init();
    const initialState = state(characterId, 0);
    BotLifeState.acceptSimulationOwnership(characterId, initialState.simulation, initialState);
    const beforeWrites = Number((await Database.execute([
        'SELECT simulationRevision FROM bot_life_state WHERE characterId = ?', [characterId]]))[0].simulationRevision);
    const queuedBeforeMigration = BotLifeState.upsertState({
        ...initialState,
        stats: { generatedCold: true, generatedIndex: 700 }
    }, 'appearance_race_before');
    const queuedMigration = BotLifeState.acceptAppearanceMetadata(characterId, 1, 2);
    const queuedNameMigration = BotLifeState.acceptNameMetadata(characterId, 'NewOwnerNick', 3);
    const [queuedSave, migratedLifecycle, renamed] = await Promise.all([
        queuedBeforeMigration,
        queuedMigration,
        queuedNameMigration
    ]);
    assert(queuedSave, 'the save queued before the migrations lands');
    assert.strictEqual(migratedLifecycle.appearanceVersion, 2,
        'appearance migration must run in the per-character lifecycle write chain');
    assert.strictEqual(renamed.name, 'NewOwnerNick');
    assert.strictEqual(renamed.nameGeneratorVersion, 3);
    const versioned = (await Database.execute([
        'SELECT characterName, nameGeneratorVersion, appearanceVersion FROM bot_life_state WHERE characterId = ?',
        [characterId]
    ]))[0];
    assert.deepStrictEqual([versioned.characterName, Number(versioned.nameGeneratorVersion), Number(versioned.appearanceVersion)],
        ['NewOwnerNick', 3, 2], 'the name and look versions live in their own columns');

    // The queued save, the generated look and the name write each moved the
    // far row's revision once, and the cache carries the written number.
    assert.strictEqual(BotLifeState.cachedState(characterId).simulation.revision, beforeWrites + 3,
        'each main write to a far row moves its revision once');
    const [invalidPatch] = await Database.commitAndReleaseColdSimulationLeases([{
        characterId,
        expectedRevision: beforeWrites + 3,
        timestamp: 1800,
        patch: { arbitraryColumn: 1 }
    }]);
    assert.strictEqual(invalidPatch.reason, 'invalid_patch', 'gateway must reject fields outside the explicit bridge protocol');

    const migratedAppearance = await BotLifeState.acceptAppearanceMetadata(characterId, 1, 2);
    assert.strictEqual(migratedAppearance.appearanceVersion, 2,
        'appearance metadata must patch atomically');
    assert.strictEqual(BotLifeState.cachedState(characterId).appearanceVersion, 2,
        'appearance migration must patch the active lifecycle cache without replacing other state');

    // The worker proposes on the state it stepped from: its name and look ride along.
    const resting = {
        ...state(characterId, 0, 'resting'),
        name: BotLifeState.cachedState(characterId).name,
        appearanceVersion: BotLifeState.cachedState(characterId).appearanceVersion,
        stats: { restUntil: 9000 },
        inventory: {
            57: { selfId: 57, name: 'Adena', amount: 500 },
            9999: { selfId: 9999, name: 'Consumed Probe', amount: 0 }
        },
        timing: { activityStartedAt: 2000, nextResolveAt: 9000, lastResolvedAt: 2000, lastHotAt: null },
        updatedAt: 2000
    };
    const commitOn = (revision, nextState, timestamp) => Owner.commitBatch([{ revision, nextState }], { timestamp })
        .then(([result]) => result);
    // The look write during the step moved the row: the proposal built before
    // it is refused and the step is redone on the row.
    assert.strictEqual((await commitOn(0, resting, 2000)).reason, 'stale_revision',
        'a proposal built before a main write is refused');
    const step = BotLifeState.cachedState(characterId).simulation.revision;
    const committed = await commitOn(step, resting, 2000);
    assert.strictEqual(committed.ok, true, 'owner proposal must commit through the main database gateway');
    assert.strictEqual(committed.revision, step + 1, 'conditional commit must advance the revision');
    assert.strictEqual(Number(committed.row.simulationRevision), committed.revision, 'the commit hands back the revision it wrote');
    assert.strictEqual(BotLifeState.cachedState(characterId).activity, 'resting', 'commit must reflect the accepted state in cache');
    assert.strictEqual(BotLifeState.cachedState(characterId).simulation.revision, committed.revision, 'commit must reflect its revision in cache');
    assert.strictEqual(BotLifeState.cachedState(characterId).inventory['9999'], undefined,
        'committed cache state must not retain a zero-amount inventory entry');
    const committedInventory = JSON.parse((await Database.execute([
        'SELECT inventorySummary FROM bot_life_state WHERE characterId = ?', [characterId]
    ]))[0].inventorySummary);
    assert.strictEqual(committedInventory['9999'], undefined,
        'cold-owner persistence must not write a zero-amount inventory entry');
    const committedRow = (await Database.execute([
        'SELECT statsJson, characterName, nameGeneratorVersion, appearanceVersion FROM bot_life_state WHERE characterId = ?', [characterId]
    ]))[0];
    // The commit patch carries no name or look version: the columns keep what their writers set.
    assert.deepStrictEqual([committedRow.characterName, Number(committedRow.nameGeneratorVersion), Number(committedRow.appearanceVersion)],
        ['NewOwnerNick', 3, 2], 'a commit leaves the name and its versions to their writers');
    assert.strictEqual(BotLifeState.cachedState(characterId).name, 'NewOwnerNick');
    assert.strictEqual(JSON.parse(committedRow.statsJson).restUntil, 9000, 'the commit writes the worker\'s stats');
    assert.strictEqual(BotLifeState.cachedState(characterId).appearanceVersion, 2,
        'the main cache keeps the look version over a commit');
    const committedCharacter = (await Database.fetchCharacters('owner_probe'))[0];
    assert.strictEqual(committedCharacter.name, 'NewOwnerNick');
    assert.strictEqual(Number(committedCharacter.sex), 1,
        'the same migration transaction must update the physical character appearance');


    const staleCommit = await commitOn(step, { ...resting, activity: 'hunting' }, 2100);
    assert.strictEqual(staleCommit.reason, 'stale_revision', 'an old step must never overwrite a newer revision');
    const partitionFailure = await commitOn(committed.revision, { ...resting, activity: 'crafting', stats: { craftShop: {} } }, 2200);
    assert.strictEqual(partitionFailure.reason, 'partition_rejected', 'owner cannot cross into a legacy-main activity');

    const handoff = await Owner.handoffToMain(BotLifeState.cachedState(characterId), { timestamp: 3000 });
    assert.strictEqual(handoff.reason, 'hot_handoff');
    assert.strictEqual(handoff.revision, committed.revision + 1, 'a hot activation moves the revision before spawning');
    const postHandoffCommit = await commitOn(committed.revision, resting, 3200);
    assert.strictEqual(postHandoffCommit.reason, 'stale_revision', 'handoff must fence a late cold commit');

    await Database.execute([
        `UPDATE bot_life_state
         SET activity = 'resting', phase = 'cold', adena = 100,
             inventorySummary = ?, statsJson = '{}'
         WHERE characterId = ?`,
        [JSON.stringify({ 57: { selfId: 57, name: 'Adena', amount: 100 } }), characterId]
    ]);
    // A clan inventory write moves the row under a step: the step's commit is
    // refused and the row keeps the new inventory.
    const [beforeRace] = await Database.execute(['SELECT simulationRevision FROM bot_life_state WHERE characterId = ?', [characterId]]);
    const raceRevision = Number(beforeRace.simulationRevision);
    const inventoryAfterClanWrite = JSON.stringify({ '1869': { selfId: 1869, amount: 42 } });
    await Database.execute([`UPDATE bot_life_state SET simulationRevision = simulationRevision + 1,
        inventorySummary = ?, statsJson = ? WHERE characterId = ?`,
    [inventoryAfterClanWrite, JSON.stringify({ clanInventoryRevision: raceRevision + 1 }), characterId]]);
    const rejectedCommit = await commitOn(raceRevision, resting, 6400);
    assert.strictEqual(rejectedCommit.reason, 'stale_revision');
    const [afterRace] = await Database.execute(['SELECT * FROM bot_life_state WHERE characterId = ?', [characterId]]);
    assert.strictEqual(afterRace.inventorySummary, inventoryAfterClanWrite, 'a refused commit preserves the new inventory');
    assert.strictEqual(JSON.parse(afterRace.statsJson).clanInventoryRevision, raceRevision + 1);

    // A lifecycle job may retain a snapshot while the generated name/look
    // migrations run. Its later ordinary save must keep their newer metadata
    // in SQLite, its returned snapshot and the lifecycle cache.
    const metadataId = Number((await Database.createCharacter('owner_probe', {
        name: 'MetadataOld', race: 0, classId: 0, maxHp: 100, maxMp: 50,
        sex: 0, face: 0, hair: 0, hairColor: 0, locX: 10, locY: 20, locZ: -30
    })).insertId);
    const metadataBefore = await BotLifeState.upsertState({
        ...state(metadataId, 0), name: 'MetadataOld', nameGeneratorVersion: 1, appearanceVersion: 1
    }, 'metadata_race_fixture');
    assert(metadataBefore);
    const appearanceWrite = BotLifeState.acceptAppearanceMetadata(metadataId, 1, 3);
    const nameWrite = BotLifeState.acceptNameMetadata(metadataId, 'MetadataNew', 4);
    const lateMetadataSave = BotLifeState.upsertState({
        ...metadataBefore, activity: 'resting', stats: { restUntil: 12000 }
    }, 'stale_metadata_snapshot');
    const [, , metadataSaved] = await Promise.all([appearanceWrite, nameWrite, lateMetadataSave]);
    assert(metadataSaved, 'a stale metadata snapshot can still save unrelated lifecycle changes');
    const metadata = snapshot => [snapshot.name, snapshot.nameGeneratorVersion, snapshot.appearanceVersion];
    assert.deepStrictEqual(metadata(metadataSaved), ['MetadataNew', 4, 3],
        'the returned save must not roll back a migrated name or appearance version');
    assert.deepStrictEqual(metadata(BotLifeState.cachedState(metadataId)), ['MetadataNew', 4, 3],
        'the lifecycle cache must keep the latest metadata after a stale save');
    const [metadataRow] = await Database.execute([
        'SELECT characterName, nameGeneratorVersion, appearanceVersion, simulationRevision FROM bot_life_state WHERE characterId = ?',
        [metadataId]
    ]);
    assert.deepStrictEqual([metadataRow.characterName, metadataRow.nameGeneratorVersion, metadataRow.appearanceVersion],
        ['MetadataNew', 4, 3], 'the durable row must keep the latest metadata');
    assert.strictEqual(metadataSaved.activity, 'resting');
    assert.strictEqual(metadataSaved.stats.restUntil, 12000, 'the unrelated lifecycle update must land');
    assert.strictEqual(Number(metadataRow.simulationRevision), metadataBefore.simulation.revision + 3,
        'both migrations and the accepted lifecycle save advance the revision once');
    assert.deepStrictEqual(metadata(metadataBefore), ['MetadataOld', 1, 1],
        'preserving current metadata must not mutate the caller\'s old snapshot');
    const [physicalMetadata] = await Database.execute(['SELECT name, sex FROM characters WHERE id = ?', [metadataId]]);
    assert.deepStrictEqual([physicalMetadata.name, physicalMetadata.sex], ['MetadataNew', 1],
        'the life row must agree with the migrated physical character');

    const sameVersionSave = await BotLifeState.upsertState({
        ...metadataSaved, name: 'StaleActorName', appearanceVersion: undefined
    }, 'same_version_stale_name');
    assert(sameVersionSave);
    assert.deepStrictEqual(metadata(sameVersionSave), ['MetadataNew', 4, 3],
        'a stale actor name with the same version and an omitted look version cannot undo metadata');
    await BotLifeState.acceptNameMetadata(metadataId, 'MetadataNewest', 5);
    await BotLifeState.acceptAppearanceMetadata(metadataId, 0, 4);
    const newerMetadataSave = await BotLifeState.upsertState(sameVersionSave, 'metadata_migrated_again');
    assert(newerMetadataSave);
    assert.deepStrictEqual(metadata(newerMetadataSave), ['MetadataNewest', 5, 4],
        'subsequent migrations must still advance and survive later saves');

    // A save or a commit names an indexed column only when its value moves:
    // SQLite rewrites the index entry of every column an UPDATE sets (a WAL
    // page each). The row still reads back as the state that was saved.
    const heldColumns = ['accountName', 'characterName', 'phase', 'partyId', 'nextResolveAt'];
    await Database.execute(['CREATE TEMP TABLE held_column_writes (name TEXT)', []]);
    for (const column of heldColumns) {
        await Database.execute([`CREATE TEMP TRIGGER held_column_${column} AFTER UPDATE OF ${column} ON bot_life_state
            BEGIN INSERT INTO held_column_writes VALUES ('${column}'); END`, []]);
    }
    const heldWrites = async () => {
        const rows = await Database.execute(['SELECT name FROM held_column_writes ORDER BY name', []]);
        await Database.execute(['DELETE FROM held_column_writes', []]);
        return rows.map((row) => row.name);
    };
    const readRow = async () => (await Database.execute([`SELECT accountName, characterName, phase, partyId, nextResolveAt,
        hp, statsJson FROM bot_life_state WHERE characterId = ?`, [metadataId]]))[0];
    const vitalsSave = await BotLifeState.upsertState({
        ...newerMetadataSave, vitals: { ...newerMetadataSave.vitals, hp: 77 }, stats: { ...newerMetadataSave.stats, restUntil: 13000 }
    }, 'held_columns_still');
    assert.deepStrictEqual(await heldWrites(), [], 'a save that moves no indexed column sets none');
    const stillRow = await readRow();
    assert.deepStrictEqual([stillRow.accountName, stillRow.characterName, stillRow.phase, stillRow.partyId,
        Number(stillRow.nextResolveAt), Number(stillRow.hp), JSON.parse(stillRow.statsJson).restUntil],
    ['owner_probe', 'MetadataNewest', 'cold', null, Number(newerMetadataSave.timing.nextResolveAt), 77, 13000],
    'the row reads back as the saved state');
    const timingSave = await BotLifeState.upsertState({
        ...vitalsSave, timing: { ...vitalsSave.timing, nextResolveAt: 14000 }
    }, 'held_columns_due');
    assert.deepStrictEqual(await heldWrites(), ['nextResolveAt'], 'a save sets the indexed column that moved');
    assert.strictEqual(Number((await readRow()).nextResolveAt), 14000);
    const heldCommit = await commitOn(timingSave.simulation.revision, {
        ...timingSave, timing: { ...timingSave.timing, nextResolveAt: 15000, lastResolvedAt: 14000 }, updatedAt: 14000
    }, 14000);
    assert.strictEqual(heldCommit.ok, true, heldCommit.reason);
    assert.deepStrictEqual(await heldWrites(), ['nextResolveAt'], 'a commit leaves the phase and party it does not move');
    const committedHeld = await readRow();
    assert.deepStrictEqual([committedHeld.phase, committedHeld.partyId, Number(committedHeld.nextResolveAt), Number(committedHeld.hp)],
        ['cold', null, 15000, 77], 'the commit reads back as proposed');

    // Developer diagnostics: an item read counts under its call-site tag.
    await Database.fetchItems(characterId, 'owner_probe');
    assert.strictEqual(invoke('GameServer/Bot/Economy/EconomyDiagnostics').metrics().counts['item_list:call:owner_probe'], 1);

    const dbStats = Database.stats();
    assert.strictEqual(path.resolve(dbStats.path), path.resolve(databasePath), 'all owner operations must use the one configured SQLite gateway');
    console.log('Cold simulation owner revision fence and handoff checks passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => Database.close());
