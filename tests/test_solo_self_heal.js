'use strict';
// Solo self-heal (our choice): a solo bot on mobs heals
// itself by one rule, hot and cold: in a fight only when it would not outlive
// the mob otherwise, between fights when the heal beats sitting.
const assert = require('node:assert/strict');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Heal = invoke('GameServer/Bot/AI/SoloSelfHeal');
const Rules = invoke('GameServer/Skills/C4SkillRules');
const HuntCycle = invoke('GameServer/Bot/AI/HuntCycle');
const ColdCombatProfile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const ColdClassPolicy = invoke('GameServer/Bot/Population/ColdClassPolicy');

// A healer at the edge the rule reads (the hot actor's API): one heal of
// `power` HP for `mp` MP, cast in about a second, ready in `readyInMs`.
function healer({ hp, maxHp = 1000, mp = 500, maxMp = 500, power = 300, cost = 30, seatedHp = 0.01, seatedMp = 0.01, classId = 0, readyInMs = 0 }) {
    const skill = { fetchSelfId: () => 1011, fetchPassive: () => false, fetchSpell: () => true, fetchHitTime: () => 1000,
        fetchPower: () => power, fetchConsumedMp: () => cost, fetchReuseTime: () => 0, fetchTargetKind: () => 'friendly',
        fetchSemantic: () => ({ skillType: Rules.HEAL, target: 'friendly' }) };
    return { fetchHp: () => hp, fetchMaxHp: () => maxHp, fetchMp: () => mp, fetchMaxMp: () => maxMp, fetchClassId: () => classId,
        fetchLevel: () => 40, fetchCastSpd: () => 333, fetchAtkSpd: () => 300, fetchSeatedHpPerMs: () => seatedHp,
        fetchSeatedMpPerMs: () => seatedMp, skillReadyInMs: () => readyInMs, canUseSkill: () => readyInMs <= 0,
        skillset: { skills: [skill] } };
}

// In a fight: no heal while the bot outlives the mob at the fight's pace.
assert.equal(Heal.inFight(healer({ hp: 600 }), { mobHp: 1000, dealtPerMs: 1, takenPerMs: 0.5 }), null,
    'the mob dies in 1 s, the bot loses 500 of 600: it fights on');
assert.ok(Heal.inFight(healer({ hp: 400 }), { mobHp: 1000, dealtPerMs: 0.5, takenPerMs: 0.25 }),
    'losing 500 of 400 before the mob dies: it heals (300 HP against 250 lost in the cast)');
assert.equal(Heal.inFight(healer({ hp: 400, power: 300 }), { mobHp: 10000, dealtPerMs: 1, takenPerMs: 0.4 }), null,
    'a heal smaller than the damage taken during its cast is not cast');
assert.equal(Heal.inFight(healer({ hp: 100 }), { mobHp: 1000, dealtPerMs: 1, takenPerMs: 0 }), null,
    'a fight that has not hurt the bot yet asks for no heal');

// Between fights: heal when it gives HP faster than sitting, never more than is missing.
assert.ok(Heal.betweenFights(healer({ hp: 500, seatedHp: 0.01 })), '300 HP in about a second beats 10 HP a second seated');
assert.equal(Heal.betweenFights(healer({ hp: 800 })), null, 'missing 200: a 300 HP heal waits');
assert.equal(Heal.betweenFights(healer({ hp: 500, seatedHp: 1 })), null, 'sitting at 1000 HP a second beats the heal');

// A heal on its reuse replaces a rest, never a fight, and its wait is priced:
// between fights the bot does not wait for it; where it would sit down it
// waits on its feet while the heal, wait included, beats sitting.
assert.equal(Heal.betweenFights(healer({ hp: 500, readyInMs: 4000 })), null, 'between fights a heal on its reuse is not waited for');
assert.ok(Heal.betweenFights(healer({ hp: 500, seatedHp: 0.03 })), 'ready, the heal beats 30 HP a second seated');
assert.equal(Heal.betweenFights(healer({ hp: 500, seatedHp: 0.03, readyInMs: 10000 }), { wait: true }), null,
    'a 10 s wait makes the same heal slower than sitting: the bot sits');
