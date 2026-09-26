const assert = require('assert');
require('../src/Global');
const Intent = invoke('GameServer/Bot/AI/BotSkillIntent');
const Tactics = invoke('GameServer/Bot/AI/BotPvpTactics');
const Self = invoke('GameServer/Bot/AI/PartyClassTactics');
const Support = invoke('GameServer/Bot/AI/BotSupportPlanner');
const Ranged = invoke('GameServer/Bot/AI/BotRangedCombatPositioning');
const Rules = invoke('GameServer/Skills/C4SkillRules');
const World = invoke('GameServer/World/World');
function actor(id, classId, hp = 100, x = 0, clan = 0) {
    const a = { hp, x, effects: {}, skills: [], weapon: 'Weapon.Sword',
        fetchId: () => id, fetchClassId: () => classId, fetchHp: () => a.hp, fetchMaxHp: () => 100,
        fetchMp: () => 100, fetchMaxMp: () => 100, fetchClanId: () => clan,
        fetchLocX: () => a.x, fetchLocY: () => 0, canUseSkill: () => true,
        state: { fetchDead: () => a.hp <= 0 },
        skillset: { get skills() { return a.skills; }, fetchSkills: () => a.skills, fetchSkill: id => a.skills.find(s => s.fetchSelfId() === id) },
        backpack: { fetchTotalWeaponKind: () => a.weapon, fetchEquippedArmors: () => [] } };
    return a;
}
function skill(id, effect, extra = {}, kind = 'enemy', type = Rules.EFFECT) {
    const semantic = { effect, effectType: 'debuff', skillType: type, ...extra };
    return { fetchSelfId: () => id, fetchLevel: () => 1, fetchPassive: () => false,
        fetchSemantic: () => semantic, fetchSkillType: () => type, fetchTargetKind: () => kind,
        fetchConsumedMp: () => 10, fetchPower: () => 50, fetchDistance: () => 600 };
}
const caster = actor(1, 12), warrior = actor(2, 46), mage = actor(3, 12);
const silence = skill(1064, 'silence'), sleep = skill(1069, 'sleep');
assert(!Intent.debuffUseful(caster, warrior, silence));
assert(Intent.debuffUseful(caster, mage, silence));
assert(!Intent.debuffUseful(caster, mage, sleep, { primary: true }));
assert(Intent.debuffUseful(caster, mage, sleep, { primary: true, fleeing: true }));
mage.effects.silence = { id: 1064, key: 'silence', level: 2, type: 'debuff', expiresAt: Date.now() + 60000 };
assert(!Intent.debuffUseful(caster, mage, silence));
mage.effects = {};
const cancel = skill(1056, '', {}, 'enemy', Rules.CANCEL);
const bane = skill(1351, '', { baneStackFamilies: ['casting_time_down'] }, 'enemy', Rules.BANE);
assert(!Intent.debuffUseful(caster, mage, cancel));
mage.effects.might = { id: 1068, key: 'might', type: 'buff', stackFamily: 'pAtk', expiresAt: Date.now() + 60000 };
assert(Intent.debuffUseful(caster, mage, cancel));
assert(!Intent.debuffUseful(caster, mage, bane));
mage.effects.might.stackFamily = 'casting_time_down';
assert(Intent.debuffUseful(caster, mage, bane));
mage.x = 601;
assert(!Intent.debuffUseful(caster, mage, cancel));
mage.x = 0;

// A dead or unreachable most-wounded member must not starve a reachable heal.
const healer = actor(10, 16), dead = actor(11, 0, 0), far = actor(12, 0, 5, 800), near = actor(13, 0, 30, 100);
healer.skills = [skill(1011, '', {}, 'friendly', Rules.HEAL)];
const session = { actor: healer }, owner = {}, casts = [];
let seated = true;
let stands = 0;
healer.state.fetchSeated = () => seated;
healer.state.setSeated = next => { seated = next; };
healer.fetchLocZ = () => 0;
healer.fetchHead = () => 0;
session.dataSendToOthers = () => stands++;
const generics = { skillExec: (_s, _a, data) => casts.push(data) };
const context = { owner, members: [dead, far, near].map(actor => ({ actor })), threats: [] };
assert(Tactics.support(session, healer, context, generics, Date.now()));
assert.strictEqual(casts.at(-1).id, 13);
assert.strictEqual(seated, false, 'support wakes a seated healer before the skill request');
assert.strictEqual(stands, 1);
assert(!Tactics.support(session, healer, context, generics, Date.now()), 'heal reservation prevents duplicate dispatch');

caster.skills = [silence];
const pvp = { owner: {}, threats: [{ actor: mage }] };
mage.effects = {};
assert(Tactics.control({ actor: caster }, caster, pvp, mage, generics, 1000));
assert(!Tactics.control({ actor: caster }, caster, pvp, mage, generics, 1001), 'failed/unfinished control is backed off');
assert(Tactics.control({ actor: caster }, caster, pvp, mage, generics, 9001));

