const MIN_DEATHS_AT_SPOT = 2;
const MIN_DEATH_RATE = 0.2;
const BACKOFF_MS = 60 * 60 * 1000;
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;
const MAX_BACKOFFS = 8;

function normalizedSpotId(value) {
    const spotId = String(value || '').trim();
    return spotId || null;
}

function deathPressure(state = {}, spotId = state.spotId) {
    const expectedSpotId = normalizedSpotId(spotId);
    const risk = state.stats?.spotRisk;
    if (!expectedSpotId || normalizedSpotId(risk?.spotId) !== expectedSpotId) return null;

    const deaths = Math.max(0, Number(state.stats?.deaths || 0) - Number(risk.deathsAtEntry || 0));
    const fights = Math.max(0, Number(state.stats?.fightsResolved || 0) - Number(risk.fightsAtEntry || 0));
    const deathRate = deaths / Math.max(1, fights);
    if (deaths < MIN_DEATHS_AT_SPOT || deathRate < MIN_DEATH_RATE) return null;
    return { spotId: expectedSpotId, deaths, fights, deathRate };
}

function activeBackoffs(state = {}, timestamp = Date.now()) {
    return (Array.isArray(state.stats?.spotBackoffs) ? state.stats.spotBackoffs : [])
        .filter((entry) => normalizedSpotId(entry?.spotId) && Number(entry.until || 0) > timestamp)
        .map((entry) => ({
            ...entry,
            spotId: normalizedSpotId(entry.spotId),
            until: Number(entry.until)
        }));
}

function backoffForStates(states = [], spotId, timestamp = Date.now()) {
    const expectedSpotId = normalizedSpotId(spotId);
    if (!expectedSpotId) return null;

    const stored = (states || []).flatMap((state) => activeBackoffs(state, timestamp))
        .filter((entry) => entry.spotId === expectedSpotId)
        .sort((left, right) => Number(right.until) - Number(left.until))[0];
    if (stored) return stored;

    const pressures = (states || [])
        .map((state) => deathPressure(state, expectedSpotId))
        .filter(Boolean)
        .sort((left, right) => right.deathRate - left.deathRate || right.deaths - left.deaths);
    const pressure = pressures[0];
    if (!pressure) return null;
    return {
        ...pressure,
        reason: 'death_pressure',
        startedAt: timestamp,
        until: timestamp + BACKOFF_MS
    };
}

function excludedSpotIdsForStates(states = [], timestamp = Date.now()) {
    const excluded = new Set();
    (states || []).forEach((state) => {
        activeBackoffs(state, timestamp).forEach((entry) => excluded.add(entry.spotId));
        const pressure = deathPressure(state);
        if (pressure) excluded.add(pressure.spotId);
    });
    return excluded;
}

function withBackoff(state = {}, backoff = null, timestamp = Date.now()) {
    const spotId = normalizedSpotId(backoff?.spotId);
    if (!spotId) return state;

    const prior = (Array.isArray(state.stats?.spotBackoffs) ? state.stats.spotBackoffs : [])
        .filter((entry) => normalizedSpotId(entry?.spotId) === spotId)
        .sort((left, right) => Number(right.startedAt || 0) - Number(left.startedAt || 0))[0];
    const continuing = prior
        && Number(prior.until || 0) > timestamp
        && Number(prior.startedAt || 0) === Number(backoff.startedAt || 0);
    const priorAttempts = prior ? Math.max(1, Number(prior.attempts || 1)) : 0;
    const attempts = continuing
        ? priorAttempts
        : Math.max(1, priorAttempts + 1);
    const escalationMs = Math.min(MAX_BACKOFF_MS, BACKOFF_MS * (2 ** Math.min(3, attempts - 1)));
    const retained = activeBackoffs(state, timestamp)
        .filter((entry) => entry.spotId !== spotId);
    const next = {
        ...backoff,
        spotId,
        reason: backoff.reason || 'death_pressure',
        attempts,
        startedAt: Number(backoff.startedAt || timestamp),
        until: Math.min(
            timestamp + MAX_BACKOFF_MS,
            Math.max(timestamp + escalationMs, Number(backoff.until || 0))
        )
    };
    const spotBackoffs = [...retained, next]
        .sort((left, right) => Number(right.until) - Number(left.until))
        .slice(0, MAX_BACKOFFS);
    return {
        ...state,
        stats: {
            ...(state.stats || {}),
            spotBackoffs
        }
    };
}

module.exports = {
    MIN_DEATHS_AT_SPOT,
    MIN_DEATH_RATE,
    BACKOFF_MS,
    MAX_BACKOFF_MS,
    MAX_BACKOFFS,
    deathPressure,
    activeBackoffs,
    backoffForStates,
    excludedSpotIdsForStates,
    withBackoff
};
