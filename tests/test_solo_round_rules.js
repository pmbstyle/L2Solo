'use strict';

const assert = require('node:assert/strict');
require('../src/Global');
invoke('GameServer/DataCache').init();

// T106 (user 10-29, docs/game-decisions.md "Bot behaviour"): a cold solo
// round's kills follow the walk to the next mob, a solo bot buffs itself, and
// a bot that heals itself with MP sits for MP.
const Cold = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Resolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const RestPolicy = invoke('GameServer/Bot/AI/RestPolicy');
const HuntCycle = invoke('GameServer/Bot/AI/HuntCycle');
const T = 1_750_000_000_000;
const originalNpc = Cold.npcForSpot;

function bot(classId, level, extra = {}) {
    const state = HuntCycle.referenceState(classId, level);
    const profile = Cold.profileFor(state, T, { store: false });
    state.vitals = { hp: profile.maxHp, maxHp: profile.maxHp, mp: profile.maxMp, maxMp: profile.maxMp };
    state.stats = { ...state.stats, ...extra };
    return state;
}
const field = density => ({ id: `walk_${density}`, name: 'Walk field', minLevel: 10, maxLevel: 10, avgLevel: 10,
    density, rewards: { exp: 10, sp: 1, adenaMin: 1, adenaMax: 1 } });
const round = (state, spot, elapsedMs = 60000, timestamp = T) => Resolver.resolveSolo({ state: structuredClone(state), spot,
    elapsedMs, timestamp, rng: () => 0.5 });

