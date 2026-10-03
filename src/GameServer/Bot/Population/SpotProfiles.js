const SpotService = invoke('GameServer/Bot/AI/SpotService');
const LevelingRoutes = invoke('GameServer/Bot/AI/LevelingRoutes');
const SpotIndex = invoke('GameServer/Bot/AI/SpotIndex');
const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const BotLifeState = invoke('GameServer/Bot/Population/BotLifeState');
const PopulationConfig = invoke('GameServer/Bot/Population/PopulationConfig');
const SpotRiskPolicy = invoke('GameServer/Bot/Population/SpotRiskPolicy');
const { stateKey, occupiedSpotId, farmIntentSpotId } = require('./SpotOccupancyIndex');

let occupancyCache = null;
let occupancyCachedAt = 0;
const capacityFingerprintCache = new WeakMap();
const MAX_CLAN_EQUIPMENT_RESERVATIONS_PER_SPOT = 2;

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
        if (physical) return SpotIndex.spotById(profiles, physical.id) || physical;
    }
    return state?.spotId ? SpotIndex.spotById(profiles, state.spotId) : null;
}

function partyIdForState(state = {}) {
    const physicalPartyId = state.party?.partyId || state.partyId || null;
    if (physicalPartyId) return physicalPartyId;
    const clanGoalKey = state.stats?.clanPartyObjective?.clanGoalKey;
    return clanGoalKey ? `clan-goal:${clanGoalKey}` : null;
}

