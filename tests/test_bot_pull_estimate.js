const assert = require('assert');

require('../src/Global');

// E72/F20: how many mobs one pull brings, for hot target choice and cold fights.
const Pull = invoke('GameServer/Bot/AI/BotPullEstimate');
const rules = { assistZ: 600, aggroRadius: 500, aggroZ: 400 };
const mob = (x, extra = {}) => ({ x, y: 0, z: 0, clan: '', helpRadius: 0, hostile: false, ...extra });

// A lone mob comes alone; passive strangers nearby stay out.
assert.strictEqual(Pull.pullSize(mob(0), [mob(100), mob(200)], rules), 1);

// Same-clan helpers inside the target's help radius join; outside it, or of another clan, they do not.
const ant = mob(0, { clan: 'ant', helpRadius: 300 });
assert.strictEqual(Pull.pullSize(ant, [ant, mob(100, { clan: 'ant' }), mob(200, { clan: 'ant' }),
    mob(290, { clan: 'ant' }), mob(400, { clan: 'ant' }), mob(150, { clan: 'wolf' })], rules), 4);
assert.strictEqual(Pull.pullSize(ant, [mob(100, { clan: 'ant', z: 700 })], rules), 1, 'help stops at the assist height');

// Aggressive mobs within the aggro radius join; a clan helper that is also aggressive counts once.
assert.strictEqual(Pull.pullSize(mob(0), [mob(450, { hostile: true }), mob(600, { hostile: true })], rules), 2);
assert.strictEqual(Pull.pullSize(ant, [mob(100, { clan: 'ant', hostile: true })], rules), 2);
assert.strictEqual(Pull.pullSize(mob(0), [mob(100, { hostile: true, z: 450 })], rules), 1, 'aggro stops at its height');
// T114: an aggressive mob joins within its own C4 aggro range (Splinter Stakato 1508: 150).
assert.strictEqual(Pull.pullSize(mob(0), [mob(300, { hostile: true, selfId: 1508 }), mob(140, { hostile: true, selfId: 1508 })], rules), 2,
    'a short-sighted mob joins only from its own range');

// A leader brings its minions; minion actors are counted through their group, not again as neighbours.
assert.strictEqual(Pull.pullSize(mob(0), [mob(100, { hostile: true, minion: true })], rules, 3), 4);

// Minion groups from the Lisvus rows: a leader brings the mean of each group, a minion its leader and siblings.
const groups = new Map([[520, [{ minionId: 445, min: 3, max: 5 }, { minionId: 446, min: 1, max: 1 }]]]);
const joiners = Pull.minionJoiners(groups);
assert.strictEqual(joiners.get(520), 5);
assert.strictEqual(joiners.get(445), 5, 'a hit minion alerts the leader and the rest of the group');
assert.strictEqual(joiners.get(1), undefined);

// The start-time table: per spawn group (spot entry) the share of its spawns by pull size and their
// mean, set only where a spawn pulls more than one (user 10-29: a spot mixes lone mobs, pairs and packs).
const spot = {
    npcEntries: [{ selfId: 10, count: 2 }, { selfId: 20, count: 1 }, { selfId: 30, count: 1 }],
    records: [
        mob(0, { selfId: 10, clan: 'ant', helpRadius: 300 }),
        mob(5000, { selfId: 10, clan: 'ant', helpRadius: 300 }),
        mob(100, { selfId: 20, clan: 'ant' }),
        mob(3000, { selfId: 30 })
    ]
};
const size = Pull.annotate([spot], rules, new Map([[30, 2]]));
assert.strictEqual(spot.npcEntries[0].pull, 1.5, 'one of two ants has a clanmate in its help radius');
assert.strictEqual(spot.npcEntries[1].pull, undefined, 'a mob without help radius pulls alone');
assert.strictEqual(spot.npcEntries[2].pull, 3, 'a leader brings its minions');
assert.deepStrictEqual(spot.npcEntries[0].pulls, [[1, 0.5], [2, 0.5]], 'one ant spawn pulls alone, one as a pair');
assert.strictEqual(spot.npcEntries[1].pulls, undefined);
assert.deepStrictEqual(spot.npcEntries[2].pulls, [[3, 1]]);
assert.strictEqual(spot.records, undefined, 'the spawn records are dropped once the table is built');
assert.deepStrictEqual(size, { entries: 3, pulls: 2 });
assert.strictEqual(Pull.entryPull(spot, 30), 3);
assert.strictEqual(Pull.entryPull(spot, 20), 1);
assert.strictEqual(Pull.entryPull(null, 30), 1);

