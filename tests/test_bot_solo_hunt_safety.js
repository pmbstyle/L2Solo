const assert = require('assert');
require('../src/Global');
const Data = invoke('GameServer/DataCache');
const Match = invoke('GameServer/Bot/AI/BotTargetMatchup');
const Cold = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Routes = invoke('GameServer/Bot/AI/LevelingRoutes');
const Spots = invoke('GameServer/Bot/Population/SpotProfiles');
const Risk = invoke('GameServer/Bot/Population/SpotRiskPolicy');
const Efficiency = invoke('GameServer/Bot/AI/BotHuntEfficiency');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Protocol = invoke('GameServer/Bot/Population/ColdSimulationProtocol');
Data.init();

const at = 1800000000000;
const mage = { classId: 12, level: 29, role: 'mage', maxHp: 592, maxMp: 932,
    pDef: 243, pAtk: 96, mAtk: 162, castSpd: 194, atkSpd: 263, weaponMask: 8,
    equipment: { weaponKind: 'Weapon.Blunt' },
    skills: [{ selfId: 1230, level: 1, spell: true, passive: false, power: 51, mp: 35, hitTime: 4000 }] };
const target = { maxHp: 500, pAtk: 60, atkSpd: 253, pDef: 100, mDef: 70,
    basePDef: 100, baseMDef: 70, vulnerabilities: {} };
assert(Match.soloSurvival([mage], target).eligible);
assert(!Match.soloSurvival([mage], { ...target, maxHp: 10000 }).eligible, 'HP multipliers matter without level changes');
assert(!Match.soloSurvival([mage], { ...target, pAtk: 1000 }).eligible, 'incoming damage matters without resistances');
assert(!Match.soloSurvival([{ ...mage, maxMp: 10 }], target).eligible, 'a spell beyond the MP budget cannot prove survival');
assert(!Match.soloSurvival([{ ...mage, skills: mage.skills.map(skill => ({ ...skill, reuse: 120000 })) }], target).eligible,
    'a long-cooldown spell cannot be treated as continuous damage');
assert(Match.soloSurvival([{ ...mage, maxHp: undefined }], target).eligible, 'legacy incomplete data is neutral');
assert(Match.soloSurvival(Match.stateProfiles({ level: 29 }), { ...target, maxHp: 10000 }).eligible,
    'a partial route projection cannot manufacture a weak default build');
assert(!Match.soloSurvival(Match.stateProfiles({ level: 29, stats: { classId: 12 } }), { ...target, maxHp: 10000 }).eligible,
    'a known unequipped mage is still subject to the safety check');
const fragile = { ...mage, maxHp: 10 };
const servitor = { role: 'dps', maxHp: 2000, pDef: 300, pAtk: 300, atkSpd: 300, skills: [] };
assert(!Match.soloSurvival([fragile], target).eligible);
assert(Match.soloSurvival([fragile, servitor], target).eligible, 'native profiles retain tanking allies');
const withSummon = (owner, hp = servitor.maxHp) => Match.coldProfiles(owner, { stats: { coldCombat: {
    summon: { ...servitor, active: true, hp, expiresAt: at + 60000 }
} } }, at);
// The pet tanks first, as in C4 (user 10-29): a fragile owner hunts behind a
// sound pet, not behind a pet with its HP nearly gone.
assert(Match.soloSurvival(withSummon(fragile), target).eligible, 'a cold summon tanks for a fragile owner');
assert(!Match.soloSurvival(withSummon(fragile, 1), target).eligible, 'a pet at 1 HP shields nothing');
const durable = { ...mage, skills: [], maxHp: 150 };
assert(!Match.soloSurvival([durable], target).eligible);
assert(Match.soloSurvival(withSummon(durable), target).eligible,
    'summon damage still helps an owner survive a fight');
// Admission uses the skill the fight picks. With T100's MP price a fresh
// fight from full MP picks the best damage rate: the faster Aura Burn.
const necro = { classId: 13, level: 45, role: 'mage', maxHp: 932, maxMp: 1489,
    pDef: 202, pAtk: 75.8, mAtk: 167.5, castSpd: 376, atkSpd: 383, weaponMask: 4,
    equipment: { weaponKind: 'Weapon.Sword' }, skills: [
        { selfId: 1148, level: 1, passive: false, spell: true, power: 58, mp: 23, hitTime: 4000, reuse: 6000 },
        { selfId: 1172, level: 8, passive: false, spell: true, power: 36, mp: 30, hitTime: 1500, reuse: 2500 }
    ] };
const lizard = Cold.npcCombatStats(Data.npcs.find(row => row.selfId === 784));
const nativeChoice = invoke('GameServer/Bot/Population/ColdClassPolicy').select(necro,
    { hp: necro.maxHp, mp: necro.maxMp, cooldowns: {}, time: at, mob: lizard });
assert.equal(nativeChoice.skill.selfId, 1172);
const realRotation = Match.coldProfiles(necro, {}, at);
assert.deepStrictEqual(Object.entries(realRotation[0].soloAttackScores).sort((a, b) => b[1] - a[1])[0][0], '1172',
    'the gate ranks the fight\'s pick first');
