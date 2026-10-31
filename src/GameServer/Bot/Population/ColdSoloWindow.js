'use strict';
// T120, option C: a hunting solo bot's step runs its rounds on until its next
// event; its next due is that event, not one 30-120 s round away. The rounds
// are today's (resolveSolo, then BotLifeState.prepareResolve), in the order and
// with the seeds its steps would run: a window changes when the bot decides and
// commits, never what its fights give.
//
// A step used to credit past time only (now - lastResolvedAt). A window credits
// ahead: its rounds run at their own dues at the window's start, so the row holds
// the bot's state up to one deadline past now. stats.huntedThrough keeps that end
// whatever writes lastResolvedAt later (a command, a party, a hot session): no
// hunt credit runs before it (stepElapsedMs), no time is hunted twice cold. Hot
// time inside it is lived on top: at most one window per interruption.
//
// The window's rule, the one owner of "is a hunting round's end a decision
// point" (design rules, Recompute: when, not what). The soft inputs (the money
// drift, the income, the market watch) are compared once, at the window's end.
const ColdEconomyPlan = require('./ColdEconomyPlan');

// The bot's own clock: what its hunt has been credited through.
function ownClock(state) {
    return Math.max(Number(state.timing?.lastResolvedAt) || 0, Number(state.stats?.huntedThrough) || 0);
}
// The hunt time a step at timestamp lives: since the bot's own clock.
function stepElapsedMs(state, timestamp) {
    const since = ownClock(state);
    return since ? Math.max(1000, timestamp - since) : 60000;
}

// A plan the rounds change only through endOf: it keeps the bot hunting, acts on
// nothing, waits for no fight and asks no party. Read by the window's open and,
// for a step a window would have skipped, by the shadow.
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
// round's states, its projection done (hard events raised, soft ones not read).
// deadline: the plan's (EconomyContext.holdEndsAt). readers, the worker's and
// the kernel's: edges(before, after) (ColdEconomyPlan.edges), moneyBound(after),
// feasible(after) (EconomyContext.leafCheck, the held leaf's execution check),
// planHolds(after, at) (the native facts its planLifecycle reads) and
// kind(after) (lifecycleKind: a state that asks a command).
function endOf(before, after, result, deadline, readers) {
    if (!huntingRound(result)) return 'round';
    // The round's own end: a rest, a death, a flight.
    if (after.activity !== 'hunting') return after.activity === 'dead' ? 'death' : 'rest';
    // Level is no fact of its own: the kit's section may not move with it.
    if (Number(after.level) !== Number(before.level)) return 'level';
    // The hard events of the round: supplies, the bag, the kit, the funding, a death mark.
    if (Number(after.stats?.wishDirty) || 0) return 'event';
    // New loot (bit 1) is no decision point: the commit's edges read it from the window's start.
    if (readers.edges(before, after) & ~1) return 'supplies';
    if (readers.moneyBound(after)) return 'money';
    if (!readers.feasible(after)) return 'leaf';
    if (readers.kind(after) !== 'resolver') return 'command';
    const at = Number(after.timing?.nextResolveAt) || 0;
    if (at >= deadline) return 'deadline';
    return readers.planHolds(after, at) ? '' : 'plan';
}

// A window's debug for main: the rounds' numbers summed over the last round's fields.
function sumDebug(total, debug = {}) {
    const sum = { ...debug };
    for (const key in total) if (typeof total[key] === 'number' && typeof sum[key] === 'number') sum[key] += total[key];
    return sum;
}

// What a step's plan would have changed in a window that skipped it (the
// shadow's compare): the leaf and the target the window ran on, a trip, an act.
function planKey(plan) {
    const pick = plan?.activityPick;
    return `${pick?.activity ?? ''}:${pick?.spotId ?? ''}:${pick?.npcId ?? ''}:${Number(plan?.targetNpcId) || 0}`;
}
function planMoved(plan, key, state) {
    return planKey(plan) !== key || (plan?.plannedState || state).activity !== 'hunting' || !planHunts(plan);
}

module.exports = { ownClock, stepElapsedMs, opens, huntingRound, endOf, sumDebug, planKey, planMoved };
