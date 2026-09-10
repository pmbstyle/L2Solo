const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
require('../src/Global');
const DB = invoke('Database'), Memory = invoke('GameServer/Social/InteractionMemoryRuntime');
const Help = invoke('GameServer/Social/CombatHelpMemory');
const P = require('../src/GameServer/Social/InteractionMemoryPolicy');
const Aid = require('../src/GameServer/Social/OpponentAidPolicy');
const Clan = require('../src/GameServer/Clan/ClanSocialPolicy');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l2-opponent-aid-'));
options.default.Database.path = path.join(dir, 'test.sqlite');
function actor(id) {
    const a = { hp: 30, x: 0, fetchId: () => id, fetchClanId: () => id === 1 ? 10 : 20,
        fetchHp() { return this.hp; }, setHp(n) { this.hp = n; }, fetchMaxHp: () => 100,
        fetchLocX() { return this.x; }, fetchLocY: () => 0, fetchLocZ: () => 0, fetchIsOnline: () => true,
        state: { fetchDead: () => a.hp <= 0, fetchCombats: () => true }, statusUpdateVitals() {} };
    a.session = { actor: a, accountId: `bot_aid_${id}` };
    return a;
}
async function run() {
    DB.init();
    for (const id of [1, 2, 3, 4]) {
        await DB.execute(['INSERT INTO accounts(username,password) VALUES (?,?)', [`bot_aid_${id}`, 'test']]);
        await DB.execute([`INSERT INTO characters(id,username,name,classId,race,maxHp,maxMp,sex,face,hair,hairColor,locX,locY,locZ)
            VALUES (?,?,?,0,0,100,100,0,0,0,0,0,0,0)`, [id, `bot_aid_${id}`, `Aid${id}`]]);
    }
    await Memory.ensureMany([1, 2, 3, 4]);
    const victim = actor(1), opponent = actor(2), helper = actor(3), bystander = actor(4);
    // Supporting a player must still be remembered by the bot they hurt.
    opponent.session.accountId = 'human';
    const at = Date.now();
    const heal = (who = helper, when = at) => {
        opponent.hp = 50;
        return Help.record(who, opponent, { heal: 20 }, { hp: 30, maxHp: 100, combat: true }, when);
    };
    assert(!heal(), 'old dislike or a nearby party is not evidence of an opponent');
    Help.recordDamage(opponent, victim, 0, at);
    assert(!heal(), 'misses cannot fabricate an aid offense');
    Help.recordDamage(opponent, victim, 10, at);
    opponent.hp = 31;
    assert(!Help.record(helper, opponent, { heal: 1 }, { hp: 30, maxHp: 100, combat: true }, at));
    opponent.hp = 50;
    assert(!Help.record(helper, opponent, { heal: 20 }, { hp: 30, maxHp: 100, combat: false }, at));
    assert(!heal(victim), 'healing your own attacker does not create self resentment');
    victim.x = 5000; assert(!heal(), 'departed victims do not witness help'); victim.x = 0;
    helper.session.arenaEphemeral = true; assert(!heal()); delete helper.session.arenaEphemeral;
    assert(!heal(helper, at + 15000), 'the direct victim trace expires');
    opponent.session.pvpEncounter = { key: 'aid-encounter', reason: 'revenge', sides: [
        { memberIds: [2, 3] }, { memberIds: [1, 4] }] };
    // Drive the existing native effect completion hook, not a proposed heal.
    opponent.hp = 30;
    const skill = { fetchSemantic: () => ({ skillType: invoke('GameServer/Skills/C4SkillRules').HEAL_PERCENT, healPower: 20 }), fetchSpell: () => false, fetchPower: () => 20 };
    const result = invoke('GameServer/Skills/C4SkillEffects').execute(helper.session, helper, opponent, skill);
    assert.strictEqual(result.heal, 20);
    await Memory.events.flush();
    const row = Memory.snapshot(1).relations.find(r => r.targetId === 3);
    assert(row && row.hostility === 4 && row.trust === -3);
    assert.strictEqual(Memory.snapshot(4).relations.length, 0, 'party witnesses get no invented personal offense');
    const event = (await invoke('GameServer/Social/InteractionMemoryRepository').load(1)).recent.find(e => e.type === 'aided_opponent');
    assert.strictEqual(event.clan.responsibility, 'aggression');
    assert(Clan.apply(Clan.empty(10), event, Date.now()).relations.some(r => r.targetId === 3));
    for (const responsibility of ['unknown', 'defense']) {
        assert.strictEqual(Clan.apply(Clan.empty(10), { ...event, clan: { ...event.clan, responsibility } }, Date.now()).revision, 0);
    }
    assert(!heal(), 'many actual heals create one personal offense');
    const now = Date.now();
    for (let i = 0; i < 4; i++) await Memory.recordBatch([{ key: `other:${i}`, sourceId: 1, targetId: 3, type: 'attacked', at: now }]);
    assert(!Memory.snapshot(1).relations[0].reasons.some(r => r.type === 'aided_opponent'));
    await DB.close(); DB.init(); Memory.snapshots.delete(1); Memory.views.delete(1); await Memory.load(1);
    assert.strictEqual(Memory.views.get(1).relation('character', 3, Date.now()).lastAidAt, row.lastAidAt);
    const staleCold = await Memory.recordBatch([{ key: 'cold-retry', sourceId: 1, targetId: 3, type: 'aided_opponent', at: Date.now() }]);
    assert.deepStrictEqual(staleCold.statuses, ['rate_limited'], 'SQL guards a stale cold forecast after restart and reason eviction');
    assert(Aid.eligible(Memory.views.get(1).relation('character', 3, Date.now()), row.lastAidAt + Aid.COOLDOWN_MS));
    const invalid = Memory.snapshot(1); invalid.relations[0].lastAidAt = invalid.relations[0].at + 1;
    assert.throws(() => P.validate(invalid), /aid time/);
    // Reverse handoff: a re-materialized recipient carries its last actual victim.
    const reloaded = actor(2); reloaded.session.accountId = 'human';
    reloaded.session.coldLifeState = { stats: { coldPvp: Help.threatSnapshot(opponent, at) } };
    const index = invoke('GameServer/Bot/AI/BotPvpIndex'), oldActor = index.actor;
    index.actor = id => id === 1 ? victim : null;
    try {
        reloaded.hp = 50;
        assert(Help.record(bystander, reloaded, { resurrected: true }, { hp: 0 }, at));
        await Memory.events.flush();
        assert(Memory.snapshot(1).relations.some(r => r.targetId === 4 && r.hostility === 4));
    } finally { index.actor = oldActor; }
    // Recipient gratitude and an opponent's resentment have independent admission.
    const ally = actor(2), supporter = actor(3), hurtBot = actor(4);
    ally.hp = 50;
    assert(Help.record(supporter, ally, { heal: 20 }, { hp: 30, maxHp: 100, combat: true }, at));
    await Memory.events.flush();
    Help.recordDamage(ally, hurtBot, 10, at);
    assert(Help.record(supporter, ally, { heal: 20 }, { hp: 30, maxHp: 100, combat: true }, at));
    await Memory.events.flush();
    assert(Memory.snapshot(4).relations.some(r => r.targetId === 3 && r.hostility === 4), 'gratitude cooldown does not swallow the negative event');
    console.log('Opponent aid: native heal, direct victim attribution, no ambient guilt, clan responsibility, resurrection, handoff and SQLite reopen passed');
}
run().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => {
    await Memory.events.flush(); await DB.close(); fs.rmSync(dir, { recursive: true, force: true });
});