assert(Match.soloSurvival(realRotation, lizard).eligible, 'the picked Aura Burn admits this fight');
const frail = Match.coldProfiles({ ...necro, maxHp: 150 }, {}, at);
assert(!Match.soloSurvival(frail, lizard).eligible, 'a frail caster is still refused');
assert(Cold.npcForSpot({ npcEntries: [{ selfId: 784, count: 1 }] }, () => 0.5,
    { matchupProfiles: frail, soloSafety: true }).avoided, 'the executor refuses the unsafe voluntary target');
// The fight reads fightProfile, the route profileFor: both give the fixture.
const savedProfile = Cold.profileFor, savedFight = Cold.fightProfile, savedSpots = Spots.cache;
try {
    // Enough HP that the next lizard still ends above its potion line (BotEncounterReadiness).
    const owned = { ...necro, maxHp: 1400, accur: 100, evasion: 0, critical: 0, mCritRate: 0,
        equipment: { ...necro.equipment, pAtkRnd: 0 }, effects: [], skills: [...necro.skills,
            { selfId: 1220, level: 1, passive: false, spell: true, power: 44, mp: 22, hitTime: 4000, reuse: 6000 },
            { selfId: 1015, level: 3, passive: false, spell: true, power: 107, mp: 32, hitTime: 2000, reuse: 3000 }
        ] };
    Cold.profileFor = Cold.fightProfile = () => owned;
    const ground = { id: 'solo-heal-loop', name: 'Solo heal loop', avgLevel: 36, density: 6,
        npcEntries: [{ selfId: 1639, count: 6 }], npcSelfIds: [1639] };
    Spots.cache = [ground];
    const fighter = { characterId: 990005, level: 45, activity: 'hunting', spotId: ground.id, inventory: {},
        vitals: { hp: owned.maxHp, maxHp: owned.maxHp, mp: necro.maxMp, maxMp: necro.maxMp },
        stats: { classId: 13, role: 'mage' } };
    const fight = invoke('GameServer/Bot/Population/BackgroundResolver').resolveSolo({
        state: fighter, spot: ground, elapsedMs: 60000, timestamp: at, rng: () => 0.5 });
    // T107: between fights the bot may heal where that beats sitting (gapHeals); in the fight it must not.
    assert.equal(fight.debug.heals - fight.debug.gapHeals, 0, 'a heal weaker than damage during its cast cannot replace the finishing attack');
    // T100: the priced pick (Aura Burn) kills fast enough for more lizards
    // within the minute; the remaining HP still admits them. T106: the walk
    // between the six (10 s each) and T126's kill floor (each kill also costs
    // its killing cast) hold the minute to three kills, and the last walk
    // engages a fourth.
    assert.equal(fight.debug.wins, 3, 'the native rotation finishes the lizards');
    assert.equal(fight.debug.died, false);
    assert.equal(fight.debug.attemptedFights, 4, 'remaining HP must be checked before the next voluntary mob');
    assert.equal(fight.patch.activity, 'hunting', 'quick kills leave enough HP to keep hunting');
} finally { Cold.profileFor = savedProfile; Cold.fightProfile = savedFight; Spots.cache = savedSpots; }

// A wealthy reward forecast or a future gear target cannot admit a lethal
// ordinary hunt. Clan membership changes neither the equipped combat profile
// nor the ability to earn on safe mobs below the character's level.
try {
    Cold.profileFor = Cold.fightProfile = () => mage;
    const safe = { id: 'safe-lower-farm', name: 'Mandragora field', minLevel: 25, maxLevel: 25,
        avgLevel: 25, density: 6, npcEntries: [{ selfId: 156, count: 6 }] };
    const unsafe = { id: 'unsafe-level-farm', name: 'Spartoi field', minLevel: 29, maxLevel: 29,
        avgLevel: 29, density: 6, npcEntries: [{ selfId: 1142, count: 6 }] };
    Spots.cache = [safe, unsafe];
    const Route = invoke('GameServer/Bot/Economy/EquipmentIncomeRoute');
    for (const clanLevel of [0, 1]) for (const grade of ['d', 'c', 'b', 'a', 's']) {
        let hunter = { characterId: 990006, level: 29, activity: 'hunting', spotId: unsafe.id,
            clanId: clanLevel ? 7 : 0, clanLevel, inventory: {},
            vitals: { hp: mage.maxHp, mp: mage.maxMp }, stats: { classId: 12, role: 'mage',
                wishFocus: ['power:200:14', 1, 1000000], equipmentPlan: { status: 'active',
                    strategy: 'direct_drop', grade, next: { spotId: unsafe.id, npcId: 1142 } } } };
        for (let sample = 0; sample < 3; sample++) for (const spot of Spots.cache) {
            hunter.stats.huntEfficiency = Efficiency.record(hunter, { spotId: spot.id, timestamp: at,
                cycleMs: 60000, adena: spot === unsafe ? 100000 : 1000, costs: 100,
                loot: 0, exp: 100, kills: 1 });
        }
        assert.equal(Route.select(hunter, { spots: Spots.cache, timestamp: at, required: true })?.spot.id,
            safe.id, 'the earning selector rejects higher income on mobs the equipped bot cannot survive');
        assert.equal(Spots.findForState(hunter, { timestamp: at, occupancy: {} })?.id, safe.id,
            'an active unsafe gear source cannot override ordinary hunt safety for a clan member or a solo bot');
    }
} finally { Cold.profileFor = savedProfile; Cold.fightProfile = savedFight; Spots.cache = savedSpots; }

