const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
require('../src/Global');
const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const Backpack = invoke('GameServer/Actor/Backpack');
const Attack = invoke('GameServer/Actor/Attack');
const Npc = invoke('GameServer/Npc/Npc');
const QuestService = invoke('GameServer/Quest/QuestService');
const World = invoke('GameServer/World/World');
const Progression = invoke('GameServer/Items/SoulCrystalProgression');
const WriteQueue = invoke('GameServer/Persistence/CharacterWriteQueue');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'l2-soul-growth-'));
const file = path.join(directory, 'growth.sqlite');
options.default.Database.path = file;
const message = session => session.packets.filter(p => p[0] === 0x64).at(-1)?.readInt32LE(1);
let objectId = 3000000;
function mob(selfId = 625, hp = 50) {
    const id = ++objectId;
    return {
        fetchId: () => id, fetchSelfId: () => selfId, fetchHp: () => hp, fetchMaxHp: () => 100,
        fetchLocX: () => 100, fetchLocY: () => 0, fetchLocZ: () => 0,
        fetchAttackable: () => true, isDead: () => false,
        addAbsorber: Npc.prototype.addAbsorber, fetchSoulCrystalAbsorber: Npc.prototype.fetchSoulCrystalAbsorber,
        resetSoulCrystalAbsorbers: Npc.prototype.resetSoulCrystalAbsorbers
    };
}
async function sessionFor(id) {
    let casts = false;
    let mp = 100;
    const actor = {
        fetchId: () => id, fetchClanId: () => 0, fetchIsOnline: () => true, isDead: () => false,
        fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0,
        fetchMp: () => mp, setMp: value => { mp = value; },
        state: { fetchCasts: () => casts, setCasts: value => { casts = value; }, setHits() {} },
        backpack: new Backpack({ items: await Database.fetchItems(id), paperdoll: {} })
    };
    const session = { actor, packets: [], dataSendToMe(p) { this.packets.push(p); }, dataSendToMeAndOthers(p) { this.packets.push(p); } };
    await QuestService.ensureLoaded(session);
    return session;
}
async function setCrystal(session, selfId, amount = 1) {
    await Database.deleteItems(session.actor.fetchId());
    session.actor.backpack.items = [];
    session.packets.length = 0;
    if (selfId) {
        await QuestService.giveItem(session, selfId, amount);
        return session.actor.backpack.fetchItemFromSelfId(selfId);
    }
}
async function kill(session, npc = mob(), roll = 0, attacker = session.actor, mark = true) {
    if (mark) npc.addAbsorber(session.actor, session.actor.backpack.fetchItems()[0]?.fetchId());
    return Progression.onDeath(session, attacker, npc, () => roll);
}
async function main() {
    const seed = new DatabaseSync(file);
    seed.exec(fs.readFileSync(path.resolve(__dirname, '../database/sql/sqlite.sql'), 'utf8'));
    seed.prepare('INSERT INTO accounts(username, password) VALUES (?, ?)').run('soul_growth', 'test');
    for (let id = 1; id <= 3; id++) {
        seed.prepare(`INSERT INTO characters(id, username, name, classId, race, level, maxHp, maxMp, sex, face, hair, hairColor, locX, locY, locZ)
            VALUES (?, 'soul_growth', ?, 0, 0, 70, 500, 250, 0, 0, 0, 0, 0, 0, 0)`).run(id, `Growth${id}`);
        seed.prepare("INSERT INTO character_quests(characterId, questId, state, variables) VALUES (?,350,'started','{}')").run(id);
    }
    seed.close();
    Database.init();
    DataCache.init();
    const a = await sessionFor(1), b = await sessionFor(2), c = await sessionFor(3);
    World.user = { sessions: [a, b, c] };
    for (const selfId of Progression.crystalIds) {
        let template;
        DataCache.fetchItemFromSelfId(selfId, value => { template = value; });
        assert(template, `crystal ${selfId} has a runtime template`);
        const meta = Progression.catalog.crystals[selfId];
        if (meta.stage === 13) continue;
        const item = await setCrystal(a, selfId);
        const target = mob(meta.stage < 10 ? 625 : meta.stage < 12 ? 12372 : 12211);
        await kill(a, target);
        assert.equal(a.actor.backpack.fetchItems()[0].fetchSelfId(), meta.nextId, `${meta.color} ${meta.stage} grows exactly one stage`);
        assert.equal(a.actor.backpack.fetchItems()[0].fetchId(), item.fetchId(), 'shortcut object id is retained');
        assert.equal((await Database.fetchItems(1))[0].selfId, meta.nextId);
        assert.equal(message(a), 974);
        await kill(a, target);
        assert.equal(a.actor.backpack.fetchItems()[0].fetchSelfId(), meta.nextId, 'replayed death cannot advance twice');
    }
    for (const [roll, expected, msg] of [[0.31999, 4630, 974], [0.32, 4629, 975], [0.89999, 4629, 975], [0.90, 4662, 976]]) {
        await setCrystal(a, 4629);
        await kill(a, mob(), roll);
        assert.equal(a.actor.backpack.fetchItems()[0].fetchSelfId(), expected);
        assert.equal(message(a), msg);
    }
    for (const [selfId, broken] of [[4640, 4663], [4651, 4664]]) {
        await setCrystal(a, selfId);
        await kill(a, mob(), 0.99);
        assert.equal(a.actor.backpack.fetchItems()[0].fetchSelfId(), broken);
    }
    for (const [selfId, target] of [[4631, 583], [4629, 12372], [5577, 12211], [5908, 12211]]) {
        await setCrystal(a, selfId);
        await kill(a, mob(target));
        assert.equal(message(a), 978, 'wrong stage refuses without breaking');
        assert.equal(a.actor.backpack.fetchItems()[0].fetchSelfId(), selfId);
    }
    for (const [target, mark] of [[mob(), false], [mob(625, 51), true], [mob(1), true], [mob(625, 0), true]]) {
        await setCrystal(a, 4629);
        await kill(a, target, 0, a.actor, mark);
        assert.equal(a.actor.backpack.fetchItems()[0].fetchSelfId(), 4629);
    }
    await setCrystal(a, 4629);
    const stolen = mob();
    stolen.addAbsorber(b.actor, a.actor.backpack.fetchItems()[0].fetchId());
    await kill(a, stolen, 0, a.actor, false);
    assert.equal(a.actor.backpack.fetchItems()[0].fetchSelfId(), 4629, 'another player cannot supply the mark');
    const swapped = mob();
    swapped.addAbsorber(a.actor, a.actor.backpack.fetchItems()[0].fetchId());
    await setCrystal(a, 4640);
    await kill(a, swapped, 0, a.actor, false);
    assert.equal(a.actor.backpack.fetchItems()[0].fetchSelfId(), 4640, 'swapping crystals invalidates mark');

    await setCrystal(a, 4629);
    await QuestService.giveItem(a, 5914, 1);
    await kill(a);
    assert.equal(message(a), 977, 'terminal crystals count toward resonance');
    await setCrystal(a, 4629, 2);
    await kill(a);
    assert.equal(message(a), 977, 'stacked crystal amounts count toward resonance');
    await setCrystal(a, 4629);
    a.questStates.get(350).state = 'created';
    await kill(a);
    assert.equal(a.actor.backpack.fetchItems()[0].fetchSelfId(), 4629, 'quest is required');
    a.questStates.get(350).state = 'started';
    await kill(a, mob(), 0, { fetchIsSummon: () => true, fetchOwnerId: () => 1 });
    assert.equal(a.actor.backpack.fetchItems()[0].fetchSelfId(), 4630, 'summon final hit credits owner');

    b.partyCompanion = true; b.followPlayerSession = a;
    c.partyCompanion = true; c.followPlayerSession = a;
    await setCrystal(a, 4639); await setCrystal(b, 4650); await setCrystal(c, 4661);
    await kill(b, mob(12372), 0.99, b.actor, false);
    assert.deepEqual([a, b, c].map(s => s.actor.backpack.fetchItems()[0].fetchSelfId()), [5577, 5578, 5579], 'full party grows without use at guaranteed bosses');
    await setCrystal(a, 5580); await setCrystal(b, 5581); await setCrystal(c, 5914);
    b.actor.fetchLocX = () => 10000;
    await kill(a, mob(12211), 0.99, a.actor, false);
    assert.equal(b.actor.backpack.fetchItems()[0].fetchSelfId(), 5581, 'remote party members receive no reward');
    assert.equal(c.actor.backpack.fetchItems()[0].fetchSelfId(), 5914, 'party member eligibility is independent');
    assert.equal(message(c), 978);
    b.actor.fetchLocX = () => 0;
    await setCrystal(a, 5580);
    await kill(a, mob(10319), 0.70, a.actor, false);
    assert.equal(a.actor.backpack.fetchItems()[0].fetchSelfId(), 5580, 'Ember failure does not break the crystal');
    assert.equal(message(a), 975);
    await kill(a, mob(10319), 0.699, a.actor, false);
    assert.equal(a.actor.backpack.fetchItems()[0].fetchSelfId(), 5908);
    assert.equal(Progression.outcomeFor({ maxStage: 12, absorbType: 'PARTY_ONE_RANDOM' }, 10, 1, 0.99), 'failed');

    // A queued award must recheck both memory and persisted ownership/state.
    await setCrystal(a, 4629);
    const original = Database.replaceSoulCrystal;
    Database.replaceSoulCrystal = async () => { throw new Error('injected write failure'); };
    await assert.rejects(kill(a), /injected write failure/);
    Database.replaceSoulCrystal = original;
    assert.equal(a.actor.backpack.fetchItems()[0].fetchSelfId(), 4629);
    assert.equal((await Database.fetchItems(1))[0].selfId, 4629);
    await Database.setItem(1, { selfId: 4640, name: 'Green Soul Crystal', amount: 1 });
    await kill(a);
    assert.equal((await Database.fetchItems(1)).find(row => row.selfId === 4629).amount, 1, 'database resonance guard rejects stale memory');
    await setCrystal(a, 4629);
    await Promise.all([kill(a), kill(a)]);
    assert.equal(a.actor.backpack.fetchItems()[0].fetchSelfId(), 4630, 'overlapping deaths cannot reuse a replaced crystal');
    assert.equal((await sessionFor(1)).actor.backpack.fetchItems()[0].fetchSelfId(), 4630, 'relogin restores growth');

    await setCrystal(a, 4629);
    const deathTarget = mob();
    deathTarget.model = {};
    deathTarget.state = { dead: false, fetchDead() { return this.dead; }, setDead(value) { this.dead = value; } };
    deathTarget.destructor = () => {};
    deathTarget.addAbsorber(a.actor, a.actor.backpack.fetchItems()[0].fetchId());
    const actorGenerics = invoke('GameServer/Actor/Generics');
    const originalNpcDied = actorGenerics.npcDied;
    const originalRandom = Math.random;
    try {
        actorGenerics.npcDied = () => {};
        Math.random = () => 0;
        invoke('GameServer/Npc/Generics/Die')(a, a.actor, deathTarget);
        await deathTarget.soulCrystalReward;
        assert.equal(a.actor.backpack.fetchItems()[0].fetchSelfId(), 4630, 'authoritative NPC death awards the crystal');
        assert.equal(deathTarget.fetchSoulCrystalAbsorber(a.actor), null, 'death clears absorber references');
    } finally { actorGenerics.npcDied = originalNpcDied; Math.random = originalRandom; }

    // Aborting the quest or replacing the character while an award is queued cannot grant it.
    for (const invalidate of [() => { a.questStates.get(350).state = 'created'; }, () => { a.actor = b.actor; }]) {
        await setCrystal(a, 4629);
        const originalActor = a.actor;
        let release;
        a.questMutationTail = new Promise(resolve => { release = resolve; });
        const pending = kill(a);
        invalidate(); release(); await pending;
        a.actor = originalActor;
        a.questStates.get(350).state = 'started';
        assert.equal(a.actor.backpack.fetchItems()[0].fetchSelfId(), 4629);
    }

    // Real item cast binds the mark and uses the attack cancellation lifecycle.
    const bp = a.actor.backpack;
    const item = await setCrystal(a, 4629);
    let target = mob();
    bp.fetchSelectedNpcTarget = () => target;
    const skill = bp.buildItemSkill(invoke('GameServer/Items/C4ItemSkills').resolve(4629));
    const originalSetTimeout = global.setTimeout;
    let callback;
    global.setTimeout = fn => { callback = fn; return { unref() {} }; };
    try {
        a.actor.attack = { timers: new Set(), queueTimer: Attack.prototype.queueTimer, clearTimers: Attack.prototype.clearTimers, resetQueuedEvent() {} };
        bp.useDrainSoulItem(a, item.fetchId(), {}, skill);
        assert.equal(a.actor.state.fetchCasts(), true);
        callback();
        assert.equal(target.fetchSoulCrystalAbsorber(a.actor).crystalItemId, item.fetchId());
        assert.equal(a.actor.fetchMp(), 74);
        target = mob();
        bp.useDrainSoulItem(a, item.fetchId(), {}, skill);
        a.actor.attack.clearTimers(); a.actor.state.setCasts(false);
        callback();
        assert.equal(target.fetchSoulCrystalAbsorber(a.actor), null, 'cancelled cast cannot mark');
        bp.useDrainSoulItem(a, item.fetchId(), {}, skill);
        bp.items = [];
        callback();
        assert.equal(target.fetchSoulCrystalAbsorber(a.actor), null, 'lost item cannot mark');
        bp.items = [item];
    } finally { global.setTimeout = originalSetTimeout; }
    console.log('Soul Crystal progression: 39 upgrades, boundaries, breaks, eligibility, parties, summons, death hook, persistence and cast cancellation passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    await WriteQueue.flushAll();
    await Database.close();
    fs.rmSync(directory, { recursive: true, force: true });
});
