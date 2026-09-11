const assert = require('assert');
require('../src/Global');
const World = invoke('GameServer/World/World');
const Geodata = invoke('GameServer/Geodata/GeodataEngine');
const Finisher = invoke('GameServer/Bot/AI/BotEmergencyFinisher');
const Hunting = invoke('GameServer/Bot/AI/States/HuntingState');
const BotAI = invoke('GameServer/Bot/BotAI');

function actor(id, hp, pAtk) {
    return {
        fetchId: () => id, fetchName: () => `actor_${id}`,
        fetchHp: () => hp, fetchMaxHp: () => 1000,
        fetchMp: () => 0, fetchMaxMp: () => 100,
        fetchCollectivePAtk: () => pAtk, fetchCollectivePDef: () => 100,
        fetchCollectiveMAtk: () => 100, fetchCollectiveMDef: () => 100,
        fetchCollectiveAtkSpd: () => 500, fetchCollectiveCastSpd: () => 500,
        fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0,
        fetchLevel: () => 5, fetchClassId: () => 0, fetchKarma: () => 0,
        fetchAttackable: () => true, isDead: () => false,
        activeBuffs: { windWalk: Date.now() + 600000, shield: Date.now() + 600000, haste: Date.now() + 600000 },
        state: { fetchDead: () => false, fetchTowards: () => false, fetchHits: () => false,
            fetchCasts: () => false, fetchSeated: () => false },
        backpack: { fetchTotalWeaponKind: () => 'Weapon.Sword', fetchEquippedWeapon: () => null,
            fetchItemFromSelfId: () => ({ fetchAmount: () => 100 }) },
        select() {}, unselect() {}, moveTo() {}, skillset: { skills: [] }
    };
}
const bot = actor(2000001, 300, 100);
const mob = actor(1001, 30, 10);
const session = { actor: bot, accountId: 'bot_finish', plan: 'hunting',
    incomingThreatId: 1001, incomingThreatAt: Date.now() };
mob.fetchDestId = () => bot.fetchId();
World.user = { sessions: [session] };
World.npc = { spawns: [mob] };
World.fetchNpcsInRadius = () => [mob];
Geodata.hasLineOfSight = () => true;
const output = { attacks: [], skills: [],
    attackExec(_s, _b, data) { this.attacks.push(data); },
    skillExec(_s, _b, data) { this.skills.push(data); } };
const originalRandom = Math.random;
Math.random = () => 0.5;

const decision = Finisher.evaluate(session, bot, mob);
assert(decision && decision.estimatedHits === 1, 'one affordable hit should beat emergency retreat');
Hunting.tick(session, bot, output, BotAI);
assert.strictEqual(session.plan, 'hunting');
assert.strictEqual(output.attacks.length, 1, 'hunting must execute the proven finisher, even at zero MP');
assert.strictEqual(session.lastCombatDecision.reason, 'safe_emergency_finisher');