const bow = { role: 'archer', pAtk: 100, pDef: 100, maxHp: 1000, atkSpd: 300,
    weaponMask: 32, equipment: { weaponKind: 'Weapon.Bow' }, skills: [] };
const resistedTarget = { ...target, vulnerabilities: { bowWpnVuln: 0.1 } };
const bowRatio = Match.soloSurvival([bow], resistedTarget).survivalRatio;
// Safe: the resisted mob takes minutes to kill, and a long fight must be outlasted
// above the potion line with the margin of its length (BotEncounterReadiness). The
// bow grows from an even race in 5 % steps to the first HP the gate admits, so
// safeBow sits at most 5 % above the margin's lower edge.
let safeBow = { ...bow, maxHp: bow.maxHp * Match.SOLO_GATE_MARGIN / bowRatio };
for (let step = 0; step < 200 && !Match.soloCanHunt([safeBow], resistedTarget).eligible; step++) {
    safeBow = { ...safeBow, maxHp: safeBow.maxHp * 1.05 };
}
assert(!Match.evaluate([safeBow], resistedTarget).eligible, 'fixture: the ordinary resistance gate rejects efficiency 0.1');
assert(Match.soloCanHunt([safeBow], resistedTarget).eligible, 'solo hunting accepts a resisted mob it safely survives');
assert(Match.soloSurvival([{ ...safeBow, maxHp: safeBow.maxHp * 0.8 }], resistedTarget).survivalRatio > 1,
    'fixture: a fifth less HP still wins the race');
assert(!Match.soloCanHunt([{ ...safeBow, maxHp: safeBow.maxHp * 0.8 }], resistedTarget).eligible,
    'a fifth less HP would end the long fight below the potion line: refused');
assert(Match.soloCanHunt([{ ...safeBow, maxHp: safeBow.maxHp * 2 }], resistedTarget).eligible, 'more HP is never refused');
assert(!Match.soloCanHunt([safeBow], resistedTarget, { maxTargetLevel: 27, npcLevel: 29 }).eligible);
assert.equal(Match.soloCanHunt([safeBow], resistedTarget, { maxTargetLevel: 27, npcLevel: 29 }).reason, 'recovery_level');
assert(!Match.soloCanHunt([{ ...safeBow, maxHp: undefined }], resistedTarget).eligible,
    'an unknown kit still uses the ordinary resistance gate');
assert.equal(Match.soloCanHunt([{ ...safeBow, maxHp: safeBow.maxHp * 0.8 }], resistedTarget).reason,
    'insufficient_survival_margin', 'a refused fight says why');

// More HP never refuses a fight less HP takes (BotEncounterReadiness reads the time
// the attacks take to deal the mob's HP, not the side's life over its ratio). From
// the first HP admitted (5 % steps), every step up to eight times is admitted too,
// and a huge bar. attacksOf: synthetic attacks, so only the fight-time rule is read.
const alwaysAdmitted = (label, make, mob, attacksOf) => {
    let first = null;
    for (let step = 0; step < 300 && first === null; step++) {
        const hp = 50 * 1.05 ** step;
        if (Match.soloCanHunt(make(hp), mob, { attacksOf }).eligible) first = hp;
    }
    assert(first !== null, `${label}: some HP admits the fight`);
    for (let hp = first; hp <= first * 8; hp *= 1.05) {
        assert(Match.soloCanHunt(make(hp), mob, { attacksOf }).eligible, `${label}: ${Math.round(hp)} HP (first ${Math.round(first)}) admitted`);
    }
    assert(Match.soloCanHunt(make(100000), mob, { attacksOf }).eligible, `${label}: a huge bar admitted`);
};
// A summoner held under its pet's hate whose own MP budget (900) limits it: the
// pet falls early, the owner then spends its budget.
const warlock = hp => [{ classId: 14, role: 'mage', level: 40, maxHp: hp, maxMp: 1000, pDef: 300, mDef: 300, skills: [] },
    { role: 'dps', servitor: true, soloDamageReceiver: false, maxHp: 120, pDef: 80, mDef: 80, pAtk: 100, atkSpd: 280, skills: [] }];
alwaysAdmitted('a summoner on its budget', warlock, target, profile => profile.servitor === true
    ? [{ weight: 15, hit: 15, modifier: 1, normal: true }]
    : [{ weight: 50, hit: 50, modifier: 1, damageBudget: 900 }]);
// A fast budgeted skill (50/s, 500 of damage) and a slow free hit (20/s): with
// more HP the hit deals more by the side's end, the skill still ends the fight first.
const gladiator = hp => [{ classId: 2, role: 'dps', level: 40, maxHp: hp, maxMp: 1000, pDef: 300, mDef: 300, skills: [] }];
alwaysAdmitted('a budgeted skill beside a free hit', gladiator, { ...target, maxHp: 450 }, () => [
    { weight: 50, hit: 100, modifier: 1, damageBudget: 500 }, { weight: 20, hit: 20, modifier: 1, normal: true }]);

const exp = Number(Data.experience[28]) + 100000;
const state = { characterId: 990003, level: 29, exp, sp: 0, adena: 0,
    phase: 'cold', activity: 'hunting', spotId: 'danger', inventory: {}, loc: {}, timing: {},
    vitals: { hp: 592, maxHp: 592, mp: 932, maxMp: 932 },
    stats: { classId: 12, classProgressionClassId: 12, classProgressionLevel: 29, deaths: 0 } };
