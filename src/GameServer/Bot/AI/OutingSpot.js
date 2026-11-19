'use strict';

// Which spot a group hunts this outing (a solo bot is a group of one). Taken
// only at an outing's start (the caller names the situations) and held until
// the next one: a group keeps its spot while it fits and re-picks among the
// spots that fit only when it stops fitting; a min-maxer re-picks the best
// fitting spot at every outing's start. It neither searches the spots nor
// values them: the caller hands it the candidates it values, and a candidate's
// value carries no road (where the group stands does not rank the spots).
// Pure on plain data. Callers: the economy model's plane (the game's earning
// choice is to call it too).
//
// A spot fits a group when, for every member:
// - level gap: the member is at most 7 levels above the spot's mobs. C4 gives
//   the full exp up to 5 levels and (5/6)^(gap-5) past it (MobExperience.gapFactor;
//   L2JLisvus L2Attackable.java:1743-1749), so at 7 the mobs still give 69 % of
//   their exp. Ours: a player stays at a spot while its mobs give about 70 % of
//   their exp. Our reading for a spot of several species: the spot's mean mob
//   level (avgLevel), not each species. Mobs too strong are the safety's side.
// - safety: the member's expected deaths over the outing are at most the bound
//   (inclusive): its deaths an hour at the spot, in the form it hunts, at the
//   worst of the levels the outing reaches (from its level at the start to the
//   level its exp reaches by the outing's end: an outing spans level-ups and a
//   spot deathless at one level may kill a level up), times the outing's hours.
//   The deaths by level and the level reached are facts of the hunt, the
//   caller's. The bound is ours and the caller's limit row.
const MobExperience = require('../../Progression/MobExperience');

// Ours: the most levels a member is above a spot's mobs while they still give about 70 % of their exp.
const MAX_FIT_GAP = 7;

// members: [{ level }]; candidate: { spotId, value, avgLevel, members: [{ deathsByLevel, reachLevel, outingHours }] }
// (members' order): deathsByLevel[level], the deaths an hour there (none read as 0); reachLevel, the last level the outing reaches.
function outingDeaths({ deathsByLevel, reachLevel, outingHours }, level) {
    let worst = 0;
    for (let at = level; at <= reachLevel; at++) worst = Math.max(worst, deathsByLevel[at] || 0);
    return worst > 0 ? worst * outingHours : 0;
}

function checkedBound(bound) {
    if (!Number.isFinite(bound) || bound < 0) throw new Error(`no safe outing deaths bound (got ${bound})`);
    return bound;
}

// Why the candidate does not fit the group: 'no_row' (none), 'level_gap', 'unsafe'; null when it fits.
function unfit(candidate, members, bound) {
    checkedBound(bound);
    if (!candidate) return 'no_row';
    if (members.some(member => MobExperience.gapFactor(member.level - candidate.avgLevel) < MobExperience.gapFactor(MAX_FIT_GAP))) return 'level_gap';
    if (candidate.members.some((member, at) => outingDeaths(member, members[at].level) > bound)) return 'unsafe';
    return null;
}

// A min-maxer persona: progression its drive and ambition at the top (our cut: about one main in eight).
const MIN_MAX_AMBITION = 0.85;
const minMaxer = persona => !!persona && persona.primaryDrive === 'progression' && Number(persona.traits?.ambition) >= MIN_MAX_AMBITION;

// { held: spotId | null, candidates, members, minMax, bound } -> { spotId, reason, refusedUnsafe }.
// reason: 'kept' | 'first' | 'unfit:<why>' | 'minmax' | 'fallback:outleveled' | 'fallback:least_risk' | 'none';
// refusedUnsafe: the unsafe candidates worth more than the choice (the scan goes in value order, richest first, and stops at
// the first that fits, so a candidate poorer than the choice is never read; with no fit, every unsafe one). No spot fits: a player hunts the safest he has, he never stops
// playing: the best safe one out of his gap, else the one with the least expected deaths (the worst member's), ties by
// value. None only without candidates.
function choose({ held = null, candidates, members, minMax = false, bound }) {
    const own = held === null ? null : candidates.find(candidate => String(candidate.spotId) === String(held)) || null;
    const heldWhy = held === null ? null : unfit(own, members, bound);
    if (held !== null && heldWhy === null && !minMax) return { spotId: String(held), reason: 'kept', refusedUnsafe: 0 };
    let best = null, refusedUnsafe = 0;
    for (const candidate of [...candidates].sort((a, b) => b.value - a.value)) {
        const why = unfit(candidate, members, bound);
        if (why === 'unsafe') refusedUnsafe++;
        if (why === null) { best = candidate; break; }
    }
    if (!best) {
        if (!candidates.length) return { spotId: null, reason: 'none', refusedUnsafe };
        const deaths = candidate => Math.max(...candidate.members.map((member, at) => outingDeaths(member, members[at].level)));
        for (const candidate of candidates) if (deaths(candidate) <= bound && (!best || candidate.value > best.value)) best = candidate;
        if (best) return { spotId: String(best.spotId), reason: 'fallback:outleveled', refusedUnsafe };
        for (const candidate of candidates) {
            if (!best || deaths(candidate) < deaths(best) || (deaths(candidate) === deaths(best) && candidate.value > best.value)) best = candidate;
        }
        return { spotId: String(best.spotId), reason: 'fallback:least_risk', refusedUnsafe };
    }
    const reason = held === null ? 'first' : heldWhy !== null ? `unfit:${heldWhy}` : 'minmax';
    return { spotId: String(best.spotId), reason, refusedUnsafe };
}

module.exports = { unfit, choose, minMaxer, MIN_MAX_AMBITION };
