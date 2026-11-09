const SpotService = invoke('GameServer/Bot/AI/SpotService');
const LevelingRoutes = invoke('GameServer/Bot/AI/LevelingRoutes');
const SpotIndex = invoke('GameServer/Bot/AI/SpotIndex');
const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const BotLifeState = invoke('GameServer/Bot/Population/BotLifeState');
const SpotRiskPolicy = invoke('GameServer/Bot/Population/SpotRiskPolicy');
const SpotSearch = invoke('GameServer/Bot/AI/SpotSearch');
const { huntersOn } = require('./SpotOccupancyIndex');

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
        spawnArea: Number(spot.spawnArea) || null,
        // The cell pieces the spot covers (SpotIndex.piecesOf, T123).
        floor: spot.floor ? { ...spot.floor } : null,
        joins: spot.joins ? spot.joins.map((piece) => ({ ...piece })) : null,
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

// `catalogOnly`: the caller has no live world (the cold worker); the cell is
// looked up in the profiles, which carry the same ids.
function physicalSpotForState(state, profiles, catalogOnly = false) {
    const loc = state?.loc;
    if (loc && Number.isFinite(Number(loc.locX)) && Number.isFinite(Number(loc.locY))) {
        const physical = SpotService.findCurrentSpot(loc, catalogOnly ? profiles : null);
        if (physical) return SpotIndex.spotById(profiles, physical.id) || physical;
    }
    return state?.spotId ? SpotIndex.spotById(profiles, state.spotId) : null;
}

// Level bounds are cheap and independent of the detailed route policy:
// out-of-range spots are rejected before deriving their tags. The window of
// one target level is the same for every search of one catalog. Near: the
// spot's level mix (SpotService.levelMix, T123) meets the level +- 4, so a
// few high spawns among a field of low ones do not make it near.
const spotsNearLevelByCatalog = new WeakMap();
// Catalogue-owned references, at most 80 level arrays; collecting/resetting a
// catalogue releases its lists. No bot, state or matchup is retained here.
const lowerSpotsByCatalog = new WeakMap();

function lowerSpots(profiles, targetLevel) {
    let byLevel = lowerSpotsByCatalog.get(profiles);
    if (!byLevel) lowerSpotsByCatalog.set(profiles, byLevel = new Map());
    let spots = byLevel.get(targetLevel);
    if (!spots) {
        // Below the near window by the same level mix (spotsNearLevel).
        spots = profiles.filter(profile => profile.raidBoss !== true && SpotService.levelMix(profile).high < targetLevel - 4);
        byLevel.set(targetLevel, spots);
        if (byLevel.size > 80) byLevel.delete(byLevel.keys().next().value);
    }
    return spots;
}

function spotsNearLevel(profiles, targetLevel) {
    let byLevel = spotsNearLevelByCatalog.get(profiles);
    if (!byLevel) spotsNearLevelByCatalog.set(profiles, byLevel = new Map());
    let spots = byLevel.get(targetLevel);
    if (!spots) {
        spots = profiles.filter((profile) => {
            if (profile.raidBoss === true) return false;
            const mix = SpotService.levelMix(profile);
            return mix.low <= targetLevel + 4 && mix.high >= targetLevel - 4;
        });
        byLevel.set(targetLevel, spots);
    }
    return spots;
}

// The occupancy index of this thread: main's world index; a cold worker
// registers its kernel's once at its start (ColdSimulationWorker.startKernel),
// read at each count, so no reader keeps a replaced kernel's.
const mainOccupancy = () => BotLifeState.occupancyIndex();
let threadOccupancy = mainOccupancy;
function useOccupancy(read) {
    threadOccupancy = read || mainOccupancy;
}

// The bots on a spot for its kill share (E69) and a spot value's crowd share
// (SpotEconomics), in this thread's occupancy (SpotOccupancyIndex.huntersOn),
// as ColdSimulationKernel.spotHunters; with a state, that bot counted once.
function spotHunters(spot, state = null) {
    return huntersOn(threadOccupancy(), spot?.id, state);
}

// How many bots a spot holds (LevelingRoutes.roomForSpot); a raid boss spot
// or a spot the catalog does not know: no limit. The worker's arrival check
// and the status mirror read this one rule; no search does (the crowd is met
// at arrival).
function spotRoom(spots, spotId) {
    const spot = SpotIndex.spotById(spots, spotId);
    return !spot || spot.raidBoss === true ? Infinity : LevelingRoutes.roomForSpot(spot);
}