// A pull of k is one mob with k times the HP and the mean attack of the mobs still standing:
// (k + 1) / 2 felled one by one, all k worn down together by area skills.
assert.deepStrictEqual(Pull.pullView({ maxHp: 100, pAtk: 10, pDef: 5 }, 3), { maxHp: 300, pAtk: 20, pDef: 5, pull: 3, pack: 2, unitPAtk: 10 });
assert.strictEqual(Pull.pullView({ maxHp: 100, pAtk: 10 }, 3, 1).pAtk, 30);
assert.strictEqual(Pull.pullView({ maxHp: 100, pAtk: 10 }, 3, 0.5).pAtk, 25);
const single = { maxHp: 100, pAtk: 10 };
assert.strictEqual(Pull.pullView(single, 1), single);

// An entry's pulls: the measured mix, else the two whole sizes around its mean, else one mob.
assert.deepStrictEqual(Pull.pullsOf(spot.npcEntries[0]), [[1, 0.5], [2, 0.5]]);
assert.deepStrictEqual(Pull.pullsOf({ pull: 2.5 }), [[2, 0.5], [3, 0.5]]);
assert.deepStrictEqual(Pull.pullsOf({ pull: 3 }), [[3, 1]]);
assert.deepStrictEqual(Pull.pullsOf({}), [[1, 1]]);
// The cold fight rolls one size of the mix once per new fight; shares need not sum to one.
assert.strictEqual(Pull.rollPulls([[3, 1]], () => assert.fail('one size draws nothing')), 3);
assert.strictEqual(Pull.rollPulls([[1, 0.7], [2, 0.25], [4, 0.05]], () => 0.69), 1);
assert.strictEqual(Pull.rollPulls([[1, 0.7], [2, 0.25], [4, 0.05]], () => 0.7), 2);
assert.strictEqual(Pull.rollPulls([[1, 0.7], [2, 0.25], [4, 0.05]], () => 0.99), 4);
assert.strictEqual(Pull.rollPulls([[1, 0.2], [2, 0.2]], () => 0.5), 2);

// Cold: the solo fight rolls its pull; the mob stays one mob for the readiness margin.
const Data = invoke('GameServer/DataCache');
Data.init();
const Cold = invoke('GameServer/Bot/Population/ColdCombatProfile');
const template = Data.npcs.find(n => n.template?.kind === 'Monster' && Number(n.template.level) === 20 && !n.template.hostile);
assert(template, 'datapack has a passive level-20 monster');
const base = Cold.npcCombatStats(template);
const coldSpot = { npcEntries: [{ selfId: template.selfId, count: 3, pull: 3 }] };
const pulled = Cold.npcForSpot(coldSpot, () => 0.5, { pull: true });
assert.strictEqual(pulled.pull, 3);
assert.strictEqual(pulled.maxHp, base.maxHp);
const alone = Cold.npcForSpot(coldSpot, () => 0.5);
assert.strictEqual(alone.pull, undefined, 'party and other callers keep one mob');
assert.strictEqual(alone.maxHp, base.maxHp);

// A won pull gives every mob's kill; the cycle reports the pull for the mobs-per-pull counter.
const Resolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const gremlins = pull => ({ id: 'starter_gremlin', name: 'Gremlin field', avgLevel: 1, density: 1, npcSelfIds: [1],
    npcEntries: [{ selfId: 1, count: 3, ...(pull ? { pull } : {}) }],
    rewards: { exp: 10, sp: 2, adenaMin: 7, adenaMax: 10 }, mob: { hp: 8, damage: 1 } });
const hunter = () => ({ characterId: 71, name: 'ColdHunter', level: 10, levelBand: '10-12', activity: 'hunting',
    vitals: { hp: 99999, maxHp: 99999, mp: 99999, maxMp: 99999 }, stats: {}, party: { role: 'dps' } });
const hunt = pull => Resolver.resolveSolo({ state: hunter(), spot: gremlins(pull), elapsedMs: 60000, rng: () => 0 });
// T106: the walk between mobs sets the fights of the minute; each counts per won fight.
const one = hunt(0), two = hunt(2);
assert(one.debug.wins > 0 && two.debug.wins > 0);
// A pull counts when its fight starts (the last walk engages one more).
assert.deepStrictEqual([one.debug.pulls, one.debug.pullMobs], [one.debug.attemptedFights, one.debug.attemptedFights]);
assert.deepStrictEqual([two.debug.pulls, two.debug.pullMobs], [two.debug.attemptedFights, 2 * two.debug.attemptedFights]);
assert.strictEqual(two.materialize.exp / two.debug.wins, one.materialize.exp / one.debug.wins * 2, 'each mob of the pull gives its exp');
assert.strictEqual(two.materialize.items.length / two.debug.wins, one.materialize.items.length / one.debug.wins * 2,
    'each mob rolls its drops');
