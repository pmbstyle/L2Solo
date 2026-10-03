const assert = require('assert');
require('../src/Global');
const Data = invoke('GameServer/DataCache');
const Match = invoke('GameServer/Bot/AI/BotTargetMatchup');
const Routes = invoke('GameServer/Bot/AI/LevelingRoutes');
const SpotService = invoke('GameServer/Bot/AI/SpotService');
const Spots = invoke('GameServer/Bot/Population/SpotProfiles');
const Risk = invoke('GameServer/Bot/Population/SpotRiskPolicy');
Data.init();

// Pins the numeric edges of the routing rules: CLASS_POLICY.md states them,
// test_bot_solo_hunt_safety.js covers the behaviour around them.
const at = 1800000000000;
const mage = { classId: 12, level: 29, role: 'mage', maxHp: 592, maxMp: 932,
    pDef: 243, pAtk: 96, mAtk: 162, castSpd: 194, atkSpd: 263, weaponMask: 8,
    equipment: { weaponKind: 'Weapon.Blunt' },
    skills: [{ selfId: 1230, level: 1, spell: true, passive: false, power: 51, mp: 35, hitTime: 4000 }] };
const target = { maxHp: 500, pAtk: 60, atkSpd: 253, pDef: 100, mDef: 70,
    basePDef: 100, baseMDef: 70, vulnerabilities: {} };

// Solo survival needs 1.5x the target's HP in deliverable damage.
const damage = Match.soloSurvival([mage], target).survivalRatio * target.maxHp;
assert(Math.abs(Match.soloSurvival([mage], { ...target, maxHp: 1000 }).survivalRatio * 1000 - damage) < 1e-6,
    'deliverable damage must not depend on the target HP, or the margin below is not a margin');
assert(Match.soloSurvival([mage], { ...target, maxHp: Math.floor(damage / 1.5) }).eligible,
    'damage of 1.5x the target HP is enough');
assert(!Match.soloSurvival([mage], { ...target, maxHp: Math.ceil(damage / 1.5) + 1 }).eligible,
    'damage under 1.5x the target HP is not enough');

// A mixed spot needs at least 60% of its spawn weight solo-safe.
const SAFE_NPC = 156;
const UNSAFE_NPC = 608;
const mixed = (safe, unsafe) => ({ npcEntries: [{ selfId: SAFE_NPC, count: safe }, { selfId: UNSAFE_NPC, count: unsafe }]
    .filter((entry) => entry.count > 0) });
assert.strictEqual(Match.spotMatchup(mixed(1, 0), [mage], { soloSafety: true }).eligible, true);
assert.strictEqual(Match.spotMatchup(mixed(0, 1), [mage], { soloSafety: true }).eligible, false);
assert.strictEqual(Match.spotMatchup(mixed(3, 2), [mage], { soloSafety: true }).eligible, true,
    '60% safe spawn weight is enough');
assert.strictEqual(Match.spotMatchup(mixed(59, 41), [mage], { soloSafety: true }).eligible, false,
    'under 60% safe spawn weight is not enough');
assert.strictEqual(Match.spotMatchup(mixed(2, 3), [mage], {}).eligible, true,
    'the 60% rule applies to solo safety only');

// Suitable: at least 3 mobs and 25% of the spot's density within [level - 7, level + 3].
const levels = (levelCounts) => {
    const all = Object.keys(levelCounts).map(Number);
    const density = Object.values(levelCounts).reduce((sum, count) => sum + count, 0);
    return { minLevel: Math.min(...all), maxLevel: Math.max(...all), avgLevel: Math.min(...all), density, levelCounts };
};
assert.strictEqual(SpotService.isSuitable(levels({ 23: 3 }), 30), true, 'level - 7 is in the band');
assert.strictEqual(SpotService.isSuitable(levels({ 22: 3 }), 30), false, 'level - 8 is below the band');
assert.strictEqual(SpotService.isSuitable(levels({ 33: 3 }), 30), true, 'level + 3 is in the band');
assert.strictEqual(SpotService.isSuitable(levels({ 34: 3 }), 30), false, 'level + 4 is above the band');
assert.strictEqual(SpotService.isSuitable(levels({ 30: 2 }), 30), false, 'fewer than 3 mobs in the band');
assert.strictEqual(SpotService.isSuitable(levels({ 30: 3, 10: 9 }), 30), true, '25% of the density in the band');
assert.strictEqual(SpotService.isSuitable(levels({ 30: 3, 10: 10 }), 30), false, 'under 25% of the density in the band');

