const SpotRiskPolicy = require('./SpotRiskPolicy');
const ColdTrip = require('./ColdTrip');

// A party's arrival when its route carries no trip time (ColdSimulationKernel).
const HUNTING_TRAVEL_MS = ColdTrip.FALLBACK_TRIP_MS;

function hasFiniteCoordinate(value) {
    return value !== null
        && value !== undefined
        && String(value).trim() !== ''
        && Number.isFinite(Number(value));
}

function routeDestination(state = {}, route = {}) {
    return route?.destinations?.[String(state.characterId)] || route?.to || null;
}

// Starts one bot's trip along a route: the bot's own (BotRoute). A party
// trip arrives `grouped` and leaves the party's backoff out of the member's
// own record; a solo trip records its backoff on the bot.
function beginHuntingTrip(state = {}, route = null, timestamp = Date.now()) {
    if (!state || !route?.needed || state.activity === 'traveling') return null;
    const destination = routeDestination(state, route);
    const from = { ...(state.loc || {}) };
    if (!destination || !hasFiniteCoordinate(from.locX) || !hasFiniteCoordinate(from.locY)) return null;
    const isPartyRoute = route.mode === 'party';
    const routedState = route.spotBackoff && !isPartyRoute
        ? SpotRiskPolicy.withBackoff(state, route.spotBackoff, timestamp)
        : state;
    return ColdTrip.toSpot(routedState, {
        from,
        to: { ...destination },
        regionName: route.regionName || state.currentRegion || 'Hunting Ground',
        spotId: route.spotId,
        arrivalActivity: isPartyRoute ? 'grouped' : 'hunting',
        arrivalEvent: isPartyRoute ? 'party_arrived_hunting_ground' : 'arrived_hunting_ground',
        reason: isPartyRoute
            ? 'party_spot_replan'
            : route.reason || (state.stats?.equipmentPlan?.status === 'active'
                ? 'equipment_source_replan'
                : 'level_replan'),
        ...(route.cause ? { cause: route.cause } : {}),
        // The held leaf's spot this trip stands in for (BotRoute.trip).
        ...(route.leafSpotId != null ? { leafSpotId: route.leafSpotId } : {})
    }, timestamp, {
        // A party travels as one: every member arrives at the party's time.
        sharedMs: isPartyRoute ? Number(route.travelMs) || 0 : 0,
        extraStats: { pveEncounter: null }
    });
}

module.exports = { HUNTING_TRAVEL_MS, beginHuntingTrip };