const fightMs = result => (result.debug.combatMs - result.debug.walkedMs) / result.debug.wins;
assert(fightMs(two) > fightMs(one), 'two mobs take longer to kill');
// User 10-29: the bot fights only the pull sizes it survives. The weaponless level-10 hunter survives a
// gremlin pair but not a trio; on a field of 70% pairs and 30% trios, a roll that would draw a trio
// draws among the pairs, and the field is still hunted.
const mixed = { ...gremlins(0), npcEntries: [{ selfId: 1, count: 3, pulls: [[2, 0.7], [3, 0.3]] }] };
const mixedFight = Resolver.resolveFight({ state: hunter(), spot: mixed, rng: () => 0.99, timestamp: 1e12 });
assert(!mixedFight.avoided, 'a field with survivable pairs is hunted');
const Matchup = invoke('GameServer/Bot/AI/BotTargetMatchup');
const hunterProfiles = Matchup.coldProfiles(Cold.fightProfile(hunter(), 1e12), hunter(), 1e12);
const mixedPick = Cold.npcForSpot(mixed, () => 0.99, { soloSafety: true, pull: true, matchupProfiles: hunterProfiles });
assert.deepStrictEqual([mixedPick.pull, mixedPick.usualPull], [2, 2], 'a trio roll becomes a pair');
assert.deepStrictEqual(Matchup.speciesPulls(hunterProfiles, mixed.npcEntries[0], { soloSafety: true }),
    { efficiency: Matchup.speciesPulls(hunterProfiles, mixed.npcEntries[0], { soloSafety: true }).efficiency,
        canHunt: true, share: 0.7, allowed: [[2, 0.7]] });
assert.strictEqual(Cold.npcForSpot(mixed, () => 0.99, { pull: true }).pull, 3, 'without safety the whole mix is rolled');
// User 10-29: a round counts only the spawns the bot may fight. One lone gremlin group
// (production 6 a hour) beside 45 trio spawns it cannot survive feeds one kill in ten
// minutes and one fight a round, not the trios' respawns.
const lone = { ...gremlins(0), density: 46, npcEntries: [{ selfId: 1, count: 1, production: 6 },
    { selfId: 1, count: 45, pulls: [[3, 1]], production: 270 }] };
const shares = Resolver.admittedShares(hunter(), lone, 1e12);
assert.deepStrictEqual([...shares.values()], [1, 0]);
assert.strictEqual(Resolver.admittedDensity(lone, shares), 1);
assert.strictEqual(Resolver.soloShareMobs(lone, 600000, 1, shares), 1);
const loneRound = Resolver.resolveSolo({ state: hunter(), spot: lone, elapsedMs: 600000, rng: () => 0, timestamp: 1e12 });
assert(loneRound.debug.mobsKilled <= 1, `the lone group feeds its own respawns (${loneRound.debug.mobsKilled})`);
assert.deepStrictEqual(loneRound.debug.killedNpcs, loneRound.debug.mobsKilled ? { 1: loneRound.debug.mobsKilled } : {});
// A round judges its fights by one set of matchup profiles (the species verdicts are kept per
// profile array): several fights, one build.
const builtProfiles = Matchup.coldProfiles;
let builds = 0;
Matchup.coldProfiles = (...args) => { builds++; return builtProfiles(...args); };
try {
    const round = Resolver.resolveSolo({ state: hunter(), spot: { ...gremlins(0), density: 9, npcEntries: [{ selfId: 1, count: 9 }] },
        elapsedMs: 60000, rng: () => 0, timestamp: 1e12 });
    assert(round.debug.wins > 1, `the round fights more than once (${round.debug.wins})`);
    assert.strictEqual(builds, 1, 'one profile build for the round');
} finally { Matchup.coldProfiles = builtProfiles; }
// T106 (user 10-29): a species whose usual pull the hunter cannot survive is not hunted, as one mob it would be.
const pack = hunt(3);
assert.deepStrictEqual([pack.debug.pulls, pack.patch.stats.lastReason], [0, 'no_safe_solo_target'],
    'a weaponless level-10 hunter leaves a field of gremlin trios alone');
// After a win the hunter's remaining HP meets the usual pull too: a level-11 hunter takes
// gremlin trios at full HP (323), but at 200 HP it takes a lone gremlin and rests before a trio.
const hurt = { ...hunter(), level: 11, vitals: { hp: 200, maxHp: 99999, mp: 99999, maxMp: 99999 } };
const nextFight = pull => Resolver.resolveFight({ state: hurt, spot: gremlins(pull), rng: () => 0, timestamp: 1e12 });
assert(!nextFight(0).avoided, 'a lone gremlin is fought at 200 HP');
assert.strictEqual(nextFight(3).reason, 'solo_recovery_needed', 'a usual trio is rested for at 200 HP');

