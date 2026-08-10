const SpotService = invoke('GameServer/Bot/AI/SpotService');
const LevelingRoutes = invoke('GameServer/Bot/AI/LevelingRoutes');
const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const BotLifeState = invoke('GameServer/Bot/Population/BotLifeState');

let occupancyCache = null;
let occupancyCachedAt = 0;

function rewardForLevel(level) {
    const value = Math.max(1, Number(level || 1));
    return {
        exp: Math.round(value * 13),
        sp: Math.round(value * 2.2),
        adenaMin: Math.round(value * 2),
        adenaMax: Math.round(value * 7)
    };
}

function combatForLevel(level) {
    const value = Math.max(1, Number(level || 1));
    return {
        hp: Math.round(60 + value * 42),
        damage: Math.round(4 + value * 2.8),
        hitDelayMs: 1600
    };
}

function profileFromSpot(spot) {
    const avgLevel = Math.max(1, Math.round(spot.avgLevel || spot.minLevel || 1));

    return {
        id: spot.id,
        name: spot.name,
        center: { ...spot.center },
        minLevel: spot.minLevel,
        maxLevel: spot.maxLevel,
        avgLevel,
        density: spot.density,
        npcNames: [...(spot.npcNames || [])],
        npcSelfIds: [...(spot.npcSelfIds || [])],
        npcEntries: (spot.npcEntries || []).map((entry) => ({ ...entry })),
        arrivalPoints: (spot.arrivalPoints || []).map((point) => ({ ...point })),
        levelCounts: { ...(spot.levelCounts || {}) },
        dominantLevels: (spot.dominantLevels || []).map((entry) => ({ ...entry })),
        area: spot.area ? { ...spot.area } : null,
        tags: [...(spot.tags || [])],
        tagsAuthoritative: spot.tagsAuthoritative === true,
        capacity: Number(spot.capacity || 0) || null,
        localStarterRegions: [...(spot.localStarterRegions || [])],
        localUntilLevel: Number(spot.localUntilLevel || 0) || null,
        route: spot.route || null,
        rewards: rewardForLevel(avgLevel),
        mob: combatForLevel(avgLevel),
        risk: Math.max(0, avgLevel - spot.minLevel) + Math.max(0, 5 - Math.min(5, spot.density))
    };
}

function isProtectedStarterCohort(state) {
    return Number(state?.level || 1) < 5
        && Number(state?.stats?.populationWave || 0) > 0
        && !!state?.stats?.starterRegion;
}

function physicalSpotForState(state, profiles) {
    const loc = state?.loc;
    if (loc && Number.isFinite(Number(loc.locX)) && Number.isFinite(Number(loc.locY))) {
        const physical = SpotService.findCurrentSpot(loc);
        if (physical) return profiles.find((profile) => profile.id === physical.id) || physical;
    }
    return state?.spotId ? profiles.find((profile) => profile.id === state.spotId) || null : null;
}

function stateKey(state = {}) {
    return String(state.characterId || state.name || state.stats?.generatedIndex || '');
}

function partyIdForState(state = {}) {
    return state.party?.partyId || state.partyId || null;
}

function occupiedSpotId(state = {}) {
    if (state.activity === 'traveling' && state.stats?.travel?.spotId) return state.stats.travel.spotId;
    if (['merchant', 'shopping', 'crafting', 'traveling'].includes(state.activity)) return null;
    return state.spotId || null;
}

function occupancySnapshot(profiles, states = BotLifeState.allStates(2000)) {
    const byId = new Map((profiles || []).map((profile) => [profile.id, profile]));
    const members = (states || []).reduce((entries, state) => {
        const spotId = occupiedSpotId(state);
        if (!spotId || !byId.has(spotId)) return entries;
        if (!entries[spotId]) entries[spotId] = [];
        entries[spotId].push(state);
        return entries;
    }, {});

    return Object.fromEntries(Object.entries(members).map(([spotId, spotMembers]) => {
        const capacity = LevelingRoutes.capacityForSpot(byId.get(spotId));
        const grouped = spotMembers.filter((state) => partyIdForState(state));
        const solo = spotMembers
            .filter((state) => !partyIdForState(state))
            .sort((left, right) => stateKey(left).localeCompare(stateKey(right)));
        const parties = [...grouped.reduce((byParty, state) => {
            const partyId = String(partyIdForState(state));
            if (!byParty.has(partyId)) byParty.set(partyId, []);
            byParty.get(partyId).push(state);
            return byParty;
        }, new Map()).entries()]
            .sort(([leftId], [rightId]) => leftId.localeCompare(rightId));
        const retained = new Set();
        let remaining = capacity;
        parties.forEach(([, partyMembers]) => {
            if (partyMembers.length > remaining) return;
            partyMembers.forEach((state) => retained.add(stateKey(state)));
            remaining -= partyMembers.length;
        });
        solo.slice(0, Math.max(0, remaining)).forEach((state) => retained.add(stateKey(state)));
        return [spotId, { count: spotMembers.length, capacity, retained }];
    }));
}

