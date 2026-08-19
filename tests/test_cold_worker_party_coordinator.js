const assert = require('assert');
const fs = require('fs');
const path = require('path');

require('../src/Global');

const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const PartyState = invoke('GameServer/Bot/Population/BackgroundPartyState');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const Metrics = invoke('GameServer/Bot/Population/PopulationMetrics');
const { ColdSimulationCoordinator } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');
const databasePath = path.join(process.cwd(), 'tmp', 'test-cold-worker-party-coordinator.sqlite');

fs.rmSync(databasePath, { force: true });
options.default.Database.path = path.relative(process.cwd(), databasePath);
Database.init();
DataCache.init();

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createMember(index, spot, dueAt) {
    const accountName = `worker_party_${index}`;
    const name = `WorkerParty${index}`;
    await Database.createAccount(accountName, 'secret');
    await Database.createCharacter(accountName, {
        name, race: 0, classId: 0, maxHp: 300, maxMp: 120,
        sex: 0, face: 0, hair: 0, hairColor: 0,
        locX: spot.center.locX, locY: spot.center.locY, locZ: spot.center.locZ
    });
    const character = (await Database.fetchCharacters(accountName))[0];
    await Database.execute([
        `INSERT INTO bot_life_state (
            characterId, accountName, characterName, level, exp, sp, adena,
            homeRegion, currentRegion, spotId, activity, phase,
            activityStartedAt, nextResolveAt, lastResolvedAt,
            locX, locY, locZ, hp, maxHp, mp, maxMp, partyId,
            statsJson, inventorySummary, updatedAt
        ) VALUES (?, ?, ?, ?, 1000, 100, 500, ?, ?, ?, 'hunting', 'cold',
            ?, ?, ?, ?, ?, ?, 300, 300, 120, 120, 'worker-party', ?, '{}', ?)`,
        [Number(character.id), accountName, name, Math.max(8, Number(spot.minLevel || 8)),
            spot.region || spot.name, spot.region || spot.name, spot.id,
            dueAt - 60000, dueAt, dueAt - 60000,
            spot.center.locX, spot.center.locY, spot.center.locZ,
            JSON.stringify({ classId: 0, role: index === 1 ? 'tank' : 'dps' }), dueAt]
    ]);
    return Number(character.id);
}

let coordinator = null;
(async () => {
    const spot = {
        id: 'worker-party-spot', name: 'Worker Party Spot', region: 'Talking Island',
        center: { locX: -84191, locY: 244577, locZ: -3729 },
        minLevel: 1, maxLevel: 30, avgLevel: 15, density: 1,
        npcSelfIds: [1], rewards: { exp: 10, sp: 2, adenaMin: 1, adenaMax: 1 },
        mob: { hp: 100, damage: 1 }
    };
    SpotProfiles.ensure = () => [spot];
    const dueAt = Date.now() - 60000;
    const memberIds = [await createMember(1, spot, dueAt), await createMember(2, spot, dueAt)];
    await Database.execute([
        `INSERT INTO bot_background_parties (
            partyId, leaderId, memberIdsJson, spotId, startedAt, nextResolveAt,
            cohesion, risk, status, roleCoverageJson, statsJson, updatedAt
        ) VALUES ('worker-party', ?, ?, ?, ?, ?, 0.65, 0.25, 'active', '{}', '{}', ?)`,
        [memberIds[0], JSON.stringify(memberIds), spot.id, dueAt - 120000, dueAt, dueAt]
    ]);
    assert.strictEqual(await PartyState.init(), true);
    assert.strictEqual(await LifeState.init(), true);

    coordinator = new ColdSimulationCoordinator();
    let mainCommands = 0;
    let partyGoalReconciles = 0;
    const partyResolvesBefore = Number(Metrics.counters.partyResolves || 0);
    await coordinator.start({
        executeWorkerLifecycleCommand() { mainCommands += 1; },
        reconcileWorkerPartyGoals(party) {
            partyGoalReconciles += 1;
            assert.strictEqual(party.partyId, 'worker-party');
            return Promise.resolve({ party, reviewed: 0, departed: null });
        }
    });

    const deadline = Date.now() + 25000;
    let rows = [];
    while (Date.now() < deadline) {
        rows = await Database.execute([
            `SELECT characterId, exp, lastResolvedAt, simulationOwner, simulationRevision,
                    simulationLeaseId, simulationLeaseUntil
             FROM bot_life_state WHERE partyId = 'worker-party' ORDER BY characterId`, []
        ]);
        if (rows.length === 2 && rows.every((row) => Number(row.simulationRevision) >= 2 && Number(row.lastResolvedAt) > dueAt)) break;
        await wait(100);
    }
    const [partyRow] = await Database.execute([
        `SELECT nextResolveAt, statsJson FROM bot_background_parties WHERE partyId = 'worker-party'`, []
    ]);
    let snapshot = coordinator.snapshot();
    while (Date.now() < deadline && Number(snapshot.worker.resolved || 0) < 2) {
        await wait(50);
        snapshot = coordinator.snapshot();
    }
    assert.strictEqual(mainCommands, 0, 'party combat must never execute on the main lifecycle command bridge');
    assert(Number(snapshot.worker.resolved || 0) >= 2, 'worker must resolve every claimed party member');
    assert(Number(snapshot.queue.committed || 0) >= 2, 'main DB gateway must commit every party member');
    assert(rows.every((row) => Number(row.lastResolvedAt) > dueAt));
    assert(rows.every((row) => row.simulationOwner === Owner.LEGACY_OWNER_ID
        && row.simulationLeaseId === null && Number(row.simulationLeaseUntil) === 0));
    assert(Number(partyRow.nextResolveAt) > dueAt, 'leader commit must durably advance the party schedule');
    assert(Number(JSON.parse(partyRow.statsJson).fightsResolved || 0) >= 1);
    assert(Number(Metrics.counters.partyResolves || 0) > partyResolvesBefore,
        'worker party commit must feed the public party resolve metric');
    assert.strictEqual(partyGoalReconciles, 1,
        'one committed worker party combat result must reconcile party goals exactly once through the leader');

    await coordinator.stop();
    console.log('Cold worker party compute and durable batch-CAS integration checks passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(async () => {
    if (coordinator?.started) await coordinator.stop().catch(() => null);
    Database.close();
});
