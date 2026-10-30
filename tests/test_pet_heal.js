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

// T136: the rest of the summoner's pet care.
const RestPolicy = invoke('GameServer/Bot/AI/RestPolicy');
const ColdClassPolicy = invoke('GameServer/Bot/Population/ColdClassPolicy');
const Match = invoke('GameServer/Bot/AI/BotTargetMatchup');
const DataCache = invoke('GameServer/DataCache');

// One chooser on the actor API (hot and cold): the cold actor's choice is
// the pet heal; a silenced owner has none (the cast would be refused).
const actor = ColdClassPolicy.actorFor(profile, { hp: profile.maxHp, mp: profile.maxMp, cooldowns: {}, time: 0 });
assert.ok(Rule.isPetHeal(Rule.choose(actor)), 'the chooser picks the pet heal');
const silenced = { skillset: actor.skillset, fetchMp: () => profile.maxMp, canUseSkill: () => true,
    effects: { silence: { type: 'debuff', key: 'silence', expiresAt: Date.now() + 1e9 } } };
assert.equal(Rule.choose(silenced), null, 'a silenced owner casts no pet heal');
assert.equal(Rule.PET_HEAL_BELOW, invoke('GameServer/Bot/AI/PartyHealPolicy').HEAL_BELOW, 'the pet line is the party heal line');

// Rest: a pet below the bot's own HP line it cannot heal sends it to rest; a
// heal it may cast (now or after its reuse) does not; the rest ends once the
// pet is whole.
assert.equal(RestPolicy.needsRest(state, 1, 1, { pet: { ratio: 0.2, healable: false } }), true, 'an unhealable low pet rests its owner');
assert.equal(RestPolicy.needsRest(state, 1, 1, { pet: { ratio: 0.2, healable: true } }), false, 'a healable pet is healed, not rested');
assert.equal(RestPolicy.petRested({ ratio: 0.5, healable: false }), false, 'a rest waits for an unhealable pet');
assert.equal(RestPolicy.petRested({ ratio: 0.96, healable: false }), true, 'a whole pet ends the wait');
const dryOwner = { hp: profile.maxHp, maxHp: profile.maxHp, mp: 0, maxMp: profile.maxMp };
const lowPet = { ...pet(), hp: 100 };
const view = Rule.restView(ColdClassPolicy.actorFor(profile, { hp: dryOwner.hp, mp: 0, cooldowns: {}, time: 0 }), lowPet.hp, lowPet.maxHp);
assert.deepEqual(view, { ratio: 0.1, healable: false }, 'without MP the owner cannot heal its pet');
assert.equal(Resolver.needsRest(state, dryOwner, { pet: view }), true, 'cold: the owner sits for its pet');

// Shots: a pet heal loads and spends the owner's spiritshot, as the hot cast,
// and the shot boosts it; pet heals are counted apart from the owner's own.
const record = profile.skills.find(skill => Rule.isPetHeal(skill));
const inventory = { bss: { selfId: 3947, amount: 10 } };
const shooter = { shot: { spiritshot: true, blessedSpiritshot: true, left: 5, key: 'bss', perAction: 1, timestamp: 0 },
    state: { inventory }, shotActions: 0 };
const shotPet = pet();
const healed = Resolver.coldHealBetweenFights(profile, { hp: profile.maxHp, mp: profile.maxMp }, {}, 0, shotPet, { shooter });
assert.equal(healed.casts, 0, 'no own heal counted');
assert.ok(healed.petCasts >= 1, 'the pet heals counted apart');
assert.equal(shooter.shotActions, healed.petCasts, 'one spiritshot per pet heal');
assert.equal(inventory.bss.amount, 10 - healed.petCasts, 'spent from the bag');
assert.ok(Rule.amount(record, shooter.shot) > Rule.amount(record), 'a blessed spiritshot boosts the pet heal');

// Party: a summoner in a party heals its pet after a won fight, saved with it.
const member = { profile, vitals: { hp: profile.maxHp, mp: profile.maxMp }, cooldowns: {}, summon: pet(),
    state: { characterId: 1, stats: { coldCombat: {} } } };
assert.ok(Resolver.healPartyPetsBetweenFights([member], 0).petCasts >= 1, 'a party summoner heals its pet between fights');
assert.ok(member.state.stats.coldCombat.summon.hp > 200, 'the healed pet is saved');

// The solo gate counts the heals: a pet its owner heals outlives one it does not.
const round = Match.coldProfiles(profile, state, 0);
const servitor = round.find(one => one.servitor);
assert.ok(servitor?.petSustain?.amount > 0, 'the gate\'s pet carries its owner\'s heal');
const npc = DataCache.npcs.find(row => row.selfId === 344);
const target = ColdCombatProfile.npcCombatStats(npc);
const withHeal = Match.soloSurvival(round, target).survivalRatio;
const without = Match.soloSurvival(round.map(one => one.servitor ? { ...one, petSustain: null } : one), target).survivalRatio;
assert.ok(withHeal > without, `the healed pet holds longer (${withHeal} > ${without})`);
assert.equal(Rule.healedLifetime(100, 10, null, 0), 10, 'no heal: HP over damage');
assert.equal(Rule.healedLifetime(100, 10, { amount: 50, mp: 10, castMs: 1000, reuseMs: 5000 }, 20), 20,
    'two paid heals: HP and both heals over damage');
console.log('test_pet_heal: ok');
