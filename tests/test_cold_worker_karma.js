const assert = require('assert');
const fs = require('fs');
const path = require('path');

require('../src/Global');

const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const { ColdSimulationCoordinator } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');
const databasePath = path.join(process.cwd(), 'tmp', 'test-cold-worker-karma.sqlite');

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
    await Database.updateCharacterExperience(characterId, 20, 1000, 100);
    await Database.updateCharacterPvpPkKarma(characterId, 0, 1, 45);
    invoke('GameServer/Bot/Population/SpotProfiles').cache = [{
        id: '-15_37', name: 'Washing Field', minLevel: 15, maxLevel: 25, avgLevel: 20,
        density: 10, center: { locX: -90000, locY: 222000, locZ: -3500 },
        tags: [], tagsAuthoritative: true, npcSelfIds: [], npcEntries: [], arrivalPoints: [],
        rewards: { exp: 1000, sp: 10, adenaMin: 1, adenaMax: 2 }, mob: { hp: 100, damage: 1, hitDelayMs: 1600 }
    }];
    const dueAt = Date.now() - 60000;
    await Database.execute([
        `INSERT INTO bot_life_state (
            characterId, accountName, characterName, level, exp, sp, adena,
            homeRegion, currentRegion, spotId, activity, phase,
            activityStartedAt, nextResolveAt, lastResolvedAt,
            locX, locY, locZ, hp, maxHp, mp, maxMp,
            statsJson, inventorySummary, updatedAt
        ) VALUES (?, 'worker_probe', 'WorkerProbe', 20, 1000, 100, 500,
            'Talking Island', 'Talking Island', NULL, 'traveling', 'cold',
            ?, ?, ?, -84191, 244577, -3729, 20, 300, 20, 120, ?, '{}', ?)`,
        [characterId, dueAt - 60000, dueAt, dueAt - 60000, JSON.stringify({ travel: { to: { locX: 82698, locY: 148638, locZ: -3473 }, arrivalAt: dueAt, arrivalActivity: 'shopping', method: 'soe_gatekeeper' } }), dueAt]
    ]);
    assert.strictEqual(await LifeState.init(), true);
    const initial = LifeState.cachedState(characterId);
    assert.strictEqual(initial.stats.karma, 45, 'startup must restore authoritative karma into cold state');
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
    assert.strictEqual(persistedStats.karma, 45, 'travel must not wash karma without XP');
    assert.strictEqual(persistedStats.equipmentPlan, null, 'town purchases must yield to karma washing');
    assert.strictEqual(row.activity, 'traveling');
    assert.strictEqual(persistedStats.travel.reason, 'karma_washing');
    assert.strictEqual(persistedStats.travel.method, 'walk');
    assert.strictEqual(persistedStats.travel.arrivalActivity, 'hunting');
    assert.strictEqual(persistedStats.travel.spotId, '-15_37');
    assert(persistedStats.travel.arrivalAt > Date.now());

    const stopped = await coordinator.stop();
    assert.strictEqual(stopped.stopped, true);
    assert.strictEqual(stopped.queue.drained, true, 'shutdown must drain the commit queue');
    const resolved = await LifeState.applyResolve(LifeState.cachedState(characterId), {
        patch: { activity: 'hunting', stats: { travel: null } },
        materialize: { exp: 260, sp: 0, adena: 0, items: [] }, events: [],
        nextResolveAt: Date.now() + 60000, debug: { fights: 1, wins: 1 }
    });
    assert.strictEqual(resolved.stats.karma, 44, 'cold state must expose washed karma to future planning');
    const [washed] = await Database.execute(['SELECT karma, pk, exp FROM characters WHERE id = ?', [characterId]]);
    assert.strictEqual(washed.karma, 44, 'legacy cold resolve must also persist karma washing');
    assert.strictEqual(washed.pk, 1);
    await Database.updateColdCharacterExperience(characterId, resolved.level, washed.exp, resolved.sp);
    const [repeated] = await Database.execute(['SELECT karma FROM characters WHERE id = ?', [characterId]]);
    assert.strictEqual(repeated.karma, 44, 'unchanged physical XP must not wash karma twice');
    console.log('Cold worker karma route and startup recovery integration checks passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => Database.close());
