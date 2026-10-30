'use strict';
// T135 (docs/game-decisions.md "Summoner keeps its pet alive"): a summoner
// heals its pet below PetHealRule's line, cold between fights and in a fight,
// and spends its own MP and the heal's reuse on it.
const assert = require('node:assert/strict');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Rule = invoke('GameServer/Bot/AI/PetHealRule');
const Resolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const HuntCycle = invoke('GameServer/Bot/AI/HuntCycle');
const ColdCombatProfile = invoke('GameServer/Bot/Population/ColdCombatProfile');

assert.equal(Rule.wantsHeal(400, 1000), true, 'a pet at 40% wants a heal');
assert.equal(Rule.wantsHeal(800, 1000), false, 'a pet at 80% does not');
assert.equal(Rule.wantsHeal(0, 1000), false, 'a dead pet is not healed');

// A level-30 Elemental Summoner's cold profile (the author's kit) and its pet.
const state = HuntCycle.referenceState(11, 30, { line: 14 });
const profile = ColdCombatProfile.profileFor(state, 0);
assert.ok(profile?.skills?.some(skill => Rule.isPetHeal(skill)), 'the summoner has Servitor Heal');

const pet = () => ({ active: true, hp: 200, maxHp: 1000, expiresAt: Infinity });
const vitals = { hp: profile.maxHp, mp: profile.maxMp };
const summon = pet();
Resolver.coldHealBetweenFights(profile, vitals, {}, 0, summon);
assert.ok(summon.hp > 200, `between fights the pet is healed (${summon.hp})`);
assert.ok(vitals.mp < profile.maxMp, 'the owner pays the MP');

const unhurt = { active: true, hp: 900, maxHp: 1000 };
Resolver.coldHealBetweenFights(profile, { hp: profile.maxHp, mp: profile.maxMp }, {}, 0, unhurt);
assert.equal(unhurt.hp, 900, 'a pet above its line is left to its regeneration');
const dry = pet();
Resolver.coldHealBetweenFights(profile, { hp: profile.maxHp, mp: 0 }, {}, 0, dry);
assert.equal(dry.hp, 200, 'without MP no heal');
const expired = { ...pet(), expiresAt: -1 };
Resolver.coldHealBetweenFights(profile, { hp: profile.maxHp, mp: profile.maxMp }, {}, 0, expired);
assert.equal(expired.hp, 200, 'a pet past its lifetime is not healed');

// A level-48 summoner has Servitor Cure (1300) too: with Servitor Heal on its
// reuse it casts nothing on the pet (a cleanse is no heal).
const high = ColdCombatProfile.profileFor(HuntCycle.referenceState(14, 48), 0);
const cure = high.skills.find(skill => skill.selfId === 1300);
assert.ok(cure && !Rule.isPetHeal(cure), 'Servitor Cure is not a pet heal');
const healIds = high.skills.filter(skill => Rule.isPetHeal(skill)).map(skill => skill.selfId);
assert.deepEqual(healIds, [1127], 'Servitor Heal is');
const waiting = pet();
Resolver.coldHealBetweenFights(high, { hp: high.maxHp, mp: high.maxMp }, { 1127: 1e9 }, 0, waiting);
assert.equal(waiting.hp, 200, 'Servitor Heal on its reuse: no cure cast for a heal');
console.log('test_pet_heal: ok');