function currentOccupancy(profiles, maxAgeMs = 1000) {
    const timestamp = Date.now();
    if (occupancyCache && timestamp - occupancyCachedAt < maxAgeMs) return occupancyCache;
    occupancyCache = occupancySnapshot(profiles);
    occupancyCachedAt = timestamp;
    return occupancyCache;
}

function shouldLeaveOverCapacity(state, spot, occupancy) {
    const entry = occupancy?.[spot?.id];
    const count = LevelingRoutes.occupancyForSpot(occupancy, spot?.id);
    const capacity = Number(entry?.capacity || LevelingRoutes.capacityForSpot(spot));
    if (!spot || count <= capacity) return false;
    if (entry?.retained instanceof Set) return !entry.retained.has(stateKey(state));
    return true;
}

const SpotProfiles = {
    cache: null,

    isProtectedStarterCohort,

    reset() {
        this.cache = null;
        occupancyCache = null;
        occupancyCachedAt = 0;
    },

    ensure() {
        if (this.cache) return this.cache;
        this.cache = SpotService.ensureIndexed().map(profileFromSpot);
        return this.cache;
    },

    findById(id) {
        return this.ensure().find((profile) => profile.id === id) || null;
    },

    findForState(state, options = {}) {
        const acquisitionPlan = state?.stats?.equipmentPlan;
        const protectedStarterCohort = isProtectedStarterCohort(state);
        const profiles = this.ensure();
        const physicalSpot = physicalSpotForState(state, profiles);
        const savedSpot = state?.spotId ? this.findById(state.spotId) : null;
        const currentSpot = physicalSpot || savedSpot;
        const targetLevel = LevelingRoutes.targetLevelForState(state);
        const occupancy = options.occupancy || currentOccupancy(profiles);
        const routeOptions = { ...options, occupancy };
        const currentMatch = currentSpot ? LevelingRoutes.scoreSpot(currentSpot, state, routeOptions) : null;
        const mustRelocate = currentSpot && (currentMatch.localityPenalty > 0
            || shouldLeaveOverCapacity(state, currentSpot, occupancy));
        const keepCurrentSpot = currentSpot && (!acquisitionPlan || protectedStarterCohort)
            && !mustRelocate
            && (protectedStarterCohort || SpotService.isSuitable(currentSpot, targetLevel, options));

        // Fresh racial cohorts stay at their physical level-one spot until
        // they advance. A gear plan otherwise remains the normal route choice
        // for established bots.
        if (keepCurrentSpot) {
            return LevelingRoutes.decorateSpot(currentSpot, currentMatch);
        }

        if (acquisitionPlan?.status === 'active') {
            const planned = this.ensure()
                .map((spot) => ({ spot, score: GearAcquisitionPlanner.scoreSpot(spot, acquisitionPlan) }))
                .filter((candidate) => candidate.score > 0)
                .sort((a, b) => b.score - a.score)[0];
            if (planned) return planned.spot;
        }

        if (currentSpot && !mustRelocate && SpotService.isSuitable(currentSpot, targetLevel, options)) {
            return LevelingRoutes.decorateSpot(currentSpot, currentMatch);
        }

        const candidates = profiles
            .filter((profile) => profile.minLevel <= targetLevel + 4 && profile.maxLevel >= targetLevel - 4);
        const relocationCandidates = mustRelocate
            ? candidates.filter((profile) => profile.id !== currentSpot.id)
            : candidates;
        const routeCandidates = relocationCandidates.length ? relocationCandidates : candidates;
        const suitable = routeCandidates.filter((profile) => SpotService.isSuitable(profile, targetLevel, options));
        const guided = LevelingRoutes.bestSpot(suitable.length ? suitable : routeCandidates, state, routeOptions);

        if (guided?.spot) return guided.spot;

        return (suitable.length ? suitable : routeCandidates).sort((a, b) => {
            const aGap = Math.abs(a.avgLevel - targetLevel);
            const bGap = Math.abs(b.avgLevel - targetLevel);
            if (aGap !== bGap) return aGap - bGap;
            return b.density - a.density;
        })[0] || null;
    }
};

SpotProfiles.occupancySnapshot = occupancySnapshot;
SpotProfiles.currentOccupancy = currentOccupancy;
SpotProfiles.shouldLeaveOverCapacity = shouldLeaveOverCapacity;

module.exports = SpotProfiles;
