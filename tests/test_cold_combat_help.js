const assert = require('assert');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Resolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const Party = invoke('GameServer/Bot/Population/BackgroundPartyResolver');
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Memory = require('../src/GameServer/Social/InteractionMemory');
const P = require('../src/GameServer/Social/InteractionMemoryPolicy');
const ColdHelp = require('../src/GameServer/Social/ColdCombatHelpMemory');
const at = Date.now(), memory = new Memory();
const fighter = (id, attack, hp, skills = [{ selfId: 1, level: 1, passive: true }]) => ({ characterId: id, level: 20, phase: 'cold', activity: 'grouped',
    name: `ColdHelp${id}`, inventory: {}, party: { partyId: 'help-party', role: id === 1 ? 'tank' : 'dps' },
    vitals: { hp, maxHp: 1000, mp: 1000, maxMp: 1000 },
    stats: { classId: 0, coldCombat: { version: 1, classId: 0,
        base: { str: 40, dex: 30, con: 43, int: 21, wit: 11, men: 25 },
        equipment: { weaponKind: 'Weapon.Sword', pAtk: attack, pAtkRnd: 0, mAtk: 40, atkSpd: 379,
            critical: 0, accur: 0, pDef: 120, mDef: 100, evasion: 0 }, effects: [], skills } } });
const healerSkill = { selfId: 1011, level: 1, passive: false, spell: true, power: 100, mp: 20, hitTime: 1000, reuse: 1000 };
const spot = { id: 'test', name: 'Test', avgLevel: 20, density: 1, npcSelfIds: [],
    mob: { hp: 1000000, damage: 1 }, rewards: { exp: 1, sp: 1, adenaMin: 0, adenaMax: 0 } };
const party = { partyId: 'help-party', leaderId: 1, memberIds: [1, 2], stats: {}, cohesion: 1 };
[1, 2].forEach(id => memory.accept(P.empty(id)));
const injured = fighter(1, 1, 30), healer = fighter(2, 1, 1000, [healerSkill]);
const resolve = (members, more = {}) => Party.resolve({ party, members, spot, elapsedMs: 1, rng: () => 0.5,
    timestamp: at, episodeId: 'help-episode', assessRelationship: memory.assess.bind(memory), ...more });
const input = JSON.stringify([injured, healer]);
const selfCaster = { state: healer, vitals: { hp: 100, maxHp: 100 }, profile: { skills: [{ selfId: 45, level: 1, power: 100, mp: 1 }] } };
const selfTarget = { state: injured, vitals: { hp: 20, maxHp: 100 } };
assert.strictEqual(Resolver.combat.chooseHeal(selfCaster.profile, [selfTarget, selfCaster], 100, {}, at, selfCaster), null,
    'healthy casters cannot treat an injured ally as the recipient of a self-only heal');
selfCaster.vitals.hp = 30;
const selfHeal = Resolver.combat.chooseHeal(selfCaster.profile, [selfTarget, selfCaster], 100, {}, at, selfCaster);
assert.strictEqual(selfHeal.target, selfCaster);
assert.deepStrictEqual(Resolver.combat.applyAllyHeal(selfCaster, [selfTarget, selfCaster], selfHeal), []);
assert.strictEqual(selfTarget.vitals.hp, 20, 'self healing neither heals nor earns credit from another bot');
const healed = resolve([injured, healer]);
const events = healed.memberResults.flatMap(m => m.result.memoryEvents);
assert(events.some(e => e.type === 'healed' && e.sourceId === 1 && e.targetId === 2), JSON.stringify(healed.debug));
assert.strictEqual(events.filter(e => e.type === 'healed').length, 1, 'many casts in an aggregate are one factual episode');
assert.strictEqual(JSON.stringify([injured, healer]), input, 'resolving is a pure proposal');
const facts = Resolver.resolvePartyFight({ members: [injured, healer], spot, timestamp: at, rng: () => 0.5 });
assert(facts.members.find(f => f.state.characterId === 2).vitals.mp < Profile.profileFor(healer, at).maxMp,
    'help follows a real paid heal');
const Metrics = invoke('GameServer/Bot/Population/PopulationMetrics');
const beforeMetrics = { ...Metrics.counters };
for (const member of healed.memberResults) Metrics.recordCombat(member.result.debug);
for (const key of ['combatActions', 'skillUses', 'heals']) {
    assert.strictEqual(Metrics.counters[key] - beforeMetrics[key], healed.debug[key],
        `worker member deliveries must count party ${key} exactly once`);
}
const soloHealer = fighter(3, 1, 30, [healerSkill]);
soloHealer.activity = 'hunting';
delete soloHealer.party;
const soloInput = JSON.stringify(soloHealer);
const soloResolve = state => Resolver.resolveSolo({ state, spot, elapsedMs: 1, timestamp: at, rng: () => 0.5 });
const soloHealed = soloResolve(soloHealer);
assert(soloHealed.debug.heals > 0, 'an injured cold solo bot must cast its learned heal');
assert(soloHealed.patch.vitals.hp > soloHealer.vitals.hp, 'solo healing must actually restore HP');
assert(soloHealed.patch.vitals.mp < soloHealer.vitals.mp, 'solo healing must pay MP');
assert(soloHealed.patch.stats.coldCombat.cooldowns[1011] > at, 'solo healing must persist reuse');
assert.strictEqual(soloHealed.debug.skillUses, soloHealed.debug.heals, 'heals use the shared bounded cast budget');
assert.strictEqual(soloHealed.memoryEvents?.length || 0, 0, 'self healing cannot earn gratitude');
assert.strictEqual(JSON.stringify(soloHealer), soloInput, 'solo healing must not mutate its input');
const unavailable = [
    { ...soloHealer, vitals: { ...soloHealer.vitals, mp: 0 } },
    { ...soloHealer, vitals: { ...soloHealer.vitals, hp: Profile.profileFor(soloHealer, at).maxHp } },
    { ...soloHealer, stats: { ...soloHealer.stats, coldCombat: { ...soloHealer.stats.coldCombat,
        cooldowns: { 1011: at + 60000 } } } }
];
for (const state of unavailable) assert.strictEqual(soloResolve(state).debug.heals, 0,
    'healthy, out-of-mana, and cooldown-bound solo bots must not cast a heal');
