'use strict';
// T120, option C: a hunting solo bot's step runs its rounds on until its next
// event; its next due is that event, not one 30-120 s round away. The rounds
// are today's (resolveSolo, then BotLifeState.prepareResolve), in the order and
// with the seeds its steps would run: a window changes when the bot decides and
// commits, never what its fights give.
//
// A step used to credit past time only (now - lastResolvedAt). A window credits
// ahead: its rounds run at their own dues at the window's start, so the row holds
// the bot's state up to one window past now. stats.huntedThrough keeps that end
// whatever writes lastResolvedAt later (a command, a party, a hot session): no
// hunt credit runs before it (stepElapsedMs), no time is hunted twice cold. Hot
// time inside it is lived on top: at most one window per interruption.
//
// The window's rule, the one owner of "is a hunting round's end a decision
// point" (design rules, Recompute: when, not what). It reads at each round what
// a step would hear at work: what its rounds raised (Situations: the wallet's
// crossings of its goal among them). The build at the window's end reads the rest, and searches the earning spot only when one of its situations woke it. The
// rounds run in one burst at the step, against the world as it stands then:
// the kernel bounds how far ahead of the step's clock they run (its look-ahead,
// WINDOW_LEAD_MS), so the window's end comes within it.
const ColdEconomyPlan = require('./ColdEconomyPlan');
const Situations = require('../Situations');

// The bot's own clock: what its hunt has been credited through.
function ownClock(state) {
    return Math.max(Number(state.timing?.lastResolvedAt) || 0, Number(state.stats?.huntedThrough) || 0);
}
// The clock a step at timestamp lives from. A bot that held for an event
// (stats.eventWait, BotLifeState.prepareResolve) steps at that event or at the
// wait's known end: the time before it was lived waiting, not hunting.
function livedClock(state, timestamp) {
    return state.stats?.eventWait ? timestamp : ownClock(state);
}
// The hunt time a step at timestamp lives: since its lived clock.
function stepElapsedMs(state, timestamp) {
    const since = livedClock(state, timestamp);
    return since ? Math.max(1000, timestamp - since) : 60000;
}

// A plan the rounds change only through endOf: it keeps the bot hunting, acts on
// nothing, waits for no fight and asks no party.
function planHunts(plan) {
    return !plan?.lastFight && !plan?.partyRequest && !plan?.replanFailure
        && (!plan?.activityPick || plan.activityPick.activity === 'hunting')
        && !ColdEconomyPlan.acts(plan?.economyPlan);
}

// A step without its own decision (karma, a meeting, raid supply) or with
// another writer of its schedule (a party, a party request, a contest's wait, an
// encounter, an errand) keeps its one round. latestAt: a step later than this is
// ahead of the clock already (woken before its window's end): one round, so a
// wake earns no window.
function opens(state, plan, result, timestamp, latestAt) {
    const stats = state.stats || {};
    return !!plan?.economy && state.activity === 'hunting' && timestamp <= latestAt
        && huntingRound(result) && result.patch?.activity === 'hunting' && planHunts(plan)
        && !state.party?.partyId && !state.partyId && !stats.partyRequest && !stats.coldCompetition?.wait
        && !stats.pvpEncounter && !stats.tradeMeeting && !stats.supplyErrand;
}

// A round that hunted (resolveSolo's last return), whatever its fights.
function huntingRound(result) {
    return Object.hasOwn(result?.debug || {}, 'attemptedFights');
}

// What ended the window at this round, '' while it runs on. before, after: the
// round's states, its projection done (its situations raised: the wallet's crossings
// and the supply lines among them). readers, the worker's and the kernel's: feasible(after)
// (EconomyContext.leafOutcome: what the held leaf's execution proved, raised by the step)
// and kind(after) (lifecycleKind: a state that asks a command).
function endOf(before, after, result, readers) {
    if (!huntingRound(result)) return 'round';
    // The round's own end: a rest, a death, a flight.
    if (after.activity !== 'hunting') return after.activity === 'dead' ? 'death' : 'rest';
    // A decision woken by the round (Situations: what is heard at work; a level up
    // waits for the rest): its step decides. What waits does not end it.
    if (Situations.anyWoken(after.stats)) return 'event';
    if (!readers.feasible(after)) return 'leaf';
    return readers.kind(after) !== 'resolver' ? 'command' : '';
}

// A window's debug for main: the rounds' numbers summed over the last round's fields.
function sumDebug(total, debug = {}) {
    const sum = { ...debug };
    for (const key in total) if (typeof total[key] === 'number' && typeof sum[key] === 'number') sum[key] += total[key];
    return sum;
}

module.exports = { ownClock, livedClock, stepElapsedMs, opens, huntingRound, endOf, sumDebug };
