const assert = require('assert');
require('../src/Global');
const Store = invoke('GameServer/Effects/EffectStore');
const Stats = invoke('GameServer/Effects/EffectStats');
const Ticker = invoke('GameServer/Effects/EffectTicker');
const Skill = invoke('GameServer/Model/Skill');
const Response = invoke('GameServer/Network/Response');
const Effects = invoke('GameServer/Skills/C4SkillEffects');
const Death = invoke('GameServer/Npc/Generics/Die');
const Rules = invoke('GameServer/Skills/C4SkillRules');
const NpcSkills = invoke('GameServer/Npc/NpcSkills');
const raw = require('../data/Npcs/Skills/active.json').find(s => s.selfId === 4038);
const skill = new Skill({ selfId: raw.selfId, ...raw.template, ...raw.time, ...raw.levels[2] });
const original = { now: Date.now, timeout: global.setTimeout, clear: global.clearTimeout, npcInfo: Response.npcInfo };
let now = 100000;
const timers = new Map();
Date.now = () => now;
global.setTimeout = (fn, delay) => { const timer = { fn, at: now + delay, unref() {} }; timers.set(timer, timer); return timer; };
global.clearTimeout = timer => timers.delete(timer);
Response.npcInfo = () => Buffer.from([0x16]);
const packets = [];
const player = { effects: {}, fetchId: () => 2001804, fetchLevel: () => 20, fetchCollectiveMDef: () => 100 };
player.session = { actor: player, dataSendToMe: p => packets.push(p) };
const npc = { effects: {}, fetchKind: () => 'Monster', fetchId: () => 1014813, fetchLevel: () => 20, fetchCollectiveMAtk: () => 100 };
const proxy = { actor: npc, dataSendToMe: p => packets.push(p), dataSendToMeAndOthers() {} };
const icons = () => packets.filter(p => p[0] === 0x7f);
const advance = ms => { now += ms; for (const t of [...timers.keys()]) if (t.at <= now) { timers.delete(t); t.fn(); } };
try {
    Store.apply(player, { id: 1204, key: 'wind_walk', type: 'buff', durationMs: 1200000 });
    // A legitimate NPC self buff must never replace the receiving player's bar.
    const buff = new Skill({ selfId: 9999, name: 'NPC Test Buff', level: 1, buff: 15000, power: 0, distance: -1 });
    Effects.execute(proxy, npc, npc, buff, { rng: () => 0 });
    assert.strictEqual(icons().length, 0);
    assert(!packets.some(p => p[0] === 0xf4));
    advance(15030);
    assert.strictEqual(icons().length, 0, 'NPC expiry must not send an empty player bar');
    Effects.execute(proxy, npc, npc, buff, { rng: () => 0 });
    Death.clearEffectsOnDeath(npc);
    advance(15030);
    assert.strictEqual(icons().length, 0, 'NPC death must not affect the player bar');

    // Summons may carry their owner's session, but still have their own effect list.
    npc.session = player.session;
    Effects.execute(proxy, npc, npc, buff, { rng: () => 0 });
    advance(15030);
    assert.strictEqual(icons().length, 0, 'Owner session must not make NPC icons personal');
    delete npc.session;
    const ruinBatSkill = NpcSkills.combatSkillsFor({ fetchSelfId: () => 505 })
        .find(s => s.fetchSelfId() === 4038);
    assert(ruinBatSkill);
    assert.strictEqual(ruinBatSkill.fetchTargetKind(), 'enemy');
    assert.strictEqual(ruinBatSkill.fetchLevel(), 3);
    assert.strictEqual(skill.fetchTargetKind(), 'enemy');
    const result = Effects.execute(proxy, npc, player, skill, { rng: () => 0 });
    assert(result.effect);
    assert.strictEqual(result.damage, 0, 'Land rate is not damage power');
    assert.strictEqual(result.effect.stats.pAtkSpdMul, 0.8);
    assert.strictEqual(Stats.multiplier(player, 'pAtkSpdMul'), 0.8);
    assert.strictEqual(result.effect.expiresAt - now, 15000);
    const packet = icons().at(-1);
    assert.strictEqual(packet.readUInt16LE(1), 2);
    assert.strictEqual(packet.readInt32LE(3), 1204);
    assert.strictEqual(packet.readInt32LE(13), 4038);
    const expiry = result.effect.expiresAt;
    advance(1000);
    Effects.execute(proxy, npc, player, skill, { rng: () => 0 });
    assert.strictEqual(Store.list(player).find(e => e.id === 4038).expiresAt, expiry);
    Death.clearEffectsOnDeath(npc);
    advance(14030);
    assert.strictEqual(Store.list(player).length, 1);
    assert.strictEqual(Stats.multiplier(player, 'pAtkSpdMul'), 1);
    assert.strictEqual(icons().at(-1).readUInt16LE(1), 1);
    assert.strictEqual(icons().at(-1).readInt32LE(3), 1204);
    for (const id of [4019,4037,4038,4183,4184,4187,4189,4190,4200,4203,4205]) {
        const rule = Rules.resolve({ selfId: id, level: 3 });
        assert.strictEqual(rule.effectType, 'debuff', String(id));
        assert.strictEqual(rule.target, 'enemy', String(id));
        assert(rule.durationMs > 0);
    }
    assert.strictEqual(Rules.resolve({ selfId: 4190, level: 6 }).stats.maxMpAdd, -4);
    const aura = Rules.resolve({ selfId: 4184, level: 4 });
    assert.strictEqual(aura.sourceTarget, 'aura');
    assert.strictEqual(aura.radius, 200);
    assert.strictEqual(aura.stats.pAtkSpdMul, 0.77);
    assert.strictEqual(aura.stackFamily, skill.fetchSemantic().stackFamily);
    assert.strictEqual(Rules.resolve({ selfId: 4019, level: 1 }).sourceTarget, 'area');
    assert.strictEqual(Rules.resolve({ selfId: 4205, level: 1 }).effect, 'paralyze');
    assert.strictEqual(Rules.resolve({ selfId: 4205, level: 1 }).durationMs, 120000);
    console.log('NPC effect panel and debuff lifecycle checks passed');
} finally {
    Date.now = original.now;
    global.setTimeout = original.timeout;
    global.clearTimeout = original.clear;
    Response.npcInfo = original.npcInfo;
}
