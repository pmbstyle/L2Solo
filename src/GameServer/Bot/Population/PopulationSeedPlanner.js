function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

const STARTER_REGIONS = [
    { id: 'human', center: { locX: -80000, locY: 250000 }, radius: 30000 },
    { id: 'elf', center: { locX: 46000, locY: 40000 }, radius: 30000 },
    { id: 'dark_elf', center: { locX: 27000, locY: 11000 }, radius: 30000 },
    { id: 'orc', center: { locX: -57000, locY: -113000 }, radius: 30000 },
    { id: 'dwarf', center: { locX: 108000, locY: -175000 }, radius: 30000 }
];

function distanceSquared(left = {}, right = {}) {
    const dx = number(left.locX) - number(right.locX);
    const dy = number(left.locY) - number(right.locY);
    return (dx * dx) + (dy * dy);
}

function isPlaying(state = {}) {
    return !['merchant', 'crafting'].includes(state.activity);
}

function snapshot(states = []) {
    const playing = states.filter(isPlaying);
    const population = playing.filter((state) => Number(state.stats?.populationWave || 0) > 0);
    const latestWave = population.reduce((highest, state) => Math.max(highest, Number(state.stats?.populationWave || 0)), 0);
    const latestCohort = population.filter((state) => Number(state.stats?.populationWave || 0) === latestWave);
    const levelTotal = playing.reduce((sum, state) => sum + Math.max(1, number(state.level, 1)), 0);
    const spots = playing.reduce((counts, state) => {
        if (!state.spotId) return counts;
        counts[state.spotId] = number(counts[state.spotId]) + 1;
        return counts;
    }, {});

    return {
        playing: playing.length,
        averageLevel: playing.length ? levelTotal / playing.length : 0,
        population: population.length,
        latestWave,
        latestCohortAverageLevel: latestCohort.length
            ? latestCohort.reduce((sum, state) => sum + Math.max(1, number(state.level, 1)), 0) / latestCohort.length
            : 0,
        spots,
        hasPopulationSeed: population.length > 0
    };
}

function nextWave(snapshot = {}) {
    if (!snapshot.hasPopulationSeed) return 1;
    // Advance exactly one cohort at a time. Legacy/static bots must neither
    // suppress the first wave nor jump several waves on server restart.
    return snapshot.latestCohortAverageLevel >= 5
        ? snapshot.latestWave + 1
        : snapshot.latestWave;
}

function eligibleSpots(profiles = [], maxMobLevel = 1) {
    return profiles
        .filter((spot) => number(spot.minLevel, 0) >= 1 && number(spot.minLevel, 0) <= maxMobLevel)
        .sort((left, right) => number(left.minLevel, 0) - number(right.minLevel, 0)
            || number(left.avgLevel, 0) - number(right.avgLevel, 0)
            || String(left.id).localeCompare(String(right.id)));
}

function starterSlots(spots = [], botsPerRace = 30, waves = 1) {
    const starters = spots.filter((spot) => number(spot.minLevel, 0) === 1);
    const slotsPerRace = Math.max(0, number(botsPerRace, 30)) * Math.max(1, number(waves, 1));
    const fallback = starters.length ? starters : spots;

    return Array.from({ length: slotsPerRace }).flatMap((_, slot) => STARTER_REGIONS.flatMap((region) => {
        const candidates = fallback
            .map((spot) => ({ spot, distance: distanceSquared(spot.center, region.center) }))
            .filter((candidate) => candidate.distance <= region.radius * region.radius)
            .sort((left, right) => left.distance - right.distance || String(left.spot.id).localeCompare(String(right.spot.id)));
        const selected = candidates[slot % Math.max(1, candidates.length)]?.spot;
        return selected ? [{ ...selected, starterRegion: region.id }] : [];
    }));
}

function seedBatchSize(plan = {}, configuredBatch = 1) {
    const normalBatch = Math.max(1, number(configuredBatch, 1));
    // A cohort must land as one wave. Splitting it lets the new level-one bots
    // lower the mean before the remaining members are created, which cancels
    // the wave on the following check.
    return Math.max(normalBatch, Number(plan.newBotsNeeded || plan.missing?.length || 0));
}

function plan(profiles = [], states = [], maxPopulation = 1700, botsPerRace = 30) {
    const current = snapshot(states);
    const limit = Math.max(0, number(maxPopulation));
    const wave = nextWave(current);
    const eligible = eligibleSpots(profiles, 1);
    const available = Math.max(0, limit - current.playing);
    const plannedSlots = starterSlots(eligible, botsPerRace, wave);
    const targetPopulation = Math.min(limit, STARTER_REGIONS.length * Math.max(0, number(botsPerRace, 30)) * wave);
    // The hard server cap includes everyone, but legacy/static bots do not
    // replace the requested 30-per-race generated cohort.
    const newBotsNeeded = Math.max(0, targetPopulation - current.population);
    const occupied = { ...current.spots };
    const missing = plannedSlots
        .filter((spot) => {
            const count = number(occupied[spot.id]);
            occupied[spot.id] = count + 1;
            return count < plannedSlots.filter((candidate) => candidate.id === spot.id).length;
        })
        .slice(0, Math.min(available, newBotsNeeded));

    return {
        ...current,
        maxPopulation: limit,
        wave,
        targetPopulation,
        newBotsNeeded,
        eligible,
        plannedSlots,
        missing
    };
}

module.exports = {
    isPlaying,
    snapshot,
    STARTER_REGIONS,
    nextWave,
    eligibleSpots,
    starterSlots,
    seedBatchSize,
    plan
};