assert.equal(Heal.betweenFights(healer({ hp: 500, seatedHp: 0.01, readyInMs: 10000 }), { wait: true })?.waitMs, 10000,
    'against 10 HP a second seated the heal is waited for');
// A level-5 Human Mystic (Self Heal: reuse 10 s, cast 5 s) at 30% HP, its
// Self Heal back in 4 s, sitting at about 1 HP a second.
const mystic = ColdCombatProfile.profileFor(HuntCycle.referenceState(10, 5), 0, { store: false });
const wounded = ColdClassPolicy.actorFor(mystic, { hp: mystic.maxHp * 0.3, mp: mystic.maxMp, cooldowns: { 1216: 4000 }, time: 0 });
assert.equal(Heal.betweenFights(wounded), null, 'between fights the mystic walks on');
const coming = Heal.betweenFights(wounded, { wait: true });
assert.equal(coming?.skill.fetchSelfId(), 1216, 'where it would sit, the mystic waits for its Self Heal');
assert.equal(coming.waitMs, 4000, 'the wait is the reuse left');
// At 50% HP and 15% MP the mystic sits for MP anyway, and that rest brings
// its HP back too: no heal, ready or on its reuse.
const drained = (cooldowns) => ColdClassPolicy.actorFor(mystic, { hp: mystic.maxHp * 0.5, mp: mystic.maxMp * 0.15, cooldowns, time: 0 });
assert.equal(Heal.betweenFights(drained({ 1216: 9000 }), { wait: true }), null, 'at 15% MP the mystic does not wait for its heal');
assert.equal(Heal.betweenFights(drained({}), { wait: true }), null, 'at 15% MP the mystic does not cast its ready heal');

// A silenced bot casts nothing, in a fight or between fights: a heal would be
// refused at the cast, so the turn goes to its weapon and the walk goes on.
const EffectStore = invoke('GameServer/Effects/EffectStore');
const silence = (actor) => { EffectStore.apply(actor, { key: 'silence', id: 1064, type: 'debuff', durationMs: 60000 }); return actor; };
const hot = (actor) => Object.assign(actor, { state: { fetchCasts: () => false }, fetchId: () => 1 });
const casts = [];
const generics = { skillExec: (session, bot, data) => casts.push(data) };
const mob = { fetchId: () => 7, fetchHp: () => 1000 };
// The bot's HP fell from 500 to 400 in the fight's last second, the mob's did not.
const fightTurn = (actor) => Heal.tryInFight({ selfHealPace: { targetId: 7, at: Date.now() - 1000, hp: 500, mobHp: 1000, healed: 0 } }, actor, mob, generics);
assert.equal(fightTurn(hot(healer({ hp: 400 }))), true, 'unsilenced it heals in the fight');
assert.equal(casts.length, 1);
casts.length = 0;
assert.equal(fightTurn(silence(hot(healer({ hp: 400 })))), false, 'silenced it fights on');
assert.equal(Heal.tryBetweenFights({}, silence(hot(healer({ hp: 500 }))), generics), false, 'silenced it does not stop to heal between fights');
assert.deepEqual(casts, [], 'no refused cast is sent');

// The same rule reads a cold profile (ColdClassPolicy.actorFor): a level-40 Bishop between fights.
const bishop = HuntCycle.referenceState(16, 40);
const profile = ColdCombatProfile.profileFor(bishop, 0, { store: false });
const actor = ColdClassPolicy.actorFor(profile, { hp: profile.maxHp * 0.4, mp: profile.maxMp, cooldowns: {}, time: 0 });
const skill = Heal.betweenFights(actor)?.skill;
assert.ok(skill, 'a cold Bishop at 40% HP heals between fights');
assert.ok(Heal.healAmount(actor, skill, skill.fetchSemantic(), true) <= profile.maxHp * 0.6, 'its heal does not overheal');

console.log('Solo self-heal checks passed');
