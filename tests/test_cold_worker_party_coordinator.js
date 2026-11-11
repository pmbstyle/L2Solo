process.env.BOT_DEVELOPER_DIAGNOSTICS = 'true'; // This fixture inspects optional resolved/compaction counters.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

require('../src/Global');

const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const PartyState = invoke('GameServer/Bot/Population/BackgroundPartyState');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const Metrics = invoke('GameServer/Bot/Population/PopulationMetrics');
const { ColdSimulationCoordinator } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');
const databasePath = path.join(process.cwd(), 'tmp', 'test-cold-worker-party-coordinator.sqlite');
const originalEnqueueEquipmentGoalAdvanceForState = LifeState.enqueueEquipmentGoalAdvanceForState;

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
            ?, ?, ?, ?, ?, ?, 300, 300, 120, 120, 'worker-party', ?, ?, ?)`,
        [Number(character.id), accountName, name, Math.max(8, Number(spot.minLevel || 8)),
            spot.region || spot.name, spot.region || spot.name, spot.id,
            dueAt - 60000, dueAt, dueAt - 60000,
            spot.center.locX, spot.center.locY, spot.center.locZ,
            JSON.stringify({ classId: 0, role: index === 1 ? 'tank' : 'dps', transportFixture: 'x'.repeat(140000) }),
            // This fixture exercises combat transport, not an unarmed bot's
            // legitimate departure to buy its first usable weapon.
            JSON.stringify({ 1: { selfId: 1, amount: 1, equipped: true, equippedCount: 1, equippedSlots: [7], slot: 7 } }), dueAt]
    ]);
    // The physical row the summary names: a commit whose step does not move
    // the bag leaves the items table as it is, and a main write that rebuilds
    // the summary from it (cold training) must find the weapon there.
    await Database.execute([
        `INSERT INTO items (selfId, name, amount, enchant, equipped, slot, characterId) VALUES (1, 'Short Sword', 1, 0, 1, 7, ?)`,
        [Number(character.id)]
    ]);
    return Number(character.id);
}

async function createRequiredMember(index, spot, timestamp) {
    const accountName = `worker_required_${index}`;
    const name = `WorkerRequired${index}`;
    await Database.createAccount(accountName, 'secret');
    await Database.createCharacter(accountName, {
        name, race: 0, classId: 0, maxHp: 300, maxMp: 120,
        sex: 0, face: 0, hair: 0, hairColor: 0,
        locX: spot.center.locX, locY: spot.center.locY, locZ: spot.center.locZ
    });
    const character = (await Database.fetchCharacters(accountName))[0];
    const stats = {
        classId: 0,
        role: index === 1 ? 'tank' : 'dps',
        partyRequest: {
            status: 'open', priority: 'required', requestedAt: timestamp - 60000,
            spotId: spot.id, npcId: 1
        }
    };
    await Database.execute([
        `INSERT INTO bot_life_state (
            characterId, accountName, characterName, level, exp, sp, adena,
            homeRegion, currentRegion, spotId, activity, phase,
            activityStartedAt, nextResolveAt, lastResolvedAt,
            locX, locY, locZ, hp, maxHp, mp, maxMp, partyId,
            statsJson, inventorySummary, updatedAt
        ) VALUES (?, ?, ?, ?, 1000, 100, 500, ?, ?, ?, 'party_wait', 'cold',
            ?, ?, ?, ?, ?, ?, 300, 300, 120, 120, NULL, ?, '{}', ?)`,
        [Number(character.id), accountName, name, Math.max(8, Number(spot.minLevel || 8)),
            spot.region || spot.name, spot.region || spot.name, spot.id,
            timestamp - 60000, timestamp + 600000, timestamp - 60000,
            spot.center.locX, spot.center.locY, spot.center.locZ,
            JSON.stringify(stats), timestamp]
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
    const requiredIds = [
        await createRequiredMember(1, spot, Date.now()),
        await createRequiredMember(2, spot, Date.now())
    ];
    await Database.execute([
        `INSERT INTO bot_background_parties (
            partyId, leaderId, memberIdsJson, spotId, startedAt, nextResolveAt,
            cohesion, risk, status, roleCoverageJson, statsJson, updatedAt
        ) VALUES ('worker-party', ?, ?, ?, ?, ?, 0.65, 0.25, 'active', '{}', '{}', ?)`,
        [memberIds[0], JSON.stringify(memberIds), spot.id, dueAt - 120000, dueAt, dueAt]
    ]);
    assert.strictEqual(await PartyState.init(), true);
    assert.strictEqual(await LifeState.init(), true);
    // Progress is read against the rows the boot loaded: the boot shift moved
    // the fixture's timers by the pause since their last write.
    const loadedResolvedAt = new Map(memberIds.map(id => [id, Number(LifeState.cachedState(id).timing.lastResolvedAt)]));
    const loadedPartyDue = Number(PartyState.find('worker-party').nextResolveAt);
    const advanced = row => Number(row.lastResolvedAt) > loadedResolvedAt.get(Number(row.characterId));

    coordinator = new ColdSimulationCoordinator();
    let mainCommands = 0;
    const partyResolvesBefore = Number(Metrics.counters.partyResolves || 0);
    const combatActionsBefore = Number(Metrics.counters.combatActions || 0);
    LifeState.enqueueEquipmentGoalAdvanceForState = async () => {
        throw new Error('synthetic equipment goal wakeup failure');
    };
    await coordinator.start({
        executeWorkerLifecycleCommand() { mainCommands += 1; }
    });

    const deadline = Date.now() + 25000;
    let rows = [];
    while (Date.now() < deadline) {
        rows = await Database.execute([
            `SELECT characterId, exp, lastResolvedAt, simulationRevision
             FROM bot_life_state WHERE partyId = 'worker-party' ORDER BY characterId`, []
        ]);
        if (rows.length === 2 && rows.every((row) => Number(row.simulationRevision) >= 2 && advanced(row))) break;
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
    const goalMembers = await LifeState.statesByIds(requiredIds, { unassigned: true });
    const goalParty = { partyId: 'worker-first-goal', memberIds: goalMembers.map(member => member.characterId),
        leaderId: goalMembers[0].characterId, stats: { objective: { sourceKind: 'raid', spotId: spot.id } } };
    const goalResult = await coordinator.requestPartyGoals(goalParty, goalMembers);
    assert.equal(goalResult.ok, true, goalResult.reason);
    assert.deepStrictEqual(goalResult.joint.objective, goalParty.stats.objective, 'native worker keeps protected raid goal');
    assert.equal(goalResult.joint.memberGoals.length, goalMembers.length);
    assert.deepStrictEqual(goalResult.sources,
        require('../src/GameServer/Bot/Population/PartyGoalCalculation').sources(goalMembers));
    assert.equal(coordinator.partyGoalRequests, 0, 'native response releases the admission slot');
    const largeMembers = await LifeState.statesForParty('worker-party');
    assert(require('../src/GameServer/Bot/Population/ColdSimulationProtocol').byteLength({ members: largeMembers }) > 256 * 1024,
        'fixture requires multiple complete-input pages');
    const largeGoals = await coordinator.requestPartyGoals(PartyState.find('worker-party'), largeMembers);
    assert.equal(largeGoals.ok, true, largeGoals.reason);
    assert.equal(largeGoals.joint.memberGoals.length, 2, 'oversize roster is computed without truncation');
    assert.strictEqual(mainCommands, 0, 'party combat must never execute on the main lifecycle command bridge');
    assert(Number(snapshot.worker.resolved || 0) >= 2, 'worker must resolve every claimed party member');
    assert(Number(snapshot.queue.committed || 0) >= 2, 'main DB gateway must commit every party member');
    assert(Number(snapshot.worker.proposalCompactions || 0) >= 2, 'the real worker must compact a party exceeding one IPC message');
    const preserved = await Database.execute([`SELECT statsJson FROM bot_life_state WHERE partyId = 'worker-party'`, []]);
    assert(preserved.every(row => JSON.parse(row.statsJson).transportFixture.length === 140000),
        'sparse transport must preserve unchanged durable state for every party member');
    assert(rows.every(advanced));
    assert(Number(partyRow.nextResolveAt) > loadedPartyDue, 'leader commit must durably advance the party schedule');
    assert(Number(JSON.parse(partyRow.statsJson).fightsResolved || 0) >= 1);
    const memories = (await Database.loadInteractionMemories(memberIds)).map(snapshot => ({ ownerId: snapshot.ownerId, snapshotJson: JSON.stringify(snapshot) }));
    assert.strictEqual(memories.length, 2, 'real worker wins must commit mutual hunt memory');
    memories.forEach(row => {
        const memory = JSON.parse(row.snapshotJson);
        assert.strictEqual(memory.revision, 1);
        assert.strictEqual(memory.relations.length, 1);
        assert.strictEqual(memory.relations[0].trust, 1);
        assert.strictEqual(memory.relations[0].reasons[0].type, 'hunted_together');
    });
    assert(Number(Metrics.counters.partyResolves || 0) > partyResolvesBefore,
        'worker party commit must feed the public party resolve metric');
    assert(Number(Metrics.counters.combatActions || 0) > combatActionsBefore,
        'actual worker transport and commit must preserve the shared party combat counters');

    await coordinator.stop();
    const cachedState = LifeState.cachedState;
    const claimed = { characterId: 99, simulation: { revision: 4 }, stats: { keep: 1 } };
    LifeState.cachedState = () => claimed;
    try {
        const delta = require('../src/GameServer/Bot/Population/ColdStateDelta').create(claimed, { ...claimed, hp: 25 });
        assert.strictEqual(await coordinator.prepareProposal({ characterId: 99, revision: 3, nextStateDelta: delta }), null,
            'a sparse result must never be applied to a newer revision');
    } finally { LifeState.cachedState = cachedState; }
    console.log('Cold worker party compute and durable batch-CAS integration checks passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(async () => {
    LifeState.enqueueEquipmentGoalAdvanceForState = originalEnqueueEquipmentGoalAdvanceForState;
    if (coordinator?.started) await coordinator.stop().catch(() => null);
    Database.close();
});
