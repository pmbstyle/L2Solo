const LevelingRoutes = invoke('GameServer/Bot/AI/LevelingRoutes');
const SpotIndex = invoke('GameServer/Bot/AI/SpotIndex');
const SpotService = invoke('GameServer/Bot/AI/SpotService');
const SpotRiskPolicy = invoke('GameServer/Bot/Population/SpotRiskPolicy');
const TargetMatchup = invoke('GameServer/Bot/AI/BotTargetMatchup');
const ColdTrip = require('./ColdTrip');
const Situations = require('../Situations');
const { isMainThread } = require('node:worker_threads');

// Karma washing: a bot with any karma hunts it off. The same value as
// Karma.closesTowns, asked for planning rather than for town access.
function active(state) {
    return Number(state?.stats?.karma || 0) > 0;
}

function targetForSpot(state, spot) {
    // Wash karma on weaker experience-bearing mobs; the normal encounter
    // resolver still permits aggressive neighbours to interrupt the hunt.
    const level = Number(state?.level || 1);
    return Number((spot?.npcEntries || [])
        .filter(entry => Number(entry.selfId) > 0 && Number(entry.level) >= Math.max(1, level - 8)
            && Number(entry.level) <= level)
        .sort((a, b) => Number(a.level) - Number(b.level) || Number(a.selfId) - Number(b.selfId))[0]?.selfId || 0);
}

// The washing state: the death backoff of its own spot recorded, its errands
// dropped (a bot with karma only washes it). Its exclusions read from it.
function washingState(state, timestamp) {
    const backoff = SpotRiskPolicy.backoffForStates([state], state.spotId, timestamp);
    const routedState = backoff && !SpotRiskPolicy.activeBackoffs(state, timestamp)
        .some(entry => entry.spotId === state.spotId)
        ? SpotRiskPolicy.withBackoff(state, backoff, timestamp) : state;
    return { ...routedState, stats: { ...(routedState.stats || {}), equipmentPlan: null,
        partyRequest: null, marketReturn: null, craftReturn: null, craftStationId: null,
        warehouseWorkflow: null, warehouseErrand: null, supplyErrand: null } };
}
// Its own spot while it stands near it (the index's row for its id).
function nearOwn(state, spot) {
    return !!spot && Math.hypot(Number(spot.center?.locX) - Number(state.loc?.locX),
        Number(spot.center?.locY) - Number(state.loc?.locY)) < 4500;
}

// The karma wash's spot: the earning spot decision's answer while the bot has
// karma (situations.md B6: EquipmentIncomeRoute's search takes it, woken by
// karma_changed and the earning spot's other situations), never asked per step.
// Its own spot while near and eligible, else the best eligible field: mobs up to
// eight levels below it, out of a peace zone, not a raid, not excluded.
// accept(spot): the earning decision's own filter (a broke bot skips spots that need survival drinks, A5).
function washSpot(state, spots, timestamp = Date.now(), accept = null) {
    const clean = washingState(state, timestamp);
    const excludedSpotIds = SpotRiskPolicy.excludedSpotIdsForStates([clean], timestamp);
    // The level window is a cheap comparison; the solo matchup behind
    // isSpotAllowedForState is not, so it only judges spots inside the window,
    // with the bot's combat profiles built once, by the first spot judged.
    const routeOptions = { mode: 'solo' };
    const allowed = (spot) => {
        if (!routeOptions.matchupProfiles) routeOptions.matchupProfiles = TargetMatchup.stateProfiles(clean, routeOptions);
        return LevelingRoutes.isSpotAllowedForState(spot, clean, routeOptions);
    };
    const eligible = spot => {
        const point = spot?.center;
        return spot?.raidBoss !== true && point
            && Number(spot.minLevel || 1) <= Number(state.level || 1)
            && Number(spot.maxLevel || spot.minLevel || 1) >= Math.max(1, Number(state.level || 1) - 8)
            && !excludedSpotIds.has(spot.id) && !utils.isInPeaceZone(point.locX, point.locY)
            && (!accept || accept(spot)) && allowed(spot);
    };
    // Only a bot that left its own spot judges every spot for the best one.
    const own = SpotIndex.spotById(spots, state.spotId);
    return (nearOwn(state, own) && eligible(own) ? own : null)
        || LevelingRoutes.bestSpot(spots.filter(eligible), clean)?.spot || null;
}

