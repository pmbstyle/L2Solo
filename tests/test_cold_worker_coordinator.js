const assert = require('assert');
const fs = require('fs');
const path = require('path');

require('../src/Global');

const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const { ColdSimulationCoordinator } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');
const databasePath = path.join(process.cwd(), 'tmp', 'test-cold-worker-coordinator.sqlite');

fs.rmSync(databasePath, { force: true });
options.default.Database.path = path.relative(process.cwd(), databasePath);
Database.init();
DataCache.init();

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

(async () => {
    await Database.createAccount('worker_probe', 'secret');
    await Database.createCharacter('worker_probe', {
        name: 'WorkerProbe', race: 0, classId: 0, maxHp: 300, maxMp: 120,
        sex: 0, face: 0, hair: 0, hairColor: 0, locX: -84191, locY: 244577, locZ: -3729
    });
    const character = (await Database.fetchCharacters('worker_probe'))[0];
    const characterId = Number(character.id);
    const dueAt = Date.now() - 60000;
    await Database.execute([
        `INSERT INTO bot_life_state (
            characterId, accountName, characterName, level, exp, sp, adena,
            homeRegion, currentRegion, spotId, activity, phase,
            activityStartedAt, nextResolveAt, lastResolvedAt,
            locX, locY, locZ, hp, maxHp, mp, maxMp,
            statsJson, inventorySummary, updatedAt
        ) VALUES (?, 'worker_probe', 'WorkerProbe', 20, 1000, 100, 500,
            'Talking Island', 'Talking Island', NULL, 'resting', 'cold',
            ?, ?, ?, -84191, 244577, -3729, 20, 300, 20, 120, ?, '{}', ?)`,
        [characterId, dueAt - 60000, dueAt, dueAt - 60000, JSON.stringify({ restUntil: dueAt - 1 }), dueAt]
    ]);
    assert.strictEqual(await LifeState.init(), true);
    const initial = LifeState.cachedState(characterId);
    assert(initial, 'startup hydration must expose the copied cold row to the coordinator');
    assert.strictEqual(initial.simulation.ownerId, Owner.LEGACY_OWNER_ID);

    const coordinator = new ColdSimulationCoordinator();
    await coordinator.start({
        executeWorkerLifecycleCommand() {
            throw new Error('main_resolver_must_not_run_for_simple_lifecycle');
        },
        resolveBackgroundParty() {
            throw new Error('party_resolver_must_not_run_for_simple_lifecycle');
        }
    });

    const deadline = Date.now() + 25000;
    let row = null;
    while (Date.now() < deadline) {
        [row] = await Database.execute([
            `SELECT activity, lastResolvedAt, nextResolveAt, simulationOwner,
                    simulationRevision, simulationLeaseId, simulationLeaseUntil, statsJson
             FROM bot_life_state WHERE characterId = ?`, [characterId]
        ]);
        if (Number(row?.simulationRevision || 0) >= 2 && Number(row?.lastResolvedAt || 0) > dueAt) break;
        await wait(100);
    }
    let snapshot = coordinator.snapshot();
    const heartbeatDeadline = Date.now() + 2000;
    while (Number(snapshot.worker.resolved || 0) < 1 && Date.now() < heartbeatDeadline) {
        await wait(50);
        snapshot = coordinator.snapshot();
    }
    assert(snapshot.ready && snapshot.snapshotsLoaded, 'real worker must complete bootstrap and snapshot loading');
    assert(Number(snapshot.worker.resolved || 0) >= 1, 'worker thread must perform the resolve');
    assert(Number(snapshot.queue.committed || 0) >= 1, 'main gateway must durably commit worker progress');
    assert(Number(row.simulationRevision) >= 2, 'claim plus commit/release must advance revision twice');
    assert(Number(row.lastResolvedAt) > dueAt, 'authoritative DB progress must advance lastResolvedAt');
    assert.strictEqual(row.simulationOwner, Owner.LEGACY_OWNER_ID);
    assert.strictEqual(row.simulationLeaseId, null);
    assert.strictEqual(Number(row.simulationLeaseUntil), 0, 'successful commit must not leak a lease');
    const persistedStats = JSON.parse(row.statsJson || '{}');
    const equipmentPlan = persistedStats.equipmentPlan;
    const plannedItem = DataCache.items.find((item) => Number(item.selfId) === Number(equipmentPlan?.target?.selfId));
    assert.strictEqual(equipmentPlan?.strategy, 'market',
        'the real cold worker must replace an empty D-grade loadout with an NPC purchase plan');
    assert.strictEqual(equipmentPlan?.market?.sourceType, 'npc');
    assert.strictEqual(String(plannedItem?.etc?.rank), 'd');
    assert.notStrictEqual(equipmentPlan?.market?.town, 'Talking Island',
        'the worker must send a Talking Island D-grade bot to a city that sells its planned item');

    const stopped = await coordinator.stop();
    assert.strictEqual(stopped.stopped, true);
    assert.strictEqual(stopped.queue.drained, true, 'shutdown must drain the commit queue');
    console.log('Cold worker coordinator durable-progress integration checks passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => Database.close());
