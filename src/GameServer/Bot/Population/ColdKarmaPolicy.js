const LevelingRoutes = invoke('GameServer/Bot/AI/LevelingRoutes');
const SpotIndex = invoke('GameServer/Bot/AI/SpotIndex');
const SpotService = invoke('GameServer/Bot/AI/SpotService');
const SpotRiskPolicy = invoke('GameServer/Bot/Population/SpotRiskPolicy');
const TargetMatchup = invoke('GameServer/Bot/AI/BotTargetMatchup');
const ColdTrip = require('./ColdTrip');

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

function plan(state, spots, timestamp = Date.now()) {
    if (!active(state)) return null;
    const backoff = SpotRiskPolicy.backoffForStates([state], state.spotId, timestamp);
    const routedState = backoff && !SpotRiskPolicy.activeBackoffs(state, timestamp)
        .some(entry => entry.spotId === state.spotId)
        ? SpotRiskPolicy.withBackoff(state, backoff, timestamp) : state;
    const clean = { ...routedState, stats: { ...(routedState.stats || {}), equipmentPlan: null,
        partyRequest: null, marketReturn: null, craftReturn: null, craftStationId: null,
        warehouseWorkflow: null, warehouseErrand: null, supplyErrand: null } };
    const travel = clean.stats.travel;
    const excludedSpotIds = SpotRiskPolicy.excludedSpotIdsForStates([clean], timestamp);
    if (state.activity === 'traveling' && travel?.reason === 'karma_washing'
        && !excludedSpotIds.has(travel.spotId)) {
        return { targetNpcId: 0, plannedState: clean, spot: SpotIndex.spotById(spots, travel.spotId) };
    }
    // The level window is a cheap comparison; the solo matchup behind
    // isSpotAllowedForState is not, so it only judges spots inside the window,
    // with the bot's combat profiles built once, by the first spot judged.
    const routeOptions = { mode: 'solo' };
    const allowed = (spot) => {
        if (!routeOptions.matchupProfiles) routeOptions.matchupProfiles = TargetMatchup.stateProfiles(clean, routeOptions);
        return LevelingRoutes.isSpotAllowedForState(spot, clean, routeOptions);
    };
    const candidates = spots.filter(spot => {
        const point = spot.center;
        return spot.raidBoss !== true && point
            && Number(spot.minLevel || 1) <= Number(state.level || 1)
            && Number(spot.maxLevel || spot.minLevel || 1) >= Math.max(1, Number(state.level || 1) - 8)
            && !excludedSpotIds.has(spot.id) && !utils.isInPeaceZone(point.locX, point.locY)
            && allowed(spot);
    });
    const current = candidates.find(spot => spot.id === state.spotId
        && Math.hypot(Number(spot.center.locX) - Number(state.loc?.locX),
            Number(spot.center.locY) - Number(state.loc?.locY)) < 4500);
    const spot = current || LevelingRoutes.bestSpot(candidates, clean)?.spot || null;
    clean.stats.travel = null;
    if (state.activity === 'dead') return { targetNpcId: 0, plannedState: clean, spot };
    if (current && !utils.isInPeaceZone(state.loc?.locX, state.loc?.locY)) {
        return { targetNpcId: targetForSpot(state, spot), plannedState: { ...clean, spotId: spot.id,
            activity: state.activity === 'resting' ? 'resting' : 'hunting' }, spot };
    }
    if (!spot) return { targetNpcId: 0, plannedState: { ...clean, activity: 'resting' }, spot: null };
    const to = SpotService.arrivalPointForState(clean, spot);
    if (!to || utils.isInPeaceZone(to.locX, to.locY)) {
        return { targetNpcId: 0, plannedState: { ...clean, activity: 'resting' }, spot: null };
    }
    const from = { ...(state.loc || {}) };
    // A bot with karma walks (ColdTrip.toSpot), with the switch off in the
    // author's washing walk time: at least 25 s, then 120 units per second.
    return { targetNpcId: 0, spot, plannedState: ColdTrip.toSpot(clean, {
        from, to, reason: 'karma_washing', spotId: spot.id, regionName: spot.name,
        arrivalActivity: 'hunting', arrivalEvent: 'arrived_hunting_ground'
    }, timestamp, { durationMs: ColdTrip.authorWalkMs(from, to) }) };
}

module.exports = { active, plan, targetForSpot };