// The earning decision taken in a karma step (plan): the search's answer held on
// stats (the planned state's copy: written), its spot marks cleared and its bit
// cleared through Situations.decided, as the build's decided path does.
function decideEarning(state, stats, spots, timestamp) {
    const IncomeRoute = invoke('GameServer/Bot/Economy/EquipmentIncomeRoute'); // lazy: cycle its search reads this module
    const found = IncomeRoute.search(state, { spots, timestamp, required: true });
    const earning = Situations.withOwnFacts(state, IncomeRoute.answerOf(found.route, timestamp, found.error));
    stats.woken = Situations.decided(stats, 'earning_spot', { caller: 'karma_step', subject: state.characterId,
        answer: earning.spotId ?? 'none', was: state.stats?.earning?.spotId ?? 'none' });
    stats.earning = earning; stats.spotMarks = null;
    return earning;
}

// A karma step (the worker's planLifecycle, main's cold entry): it executes the
// held answer (stats.earning). While the earning spot is woken the worker takes
// the decision first (decideEarning); main rests until the answer comes. With no
// spot, or one its marks exclude, it rests. A party member with karma leaves its
// party (its stay, PartyStay): the wash is a solo hunt.
function plan(state, spots, timestamp = Date.now()) {
    if (!active(state)) return null;
    const clean = washingState(state, timestamp);
    const travel = clean.stats.travel;
    const excludedSpotIds = SpotRiskPolicy.excludedSpotIdsForStates([clean], timestamp);
    if (state.activity === 'traveling' && travel?.reason === 'karma_washing'
        && !excludedSpotIds.has(travel.spotId)) {
        return { targetNpcId: 0, plannedState: clean, spot: SpotIndex.spotById(spots, travel.spotId) };
    }
    let earning = state.stats?.earning;
    if (Situations.woken(state.stats, 'earning_spot')) {
        // Woken (karma just appeared, no answer yet, another situation): a karma step is the
        // bot's decision point (its build only runs after the round), so on the worker the
        // earning decision is taken here by its one search (the karma wash's choice there),
        // published on the planned state as a build publishes it; main never decides: it rests.
        earning = isMainThread ? null : decideEarning(state, clean.stats, spots, timestamp);
    }
    const held = SpotIndex.spotById(spots, earning?.spotId);
    const spot = held && !excludedSpotIds.has(String(held.id)) ? held : null;
    clean.stats.travel = null;
    if (state.activity === 'dead') return { targetNpcId: 0, plannedState: clean, spot };
    if (nearOwn(state, spot) && String(spot.id) === String(state.spotId) && !utils.isInPeaceZone(state.loc?.locX, state.loc?.locY)) {
        return { targetNpcId: targetForSpot(state, spot), plannedState: { ...clean, spotId: spot.id,
            activity: state.activity === 'resting' ? 'resting' : 'hunting' }, spot };
    }
    if (!spot) return { targetNpcId: 0, plannedState: { ...clean, activity: 'resting' }, spot: null };
    const to = SpotService.arrivalPointForState(clean, spot);
    if (!to || utils.isInPeaceZone(to.locX, to.locY)) {
        return { targetNpcId: 0, plannedState: { ...clean, activity: 'resting' }, spot: null };
    }
    const from = { ...(state.loc || {}) };
    // A bot with karma walks (ColdTrip.toSpot).
    return { targetNpcId: 0, spot, plannedState: ColdTrip.toSpot(clean, {
        from, to, reason: 'karma_washing', spotId: spot.id, regionName: spot.name,
        arrivalActivity: 'hunting', arrivalEvent: 'arrived_hunting_ground'
    }, timestamp) };
}

module.exports = { active, washSpot, plan, targetForSpot };
