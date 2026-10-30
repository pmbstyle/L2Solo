'use strict';
// T122: a Wizard heading for Warlock fights 20-39 with the cat it learns at
// 20, as in C4, hot and cold through the summoner owners (BotRoles.isSummoner
// by its future second class, BotRoles.kitClassId); the pet takes the hits.
// A future Sorcerer, a player and a class-only Wizard fight without it.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
require('../src/Global');
const DataCache = invoke('GameServer/DataCache');
DataCache.init();
const Progression = invoke('GameServer/Bot/BotClassProgression');
const Cold = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Match = invoke('GameServer/Bot/AI/BotTargetMatchup');
const Tactics = invoke('GameServer/Bot/AI/SummonerTactics');
const Table = invoke('GameServer/Bot/AI/SpotValueTable');
const HuntCycle = invoke('GameServer/Bot/AI/HuntCycle');
const Skill = invoke('GameServer/Model/Skill');
const PveEncounter = require('../src/GameServer/Bot/Population/ColdPveEncounter');
const Resolver = invoke('GameServer/Bot/Population/BackgroundResolver');
// One fight is module-private (as test_cold_combat_parity): a second copy of
// the resolver that also exports it.
const full = path.join(__dirname, '../src/GameServer/Bot/Population/BackgroundResolver.js');
const copy = new Module(full, module);
copy.filename = full;
copy.paths = Module._nodeModulePaths(path.dirname(full));
copy._compile(`${fs.readFileSync(full, 'utf8')}\nmodule.exports.__resolveFight = resolveFight;`, full);
const resolveFight = copy.exports.__resolveFight;

const WIZARD = 11, SORCERER = 12, WARLOCK = 14, LEVEL = 30, TS = 1_791_060_000_000;
const KAT = 1111, MOB = 251; // Summon Kat the Cat; Delu Lizardman, level 28
const idsWithFuture = (future, count = 2) => {
    const ids = [];
    for (let id = 1; ids.length < count; id++) if (Progression.futureClass(WIZARD, id) === future) ids.push(id);
    return ids;
};
const [warlockId, playerId] = idsWithFuture(WARLOCK);
const [sorcererId] = idsWithFuture(SORCERER);

// A Wizard 30 with its whole learned tree (the cat among it), as a cold row.
function wizard(characterId, extra = {}) {
    const state = { ...(characterId ? { characterId } : {}), name: `Wizard${characterId}`, level: LEVEL, classId: WIZARD,
        activity: 'hunting', stats: { classId: WIZARD, role: 'mage' }, inventory: {}, vitals: {}, ...extra };
    state.stats.coldCombat = Cold.legacySnapshot(state, Cold.skillRecordsFromTree(WIZARD, LEVEL), TS);
    const profile = Cold.profileFor(state, TS);
    return { ...state, vitals: { hp: profile.maxHp, maxHp: profile.maxHp, mp: profile.maxMp, maxMp: profile.maxMp } };
}
const warlock = wizard(warlockId), sorcerer = wizard(sorcererId);
const player = wizard(playerId, { accountName: 'player1' }), classOnly = wizard(null);
assert(warlock.stats.coldCombat.skills.some((skill) => Number(skill.selfId) === KAT), 'a Wizard 30 has learned the cat');

// Cold: the fight raises the cat, and the mob strikes it, not its owner.
const npc = DataCache.npcs.find((row) => row.selfId === MOB);
const spot = { id: 'future-pet', name: 'future pet', avgLevel: npc.template.level, minLevel: npc.template.level,
    maxLevel: npc.template.level, density: 30, npcEntries: [{ selfId: MOB, count: 1 }], npcSelfIds: [MOB],
    rewards: { exp: 1, sp: 1, adenaMin: 0, adenaMax: 0 }, center: { x: 0, y: 0, z: 0 } };
