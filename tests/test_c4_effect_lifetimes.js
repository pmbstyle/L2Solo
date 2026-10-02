const assert = require('assert');
require('../src/Global');

const Cache = invoke('GameServer/DataCache');
const Skill = invoke('GameServer/Model/Skill');
const Npc = invoke('GameServer/Npc/Npc');
const NpcSkills = invoke('GameServer/Npc/NpcSkills');
const Execute = invoke('GameServer/Skills/C4SkillEffects');
const Store = invoke('GameServer/Effects/EffectStore');
const Stats = invoke('GameServer/Effects/EffectStats');
const Ticker = invoke('GameServer/Effects/EffectTicker');
const Planner = invoke('GameServer/Bot/AI/BotSupportPlanner');
const Attack = invoke('GameServer/Actor/Attack');
const Response = invoke('GameServer/Network/Response');
const World = invoke('GameServer/World/World');
const fixture = require('./fixtures/c4_effect_lifetimes.json');
Cache.init();

// Use the real player cache and NPC importer, including overrides in regional
// and raid templates. The fixture is an independent snapshot of Lisvus XML.
const skills = new Map();
for (const data of Cache.skills) for (const row of data.levels || []) {
    const skill = new Skill({ ...utils.crushOb(data), ...row });
    skills.set(`${skill.fetchSelfId()}|${skill.fetchLevel()}`, skill);
}
for (const data of Cache.npcs) {
    for (const skill of NpcSkills.forNpc({ fetchSelfId: () => data.selfId, fetchIsPet: () => false })) {
        skills.set(`${skill.fetchSelfId()}|${skill.fetchLevel()}`, skill);
    }
}
for (const summonId of [299, 301, 1276, 1277, 1278]) {
    for (const s of NpcSkills.forNpc({ fetchSelfId: () => 0, fetchSummonSkillId: () => summonId, fetchIsPet: () => false })) {
        skills.set(`${s.fetchSelfId()}|${s.fetchLevel()}`, s);
    }
}
const variants = id => [...skills.values()].filter(skill => skill.fetchSelfId() === id);
const skill = (id, level = null) => level === null ? variants(id)[0] : skills.get(`${id}|${level}`);
const atLevel = (value, level) => Array.isArray(value) ? value[level - 1] : value;
let nextId = 2005000;
function actor() {
    return {
        id: ++nextId, hp: 500000, maxHp: 1000000, mp: 10000, effects: {},
        fetchId() { return this.id; }, fetchName: () => 'effect_test', fetchLevel: () => 78,
        fetchHp() { return this.hp; }, fetchMaxHp() { return this.maxHp; }, setHp(v) { this.hp = v; },
        fetchMp() { return this.mp; }, fetchMaxMp: () => 10000, setMp(v) { this.mp = v; },
        fetchCollectiveMAtk: () => 1000, fetchCollectiveMDef: () => 100,
        fetchDex: () => 30, fetchHead: () => 0,
        fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0,
        isDead: () => false, state: { fetchDead: () => false }, statusUpdateVitals() {},
        backpack: { fetchTotalWeaponPAtkRnd: () => 0 }, skillset: { fetchSkills: () => [] }
    };
}
// Isolate the damage formula; execution, effects, packets and tick callbacks
// remain native. No live world sessions or SQLite writes are needed.
const attack = { prepareSkillDamage: () => 1, clearLoadedShot() {} };
const cast = (caster, target, s) => Execute.execute(null, caster, target, s, { attack, rng: () => 0 });
const original = { now: Date.now, setTimeout, clearTimeout, setInterval, clearInterval, npc: World.npc };
let now = 1000000, sequence = 0;
const timers = new Map();
function timer(callback, delay, repeat) {
    const token = { id: ++sequence, unref() {} };
    timers.set(token, { callback, due: now + Number(delay), repeat, order: sequence });
    return token;
}
function advance(ms) {
    const end = now + ms;
    for (let count = 0; count < 1000; count++) {
        const next = [...timers].filter(([, t]) => t.due <= end)
            .sort((a, b) => a[1].due - b[1].due || a[1].order - b[1].order)[0];
        if (!next) { now = end; return; }
        const [token, t] = next;
        now = t.due;
        if (t.repeat) t.due += t.repeat;
        else timers.delete(token);
        t.callback();
    }
    throw new Error('virtual timer loop exceeded bound');
}
Date.now = () => now;
global.setTimeout = (callback, delay) => timer(callback, delay, 0);
global.setInterval = (callback, delay) => timer(callback, delay, Number(delay));
global.clearTimeout = global.clearInterval = token => timers.delete(token);
const clear = (...actors) => {
    actors.forEach(a => Ticker.clearAll(a));
    assert.strictEqual(timers.size, 0, 'all effect timers must be released');
};
let lifetimes = 0, periodic = 0, stacks = 0;
try {
    const runtimeStats = { runSpd: 'runSpdAdd', pAtk: 'pAtkMul', pDef: 'pDefMul', pAtkSpd: 'pAtkSpdMul', reflectDam: 'reflectDam' };
    for (const sourced of fixture.skills) {
        const materialized = variants(sourced.id);
        assert(materialized.length > 0, `materialize ${sourced.id}`);
        for (const s of materialized) {
            const caster = actor(), target = actor(), start = now;
            const outcome = cast(caster, target, s);
            const affected = sourced.self ? caster : target;
            const effect = sourced.self ? outcome.selfEffect : outcome.effect;
            const duration = sourced.count * sourced.periodSeconds * 1000;
            assert(effect, `${sourced.id}:${s.fetchLevel()} creates its native effect`);
            assert.strictEqual(effect.expiresAt - start, duration, `${sourced.id} full lifetime`);
            const self = Response.abnormalStatusUpdate.fromActor(affected);
            const party = Response.partySpelled.fromActor(affected);
            assert.strictEqual(self.readUInt16LE(1), 1);
            assert.strictEqual(self.readUInt32LE(3), sourced.id);
            assert.strictEqual(self.readUInt32LE(9), duration / 1000);
            assert.strictEqual(party.readUInt32LE(13), sourced.id);
            assert.strictEqual(party.readUInt32LE(19), duration / 1000);
            for (const stat of sourced.stats.filter(stat => runtimeStats[stat.stat])) {
                const key = stat.stat === 'runSpd' && stat.op === 'mul' ? 'runSpdMul' : runtimeStats[stat.stat];
                const actual = stat.op === 'mul' ? Stats.multiplier(affected, key) : Stats.add(affected, key);
                assert.strictEqual(actual, atLevel(stat.value, s.fetchLevel()), `${sourced.id}:${s.fetchLevel()} ${stat.stat}`);
            }
            const kind = { DamOverTime: 'dot', ManaDamOverTime: 'manaDot', HealOverTime: 'hot' }[sourced.effect];
            if (kind) {
                const payload = effect[kind], value = atLevel(sourced.value, s.fetchLevel());
                assert(payload, `${sourced.id} periodic payload`);
                assert.strictEqual(payload.count, sourced.count);
                assert.strictEqual(payload.intervalMs, sourced.periodSeconds * 1000);
                const beforeHp = affected.hp, beforeMp = affected.mp;
                advance(duration - sourced.periodSeconds * 1000);
                const total = () => kind === 'hot' ? affected.hp - beforeHp : kind === 'dot' ? beforeHp - affected.hp : beforeMp - affected.mp;
                assert.strictEqual(total(), value * (sourced.count - 1), `${sourced.id} ticks before final boundary`);
                assert(Store.list(affected).some(e => e === effect), `${sourced.id} stays active until its full lifetime`);
                advance(sourced.periodSeconds * 1000);
                assert.strictEqual(total(), value * sourced.count, `${sourced.id} includes its final tick`);
                advance(26);
                const completed = total();
                advance(sourced.periodSeconds * 1000);
                assert.strictEqual(total(), completed, `${sourced.id} has no ticks after expiry`);
                periodic++;
            } else {
                advance(duration - 1);
                assert(Store.list(affected).some(e => e === effect), `${sourced.id} lasts through its final millisecond`);
                advance(27);
            }
            assert.strictEqual(Store.list(affected).length, 0, `${sourced.id} expires`);
            clear(caster, target);
            lifetimes++;
        }
    }
    for (const sourced of fixture.stacks) for (const s of variants(sourced.id)) {
        assert.strictEqual(s.fetchSemantic().stackFamily, sourced.stackType, `${sourced.id} native stack family`);
        assert.strictEqual(s.fetchSemantic().stackOrder, atLevel(sourced.stackOrder, s.fetchLevel()), `${sourced.id}:${s.fetchLevel()} native order`);
        stacks++;
    }
    for (const [ids, stat, expected] of [
        [[[1036, 2], [1006, 3]], 'mDefMul', 1.3],
        [[[1045, 6], [1311, 6]], 'maxHpMul', 1.35],
        [[[1346, 1], [1349, 1]], 'maxHpMul', 1.2],
        [[[1206, 19], [1104, 14]], 'pAtkSpdMul', 0.77],
        // Lisvus rejects equal offensive effects in an occupied stack. Fire
        // keeps the slot; Ice neither compounds its penalties nor refreshes it.
        [[[1339, 1], [1340, 1]], 'runSpdMul', 0.9]
    ]) {
        const caster = actor(), target = actor();
        const first = cast(caster, target, skill(...ids[0])).effect;
        advance(1000);
        cast(caster, target, skill(...ids[1]));
        assert.strictEqual(Store.list(target).length, 1, `${ids} shares one slot`);
        assert.strictEqual(Stats.multiplier(target, stat), expected, `${ids} does not compound stats`);
        if (first.type === 'debuff') {
            assert.strictEqual(Store.list(target)[0], first, 'equal debuff retains original expiry and ticker');
        }
        clear(caster, target);
    }
    {
        const caster = actor(), target = actor();
        cast(caster, target, skill(1006, 2));
        assert.strictEqual(Planner.needsSkill(target, skill(1036, 2)), true, 'Barrier 2 upgrades weaker Chant 2');
        cast(caster, target, skill(1036, 2));
        assert.strictEqual(Planner.needsSkill(target, skill(1006, 3)), false, 'equal strength across different levels is already covered');
        assert.strictEqual(Planner.needsSkill(target, skill(1006, 2)), false, 'a weaker buff cannot restart a stronger one');
        const expiry = Store.list(target)[0].expiresAt;
        assert.strictEqual(cast(caster, target, skill(1006, 2)).effect, null);
        assert.strictEqual(Store.list(target)[0].expiresAt, expiry);
        cast(caster, target, skill(1356, 1));
        assert.strictEqual(Planner.needsSkill(target, skill(1086, 2)), true, 'Prophecy cannot substitute for the separate Haste slot');
        clear(caster, target);
    }
    {
        const boss = actor(), healer = actor(), sibling = actor(), dead = actor(), outsider = actor();
        for (const a of [boss, healer, sibling, dead, outsider]) {
            a.fetchKind = () => 'Monster'; a.fetchSelfId = () => a.id;
        }
        boss.fetchIsRaidBoss = () => true;
        for (const a of [healer, sibling, dead]) a.minionBossObjectId = boss.id;
        dead.state.fetchDead = () => true;
        World.npc = { spawns: [boss, healer, sibling, dead, outsider] };
        const hot = skill(4784);
        const targets = Attack.prototype.resolveSkillTargets.call(Attack.prototype, null, healer, healer, hot);
        assert.deepStrictEqual(targets, [boss, healer, sibling], 'NPC clan HoT reaches its living raid group');
        const before = boss.hp;
        for (const recipient of targets) cast(healer, recipient, hot);
        advance(1000);
        assert(boss.hp > before, 'a minion actually heals the boss through the native periodic path');
        clear(boss, healer, sibling);
        World.npc = { spawns: [] };
        const template = Cache.npcs[0];
        const npc = new Npc(++nextId, utils.crushOb(template));
        npc.combatSkills = [hot];
        npc.setMp(10000); npc.setHp(npc.fetchMaxHp());
        assert.strictEqual(npc.selectCombatSkill(null, () => 0), null, 'NPC does not spend MP on HoT at full health');
        npc.setHp(npc.fetchMaxHp() / 2);
        assert.strictEqual(npc.selectCombatSkill(null, () => 0), hot, 'HOT remains selectable after correcting its type');
        npc.combatSkills = [skill(4028)];
        cast(npc, npc, skill(4211));
        assert.strictEqual(npc.selectCombatSkill(null, () => 0), null, 'NPC does not repeatedly cast a weaker member of its active stack');
        clear(npc);
    }
} finally {
    Date.now = original.now;
    global.setTimeout = original.setTimeout; global.clearTimeout = original.clearTimeout;
    global.setInterval = original.setInterval; global.clearInterval = original.clearInterval;
    World.npc = original.npc;
}
console.log(`C4 effect lifetimes ok (${lifetimes} levels, ${periodic} periodic cases, ${stacks} stack orders)`);
