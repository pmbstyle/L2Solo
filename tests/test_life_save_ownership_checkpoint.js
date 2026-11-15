'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('life-save-ownership');
require('../src/Global');
fixture.assertConfigured(options.default);
const Database = invoke('Database');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Protocol = invoke('GameServer/Bot/Population/ColdSimulationProtocol');
const Checkpoint = invoke('GameServer/Bot/Population/NativeWriteCheckpoint');
const Native = require('./helpers/nativeMarketFixture');
async function run() {
    invoke('GameServer/DataCache').init();
    await Database.init();
    const id = 9600321;
    await Native.character(Database, id, 'SaveOwnership', 'bot_save_ownership');
    await Life.init();
    const initial = await Life.upsertState({ characterId: id, accountName: 'bot_save_ownership', name: 'SaveOwnership',
        level: 1, phase: 'cold', activity: 'resting', loc: { locX: 83000, locY: 148000, locZ: -3400 },
        vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 }, timing: { nextResolveAt: Date.now() + 30000 },
        stats: { classId: 0 }, inventory: {} }, 'ownership_seed');
    // A durable ownership handoff advances the native row. A retained session
    // can still supply its original lifecycle snapshot to an ordinary save.
    const transition = await invoke('GameServer/Bot/Population/ColdSimulationOwner').handoffToMain(initial,
        { nextState: { ...initial, updatedAt: Date.now() }, allowLifecycle: true });
    assert.equal(transition.ok, true);
    assert.equal(transition.revision, 1);
    // A save over a far row moves its revision (Database MOVE_FAR_REVISION,
    // the worker's fence); each save publishes the row's own revision.
    const rowRevision = async () => Number((await Database.execute(['SELECT simulationRevision FROM bot_life_state WHERE characterId=?', [id]]))[0].simulationRevision);
    let saved = await Life.upsertState(initial, 'retained_session_save');
    assert(saved);
    const [row] = await Database.execute(['SELECT * FROM bot_life_state WHERE characterId=?', [id]]);
    assert(row.simulationRevision >= transition.revision, 'a save never moves the durable revision back');
    assert.equal(saved.simulation.revision, row.simulationRevision, 'publication must use the saved native revision');
    assert(Protocol.sameCommandCheckpoint(saved, { ...row, activityStartedAt: row.activityStartedAt || 0,
        nextResolveAt: row.nextResolveAt || 0, lastResolvedAt: row.lastResolvedAt || 0, lastHotAt: row.lastHotAt || 0 }));
    const actor = new Proxy({ fetchId: () => id, fetchName: () => 'SaveOwnership', fetchLevel: () => 1,
        fetchHp: () => 100, fetchMaxHp: () => 100, fetchMp: () => 100, fetchMaxMp: () => 100,
        fetchLocX: () => 83000, fetchLocY: () => 148000, fetchLocZ: () => -3400,
        backpack: { fetchItems: () => [], fetchItemFromSelfId: () => null } },
    { get: (target, key) => key in target ? target[key]
        : typeof key === 'string' && key.startsWith('fetch') ? () => 0 : undefined });
    const session = { actor, accountId: 'bot_save_ownership', coldLifeState: initial, coldCraftState: null };
    assert.equal((await Life.markHot(session, 'retained_hot')).simulation.revision, await rowRevision());
    saved = await Life.markCold(session, 'retained_cooldown');
    assert.equal(saved.phase, 'cold');
    assert.equal(saved.simulation.revision, await rowRevision(), 'hot/cold hand-back publishes the row revision');
    saved = await Life.upsertState({ ...saved, simulation: undefined }, 'legacy_view_save');
    assert.equal(saved.simulation.revision, await rowRevision(), 'a view without a revision cannot publish revision zero');
    const beforeWrite = Checkpoint.create(id, { workerAdmission: { characterId: id, commandId: 'after-retained-save',
        commandCheckpoint: Protocol.commandCheckpoint(saved), check: () => null } });
    await Database.updateCharacterVitals(id, 90, 100, 80, 100, { beforeWrite });
    const [character] = await Database.execute(['SELECT hp,mp FROM characters WHERE id=?', [id]]);
    assert.deepEqual(character, { hp: 90, mp: 80 }, 'the next actual queued native writer is admitted');
    await Database.execute(['UPDATE bot_life_state SET simulationRevision=simulationRevision+1 WHERE characterId=?', [id]]);
    await assert.rejects(Database.updateCharacterVitals(id, 1, 100, 1, 100, { beforeWrite }),
        error => error.code === 'BOT_WORKER_COMMAND_ADMISSION_REFUSED' && error.message === 'stale_command');
    assert.deepEqual((await Database.execute(['SELECT hp,mp FROM characters WHERE id=?', [id]]))[0], character,
        'a later foreign write still fences the original native capability');
    console.log('Lifecycle save ownership checkpoint PASS: retained snapshot, durable revision, next writer and foreign fence');
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    await Database.close(); fs.rmSync(fixture.directory, { recursive: true, force: true });
});
