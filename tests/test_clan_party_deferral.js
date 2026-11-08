'use strict';
const assert = require('node:assert/strict');
const world = require('./fixtures/native_stock_world')();
require('../src/Global');
const DB = invoke('Database'), Life = invoke('GameServer/Bot/Population/BotLifeState');
const Requests = require('../src/GameServer/Bot/Population/PartyRequestPlanner');
const Duty = require('../src/GameServer/Bot/Population/ClanPartyDuty');
const Recovery = require('../src/GameServer/Bot/Population/PartyAssemblyRecovery');
const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const originalDirty = Coordinator.markDirty, snapshots = [], at = Date.now();
const goalKey = 'fixture:clan:equipment';
const requestFor = (clanId, status = 'open') => ({ status, priority: 'required', clanId, clanGoalKey: goalKey,
    clanOperation: 'equipment', objectiveKey: goalKey, spotId: 'clan-source', itemId: 91,
    requestedAt: at - 60 * 60000, attempts: 4, ...(status === 'deferred' ? { deferredUntil: at + 60000 } : {}) });
const statsFor = request => ({ classId: 1, generatedCold: true, eventWait: 'clan_party_assembly',
    partyRequest: request, clanPartyObjective: { ...request, status: 'open' },
    equipmentPlan: { status: 'active', strategy: 'direct_drop', target: { selfId: 91, slot: 7 },
        next: { spotId: 'clan-source', itemId: 91 }, clanGoal: { clanId: request.clanId, goalKey } } });

function assertSafe(state) {
    assert.equal(state.activity, 'hunting');
    assert.equal(state.stats.partyRequest.status, 'deferred');
    assert.equal(state.stats.clanPartyObjective.status, 'deferred');
    assert.equal(state.stats.clanPartyObjective.deferredUntil, state.stats.partyRequest.deferredUntil);
    assert.equal(state.stats.equipmentPlan, undefined, 'a released clan hold cannot retain its farm route');
    assert.equal(Duty.waiting(state), false);
    assert.equal(Recovery.coolingDown(state), true);
    assert.equal(Requests.partyObjectiveForState(state), null);
}

async function main() {
    DB.init(); invoke('GameServer/DataCache').init();
    const ids = [];
    for (let index = 0; index < 2; index++) {
        const username = `bot_clan_pause_${index}`;
        await DB.createAccount(username, 'fixture');
        const id = Number((await DB.createCharacter(username, { name: `ClanPause${index}`, classId: 1,
            race: 0, sex: 0, face: 0, hair: 0, hairColor: 0, maxHp: 100, maxMp: 100,
            locX: 0, locY: 0, locZ: 0 })).insertId);
        ids.push(id);
        await DB.execute(['UPDATE characters SET level=20 WHERE id=?', [id]]);
        await DB.execute([`INSERT INTO bot_life_state
            (characterId, accountName, characterName, level, phase, activity, hp, maxHp, mp, maxMp,
                inventorySummary, statsJson, updatedAt, nextResolveAt)
            VALUES (?, ?, ?, 20, 'cold', 'party_wait', 100, 100, 100, 100, '{}', '{"generatedCold":true}', ?, ?)`,
        [id, username, `ClanPause${index}`, at, at + 30000]]);
    }
    const goal = { type: 'equipment', status: 'executing', goalKey,
        target: { memberId: ids[0], itemId: 91, slot: 7 }, assignedMemberIds: ids };
    const clan = await DB.createAutonomousClan({ name: 'ClanPause', leaderId: ids[0], memberIds: ids,
        founderQuorum: 2, maxBotMemberShare: 1, stateJson: { level: 3, goal } });
    assert(clan.ok, JSON.stringify(clan));
    for (const [index, id] of ids.entries()) {
        await DB.execute(['UPDATE bot_life_state SET statsJson=? WHERE characterId=?',
            [JSON.stringify(statsFor(requestFor(clan.clanId, index ? 'deferred' : 'open'))), id]]);
    }
    await Life.init();
    for (const id of ids) assertSafe(await Life.findByCharacterId(id));
    assert.equal(Life.cachedState(ids[0]).stats.partyRequest.attempts, 5);
    assert.equal(Life.cachedState(ids[1]).stats.partyRequest.attempts, 4, 'legacy pause repair is not another failed assembly');
    assert.equal(Life.cachedState(ids[1]).stats.partyRequest.deferredUntil, at + 60000);

    Coordinator.markDirty = (state, options) => snapshots.push({ state, options });
    for (const [index, id] of ids.entries()) {
        const state = await Life.reloadRow(id);
        const opened = await Life.upsertState({ ...state, activity: index ? 'hunting' : 'party_wait',
            stats: { ...state.stats, ...statsFor({ ...requestFor(clan.clanId), requestedAt: Date.now() }) } }, 'fixture_reopen');
        assert(opened, 'fixture must reopen the current native revision');
        snapshots.length = 0;
        assert.equal(await Life.deferUnformablePartyRequests([id]), 1);
        await new Promise(resolve => setImmediate(resolve));
        const paused = Life.cachedState(id);
        assertSafe(paused);
        assert.equal(paused.simulation.revision, opened.simulation.revision + 1);
        assert(snapshots.some(packet => packet.state === paused && packet.options.critical));
        assert.equal(await Life.deferUnformablePartyRequests([id]), 0);
    }
    const legacy = { ...Life.cachedState(ids[0]), activity: 'party_wait', stats: statsFor(requestFor(clan.clanId, 'deferred')) };
    assertSafe(Requests.expireState(legacy));
    assert.equal(Requests.expireState({ ...legacy, party: { partyId: 'active-clan' } }).stats, legacy.stats,
        'a party member remains owned by its active group');
    console.log('PASS clan native/startup deferrals and legacy pauses atomically release holds without solo clan routes');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    Coordinator.markDirty = originalDirty;
    await world.close();
});