function clanEquipmentReservationKey(state = {}, spotId = null) {
    const objective = state.stats?.clanPartyObjective;
    if (!objective || String(objective.spotId || '') !== String(spotId || '')) return null;
    if (objective.clanOperation !== 'equipment' && objective.reason !== 'clan_equipment') return null;
    if (['completed', 'cancelled', 'failed'].includes(String(objective.status || ''))) return null;
    const identity = objective.clanId || objective.clanGoalKey;
    return identity ? `clan-equipment:${identity}` : null;
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

function allocationGroups(states = [], physicalKeys = new Set()) {
    const parties = new Map();
    const solo = [];
    states.forEach((state) => {
        const partyId = partyIdForState(state);
        if (!partyId) {
            solo.push(state);
            return;
        }
        const key = String(partyId);
        if (!parties.has(key)) parties.set(key, []);
        parties.get(key).push(state);
    });
    const physicalRank = (members) => members.some((state) => physicalKeys.has(stateKey(state))) ? 0 : 1;
    return {
        parties: [...parties.entries()].sort((left, right) => (
            physicalRank(left[1]) - physicalRank(right[1]) || left[0].localeCompare(right[0])
        )),
        solo: solo.sort((left, right) => (
            Number(!physicalKeys.has(stateKey(left))) - Number(!physicalKeys.has(stateKey(right)))
            || stateKey(left).localeCompare(stateKey(right))
        ))
    };
}

function occupancySnapshot(profiles, states = BotLifeState.allStates(PopulationConfig.maxPlayingPopulation)) {
    const byId = new Map((profiles || []).map((profile) => [profile.id, profile]));
    const physicalMembers = {};
    const reservedMembers = {};
    const append = (entries, spotId, state) => {
        if (!spotId || !byId.has(spotId)) return;
        entries[spotId] = entries[spotId] || new Map();
        entries[spotId].set(stateKey(state), state);
    };
    (states || []).forEach((state) => {
        const spotId = occupiedSpotId(state);
        const intentSpotId = farmIntentSpotId(state);
        append(physicalMembers, spotId, state);
        append(reservedMembers, spotId, state);
        append(reservedMembers, intentSpotId, state);
    });

    const spotIds = new Set([...Object.keys(physicalMembers), ...Object.keys(reservedMembers)]);
    return Object.fromEntries([...spotIds].map((spotId) => [spotId, occupancyEntry(
        spotId,
        byId.get(spotId),
        [...(physicalMembers[spotId]?.values() || [])],
        [...(reservedMembers[spotId]?.values() || [])]
    )]));
}

// One spot of an occupancy snapshot: who counts, who keeps a place when the
// spot is over capacity, and which clan equipment groups hold a reservation.
function occupancyEntry(spotId, profile, spotMembers, claimers) {
    const capacity = LevelingRoutes.capacityForSpot(profile);
    const physicalKeys = new Set(spotMembers.map(stateKey));
    const clanReservationGroups = claimers.reduce((groupsByClan, state) => {
        const key = clanEquipmentReservationKey(state, spotId);
        if (!key) return groupsByClan;
        if (!groupsByClan.has(key)) groupsByClan.set(key, []);
        groupsByClan.get(key).push(state);
        return groupsByClan;
    }, new Map());
    const rankedClanReservationKeys = [...clanReservationGroups.entries()]
        .sort((left, right) => (
            Number(!left[1].some((state) => physicalKeys.has(stateKey(state))))
            - Number(!right[1].some((state) => physicalKeys.has(stateKey(state))))
            || left[0].localeCompare(right[0])
        ))
        .map(([key]) => key);
    const retainedReservationKeys = new Set(
        rankedClanReservationKeys.slice(0, MAX_CLAN_EQUIPMENT_RESERVATIONS_PER_SPOT)
    );
    const admittedClaimers = claimers.filter((state) => {
        const key = clanEquipmentReservationKey(state, spotId);
        return !key || retainedReservationKeys.has(key);
    });
    const groups = allocationGroups(admittedClaimers, physicalKeys);
    const retained = new Set();
    let remaining = capacity;
    groups.parties.forEach(([, partyMembers]) => {
        if (partyMembers.length > remaining) return;
        partyMembers.forEach((state) => retained.add(stateKey(state)));
        remaining -= partyMembers.length;
    });
    groups.solo.slice(0, Math.max(0, remaining)).forEach((state) => retained.add(stateKey(state)));
    return {
        count: spotMembers.length,
        reservedCount: claimers.length,
        capacity,
        retained,
        reservedKeys: new Set(claimers.map(stateKey)),
        reservationKeys: new Set(rankedClanReservationKeys),
        retainedReservationKeys
    };
}

function capacityCount(entry) {
    return Math.max(0, Number(entry?.reservedCount ?? entry?.count ?? 0));
}

function capacityUnitsFor(states = [], entry = null) {
    const reservedKeys = entry?.reservedKeys instanceof Set ? entry.reservedKeys : new Set();
    return [...new Set((states || []).map(stateKey).filter(Boolean))]
        .filter((key) => !reservedKeys.has(key)).length;
}

function reservationGroupHasCapacity(entry, options = {}) {
    const reservationKey = String(options.reservationKey || '');
    const maxReservationGroups = Math.max(0, Math.floor(Number(options.maxReservationGroups || 0)));
    if (!reservationKey || maxReservationGroups <= 0) return true;
    const reservationKeys = entry?.reservationKeys instanceof Set ? entry.reservationKeys : new Set();
    const retainedReservationKeys = entry?.retainedReservationKeys instanceof Set
        ? entry.retainedReservationKeys
        : reservationKeys;
    if (reservationKeys.has(reservationKey)) return retainedReservationKeys.has(reservationKey);
    return retainedReservationKeys.size < maxReservationGroups;
}

function hasCapacityForStates(spot, states = [], occupancy = {}, options = {}) {
    if (spot?.raidBoss === true) return true;
    if (!spot?.id) return false;
    const entry = occupancy?.[spot.id];
    const maxOverflowUnits = Math.max(0, Math.floor(Number(options.maxOverflowUnits || 0)));
    if (!entry) {
        return capacityUnitsFor(states) <= Math.max(1, LevelingRoutes.capacityForSpot(spot)) + maxOverflowUnits;
    }
    if (!reservationGroupHasCapacity(entry, options)) return false;
    const capacity = Number(entry.capacity || LevelingRoutes.capacityForSpot(spot));
    return capacityCount(entry) + capacityUnitsFor(states, entry) <= Math.max(1, capacity) + maxOverflowUnits;
}

function reserveCapacity(occupancy, spot, states = [], options = {}) {
    if (spot?.raidBoss === true) return true;
    if (!occupancy || !spot?.id) return false;
    const entry = occupancy[spot.id] || {
        count: 0,
        reservedCount: 0,
        capacity: LevelingRoutes.capacityForSpot(spot),
        retained: new Set(),
        reservedKeys: new Set(),
        reservationKeys: new Set(),
        retainedReservationKeys: new Set()
    };
    if (!(entry.retained instanceof Set)) entry.retained = new Set();
    if (!(entry.reservedKeys instanceof Set)) entry.reservedKeys = new Set();
    if (!(entry.reservationKeys instanceof Set)) entry.reservationKeys = new Set();
    if (!(entry.retainedReservationKeys instanceof Set)) entry.retainedReservationKeys = new Set(entry.reservationKeys);
    if (!reservationGroupHasCapacity(entry, options)) return false;
    const keys = [...new Set((states || []).map(stateKey).filter(Boolean))]
        .filter((key) => !entry.reservedKeys.has(key));
    const maxOverflowUnits = Math.max(0, Math.floor(Number(options.maxOverflowUnits || 0)));
    if (capacityCount(entry) + keys.length > Math.max(1, Number(entry.capacity || 0)) + maxOverflowUnits) return false;
    keys.forEach((key) => {
        entry.reservedKeys.add(key);
        entry.retained.add(key);
    });
    const reservationKey = String(options.reservationKey || '');
    if (reservationKey) {
        entry.reservationKeys.add(reservationKey);
        entry.retainedReservationKeys.add(reservationKey);
    }
    entry.reservedCount = capacityCount(entry) + keys.length;
    occupancy[spot.id] = entry;
    capacityFingerprintCache.delete(occupancy);
    return true;
}

function capacityFingerprint(occupancy = {}, maxUnits = 9, options = {}) {
    const threshold = Math.max(1, Number(maxUnits || 1));
    const maxReservationGroups = Math.max(0, Math.floor(Number(options.maxReservationGroups || 0)));
    const cacheKey = `${threshold}:${maxReservationGroups}`;
    const cachedByThreshold = capacityFingerprintCache.get(occupancy);
    if (cachedByThreshold?.has(cacheKey)) return cachedByThreshold.get(cacheKey);
    const fingerprint = Object.entries(occupancy)
        .map(([spotId, entry]) => ({
            spotId,
            free: Math.max(0, Number(entry?.capacity || 0) - capacityCount(entry)),
            groupFree: maxReservationGroups > 0
                ? Math.max(0, maxReservationGroups - Number(entry?.retainedReservationKeys?.size || 0))
                : null
        }))
        .filter((entry) => entry.free < threshold || entry.groupFree === 0)
        .sort((left, right) => left.spotId.localeCompare(right.spotId))
        .map((entry) => `${entry.spotId}:${entry.free}${entry.groupFree === null ? '' : `:g${entry.groupFree}`}`)
        .join(',');
    const nextCache = cachedByThreshold || new Map();
    nextCache.set(cacheKey, fingerprint);
    if (!cachedByThreshold) capacityFingerprintCache.set(occupancy, nextCache);
    return fingerprint;
}

// Level bounds are cheap and independent of the detailed route policy:
// out-of-range spots are rejected before deriving their tags. The window of
// one target level is the same for every search of one catalog.
const spotsNearLevelByCatalog = new WeakMap();

function spotsNearLevel(profiles, targetLevel) {
    let byLevel = spotsNearLevelByCatalog.get(profiles);
    if (!byLevel) spotsNearLevelByCatalog.set(profiles, byLevel = new Map());
    let spots = byLevel.get(targetLevel);
    if (!spots) {
        spots = profiles.filter((profile) => profile.raidBoss !== true
            && profile.minLevel <= targetLevel + 4 && profile.maxLevel >= targetLevel - 4);
        byLevel.set(targetLevel, spots);
    }
    return spots;
}

// occupancySnapshot of the states a SpotOccupancyIndex holds, minus
// excludedKeys. A spot is recomputed only when its members changed or the
// caller's catalog has another profile for it; other spots reuse their entry.
// Every call hands out copies: callers reserve places in the snapshot they
// were given (reserveCapacity), and that must not reach the next snapshot.
const indexedViews = new WeakMap();
function indexedOccupancy(index, profiles, excludedKeys = new Set()) {
    // occupancySnapshot judges capacity backoffs at wall-clock time.
    index.refreshBackoffs(Date.now());
    let view = indexedViews.get(index);
    if (!view) indexedViews.set(index, view = { entries: new Map(), excludedKeys: new Set() });
    const markPlace = (key) => {
        const place = index.places.get(key);
        if (place?.spotId) index.dirty.add(place.spotId);
        if (place?.intentSpotId) index.dirty.add(place.intentSpotId);
    };
    for (const key of excludedKeys) if (!view.excludedKeys.has(key)) markPlace(key);
    for (const key of view.excludedKeys) if (!excludedKeys.has(key)) markPlace(key);
    view.excludedKeys = new Set(excludedKeys);
    const catalog = profiles || [];
    const counted = (members) => [...(members || [])]
        .filter(([key]) => !view.excludedKeys.has(key))
        .map(([, state]) => state);
    const snapshot = {};
    const byId = SpotIndex.tableFor(catalog);
    for (const spotId of new Set([...index.physical.keys(), ...index.reserved.keys()])) {
        const key = String(spotId);
        const profile = byId.get(key);
        if (!profile) {
            view.entries.delete(spotId);
            continue;
        }
        let cached = view.entries.get(spotId);
        if (!cached || cached.profile !== profile || index.dirty.has(spotId)) {
            const spotMembers = counted(index.physical.get(spotId));
            const claimers = counted(index.reserved.get(spotId));
            cached = { profile, entry: spotMembers.length || claimers.length
                ? occupancyEntry(key, profile, spotMembers, claimers) : null };
            view.entries.set(spotId, cached);
        }
        if (!cached.entry) continue;
        snapshot[spotId] = { ...cached.entry,
            retained: new Set(cached.entry.retained),
            reservedKeys: new Set(cached.entry.reservedKeys),
            reservationKeys: new Set(cached.entry.reservationKeys),
            retainedReservationKeys: new Set(cached.entry.retainedReservationKeys) };
    }
    for (const spotId of view.entries.keys()) {
        if (!index.physical.has(spotId) && !index.reserved.has(spotId)) view.entries.delete(spotId);
    }
    index.dirty.clear();
    return snapshot;
}

function currentOccupancy(profiles, maxAgeMs = 1000) {
    const timestamp = Date.now();
    if (occupancyCache && timestamp - occupancyCachedAt < maxAgeMs) return occupancyCache;
    // The same states as occupancySnapshot's default list: the most recently
    // updated maxPlayingPopulation of them.
    const excludedKeys = new Set(BotLifeState.statesBeyondRecent(PopulationConfig.maxPlayingPopulation).map(stateKey));
    occupancyCache = indexedOccupancy(BotLifeState.occupancyIndex(), profiles, excludedKeys);
    occupancyCachedAt = timestamp;
    return occupancyCache;
}

function shouldLeaveOverCapacity(state, spot, occupancy) {
    const entry = occupancy?.[spot?.id];
    const reservationKey = clanEquipmentReservationKey(state, spot?.id);
    if (reservationKey && entry?.retainedReservationKeys instanceof Set
        && !entry.retainedReservationKeys.has(reservationKey)) return true;
    const count = LevelingRoutes.occupancyForSpot(occupancy, spot?.id);
    const capacity = Number(entry?.capacity || LevelingRoutes.capacityForSpot(spot));
    if (!spot || count <= capacity) return false;
    if (entry?.retained instanceof Set) return !entry.retained.has(stateKey(state));
    return true;
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
        occupancyCache = null;
        occupancyCachedAt = 0;
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

    findForState(state, options = {}) {
        const timestamp = Number(options.timestamp || Date.now());
        if (GearAcquisitionPlanner.levelingRecoveryFor(state, state?.stats?.equipmentPlan, timestamp)) {
            state = { ...state, stats: { ...(state.stats || {}), equipmentPlan: null } };
        }
        const acquisitionPlan = state?.stats?.equipmentPlan;
        const protectedStarterCohort = isProtectedStarterCohort(state);
        const profiles = this.ensure();
        const physicalSpot = physicalSpotForState(state, profiles);
        const savedSpot = state?.spotId ? this.findById(state.spotId) : null;
        const currentSpot = physicalSpot || savedSpot;
        const targetLevel = LevelingRoutes.targetLevelForState(state, options);
        const excludedSpotIds = new Set([
            ...(options.mode === 'party' ? [] : SpotRiskPolicy.excludedSpotIdsForStates([state], timestamp)),
            ...((options.excludedSpotIds instanceof Set || Array.isArray(options.excludedSpotIds))
                ? [...options.excludedSpotIds].map(String)
                : [])
        ]);
        const occupancy = options.occupancy || currentOccupancy(profiles);
        const capacityStates = Array.isArray(options.capacityStates) && options.capacityStates.length
            ? options.capacityStates
            : [state];
        const capacityUnits = new Set(capacityStates.map(stateKey).filter(Boolean)).size || 1;
        const reservationKey = clanEquipmentReservationKey(state, acquisitionPlan?.next?.spotId);
        const reservationOptions = reservationKey ? {
            reservationKey,
            maxReservationGroups: MAX_CLAN_EQUIPMENT_RESERVATIONS_PER_SPOT
        } : {};
        const TargetMatchup = invoke('GameServer/Bot/AI/BotTargetMatchup');
        const mode = LevelingRoutes.modeForState(state, options);
        const routeOptions = { ...options, occupancy, excludedSpotIds, capacityUnits, ...reservationOptions,
            matchupProfiles: TargetMatchup.stateProfiles(state, { ...options, mode }) };
        const currentMatch = currentSpot ? LevelingRoutes.scoreSpot(currentSpot, state, routeOptions) : null;
        // Staying on the leader's ground still admits any teammates reserved
        // elsewhere. Check them before either current-spot shortcut, while
        // leaving redistribution of already counted hunters to the retained set.
        const currentNeedsRoom = currentSpot
            && capacityUnitsFor(capacityStates, occupancy[currentSpot.id]) > 0
            && !hasCapacityForStates(currentSpot, capacityStates, occupancy, reservationOptions);
        // A starter field outside the bot's region (locality penalty) asks
        // for a move only when a field without that penalty can take the bot:
        // allowed, with room, near its level. A kit that survives no home
        // field yet (an orc mystic on fists before its first spell) would
        // otherwise be sent to another penalised field on every resolve and
        // never hunt. Checked only for the few young bots on foreign ground.
        const localityRelocate = currentSpot && currentMatch.localityPenalty > 0
            && spotsNearLevel(profiles, targetLevel).some((profile) => profile.id !== currentSpot.id
                && !excludedSpotIds.has(String(profile.id))
                && LevelingRoutes.localityPenaltyForSpot(profile, state, { level: targetLevel },
                    LevelingRoutes.tagsForSpot(profile)) === 0
                && hasCapacityForStates(profile, capacityStates, occupancy, reservationOptions)
                && LevelingRoutes.isSpotAllowedForState(profile, state, routeOptions));
        const mustRelocate = currentSpot && (localityRelocate
            || (currentSpot.raidBoss === true && !explicitClanRaidSpot(state, currentSpot))
            || currentMatch.targetMatchup?.eligible === false
            || currentMatch.huntingGround?.allowed === false
            || shouldLeaveOverCapacity(state, currentSpot, occupancy)
            || currentNeedsRoom
            || excludedSpotIds.has(String(currentSpot.id)));
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
            // A gear objective may have several valid drop sources. Select an
            // available source instead of letting the persisted objective
            // override the live spot capacity forever.
            const plannedSource = GearAcquisitionPlanner.bestSourceForPlan(
                state,
                acquisitionPlan,
                profiles,
                { occupancy, excludedSpotIds, capacityUnits, ...reservationOptions,
                    allowRaidSources: acquisitionPlan.next?.sourceKind === 'raid'
                        && GearAcquisitionPlanner.isClanOwnedPlan(acquisitionPlan) }
            );
            const planned = plannedSource
                ? this.findById(plannedSource.spotId)
                // Lightweight callers may provide only the persisted route
                // metadata, without a source atlas or occupancy snapshot.
                // Preserve that route until live capacity data is available.
                : Object.keys(occupancy || {}).length === 0
                    ? this.findById(acquisitionPlan.next?.spotId)
                    : null;
            if (planned && !excludedSpotIds.has(String(planned.id))
                && LevelingRoutes.isSpotAllowedForState(planned, state, routeOptions)) {
                // A drop source may be valid for the item but still be a
                // starter-level camp for the bot. Never let an active gear
                // plan pin an outleveled bot to that source indefinitely.
                const hasLevelBounds = Number.isFinite(Number(planned.minLevel))
                    && Number.isFinite(Number(planned.maxLevel));
                if (!currentSpot || !hasLevelBounds || SpotService.isSuitable(planned, targetLevel, options)) {
                    return planned;
                }
            }
        }

        if (currentSpot && !mustRelocate && SpotService.isSuitable(currentSpot, targetLevel, options)) {
            return LevelingRoutes.decorateSpot(currentSpot, currentMatch);
        }

        const candidates = spotsNearLevel(profiles, targetLevel)
            .filter((profile) => !excludedSpotIds.has(String(profile.id)))
            .filter((profile) => LevelingRoutes.isSpotAllowedForState(profile, state, routeOptions));
        const relocationCandidates = mustRelocate
            ? candidates.filter((profile) => profile.id !== currentSpot.id)
            : candidates;
        let routeCandidates = (relocationCandidates.length ? relocationCandidates : candidates)
            .filter((profile) => hasCapacityForStates(profile, capacityStates, occupancy, reservationOptions));
        let suitable = routeCandidates.filter((profile) => SpotService.isSuitable(profile, targetLevel, options));
        const soloSearch = !['party', 'duo'].includes(mode);
        // Without a suitable camp a solo bot hunts allowed ground near its
        // level: like the easier-ground fallback below, it keeps its current camp.
        if (soloSearch && !suitable.length && currentSpotAmong(routeCandidates, currentSpot, mustRelocate)) {
            return LevelingRoutes.decorateSpot(currentSpot, currentMatch);
        }
        // A weak kit can make every camp near the character's level unsafe.
        // Search easier ground using the same combat and capacity checks;
        // otherwise a perfectly healthy bot repeats missing_spot forever.
        if (!routeCandidates.length && soloSearch) {
            const recoveryState = { ...state, stats: { ...state.stats, equipmentPlan: null } };
            routeCandidates = profiles.filter(profile => profile.raidBoss !== true
                && profile.maxLevel >= targetLevel - 16
                && profile.maxLevel < targetLevel - 4
                && !excludedSpotIds.has(String(profile.id))
                && hasCapacityForStates(profile, capacityStates, occupancy, reservationOptions)
                && LevelingRoutes.isSpotAllowedForState(profile, recoveryState, routeOptions));
            if (currentSpotAmong(routeCandidates, currentSpot, mustRelocate)) {
                return LevelingRoutes.decorateSpot(currentSpot, currentMatch);
            }
            suitable = routeCandidates.filter((profile) => SpotService.isSuitable(profile, targetLevel, options));
        }
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
SpotProfiles.indexedOccupancy = indexedOccupancy;
SpotProfiles.shouldLeaveOverCapacity = shouldLeaveOverCapacity;
SpotProfiles.farmIntentSpotId = farmIntentSpotId;
SpotProfiles.hasCapacityForStates = hasCapacityForStates;
SpotProfiles.reserveCapacity = reserveCapacity;
SpotProfiles.capacityFingerprint = capacityFingerprint;
SpotProfiles.clanEquipmentReservationKey = clanEquipmentReservationKey;
SpotProfiles.MAX_CLAN_EQUIPMENT_RESERVATIONS_PER_SPOT = MAX_CLAN_EQUIPMENT_RESERVATIONS_PER_SPOT;

module.exports = SpotProfiles;