const first = Risk.recordRecovery(state, { deaths: 1, exp: exp - 100, expBeforeDeath: exp });
const recovering = { ...state, stats: { ...state.stats, huntingRecovery: first } };
assert.strictEqual(Routes.targetLevelForState(recovering), 27);
const moved = JSON.parse(JSON.stringify({ ...recovering, spotId: 'elsewhere' }));
assert.strictEqual(Routes.targetLevelForState(moved), 27, 'travel and restart retain the lower target level');
assert.strictEqual(Routes.targetLevelForState({ ...moved, party: { partyId: 'reinforced' } }), 29,
    'solo setbacks do not penalize a reinforced party');
assert.strictEqual(Routes.scoreSpot({ id: 'party', minLevel: 29, maxLevel: 29, avgLevel: 29 }, moved,
    { mode: 'party', matchupProfiles: [mage] }).level, 29, 'explicit party projections also ignore solo setbacks');
const second = Risk.recordRecovery(moved, { deaths: 1, exp: exp - 200, expBeforeDeath: exp - 100 });
assert.strictEqual(second.levelPenalty, 4);
const successful = Risk.recordRecovery({ ...moved, stats: { ...moved.stats, huntingRecovery: second } },
    { wins: 12, exp });
assert.strictEqual(successful.levelPenalty, 2, 'successful farming eases caution gradually, without a timer');
assert.strictEqual(Risk.recordRecovery(recovering, { wins: 12, exp: exp - 1 }).levelPenalty, 2,
    'wins without recovering lost XP must not restore the old difficulty');
const restored = Risk.recordRecovery(recovering, { wins: 12, exp });
assert.strictEqual(restored.levelPenalty, 0);

const boundary = Risk.recordResolve({}, { spotId: 'danger', timestamp: at, fights: 12, wins: 11, deaths: 1 });
let failedHunts = Risk.recordResolve({}, { spotId: 'danger', timestamp: at, fights: 5, wins: 5 });
for (let i = 0; i < 2; i++) {
    failedHunts = Risk.recordResolve(failedHunts, { spotId: 'danger', timestamp: at + i + 1,
        fights: 1, wins: 0, failedHunts: 1 });
}
assert(!Risk.deathPressure({ ...state, stats: { spotRisk: failedHunts } }));
const restingRisk = Risk.recordResolve(failedHunts, { spotId: 'danger', timestamp: at + 3, fights: 0, wins: 0 });
assert.strictEqual(restingRisk.failedHunts, 2, 'resting or a pending slice neither creates nor hides a failed hunt');
const winningRisk = Risk.recordResolve(failedHunts, { spotId: 'danger', timestamp: at + 3, fights: 1, wins: 1 });
assert.strictEqual(winningRisk.failedHunts, 2, 'one lucky victory must not erase repeated abandoned fights');
const recoveredRisk = Risk.recordResolve(winningRisk, { spotId: 'danger', timestamp: at + 4, fights: 2, wins: 2 });
assert.strictEqual(recoveredRisk.failedHunts, 0, 'three clean wins restore confidence in the same spot');
failedHunts = Risk.recordResolve(winningRisk, { spotId: 'danger', timestamp: at + 4, fights: 1, wins: 0, failedHunts: 1 });
assert.strictEqual(Risk.deathPressure({ ...state, stats: { spotRisk: failedHunts } }).reason, 'failed_hunts',
    'old wins must not hide three subsequent abandoned fights');
assert.strictEqual(Risk.recordResolve(failedHunts, { spotId: 'elsewhere', timestamp: at + 5 }).failedHunts, 0);
const repeated = Risk.recordResolve(boundary, { spotId: 'danger', timestamp: at + 1, fights: 1, wins: 0, deaths: 1 });
assert.strictEqual(Risk.deathPressure({ ...state, stats: { spotRisk: repeated } }).reason, 'death_pressure',
    'two deaths spanning the old window boundary must still force relocation');

const spot = (id, npcId, level, density) => ({ id, name: id, minLevel: level, maxLevel: level, avgLevel: level,
    density, tags: [], tagsAuthoritative: true, center: { locX: 50000, locY: 150000, locZ: -3000 },
    npcEntries: [{ selfId: npcId, count: density }], levelCounts: { [level]: density } });