try {
    // A mob the bot kills with its first hit: the walk between kills is all the round holds.
    Cold.npcForSpot = () => ({ level: 10, maxHp: 1, pAtk: 1, pAtkRnd: 0, pDef: 1, mDef: 1, accur: 1,
        evasion: 0, critical: 0, atkSpd: 253 });
    const fighter = bot(0, 10);
    const runSpd = Cold.fightProfile(fighter, T).runSpd;
    assert(runSpd > 100, `a Human Fighter runs at its template speed (${runSpd})`);
    for (const density of [9, 36]) {
        // It stops at its weapon's reach from the mob.
        const walkMs = Resolver.soloWalkMs(density, runSpd, undefined, Cold.attackReach(Cold.fightProfile(fighter, T)));
        const result = round(fighter, field(density));
        // Every walk begun in the minute ends in a kill, the last by its opening blow.
        assert.equal(result.debug.wins, Math.ceil(60000 / walkMs), `density ${density}: one kill per walk of ${walkMs} ms`);
        assert.equal(result.debug.walkedMs, result.debug.wins * walkMs);
    }
    // Four times the monsters halve the walk.
    assert(Math.abs(Resolver.soloWalkMs(36, runSpd) * 2 - Resolver.soloWalkMs(9, runSpd)) <= 1);
    // A faster run (Wind Walk) shortens the walk.
    const windWalk = { key: 'wind_walk', id: 1204, level: 2, type: 'buff', expiresAt: T + 1200000, stats: { runSpdAdd: 33 } };
    const fast = bot(0, 10, { coldCombat: { ...fighter.stats.coldCombat, effects: [windWalk] } });
    assert(round(fast, field(9)).debug.wins > round(fighter, field(9)).debug.wins, 'Wind Walk buys more kills');

    // A Gladiator buffs itself before it hunts, pays the MP and the cast, and
    // renews a buff once it expires and its reuse has passed.
    Cold.npcForSpot = () => ({ level: 40, maxHp: 1e9, pAtk: 1, pAtkRnd: 0, pDef: 300, mDef: 300, accur: 1,
        evasion: 0, critical: 0, atkSpd: 253, aggressiveInterruption: true });
    const gladiator = bot(2, 40);
    const first = round(gladiator, field(30), 60000);
    const effects = first.patch.stats.coldCombat.effects;
    const warCry = effects.find(effect => effect.key === 'war_cry');
    assert(first.debug.buffCasts > 0 && warCry, 'War Cry is cast before the fight');
    assert(effects.some(effect => effect.key === 'lionheart'), 'its other own buffs too');
    assert(first.patch.vitals.mp < gladiator.vitals.mp, 'the buffs cost MP');
    assert(!effects.some(effect => ['frenzy', 'guts'].includes(effect.key)), 'an HP-gated stance is no hunt buff');
    // The next round, within War Cry's minute: nothing to cast.
    const next = { ...gladiator, vitals: { ...gladiator.vitals }, stats: { ...first.patch.stats, pveEncounter: null } };
    assert.equal(round(next, field(30), 30000, T + 30000).debug.buffCasts, 0, 'a held buff is not recast');
    // After the 180 s reuse War Cry comes back.
    const later = round(next, field(30), 60000, T + 200000);
    assert(later.patch.stats.coldCombat.effects.find(effect => effect.key === 'war_cry').expiresAt > warCry.expiresAt,
        'an expired War Cry is renewed after its reuse');

    // A Paladin heals itself with MP: alone it sits for MP as a mage does; a
    // Gladiator (Battle Roar is a buff) and a Warlord (Revival is HP-gated) do not.
    const paladin = bot(5, 40);
    assert.equal(RestPolicy.needsRest(paladin, 0.9, 0.1), true, 'a Paladin at 10% MP sits');
    assert.equal(RestPolicy.needsRest(bot(2, 60), 0.9, 0.1), false, 'a Gladiator does not');
    assert.equal(RestPolicy.needsRest(bot(3, 76), 0.9, 0.1), false, 'a Warlord does not');
    assert.equal(RestPolicy.needsRest(paladin, 0.9, 0.1, { party: true }), true, 'a tank sits for MP in a party anyway');
    const vitals = { hp: paladin.vitals.maxHp, maxHp: paladin.vitals.maxHp, mp: 1, maxMp: paladin.vitals.maxMp };
    assert(Resolver.estimateRestMs(paladin, vitals) > 8000, 'its rest refills the MP');
    // Its heal between fights is priced in that rest: a Paladin at 60% HP and
    // empty MP sits instead of casting.
    const ColdClassPolicy = invoke('GameServer/Bot/Population/ColdClassPolicy');
    const SoloSelfHeal = invoke('GameServer/Bot/AI/SoloSelfHeal');
    const profile = Cold.profileFor(paladin, T, { store: false });
    const heal = mp => SoloSelfHeal.betweenFights(ColdClassPolicy.actorFor(profile,
        { hp: profile.maxHp * 0.6, mp, cooldowns: {}, time: 0 }));
    assert(heal(profile.maxMp), 'at full MP the heal beats sitting');
    assert.equal(heal(profile.maxMp * 0.15), null, 'with its bar near empty the heal costs more rest than it saves');
} finally {
    Cold.npcForSpot = originalNpc;
}
// The walk spans the spot's spawn area, and a bow or a spell strikes from
// afar: the bot walks only until its next mob is in its reach.
assert.equal(Resolver.soloWalkMs(4, 100, 6000 * 6000), 15000, 'four mobs on the cell: 1500 apart');
assert.equal(Resolver.soloWalkMs(4, 100, 3000 * 3000), 7500, 'on a quarter of it: half the walk');
assert.equal(Resolver.soloWalkMs(4, 100, 6000 * 6000, 700), 8000, 'a reach of 700 walks 800');
assert.equal(Resolver.soloWalkMs(400, 100, 6000 * 6000, 700), 0, 'a dense spot inside the reach: no walk');
const archer = Cold.profileFor(HuntCycle.referenceState(22, 30), T), dagger = Cold.profileFor(HuntCycle.referenceState(7, 30), T);
assert(Cold.attackReach(archer) > 3 * Cold.attackReach(dagger), 'a bow reaches far beyond a dagger');
console.log('Solo round rules checks passed');
