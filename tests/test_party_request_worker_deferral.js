'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
const world = require('./fixtures/native_stock_world')();
require('../src/Global');
const DB = invoke('Database'), Life = invoke('GameServer/Bot/Population/BotLifeState');
const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const Request = require('../src/GameServer/Bot/Population/PartyRequestPlanner');
const { ColdSimulationKernel } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
const at = Date.now(), snapshots = [], originalDirty = Coordinator.markDirty;
const kernel = new ColdSimulationKernel({ now: () => at, resolveSolo: () => { throw Error('no combat in this fixture'); } });
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
let sequence = 0;
async function seed(age = 0, extra = {}) {
    const username = `bot_deferral_${++sequence}`;
    await DB.createAccount(username, 'fixture');
    const id = Number((await DB.createCharacter(username, { name: `Deferred${sequence}`, classId: 14,
        race: 0, sex: 0, face: 0, hair: 0, hairColor: 0, maxHp: 100, maxMp: 100,
        locX: 0, locY: 0, locZ: 0 })).insertId);
    await DB.execute(['UPDATE characters SET level=57,hp=100,mp=100 WHERE id=?', [id]]);
    const state = await Life.upsertState({ characterId: id, name: `Deferred${sequence}`, accountName: username,
        phase: 'cold', activity: 'party_wait', level: 57, spotId: 'old-source', loc: { locX: 0, locY: 0, locZ: 0 },
        inventory: {}, vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 }, timing: {}, stats: { classId: 14,
            equipmentPlan: { status: 'active', target: { selfId: 148, slot: 7 } },
            partyRequest: { materialParty: true, status: 'open', priority: 'required', reason: 'craft_material',
                itemId: 4108, targetId: 148, requiredTotal: 12, amount: 12, spotId: 'old-source',
                objectiveKey: 'craft-material:old-source', npcId: 620, attempts: 2, requestedAt: at - age, ...extra } } }, 'deferral_fixture');
    await flush();
    kernel.upsert({ state });
    return state;
}
async function rowFor(id) { return (await DB.execute(['SELECT * FROM bot_life_state WHERE characterId=?', [id]]))[0]; }
async function checkDeferred(old, reason) {
    await flush();
    const row = await rowFor(old.characterId), cached = Life.cachedState(old.characterId);
    const request = JSON.parse(row.statsJson).partyRequest;
    assert.equal(request.status, 'closed', 'forming\'s no closes the request: no cooldown clock');
    assert.equal(request.attempts, 3, 'forming\'s no counts one attempt');
    assert.equal(request.deferredUntil, undefined);
    assert.equal(cached.simulation.revision, old.simulation.revision + 1, 'native closing moves the revision');
    assert.equal(row.simulationRevision, cached.simulation.revision);
    assert.deepEqual(cached.stats.partyRequest, request, 'cache accepts the exact committed request');
    assert(snapshots.some(packet => packet.state === cached && packet.options.critical && packet.options.reason === 'party_request_deferred'),
        'the worker receives a critical snapshot, without waiting for a population refresh');
    const workerState = kernel.states.get(old.characterId).state;
    assert.deepEqual(workerState.stats.partyRequest, request);
    const Material = require('../src/GameServer/Bot/Population/CraftMaterialParty'), originalRequest = Material.request;
    Material.request = () => ({ ...request, status: 'open', spotId: 'rotated-source', objectiveKey: 'craft-material:rotated-source' });
    try {
        const planned = Request.partyRequestForPlan(workerState, workerState.stats.equipmentPlan, at + 2,
            { economy: { worth: () => 0 } });
        // The closed request is held until the bot's next build, which asks again.
        assert.equal(planned.status, 'open', 'the next build asks again');
        assert.equal(planned.attempts, request.attempts, 'a reopened request keeps its attempts');
    } finally { Material.request = originalRequest; }
    const [stale] = await Owner.commitBatch([{ revision: old.simulation.revision, nextState: old, options: { allowLifecycle: true } }]);
    assert.equal(stale.ok, false);
    assert.equal(stale.reason, 'stale_revision', 'a step begun before the deferral is refused');
    if (reason) assert.equal(request.lastReason, reason);
    return cached;
}
async function main() {
    DB.init(); invoke('GameServer/DataCache').init(); await Life.init();
    Coordinator.markDirty = (state, options) => { snapshots.push({ state, options }); kernel.upsert({ state }); };
    const incompatible = await seed();
    snapshots.length = 0;
    assert.equal(await Life.deferUnformablePartyRequests([incompatible.characterId]), 1);
    await checkDeferred(incompatible, 'no_compatible_level_match');
    assert.equal(await Life.deferUnformablePartyRequests([incompatible.characterId]), 0, 'one rejection increments attempts exactly once');
    // Forming's no closes a preferred request too: it is not judged again on every move.
    const preferred = await seed(0, { priority: 'preferred' });
    assert.equal(await Life.deferUnformablePartyRequests([preferred.characterId], 'forming_refused'), 1);
    await checkDeferred(preferred, 'forming_refused');

    // Native data can change after the preliminary pending-write lookup. Only
    // RETURNING may supply the cache/worker publication, never that old SELECT.
    const raced = await seed(), originalExecute = DB.execute;
    let injected = false;
    DB.execute = async (statement, ...args) => {
        const rows = await originalExecute.call(DB, statement, ...args);
        if (!injected && statement[0].startsWith('SELECT characterId FROM bot_life_state') && statement[1].includes(raced.characterId)) {
            injected = true;
            await originalExecute.call(DB, ["UPDATE bot_life_state SET statsJson=json_set(statsJson, '$.partyRequest.attempts', 7, '$.partyRequest.spotId', 'new-source', '$.nativeMarker', 123) WHERE characterId=?", [raced.characterId]]);
        }
        return rows;
    };
    try { assert.equal(await Life.deferUnformablePartyRequests([raced.characterId]), 1); }
    finally { DB.execute = originalExecute; }
    await flush();
    const fresh = Life.cachedState(raced.characterId);
    assert.equal(fresh.stats.partyRequest.attempts, 8);
    assert.equal(fresh.stats.partyRequest.spotId, 'new-source');
    assert.equal(fresh.stats.nativeMarker, 123);
    assert.deepEqual(kernel.states.get(raced.characterId).state.stats.partyRequest, fresh.stats.partyRequest);
    console.log('PASS native request closing publishes exact critical worker snapshots, advances revision and refuses stale steps; concurrent native edits survive');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    Coordinator.markDirty = originalDirty;
    await world.close();
});
