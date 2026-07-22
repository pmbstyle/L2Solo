function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function isPlaying(state = {}) {
    return !['merchant', 'crafting'].includes(state.activity);
}

function snapshot(states = []) {
    const playing = states.filter(isPlaying);
    const levelTotal = playing.reduce((sum, state) => sum + Math.max(1, number(state.level, 1)), 0);
    const spots = playing.reduce((counts, state) => {
        if (!state.spotId) return counts;
        counts[state.spotId] = number(counts[state.spotId]) + 1;
        return counts;
    }, {});

    return {
        playing: playing.length,
        averageLevel: playing.length ? levelTotal / playing.length : 0,
        spots,
        hasPopulationSeed: playing.some((state) => !!state.stats?.populationWave)
    };
}

function unlockedMobLevel(averageLevel) {
    const average = Math.max(0, number(averageLevel));
    // The first wave is deliberately only the genuine level-one grounds.
    // Afterwards every five average levels opens the next five-level band.
    return average < 5 ? 1 : (Math.floor(average / 5) * 5) + 1;
}

function eligibleSpots(profiles = [], maxMobLevel = 1) {
    return profiles
        .filter((spot) => number(spot.minLevel, 0) >= 1 && number(spot.minLevel, 0) <= maxMobLevel)
        .sort((left, right) => number(left.minLevel, 0) - number(right.minLevel, 0)
            || number(left.avgLevel, 0) - number(right.avgLevel, 0)
            || String(left.id).localeCompare(String(right.id)));
}

function desiredSlots(spots = [], starterPopulation = 65) {
    const starters = spots.filter((spot) => number(spot.minLevel, 0) === 1);
    const starterTarget = Math.max(starters.length, number(starterPopulation, 65));
    const starterCopies = starters.reduce((copies, spot, index) => {
        const base = Math.floor(starterTarget / starters.length);
        const extra = index < starterTarget % starters.length ? 1 : 0;
        copies[spot.id] = base + extra;
        return copies;
    }, {});

    return spots.flatMap((spot) => Array.from({ length: starterCopies[spot.id] || 1 }, () => spot));
}

function seedBatchSize(plan = {}, configuredBatch = 1) {
    const normalBatch = Math.max(1, number(configuredBatch, 1));
    // A fresh world must receive every starter slot together. Subsequent
    // expansions remain bounded by the normal database-safe batch size.
    return plan.hasPopulationSeed ? normalBatch : Math.max(normalBatch, Number(plan.missing?.length || 0));
}

function plan(profiles = [], states = [], maxPopulation = 1700, starterPopulation = 65) {
    const current = snapshot(states);
    const limit = Math.max(0, number(maxPopulation));
    // Existing hand-authored or legacy bots must not make a brand-new world
    // skip its starter wave. Once that wave exists, average level governs
    // every following expansion.
    const maxMobLevel = current.hasPopulationSeed ? unlockedMobLevel(current.averageLevel) : 1;
    const eligible = eligibleSpots(profiles, maxMobLevel);
    const available = Math.max(0, limit - current.playing);
    const plannedSlots = desiredSlots(eligible, starterPopulation);
    const occupied = { ...current.spots };
    const missing = plannedSlots
        .filter((spot) => {
            const count = number(occupied[spot.id]);
            occupied[spot.id] = count + 1;
            return count < plannedSlots.filter((candidate) => candidate.id === spot.id).length;
        })
        .slice(0, available);

    return {
        ...current,
        maxPopulation: limit,
        maxMobLevel,
        eligible,
        plannedSlots,
        missing
    };
}

module.exports = {
    isPlaying,
    snapshot,
    unlockedMobLevel,
    eligibleSpots,
    desiredSlots,
    seedBatchSize,
    plan
};
