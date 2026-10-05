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
assert(Match.soloSurvival([fragile, servitor], target).eligible, 'a real summon contributes damage and tanking');

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
        matchupProfiles: [mage], occupancy: {}, timestamp: at })?.id, 'easy',
    'a safe lower-level fallback must not become an endless travel loop between comparable camps');
} finally { Spots.cache = original; }

const Resolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const Encounter = invoke('GameServer/Bot/Population/ColdPveEncounter');
const Readiness = invoke('GameServer/Bot/AI/BotEncounterReadiness');
assert(!Readiness.evaluate({ hp: 500, maxHp: 1000, mp: 1000, maxMp: 1000, level: 40,
    manaDependent: true }, { level: 35, maxHp: 1000 }).ready);
assert(Readiness.evaluate({ hp: 500, maxHp: 1000, mp: 0, maxMp: 1000, level: 40,
    manaDependent: false }, { level: 35, hp: 10, maxHp: 1000 }).ready,
    'a physical finisher does not need mana or a full-target HP reserve');
const originalProfile = Cold.profileFor;
const originalNpc = Cold.npcForSpot;
try {
    Cold.profileFor = () => ({ ...mage, accur: 100, evasion: 0, critical: 0, effects: [] });
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
} finally { Cold.profileFor = originalProfile; Cold.npcForSpot = originalNpc; }

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
    assert(next.stats.spotBackoffs.some(entry => entry.spotId === 'danger' && entry.until > at),
        'the failed spot is remembered before revival changes physical routing origin');
    assert(next.stats.huntingRecovery.levelPenalty > 0);
    let losing = { ...state, stats: { ...state.stats } };
    for (let i = 0; i < 3; i++) losing.stats.huntEfficiency = Efficiency.record(losing,
        { spotId: 'danger', exp: -100, cycleMs: 10000, timestamp: at });
    assert(Efficiency.scores(losing, at).get('danger') < 0, 'an exclusively losing history still lowers its route score');
    const legacy = { ...losing, stats: { ...losing.stats, huntEfficiency: losing.stats.huntEfficiency
        .map(row => ({ ...row, signature: row.signature.replace('net-xp-v1:', ''), exp: 10000 })) } };
    assert.strictEqual(Efficiency.scores(legacy, at).size, 0, 'legacy gross-reward samples cannot bias net-XP routing');
    console.log('Solo survival, safer routing, cross-window deaths, persistent recovery and net death XP passed');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