const easy = spot('easy', 156, 25, 8);
const hard = spot('danger', 1142, 29, 1000);
const original = Spots.cache;
try {
    Spots.cache = [hard, easy];
    const chosen = Spots.findForState(recovering, { matchupProfiles: [mage], occupancy: {}, timestamp: at });
    assert.strictEqual(chosen.id, 'easy', 'high density cannot keep a recovering mage on stronger ground');
    assert.strictEqual(Routes.bestSpot([hard], recovering, { matchupProfiles: [mage] }), null,
        'absence of safe ground cannot silently re-admit a failed candidate');
    assert(Cold.npcForSpot(hard, () => 0, { matchupProfiles: [mage], soloSafety: true, maxTargetLevel: 27 }).avoided,
        'cold target selection uses the same lowered difficulty as routing');
    assert(!Cold.npcForSpot(easy, () => 0, { matchupProfiles: [mage], soloSafety: true, maxTargetLevel: 27 }).avoided);
    const stranded = { ...state, level: 35 };
    assert.strictEqual(Spots.findForState(stranded, { matchupProfiles: [mage], occupancy: {}, timestamp: at })?.id, 'easy',
        'without safe camps near its own level, a weak bot can resume on lower-level safe ground');
    assert.strictEqual(Spots.findForState(stranded, { matchupProfiles: [mage], occupancy: {}, timestamp: at,
        excludedSpotIds: new Set(['easy']) }), null, 'lower-level recovery still honors failed-spot exclusions');
    const otherEasy = { ...easy, id: 'other-easy', density: 20 };
    Spots.cache = [hard, easy, otherEasy];
    assert.strictEqual(Spots.findForState({ ...stranded, spotId: easy.id }, {
        matchupProfiles: [mage], occupancy: {}, timestamp: at })?.id, 'other-easy',
    'a lower-level fallback leaves its old camp when another allowed camp has a better value');
    assert.strictEqual(Spots.findForState({ ...stranded, spotId: otherEasy.id }, {
        matchupProfiles: [mage], occupancy: {}, timestamp: at })?.id, 'other-easy',
    'the best lower-level fallback remains stable');
} finally { Spots.cache = original; }

const Resolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const Encounter = invoke('GameServer/Bot/Population/ColdPveEncounter');
const Readiness = invoke('GameServer/Bot/AI/BotEncounterReadiness');
// A fight is admitted by what the bot has now against this mob, not by a share of its HP.
const readied = [{ ...mage, accur: 100, evasion: 0, critical: 0, effects: [] }];
const weakMob = { ...target, level: 25, maxHp: 50, pAtk: 1, accur: 100, evasion: 0, critical: 0 };
const hardMob = { ...target, level: 25, accur: 100, evasion: 0, critical: 0 };
assert(Readiness.evaluate(Readiness.atVitals(readied, mage.maxHp * 0.4, mage.maxMp * 0.3), weakMob).ready,
    'a bot at 40% HP and 30% MP takes a mob it beats with that');
assert(!Readiness.evaluate(Readiness.atVitals(readied, 1, 0), hardMob).ready, 'a bot that cannot cover the mob sits');
const originalProfile = Cold.profileFor, originalFight = Cold.fightProfile;
const originalNpc = Cold.npcForSpot;
try {
    Cold.profileFor = Cold.fightProfile = () => ({ ...mage, accur: 100, evasion: 0, critical: 0, effects: [] });
    Cold.npcForSpot = () => ({ ...target, level: 25, selfId: 156, accur: 100, evasion: 0, critical: 0 });
    const hurt = { ...state, spotId: easy.id, vitals: { ...state.vitals, hp: 150, mp: 300 } };
    const recover = Resolver.resolveSolo({ state: hurt, spot: easy, elapsedMs: 0, timestamp: at, rng: () => 0.5 });
    assert.strictEqual(recover.patch.activity, 'resting', 'cold solo hunters recover before starting another fight');
    assert.strictEqual(recover.patch.stats.lastReason, 'solo_recovery_needed');
    assert.strictEqual(recover.debug.attemptedFights, 0);
    assert.strictEqual(recover.materialize.exp, 0);
    assert(recover.nextResolveAt > at && recover.events.some(event => event.type === 'rest'));
    // A bot the next fight refuses rests to its rested line (RestPolicy.restOver, the hot rest's
    // rule), as a player sits once and then chains kills: not up at the HP the fight would take.
    const RestPolicy = invoke('GameServer/Bot/AI/RestPolicy');
    const worn = { ...hurt, vitals: { ...hurt.vitals, hp: 215, mp: 300 } };
    const refused = Resolver.resolveSolo({ state: worn, spot: easy, elapsedMs: 0, timestamp: at, rng: () => 0.5 });
    assert.strictEqual(refused.patch.stats.lastReason, 'solo_recovery_needed');
    const restUntil = refused.patch.stats.restUntil;
    assert.strictEqual(restUntil - at, Resolver.estimateRestMs(worn, worn.vitals, { line: RestPolicy.THRESHOLDS.rested }),
        'the rest lasts to the rested line');
    const sat = { ...worn, activity: 'resting', vitals: refused.patch.vitals, timing: { lastResolvedAt: at },
        stats: { ...worn.stats, ...refused.patch.stats } };
    const early = Resolver.resolveRest(sat, (restUntil - at) / 2, at + (restUntil - at) / 2);
    assert.strictEqual(early.patch.activity, 'resting', 'halfway there the bot rests on');
    const up = Resolver.resolveRest(sat, restUntil - at, restUntil);
    assert.strictEqual(up.patch.activity, 'hunting', 'at its rested line the rest is over');
    assert(up.patch.vitals.hp >= 0.95 * mage.maxHp, `on a high bar (${up.patch.vitals.hp})`);
    const next = Resolver.resolveSolo({ state: { ...sat, activity: 'hunting', vitals: up.patch.vitals,
        stats: { ...sat.stats, ...up.patch.stats } }, spot: easy, elapsedMs: 0, timestamp: restUntil, rng: () => 0.5 });
    assert(next.debug.attemptedFights > 0, 'and takes the fight, without sitting again');
    // The persona's caution moves the line (RestPolicy.restedLine, hot and cold alike).
    const restFor = caution => Resolver.resolveSolo({ state: { ...worn, persona: { traits: { caution } } },
        spot: easy, elapsedMs: 0, timestamp: at, rng: () => 0.5 }).patch.stats.restUntil - at;
    assert(restFor(1) > restUntil - at && restUntil - at > restFor(0), 'a cautious bot rests longer, a reckless one less');
    // Refused already at its line (a reckless bot at 93 %), the bot rests to a full bar.
    Cold.npcForSpot = () => ({ ...target, pAtk: 400, level: 25, selfId: 156, accur: 100, evasion: 0, critical: 0 });
    const reckless = { ...hurt, persona: { traits: { caution: 0 } }, vitals: { ...hurt.vitals, hp: 551, mp: 932 } };
    const topped = Resolver.resolveSolo({ state: reckless, spot: easy, elapsedMs: 0, timestamp: at, rng: () => 0.5 });
    assert.strictEqual(topped.patch.stats.lastReason, 'solo_recovery_needed');
    assert.strictEqual(topped.patch.stats.restUntil - at, Resolver.estimateRestMs(reckless, reckless.vitals, { requireMana: true }),
        'a bot refused at its rested line rests to a full bar, not to the line again');
    Cold.npcForSpot = () => ({ ...target, level: 25, selfId: 156, accur: 100, evasion: 0, critical: 0 });
    const inCombat = { ...hurt, stats: { ...hurt.stats, pveEncounter: Encounter.save(null,
        Encounter.key([hurt], easy), Cold.npcForSpot(), 1, at, { botReadyAt: 0, mobReadyAt: 10000 }) } };
    const continued = Resolver.resolveSolo({ state: inCombat, spot: easy, elapsedMs: 0, timestamp: at, rng: () => 0.5 });
    assert(continued.debug.attemptedFights > 0, 'a pending fight cannot disappear into pre-fight recovery');
    // The rest after a fight, from a step time with a saved fraction: still whole.
    const postFight = Resolver.resolveSolo({ state: { ...inCombat, vitals: { ...inCombat.vitals, hp: 20, mp: 0 } },
        spot: easy, elapsedMs: 0, timestamp: at + 0.5, rng: () => 0.5 });
    assert(postFight.events.some(event => event.summary.includes('sat down to recover')), 'the fight left it hurt');
    assert(Number.isSafeInteger(postFight.patch.stats.restUntil), `a post-fight rest deadline is whole milliseconds (${postFight.patch.stats.restUntil})`);
    Cold.npcForSpot = () => ({ ...target, level: 25, selfId: 156, aggressiveInterruption: true,
        accur: 100, evasion: 0, critical: 0 });
    const defense = Resolver.resolveSolo({ state: hurt, spot: easy, elapsedMs: 0, timestamp: at, rng: () => 0.5 });
    assert(defense.debug.attemptedFights > 0, 'pre-fight recovery cannot grant immunity to an aggressive interruption');
} finally { Cold.profileFor = originalProfile; Cold.fightProfile = originalFight; Cold.npcForSpot = originalNpc; }

