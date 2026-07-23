const ProgressionRates = invoke('GameServer/ProgressionRates');

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

function regionalTargetCounts(targetPopulation) {
    const base = Math.floor(Math.max(0, number(targetPopulation)) / STARTER_REGIONS.length);
    const remainder = Math.max(0, number(targetPopulation)) % STARTER_REGIONS.length;
    return STARTER_REGIONS.reduce((counts, region, index) => ({
        ...counts,
        [region.id]: base + (index < remainder ? 1 : 0)
    }), {});
}

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
    // Wave pacing deliberately follows hunting bots: a bot that opens a
    // private store has left its farming spot and should be backfilled there.
    // The hard cap, however, covers every generated character, including the
    // ones temporarily selling in town.
    const population = states.filter((state) => Number(state.stats?.populationWave || 0) > 0);
    const playingPopulation = playing.filter((state) => Number(state.stats?.populationWave || 0) > 0);
    const populationByStarterRegion = playingPopulation.reduce((counts, state) => {
        const region = String(state.stats?.starterRegion || '');
        if (STARTER_REGIONS.some((entry) => entry.id === region)) {
            counts[region] = number(counts[region]) + 1;
        }
        return counts;
    }, {});
    const latestWave = population.reduce((highest, state) => Math.max(highest, Number(state.stats?.populationWave || 0)), 0);
    const latestCohort = playingPopulation.filter((state) => Number(state.stats?.populationWave || 0) === latestWave);
    const levelTotal = playing.reduce((sum, state) => sum + Math.max(1, number(state.level, 1)), 0);
    const spots = playing.reduce((counts, state) => {
        if (!state.spotId) return counts;
        counts[state.spotId] = number(counts[state.spotId]) + 1;
        return counts;
    }, {});

    return {
        playing: playing.length,
        playingPopulation: playingPopulation.length,
        averageLevel: playing.length ? levelTotal / playing.length : 0,
        population: population.length,
        latestWave,
        latestCohortAverageLevel: latestCohort.length
            ? latestCohort.reduce((sum, state) => sum + Math.max(1, number(state.level, 1)), 0) / latestCohort.length
            : 0,
        populationByStarterRegion,
        hasRegionalPopulation: Object.keys(populationByStarterRegion).length > 0,
        spots,
        hasPopulationSeed: population.length > 0
    };
}

function waveLevelThreshold(multiplier = ProgressionRates.profile().multiplier) {
    return number(multiplier, 1) >= 50 ? 10 : 5;
}

function nextWave(snapshot = {}, levelThreshold = waveLevelThreshold()) {
    if (!snapshot.hasPopulationSeed) return 1;
    // Advance exactly one cohort at a time. Legacy/static bots must neither
    // suppress the first wave nor jump several waves on server restart.
    return snapshot.latestCohortAverageLevel >= levelThreshold
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

function plan(profiles = [], states = [], maxPopulation = 1700, botsPerRace = 30, options = {}) {
    const current = snapshot(states);
    const limit = Math.max(0, number(maxPopulation));
    const levelThreshold = waveLevelThreshold(options.progressionMultiplier);
    const wave = nextWave(current, levelThreshold);
    const eligible = eligibleSpots(profiles, 1);
    const available = Math.max(0, limit - current.population);
    const plannedSlots = starterSlots(eligible, botsPerRace, wave);
    const targetPopulation = Math.min(limit, STARTER_REGIONS.length * Math.max(0, number(botsPerRace, 30)) * wave);
    // Static merchant and craft services are outside the generated-population
    // cap, and do not replace the requested 30-per-race starter cohort.
    const regionalTargets = regionalTargetCounts(targetPopulation);
    const regionalMissing = STARTER_REGIONS.reduce((counts, region) => ({
        ...counts,
        [region.id]: Math.max(0, number(regionalTargets[region.id]) - number(current.populationByStarterRegion[region.id]))
    }), {});
    const newBotsNeeded = current.hasRegionalPopulation
        ? Object.values(regionalMissing).reduce((sum, count) => sum + number(count), 0)
        : Math.max(0, targetPopulation - current.population);
    const occupied = { ...current.spots };
    const missing = plannedSlots
        .filter((spot) => {
            if (current.hasRegionalPopulation && number(regionalMissing[spot.starterRegion]) <= 0) return false;
            const count = number(occupied[spot.id]);
            occupied[spot.id] = count + 1;
            const available = count < plannedSlots.filter((candidate) => candidate.id === spot.id).length;
            if (available && current.hasRegionalPopulation) regionalMissing[spot.starterRegion] -= 1;
            return available;
        })
        .slice(0, Math.min(available, newBotsNeeded));

    return {
        ...current,
        maxPopulation: limit,
        levelThreshold,
        wave,
        targetPopulation,
        newBotsNeeded,
        regionalTargets,
        regionalMissing,
        eligible,
        plannedSlots,
        missing
    };
}

module.exports = {
    isPlaying,
    snapshot,
    STARTER_REGIONS,
    waveLevelThreshold,
    nextWave,
    eligibleSpots,
    starterSlots,
    seedBatchSize,
    plan
};
