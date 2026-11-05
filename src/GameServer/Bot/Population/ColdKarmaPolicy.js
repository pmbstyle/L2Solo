const LevelingRoutes = invoke('GameServer/Bot/AI/LevelingRoutes');
const SpotIndex = invoke('GameServer/Bot/AI/SpotIndex');
const SpotService = invoke('GameServer/Bot/AI/SpotService');
const SpotRiskPolicy = invoke('GameServer/Bot/Population/SpotRiskPolicy');
const TargetMatchup = invoke('GameServer/Bot/AI/BotTargetMatchup');
const ColdTrip = require('./ColdTrip');
const Situations = require('../Situations');

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
function washSpot(state, spots, timestamp = Date.now()) {
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
            && allowed(spot);
    };
    // Only a bot that left its own spot judges every spot for the best one.
    const own = SpotIndex.spotById(spots, state.spotId);
    return (nearOwn(state, own) && eligible(own) ? own : null)
        || LevelingRoutes.bestSpot(spots.filter(eligible), clean)?.spot || null;
}

// A karma step (the worker's planLifecycle, main's cold entry): it executes the
// held answer (stats.earning), no search here. While the earning spot is woken
// (karma just appeared, or another situation) the bot rests until the answer
// comes; with none, or one its marks exclude, it rests too. A party member
// decides no earning spot (EconomyContext.earningDue): its step takes the wash's
// choice itself, as before situations step 1 (temporary until the party
// aggregate, step 8; debt.md).
function plan(state, spots, timestamp = Date.now()) {
    if (!active(state)) return null;
    const clean = washingState(state, timestamp);
    const travel = clean.stats.travel;
    const excludedSpotIds = SpotRiskPolicy.excludedSpotIdsForStates([clean], timestamp);
    if (state.activity === 'traveling' && travel?.reason === 'karma_washing'
        && !excludedSpotIds.has(travel.spotId)) {
        return { targetNpcId: 0, plannedState: clean, spot: SpotIndex.spotById(spots, travel.spotId) };
    }
    const member = !!(state.party?.partyId || state.partyId);
    const held = member ? washSpot(state, spots, timestamp) : Situations.woken(state.stats, 'earning_spot') ? null
        : SpotIndex.spotById(spots, state.stats?.earning?.spotId);
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
