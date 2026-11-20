'use strict';
// Which spot a group hunts this outing: it keeps its spot while the spot fits
// (no member more than 5 levels above the spot's mobs, C4's full exp, and every
// member's expected deaths over the outing at most the bound, inclusive, at the
// worst of the levels the outing reaches) even
// when another spot is worth more; past the gap or over the bound it takes the
// best spot that fits; no spot fits gives the best safe one out of the gap,
// else the least deadly one (a player never stops playing), none only without
// candidates; a min-maxer takes the best fitting spot at every outing's start.
const assert = require('node:assert/strict');
const OutingSpot = require('../src/GameServer/Bot/AI/OutingSpot');

const BOUND = 0.1;
// Deaths an hour the same at every level, an outing of one hour reaching any level.
const spot = (spotId, value, avgLevel, ...deaths) => ({ spotId, value, avgLevel,
    members: deaths.map(each => ({ deathsByLevel: Array(100).fill(each), reachLevel: 99, outingHours: 1 })) });
const solo = level => [{ level }];

// Kept while it fits, though another is worth more.
const own = spot('a', 1, 20, 0), richer = spot('b', 2, 22, 0);
assert.deepEqual(OutingSpot.choose({ held: 'a', candidates: [own, richer], members: solo(24), bound: BOUND }),
    { spotId: 'a', reason: 'kept', refusedUnsafe: 0 });
// The level gap: 7 levels above the spot's mobs fits (69 % of their exp), 8 does not (MobExperience.gapFactor).
assert.equal(OutingSpot.unfit(spot('a', 1, 20, 0), solo(27), BOUND), null);
assert.equal(OutingSpot.unfit(spot('a', 1, 20, 0), solo(28), BOUND), 'level_gap');
assert.equal(OutingSpot.unfit(spot('a', 1, 30, 0), solo(10), BOUND), null, 'stronger mobs are the safety\'s side, not the gap\'s');
assert.deepEqual(OutingSpot.choose({ held: 'a', candidates: [own, richer], members: solo(28), bound: BOUND }),
    { spotId: 'b', reason: 'unfit:level_gap', refusedUnsafe: 0 });
// Safety: expected deaths over the outing 0.12 refused, 0.08 and 0.1 taken (the bound is inclusive).
assert.equal(OutingSpot.unfit(spot('s', 1, 20, 0.12), solo(20), BOUND), 'unsafe');
assert.equal(OutingSpot.unfit(spot('s', 1, 20, 0.08), solo(20), BOUND), null);
assert.equal(OutingSpot.unfit(spot('s', 1, 20, 0.1), solo(20), BOUND), null);
assert.equal(OutingSpot.unfit({ spotId: 's', value: 1, avgLevel: 20, members: [{ deathsByLevel: { 20: 0.04 }, reachLevel: 20, outingHours: 3 }] }, solo(20), BOUND), 'unsafe',
    'deaths an hour times the outing\'s hours');
// The levels the outing reaches: deathless at its start level but deadly a level up is unsafe when the outing reaches that
// level, and fits when the outing ends before it.
const deadlyUp = reachLevel => ({ spotId: 's', value: 1, avgLevel: 20, members: [{ deathsByLevel: { 20: 0, 21: 0.5 }, reachLevel, outingHours: 1 }] });
assert.equal(OutingSpot.unfit(deadlyUp(21), solo(20), BOUND), 'unsafe', 'deadly at a level the outing reaches');
assert.equal(OutingSpot.unfit(deadlyUp(20), solo(20), BOUND), null, 'deadly only past the levels the outing reaches');
assert.deepEqual(OutingSpot.choose({ held: null, candidates: [spot('x', 3, 20, 0.12), spot('y', 1, 20, 0.08)], members: solo(20), bound: BOUND }),
    { spotId: 'y', reason: 'first', refusedUnsafe: 1 });
// No safe candidate: the least deadly one, though another is worth more.
assert.deepEqual(OutingSpot.choose({ held: null, candidates: [spot('x', 3, 20, 0.5), spot('y', 1, 20, 0.2)], members: solo(20), bound: BOUND }),
    { spotId: 'y', reason: 'fallback:least_risk', refusedUnsafe: 2 });
// None in the gap: the best safe outleveled one, before an unsafe one in the gap.
assert.deepEqual(OutingSpot.choose({ held: 'a', candidates: [spot('a', 1, 20, 0), spot('o', 2, 19, 0), spot('u', 5, 26, 0.5)], members: solo(28), bound: BOUND }),
    { spotId: 'o', reason: 'fallback:outleveled', refusedUnsafe: 1 });
// The scan stops at the best fitting: a richer unsafe one is refused, a poorer candidate's facts are never read.
const poorer = { spotId: 'z', value: 0.5, avgLevel: 20, get members() { throw new Error('read the members of a candidate poorer than the choice'); } };
assert.deepEqual(OutingSpot.choose({ held: null, candidates: [poorer, spot('y', 1, 20, 0.08), spot('x', 3, 20, 0.12)], members: solo(20), bound: BOUND }),
    { spotId: 'y', reason: 'first', refusedUnsafe: 1 });
// No candidates: none.
assert.deepEqual(OutingSpot.choose({ held: 'a', candidates: [], members: solo(20), bound: BOUND }),
    { spotId: null, reason: 'none', refusedUnsafe: 0 });
// A held spot that has no candidate (no row at this level or form) is left.
assert.equal(OutingSpot.choose({ held: 'gone', candidates: [own], members: solo(20), bound: BOUND }).reason, 'unfit:no_row');
// A min-maxer takes the best safe spot at every outing's start.
assert.deepEqual(OutingSpot.choose({ held: 'a', candidates: [own, richer, spot('c', 5, 22, 0.3)], members: solo(24), minMax: true, bound: BOUND }),
    { spotId: 'b', reason: 'minmax', refusedUnsafe: 1 });
// A group of two: the spot does not fit when one member is unsafe there or out of its gap.
const pair = [{ level: 20 }, { level: 24 }];
assert.equal(OutingSpot.unfit(spot('p', 1, 20, 0, 0), pair, BOUND), null);
assert.equal(OutingSpot.unfit(spot('p', 1, 20, 0, 0.2), pair, BOUND), 'unsafe');
assert.equal(OutingSpot.unfit(spot('p', 1, 17, 0, 0), pair, BOUND), null);
assert.equal(OutingSpot.unfit(spot('p', 1, 16, 0, 0), pair, BOUND), 'level_gap');
// The min-maxer persona: progression and high ambition.
assert.equal(OutingSpot.minMaxer({ primaryDrive: 'progression', traits: { ambition: 0.85 } }), true);
assert.equal(OutingSpot.minMaxer({ primaryDrive: 'progression', traits: { ambition: 0.84 } }), false);
assert.equal(OutingSpot.minMaxer({ primaryDrive: 'wealth', traits: { ambition: 0.9 } }), false);
assert.equal(OutingSpot.minMaxer(null), false);
// The bound is the caller's: none given is refused.
assert.throws(() => OutingSpot.unfit(own, solo(20)), /no safe outing deaths bound/);

console.log('test_outing_spot: ok');
