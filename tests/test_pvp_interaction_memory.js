const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
require('../src/Global');
const Database = invoke('Database');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Enemy = invoke('GameServer/Bot/AI/BotEnemyMemory');
const Social = invoke('GameServer/Social/InteractionMemoryRuntime');
const Bridge = invoke('GameServer/Social/PvpInteractionMemory');
const Repository = invoke('GameServer/Social/InteractionMemoryRepository');
const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l2-pvp-relations-'));
options.default.Database.path = path.join(dir, 'memory.sqlite');
const originalDirty = Coordinator.markDirty;
const originalEnqueue = Social.events.enqueue;
const originalOnCommit = Social.events.onCommit;
const delivered = [];
const at = Date.now() - 90000;

async function run() {
    Database.init();
    for (let id = 1; id <= 7; id++) {
        await Database.execute(['INSERT INTO accounts(username,password) VALUES (?,?)', [`bot_test_${id}`, 'test']]);
        await Database.execute([`INSERT INTO characters(id,username,name,classId,race,maxHp,maxMp,sex,face,hair,hairColor,locX,locY,locZ)
            VALUES (?,?,?,0,0,100,100,0,0,0,0,0,0,0)`, [id, `bot_test_${id}`, `Actor${id}`]]);
    }
    assert(await Life.init());
    await Social.ensureMany([1]);
    Coordinator.markDirty = (state, options) => delivered.push({ id: state.characterId, options });
    const state = await Life.upsertState({ characterId: 1, name: 'Actor1', accountName: 'bot_test_1',
        level: 10, phase: 'hot', activity: 'hunting', stats: { classId: 0 }, inventory: {},
        loc: { locX: 0, locY: 0, locZ: 0 }, vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 } });
    const actor = { dead: false, effects: {}, fetchId: () => 1, fetchName: () => 'Actor1', fetchLevel: () => 10,
        fetchClassId: () => 0, fetchExp: () => 0, fetchSp: () => 0,
        fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0,
        fetchHp: () => 100, fetchMaxHp: () => 100, fetchMp: () => 100, fetchMaxMp: () => 100,
        state: { fetchDead: () => actor.dead } };
    const session = { actor, accountId: 'bot_test_1', plan: 'hunting', coldLifeState: state };
    actor.session = session;
    const foe = id => ({ fetchId: () => id, fetchName: () => `Actor${id}` });
    for (let i = 0; i < 500; i++) Enemy.record(actor, foe(2), false, at + i);
    assert.strictEqual(Social.events.pending.size, 1, '500 damage callbacks create one social episode');
    const first = [...Social.events.pending.values()][0];
    await Social.events.flush();
    assert.strictEqual(Social.assess({ id: 1 }, { id: 2 }).disposition, 'wary');
    Enemy.record(actor, foe(2), true, at + 500);
    actor.dead = true;
    assert(!Enemy.record(actor, foe(2), true, at + 501), 'a corpse cannot record another death');
    actor.dead = false;
    await Social.events.flush();
    assert.strictEqual(Social.assess({ id: 1 }, { id: 2 }).disposition, 'hostile');
    assert.strictEqual(Social.snapshot(1).revision, 2);
    assert(delivered.some(e => e.id === 1 && e.options?.reason === 'interaction_memory'), 'worker receives the new relationship');
    Social.events.enqueue(first);
    await Social.events.flush();
    assert.strictEqual(Social.snapshot(1).revision, 2, 'replay is idempotent in SQLite');

    for (let id = 3; id <= 6; id++) Enemy.record(actor, foe(id), false, at + id);
    await Social.events.flush();
    assert.strictEqual(Enemy.entries(session).length, 3);
    assert.strictEqual(Social.snapshot(1).relations.length, 5, 'social memory includes aggressors outside the revenge shortlist');
    Enemy.record(actor, foe(6), false, at + 60006);
    await Social.events.flush();
    const before = (await Repository.load(1)).revision;
    assert.strictEqual(before, 7, 'a later attack episode can change the relationship again');

    // Delivery pressure retries the original incident, rather than stamping
    // each subsequent damage callback as another episode.
    Social.events.enqueue = () => false;
    Enemy.record(actor, foe(7), false, at + 60007);
    Social.events.enqueue = originalEnqueue;
    Enemy.record(actor, foe(7), false, at + 60008);
    const retried = [...Social.events.pending.values()].find(e => e.targetId === 7);
    assert.strictEqual(retried.at, at + 60007);
    await Social.events.flush();
    assert.strictEqual((await Repository.load(1)).revision, before + 1);
    assert(!Bridge.record(session, 1, false, Date.now()), 'self interactions are rejected');
    assert(!Enemy.record(actor, { fetchKind: () => 'Monster', fetchId: () => 7 }, false), 'ordinary monsters create no personal enemy');
    session.arenaEphemeral = true;
    assert(!Enemy.record(actor, foe(7), true), 'arena actors create no relationship penalty');
    delete session.arenaEphemeral;

    await Life.rememberEnemies(session);
    const cold = await Life.markCold(session, 'pvp_relation_test');
    assert.strictEqual(cold.phase, 'cold');
    const persisted = await Repository.load(1);
    await Database.close();
    Database.init();
    Social.forget(1);
    await Social.ensureMany([1]);
    assert.strictEqual(Social.snapshot(1).revision, persisted.revision);
    assert.strictEqual(Social.assess({ id: 1 }, { id: 2 }).disposition, 'hostile');
    const restarted = { ...session, coldLifeState: cold, pvpEnemyMemory: undefined };
    actor.session = restarted;
    Enemy.record(actor, foe(6), false, at + 60009);
    assert.strictEqual(Social.events.pending.size, 0, 'hot reactivation recovers the attack cooldown from social memory');
    console.log('PvP interaction memory: factual episodes, bounded spam, death, replay, queue retry, shortlist independence, worker delivery and SQLite reopen passed');
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    Social.events.enqueue = originalEnqueue;
    await Social.events.drain();
    Social.events.onCommit = originalOnCommit;
    Coordinator.markDirty = originalDirty;
    await Database.close();
    fs.rmSync(dir, { recursive: true, force: true });
});
