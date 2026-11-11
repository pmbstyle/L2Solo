'use strict';
const assert = require('node:assert/strict');
const world = require('./fixtures/native_stock_world')();
require('../src/Global');
const DB = invoke('Database'), Life = invoke('GameServer/Bot/Population/BotLifeState');
const Requests = require('../src/GameServer/Bot/Population/PartyRequestPlanner');
const Duty = require('../src/GameServer/Bot/Population/ClanPartyDuty');
const { lifecycleKind } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
const at = Date.now();
const goalKey = 'fixture:clan:equipment';
const requestFor = (clanId, status = 'open') => ({ status, priority: 'required', clanId, clanGoalKey: goalKey,
    clanOperation: 'equipment', objectiveKey: goalKey, spotId: 'clan-source', itemId: 91,
    requestedAt: at - 60 * 60000, attempts: 4 });
const statsFor = request => ({ classId: 1, generatedCold: true, eventWait: 'clan_party_assembly',
    partyRequest: request, clanPartyObjective: { ...request, status: 'open' },
    equipmentPlan: { status: 'active', strategy: 'direct_drop', target: { selfId: 91, slot: 7 },
        next: { spotId: 'clan-source', itemId: 91 }, clanGoal: { clanId: request.clanId, goalKey } } });

// A clan member whose clan party never formed: its request closes, the worker
// releases it to its own hunt without the clan's route, and it keeps the closed
// request until its next build asks again.
async function assertReleased(state) {
    assert(Requests.closed(state));
    assert.equal(Duty.waiting(state), false, 'a closed call holds no wait');
    assert.equal(Duty.released(state), true);
    assert.equal(lifecycleKind(state), 'resolver', 'the worker steps it, no command for main');
    const result = Duty.release(state, at);
    assert.equal(result.patch.activity, 'hunting');
    assert.equal(result.patch.stats.partyRequest.status, 'closed', 'its closed request stays until its next build');
    assert.equal(result.patch.stats.clanPartyObjective.status, 'open', 'the clan keeps its call');
    // The row as main writes it: the patch's stats merge over the row's, so the clan's plan stays.
    const released = await Life.prepareResolve(state, result,
        { timestamp: at, persist: false, projectClassProgression: true });
    assert.equal(released.activity, 'hunting');
    assert(released.stats.equipmentPlan, 'the plan is the clan\'s: a release does not drop it');
    assert.equal(Duty.released(released), false, 'released once: the next step sends no second release');
    assert.equal(Requests.partyObjectiveForState(released), null, 'it anchors no roster while closed');
    assert.equal(Requests.partyRequestForPlan({ ...released, activity: 'traveling' }, null, at), released.stats.partyRequest,
        'a bot that cannot ask keeps the closed request');
    assert.equal(Requests.partyRequestForPlan(released, null, at, { economy: { worth: () => 0 } }).status, 'open',
        'its next build asks for the clan party again');
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
    for (const id of ids) {
        await DB.execute(['UPDATE bot_life_state SET statsJson=? WHERE characterId=?',
            [JSON.stringify(statsFor(requestFor(clan.clanId))), id]]);
    }
    await Life.init();
    for (const [index, id] of ids.entries()) {
        const state = await Life.reloadRow(id);
        if (index) await Life.upsertState({ ...state, activity: 'hunting' }, 'fixture_hunting');
        assert.equal(await Life.deferUnformablePartyRequests([id]), 1);
        await new Promise(resolve => setImmediate(resolve));
        const closed = Life.cachedState(id);
        assert.equal(closed.stats.partyRequest.attempts, 5, 'the failed forming counts one attempt');
        if (index) {
            assert.equal(Duty.released(closed), false, 'a hunting member with a closed request is not released');
            assert(closed.stats.equipmentPlan, 'its clan plan stays');
        } else await assertReleased(closed);
        assert.equal(await Life.deferUnformablePartyRequests([id]), 0, 'a closed request is not closed again');
    }
    const member = { ...Life.cachedState(ids[0]), party: { partyId: 'active-clan' } };
    assert.equal(Duty.released(member), false, 'a party member remains owned by its active group');
    console.log('PASS a closed clan duty is released to its own hunt without the clan route until its next build');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    await world.close();
});
