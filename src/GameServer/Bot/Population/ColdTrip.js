// One builder for a cold bot's trip (U18): to a town (market, craft station,
// Mammon) or to a hunting spot (a hunting route, the return from a town). The
// caller names the destination and its own trip fields (reason, arrival,
// events); the builder sets the method, the payment, the duration and the
// timing. A trip into a town is paid as a player pays (TripPayment): one
// Scroll of Escape from outside the town (without one the bot walks to the
// town), the gatekeeper fee between towns; a trip to a spot is free.
//
// Trip time: with [BotPopulation] coldHonestTravel off, the author's times (a
// 25 s transit). With it on, the same for every bot: the scroll cast, 5 s per
// gatekeeper hop (TravelRoutes) and the run at 120 units/s; a solo trip to a
// spot keeps its run as travel.run { from, to, startAt, endAt }, which makes
// the bot a walker (LifeStateCache.walkers) that can appear near a player.
// Nothing is computed while the bot travels.
const Karma = require('../../Karma');
const Config = require('./PopulationConfig');
const TravelRoutes = require('../Travel/TravelRoutes');
const TripPayment = require('../Travel/TripPayment');

// The author's cold trip: an SoE / gatekeeper transit or a hunting route.
const AUTHOR_TRIP_MS = 25000;
// The author's cold walking speed, units per second (ColdKarmaPolicy, clan hall walks).
const RUN_SPEED = 120;
// Within this distance of its centre a bot is in town: it walks to the gatekeeper.
const TOWN_RADIUS = 6000;
// One gatekeeper hop: the talk and the teleport.
const HOP_MS = 5000;

function honest() {
    return Config.coldHonestTravel === true;
}

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
    const { start, gate, route } = TravelRoutes.between(from, to);
    if (!route) return null;
    const inStart = distance(from, start) <= TOWN_RADIUS;
    const scroll = !inStart && TripPayment.hasColdScroll(state);
    const walk = !inStart && !scroll;
    const honestMs = (scroll ? TripPayment.SCROLL_CAST_MS : runMs(from, start))
        + route.hops * HOP_MS + runMs(gate, to);
    return {
        route,
        scroll,
        method: walk ? 'walk_gatekeeper' : 'soe_gatekeeper',
        durationMs: honest() ? honestMs : walk ? authorWalkMs(from, start) : AUTHOR_TRIP_MS
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

// Honest time to a spot point `to`: on foot all the way, or from the town a
// Scroll of Escape reaches (in it already: a walk to its gatekeeper) through
// the gatekeeper hops to a teleport point, then on foot; whichever is sooner.
// A bot with karma walks. The run is the last part on foot: { from, startMs }.
// One pass over the ~105 teleport points of the route table per trip.
function spotPlan(state, to) {
    const from = state.loc || {};
    let best = { method: 'walk', durationMs: runMs(from, to), run: { from, startMs: 0 } };
    if (Karma.closesTowns(state.stats?.karma)) return best;
    const start = TravelRoutes.landingTown(from);
    const startKey = TravelRoutes.townKey(start);
    const lead = distance(from, start) <= TOWN_RADIUS ? runMs(from, start) : TripPayment.SCROLL_CAST_MS;
    for (const teleport of TravelRoutes.teleportPoints()) {
        const hops = teleport.hops[startKey];
        if (hops === undefined) continue;
        const startMs = lead + hops * HOP_MS;
        const durationMs = startMs + runMs(teleport, to);
        if (durationMs < best.durationMs) best = { method: 'gatekeeper_spot', durationMs, run: { from: teleport, startMs } };
    }
    return best;
}

// How long a trip to a spot takes: the author's 25 s, or the honest time.
function spotTripMs(state, to) {
    return honest() ? spotPlan(state, to).durationMs : AUTHOR_TRIP_MS;
}

// A trip to a hunting spot: a gatekeeper from the nearest town, on foot for a
// bot with karma. `durationMs` is the caller's trip time with the switch off;
// `sharedMs`, a party's one trip time for every member (no walker).
function toSpot(state, travel, timestamp = Date.now(), { durationMs = AUTHOR_TRIP_MS, sharedMs = 0, extraStats = {} } = {}) {
    const method = Karma.closesTowns(state.stats?.karma) ? 'walk' : 'gatekeeper_spot';
    if (!honest()) return begin(state, { ...travel, method }, timestamp, durationMs, extraStats);
    if (sharedMs > 0) return begin(state, { ...travel, method }, timestamp, sharedMs, extraStats);
    const plan = spotPlan(state, travel.to);
    const arrivalAt = timestamp + Math.max(1000, plan.durationMs);
    const run = {
        from: point(plan.run.from),
        to: { ...travel.to },
        startAt: Math.min(arrivalAt, timestamp + plan.run.startMs),
        endAt: arrivalAt
    };
    return begin(state, { ...travel, method: plan.method, run }, timestamp, arrivalAt - timestamp, extraStats);
}

// Where a cold traveller is at `timestamp`, computed only when asked: on its
// run, the straight-line estimate (used to judge distance, never to place
// the bot); before it, where it set out; after it, the destination.
function positionAt(state, timestamp = Date.now()) {
    const travel = state?.stats?.travel;
    if (!travel) return state?.loc || null;
    const run = travel.run;
    if (!run || timestamp < run.startAt) return timestamp >= Number(travel.arrivalAt) ? travel.to : travel.from || state.loc;
    const progress = Math.min(1, (timestamp - run.startAt) / Math.max(1, run.endAt - run.startAt));
    return {
        locX: Math.round(run.from.locX + (run.to.locX - run.from.locX) * progress),
        locY: Math.round(run.from.locY + (run.to.locY - run.from.locY) * progress),
        locZ: Math.round(run.from.locZ + (run.to.locZ - run.from.locZ) * progress)
    };
}

// Design 5.9: with honest travel a trip is not a "busy" reason; a traveller
// invited by a player leaves its trip as a bot on a spot leaves its hunt.
function travellerAnswers(state) {
    return honest() && state?.activity === 'traveling';
}

module.exports = {
    AUTHOR_TRIP_MS, RUN_SPEED, TOWN_RADIUS, HOP_MS,
    honest, authorWalkMs, runMs, point, toTown, toSpot, spotPlan, spotTripMs, positionAt, travellerAnswers
};
