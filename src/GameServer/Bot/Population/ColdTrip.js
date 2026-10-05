// One builder for a cold bot's trip (U18): to a town (market, craft station,
// Mammon) or to a hunting spot (a hunting route, the return from a town). The
// caller names the destination and its own trip fields (reason, arrival,
// events); the builder sets the method, the payment, the duration and the
// timing. A trip into a town is paid as a player pays (TripPayment): one
// Scroll of Escape from outside the town (without one the bot walks to the
// town), the gatekeeper fee between towns; a trip to a spot is free.
const Karma = require('../../Karma');
const TravelRoutes = require('../Travel/TravelRoutes');
const TripPayment = require('../Travel/TripPayment');

// The author's cold trip: an SoE / gatekeeper transit or a hunting route.
const AUTHOR_TRIP_MS = 25000;
// The author's cold walking speed, units per second (ColdKarmaPolicy, clan hall walks).
const RUN_SPEED = 120;
// Within this distance of its centre a bot is in town: it walks to the gatekeeper.
const TOWN_RADIUS = 6000;

function distance(from, to) {
    return Math.hypot(Number(from?.locX || 0) - Number(to?.locX || 0), Number(from?.locY || 0) - Number(to?.locY || 0));
}

function runMs(from, to) {
    return Math.ceil(distance(from, to) / RUN_SPEED * 1000);
}

// The author's cold walk: at least the 25 s transit, then 120 units per second.
function authorWalkMs(from, to) {
    return Math.max(AUTHOR_TRIP_MS, runMs(from, to));
}

function point(town) {
    return { locX: town.locX, locY: town.locY, locZ: town.locZ };
}

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

// How a bot reaches the town at `to`: it starts in the town a Scroll of Escape
// lands in (TravelRoutes.landingTown); in it already, it walks to the
// gatekeeper; otherwise it reads a scroll, or walks there without one. Then
// the gatekeeper route to the destination town. Null without a route.
function townPlan(state, to) {
    const from = state.loc || {};
    const { start, route } = TravelRoutes.between(from, to);
    if (!route) return null;
    const inStart = distance(from, start) <= TOWN_RADIUS;
    const scroll = !inStart && TripPayment.hasColdScroll(state);
    const walk = !inStart && !scroll;
    return {
        route,
        scroll,
        method: walk ? 'walk_gatekeeper' : 'soe_gatekeeper',
        durationMs: walk ? authorWalkMs(from, start) : AUTHOR_TRIP_MS
    };
}

// A trip into a town; the scroll and the fee are debited at once. Null when
// no gatekeeper route leads there or the bot cannot pay the fee.
function toTown(state, travel, timestamp = Date.now(), extraStats = {}) {
    const plan = townPlan(state, travel.to);
    if (!plan) return null;
    const paid = TripPayment.payCold(state, { scroll: plan.scroll, fee: plan.route.fee });
    if (!paid) return null;
    const payment = plan.scroll || plan.route.fee > 0
        ? { paid: { ...(plan.scroll ? { scroll: TripPayment.SCROLL_OF_ESCAPE } : {}), fee: plan.route.fee } }
        : {};
    return begin(paid, { ...travel, method: plan.method, ...payment }, timestamp, plan.durationMs, extraStats);
}

// A trip to a hunting spot: a gatekeeper from the nearest town, on foot for a
// bot with karma. `durationMs` is the caller's trip time.
function toSpot(state, travel, timestamp = Date.now(), { durationMs = AUTHOR_TRIP_MS, extraStats = {} } = {}) {
    const method = Karma.closesTowns(state.stats?.karma) ? 'walk' : 'gatekeeper_spot';
    return begin(state, { ...travel, method }, timestamp, durationMs, extraStats);
}

module.exports = { AUTHOR_TRIP_MS, RUN_SPEED, TOWN_RADIUS, authorWalkMs, runMs, point, toTown, toSpot };
