const SpotRiskPolicy = require('./SpotRiskPolicy');

// A trip to a hunting spot (gatekeeper, or a walk for a red bot) takes this long.
const HUNTING_TRAVEL_MS = 25000;

function hasFiniteCoordinate(value) {
    return value !== null
        && value !== undefined
        && String(value).trim() !== ''
        && Number.isFinite(Number(value));
}

function routeDestination(state = {}, route = {}) {
    return route?.destinations?.[String(state.characterId)] || route?.to || null;
}

// Starts one bot's trip along a route: the coordinator's (routeFor), or one
// main builds from a spot (PopulationService.beginHuntingTravel). A party
// trip arrives `grouped` and leaves the party's backoff out of the member's
// own record; a solo trip records its backoff on the bot.
function beginHuntingTrip(state = {}, route = null, timestamp = Date.now()) {
    if (!state || !route?.needed || state.activity === 'traveling') return null;
    const destination = routeDestination(state, route);
    const from = { ...(state.loc || {}) };
    if (!destination || !hasFiniteCoordinate(from.locX) || !hasFiniteCoordinate(from.locY)) return null;
    const arrivalAt = timestamp + Math.max(1000, Number(route.travelMs) || HUNTING_TRAVEL_MS);
    const isPartyRoute = route.mode === 'party';
    const routedState = route.spotBackoff && !isPartyRoute
        ? SpotRiskPolicy.withBackoff(state, route.spotBackoff, timestamp)
        : state;
    return {
        ...routedState,
        activity: 'traveling',
        timing: {
            ...(state.timing || {}),
            activityStartedAt: timestamp,
            nextResolveAt: arrivalAt
        },
        stats: {
            ...(routedState.stats || {}),
            pveEncounter: null,
            travel: {
                from,
                to: { ...destination },
                startedAt: timestamp,
                arrivalAt,
                regionName: route.regionName || state.currentRegion || 'Hunting Ground',
                method: Number(state.stats?.karma || 0) > 0 ? 'walk' : 'gatekeeper_spot',
                spotId: route.spotId,
                arrivalActivity: isPartyRoute ? 'grouped' : 'hunting',
                arrivalEvent: isPartyRoute ? 'party_arrived_hunting_ground' : 'arrived_hunting_ground',
                reason: isPartyRoute
                    ? 'party_spot_replan'
                    : route.reason || (state.stats?.equipmentPlan?.status === 'active'
                        ? 'equipment_source_replan'
                        : 'level_replan'),
                ...(route.cause ? { cause: route.cause } : {})
            }
        }
    };
}

module.exports = { HUNTING_TRAVEL_MS, beginHuntingTrip };
