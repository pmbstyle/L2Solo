// One builder for a cold bot's trip (U18): to a town (market, craft station,
// Mammon) or to a hunting spot (a hunting route, the return from a town). The
// caller names the destination and its own trip fields (reason, arrival,
// events); the builder sets the method, the duration and the timing.
const Karma = require('../../Karma');

// The author's cold trip: an SoE / gatekeeper transit or a hunting route.
const AUTHOR_TRIP_MS = 25000;

function begin(state, travel, timestamp, durationMs, extraStats = {}) {
    const arrivalAt = timestamp + Math.max(1000, Number(durationMs) || AUTHOR_TRIP_MS);
    return {
        ...state,
        activity: 'traveling',
        stats: {
            ...(state.stats || {}),
            ...extraStats,
            travel: { from: { ...(state.loc || {}) }, ...travel, startedAt: timestamp, arrivalAt }
        },
        timing: { ...(state.timing || {}), activityStartedAt: timestamp, nextResolveAt: arrivalAt }
    };
}

// A trip into a town: Scroll of Escape to the region's town, then the
// gatekeeper (method soe_gatekeeper).
function toTown(state, travel, timestamp = Date.now(), extraStats = {}) {
    return begin(state, { ...travel, method: 'soe_gatekeeper' }, timestamp, AUTHOR_TRIP_MS, extraStats);
}

// A trip to a hunting spot: a gatekeeper from the nearest town, on foot for a
// bot with karma. `durationMs` is the caller's trip time.
function toSpot(state, travel, timestamp = Date.now(), { durationMs = AUTHOR_TRIP_MS, extraStats = {} } = {}) {
    const method = Karma.closesTowns(state.stats?.karma) ? 'walk' : 'gatekeeper_spot';
    return begin(state, { ...travel, method }, timestamp, durationMs, extraStats);
}

module.exports = { AUTHOR_TRIP_MS, toTown, toSpot };