const raider = actor(20, 45, 25);
const frenzy = skill(176, 'frenzy', { stackFamily: 'OrcBuff', condition: { actorHpPercentAtMost: 30 } }, 'self');
const guts = skill(139, 'guts', { stackFamily: 'OrcBuff', condition: { actorHpPercentAtMost: 30 } }, 'self');
raider.skills = [frenzy, guts];
assert.strictEqual(Self.selfAction(raider, { activeMobs: 1 }).skill, frenzy);
raider.effects.frenzy = { id: 176, key: 'frenzy', stackFamily: 'OrcBuff', expiresAt: Date.now() + 60000 };
assert.strictEqual(Self.selfAction(raider, { activeMobs: 2 }), null, 'target count changes must not oscillate OrcBuff');
raider.effects = {}; raider.hp = 31;
assert.strictEqual(Self.selfAction(raider, { activeMobs: 1 }), null);

const singer = actor(21, 21, 40);
const ud = skill(110, 'ultimate_defense', { effectType: 'buff' }, 'self');
singer.skills = [ud];
assert.strictEqual(Self.selfAction(singer, { raidBoss: true, activeMobs: 1, target: warrior }).skill, ud,
    'a SwS holding an add can use learned UD even though its role is buffer');
warrior.x = 1000;
assert.strictEqual(Self.selfAction(singer, { raidBoss: true, activeMobs: 1, target: warrior }), null,
    'UD must not freeze a knight before reaching weapon range');
warrior.x = 0;

const root = skill(1201, 'root');
caster.skills = [sleep, root];
assert.strictEqual(Self.supportCrowdControl(caster, [warrior], { raid: true, primaryTargetId: warrior.fetchId() }).skill, root,
    'a single focused minion may be rooted, never slept');
warrior.effects.root = { id: 1201, key: 'root', type: 'debuff', expiresAt: Date.now() + 60000 };
assert.strictEqual(Self.supportCrowdControl(caster, [warrior], { raid: true }), null, 'an immobilized add needs no repeated control');
warrior.effects = {};
caster.skills = [sleep];
assert.strictEqual(Self.supportCrowdControl(caster, [warrior], { raid: true, primaryTargetId: warrior.fetchId() }), null);
assert.strictEqual(Self.supportCrowdControl(caster, [warrior], { raid: true }).skill, sleep);
assert.strictEqual(Self.supportCrowdControl(caster, [warrior], { raid: true, canAttempt: () => false }), null);
warrior.x = 1000;
assert.strictEqual(Self.supportCrowdControl(caster, [warrior], { raid: true }), null, 'control does not chase distant adds');
warrior.x = 0;
const stun = skill(260, 'stun');
singer.skills = [stun];
assert.strictEqual(Self.supportCrowdControl(singer, [warrior], { raid: true }).skill, stun, 'control uses learned capabilities, not caster-role labels');

const Awareness = invoke('GameServer/Bot/AI/PartyAwareness');
const oldRadiusQuery = World.fetchNpcsInRadius;
let mobTarget = warrior.fetchId();
World.fetchNpcsInRadius = () => [{ fetchAttackable: () => true, isDead: () => false,
    fetchDestId: () => mobTarget, getHating: () => 100 }];
try {
    assert(Awareness.npcThreateningActor(session), 'ordinary threat discovery still sees heal hate');
    assert.strictEqual(Awareness.underDirectNpcAttack(session), false, 'heal hate alone must not block sitting or resurrection');
    mobTarget = healer.fetchId();
    assert.strictEqual(Awareness.underDirectNpcAttack(session), true, 'a mob actually targeting the healer blocks recovery');
} finally { World.fetchNpcsInRadius = oldRadiusQuery; }

const scout = actor(30, 22), mob = { fetchAttackable: () => true };
assert(!Ranged.isAutonomousArcher({}, scout, mob));
scout.weapon = 'Weapon.Bow';
assert(Ranged.isAutonomousArcher({}, scout, mob));
assert(!Ranged.isAutonomousArcher({ partyCompanion: true }, scout, mob));

// Native ally targeting, including non-party clan members and capacity.
const overlord = actor(40, 51, 100, 0, 77), clanMate = actor(41, 46, 100, 100, 77), stranger = actor(42, 46);
const paagrio = skill(1003, 'power_of_paagrio', { radius: 1000, effectType: 'buff' }, 'ally');
World.user = { sessions: [overlord, clanMate, stranger].map(actor => ({ actor })) };
assert(Support.isUsefulForTarget(clanMate, paagrio, overlord));
assert(!Support.isUsefulForTarget(stranger, paagrio, overlord));
for (let i = 0; i < 20; i++) clanMate.effects[`buff${i}`] = { id: 5000 + i, key: `buff${i}`, type: 'buff', expiresAt: Date.now() + 60000 };
assert(!Support.canPlanSupportAction(overlord, overlord, paagrio, [{ actor: overlord }]), 'unlisted clan recipient capacity still matters');
console.log('Class intent checks passed: control, PvP support, retries, self buffs, loadout and native ally scope');
