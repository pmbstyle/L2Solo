const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
require('../src/Global');
const DB = invoke('Database'), Memory = invoke('GameServer/Social/InteractionMemoryRuntime');
const Repository = invoke('GameServer/Social/InteractionMemoryRepository');
const P = require('../src/GameServer/Social/InteractionMemoryPolicy');
const Help = invoke('GameServer/Social/CombatHelpMemory');
const Policy = require('../src/GameServer/Social/CombatHelpPolicy');
const Cold = require('../src/GameServer/Social/ColdCombatHelpMemory');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l2-combat-help-'));
options.default.Database.path = path.join(dir, 'test.sqlite');
const saved = [];
function patch(o, key, value) { const old = o[key]; saved.push(() => o[key] = old); o[key] = value; }
function actor(id, hp = 100) {
    const a = { hp, effects: {}, fetchId: () => id, fetchName: () => `Help${id}`, fetchLevel: () => 20,
        fetchHp() { return this.hp; }, setHp(n) { this.hp = n; }, fetchMaxHp: () => 100,
        fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0, fetchIsOnline: () => true,
        state: { fetchDead: () => a.hp <= 0, fetchSeated: () => false },
        statusUpdateVitals() {}, automation: { replenishVitals() {} } };
    a.session = { actor: a, accountId: `bot_help_${id}` };
    return a;
}
async function run() {
    DB.init();
    for (const id of [1, 2, 3]) {
        await DB.execute(['INSERT INTO accounts(username,password) VALUES (?,?)', [`bot_help_${id}`, 'test']]);
        await DB.execute([`INSERT INTO characters(id,username,name,classId,race,maxHp,maxMp,sex,face,hair,hairColor,locX,locY,locZ)
            VALUES (?,?,?,0,0,100,100,0,0,0,0,0,0,0)`, [id, `bot_help_${id}`, `Help${id}`]]);
    }
    await Memory.ensureMany([1, 2, 3]);
    const a = actor(1), helper = actor(2), other = actor(3);
    const npc = { hp: 10, dead: false, fetchId: () => 900, fetchName: () => 'Threat', fetchKind: () => 'Monster',
        fetchHp() { return this.hp; }, setHp(n) { this.hp = n; }, broadcastVitals() {}, state: { fetchDead: () => npc.dead } };
    patch(invoke('GameServer/Actor/Generics'), 'enterCombatState', () => {});
    patch(invoke('GameServer/Effects/EffectRestrictions'), 'wakeOnDamage', () => {});
    patch(invoke('GameServer/Pets/PetRuntime'), 'recordDamage', () => {});
    patch(invoke('GameServer/Quest/QuestService'), 'onAttack', async () => {});
    patch(invoke('GameServer/Bot/AI/BotMobCompetition'), 'record', () => {});
    patch(invoke('GameServer/Bot/AI/BotSocialMemory'), 'recordCombatHelp', () => {});
    patch(invoke(global.path.npc), 'die', () => { npc.dead = true; });
    invoke('GameServer/Actor/Generics/ReceivedHit')(helper.session, a, 70, { source: npc });
    assert.strictEqual(a.hp, 30);
    invoke('GameServer/Npc/Generics/ReceivedHit')(helper.session, helper, npc, 10);
    await Memory.events.flush();
    const rescued = Memory.assess({ id: 1 }, { id: 2 });
    assert(rescued.personal.reasons.some(r => r.type === 'helped_in_combat'), 'native damage then actual threat death creates gratitude');
    const helpAt = rescued.personal.lastHelpAt.helped_in_combat;
    assert(rescued.personal.trust > 3.99 && rescued.personal.trust <= 4);
    assert(!Help.recordDefeat(helper, npc), 'repeat fatal callbacks cannot farm credit');
    a.hp = 30;
    assert(!Help.record(other, a, { heal: 1 }, { hp: 30, maxHp: 100, combat: true }), 'trivial healing is not a rescue');
    assert(!Help.record(other, a, { heal: 20 }, { hp: 30, maxHp: 100, combat: false }), 'resting regeneration is not combat healing');
    assert(!Help.record(other, a, { heal: 20 }, { hp: 30, maxHp: 100, combat: true }), 'drain or group totals do not prove this recipient was healed');
    a.hp = 50;
    assert(Help.record(other, a, { heal: 20 }, { hp: 30, maxHp: 100, combat: true }));
    await Memory.events.flush();
    const now = Date.now();
    for (let i = 0; i < 4; i++) await Memory.recordBatch([{ key: `unrelated:${i}`, sourceId: 1, targetId: 2, type: 'attacked', at: now }]);
    assert(!Memory.assess({ id: 1 }, { id: 2 }).personal.reasons.some(r => r.type === 'helped_in_combat'));
    assert.strictEqual(Memory.assess({ id: 1 }, { id: 2 }).personal.lastHelpAt.helped_in_combat, helpAt);
    const before = await Repository.load(1);
    await DB.close(); DB.init(); await Memory.load(1);
    const cold = new (require('../src/GameServer/Social/InteractionMemory'))(); cold.accept(Memory.snapshot(1));
    assert.deepStrictEqual(Cold.eventsFor([{ sourceId: 1, targetId: 2, type: 'helped_in_combat' }],
        'cold-after-hot', Date.now(), cold.assess.bind(cold)), [], 'restart/worker handoff retain the help cooldown after reason eviction');
    const duplicate = await Memory.recordBatch([{ key: 'stale-worker-help', sourceId: 1, targetId: 2, type: 'helped_in_combat', at: Date.now() }]);
    assert.deepStrictEqual(duplicate.statuses, ['rate_limited']);
    assert.deepStrictEqual(await Repository.load(1), before, 'SQL protects against forecasts from a stale cache');
    assert(Policy.eligible(Memory.assess({ id: 1 }, { id: 2 }).personal, 'helped_in_combat', helpAt + Policy.COOLDOWN_MS));
    const invalid = Memory.snapshot(1); invalid.relations[0].lastHelpAt = { forged: now };
    assert.throws(() => P.validate(invalid), /help clock/);
    const old = { ...before, relations: before.relations.map(r => ({ ...r, lastHelpAt: undefined,
        reasons: [{ type: 'healed', at: r.at }] })) };
    const migrated = P.apply(old, { key: 'legacy-clock', sourceId: 1, targetId: 2, type: 'attacked', at: now }, now).snapshot;
    assert.strictEqual(migrated.relations.find(r => r.targetId === 2).lastHelpAt.healed, old.relations.find(r => r.targetId === 2).at);
    const freshNpc = { ...npc, hp: 0, state: { fetchDead: () => false } };
    Help.recordDamage(freshNpc, a, 10, now);
    assert(!Help.recordDefeat(other, freshNpc, now + Policy.THREAT_MS), 'stale threats do not award protection');
    a.hp = 80; Help.recordDamage(freshNpc, a, 10, now);
    assert(!Help.recordDefeat(other, freshNpc, now), 'healthy hunters do not reward every ordinary kill');
    console.log('Combat help: native damage/kill, meaningful heals, persistent bounded clocks, stale worker admission and SQLite reopen passed');
}
run().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => {
    await Memory.events.flush(); await DB.close(); saved.reverse().forEach(f => f()); fs.rmSync(dir, { recursive: true, force: true });
});