bot.fetchHp = () => 110;
assert.strictEqual(Finisher.evaluate(session, bot, mob), null, 'do not trade lethal damage for a last hit');
bot.fetchHp = () => 300;
mob.fetchHp = () => 200;
assert.strictEqual(Finisher.evaluate(session, bot, mob), null, 'small percentage HP is not necessarily a quick kill');
mob.fetchHp = () => 30;
const add = actor(1002, 1000, 100);
add.fetchDestId = () => bot.fetchId();
World.fetchNpcsInRadius = () => [mob, add];
assert.strictEqual(Finisher.evaluate(session, bot, mob), null, 'include damage from other attackers');
Hunting.tick(session, bot, output, BotAI);
assert.strictEqual(session.plan, 'fleeing', 'new add must restore actual retreat on the next tick');
assert.strictEqual(output.attacks.length, 1);
World.fetchNpcsInRadius = () => [mob];
session.plan = 'hunting';
session.incomingThreatId = undefined;
session.currentTargetId = mob.fetchId();
Hunting.tick(session, bot, output, BotAI);
assert.strictEqual(session.plan, 'hunting', 'selected live encounter also permits safe finishing');
assert.strictEqual(output.attacks.length, 2);
bot.fetchCollectiveAtkSpd = () => 100;
assert.strictEqual(Finisher.evaluate(session, bot, mob), null, 'slow attacks exceed the finishing window');
bot.fetchCollectiveAtkSpd = () => 500;
mob.fetchLocX = () => 600;
assert.strictEqual(Finisher.evaluate(session, bot, mob), null, 'do not chase a dying target');
bot.backpack.fetchTotalWeaponKind = () => 'Weapon.Bow';
BotAI.executeCombat(session, bot, mob, output, { emergencyFinisher: true });
assert.strictEqual(output.attacks.length, 3, 'a safe bow finisher must reach the attack executor');
mob.fetchPassiveSkills = () => [{ fetchPassive: () => true, fetchSelfId: () => 4071, fetchLevel: () => 5 }];
assert.strictEqual(Finisher.evaluate(session, bot, mob), null, '90% bow resistance turns one apparent hit into an unsafe long fight');
mob.fetchPassiveSkills = () => [];
bot.backpack.fetchTotalWeaponKind = () => 'Weapon.Sword';
bot.fetchClassId = () => 10;
bot.fetchMp = () => 10;
const nuke = {
    fetchSelfId: () => 1234, fetchPassive: () => false, fetchSemantic: () => ({}),
    fetchSkillType: () => 'damage', fetchTargetKind: () => 'enemy', fetchSpell: () => true,
    fetchDistance: () => 600, fetchPower: () => 100, fetchConsumedMp: () => 5,
    fetchConsumedHp: () => 0, fetchHitTime: () => 1000
};
bot.skillset.skills = [nuke];
BotAI.executeCombat(session, bot, mob, output, { emergencyFinisher: true });
assert.strictEqual(output.skills[0]?.selfId, 1234, 'low-MP mage must use an affordable lethal nuke');
nuke.fetchSemantic = () => ({ trait: 'fire' });
mob.fetchHp = () => 100;
assert(Finisher.evaluate(session, bot, mob), 'the unresisted nuke can finish this target');
mob.fetchPassiveSkills = () => [{ fetchPassive: () => true, fetchSelfId: () => 4009, fetchLevel: () => 5 }];
assert.strictEqual(Finisher.evaluate(session, bot, mob), null, 'elemental resistance must apply to lethal spell estimates');
mob.fetchPassiveSkills = () => [];
mob.fetchHp = () => 30;
bot.attack = { activeCast: { target: mob, skill: nuke, landsAt: Date.now() + 500 } };
bot.state.fetchCasts = () => true;
bot.canUseSkill = () => false;
session.currentTargetId = mob.fetchId();
session.incomingThreatId = mob.fetchId();
session.incomingThreatAt = Date.now();
const inFlight = Finisher.evaluate(session, bot, mob);
assert(inFlight && inFlight.finishMs <= 1500, 'use remaining cast time despite reuse having started');
Hunting.tick(session, bot, output, BotAI);
assert.strictEqual(session.plan, 'hunting', 'an accepted lethal cast must not switch to fleeing on the next tick');
assert.strictEqual(output.skills.length, 1, 'waiting for the accepted cast must not recast it');
bot.attack.activeCast.target = add;
assert.strictEqual(Finisher.evaluate(session, bot, mob), null, 'selected target cannot disguise a cast against another actor');
bot.attack.activeCast.target = mob;
bot.attack.activeCast.landsAt = Date.now() - 1;
assert.strictEqual(Finisher.evaluate(session, bot, mob), null, 'expired cast metadata cannot keep a bot fighting');
bot.attack.activeCast.landsAt = Date.now() + 500;
World.fetchNpcsInRadius = () => [mob, add];
assert.strictEqual(Finisher.evaluate(session, bot, mob), null, 'incoming damage is still checked during a cast');
World.fetchNpcsInRadius = () => [mob];
bot.attack.activeCast = null;
assert.strictEqual(Finisher.evaluate(session, bot, mob), null, 'a stale casting flag alone is insufficient');
bot.state.fetchCasts = () => false;
bot.canUseSkill = () => true;
bot.fetchMp = () => 4;
assert.strictEqual(Finisher.evaluate(session, bot, mob), null, 'unaffordable skill cannot justify staying');
bot.fetchMp = () => 10;
bot.canUseSkill = () => false;
assert.strictEqual(Finisher.evaluate(session, bot, mob), null, 'cooldown prevents a finisher');
bot.canUseSkill = () => true;
Geodata.hasLineOfSight = () => false;
assert.strictEqual(Finisher.evaluate(session, bot, mob), null, 'blocked line of sight prevents a finisher');
Geodata.hasLineOfSight = () => true;
mob.fetchIsRaidBoss = () => true;
assert.strictEqual(Finisher.evaluate(session, bot, mob), null, 'raid protection wins even at one hit');
mob.fetchIsRaidBoss = () => false;
session.partyCompanion = true;
assert.strictEqual(Finisher.evaluate(session, bot, mob), null, 'player companions keep their own tactics');
session.partyCompanion = false;
mob.state.fetchCasts = () => true;
assert.strictEqual(Finisher.evaluate(session, bot, mob), null, 'an unestimated incoming spell must not count as a normal swing');
mob.state.fetchCasts = () => false;
const Restrictions = invoke('GameServer/Effects/EffectRestrictions');
const canCast = Restrictions.canCast;
Restrictions.canCast = () => false;
assert.strictEqual(Finisher.evaluate(session, bot, mob), null, 'silenced caster cannot rely on a nuke');
Restrictions.canCast = canCast;
bot.state.fetchCasts = () => true;
session.currentTargetId = 9999;
assert.strictEqual(Finisher.evaluate(session, bot, mob), null, 'a cast on another target cannot be counted as finishing this mob');
bot.state.fetchCasts = () => false;
session.currentTargetId = mob.fetchId();
session.currentSpot = { id: 'test_catacomb', tags: ['catacomb'], minLevel: 1, maxLevel: 10 };
invoke('GameServer/Bot/AI/SpotService').findCurrentSpot = () => null;
Hunting.tick(session, bot, output, BotAI);
assert.strictEqual(session.plan, 'fleeing', 'unsafe hunting ground wins over a lethal skill');
Math.random = originalRandom;
console.log('Emergency finisher checks passed');
