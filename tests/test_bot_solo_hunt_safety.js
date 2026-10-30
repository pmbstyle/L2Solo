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
const fragile = { ...mage, maxHp: 20 };
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
    const owned = { ...necro, accur: 100, evasion: 0, critical: 0, mCritRate: 0,
        equipment: { ...necro.equipment, pAtkRnd: 0 }, effects: [], skills: [...necro.skills,
            { selfId: 1220, level: 1, passive: false, spell: true, power: 44, mp: 22, hitTime: 4000, reuse: 6000 },
            { selfId: 1015, level: 3, passive: false, spell: true, power: 107, mp: 32, hitTime: 2000, reuse: 3000 }
        ] };
    Cold.profileFor = Cold.fightProfile = () => owned;
    const ground = { id: 'solo-heal-loop', name: 'Solo heal loop', avgLevel: 36, density: 6,
        npcEntries: [{ selfId: 1639, count: 6 }], npcSelfIds: [1639] };
    Spots.cache = [ground];
    const fighter = { characterId: 990005, level: 45, activity: 'hunting', spotId: ground.id, inventory: {},
        vitals: { hp: necro.maxHp, maxHp: necro.maxHp, mp: necro.maxMp, maxMp: necro.maxMp },
        stats: { classId: 13, role: 'mage' } };
    const fight = invoke('GameServer/Bot/Population/BackgroundResolver').resolveSolo({
        state: fighter, spot: ground, elapsedMs: 60000, timestamp: at, rng: () => 0.5 });
    // T107: between fights the bot may heal where that beats sitting (gapHeals); in the fight it must not.
    assert.equal(fight.debug.heals - fight.debug.gapHeals, 0, 'a heal weaker than damage during its cast cannot replace the finishing attack');
    // T100: the priced pick (Aura Burn) kills fast enough for more lizards
    // within the minute; the remaining HP still admits them. T106: the walk
    // between the six (10 s each) holds the minute to four kills, and the
    // last walk engages a fifth.
    assert.equal(fight.debug.wins, 4, 'the native rotation finishes the lizards');
    assert.equal(fight.debug.died, false);
    assert.equal(fight.debug.attemptedFights, 5, 'remaining HP must be checked before the next voluntary mob');
    assert.equal(fight.patch.activity, 'hunting', 'quick kills leave enough HP to keep hunting');
} finally { Cold.profileFor = savedProfile; Cold.fightProfile = savedFight; Spots.cache = savedSpots; }

// A wealthy reward forecast or a future gear target cannot admit a lethal
// ordinary hunt. Clan membership changes neither the equipped combat profile
// nor the ability to earn on safe mobs below the character's level.
try {
    Cold.profileFor = Cold.fightProfile = () => mage;
    const safe = { id: 'safe-lower-farm', name: 'Mandragora field', minLevel: 25, maxLevel: 25,
        avgLevel: 25, density: 6, npcEntries: [{ selfId: 156, count: 6 }] };
    const unsafe = { id: 'unsafe-level-farm', name: 'Patin field', minLevel: 29, maxLevel: 29,
        avgLevel: 29, density: 6, npcEntries: [{ selfId: 608, count: 6 }] };
    Spots.cache = [safe, unsafe];
    const Route = invoke('GameServer/Bot/Economy/EquipmentIncomeRoute');
    for (const clanLevel of [0, 1]) for (const grade of ['d', 'c', 'b', 'a', 's']) {
        let hunter = { characterId: 990006, level: 29, activity: 'hunting', spotId: unsafe.id,
            clanId: clanLevel ? 7 : 0, clanLevel, inventory: {},
            vitals: { hp: mage.maxHp, mp: mage.maxMp }, stats: { classId: 12, role: 'mage',
                wishFocus: ['power:200:14', 1, 1000000], equipmentPlan: { status: 'active',
                    strategy: 'direct_drop', grade, next: { spotId: unsafe.id, npcId: 608 } } } };
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
const safeBow = { ...bow, maxHp: bow.maxHp * 1.6 / bowRatio };
assert(!Match.evaluate([safeBow], resistedTarget).eligible, 'fixture: the ordinary resistance gate rejects efficiency 0.1');
assert(Match.soloCanHunt([safeBow], resistedTarget).eligible, 'solo hunting accepts a resisted mob it safely survives');
assert(!Match.soloCanHunt([{ ...safeBow, maxHp: safeBow.maxHp * 1.2 / 1.6 }], resistedTarget).eligible);
assert(!Match.soloCanHunt([safeBow], resistedTarget, { maxTargetLevel: 27, npcLevel: 29 }).eligible);
assert.equal(Match.soloCanHunt([safeBow], resistedTarget, { maxTargetLevel: 27, npcLevel: 29 }).reason, 'recovery_level');
assert(!Match.soloCanHunt([{ ...safeBow, maxHp: undefined }], resistedTarget).eligible,
    'an unknown kit still uses the ordinary resistance gate');

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
const hard = spot('danger', 608, 29, 1000);
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
assert(!Readiness.evaluate({ hp: 500, maxHp: 1000, mp: 1000, maxMp: 1000, level: 40,
    manaDependent: true }, { level: 35, maxHp: 1000 }).ready);
assert(Readiness.evaluate({ hp: 500, maxHp: 1000, mp: 0, maxMp: 1000, level: 40,
    manaDependent: false }, { level: 35, hp: 10, maxHp: 1000 }).ready,
    'a physical finisher does not need mana or a full-target HP reserve');
const originalProfile = Cold.profileFor, originalFight = Cold.fightProfile;
const originalNpc = Cold.npcForSpot;
try {
    Cold.profileFor = Cold.fightProfile = () => ({ ...mage, accur: 100, evasion: 0, critical: 0, effects: [] });
    Cold.npcForSpot = () => ({ ...target, level: 25, selfId: 156, accur: 100, evasion: 0, critical: 0 });
    const hurt = { ...state, spotId: easy.id, vitals: { ...state.vitals, hp: 260, mp: 300 } };
    const recover = Resolver.resolveSolo({ state: hurt, spot: easy, elapsedMs: 0, timestamp: at, rng: () => 0.5 });
    assert.strictEqual(recover.patch.activity, 'resting', 'cold solo hunters recover before starting another fight');
    assert.strictEqual(recover.patch.stats.lastReason, 'solo_recovery_needed');
    assert.strictEqual(recover.debug.attemptedFights, 0);
    assert.strictEqual(recover.materialize.exp, 0);
    assert(recover.nextResolveAt > at && recover.events.some(event => event.type === 'rest'));
    const inCombat = { ...hurt, stats: { ...hurt.stats, pveEncounter: Encounter.save(null,
        Encounter.key([hurt], easy, 0), Cold.npcForSpot(), 1, at, { botReadyAt: 0, mobReadyAt: 10000 }) } };
    const continued = Resolver.resolveSolo({ state: inCombat, spot: easy, elapsedMs: 0, timestamp: at, rng: () => 0.5 });
    assert(continued.debug.attemptedFights > 0, 'a pending fight cannot disappear into pre-fight recovery');
    Cold.npcForSpot = () => ({ ...target, level: 25, selfId: 156, aggressiveInterruption: true,
        accur: 100, evasion: 0, critical: 0 });
    const defense = Resolver.resolveSolo({ state: hurt, spot: easy, elapsedMs: 0, timestamp: at, rng: () => 0.5 });
    assert(defense.debug.attemptedFights > 0, 'pre-fight recovery cannot grant immunity to an aggressive interruption');
} finally { Cold.profileFor = originalProfile; Cold.fightProfile = originalFight; Cold.npcForSpot = originalNpc; }

async function run() {
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