// An engaged fight (the mob met), seeded.
function fight(state) {
    const mob = Cold.npcForSpot(spot, () => 0.5, { preferredNpcId: MOB });
    const encounter = PveEncounter.save(null, PveEncounter.key([state], spot, MOB), mob, mob.maxHp, TS,
        { botReadyAt: 0, mobReadyAt: 0 });
    let seed = 7;
    const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    return resolveFight({ state: { ...state, stats: { ...state.stats, pveEncounter: encounter } }, spot, pressure: {},
        targetNpcId: MOB, rng, timestamp: TS, fightLimitMs: 60000, maxActions: 400 });
}
const pet = fight(warlock);
assert(pet.debug.summonUses > 0, 'a future Warlock Wizard summons its servitor');
assert(pet.debug.petTaken > 0, 'the mob strikes the pet');
if (!pet.debug.summonDeaths) assert.equal(pet.debug.damageTaken, 0, 'the owner is untouched while its pet stands');
for (const [name, state] of [['future Sorcerer', sorcerer], ['player', player], ['class-only', classOnly]]) {
    const result = fight(state);
    assert.equal(result.debug.summonUses || 0, 0, `a ${name} Wizard summons nothing`);
    assert.equal(result.debug.petTaken || 0, 0, `a ${name} Wizard has no pet to take the hits`);
    assert(result.debug.damageTaken > 0, `a ${name} Wizard takes the hits itself`);
}

// The pet keeps the HP it lost across its owner's turns: a long fight wears
// it down whole (its full HP, not one gap's worth), it dies once (its
// summons on their 6 h reuse raise no other), and then the mob strikes the
// owner.
{
    const profile = Cold.profileFor(warlock, TS);
    const katHp = invoke('GameServer/Bot/Population/ColdSummonProfile')(profile,
        Cold.summonDetails(Cold.summonSkills(profile).find((skill) => skill.selfId === KAT))).maxHp;
    const reuse = Object.fromEntries(Cold.summonSkills(profile).map((skill) => [skill.selfId, TS + 21600000]));
    const strong = Cold.npcForSpot(spot, () => 0.5, { preferredNpcId: MOB });
    const encounter = PveEncounter.save(null, PveEncounter.key([warlock], spot, MOB), { ...strong, maxHp: 1e7 }, 1e7, TS,
        { botReadyAt: 0, mobReadyAt: 0 });
    const state = { ...warlock, stats: { ...warlock.stats, pveEncounter: encounter, coldCombat: { ...warlock.stats.coldCombat,
        cooldowns: reuse, summon: { active: true, skillId: KAT, expiresAt: TS + 1e6, hp: katHp } } } };
    let seed = 11;
    const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const worn = resolveFight({ state, spot, pressure: {}, targetNpcId: MOB, rng, timestamp: TS, fightLimitMs: 180000, maxActions: 2000 });
    assert.equal(worn.debug.summonUses, 0);
    assert.equal(worn.debug.summonDeaths, 1, 'the pet dies of the blows summed over the fight');
    assert(worn.debug.petTaken >= katHp && worn.debug.petTaken < 2 * katHp, `the pet took its own HP (${worn.debug.petTaken} of ${katHp})`);
    assert(worn.debug.damageTaken > 0, 'with the pet down the mob strikes its owner');
}

// Each fight's readiness reads the pet beside the bot now
// (BotTargetMatchup.servitorProfile), not the round's: a mob the Warlock
// beats only with its cat (Delu Lizardman Supplier, 344) is declined once
// the cat died this round (its summons on their 6 h reuse) or is down to 1 HP.
{
    const SUPPLIER = 344;
    const supplierNpc = DataCache.npcs.find((row) => row.selfId === SUPPLIER);
    const field = { ...spot, id: 'pet-readiness', avgLevel: supplierNpc.template.level, minLevel: supplierNpc.template.level,
        maxLevel: supplierNpc.template.level, npcEntries: [{ selfId: SUPPLIER, count: 1 }], npcSelfIds: [SUPPLIER] };
    const profile = Cold.profileFor(warlock, TS);
    const reuse = Object.fromEntries(Cold.summonSkills(profile).map((skill) => [skill.selfId, TS + 21600000]));
    const later = (summon) => ({ ...warlock, stats: { ...warlock.stats,
        coldCombat: { ...warlock.stats.coldCombat, cooldowns: reuse, summon } } });
    // A saved pet carries its numbers (BackgroundResolver.startColdSummon).
    const stats = invoke('GameServer/Bot/Population/ColdSummonProfile')(profile,
        Cold.summonDetails(Cold.summonSkills(profile).find((skill) => skill.selfId === KAT)));
    const whole = { ...stats, active: true, skillId: KAT, expiresAt: TS + 1e6, hp: stats.maxHp };
    // The round's profiles, built with the whole cat out.
    const round = Match.coldProfiles(profile, later(whole), TS);
    const target = Cold.npcCombatStats(supplierNpc);
    assert(Match.soloSurvival(round, target).eligible && !Match.soloSurvival(round.filter((p) => !p.servitor), target).eligible,
        'the Supplier is a fight for the Warlock with its cat only');
    const ready = (state) => resolveFight({ state, spot: field, pressure: {}, targetNpcId: SUPPLIER, rng: () => 0.5,
        timestamp: TS, fightLimitMs: 1, maxActions: 1, roundProfiles: round });
    const dead = ready(later(null));
    assert.deepEqual({ avoided: dead.avoided, reason: dead.reason }, { avoided: true, reason: 'solo_recovery_needed' },
        'a cat dead this round no longer tanks the next fight');
    const wounded = ready(later({ ...whole, hp: 1 }));
    assert.equal(wounded.reason, 'solo_recovery_needed', 'a cat at 1 HP tanks with that HP');
    assert(!ready(later(whole)).avoided, 'a whole cat still does');
}

