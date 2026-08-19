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
        simulation: { ownerId: Owner.LEGACY_OWNER_ID, revision, leaseId: null, leaseUntil: 0 },
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
    for (const column of ['simulationOwner', 'simulationRevision', 'simulationLeaseId', 'simulationLeaseUntil']) {
        assert(columns.some((entry) => entry.name === column), `migration must add ${column}`);
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

    const initialState = state(characterId, 0);
    BotLifeState.acceptSimulationOwnership(characterId, initialState.simulation, initialState);
    const first = await Owner.claim(initialState, { timestamp: 1000, leaseMs: 5000, leaseId: 'lease-a' });
    assert.strictEqual(first.ok, true, 'simple cold state must be claimable');
    assert.strictEqual(first.revision, 1, 'claim must advance the persisted revision');
    assert.strictEqual(BotLifeState.cachedState(characterId).simulation.ownerId, Owner.OWNER_ID, 'claim must update cached ownership');
    assert.strictEqual(BotLifeState.cachedState(characterId).simulation.revision, first.revision, 'claim must update the cached revision');
    const competing = await Owner.claim({
        ...state(characterId, 1),
        simulation: { ownerId: Owner.OWNER_ID, revision: 1, leaseId: 'lease-a', leaseUntil: 6000 }
    }, { timestamp: 1500, leaseMs: 5000, leaseId: 'lease-b' });
    assert.strictEqual(competing.reason, 'lease_active', 'an active lease must reject a competing claim');

    const invalidPatch = await Database.commitColdSimulationLease({
        characterId,
        expectedRevision: first.revision,
        ownerId: Owner.OWNER_ID,
        leaseId: first.leaseId,
        timestamp: 1800,
        leaseUntil: 6800,
        patch: { arbitraryColumn: 1 }
    });
    assert.strictEqual(invalidPatch.reason, 'invalid_patch', 'gateway must reject fields outside the explicit bridge protocol');

    const renewed = await Owner.renewActiveLeases({ timestamp: 2000, leaseMs: 5000 });
    assert.strictEqual(renewed.length, 1, 'active cold ownership must be renewable before its lease expires');
    assert.strictEqual(renewed[0].ok, true);
    assert.strictEqual(renewed[0].leaseUntil, 7000, 'renewal must extend the lease from the renewal timestamp');
    assert.strictEqual(BotLifeState.cachedState(characterId).simulation.leaseUntil, 7000,
        'renewal must update the main ownership cache for later persistence');

    const resting = {
        ...state(characterId, first.revision, 'resting'),
        stats: { restUntil: 9000 },
        inventory: {
            57: { selfId: 57, name: 'Adena', amount: 500 },
            9999: { selfId: 9999, name: 'Consumed Probe', amount: 0 }
        },
        timing: { activityStartedAt: 2000, nextResolveAt: 9000, lastResolvedAt: 2000, lastHotAt: null },
        updatedAt: 2000
    };
    const committed = await Owner.commit(first, resting, { timestamp: 2000, leaseMs: 5000 });
    assert.strictEqual(committed.ok, true, 'owner proposal must commit through the main database gateway');
    assert.strictEqual(committed.revision, 2, 'conditional commit must advance the revision');
    assert.strictEqual(committed.row.activity, 'resting');
    assert.strictEqual(BotLifeState.cachedState(characterId).activity, 'resting', 'commit must reflect the accepted state in cache');
    assert.strictEqual(BotLifeState.cachedState(characterId).simulation.revision, committed.revision, 'commit must reflect its revision in cache');
    assert.strictEqual(BotLifeState.cachedState(characterId).inventory['9999'], undefined,
        'committed cache state must not retain a zero-amount inventory entry');
    const committedInventory = JSON.parse((await Database.execute([
        'SELECT inventorySummary FROM bot_life_state WHERE characterId = ?', [characterId]
    ]))[0].inventorySummary);
    assert.strictEqual(committedInventory['9999'], undefined,
        'cold-owner persistence must not write a zero-amount inventory entry');

    const staleCommit = await Owner.commit(first, { ...resting, activity: 'hunting' }, { timestamp: 2100, leaseMs: 5000 });
    assert.strictEqual(staleCommit.reason, 'stale_revision', 'an old claim must never overwrite a newer revision');
    const partitionFailure = await Owner.commit(committed, { ...resting, activity: 'crafting', stats: { craftShop: {} } }, { timestamp: 2200 });
    assert.strictEqual(partitionFailure.reason, 'partition_rejected', 'owner cannot cross into a legacy-main activity');
    const staleRelease = await Owner.release(first, { timestamp: 2300 });
    assert.strictEqual(staleRelease.reason, 'stale_revision', 'release is CAS-protected too');

    const released = await Owner.release(committed, { timestamp: 2400 });
    assert.strictEqual(released.ok, true);
    assert.strictEqual(released.ownerId, Owner.LEGACY_OWNER_ID);
    assert.strictEqual(released.revision, 3);
    assert.strictEqual(BotLifeState.cachedState(characterId).simulation.ownerId, Owner.LEGACY_OWNER_ID, 'release must return cached ownership to main');

    const secondState = {
        ...resting,
        simulation: { ownerId: Owner.LEGACY_OWNER_ID, revision: released.revision, leaseId: null, leaseUntil: 0 }
    };
    const second = await Owner.claim(secondState, { timestamp: 3000, leaseMs: 5000, leaseId: 'lease-c' });
    assert.strictEqual(second.ok, true);
    const handoff = await Owner.handoffToMain({
        ...secondState,
        simulation: { ownerId: Owner.OWNER_ID, revision: second.revision, leaseId: second.leaseId, leaseUntil: second.leaseUntil }
    });
    assert.strictEqual(handoff.reason, 'hot_handoff', 'hot activation must revoke the cold claim before spawning');
    const postHandoffCommit = await Owner.commit(second, resting, { timestamp: 3200 });
    assert.strictEqual(postHandoffCommit.reason, 'stale_revision', 'handoff must fence a late cold commit');

    const thirdState = {
        ...resting,
        simulation: { ownerId: Owner.LEGACY_OWNER_ID, revision: handoff.revision, leaseId: null, leaseUntil: 0 }
    };
    const third = await Owner.claim(thirdState, { timestamp: 4000, leaseMs: 1000, leaseId: 'lease-d' });
    assert.strictEqual(third.ok, true);
    assert.strictEqual((await Owner.recoverExpiredLeases(4500)).affectedRows, 0, 'live lease must survive recovery');
    assert.strictEqual((await Owner.recoverExpiredLeases(5001)).affectedRows, 1, 'expired owner must recover to legacy_main');
    const recovered = (await Database.execute([
        'SELECT simulationOwner, simulationRevision, simulationLeaseId, simulationLeaseUntil FROM bot_life_state WHERE characterId = ?',
        [characterId]
    ]))[0];
    assert.strictEqual(recovered.simulationOwner, Owner.LEGACY_OWNER_ID);
    assert.strictEqual(recovered.simulationRevision, third.revision + 1);
    assert.strictEqual(recovered.simulationLeaseId, null);
    assert.strictEqual(recovered.simulationLeaseUntil, 0);
    assert.strictEqual(BotLifeState.cachedState(characterId).simulation.ownerId, Owner.LEGACY_OWNER_ID, 'recovery must return cached ownership to main');
    assert.strictEqual(BotLifeState.cachedState(characterId).simulation.revision, recovered.simulationRevision, 'recovery must reflect its revision in cache');

    await Database.execute([
        `UPDATE bot_life_state
         SET activity = 'resting', phase = 'cold', adena = 100,
             inventorySummary = ?, statsJson = '{}'
         WHERE characterId = ?`,
        [JSON.stringify({ 57: { selfId: 57, name: 'Adena', amount: 100 } }), characterId]
    ]);
    await Database.execute(['DELETE FROM items WHERE characterId = ? AND selfId = 57', [characterId]]);
    await Database.execute([
        "INSERT INTO items (selfId, name, amount, equipped, slot, characterId) VALUES (57, 'Adena', 100, 0, 0, ?)",
        [characterId]
    ]);
    const storedGear = [];
    for (const enchant of [3, 2, 0]) {
        const inserted = await Database.execute([
            "INSERT INTO warehouse_items (selfId, name, amount, enchant, characterId) VALUES (94, 'Bec de Corbin', 1, ?, ?)",
            [enchant, characterId]
        ]);
        storedGear.push({ id: Number(inserted.insertId), selfId: 94, amount: 1, enchant, npcPrice: 50 });
    }
    const compacted = await Database.liquidateWarehouseGear(characterId, [storedGear[2]], { source: 'test_cleanup' });
    assert.strictEqual(compacted.ok, true, 'legacy-main cold owners may compact a selected warehouse object atomically');
    assert.strictEqual(compacted.rowsRemoved, 1);
    assert.strictEqual(compacted.units, 1);
    assert.strictEqual(compacted.payout, 50);
    assert.strictEqual(Number(compacted.state.adena), 150);
    assert.strictEqual(JSON.parse(compacted.state.inventorySummary)['57'].amount, 150);
    assert.strictEqual(JSON.parse(compacted.state.statsJson).lastWarehouseCompaction.source, 'test_cleanup');
    assert.deepStrictEqual((await Database.fetchWarehouseItems(characterId))
        .filter((item) => Number(item.selfId) === 94)
        .map((item) => Number(item.enchant)).sort((a, b) => b - a), [3, 2],
    'the explicit low-enchant surplus row must be removed while the two keepers survive');
    assert.strictEqual(Number((await Database.fetchItems(characterId)).find((item) => Number(item.selfId) === 57).amount), 150,
        'physical Adena must commit in the same transaction as warehouse removal and life-state payout');
    await assert.rejects(
        Database.liquidateWarehouseGear(characterId, [{ ...storedGear[0], enchant: 99 }], { source: 'stale_test' }),
        /warehouse gear changed/,
        'a stale object snapshot must roll the whole cleanup transaction back'
    );
    assert.strictEqual(Number((await Database.fetchItems(characterId)).find((item) => Number(item.selfId) === 57).amount), 150,
        'failed cleanup must not credit Adena');
    assert((await Database.fetchWarehouseItems(characterId)).some((item) => Number(item.id) === storedGear[0].id),
        'failed cleanup must not remove the selected warehouse object');

    const warehouseClaim = await Owner.claim({
        ...resting,
        simulation: { ownerId: Owner.LEGACY_OWNER_ID, revision: recovered.simulationRevision, leaseId: null, leaseUntil: 0 }
    }, { timestamp: 6000, leaseMs: 5000, leaseId: 'lease-warehouse' });
    assert.strictEqual(warehouseClaim.ok, true, 'passive stored items must not starve the owner-capable lifecycle partition');
    const leasedCleanup = await Database.liquidateWarehouseGear(characterId, [storedGear[0]], { source: 'must_not_run' });
    assert.strictEqual(leasedCleanup.reason, 'owner_changed', 'warehouse cleanup must defer while the cold worker owns the lifecycle row');
    const warehouseReleased = await Owner.release(warehouseClaim, { timestamp: 6100 });
    assert.strictEqual(warehouseReleased.ok, true);

    await Database.execute([
        'UPDATE bot_life_state SET statsJson = ? WHERE characterId = ?',
        [JSON.stringify({ warehouseWorkflow: { kind: 'release' } }), characterId]
    ]);
    const activeWarehouseClaim = await Database.claimColdSimulationLease({
        characterId,
        expectedRevision: warehouseReleased.revision,
        ownerId: Owner.OWNER_ID,
        leaseId: 'lease-active-warehouse',
        timestamp: 6200,
        leaseUntil: 11200
    });
    assert.strictEqual(activeWarehouseClaim.reason, 'warehouse_state', 'an active warehouse workflow must remain legacy-main');

    const dbStats = Database.stats();
    assert.strictEqual(path.resolve(dbStats.path), path.resolve(databasePath), 'all owner operations must use the one configured SQLite gateway');
    console.log('Cold simulation owner claim, CAS, handoff, and recovery checks passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => Database.close());