// The solo death penalty grows by 2 per death and stops at 6.
const exp = Number(Data.experience[28]) + 100000;
const state = { characterId: 990004, level: 29, exp, sp: 0, adena: 0,
    phase: 'cold', activity: 'hunting', spotId: 'danger', inventory: {}, loc: {}, timing: {},
    vitals: { hp: 592, maxHp: 592, mp: 932, maxMp: 932 },
    stats: { classId: 12, classProgressionClassId: 12, classProgressionLevel: 29, deaths: 0 } };
let dying = state;
const penalties = [];
for (let death = 0; death < 5; death++) {
    const recovery = Risk.recordRecovery(dying, { deaths: 1, exp, expBeforeDeath: exp });
    penalties.push(recovery.levelPenalty);
    dying = { ...dying, stats: { ...dying.stats, huntingRecovery: recovery } };
}
assert.deepStrictEqual(penalties, [2, 4, 6, 6, 6]);
assert.strictEqual(Routes.targetLevelForState(dying), 23);

// Spot pressure: 2 deaths at a 20% death rate; a backoff doubles from 1 h up to 6 h; at most 8 spots.
const pressure = (windowFights, windowDeaths) => Risk.deathPressure({ ...state, stats: { spotRisk: {
    spotId: 'danger', version: Risk.RISK_WINDOW_VERSION, windowFights, windowWins: windowFights - windowDeaths,
    windowDeaths, unrecoveredDeaths: 0, failedHunts: 0 } } });
assert.strictEqual(pressure(10, 2)?.reason, 'death_pressure', '2 deaths in 10 fights is a 20% death rate');
assert.strictEqual(pressure(11, 2), null, '2 deaths in 11 fights is under 20%');
assert.strictEqual(pressure(1, 1), null, 'one death is never pressure');

let backedOff = state;
let startedAt = at;
const hours = [];
for (let attempt = 0; attempt < 5; attempt++) {
    backedOff = Risk.withBackoff(backedOff, { spotId: 'danger', reason: 'death_pressure', startedAt }, startedAt);
    const entry = backedOff.stats.spotBackoffs.find((backoff) => backoff.spotId === 'danger');
    hours.push((entry.until - startedAt) / 3600000);
    startedAt = entry.until + 1;
}
assert.deepStrictEqual(hours, [1, 2, 4, 6, 6]);
let crowded = state;
for (let index = 0; index < 10; index++) {
    crowded = Risk.withBackoff(crowded, { spotId: `spot_${index}`, reason: 'death_pressure', startedAt: at }, at);
}
assert.strictEqual(crowded.stats.spotBackoffs.length, Risk.MAX_BACKOFFS);
assert.strictEqual(Risk.MAX_BACKOFFS, 8);

// Spot search: the regular window is +-4 levels; the solo fallback takes max mob level in [level - 16, level - 4).
const spot = (id, level) => ({ id, name: id, minLevel: level, maxLevel: level, avgLevel: level,
    density: 8, tags: [], tagsAuthoritative: true, center: { locX: 50000, locY: 150000, locZ: -3000 },
    npcEntries: [{ selfId: SAFE_NPC, count: 8 }], levelCounts: { [level]: 8 } });
const original = Spots.cache;
const search = (cache, searchState) => {
    Spots.cache = cache;
    return Spots.findForState(searchState, { matchupProfiles: [mage], occupancy: {}, timestamp: at })?.id || null;
};
try {
    const level35 = { ...state, level: 35, spotId: null };
    assert.strictEqual(search([spot('above', 40)], level35), null, 'level + 5 is outside the window');
    assert.strictEqual(search([spot('top', 39)], level35), 'top', 'level + 4 is inside the window');
    assert.strictEqual(search([spot('fallback_top', 30)], level35), 'fallback_top', 'level - 5 is easier ground');
    assert.strictEqual(search([spot('fallback_low', 19)], level35), 'fallback_low', 'level - 16 is easier ground');
    assert.strictEqual(search([spot('too_low', 18)], level35), null, 'level - 17 is below easier ground');
    assert.strictEqual(search([spot('fallback_top', 30)], { ...level35, party: { partyId: 'p1' } }), null,
        'party bots do not fall back to easier ground');
} finally { Spots.cache = original; }

console.log('test_bot_routing_thresholds passed');