for (const skill of [{ ...healerSkill, selfId: 45 }, { ...healerSkill, selfId: 109, power: 20 }]) {
    const state = { ...soloHealer, stats: { ...soloHealer.stats,
        coldCombat: { ...soloHealer.stats.coldCombat, skills: [skill] } } };
    const won = Resolver.resolveSolo({ state, spot: { ...spot, mob: { hp: 1, damage: 1 } },
        elapsedMs: 1, timestamp: at, rng: () => 0.5 });
    assert(won.debug.wins > 0 && won.debug.heals > 0, 'self and percentage heals must survive a winning solo result');
    assert(won.patch.vitals.hp > state.vitals.hp);
}
assert(!resolve([injured, fighter(2, 1, 1000)]).memberResults.some(m => m.result.memoryEvents.some(e => e.type === 'healed')),
    'healer role alone is not evidence of a cast');
const snapshot = P.apply(P.empty(1), events.find(e => e.type === 'healed'), at).snapshot;
memory.accept(snapshot);
assert(!resolve([injured, healer], { episodeId: 'next-episode', timestamp: at + 1 }).memberResults
    .some(m => m.result.memoryEvents.some(e => e.type === 'healed')), 'subsequent cold casts respect committed personal cooldown');
const attacker = fighter(2, 100, 1000);
const protectedFight = Resolver.resolvePartyFight({ members: [injured, attacker],
    spot: { ...spot, mob: { hp: 10000, damage: 10 } }, timestamp: at, rng: () => 0.01 });
assert(protectedFight.won && protectedFight.help.some(e => e.type === 'helped_in_combat' && e.sourceId === 1 && e.targetId === 2),
    JSON.stringify({ won: protectedFight.won, help: protectedFight.help, debug: protectedFight.debug }));
const healthy = Resolver.resolvePartyFight({ members: [fighter(1, 1, 1000), attacker],
    spot: { ...spot, mob: { hp: 10000, damage: 10 } }, timestamp: at, rng: () => 0.01 });
assert(!healthy.help.some(e => e.type === 'helped_in_combat'), 'ordinary damage dealing for a healthy party is not rescue');
const pvpState = (state, readyAt) => ({ ...state, loc: { locX: 0, locY: 0, locZ: 0 },
    stats: { ...state.stats, coldPvp: { readyAt }, coldCombat: { ...state.stats.coldCombat, cp: 0 } } });
const victim = pvpState(injured, at + 10000), defender = pvpState(fighter(2, 5000, 1000), at + 100);
const opponent = pvpState(fighter(3, 10, 1000), at);
const pvp = require('../src/GameServer/Bot/Population/ColdPvpResolver').resolve({
    sides: [{ principal: victim, members: [victim, defender] }, { principal: opponent, members: [opponent] }],
    roles: new Map([[2, 'support']]), timestamp: at, rng: () => 0.01, personaFor: () => ({ traits: { caution: 0 } }),
    step: { resuming: true, until: at + 1000, expiresAt: at + 30000 } });
assert(pvp.help?.some(e => e.type === 'helped_in_combat' && e.sourceId === 1 && e.targetId === 2), JSON.stringify(pvp));
// Mixed helpful and hunt facts share the same 64-event transaction budget.
const savedFight = Resolver.resolvePartyFight;
try {
    const many = Array.from({ length: 9 }, (_, i) => fighter(i + 1, 1, 1000));
    many.forEach(s => memory.accept(P.empty(s.characterId)));
    Resolver.resolvePartyFight = ({ members }) => ({ won: true, help: members.filter(m => m.characterId !== 2)
        .map(m => ({ sourceId: m.characterId, targetId: 2, type: 'helped_in_combat' })),
        members: members.map(state => ({ state, profile: Profile.profileFor(state, at), vitals: state.vitals, cooldowns: {} })), debug: {} });
    const batch = resolve(many).memberResults.flatMap(m => m.result.memoryEvents);
    assert.strictEqual(batch.length, 64);
    assert.strictEqual(batch.filter(e => e.type === 'helped_in_combat').length, 8, 'specific help has priority over generic group familiarity');
    assert.deepStrictEqual(ColdHelp.eventsFor([], null, at, null), []);
} finally { Resolver.resolvePartyFight = savedFight; }
console.log('Cold PvE help: real heals, real threat defeat, useful targets, no invented role credit, pure proposals and shared event budget passed');
