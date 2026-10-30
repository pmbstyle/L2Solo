'use strict';
// T107 (docs/game-decisions.md "Solo self-heal"): a solo bot on mobs heals
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
// `power` HP for `mp` MP, cast in about a second.
function healer({ hp, maxHp = 1000, mp = 500, maxMp = 500, power = 300, cost = 30, seatedHp = 0.01, seatedMp = 0.01, classId = 0 }) {
    const skill = { fetchSelfId: () => 1011, fetchPassive: () => false, fetchSpell: () => true, fetchHitTime: () => 1000,
        fetchPower: () => power, fetchConsumedMp: () => cost, fetchReuseTime: () => 0, fetchTargetKind: () => 'friendly',
        fetchSemantic: () => ({ skillType: Rules.HEAL, target: 'friendly' }) };
    return { fetchHp: () => hp, fetchMaxHp: () => maxHp, fetchMp: () => mp, fetchMaxMp: () => maxMp, fetchClassId: () => classId,
        fetchLevel: () => 40, fetchCastSpd: () => 333, fetchAtkSpd: () => 300, fetchSeatedHpPerMs: () => seatedHp,
        fetchSeatedMpPerMs: () => seatedMp, canUseSkill: () => true, skillset: { skills: [skill] } };
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

// The same rule reads a cold profile (ColdClassPolicy.actorFor): a level-40 Bishop between fights.
const bishop = HuntCycle.referenceState(16, 40);
const profile = ColdCombatProfile.profileFor(bishop, 0, { store: false });
const actor = ColdClassPolicy.actorFor(profile, { hp: profile.maxHp * 0.4, mp: profile.maxMp, cooldowns: {}, time: 0 });
const skill = Heal.betweenFights(actor);
assert.ok(skill, 'a cold Bishop at 40% HP heals between fights');
assert.ok(Heal.healAmount(actor, skill, skill.fetchSemantic(), true) <= profile.maxHp * 0.6, 'its heal does not overheal');

console.log('Solo self-heal checks passed');