// Area and aura skills hit every mob of the pull (F20, plan 3.3(в)): a nuker whose
// only spell strikes an area kills a pull of three about as fast as one mob, while
// a single-target nuker of the same damage needs three times as long.
const fieldMob = Data.npcs.find(n => n.template?.kind === 'Monster' && Number(n.template.level) === 20 && !n.template.hostile);
const nuker = selfId => ({ characterId: 72, name: 'ColdNuker', level: 20, levelBand: '20-22', activity: 'hunting',
    vitals: { hp: 99999, maxHp: 99999, mp: 99999, maxMp: 99999 }, inventory: {}, party: { role: 'dps' },
    stats: { classId: 11, coldCombat: { version: 1, classId: 11,
        base: { str: 22, dex: 21, con: 27, int: 41, wit: 20, men: 39 },
        equipment: { weaponKind: 'Weapon.Staff', pAtk: 20, pAtkRnd: 0, mAtk: 300, atkSpd: 300, critical: 0, accur: 0,
            pDef: 99999, mDef: 99999, evasion: 0, bonusMp: 20000, shieldPDef: 0 },
        // Same record for both: Flame Strike (area) and Wind Strike (one target).
        effects: [], skills: [{ selfId, level: 1, passive: false, spell: true, power: 4, mp: 20, hitTime: 2000, reuse: 1 }] } } });
const field = pull => ({ id: 'f20_field', name: 'F20 field', avgLevel: 20, density: 1, npcSelfIds: [fieldMob.selfId],
    // One mob a minute respawns for the lone hunter: the round holds one fight (T106: else the walk sets them).
    npcEntries: [{ selfId: fieldMob.selfId, count: 3, production: 60, ...(pull > 1 ? { pull } : {}) }],
    rewards: { exp: 10, sp: 2, adenaMin: 7, adenaMax: 10 }, mob: { hp: 8, damage: 1 } });
const nukeFight = (selfId, pull) => {
    const result = Resolver.resolveSolo({ state: nuker(selfId), spot: field(pull), elapsedMs: 60000, rng: () => 0.5 });
    assert.strictEqual(result.debug.wins, 1, `skill ${selfId} wins its pull of ${pull}`);
    assert(result.debug.skillUses > 1, 'the nuker casts its spell');
    // The fight's time, without the walk to it.
    return { ...result.debug, fightMs: result.debug.combatMs - result.debug.walkedMs };
};
const areaOne = nukeFight(1181, 1), areaThree = nukeFight(1181, 3);
const singleOne = nukeFight(1177, 1), singleThree = nukeFight(1177, 3);
assert.strictEqual(areaOne.fightMs, singleOne.fightMs, 'equal damage against one mob');
assert(singleThree.fightMs > 2.5 * singleOne.fightMs, 'a single-target nuker kills the three one by one');
assert(areaThree.fightMs < 1.5 * areaOne.fightMs, 'an area nuker kills the three together');
assert(areaThree.areaPullHits > 0, 'the cycle reports area hits on a pull');
assert.strictEqual(singleThree.areaPullHits, 0);
assert.strictEqual(areaOne.areaPullHits, 0, 'a lone mob takes no area hits');

// The same rule in the matchup estimate a pull is judged by (hot target choice).
const Rules = invoke('GameServer/Skills/C4SkillRules');
const caster = sourceTarget => [{ role: 'mage', maxHp: 1000, pDef: 100, mAtk: 400, castSpd: 333, maxMp: 1000,
    skills: [{ selfId: 9001, spell: true, power: 50, mp: 10, hitTime: 2000, reuse: 1,
        semantic: { skillType: Rules.DAMAGE, target: 'enemy', sourceTarget } }] }];
const packMob = { maxHp: 1000, pAtk: 50, atkSpd: 253, pDef: 100, mDef: 100, basePDef: 100, baseMDef: 100 };
const margin = (sourceTarget, k) => Matchup.soloSurvival(caster(sourceTarget), Pull.pullView(packMob, k)).survivalRatio;
assert.strictEqual(margin('area', 1), margin(null, 1), 'one mob: area and single-target are equal');
// A pull of three: the area spell counts three times, and the three mobs it
// wears down together all hit (pack 3 instead of 2): 3 x 2 / 3.
assert(Math.abs(margin('aura', 3) / margin(null, 3) - 2) < 1e-9, 'a pull of three: three hits, three mobs standing');

console.log('Bot pull estimate checks passed');