// A solo fallback search must not become a travel loop between comparable
// camps: the bot keeps its current camp when it is one of the candidates.
const SpotProfiles = {
    cache: null,

    isProtectedStarterCohort,

    reset() {
        this.cache = null;
    },

    ensure() {
        if (this.cache) return this.cache;
        this.cache = [
            ...SpotService.ensureIndexed().map(profileFromSpot),
            ...invoke('GameServer/RaidBoss/RaidBossSourceCatalog').all()
        ];
        return this.cache;
    },

    findById(id) {
        return SpotIndex.spotById(this.ensure(), id);
    },

    // The leveling search (SpotSearch.leveling, the one search's goal for a bot no held answer routes) over
    // the catalogue: options.profiles for a caller without the live world (the cold worker), else ensure().
    // A solo bot's search is that goal alone (its plan's source and its held answer are BotRoute.huntSpot's);
    // a party's or duo's ground first takes its plan's source, then the same goal without the habit.
    findForState(state, options = {}) {
        const timestamp = Number(options.timestamp || Date.now());
        if (GearAcquisitionPlanner.levelingRecoveryFor(state, state?.stats?.equipmentPlan, timestamp)) {
            state = { ...state, stats: { ...(state.stats || {}), equipmentPlan: null } };
        }
        const profiles = options.profiles || this.ensure();
        const currentSpot = physicalSpotForState(state, profiles, !!options.profiles);
        const excludedSpotIds = new Set([
            ...(options.mode === 'party' ? [] : SpotRiskPolicy.excludedSpotIdsForStates([state], timestamp)),
            ...((options.excludedSpotIds instanceof Set || Array.isArray(options.excludedSpotIds))
                ? [...options.excludedSpotIds].map(String)
                : [])
        ]);
        const mode = LevelingRoutes.modeForState(state, options);
        const routeOptions = { ...options, profiles, currentSpot, excludedSpotIds,
            spotEconomics: options.spotEconomics || invoke('GameServer/Bot/Economy/SpotEconomics').create(state,
                { timestamp, mode, members: options.capacityStates }),
            matchupProfiles: invoke('GameServer/Bot/AI/BotTargetMatchup').stateProfiles(state, { ...options, mode }) };
        const plan = state?.stats?.equipmentPlan;
        if (['party', 'duo'].includes(mode) && plan?.status === 'active') {
            const targetLevel = LevelingRoutes.targetLevelForState(state, options);
            const ground = LevelingRoutes.spotAllowedReaderFor(state, routeOptions);
            const plannedAllowed = planned => !!planned && !excludedSpotIds.has(String(planned.id)) && ground(planned)
                && (!currentSpot || !Number.isFinite(Number(planned.minLevel)) || !Number.isFinite(Number(planned.maxLevel))
                    || SpotService.isSuitable(planned, targetLevel, options)
                    || invoke('GameServer/Bot/Economy/EquipmentIncomeRoute').economicHunt(state)
                        && Number(planned.avgLevel || planned.minLevel || 1) - state.level >= -15);
            // A gear objective may have several valid drop sources: the first allowed one, else the persisted route.
            const source = GearAcquisitionPlanner.bestSourceForPlan(state, plan, profiles,
                { excludedSpotIds, timestamp, mode, matchupProfiles: routeOptions.matchupProfiles,
                    sourceAllowed: candidate => plannedAllowed(SpotIndex.spotById(profiles, candidate.spotId)),
                    allowRaidSources: plan.next?.sourceKind === 'raid' && GearAcquisitionPlanner.isClanOwnedPlan(plan) });
            const planned = SpotIndex.spotById(profiles, source ? source.spotId : plan.next?.spotId);
            if (plannedAllowed(planned)) return planned;
        }
        return SpotSearch.leveling(state, routeOptions);
    }
};

SpotProfiles.spotHunters = spotHunters;
SpotProfiles.useOccupancy = useOccupancy;
SpotProfiles.spotsNearLevel = spotsNearLevel;
SpotProfiles.lowerSpots = lowerSpots;
SpotProfiles.spotRoom = spotRoom;

module.exports = SpotProfiles;
// A getter also sees replaced period catalogs and manually hydrated profiles;
// table forecasts never call ensure() or import a live World from a worker.
const EMPTY_REWARD_SPOTS = [];
invoke('GameServer/Bot/AI/SpotValueTable').useSpots(() => SpotProfiles.cache || EMPTY_REWARD_SPOTS);