async function run() {
    // The rule behind every clock: a bot's life through the real resolver and
    // projection leaves a state each command checkpoint accepts: a writer on this
    // path that adds a fraction fails here. Pet and potion fractions have their
    // own tests at the deadlines (test_rest_potion, test_bot_cold_combat).
    Cold.profileFor = Cold.fightProfile = () => ({ ...mage, accur: 100, evasion: 0, critical: 0, effects: [] });
    Cold.npcForSpot = () => ({ ...target, level: 25, selfId: 156, accur: 100, evasion: 0, critical: 0 });
    try {
        let life = { ...state, spotId: easy.id, simulation: { revision: 1 }, updatedAt: at, vitals: { ...state.vitals, hp: 60, mp: 0 },
            timing: { activityStartedAt: at - 30000, lastResolvedAt: at - 30000, nextResolveAt: at } };
        const activities = new Set();
        let timestamp = at;
        for (let step = 0; step < 30; step++) {
            const result = Resolver.resolveSolo({ state: life, spot: easy, elapsedMs: 30000, timestamp, rng: () => 0.5 });
            life = { ...await Life.prepareResolve(life, result, { timestamp, writtenAt: timestamp, persist: false, projectClassProgression: true }),
                simulation: { revision: 1 } };
            activities.add(life.activity);
            assert(Protocol.commandCheckpoint(life), `step ${step} (${life.activity}) leaves clocks a checkpoint refuses: ${JSON.stringify(life.timing)}`);
            timestamp = life.timing.nextResolveAt;
        }
        assert(activities.has('resting') && activities.has('hunting'), `the chain lives both (${[...activities]})`);
    } finally { Cold.profileFor = originalProfile; Cold.fightProfile = originalFight; Cold.npcForSpot = originalNpc; }

    // A bot whose kit no longer admits its spot's mobs (this mage on the
    // Spartoi ground, as after a gear loss): its round tries no fight and raises
    // its ground once (occupation, sources, heard far at work), so the decision
    // it asks searches its spot afresh, and that search leaves for ground the
    // bot can hunt. A later empty round of the same stay raises nothing more.
    // The bot comes from a save the old rounds wrote (their refusal reason on
    // the same spot): it still raises.
    Cold.profileFor = Cold.fightProfile = () => ({ ...mage, accur: 100, evasion: 0, critical: 0, effects: [] });
    const savedCache = Spots.cache;
    try {
        const Sections = invoke('GameServer/Bot/Economy/DecisionSections');
        const ground = Sections.sectionBit('occupation') | Sections.sectionBit('sources');
        const stranded = { ...state, spotId: hard.id, simulation: { revision: 1 }, updatedAt: at,
            stats: { ...state.stats, lastReason: 'no_safe_solo_target' },
            timing: { activityStartedAt: at - 60000, lastResolvedAt: at - 60000, nextResolveAt: at } };
        const empty = Resolver.resolveSolo({ state: stranded, spot: hard, elapsedMs: 60000, timestamp: at, rng: () => 0.5 });
        assert.strictEqual(empty.patch.activity, 'hunting');
        assert.strictEqual(empty.debug.attemptedFights, 0, 'no spawn of the spot admits a fight alone');
        assert.strictEqual(empty.patch.stats.lastReason, 'no_safe_solo_target');
        const raised = await Life.prepareResolve(stranded, empty, { timestamp: at, persist: false, projectClassProgression: true });
        assert.strictEqual(Number(raised.stats.wishDirty) & ground, ground, 'the empty spot raises its ground');
        Spots.cache = [hard, easy];
        assert.strictEqual(Spots.findForState(raised, { matchupProfiles: [mage], occupancy: {}, timestamp: at })?.id, easy.id,
            'the search the raise asks leaves for ground the bot can hunt');
        const next = { ...raised, stats: { ...raised.stats, wishDirty: 0 } };
        const again = Resolver.resolveSolo({ state: next, spot: hard, elapsedMs: 60000, timestamp: at + 60000, rng: () => 0.5 });
        const kept = await Life.prepareResolve(next, again, { timestamp: at + 60000, persist: false, projectClassProgression: true });
        assert.strictEqual(Number(kept.stats.wishDirty) || 0, 0, 'a later empty round of the stay raises nothing');
    } finally { Cold.profileFor = originalProfile; Cold.fightProfile = originalFight; Spots.cache = savedCache; }

    // The same rule near a player: after the scans of the whole spot found no
    // fight, the body raises its ground once per empty streak; a spot only
    // killed out for now (its spawns admit the bot) raises nothing.
    const SpotService = invoke('GameServer/Bot/AI/SpotService'), Decision = invoke('GameServer/Bot/AI/BotDecisionService');
    const Tactics = invoke('GameServer/Bot/AI/SummonerTactics'), Rest = invoke('GameServer/Bot/AI/RestPolicy');
    const savedCurrent = SpotService.findCurrentSpot, savedActor = Match.actorProfiles, savedReady = Match.actorReadyProfiles;
    try {
        const Sections = invoke('GameServer/Bot/Economy/DecisionSections');
        const ground = Sections.sectionBit('occupation') | Sections.sectionBit('sources');
        Match.actorProfiles = Match.actorReadyProfiles = () => [{ ...mage, accur: 100, evasion: 0, critical: 0, effects: [] }];
        const body = (field, id, mp = 900) => ({ actor: { fetchId: () => id, fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0,
            fetchKarma: () => 0, fetchMp: () => mp },
            coldLifeState: { ...state, characterId: id, spotId: field.id, stats: { ...state.stats } }, noTargetTicks: 3,
            heldEconomy: { decided: true, network: { activity: { activity: 'hunting', spotId: field.id } } } });
        const look = { available: true, mode: 'hunting', blockers: [], loc: { locX: 0, locY: 0, locZ: 0 } };
        SpotService.findCurrentSpot = () => hard;
        const near = body(hard, 990008), dirty = () => Number(near.coldLifeState.stats.wishDirty) || 0;
        assert.strictEqual(Decision.suggest(look, near).reason, 'ground_unhuntable', 'a hot body on ground it cannot hunt raises it');
        assert.strictEqual(dirty() & ground, ground);
        const seq = near.coldLifeState.stats.decisionSeq;
        assert.strictEqual(Decision.suggest(look, near).reason, 'selected_hunting_ground', 'once per empty streak');
        assert.strictEqual(near.coldLifeState.stats.decisionSeq, seq);
        near.noTargetTicks = 0;
        Decision.suggest(look, near);
        near.noTargetTicks = 3;
        assert.strictEqual(Decision.suggest(look, near).reason, 'ground_unhuntable', 'a new empty streak looks again');
        SpotService.findCurrentSpot = () => easy;
        const killedOut = body(easy, 990009);
        assert.strictEqual(Decision.suggest(look, killedOut).reason, 'selected_hunting_ground', 'a spot only killed out for now');
        assert.strictEqual(Number(killedOut.coldLifeState.stats.wishDirty) || 0, 0);
        // A summoner short only of its pet (the route's view, stubbed here, admits
        // the ground with the pet up): it raises the pet out of the fight when it
        // can, sits when the summon's MP is missing, waits on its feet while the
        // summon is on its reuse; none of these raises its ground.
        const readyView = [{ ...mage }], shares = Match.spotShares;
        const tactics = { petRestView: Tactics.petRestView, summonSkills: Tactics.summonSkills, summonSkill: Tactics.summonSkill };
        const waitsForMana = Rest.restWaitsForMana;
        Match.actorReadyProfiles = () => readyView;
        Match.spotShares = (profiles, field, options) => profiles === readyView ? new Map([[{ selfId: 0 }, 1]]) : shares(profiles, field, options);
        Tactics.petRestView = () => null;
        Tactics.summonSkills = () => [{ fetchConsumedMp: () => 70 }];
        Rest.restWaitsForMana = () => true;
        try {
            SpotService.findCurrentSpot = () => hard;
            // One look, after a streak of empty scans; the ground raised or not.
            const decide = (summoner, castable) => {
                Tactics.summonSkill = () => castable ? { fetchSelfId: () => 1276 } : null;
                summoner.noTargetTicks = 3;
                const decision = Decision.suggest(look, summoner);
                return [decision.action, decision.reason, summoner.noTargetTicks, Number(summoner.coldLifeState.stats.wishDirty) || 0];
            };
            const pet = body(hard, 990010, 900), drained = body(hard, 990011, 10), cooling = body(hard, 990012, 900);
            assert.deepStrictEqual(decide(pet, true), ['summon', 'ground_needs_pet', 0, 0], 'it raises its pet out of the fight');
            assert.deepStrictEqual(decide(drained, false), ['rest', 'ground_needs_rest', 0, 0], 'short of the summon\'s MP it sits');
            assert.deepStrictEqual(decide(cooling, false), ['search_locally', 'selected_hunting_ground', 0, 0],
                'on the summon\'s reuse it waits a streak');
            // Neither waits forever: a second wait, or a summon that brought no pet, raises.
            assert.strictEqual(decide(cooling, false)[1], 'ground_unhuntable', 'a second wait on the stay raises its ground');
            const failed = decide(pet, true);
            assert.strictEqual(failed[1], 'ground_unhuntable', 'a summon that brought no pet raises its ground');
            assert.strictEqual(failed[3] & ground, ground);
        } finally {
            Object.assign(Tactics, tactics);
            Rest.restWaitsForMana = waitsForMana;
            Match.spotShares = shares;
        }
    } finally { SpotService.findCurrentSpot = savedCurrent; Match.actorProfiles = savedActor; Match.actorReadyProfiles = savedReady; }

    let stalled = { ...state, stats: { ...state.stats, spotRisk: recoveredRisk } };
    for (let i = 0; i < 3; i++) {
        stalled = await Life.prepareResolve(stalled, {
            patch: { activity: 'resting', vitals: state.vitals },
            events: [], materialize: { exp: 0, sp: 0, adena: 0, items: [] },
            nextResolveAt: at + 1000, debug: { fights: 1, wins: 0, combatMs: 30000 }
        }, { timestamp: at + i, persist: false, projectClassProgression: true });
    }
    assert.strictEqual(stalled.stats.spotRisk.failedHunts, 3);
    assert.strictEqual(Risk.stepCount(stalled), Risk.stepCount(state) + 3, 'each resolved step moves the bot\'s counter by exactly one');
    assert(stalled.stats.spotBackoffs.some(entry => entry.spotId === 'danger' && entry.reason === 'failed_hunts'),
        'abandoned real fights must exclude the failing ground through the existing routing policy');
    assert.strictEqual(stalled.stats.deaths, 0, 'an abandoned fight is not a death');
    const prepared = await Life.prepareResolve({ ...state, stats: { ...state.stats, spotRisk: boundary } }, {
        patch: { activity: 'dead', deathCount: 1, vitals: { ...state.vitals, hp: 0 } },
        events: [], materialize: { exp: 10, sp: 0, adena: 0, items: [] },
        nextResolveAt: at + 1000, debug: { fights: 1, wins: 0, died: true, combatMs: 10000 }
    }, { timestamp: at, persist: false, projectClassProgression: true });
    const next = prepared;
    assert(next.exp < state.exp, 'the regression must incur the real C4 death penalty');
    assert.strictEqual(next.stats.huntEfficiency[0].exp, next.exp - state.exp,
        'the persisted efficiency sample includes actual XP loss, not just the ten XP reward');
    assert(next.stats.spotBackoffs.some(entry => entry.spotId === 'danger' && Risk.markActive(entry, next)),
        'the failed spot is remembered before revival changes physical routing origin');
    assert(next.stats.huntingRecovery.levelPenalty > 0);
    let losing = { ...state, stats: { ...state.stats } };
    for (let i = 0; i < 3; i++) losing.stats.huntEfficiency = Efficiency.record(losing,
        { spotId: 'danger', exp: -100, cycleMs: 10000, timestamp: at });
    assert(Efficiency.scores(losing, at).get('danger') < 0, 'an exclusively losing history still lowers its route score');
    for (const legacySignature of [signature => signature.replace('net-income-v3:', 'net-xp-v1:'),
        signature => `legacy-gross:${signature}`]) {
        const legacy = { ...losing, stats: { ...losing.stats, huntEfficiency: losing.stats.huntEfficiency
            .map(row => ({ ...row, signature: legacySignature(row.signature), exp: 10000 })) } };
        assert.strictEqual(Efficiency.scores(legacy, at).size, 0, 'legacy gross-reward samples cannot bias net-XP routing');
    }
    console.log('Solo survival, safer routing, cross-window deaths, persistent recovery and net death XP passed');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
