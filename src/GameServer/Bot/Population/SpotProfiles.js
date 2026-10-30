const SpotService = invoke('GameServer/Bot/AI/SpotService');
const LevelingRoutes = invoke('GameServer/Bot/AI/LevelingRoutes');
const SpotIndex = invoke('GameServer/Bot/AI/SpotIndex');
const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const EquipmentIncomeRoute = invoke('GameServer/Bot/Economy/EquipmentIncomeRoute');
const BotLifeState = invoke('GameServer/Bot/Population/BotLifeState');
const SpotRiskPolicy = invoke('GameServer/Bot/Population/SpotRiskPolicy');
const Diagnostics = require('../Economy/EconomyDiagnostics');
const { stateKey, huntersOn } = require('./SpotOccupancyIndex');
const { isMainThread } = require('node:worker_threads');

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

function explicitClanRaidSpot(state = {}, profile = null) {
    if (profile?.raidBoss !== true) return false;
    const spotId = String(profile.id || '');
    const objective = state.stats?.clanPartyObjective;
    if (objective?.sourceKind === 'raid'
        && objective?.clanOperation === 'equipment'
        && String(objective.spotId || '') === spotId) return true;
    const plan = state.stats?.equipmentPlan;
    return plan?.next?.sourceKind === 'raid'
        && GearAcquisitionPlanner.isClanOwnedPlan(plan)
        && String(plan.next?.spotId || '') === spotId;
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
// and the route search's room filter below read this one rule.
function spotRoom(spots, spotId) {
    const spot = SpotIndex.spotById(spots, spotId);
    return !spot || spot.raidBoss === true ? Infinity : LevelingRoutes.roomForSpot(spot);
}

// The room filter of a route (ROUTE-ROOM): a spot has room for the routed
// bots (members: [state] for a solo bot, the whole party for a party) when
// every bot `index` has there, those on their way included, other than these
// bots, plus all of them fit; re-checked at arrival. A party's own members are
// not counted against it. index: the worker's own (kernel.occupancy) or main's
// world index (BotLifeState.occupancyIndex()), the one of the thread that plans.
function roomFilterFor(index, spots, members) {
    const own = new Set(members.map(stateKey));
    return (spotId) => index.physicalCount(spotId, { excludeKeys: own }) + members.length <= spotRoom(spots, spotId);
}

// The room filter a search takes when its caller passes none: a search on
// main reads main's world index (ROUTE-ROOM-4) for the routed bots (members:
// the search's capacityStates, else the bot alone); the worker always passes
// its own (null here).
function defaultRoomFilter(state, spots, members = null) {
    return isMainThread
        ? roomFilterFor(BotLifeState.occupancyIndex(), spots, members?.length ? members : [state]) : null;
}

// A solo fallback search must not become a travel loop between comparable
// camps: the bot keeps its current camp when it is one of the candidates.
function currentSpotAmong(candidates, currentSpot, mustRelocate) {
    if (!currentSpot || mustRelocate) return false;
    return candidates.some((profile) => profile.id === currentSpot.id);
}

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

    // options.profiles: the spot catalogue to search instead of ensure(), for
    // callers without the live world (the cold worker).
    findForState(state, options = {}) {
        const timestamp = Number(options.timestamp || Date.now());
        if (GearAcquisitionPlanner.levelingRecoveryFor(state, state?.stats?.equipmentPlan, timestamp)) {
            state = { ...state, stats: { ...(state.stats || {}), equipmentPlan: null } };
        }
        const acquisitionPlan = state?.stats?.equipmentPlan;
        const protectedStarterCohort = isProtectedStarterCohort(state);
        const profiles = options.profiles || this.ensure();
        const physicalSpot = physicalSpotForState(state, profiles, !!options.profiles);
        const savedSpot = state?.spotId ? SpotIndex.spotById(profiles, state.spotId) : null;
        const currentSpot = physicalSpot || savedSpot;
        const targetLevel = LevelingRoutes.targetLevelForState(state, options);
        const excludedSpotIds = new Set([
            ...(options.mode === 'party' ? [] : SpotRiskPolicy.excludedSpotIdsForStates([state], timestamp)),
            ...((options.excludedSpotIds instanceof Set || Array.isArray(options.excludedSpotIds))
                ? [...options.excludedSpotIds].map(String)
                : [])
        ]);
        const TargetMatchup = invoke('GameServer/Bot/AI/BotTargetMatchup');
        const mode = LevelingRoutes.modeForState(state, options);
        const routeOptions = { ...options, excludedSpotIds,
            spotEconomics: options.spotEconomics || invoke('GameServer/Bot/Economy/SpotEconomics').create(state,
                { timestamp, mode, members: options.capacityStates, ...(options.spotHunters ? { spotHunters: options.spotHunters } : {}) }),
            matchupProfiles: TargetMatchup.stateProfiles(state, { ...options, mode }) };
        const currentMatch = currentSpot ? LevelingRoutes.scoreSpot(currentSpot, state, routeOptions) : null;
        // A starter field outside the bot's region (locality penalty) asks
        // for a move only when a field without that penalty can take the bot:
        // allowed, near its level. A kit that survives no home
        // field yet (an orc mystic on fists before its first spell) would
        // otherwise be sent to another penalised field on every resolve and
        // never hunt. Checked only for the few young bots on foreign ground.
        // One reader per spot loop: profiles and safety are read once (L131).
        const homeAllowed = LevelingRoutes.spotAllowedReaderFor(state, routeOptions);
        const foreign = (profile) => LevelingRoutes.localityPenaltyForSpot(profile, state, { level: targetLevel },
            LevelingRoutes.tagsForSpot(profile)) > 0;
        const localityRelocate = currentSpot && currentMatch.localityPenalty > 0
            && spotsNearLevel(profiles, targetLevel).some((profile) => profile.id !== currentSpot.id
                && !excludedSpotIds.has(String(profile.id))
                && !foreign(profile)
                && homeAllowed(profile));
        const mustRelocate = currentSpot && (localityRelocate
            || (currentSpot.raidBoss === true && !explicitClanRaidSpot(state, currentSpot))
            || currentMatch.targetMatchup?.eligible === false
            || currentMatch.huntingGround?.allowed === false
            || excludedSpotIds.has(String(currentSpot.id)));
        const keepCurrentSpot = currentSpot && (!acquisitionPlan || protectedStarterCohort)
            && !mustRelocate
            && (protectedStarterCohort || SpotService.isSuitable(currentSpot, targetLevel, options));

        // Fresh racial cohorts stay at their physical level-one spot until
        // they advance. A gear plan otherwise remains the normal route choice
        // for established bots.
        const collectingGear = acquisitionPlan?.status === 'active' && acquisitionPlan.next?.spotId;
        // One list object for the income route and the list walk below: its
        // spoiler and costs are read once, and only when one of them asks.
        const list = EquipmentIncomeRoute.spotList(state);
        // hasRoom(spotId): a filter on every spot this search returns other
        // than the current one (ROUTE-ROOM, ROUTE-ROOM-2): the income route's
        // spot, the planned source, the list walk and the near-level
        // fallback; a refused candidate counts as absent. A bot's own spot is
        // never full to it; the room is checked again at arrival. The worker
        // passes its own index's filter (options.hasRoom); a search on main
        // (market return, competition retreat, a command's trip, a party's
        // formation) reads main's world index (ROUTE-ROOM-4). A party search
        // counts the whole party (options.capacityStates), its own members
        // excluded.
        const hasRoom = options.hasRoom ?? defaultRoomFilter(state, profiles, options.capacityStates);
        const full = (spot) => {
            if (!hasRoom || (currentSpot && spot.id === currentSpot.id)
                || hasRoom(spot.id)) return false;
            Diagnostics.count('spot_list', 'skip', 'full');
            return true;
        };
        if (!protectedStarterCohort && !collectingGear) {
            const incomeRoute = EquipmentIncomeRoute.select(state, {
                spots: profiles, timestamp, mode, list,
                required: invoke('GameServer/Bot/AI/PersonalGearProgression').assess(state).required });
            // The route reads its own risk marks, not the caller's exclusions
            // (a market return's full saved spot, ROUTE-ROOM-4): an excluded
            // pick counts as absent, as on the list walk.
            if (incomeRoute && !excludedSpotIds.has(String(incomeRoute.spot.id)) && !full(incomeRoute.spot)) {
                return incomeRoute.spot;
            }
        }

        if (keepCurrentSpot) {
            return LevelingRoutes.decorateSpot(currentSpot, currentMatch);
        }

        if (acquisitionPlan?.status === 'active') {
            // A gear objective may have several valid drop sources: the first
            // allowed one, else the persisted route.
            const plannedSource = GearAcquisitionPlanner.bestSourceForPlan(
                state,
                acquisitionPlan,
                profiles,
                { excludedSpotIds,
                    allowRaidSources: acquisitionPlan.next?.sourceKind === 'raid'
                        && GearAcquisitionPlanner.isClanOwnedPlan(acquisitionPlan) }
            );
            const planned = SpotIndex.spotById(profiles, plannedSource ? plannedSource.spotId : acquisitionPlan.next?.spotId);
            if (planned && !excludedSpotIds.has(String(planned.id)) && !full(planned)
                && LevelingRoutes.isSpotAllowedForState(planned, state, routeOptions)) {
                // A drop source may be valid for the item but still be a
                // starter-level camp for the bot. Never let an active gear
                // plan pin an outleveled bot to that source indefinitely.
                const hasLevelBounds = Number.isFinite(Number(planned.minLevel))
                    && Number.isFinite(Number(planned.maxLevel));
                const economicSource = EquipmentIncomeRoute.economicHunt(state)
                    && Number(planned.avgLevel || planned.minLevel || 1) - state.level >= -15;
                if (!currentSpot || !hasLevelBounds || SpotService.isSuitable(planned, targetLevel, options) || economicSource) {
                    return planned;
                }
            }
        }

        if (currentSpot && !mustRelocate && SpotService.isSuitable(currentSpot, targetLevel, options)) {
            return LevelingRoutes.decorateSpot(currentSpot, currentMatch);
        }

        const soloSearch = !['party', 'duo'].includes(mode);
        const withRoute = (spot) => LevelingRoutes.decorateSpot(spot, LevelingRoutes.routeMatchFor(spot, state, routeOptions));
        // The game table's spot list for the bot's role and level (ARCH-08-b):
        // best income first, ties to the closest level. The first spot that
        // is not avoided, its ground and matchup allow and whose level fits
        // wins, else the first allowed one; the list with shots, then the
        // list without them when no spot of the first is allowed.
        // Deviation from the task text (a party list): a party or duo search
        // reads its leader's list (its party role when it has one, the
        // simplest reading); a list for the party's main role would be read
        // once per party search.
        let pick = null, firstAllowed = null, currentListed = false;
        for (const shots of [true, false]) {
            for (const id of list.ids(shots, targetLevel)) {
                const spot = SpotIndex.spotById(profiles, id);
                // A foreign starter field is no list pick: the locality rule
                // above would send the bot away from it again.
                if (!spot || spot.raidBoss === true || excludedSpotIds.has(String(spot.id)) || foreign(spot)) continue;
                const isCurrent = currentSpot && spot.id === currentSpot.id;
                if (isCurrent && mustRelocate) continue;
                if (full(spot)) continue;
                const fits = SpotService.isSuitable(spot, targetLevel, options);
                if (!fits && firstAllowed && !isCurrent) continue;
                // The keep rule below holds only a current spot this reader
                // allows: the current match reads the ground at the target
                // level, which a recovery lowers below the bot's own.
                if (!homeAllowed(spot)) continue;
                if (isCurrent) currentListed = true;
                if (fits) { pick = spot; break; }
                firstAllowed ||= spot;
            }
            if (pick || firstAllowed) break;
        }
        // Without a suitable camp a solo bot keeps its current one when the
        // list holds it: comparable camps must not become a travel loop.
        if (!pick && firstAllowed && soloSearch && currentListed) {
            Diagnostics.count('spot_list', 'pick', 'current');
            return LevelingRoutes.decorateSpot(currentSpot, currentMatch);
        }
        if (pick || firstAllowed) {
            Diagnostics.count('spot_list', 'pick', pick ? 'suitable' : 'allowed');
            return withRoute(pick || firstAllowed);
        }

        // No allowed spot on the list (a catalogue spot the table does not
        // rank, e.g. one without income): the allowed ground near the level,
        // a field of the bot's own region first, then the closest level.
        // Deviation from the task text (recovery and level-gap fallback
        // only): this near-level step comes first, so a spot the table does
        // not rank is not mistaken for no ground at all. If bots still end
        // without a spot, the simplest option is the list again with the
        // income route's wider minGap (-15).
        const candidates = spotsNearLevel(profiles, targetLevel)
            .filter((profile) => !excludedSpotIds.has(String(profile.id))
                && !full(profile))
            .filter((profile) => homeAllowed(profile));
        const relocationCandidates = mustRelocate
            ? candidates.filter((profile) => profile.id !== currentSpot.id)
            : candidates;
        let routeCandidates = relocationCandidates.length ? relocationCandidates : candidates;
        let suitable = routeCandidates.filter((profile) => SpotService.isSuitable(profile, targetLevel, options));
        // Without a suitable camp a solo bot hunts allowed ground near its
        // level: like the easier-ground fallback below, it keeps its current camp.
        if (soloSearch && !suitable.length && currentSpotAmong(routeCandidates, currentSpot, mustRelocate)) {
            Diagnostics.count('spot_list', 'pick', 'current');
            return LevelingRoutes.decorateSpot(currentSpot, currentMatch);
        }
        // A weak kit can make every camp near the character's level unsafe.
        // Search easier ground using the same combat checks;
        // otherwise a perfectly healthy bot repeats missing_spot forever.
        if (!routeCandidates.length && soloSearch) {
            const recoveryState = { ...state, stats: { ...state.stats, equipmentPlan: null } };
            const spotValue = routeOptions.spotEconomics;
            const maybeSurvives = TargetMatchup.soloSpotUpperBound(routeOptions.matchupProfiles);
            const lower = lowerSpots(profiles, targetLevel)
                .filter(profile => !excludedSpotIds.has(String(profile.id))
                    && maybeSurvives(profile))
                .map(profile => ({ profile, value: spotValue(profile)?.valueHours ?? -Infinity }))
                // Value first, ties as the near-level fallback: closest level, then density.
                .sort((a, b) => b.value - a.value
                    || Math.abs(a.profile.avgLevel - targetLevel) - Math.abs(b.profile.avgLevel - targetLevel)
                    || b.profile.density - a.profile.density
                    || String(a.profile.id).localeCompare(String(b.profile.id)));
            routeCandidates = [];
            const recoveryAllowed = LevelingRoutes.spotAllowedReaderFor(recoveryState, routeOptions);
            // ARCH-NOTE: ALT optimistic damage prefilter preserves exact-safe
            // camps: naked L50 catalogue fixture finds 100% of best safe income
            // with 8 exact probes (default 128 found none). Same-catalogue first
            // search 65.9 -> 22.1 ms; warm 1.77 -> 2.38 ms. Shared gate unchanged.
            // The first allowed one in this order is the pick (ARCH-08-b: no score).
            for (let checked = 0; checked < lower.length && checked < 128 && !routeCandidates.length; checked++) {
                const profile = lower[checked].profile;
                if (recoveryAllowed(profile)) routeCandidates.push(profile);
            }
            suitable = [];
            Diagnostics.count('spot_list', 'pick', routeCandidates.length ? 'recovery' : 'none');
        } else {
            Diagnostics.count('spot_list', 'pick', routeCandidates.length ? 'near_level' : 'none');
        }
        const fallback = (suitable.length ? suitable : routeCandidates).sort((a, b) => {
            if (foreign(a) !== foreign(b)) return foreign(a) ? 1 : -1;
            const aGap = Math.abs(a.avgLevel - targetLevel);
            const bGap = Math.abs(b.avgLevel - targetLevel);
            if (aGap !== bGap) return aGap - bGap;
            return b.density - a.density;
        })[0] || null;
        return fallback && withRoute(fallback);
    }
};

SpotProfiles.spotHunters = spotHunters;
SpotProfiles.useOccupancy = useOccupancy;
SpotProfiles.spotsNearLevel = spotsNearLevel;
SpotProfiles.spotRoom = spotRoom;
SpotProfiles.roomFilterFor = roomFilterFor;
SpotProfiles.defaultRoomFilter = defaultRoomFilter;

module.exports = SpotProfiles;
// A getter also sees replaced period catalogs and manually hydrated profiles;
// table forecasts never call ensure() or import a live World from a worker.
const EMPTY_REWARD_SPOTS = [];
invoke('GameServer/Bot/AI/SpotValueTable').useSpots(() => SpotProfiles.cache || EMPTY_REWARD_SPOTS);
