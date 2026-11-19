const assert = require('assert');

const fs = require('node:fs');
const nodePath = require('node:path');
const isolated = require('./helpers/isolatedSocialDatabase')('bot_background_rest_scheduling', nodePath.resolve(__dirname, '..'));
require('./helpers/databaseIsolation');
require('../src/Global');
isolated.assertConfigured(options.default);
invoke('GameServer/DataCache').init();

const BackgroundResolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const BackgroundPartyResolver = invoke('GameServer/Bot/Population/BackgroundPartyResolver');

try {
const timestamp = 1_000_000;
const restUntil = timestamp + 24 * 60 * 60 * 1000;
const exhausted = {
    characterId: 81,
    name: 'TiredSolo',
    level: 20,
    levelBand: '18-22',
    activity: 'resting',
    vitals: { hp: 10, maxHp: 800, mp: 0, maxMp: 420 },
    stats: { classId: 11, role: 'mage', restUntil },
    party: { role: 'dps' }
};

const solo = BackgroundResolver.resolveSolo({ state: exhausted, spot: null, elapsedMs: 0, timestamp });
assert.strictEqual(solo.patch.activity, 'resting');
assert.strictEqual(solo.nextResolveAt, restUntil, 'a resting solo bot must sleep until its persisted recovery deadline');

// A pet's regen and a potion's ms are fractions; a fractional clock fails the
// command checkpoint, so the deadline that carries them is whole, and not early.
const fractional = BackgroundResolver.resolveRest({ ...exhausted, stats: { ...exhausted.stats, restUntil: restUntil + 0.25 } },
    0, timestamp, { requireMana: true });
assert.strictEqual(fractional.patch.stats.restUntil, restUntil + 1, 'a rest deadline is whole milliseconds, rounded up');

const party = { partyId: 'rest-scheduling', cohesion: 0.7, risk: 0.2, stats: { restUntil } };
const spot = { id: 'test_spot', name: 'Test Spot', center: {}, rewards: { exp: 1, sp: 1, adenaMin: 1, adenaMax: 1 } };
const restedParty = BackgroundPartyResolver.resolve({
    party,
    members: [exhausted, {
        ...exhausted,
        characterId: 82,
        name: 'ReadyMember',
        vitals: { hp: 800, maxHp: 800, mp: 420, maxMp: 420 },
        stats: { classId: 1, role: 'dps' }
    }],
    spot,
    elapsedMs: 0,
    timestamp
});
assert.strictEqual(restedParty.nextResolveAt, restUntil, 'a resting party must share one recovery deadline');
assert(restedParty.memberResults.every(({ result }) => result.patch.activity === 'resting'), 'ready members must remain seated with their recovering party');
assert.strictEqual(restedParty.partyPatch.stats.restUntil, restUntil, 'the common party deadline must be persisted');

const fullRaidMembers = [91, 92].map((characterId) => ({
    ...exhausted,
    characterId,
    activity: 'resting',
    vitals: { hp: 100000, maxHp: 100000, mp: 100000, maxMp: 100000 },
    stats: { classId: 11, role: 'mage', restUntil: timestamp + 8000 }
}));
const recoveredRaid = BackgroundPartyResolver.resolve({
    party: {
        partyId: 'raid-rest-recovery',
        cohesion: 0.7,
        risk: 0.2,
        stats: {
            restUntil: timestamp + 8000,
            objective: { sourceKind: 'raid', raidBossTemplateId: 999 }
        }
    },
    members: fullRaidMembers,
    spot: { ...spot, raidBoss: true, raidBossTemplateId: 999 },
    elapsedMs: 3000,
    timestamp
});
assert(recoveredRaid.memberResults.every(({ result }) => result.patch.activity === 'grouped'),
    'a fully recovered raid party must resume preparation before its estimated deadline');
assert.strictEqual(recoveredRaid.partyPatch.stats.restUntil, null,
    'a fully recovered raid party must clear the shared recovery deadline');

// This positive combat case needs a real level-20 encounter. The old spot
// has neither an NPC nor an average level: its fallback reward of 1 is
// penalized against NPC level 0 and both level-20 party shares round to 0.
// Select the first authored ordinary monster at the unchanged member level,
// without filtering its strength or modifying its rewards/vitals/skills.
const combatNpc = invoke('GameServer/DataCache').npcs
    .filter(npc => npc.template.kind === 'Monster' && npc.template.level === exhausted.level
        && Number(npc.rewards?.exp) > 0)
    .sort((left, right) => left.selfId - right.selfId)[0];
assert(combatNpc, 'the native catalogue contains an ordinary monster at the existing party level');
const combatSpot = { ...spot, avgLevel: combatNpc.template.level,
    npcSelfIds: [combatNpc.selfId], npcEntries: [{ selfId: combatNpc.selfId, count: 1 }] };
let observedCombat;
const nativeFight = BackgroundResolver.resolvePartyFight;
// These unequipped members may not take the monster (the party's pick refuses
// it: test_bot_cold_combat pins that); the case pins the rest rule in a live
// fight, so its pick takes the monster regardless.
BackgroundResolver.resolvePartyFight = function (options) {
    const result = nativeFight.call(this, { ...options, partyProfiles: null });
    observedCombat = { input: arguments[0], result };
    return result;
};
let combatRestParty, combatMembers;
try {
combatRestParty = BackgroundPartyResolver.resolve({
    party: { partyId: 'combat-rest', cohesion: 0.7, risk: 0.2, roleCoverage: { dps: 2 }, stats: {} },
    members: combatMembers = [
        { ...exhausted, characterId: 83, activity: 'grouped', vitals: { hp: 800, maxHp: 800, mp: 1, maxMp: 420 }, stats: { classId: 5, role: 'tank' }, party: { role: 'tank' } },
        { ...exhausted, characterId: 84, activity: 'grouped', vitals: { hp: 800, maxHp: 800, mp: 420, maxMp: 420 }, stats: { classId: 1, role: 'dps' }, party: { role: 'dps' } }
    ],
    spot: combatSpot,
    elapsedMs: 10_000,
    timestamp,
    rng: () => 0
});
} finally { BackgroundResolver.resolvePartyFight = nativeFight; }
// A party rests between fights, never in one, as hot: a tank out of MP in a live
// fight fights on, and the mob stays pending, not a kill and not a loss.
assert(observedCombat.result.timedOut && !observedCombat.result.won,
    'the original bounded encounter times out before the monster is defeated');
assert(observedCombat.result.debug.remainingHp > 0, 'the timed-out target is still alive');
assert(observedCombat.input.timestamp > timestamp - 10_000, 'the encounter starts after its walk from the round\'s start');
assert.strictEqual(observedCombat.input.spot, combatSpot, 'the authored ordinary target is used unchanged');
assert.strictEqual(observedCombat.result.debug.mobSelfId, combatNpc.selfId);
assert.strictEqual(combatRestParty.debug.spotId, combatSpot.id);
assert.strictEqual(combatRestParty.debug.attemptedFights, 1, 'the original elapsed window attempts one encounter');
assert.strictEqual(combatRestParty.debug.wins, 0, 'a cut fight mints no kill');
assert.strictEqual(combatRestParty.debug.losses, 0, 'a cut fight is no loss');
assert(combatRestParty.memberResults.every(({ result }) => result.patch.activity === 'grouped'), 'nobody sits down in a live fight');
assert(combatRestParty.partyPatch.stats.pveEncounter?.hp > 0, 'the fight stays pending');
assert(!combatRestParty.partyPatch.stats.restUntil, 'no rest deadline while the mob lives');
assert(combatRestParty.memberResults.every(({ result }) => Number(result.materialize.exp || 0) === 0
    && Number(result.materialize.sp || 0) === 0), 'an unfinished encounter mints no EXP or SP');
// The kill ends the fight: the whole party sits together, before any next pull.
const killedParty = BackgroundPartyResolver.resolve({
    party: { partyId: 'combat-rest', cohesion: 0.7, risk: 0.2, roleCoverage: { dps: 2 },
        stats: { pveEncounter: { ...combatRestParty.partyPatch.stats.pveEncounter, hp: 1 } } },
    members: combatMembers,
    spot: combatSpot,
    elapsedMs: 10_000,
    // The members' clock: the step's timestamp or the cut fight's walk past it.
    timestamp: combatRestParty.memberResults[0].result.doneAt + 10_000,
    rng: () => 0
});
assert.strictEqual(killedParty.debug.wins, 1, 'the pending mob falls, and the party takes no next one');
assert(killedParty.partyPatch.stats.restUntil > timestamp + 10_000, 'the rest deadline comes with the fight\'s end');
assert.strictEqual(killedParty.nextResolveAt, killedParty.partyPatch.stats.restUntil);
assert(killedParty.memberResults.every(({ result }) => result.patch.activity === 'resting'), 'a party rest seats every living member together');
assert.strictEqual(killedParty.partyPatch.stats.pveEncounter, null);
assert.strictEqual(BackgroundResolver.needsRest({ stats: { classId: 1 } }, {
    hp: 800, maxHp: 800, mp: 0, maxMp: 420
}, { party: true, hpThreshold: 0.3, mpThreshold: 0.18 }), false,
    'an empty-MP physical DPS must not stop the whole party');
assert.strictEqual(BackgroundResolver.needsRest({ stats: { classId: 5 } }, {
    hp: 800, maxHp: 800, mp: 0, maxMp: 420
}, { party: true, hpThreshold: 0.3, mpThreshold: 0.18 }), true,
    'an empty-MP tank must still trigger party recovery because Hate is part of its primary job');

// A cold solo round runs on one clock from the bot's last action (roundStart = the
// step's timestamp - its elapsed): the bot sits down at its fight's end, as a hot
// bot sits between fights, not at the round's end; nothing carries but its clock.
const Cold = invoke('GameServer/Bot/Population/ColdCombatProfile');
const RestPolicy = invoke('GameServer/Bot/AI/RestPolicy');
const ColdRest = invoke('GameServer/Bot/Population/ColdRest');
const tick = invoke('GameServer/Formulas').REGEN_TICK_MS;
const originalProfile = Cold.profileFor, originalFightProfile = Cold.fightProfile, originalNpc = Cold.npcForSpot;
try {
    const caster = { classId: 12, level: 29, role: 'mage', maxHp: 592, maxMp: 932,
        pDef: 243, pAtk: 96, mAtk: 162, castSpd: 194, atkSpd: 263, weaponMask: 8,
        equipment: { weaponKind: 'Weapon.Blunt' }, accur: 100, evasion: 0, critical: 0, effects: [],
        skills: [{ selfId: 1230, level: 1, spell: true, passive: false, power: 51, mp: 35, hitTime: 4000 }] };
    Cold.profileFor = Cold.fightProfile = () => ({ ...caster });
    Cold.npcForSpot = () => ({ maxHp: 500, pAtk: 60, atkSpd: 253, pDef: 100, mDef: 70, basePDef: 100, baseMDef: 70,
        vulnerabilities: {}, level: 25, selfId: 156, accur: 100, evasion: 0, critical: 0 });
    const field = { id: 'field', name: 'field', minLevel: 25, maxLevel: 25, avgLevel: 25, density: 8, tags: [],
        tagsAuthoritative: true, center: { locX: 50000, locY: 150000, locZ: -3000 },
        npcEntries: [{ selfId: 156, count: 8 }], levelCounts: { 25: 8 } };
    const hunter = { characterId: 85, level: 29, exp: 0, sp: 0, adena: 0, phase: 'cold', activity: 'hunting', spotId: 'field',
        inventory: {}, loc: {}, timing: {}, vitals: { hp: 592, maxHp: 592, mp: 300, maxMp: 932 },
        stats: { classId: 12, classProgressionClassId: 12, classProgressionLevel: 29, deaths: 0 } };
    const at = 1_800_000_000_000, budget = 120_000, line = { line: RestPolicy.THRESHOLDS.rested };
    const seatedRate = ColdRest.coldRestRegenPerTick(hunter, { profile: caster, timestamp: at });

    const worn = BackgroundResolver.resolveSolo({ state: hunter, spot: field, elapsedMs: budget, timestamp: at, rng: () => 0.5 });
    assert.strictEqual(worn.patch.activity, 'resting', 'the fights wear the caster down to a rest');
    // The vitals its last fight left (the rest event reads them where it sits down).
    const sat = worn.events.find(event => event.type === 'rest').meta;
    const fightEnd = { hp: sat.hpPct * caster.maxHp, maxHp: caster.maxHp, mp: sat.mpPct * caster.maxMp, maxMp: caster.maxMp };
    const sitAt = at - budget + worn.debug.combatMs;
    assert(sitAt < at - budget / 2, `its last fight ends well before the round's end (${at - sitAt} ms before)`);
    const restUntil = worn.patch.stats.restUntil;
    assert(Math.abs(restUntil - Math.ceil(sitAt + BackgroundResolver.estimateRestMs(hunter, fightEnd, line))) <= 1,
        `the rest ends at the fight's end + the rest it needs (${restUntil - at} ms after the round)`);
    assert(Math.abs(worn.patch.vitals.mp - (fightEnd.mp + seatedRate.mp * (at - sitAt) / tick)) < 0.01,
        `at the round's end it has rested seated since its fight, no standing regen after it (MP ${worn.patch.vitals.mp} from ${fightEnd.mp})`);
    assert(Math.abs(worn.debug.seatedMs - (at - sitAt)) < 0.01, 'the round\'s time after the sit is seated');
    assert.strictEqual(worn.doneAt, at, 'its clock is the round\'s end: no field carries the rest');
    // At its deadline the rest step (seated from the round's end) finds the bot at its line.
    const rested = BackgroundResolver.resolveRest({ ...hunter, activity: 'resting', vitals: worn.patch.vitals,
        stats: { ...hunter.stats, ...worn.patch.stats } }, restUntil - worn.doneAt, restUntil);
    assert(rested.patch.vitals.mp >= RestPolicy.THRESHOLDS.rested.mp * caster.maxMp,
        `at its deadline the bot is at its rested line (MP ${rested.patch.vitals.mp})`);
    assert.strictEqual(rested.patch.activity, 'hunting', 'and stands up, the rest not extended');
    // A rest step's own deadline (from a whole-ms step time) is never short of the line either.
    for (const mp of [300, 301, 302, 303]) {
        const low = { ...hunter, activity: 'resting', vitals: { ...hunter.vitals, mp }, stats: { ...hunter.stats } };
        const until = BackgroundResolver.resolveRest(low, 0, at).patch.stats.restUntil;
        const up = BackgroundResolver.resolveRest({ ...low, stats: { ...low.stats, restUntil: until } }, until - at, until);
        assert.strictEqual(up.patch.activity, 'hunting', `at its deadline the bot stands up at its line (MP ${mp}: ${up.patch.vitals.mp})`);
    }

    // A fight refused (the bot cannot take the mob at its HP) seats it where it stands: it
    // reads its readiness before its walk (as hot at its target scan), so no walk comes first.
    const tired = { ...hunter, vitals: { ...hunter.vitals, hp: 150 } };
    const refused = BackgroundResolver.resolveSolo({ state: tired, spot: field, elapsedMs: 30_000, timestamp: at, rng: () => 0.5 });
    assert.strictEqual(refused.patch.stats.lastReason, 'solo_recovery_needed');
    assert.strictEqual(refused.debug.attemptedFights, 0);
    assert.strictEqual(refused.debug.walkedMs, 0, 'below its line the bot sits before it walks');
    assert.strictEqual(refused.debug.combatMs, 0, 'fixture: nothing comes before the refusal');
    // A walk regenerates at the moving rate (C4 x0.7, the hot rule's): two rounds that
    // walk past their end to one mob and kill it with one nuke, differing only in the
    // walk's length (the spot's spawn area), differ in HP and MP by the moving rate over
    // the walks' difference.
    const walker = { ...hunter, vitals: { ...hunter.vitals, hp: 500 } };
    const movingRate = ColdRest.coldRestRegenPerTick(walker, { profile: caster, moving: true, timestamp: at });
    const [near, far] = [1e8, 4e8].map(spawnArea => BackgroundResolver.resolveSolo({ state: walker, spot: { ...field, spawnArea },
        elapsedMs: 1000, timestamp: at, rng: () => 0.5 }));
    assert(near.debug.attemptedFights === 1 && far.debug.attemptedFights === 1
        && Math.abs((near.debug.combatMs - near.debug.walkedMs) - (far.debug.combatMs - far.debug.walkedMs)) < 1e-6,
        `fixture: each round walks to one mob and does the same after it (${near.debug.attemptedFights}, ${far.debug.attemptedFights})`);
    assert(far.debug.walkedMs > near.debug.walkedMs && near.debug.walkedMs > 1000,
        `fixture: the walks differ and each crosses the round's end (${near.debug.walkedMs}, ${far.debug.walkedMs} ms)`);
    // The fight keeps whole HP and MP (each round rounds once: within 1 of the walks' regen;
    // the standing rate would be (1.1 / 0.7 - 1) x the moving one's further off).
    const walkTicks = (near.debug.walkedMs - far.debug.walkedMs) / tick;
    assert(Math.abs(movingRate.hp * walkTicks) * (1.1 / 0.7 - 1) > 2, 'fixture: the standing rate would differ by more than the rounding');
    assert(Math.abs(near.patch.vitals.hp - far.patch.vitals.hp - movingRate.hp * walkTicks) < 1,
        `a walk regenerates HP at the moving rate (${near.patch.vitals.hp - far.patch.vitals.hp} vs ${movingRate.hp * walkTicks})`);
    assert(Math.abs(near.patch.vitals.mp - far.patch.vitals.mp - movingRate.mp * walkTicks) < 1,
        `a walk regenerates MP at the moving rate (${near.patch.vitals.mp - far.patch.vitals.mp} vs ${movingRate.mp * walkTicks})`);
    const refusedNeed = BackgroundResolver.estimateRestMs(tired, tired.vitals, line);
    assert.strictEqual(refused.patch.stats.restUntil, Math.ceil(at - 30_000 + refusedNeed),
        'a refused fight\'s rest starts at the round\'s start, where the bot stands');

    // The same rest inside a longer round ends in it: the bot stands up at its rested
    // line and hunts on in the same round.
    const longer = BackgroundResolver.resolveSolo({ state: tired, spot: field, elapsedMs: 600_000, timestamp: at, rng: () => 0.5 });
    assert(longer.debug.wins > 0, `after the rest it fights on in the round (${longer.debug.wins} wins)`);
    assert(longer.debug.seatedMs >= refusedNeed, `it sat for the rest it needed first (${longer.debug.seatedMs} ms)`);
    assert(longer.events.findIndex(event => event.type === 'rest') < longer.events.findIndex(event => event.type === 'hunt'),
        'the rest came before the fights');
    assert.strictEqual(longer.debug.walkedMs, worn.debug.walkedMs / worn.debug.attemptedFights * longer.debug.attemptedFights,
        'after the rest it walks once to each mob: one walk per mob');

    // A round ends at the end of the fight that crosses a situation the bot hears now (its
    // step decides at once): the kill whose drop fills the bag. A drop past the bag's slot
    // limit stays on the ground (C4 pickup). Each kill drops one Short Sword (a slot each).
    const Rewards = invoke('GameServer/Bot/Population/ColdKillRewards'), originalRoll = Rewards.roll;
    let dropped = 1, paid = 0;
    Rewards.roll = options => ({ ...originalRoll(options), adena: paid, loot: [{ drops: dropped ? [{ selfId: 1, name: 'Short Sword', amount: dropped }] : [], spoil: [] }] });
    try {
        const swords = amount => ({ ...hunter, exp: Number(invoke('GameServer/DataCache').experience[28]), vitals: { ...hunter.vitals, mp: 932 },
            inventory: { 1: { selfId: 1, name: 'Short Sword', amount, stackable: false } } });
        // The last shot spent ends the round at that fight's end (shots_out: the earning
        // spot is asked again). An Apprentice's Wand fires one Spiritshot a cast; the kit
        // rates pay the shots, so their line is the spot's hour of use. These rounds drop
        // nothing: twenty surplus swords are the bag's cleanup count (bag_full).
        const armed = shots => ({ ...swords(0), inventory: {
            6: { selfId: 6, name: 'Apprentice\'s Wand', amount: 1, equipped: true, slot: 7, stackable: false },
            2509: { selfId: 2509, name: 'Spiritshot', amount: shots, stackable: true } },
            stats: { ...hunter.stats, kitRates: [2509, 1, 1, 1061, 0, 1, -1, 1, 1], earning: { spotId: 'field', shotsPerHour: 100, potionsPerHour: 0 } } });
        dropped = 0;
        const stocked = BackgroundResolver.resolveSolo({ state: armed(1000), spot: field, elapsedMs: budget, timestamp: at, rng: () => 0.5 });
        const dry = BackgroundResolver.resolveSolo({ state: armed(4), spot: field, elapsedMs: budget, timestamp: at, rng: () => 0.5 });
        dropped = 1;
        assert(stocked.debug.shotActions > 4 && stocked.debug.wins > 2, `fixture: with shots to spare the round fires on (${stocked.debug.shotActions} shots, ${stocked.debug.wins} wins)`);
        assert.strictEqual(dry.debug.shotActions, 4, 'the round fires its four shots');
        assert(dry.debug.wins < stocked.debug.wins && dry.doneAt < at,
            `the round ends at the fight that spends its last shot (${dry.debug.wins} wins, ${stocked.debug.wins} with shots to spare)`);
        assert.deepStrictEqual([dry.debug.ended, stocked.debug.ended], ['shots_out', null], 'the round names the crossing it ended at');
        const filling = BackgroundResolver.resolveSolo({ state: swords(78), spot: field, elapsedMs: budget, timestamp: at, rng: () => 0.5 });
        assert.strictEqual(filling.debug.wins, 2, `the round ends at the kill whose drop fills the bag's 80 slots (${filling.debug.wins} wins)`);
        assert(filling.doneAt < at, `at that fight's end, before the round's bound (${at - filling.doneAt} ms before)`);
        assert.strictEqual(filling.debug.ended, 'bag_full');
        assert.strictEqual(filling.patch.activity, 'hunting');
        assert.strictEqual(filling.materialize.items.length, 2, 'both drops fit');
        // Two swords a kill into a bag one slot short of full: each drop stays on the ground
        // (the bag does not move: the round hunts on).
        dropped = 2;
        const full = BackgroundResolver.resolveSolo({ state: swords(79), spot: field, elapsedMs: budget, timestamp: at, rng: () => 0.5 });
        dropped = 1;
        assert(full.debug.wins > 2, `fixture: the round hunts on (${full.debug.wins} wins)`);
        assert.strictEqual(full.materialize.items.length, 0, `no drop past the bag's slots (${full.materialize.items.length} kept)`);
        // A raise standing when the round began (the goal in reach, not taken yet) ends no round.
        paid = 10;
        const standing = BackgroundResolver.resolveSolo({ state: { ...swords(0), inventory: {}, adena: 100,
            stats: { ...hunter.stats, wishSections: { affordAt: { at: 50, kind: 'focus' } } } }, spot: field, elapsedMs: budget, timestamp: at, rng: () => 0.5 });
        paid = 0;
        assert(standing.debug.wins > 2 && standing.materialize.adena > 0, `a raise standing at the round's start does not end it (${standing.debug.wins} wins)`);
        // A level gained ends the round at its kill (its profile is one level's).
        const levelling = { ...swords(0), inventory: {}, exp: Number(invoke('GameServer/DataCache').experience[29]) - 1 };
        const up = BackgroundResolver.resolveSolo({ state: levelling, spot: field, elapsedMs: budget, timestamp: at, rng: () => 0.5 });
        assert.strictEqual(up.debug.wins, 1, `the round ends at the kill that gains a level (${up.debug.wins} wins)`);
        assert(up.doneAt < at && up.patch.activity === 'hunting', 'at that fight\'s end, still hunting');
        assert.strictEqual(up.debug.ended, 'level');
        // A bag at 48 % of its carrying load (under the first weight penalty, so it hunts): a
        // drop of 20000 Iron Ore (mass 2 each, a stack it holds) would pass the load and stays
        // on the ground, the weightless Adena beside it is picked up.
        Cold.profileFor = Cold.fightProfile = () => ({ ...caster, maxLoad: 64000 });
        const laden = { ...swords(0), inventory: { 1869: { selfId: 1869, name: 'Iron Ore', amount: 15500, stackable: true } } };
        Rewards.roll = options => ({ ...originalRoll(options), adena: 0,
            loot: [{ drops: [{ selfId: 1869, name: 'Iron Ore', amount: 20000 }, { selfId: 57, name: 'Adena', amount: 10 }], spoil: [] }] });
        const hauled = BackgroundResolver.resolveSolo({ state: laden, spot: field, elapsedMs: budget, timestamp: at, rng: () => 0.5 });
        Cold.profileFor = Cold.fightProfile = () => ({ ...caster });
        const kept = hauled.materialize.items.map(item => Number(item.selfId));
        assert(kept.includes(57), 'fixture: the round kills and picks up the Adena');
        assert(!kept.includes(1869), `no drop past the bag's carrying load (${kept.filter(id => id === 1869).length} ore drops kept)`);
        assert(hauled.debug.wins > 1, `the bag does not move: the round hunts on (${hauled.debug.wins} wins)`);
    } finally { Rewards.roll = originalRoll; }
    // The same rule near a player (PickupCapacity.check on a body's bag): a full bag takes
    // no new slot, a stack it holds still grows.
    const Pickup = invoke('GameServer/Inventory/PickupCapacity');
    const piece = (selfId, stackable) => ({ fetchAmount: () => 1, fetchStackable: () => stackable, fetchSelfId: () => selfId, fetchMass: () => 0 });
    const body = { backpack: { fetchItems: () => [piece(1864, true), ...Array.from({ length: 79 }, () => piece(1, false))] },
        fetchRace: () => 0, fetchMaxLoad: () => 1e9 };
    assert.strictEqual(Pickup.check(body, 1869, 1, {}).reason, 'slots', 'a full bag takes no new stack');
    assert.strictEqual(Pickup.check(body, 1864, 5, {}).reason, undefined, 'a stack it holds still grows');

    // MP under every cast (the survival floor) is what the last round left: the bot sat
    // down there, so the interval before the step is a seated rest.
    const drained = { ...hunter, vitals: { ...hunter.vitals, mp: 20 } };
    const floored = BackgroundResolver.resolveSolo({ state: drained, spot: field, elapsedMs: 60_000, timestamp: at, rng: () => 0.5 });
    assert.strictEqual(floored.debug.reason, 'survival_no_mp');
    assert.strictEqual(floored.patch.vitals.mp,
        BackgroundResolver.resolveRest({ ...drained, activity: 'resting' }, 60_000, at, { requireMana: true }).patch.vitals.mp,
        'the floor\'s rest is seated over the interval since the last round');
    assert(floored.patch.vitals.mp > 20, 'it regenerates there');

    // A party round runs on the same clock: from the members' credited hunt, each
    // fight at its own moment (after its walk), the rest from its last fight's end.
    const nuker = { ...caster, skills: [{ ...caster.skills[0], reuse: 3000 }] };
    Cold.profileFor = Cold.fightProfile = () => ({ ...nuker });
    const pair = (mp, hp = hunter.vitals.hp) => [85, 86].map((characterId, k) => ({ ...hunter, characterId, activity: 'grouped',
        vitals: { ...hunter.vitals, mp, hp }, party: { role: k ? 'dps' : 'tank' }, stats: { ...hunter.stats, role: k ? 'dps' : 'tank' } }));
    const partyFights = (members, elapsedMs) => {
        const seen = [];
        BackgroundResolver.resolvePartyFight = function (options) {
            const result = nativeFight.call(this, { ...options, partyProfiles: null });
            seen.push({ at: options.timestamp, members: options.members, result,
                foughtMs: Math.max(Number(result.debug?.durationMs || 0), result.won
                    ? Math.max(0, ...result.members.map(member => Number(member.readyAt) || 0)) : 0) });
            return result;
        };
        try {
            return { seen, party: BackgroundPartyResolver.resolve({ party: { partyId: 'clock', cohesion: 0.7, risk: 0.2,
                roleCoverage: { dps: 2 }, stats: {} }, members, spot: field, elapsedMs, timestamp: at, rng: () => 0.5 }) };
        } finally { BackgroundResolver.resolvePartyFight = nativeFight; }
    };
    const hunt = partyFights(pair(932), 120_000);
    assert(hunt.seen.length >= 2, `the party fights more than once in its round (${hunt.seen.length})`);
    assert(hunt.seen[0].at > at - 120_000 && hunt.seen[0].at < at, 'its first fight starts after its walk from the round\'s start');
    for (let k = 1; k < hunt.seen.length; k++) {
        const before = hunt.seen[k - 1];
        assert(hunt.seen[k].at >= before.at + before.foughtMs, `fight ${k + 1} starts after fight ${k} ends`);
        for (const member of hunt.seen[k].members) {
            const cast = Number(member.stats?.coldCombat?.cooldowns?.[1230]) - 3000;
            if (!(cast > 0)) continue;
            assert(cast >= hunt.seen[0].at && cast <= before.at + before.foughtMs,
                `fight ${k + 1} reads the reuse of a cast inside the fights before it (${cast - before.at} ms after fight ${k}'s start)`);
        }
    }
    // A worn party sits at its last fight's end, to its slowest member's rest from there.
    const worn2 = partyFights(pair(120), 30_000);
    const rest = worn2.party.partyPatch.stats.restUntil;
    assert(rest > at, 'the worn party rests past its round');
    const last = worn2.seen[worn2.seen.length - 1];
    const sitAt2 = last.at + last.foughtMs;
    assert(sitAt2 < at, `it sits at its last fight's end, inside the round (${at - sitAt2} ms before its end)`);
    const standing = ColdRest.coldRestRegenPerTick(hunter, { profile: nuker, standing: true, timestamp: at - 30_000 });
    const need = Math.max(...last.result.members.map(({ state, vitals }) => {
        const atSit = { ...vitals, mp: Math.min(vitals.maxMp, vitals.mp + standing.mp * last.foughtMs / tick),
            hp: Math.min(vitals.maxHp, vitals.hp + standing.hp * last.foughtMs / tick) };
        return BackgroundResolver.resolveRest({ ...state, vitals: atSit }, 0, sitAt2, { party: true }).patch.stats.restUntil;
    }));
    assert(Math.abs(rest - need) <= 1, `the party rest ends at its last fight's end + the rest it needs (${rest - need} ms off)`);
    assert(worn2.party.memberResults.every(({ result }) => result.doneAt === at), 'its members\' clock is the round\'s end');
    // The same rest inside a longer round ends in it: the party stands up at its
    // locked line and hunts on.
    // (a small HP bar: its rest from the trigger to the line fits in a round)
    const small = { ...nuker, maxHp: 150 };
    Cold.profileFor = Cold.fightProfile = () => ({ ...small });
    const longer2 = partyFights(pair(932, 15).map(member => ({ ...member, vitals: { ...member.vitals, maxHp: 150 } })), 135_000);
    const after = longer2.seen.findIndex((fight, k) => k > 0 && fight.at > longer2.seen[k - 1].at + longer2.seen[k - 1].foughtMs + 5000);
    assert(after > 0, 'a fight follows the party\'s rest in the round');
    for (const member of longer2.seen[after].members) {
        assert(RestPolicy.restOver(member.vitals, { mana: ColdRest.requiresManaRecovery(member), party: true }),
            `it stood up at its line (MP ${member.vitals.mp})`);
    }
    // A party round starts at its latest member's clock: the member whose clock is
    // earlier stood until then (regenerating), and no fight starts before it.
    Cold.profileFor = Cold.fightProfile = () => ({ ...nuker });
    const clocked = pair(932, 100).map((member, k) => ({ ...member, timing: { lastResolvedAt: at - (k ? 5_000 : 30_000) } }));
    const late = partyFights(clocked, 30_000);
    assert(late.seen[0].at >= at - 5_000, `its first fight starts at or after its latest member's clock (${at - late.seen[0].at} ms before the step)`);
    const hpAt = (fight, id) => fight.members.find(member => Number(member.characterId) === id).vitals.hp;
    const stood = ColdRest.coldRestRegenPerTick(clocked[0], { profile: nuker, standing: true, timestamp: at - 5_000 }).hp * 25_000 / tick;
    assert(Math.abs(hpAt(late.seen[0], 85) - hpAt(late.seen[0], 86) - stood) < 1e-6,
        `the earlier member stood 25 s more (${hpAt(late.seen[0], 85) - hpAt(late.seen[0], 86)} HP vs ${stood})`);
    // A party summoner's pet regenerates between fights, as a solo one's (its revHp per regen tick).
    const pet = { active: true, npcId: 1, hp: 700, maxHp: 1000, revHp: 10, pDef: 1, expiresAt: at + 3_600_000 };
    const summoners = pair(932).map(member => ({ ...member,
        stats: { ...member.stats, coldCombat: { ...(member.stats.coldCombat || {}), summon: { ...pet } } } }));
    const scripted = [];
    BackgroundResolver.resolvePartyFight = (options) => {
        scripted.push({ at: options.timestamp, members: options.members });
        return { won: true, encounter: null, help: [], debug: { durationMs: 5_000, actions: 1, killsPaid: 1 },
            members: options.members.map(state => ({ state, vitals: { ...state.vitals }, profile: { effects: [] }, cooldowns: {}, readyAt: 0 })) };
    };
    try {
        BackgroundPartyResolver.resolve({ party: { partyId: 'pet-clock', cohesion: 0.7, risk: 0.2, roleCoverage: { dps: 2 }, stats: {} },
            members: summoners, spot: field, elapsedMs: 60_000, timestamp: at, rng: () => 0.5 });
    } finally { BackgroundResolver.resolvePartyFight = nativeFight; }
    assert(scripted.length >= 2, `the summoners fight more than once (${scripted.length})`);
    const petHp = (fight) => fight.members[0].stats.coldCombat.summon.hp;
    const petExpected = Math.min(pet.maxHp, petHp(scripted[0]) + pet.revHp * (scripted[1].at - scripted[0].at) / tick);
    assert(Math.abs(petHp(scripted[1]) - petExpected) < 1e-6,
        `the pet regenerates between the fights (${petHp(scripted[1])} vs ${petExpected})`);

    // A party round ends at the end of the fight that spends a member's last shot, as the
    // solo round (its loot, exp and adena are rolled at the round's end: only the members'
    // shots and bottles are read in it). The first member (its tank, who kills each mob
    // here) fires one Spiritshot a cast.
    const shooting = (shots) => pair(932).map((member, k) => k ? member : { ...member, exp: Number(invoke('GameServer/DataCache').experience[28]), inventory: {
        6: { selfId: 6, name: 'Apprentice\'s Wand', amount: 1, equipped: true, slot: 7, stackable: false },
        2509: { selfId: 2509, name: 'Spiritshot', amount: shots, stackable: true } },
        stats: { ...member.stats, kitRates: [2509, 1, 1, 1061, 0, 1, -1, 1, 1], earning: { spotId: 'field', shotsPerHour: 100, potionsPerHour: 0 } } });
    const partyRound = (members) => BackgroundPartyResolver.resolve({ party: { partyId: 'lines', cohesion: 0.7, risk: 0.2,
        roleCoverage: { dps: 2 }, stats: {} }, members, spot: field, elapsedMs: 120_000, timestamp: at, rng: () => 0.5 });
    const dryParty = partyRound(shooting(2));
    const loaded = partyRound(shooting(1000)).memberResults[0].result, empty = dryParty.memberResults[0].result;
    assert(loaded.debug.wins > 2 && loaded.debug.shotActions > 2, `fixture: with shots to spare the party fights on (${loaded.debug.wins} wins, ${loaded.debug.shotActions} shots)`);
    assert.strictEqual(empty.debug.shotActions, 2, 'the member fires its two shots');
    assert(empty.debug.wins < loaded.debug.wins && empty.doneAt < at,
        `the party round ends at the fight that spends its last shot (${empty.debug.wins} wins, ${loaded.debug.wins} with shots to spare)`);
    assert.deepStrictEqual([empty.debug.ended, loaded.debug.ended], ['shots_out', null], 'the party round names the crossing it ended at');
    // Its next step is at that fight's end: the crossing is decided at once.
    assert.deepStrictEqual([dryParty.nextResolveAt, ...dryParty.memberResults.map(({ result }) => result.nextResolveAt)],
        [empty.doneAt, empty.doneAt, empty.doneAt], 'the party round ended at a crossing steps again at its end');
    // A drop a member cannot pick up stays on the ground (C4 pickup on its own bag): a
    // sword a kill into bags one slot short of their 80, each built as a round builds it
    // (RoundLoot.addTo: one slot a non-stackable copy). Each bag takes one sword, no more.
    const Rolls = invoke('GameServer/Bot/Population/ColdKillRewards'), nativeRoll = Rolls.roll;
    const crowdedBag = () => invoke('GameServer/Bot/Population/RoundLoot').addTo({}, [{ selfId: 1, name: 'Short Sword', amount: 79 }]);
    const swordsOf = party => party.memberResults.map(({ result }) => result.materialize.items
        .filter(item => Number(item.selfId) === 1).reduce((sum, item) => sum + Number(item.amount), 0));
    let rolled = 0;
    const swordRoll = owner => options => {
        rolled += options.kills.length;
        return { ...nativeRoll(options), adena: 0,
            loot: options.kills.map((kill, k) => ({ drops: [{ selfId: 1, name: 'Short Sword', amount: 1 }], owner: owner ?? k % 2, spoil: [] })) };
    };
    let crowded;
    Rolls.roll = swordRoll(null);
    try {
        crowded = partyRound(pair(932).map(member => ({ ...member, inventory: crowdedBag() })));
    } finally { Rolls.roll = nativeRoll; }
    const swordsKept = swordsOf(crowded);
    assert(rolled > 2, `fixture: the party kills (${rolled} swords rolled)`);
    assert(swordsKept.every(count => count <= 1) && swordsKept.some(count => count === 1),
        `no party drop past a member's bag slots (${swordsKept} kept of ${rolled})`);
    // A party sharing its loot hands a drop only to a member whose bag takes it, and one its
    // full rolling member cannot take passes on to a member who can (C4
    // L2Party.getCheckedNextLooter / getCheckedRandomMember): in turn, every sword a kill
    // rolls, by either member, goes to the first (empty) but one the second, one slot short
    // of its 80, takes; at random and by need the second takes one too.
    const shared = (mode, owner) => {
        rolled = 0;
        Rolls.roll = swordRoll(owner);
        try {
            return BackgroundPartyResolver.resolve({ party: { partyId: 'turns', cohesion: 0.7, risk: 0.2, roleCoverage: { dps: 2 },
                stats: { agreement: { mode, spoil: 'spoiler', cursor: 0 } } },
            members: pair(932).map((member, k) => k ? { ...member, inventory: crowdedBag() } : member),
            spot: field, elapsedMs: 120_000, timestamp: at, rng: () => 0.5 });
        } finally { Rolls.roll = nativeRoll; }
    };
    for (const owner of [0, 1]) {
        const swordsTo = swordsOf(shared('turn', owner));
        assert(rolled > 2, `fixture: the party kills (${rolled} swords rolled)`);
        assert.deepStrictEqual(swordsTo, [rolled - 1, 1], `a drop member ${owner} rolls goes to a member whose bag takes it (${swordsTo} of ${rolled})`);
    }
    for (const mode of ['random', 'need']) {
        const swordsTo = swordsOf(shared(mode, 0));
        assert(rolled > 2 && swordsTo[1] <= 1, `${mode}: the second member's bag takes one sword (${swordsTo} of ${rolled})`);
    }
} finally {
    Cold.profileFor = originalProfile;
    Cold.fightProfile = originalFightProfile;
    Cold.npcForSpot = originalNpc;
}

console.log('Bot background rest scheduling checks passed');

} finally {
    fs.rmSync(isolated.directory, { recursive: true, force: true });
}