// In a party the mob strikes the member its aggro holds, a summoner too: the
// pet tanks only alone (the hot SummonerTactics).
{
    const pet = { active: true, skillId: KAT, expiresAt: TS + 1e6, hp: 600 };
    const owner = { ...warlock, stats: { ...warlock.stats, coldCombat: { ...warlock.stats.coldCombat, summon: pet } } };
    const members = [owner, sorcerer];
    const strong = Cold.npcForSpot(spot, () => 0.5, { preferredNpcId: MOB });
    const encounter = PveEncounter.save(null, PveEncounter.key(members, spot, MOB), { ...strong, maxHp: 1e7 }, 1e7, TS,
        { mobReadyAt: 0, hate: { [owner.characterId]: 1e9 } });
    let seed = 5;
    const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const party = Resolver.resolvePartyFight({ members, spot, targetNpcId: MOB, rng, timestamp: TS, encounter });
    const fought = party.members.find((member) => member.state.characterId === owner.characterId);
    assert.equal(fought.summon?.hp, 600, 'the pet takes no blow in a party');
    assert(fought.vitals.hp < fought.vitals.maxHp, 'its owner, held by the aggro, does');
}

// The solo gate counts the servitor the fight raises (coldProfiles).
const profiles = (state) => Match.coldProfiles(Cold.profileFor(state, TS), state, TS);
assert.equal(profiles(warlock).filter((profile) => profile.servitor).length, 1, 'the gate sees the cat');
assert.equal(profiles(sorcerer).filter((profile) => profile.servitor).length, 0);
assert.equal(profiles(classOnly).filter((profile) => profile.servitor).length, 0);

// Hot: the summoner tactics cast the cat for a bot heading for Warlock only.
const definition = DataCache.skills.find((row) => Number(row.selfId) === KAT);
const rank = definition.levels.find((row) => Number(row.level) === 3);
const kat = new Skill({ selfId: definition.selfId, ...definition.template, ...definition.time, ...rank });
const hotWizard = (id, session) => ({ fetchId: () => id, fetchClassId: () => WIZARD, fetchLevel: () => LEVEL,
    fetchMp: () => 1000, canUseSkill: () => true, session, skillset: { fetchSkills: () => [kat] } });
const casts = [];
const Generics = { skillExec: (session, actor, request) => casts.push(request.selfId) };
const mob = { fetchId: () => 9001, fetchAttackable: () => true, isDead: () => false };
assert.equal(Tactics.combatAction({}, hotWizard(warlockId, { botSession: true }), mob, Generics).reason, 'summon_servitor');
assert.deepEqual(casts, [KAT], 'the bot casts its cat');
assert.equal(Tactics.combatAction({}, hotWizard(sorcererId, { botSession: true }), mob, Generics).reason, 'not_summoner');
assert.equal(Tactics.combatAction({}, hotWizard(warlockId, {}), mob, Generics).reason, 'not_summoner',
    'a player picks its second class itself');

// The table: a future Warlock reads the Warlock line, whose reference summons.
assert.equal(Table.roleFor(warlock), String(WARLOCK));
assert.equal(Table.roleFor(sorcerer), String(SORCERER));
const reference = (line) => fight(HuntCycle.referenceState(WIZARD, LEVEL, { line })).debug.summonUses > 0;
assert(reference(WARLOCK), 'the Warlock line reference fights with its cat');
assert(!reference(SORCERER), 'the Sorcerer line reference does not');
assert(!reference(null), 'a class-only reference Wizard keeps no pet');

console.log('test_future_summoner_pet: ok');
