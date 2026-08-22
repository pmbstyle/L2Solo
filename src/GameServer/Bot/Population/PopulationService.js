const Config  = invoke('GameServer/Bot/Population/PopulationConfig');
const Metrics = invoke('GameServer/Bot/Population/PopulationMetrics');
const Database = invoke('Database');
const Status  = invoke('GameServer/Bot/Population/PopulationStatus');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const LifeEvents = invoke('GameServer/Bot/Population/BotLifeEvents');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const SpotService = invoke('GameServer/Bot/AI/SpotService');
const BackgroundResolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const BackgroundPartyResolver = invoke('GameServer/Bot/Population/BackgroundPartyResolver');
const BackgroundPartyState = invoke('GameServer/Bot/Population/BackgroundPartyState');
const HotActivation = invoke('GameServer/Bot/Population/HotActivation');
const Cooldown = invoke('GameServer/Bot/Population/Cooldown');
const Director = invoke('GameServer/Bot/Population/PopulationDirector');
const GlobalChat = invoke('GameServer/Bot/Population/BotGlobalChat');
const GeneratedColdSeeder = invoke('GameServer/Bot/Population/GeneratedColdSeeder');
const GoalService = invoke('GameServer/Bot/Goals/GoalService');
const GoalExecutor = invoke('GameServer/Bot/Goals/GoalExecutor');
const ColdMarketService = invoke('GameServer/Bot/Economy/ColdMarketService');
const ColdMarketListingService = invoke('GameServer/Bot/Economy/ColdMarketListingService');
const ColdMarketTradeChat = invoke('GameServer/Bot/Economy/ColdMarketTradeChat');
const BotWarehouse = invoke('GameServer/Bot/Economy/BotWarehouseService');
const PersistentStateRetention = invoke('GameServer/Bot/Population/PersistentStateRetention');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const PartyComposition = invoke('GameServer/Bot/Population/BackgroundPartyComposition');
const PartyRecruitmentChat = invoke('GameServer/Bot/Population/ColdPartyRecruitmentChat');
const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const ColdCraftingService = invoke('GameServer/Bot/Economy/ColdCraftingService');
const CraftTelemetry = invoke('GameServer/Bot/Economy/CraftTelemetry');
const BotPersona = invoke('GameServer/Bot/AI/BotPersona');
const PersonaPartyPolicy = invoke('GameServer/Bot/Population/PersonaPartyPolicy');
const PlayerActivitySignal = invoke('GameServer/Bot/Population/PlayerActivitySignal');
const FloorAwareActivationPolicy = invoke('GameServer/Bot/Population/FloorAwareActivationPolicy');
const ColdSimulationOwner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const ColdSimulationCoordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const PartyRequestPlanner = invoke('GameServer/Bot/Population/PartyRequestPlanner');
const BackgroundPartyLifecycle = invoke('GameServer/Bot/Population/BackgroundPartyLifecycle');
const ClanSimulationConfig = invoke('GameServer/Clan/ClanSimulationConfig');
const ClanSimulationService = invoke('GameServer/Clan/ClanSimulationService');
const ClanEconomyService = invoke('GameServer/Clan/ClanEconomyService');
const ClanGoalService = invoke('GameServer/Clan/ClanGoalService');
const ClanPartyService = invoke('GameServer/Clan/ClanPartyService');
const ClanMarketService = invoke('GameServer/Clan/ClanMarketService');

const {
    partyObjectiveForPlan,
    partyRequestForPlan,
    partyObjectiveForState
} = PartyRequestPlanner;

const HUNTING_TRAVEL_MS = 25000;

function deterministicRandom(state = {}) {
    const seedText = `${state.characterId || 0}:${state.timing?.lastResolvedAt || 0}:${state.timing?.nextResolveAt || 0}`;
    let seed = 2166136261;
    for (let index = 0; index < seedText.length; index++) {
        seed ^= seedText.charCodeAt(index);
        seed = Math.imul(seed, 16777619);
    }
    return () => {
        seed |= 0;
        seed = (seed + 0x6D2B79F5) | 0;
        let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}

function withTimeout(work, timeoutMs) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            const error = new Error('cold_owner_resolve_timeout');
            error.code = 'COLD_OWNER_TIMEOUT';
            reject(error);
        }, Math.max(1000, Number(timeoutMs) || 10000));
    });
    return Promise.race([Promise.resolve().then(work), timeout]).finally(() => clearTimeout(timer));
}

function hasFiniteCoordinate(value) {
    return value !== null
        && value !== undefined
        && String(value).trim() !== ''
        && Number.isFinite(Number(value));
}

function beginHuntingTravel(state, spot, timestamp = Date.now(), options = {}) {
    if (!state || !spot || state.activity === 'traveling') return null;
    const from = { ...(state.loc || {}) };
    const hasLocation = hasFiniteCoordinate(from.locX) && hasFiniteCoordinate(from.locY);
    if (!hasLocation) return null;
    const physical = SpotService.findCurrentSpot(from);
    const currentId = physical?.id || options.currentSpotId || state.spotId || null;
    if (currentId === spot.id) return null;
    const destination = SpotService.arrivalPointForState(state, spot);

    return {
        ...state,
        activity: 'traveling',
        timing: {
            ...(state.timing || {}),
            activityStartedAt: timestamp,
            nextResolveAt: timestamp + HUNTING_TRAVEL_MS
        },
        stats: {
            ...(state.stats || {}),
            travel: {
                from,
                to: destination,
                startedAt: timestamp,
                arrivalAt: timestamp + HUNTING_TRAVEL_MS,
                regionName: spot.name || state.currentRegion || 'Hunting Ground',
                method: 'gatekeeper_spot',
                spotId: spot.id,
                arrivalActivity: 'hunting',
                arrivalEvent: 'arrived_hunting_ground',
                reason: state.stats?.equipmentPlan?.status === 'active'
                    ? 'equipment_source_replan'
                    : 'level_replan'
            }
        }
    };
}

function beginPartySpotTravel(state, spot, timestamp = Date.now()) {
    const travelling = beginHuntingTravel(state, spot, timestamp);
    if (!travelling) return null;
    return {
        ...travelling,
        stats: {
            ...(travelling.stats || {}),
            travel: {
                ...(travelling.stats?.travel || {}),
                reason: 'party_spot_replan',
                arrivalActivity: 'grouped',
                arrivalEvent: 'party_arrived_hunting_ground'
            }
        }
    };
}

function finishPartySpotTravel(state, timestamp = Date.now(), destinationSpot = null, partyTravel = null) {
    const travel = state?.stats?.travel;
    const ownTravelReady = state?.activity === 'traveling'
        && travel?.reason === 'party_spot_replan'
        && Number(travel.arrivalAt || 0) <= timestamp;
    const partyFallbackReady = !ownTravelReady
        && destinationSpot
        && partyTravel?.reason === 'party_spot_replan'
        && Number(partyTravel.arrivalAt || 0) <= timestamp;
    if (!ownTravelReady && !partyFallbackReady) return state;
    const arrival = ownTravelReady
        ? travel
        : {
            ...partyTravel,
            arrivalActivity: 'grouped',
            to: SpotService.arrivalPointForState(state, destinationSpot) || destinationSpot.center || state.loc
        };
    return {
        ...state,
        activity: arrival.arrivalActivity || 'grouped',
        currentRegion: arrival.regionName || destinationSpot?.name || state.currentRegion,
        spotId: arrival.spotId || destinationSpot?.id || state.spotId,
        loc: { ...(arrival.to || state.loc) },
        timing: {
            ...(state.timing || {}),
            activityStartedAt: timestamp,
            nextResolveAt: timestamp + 1000
        },
        stats: { ...(state.stats || {}), travel: null }
    };
}

function finishPartyTravelRecord(party, timestamp = Date.now()) {
    return {
        ...party,
        nextResolveAt: timestamp + 1000,
        stats: {
            ...(party.stats || {}),
            lastResolveAt: timestamp,
            travel: null
        }
    };
}

function groupBySpot(states, options = {}) {
    const grouped = new Map();
    states.forEach((state) => {
        const planSpotId = !SpotProfiles.isProtectedStarterCohort(state)
            && state.stats?.equipmentPlan?.status === 'active'
            ? state.stats.equipmentPlan.next?.spotId
            : null;
        const spotId = planSpotId || state.spotId;
        if (!spotId) return;
        if (!grouped.has(spotId)) grouped.set(spotId, []);
        grouped.get(spotId).push(state);
    });

    const activePartiesBySpot = options.activePartiesBySpot || new Map();
    return Array.from(grouped.entries())
        .map(([spotId, group]) => ({
            spotId,
            states: group.sort((a, b) => Number(a.level || 1) - Number(b.level || 1)),
            partyWaiters: group.filter((state) => state.activity === 'party_wait'
                || state.stats?.partyRequest?.status === 'open').length,
            oldestPartyWaitAt: Math.min(...group
                .filter((state) => state.activity === 'party_wait'
                    || state.stats?.partyRequest?.status === 'open')
                .map((state) => Number(state.stats?.partyRequest?.requestedAt
                    || state.timing?.activityStartedAt
                    || state.updatedAt
                    || Date.now())))
        }))
        .sort((a, b) => {
            if (options.prioritizePartyWait) {
                const aDeficit = a.partyWaiters / (1 + Number(activePartiesBySpot.get(a.spotId) || 0));
                const bDeficit = b.partyWaiters / (1 + Number(activePartiesBySpot.get(b.spotId) || 0));
                if (aDeficit !== bDeficit) return bDeficit - aDeficit;
                if (a.oldestPartyWaitAt !== b.oldestPartyWaitAt) return a.oldestPartyWaitAt - b.oldestPartyWaitAt;
            }
            const aGroup = a.states;
            const bGroup = b.states;
            const aPlanned = aGroup.filter((state) => state.stats?.equipmentPlan?.status === 'active').length;
            const bPlanned = bGroup.filter((state) => state.stats?.equipmentPlan?.status === 'active').length;
            return bPlanned - aPlanned || bGroup.length - aGroup.length;
        })
        .map((group) => group.states);
}

function partySpotForLeader(leader, objectiveSpotId = null) {
    if (objectiveSpotId) {
        const objectiveSpot = SpotProfiles.findById(objectiveSpotId);
        if (objectiveSpot) return objectiveSpot;
    }
    const preserveStarterSpot = SpotProfiles.isProtectedStarterCohort(leader);
    return SpotProfiles.findForState({
        ...leader,
        spotId: preserveStarterSpot ? leader.spotId : null,
        party: {
            ...(leader.party || {}),
            partyId: 'forming',
            role: PartyComposition.roleForState(leader)
        },
        stats: {
            ...(leader.stats || {}),
            routeMode: 'party'
        }
    }, { mode: 'party', role: PartyComposition.roleForState(leader) }) || SpotProfiles.findById(leader.spotId);
}

function leaderIdForMembers(party, members = []) {
    const memberIds = new Set((members || [])
        .map((member) => Number(member?.characterId))
        .filter(Boolean));
    const currentLeaderId = Number(party?.leaderId || 0);
    if (memberIds.has(currentLeaderId)) return currentLeaderId;
    const selectedLeader = PartyComposition.chooseLeader(members);
    return Number(selectedLeader?.characterId || members[0]?.characterId || currentLeaderId || 0);
}

function maxBackgroundPartiesForBacklog(partyWaitCount = 0) {
    const base = Math.max(0, Number(Config.maxBackgroundParties) || 0);
    const threshold = Math.max(1, Number(Config.partyBacklogCapacityThreshold) || 250);
    const step = Math.max(0, Number(Config.partyBacklogCapacityStep) || 0);
    const maxExtra = Math.max(0, Number(Config.partyBacklogCapacityMaxExtra) || 0);
    const extra = Math.min(maxExtra, Math.floor(Math.max(0, Number(partyWaitCount) || 0) / threshold) * step);
    return base + extra;
}

function acquisitionRequirementKey(plan) {
    return JSON.stringify({
        status: plan?.status || null,
        strategy: plan?.strategy || null,
        partyNeed: plan?.partyNeed || (plan?.requiresParty ? 'required' : 'solo_ok'),
        partyNeedReason: plan?.partyNeedReason || null,
        requiresParty: Boolean(plan?.requiresParty),
        target: Number(plan?.target?.selfId || 0),
        nextSpot: plan?.next?.spotId || null,
        nextNpc: Number(plan?.next?.npcId || 0),
        nextItem: Number(plan?.next?.itemId || 0)
    });
}

function partyObjectivesShareRoute(left, right) {
    return Boolean(left && right
        && String(left.spotId || '') === String(right.spotId || '')
        && Number(left.npcId || 0) > 0
        && Number(left.npcId || 0) === Number(right.npcId || 0));
}

function partySessionExpired(party, timestamp = Date.now()) {
    return BackgroundPartyLifecycle.sessionExpired(party, timestamp, Config);
}

function statesForParties(partyIds = []) {
    const ids = [...new Set((partyIds || []).map((partyId) => String(partyId || '')).filter(Boolean))];
    if (typeof LifeState.statesForParties === 'function') {
        return LifeState.statesForParties(ids);
    }
    return Promise.all(ids.map((partyId) => LifeState.statesForParty(partyId)))
        .then((groups) => new Map(ids.map((partyId, index) => [partyId, groups[index] || []])));
}

function expirePartyRequestForState(state, timestamp = Date.now()) {
    const request = state?.stats?.partyRequest;
    if (request?.status !== 'open') return state;
    const maxAge = request.priority === 'required'
        ? Math.max(30000, Number(Config.partyRequestMaxAgeMs) || 15 * 60 * 1000)
        : Math.max(30000, Number(Config.partyPreferredMaxAgeMs) || 5 * 60 * 1000);
    if (timestamp - Number(request.requestedAt || timestamp) < maxAge) return state;
    return {
        ...state,
        stats: {
            ...(state.stats || {}),
            partyRequest: {
                ...request,
                status: 'deferred',
                deferredUntil: timestamp + Math.max(30000, Number(Config.partyRequestCooldownMs) || 5 * 60 * 1000),
                expiredAt: timestamp,
                attempts: Number(request.attempts || 0) + 1
            }
        }
    };
}

function partyObjectiveKeyForState(state) {
    return partyObjectiveForState(state)?.objectiveKey
        || `spot:${state?.spotId || 'unknown'}`;
}

function partyObjectiveSpotForState(state) {
    return partyObjectiveForState(state)?.spotId
        || state?.stats?.equipmentPlan?.next?.spotId
        || state?.spotId
        || null;
}

function directDropTargetNpcId(...plans) {
    for (const plan of plans) {
        if (plan?.status !== 'active' || plan?.strategy !== 'direct_drop') continue;
        const npcId = Number(plan.next?.npcId || 0);
        if (npcId > 0) return npcId;
    }
    return 0;
}

function partyTargetNpcId(party, leader) {
    const objectiveNpcId = Number(party.stats?.objective?.npcId || 0);
    return objectiveNpcId > 0
        ? objectiveNpcId
        : directDropTargetNpcId(leader.stats?.equipmentPlan, party.stats?.acquisitionGoal);
}

function joinedBackgroundParty(state) {
    const current = LifeState.cachedState(state?.characterId);
    return !!current?.party?.partyId;
}

function canResumeAffordableWeaponMarketPlan(state, timestamp = Date.now()) {
    const plan = state?.stats?.equipmentPlan;
    const targetId = Number(plan?.target?.selfId || 0);
    if (state?.activity !== 'hunting'
        || plan?.status !== 'active'
        || plan?.strategy !== 'market'
        || Number(plan?.target?.slot || 0) !== 7
        || targetId <= 0
        || Number(state.stats?.marketRetryAfter || 0) > timestamp) return false;

    const price = Number(plan.market?.price || 0);
    const reserve = Math.max(0, Number(plan.market?.reserve || 0));
    if (price <= 0 || Number(state.adena || 0) < price + reserve) return false;

    const combinationRequirement = (plan.combine?.requirements || [])
        .find((entry) => Number(entry.selfId) === targetId);
    const required = Math.max(1, Number(combinationRequirement?.amount || 1));
    const owned = Number(state.inventory?.[String(targetId)]?.amount || 0);
    return owned < required;
}

function canResumeWarehouseMarketSale(state) {
    if (state?.activity !== 'hunting' || state.stats?.marketReturn || state.stats?.travel) return false;
    return (state.stats?.lastWarehouseWithdrawal?.items || []).some((item) => (
        item.reason === 'market'
        && Number(state.inventory?.[String(item.selfId)]?.amount || 0) > 0
        && !!MarketOpportunity.bestBuyOffer(item.selfId, { sellerCharacterId: state.characterId })
    ));
}

function canTakePartyMarketBreak(party, members, member, timestamp = Date.now()) {
    if (timestamp - Number(party.stats?.formedAt || party.startedAt || timestamp) < Config.partyMarketBreakMinSessionMs) return false;
    if (Number(party.stats?.fightsResolved || 0) < Config.partyMarketBreakMinFights) return false;
    if (timestamp - Number(party.stats?.lastMarketBreakAt || 0) < Config.partyMarketBreakCooldownMs) return false;
    const role = PartyComposition.roleForState(member);
    const coverage = PartyComposition.roleCoverage(members);
    return !(['tank', 'healer'].includes(role) && Number(coverage[role] || 0) <= 1);
}

function dissolveBackgroundParty(party, reason, memberCount = 0) {
    return BackgroundPartyState.setStatus(party.partyId, 'dissolved')
        .then(() => LifeState.releaseDissolvedPartyMembers(party.partyId, reason))
        .then((cleared) => {
            Metrics.recordPartyDissolution();
            console.info(
                'BotPopulation :: dissolved background party %s reason=%s members=%d cleared=%d',
                party.partyId,
                reason,
                memberCount,
                cleared
            );
            return { ok: false, reason, party, cleared };
        });
}

async function reconcileWorkerPartyGoals(party, timestamp = Date.now()) {
    if (!party?.partyId || party.status === 'dissolved') {
        return { party, reviewed: 0, departed: null };
    }

    const members = (party.memberIds || [])
        .map((characterId) => LifeState.cachedState(characterId))
        .filter((member) => member && String(member.party?.partyId || member.partyId || '') === String(party.partyId));
    if (!members.length) return { party, reviewed: 0, departed: null };

    const spot = SpotProfiles.findById(party.spotId) || null;
    let reviewed = 0;
    let departed = null;
    for (const member of members) {
        const cachedGoal = GoalService.snapshot(member.characterId);
        const cleanupNeeded = ItemDisposition.inventoryCleanupNeed(member, { now: timestamp });
        const due = !cachedGoal?.current || Number(cachedGoal.current.nextReviewAt || 0) <= timestamp;
        const goalSnapshot = due || cleanupNeeded
            ? await GoalService.review(member, { spot, now: timestamp })
            : cachedGoal;
        if (due || cleanupNeeded) reviewed += 1;
        if (departed || !canTakePartyMarketBreak(party, members, member, timestamp)) continue;

        // Goal review can overlap the next worker claim. Re-read the reflected
        // ownership revision immediately before the atomic transition so the
        // handoff fences that live token instead of an older cached snapshot.
        const currentMember = LifeState.cachedState(member.characterId) || member;
        if (String(currentMember.party?.partyId || currentMember.partyId || '') !== String(party.partyId)) continue;
        const travel = GoalExecutor.beginMarketTravel(currentMember, goalSnapshot?.current, timestamp);
        if (!travel) continue;
        const detached = await LifeState.leaveParty(travel, 'market_break', { ownerHandoff: true });
        if (detached) departed = detached;
    }

    if (!departed) return { party, reviewed, departed: null };
    const activeMembers = members.filter((member) => Number(member.characterId) !== Number(departed.characterId));
    if (activeMembers.length < Config.partyMinSize) {
        const dissolved = await dissolveBackgroundParty(party, 'market_break', activeMembers.length);
        return { party: dissolved.party || party, reviewed, departed, dissolved: true };
    }

    const leader = activeMembers.find((member) => Number(member.characterId) === Number(party.leaderId))
        || PartyComposition.chooseLeader(activeMembers)
        || activeMembers[0];
    const updatedParty = await BackgroundPartyState.createOrUpdate({
        ...party,
        leaderId: Number(leader.characterId),
        memberIds: activeMembers.map((member) => Number(member.characterId)),
        roleCoverage: PartyComposition.roleCoverage(activeMembers),
        stats: {
            ...(party.stats || {}),
            lastMarketBreakAt: timestamp
        },
        updatedAt: timestamp
    });
    return { party: updatedParty || party, reviewed, departed, dissolved: false };
}

function inventoryCleanupGoal(state, timestamp = Date.now()) {
    if (!state || state.phase !== 'cold' || state.party?.partyId || state.partyId
        || state.stats?.travel || state.stats?.marketReturn
        || ['traveling', 'shopping', 'merchant', 'crafting', 'dead', 'pk_hunting'].includes(state.activity)) return null;
    const need = ItemDisposition.inventoryCleanupNeed(state, { now: timestamp });
    if (!need) return null;
    return {
        type: 'sell_inventory',
        status: 'active',
        priority: 96,
        target: {
            itemCount: need.slots,
            npcOnlySlots: need.npcOnlySlots,
            cleanupReason: need.reason
        },
        plan: {
            kind: 'market_sell',
            expectedBenefit: 'market_sale_inventory',
            risk: 0,
            cleanupReason: need.reason
        },
        blockers: []
    };
}

function inventoryCleanupTravelState(state, timestamp = Date.now(), simulation = null) {
    const cleanupGoal = inventoryCleanupGoal(state, timestamp);
    if (!cleanupGoal) return null;
    const travelState = GoalExecutor.beginMarketTravel(state, cleanupGoal, timestamp);
    if (!travelState) return null;

    const cleanup = cleanupGoal.target;
    console.info('BotGoals :: forced inventory cleanup for %s slots=%d npcOnly=%d reason=%s',
        state.name, Number(cleanup.itemCount || 0), Number(cleanup.npcOnlySlots || 0), cleanup.cleanupReason);
    return {
        ...travelState,
        stats: {
            ...(travelState.stats || {}),
            forcedMarketCleanup: {
                ...cleanup,
                startedAt: timestamp
            }
        },
        ...(simulation ? { simulation } : {}),
        cleanup
    };
}

function marketListingIntent(state, goal = null) {
    const forcedCleanup = state?.stats?.forcedMarketCleanup || null;
    if (!forcedCleanup && goal?.type !== 'sell_inventory') {
        return { shouldOpen: false, state };
    }
    if (!forcedCleanup) return { shouldOpen: true, state };

    return {
        shouldOpen: true,
        cleanup: forcedCleanup,
        state: {
            ...state,
            stats: {
                ...(state.stats || {}),
                forcedMarketCleanup: null
            }
        }
    };
}

function assignPartyMembers(members = [], party) {
    const assigned = [];
    const failed = [];
    return (members || []).reduce((chain, member) => chain.then(() => (
        LifeState.assignParty(
            member,
            party.partyId,
            PartyComposition.roleForState(member),
            party.leaderId,
            party.nextResolveAt
        ).then((saved) => {
            if (saved) assigned.push(member);
            else failed.push(member);
            return saved;
        }).catch(() => {
            failed.push(member);
            return null;
        })
    )), Promise.resolve()).then(() => ({ assigned, failed }));
}

function hydratePartyCandidates(candidates = []) {
    const selected = (candidates || []).filter((state) => Number(state?.characterId || 0) > 0);
    if (!selected.length || !Database.isReady() || typeof LifeState.statesByIds !== 'function') {
        return Promise.resolve(selected);
    }
    const projectionById = new Map(selected.map((state) => [Number(state.characterId), state]));
    return LifeState.statesByIds(Array.from(projectionById.keys()), {
        ownerId: 'legacy_main',
        unassigned: true
    }).then((states) => {
        const hydratedById = new Map((states || []).map((state) => [Number(state.characterId), state]));
        return selected.map((projection) => {
            const hydrated = hydratedById.get(Number(projection.characterId));
            if (!hydrated) return null;
            const projectedAt = Number(projection.updatedAt || 0);
            if (projectedAt > 0 && Number(hydrated.updatedAt || 0) !== projectedAt) return null;
            return hydrated;
        }).filter(Boolean);
    });
}

function commitPartyMembership(party, members = [], event = null) {
    const selected = (members || []).filter(Boolean);
    if (!party || !selected.length) return Promise.resolve({ party: null, assigned: [], failed: selected });

    // Unit harnesses and startup fall back to the legacy composition API.
    // The live path below is one SQLite queue item and one bounded transaction.
    if (!Database.isReady()
        || typeof Database.commitBackgroundPartyMembership !== 'function'
        || typeof BackgroundPartyState.prepareCommit !== 'function'
        || typeof LifeState.preparePartyAssignment !== 'function') {
        return BackgroundPartyState.createOrUpdate(party).then((savedParty) => {
            if (!savedParty) return { party: null, assigned: [], failed: selected, eventCommitted: false };
            return assignPartyMembers(selected, savedParty)
                .then(({ assigned, failed }) => ({ party: savedParty, assigned, failed, eventCommitted: false }));
        });
    }

    const preparedParty = BackgroundPartyState.prepareCommit(party);
    if (!preparedParty) return Promise.resolve({ party: null, assigned: [], failed: selected });
    const preparedMembers = selected.map((member) => LifeState.preparePartyAssignment(
        member,
        preparedParty.snapshot.partyId,
        PartyComposition.roleForState(member),
        preparedParty.snapshot.leaderId,
        preparedParty.snapshot.nextResolveAt
    )).filter(Boolean);
    if (preparedMembers.length !== selected.length) {
        return Promise.resolve({ party: null, assigned: [], failed: selected });
    }

    return Database.commitBackgroundPartyMembership({
        party: preparedParty.row,
        members: preparedMembers,
        event
    }).then((result) => {
        if (!result?.ok) return { party: null, assigned: [], failed: selected, eventCommitted: false, reason: result?.reason || 'commit_failed' };
        const committedParty = BackgroundPartyState.acceptCommit(preparedParty);
        const assigned = LifeState.acceptPartyAssignments(preparedMembers);
        assigned.forEach(() => Metrics.recordDbFlush());
        return { party: committedParty, assigned, failed: [], eventCommitted: !!event };
    }).catch((error) => {
        if (error?.code !== 'BOT_PARTY_MEMBERSHIP_CONFLICT') {
            utils.infoWarn('BotPopulation', 'atomic party membership commit failed for %s: %s', party.partyId, error.message);
        }
        return { party: null, assigned: [], failed: selected, eventCommitted: false, reason: error?.code || 'commit_failed' };
    });
}

function syncPartyLeader(members = [], party, leaderId) {
    const nextLeaderId = Number(leaderId || 0);
    const staleMembers = (members || []).filter((member) => (
        Number(member.party?.leaderId || 0) !== nextLeaderId
    ));
    if (!staleMembers.length) return Promise.resolve({ assigned: [], failed: [] });
    return assignPartyMembers(staleMembers, { ...party, leaderId: nextLeaderId });
}

function activationCandidatesForPlayer(states, playerLevel) {
    const level = Number(playerLevel || 1);
    const range = Math.max(0, Number(Config.activationLevelRange || 0));
    const matching = states.filter((state) => {
        const stateLevel = Number(state.level || 1);
        if (Math.abs(stateLevel - level) <= range) return true;
        return !!state.stats?.newbieAnchor && level <= Config.newbieAnchorMaxLevel + 2;
    });

    return matching.length > 0 ? matching : states;
}

function distance2d(a, b) {
    const dx = Number(a?.fetchLocX?.() || 0) - Number(b?.fetchLocX?.() || 0);
    const dy = Number(a?.fetchLocY?.() || 0) - Number(b?.fetchLocY?.() || 0);
    return Math.sqrt((dx * dx) + (dy * dy));
}

function nearbyHotCount(sessions, player) {
    const playerLevel = Number(player.fetchLevel?.() || 1);
    return sessions.filter((session) => {
        const actor = session?.actor;
        if (!actor || !session.accountId || !String(session.accountId).startsWith('bot_')) return false;
        if (actor.fetchIsOnline && !actor.fetchIsOnline()) return false;
        if (session.plan === 'merchant') return false;
        if (distance2d(actor, player) > Config.activationRadius) return false;
        return Math.abs(Number(actor.fetchLevel?.() || 1) - playerLevel) <= Config.activationLevelRange;
    }).length;
}

const PopulationService = {
    groupBySpot,
    partySpotForLeader,
    partyTargetNpcId,
    initialized: false,
    started: false,
    summaryTimer: null,
    initialSummaryTimer: null,
    schedulerTimer: null,
    clanSimulationTimer: null,
    warehouseCleanupTimer: null,
    stateRetentionTimer: null,
    partyFormationTimer: null,
    partyRequestCleanupTimer: null,
    phasePolicyTimer: null,
    seedTimer: null,
    classProgressionMigrationTimer: null,
    marketTownMigrationTimer: null,
    goalMetadataTimer: null,
    nextColdCombatProfileMigrationAt: 0,
    nextMarketTownMigrationAt: 0,
    nextPartyRequestCleanupAt: 0,
    nextColdOwnerRecoveryAt: 0,
    nextWarehouseCleanupAt: 0,
    warehouseCleanupCursor: 0,
    warehouseCleanupPassUnits: 0,
    nextStateRetentionAt: 0,
    stateRetentionPassRows: 0,
    walResetTimer: null,
    walResetRunning: false,
    nextWalResetAt: 0,
    lastWalResetResult: null,
    marketExpiryCleanupTimer: null,
    personaBackfillTimer: null,
    personaBackfillRunning: false,
    nextMarketExpiryCleanupAt: 0,
    resolving: false,
    classProgressionMigrationRunning: false,
    coldCombatProfileMigrationRunning: false,
    marketTownMigrationRunning: false,
    goalMetadataRunning: false,
    marketExpiryCleanupRunning: false,
    coldOwnerRecoveryRunning: false,
    warehouseCleanupRunning: false,
    stateRetentionRunning: false,
    partyFormationRunning: false,
    partyFormationPending: false,
    partyRequestCleanupRunning: false,
    phasePolicyRunning: false,
    clanSimulationRunning: false,

    init() {
        if (this.initialized || Config.enabled === false) return;

        Metrics.init();
        Metrics.startEventLoopMonitor();
        LifeState.init();
        LifeEvents.init();
        BackgroundPartyState.init();
        Director.init();
        this.initialized = true;
        utils.infoSuccess('BotPopulation', 'population service initialized');
    },

    start() {
        if (this.started || Config.enabled === false) return;
        if (!this.initialized) this.init();

        this.started = true;
        this.initialSummaryTimer = setTimeout(() => {
            this.logSummary('start');
            this.initialSummaryTimer = null;
        }, 5000);

        if (typeof this.initialSummaryTimer.unref === 'function') {
            this.initialSummaryTimer.unref();
        }

        this.summaryTimer = setInterval(() => {
            this.logSummary('summary');
        }, Config.summaryIntervalMs);

        if (typeof this.summaryTimer.unref === 'function') {
            this.summaryTimer.unref();
        }

        if (Config.backgroundResolverEnabled !== false) {
            // Cold simulation is owned by ColdSimulationCoordinator and runs
            // in its worker. Keep this timer telemetry-only: the legacy
            // tickBudgeted() path must not be reintroduced on the main thread.
            this.refreshSchedulerTelemetry();
            this.schedulerTimer = setInterval(() => {
                this.refreshSchedulerTelemetry();
            }, Config.schedulerIntervalMs);

            if (typeof this.schedulerTimer.unref === 'function') {
                this.schedulerTimer.unref();
            }
        }

        if (Config.backgroundResolverEnabled !== false) ColdSimulationCoordinator.start(this);

        if (ClanSimulationConfig.enabled !== false) {
            this.clanSimulationTimer = setInterval(() => {
                this.resolveClanSimulation();
            }, ClanSimulationConfig.resolveIntervalMs);
            if (typeof this.clanSimulationTimer.unref === 'function') {
                this.clanSimulationTimer.unref();
            }
        }

        this.classProgressionMigrationTimer = setInterval(() => {
            this.migrateLegacyClassProgression();
        }, Config.classProgressionMigrationIntervalMs);

        if (typeof this.classProgressionMigrationTimer.unref === 'function') {
            this.classProgressionMigrationTimer.unref();
        }

        this.marketTownMigrationTimer = setInterval(() => {
            this.maybeMigrateLegacyMarketTowns();
        }, Config.marketTownMigrationIntervalMs);

        if (typeof this.marketTownMigrationTimer.unref === 'function') {
            this.marketTownMigrationTimer.unref();
        }

        this.marketExpiryCleanupTimer = setInterval(() => {
            this.maybeExpireStaleMarketStores();
        }, Config.marketExpiryCleanupIntervalMs);

        if (typeof this.marketExpiryCleanupTimer.unref === 'function') {
            this.marketExpiryCleanupTimer.unref();
        }

        if (Config.backgroundResolverEnabled !== false) {
            this.reconcileGoalMetadata();
            this.goalMetadataTimer = setInterval(() => {
                this.reconcileGoalMetadata();
            }, Math.max(5000, Number(Config.goalMetadataReconcileIntervalMs) || 30000));

            if (typeof this.goalMetadataTimer.unref === 'function') {
                this.goalMetadataTimer.unref();
            }
        }

        if (Config.warehouseCleanupEnabled !== false) {
            this.nextWarehouseCleanupAt = Date.now() + Math.max(1000, Number(Config.warehouseCleanupStartDelayMs) || 60000);
            this.warehouseCleanupTimer = setInterval(() => {
                this.runWarehouseCleanup();
            }, Math.max(250, Number(Config.warehouseCleanupIntervalMs) || 2000));
            if (typeof this.warehouseCleanupTimer.unref === 'function') this.warehouseCleanupTimer.unref();
        }

        if (Config.stateRetentionEnabled !== false) {
            this.nextStateRetentionAt = Date.now() + Math.max(1000, Number(Config.stateRetentionStartDelayMs) || 90000);
            this.stateRetentionTimer = setInterval(() => {
                this.runStateRetention();
            }, Math.max(250, Number(Config.stateRetentionIntervalMs) || 1000));
            if (typeof this.stateRetentionTimer.unref === 'function') this.stateRetentionTimer.unref();
        }

        const walResetIntervalMs = Math.max(1000, Number(options.default.Database?.checkpointResetIntervalMs) || 5000);
        if (Number(options.default.Database?.checkpointResetWalBytes) > 0) {
            this.walResetTimer = setInterval(() => {
                this.runAdaptiveWalReset();
            }, walResetIntervalMs);
            if (typeof this.walResetTimer.unref === 'function') this.walResetTimer.unref();
        }

        if (Config.backgroundPartyEnabled !== false) {
            this.partyRequestCleanupTimer = setInterval(() => {
                // Request TTL maintenance is deliberately lower priority than
                // party formation while a real player is online. Running it
                // on the formation timer made a single SQLite cleanup query
                // consume most of the player-safe formation budget.
                if (this.partyFormationRunning || this.playerActivityProfile().protected) return;
                this.runPartyRequestCleanup(Config.partyRequestCleanupBatchSize);
            }, Math.max(5000, Number(Config.partyRequestCleanupIntervalMs) || 30000));

            if (typeof this.partyRequestCleanupTimer.unref === 'function') {
                this.partyRequestCleanupTimer.unref();
            }

            this.partyFormationTimer = setInterval(() => {
                this.formBackgroundParties();
            }, Config.partyFormationIntervalMs);

            if (typeof this.partyFormationTimer.unref === 'function') {
                this.partyFormationTimer.unref();
            }
        }

        if (Config.phasePolicyEnabled !== false) {
            this.phasePolicyTimer = setInterval(() => {
                this.tickPhasePolicy();
            }, Config.phasePolicyIntervalMs);

            if (typeof this.phasePolicyTimer.unref === 'function') {
                this.phasePolicyTimer.unref();
            }
        }

        this.scheduleGeneratedColdSeed(Config.generatedColdSeedDelayMs);
        this.schedulePersonaBackfill();

        Director.start();
    },

    stop() {
        const coldStop = ColdSimulationCoordinator.stop();
        if (this.initialSummaryTimer) {
            clearTimeout(this.initialSummaryTimer);
            this.initialSummaryTimer = null;
        }
        if (this.summaryTimer) {
            clearInterval(this.summaryTimer);
            this.summaryTimer = null;
        }
        if (this.schedulerTimer) {
            clearInterval(this.schedulerTimer);
            this.schedulerTimer = null;
        }
        if (this.clanSimulationTimer) {
            clearInterval(this.clanSimulationTimer);
            this.clanSimulationTimer = null;
        }
        if (this.warehouseCleanupTimer) {
            clearInterval(this.warehouseCleanupTimer);
            this.warehouseCleanupTimer = null;
        }
        this.warehouseCleanupRunning = false;
        this.warehouseCleanupCursor = 0;
        this.warehouseCleanupPassUnits = 0;
        this.nextWarehouseCleanupAt = 0;
        if (this.stateRetentionTimer) {
            clearInterval(this.stateRetentionTimer);
            this.stateRetentionTimer = null;
        }
        this.stateRetentionRunning = false;
        this.stateRetentionPassRows = 0;
        this.nextStateRetentionAt = 0;
        if (this.walResetTimer) {
            clearInterval(this.walResetTimer);
            this.walResetTimer = null;
        }
        this.walResetRunning = false;
        this.nextWalResetAt = 0;
        this.lastWalResetResult = null;
        PersistentStateRetention.reset();
        if (this.partyFormationTimer) {
            clearInterval(this.partyFormationTimer);
            this.partyFormationTimer = null;
        }
        if (this.partyRequestCleanupTimer) {
            clearInterval(this.partyRequestCleanupTimer);
            this.partyRequestCleanupTimer = null;
        }
        if (this.phasePolicyTimer) {
            clearInterval(this.phasePolicyTimer);
            this.phasePolicyTimer = null;
        }
        if (this.seedTimer) {
            clearTimeout(this.seedTimer);
            this.seedTimer = null;
        }
        if (this.classProgressionMigrationTimer) {
            clearInterval(this.classProgressionMigrationTimer);
            this.classProgressionMigrationTimer = null;
        }
        this.nextColdCombatProfileMigrationAt = 0;
        if (this.marketTownMigrationTimer) {
            clearInterval(this.marketTownMigrationTimer);
            this.marketTownMigrationTimer = null;
        }
        if (this.marketExpiryCleanupTimer) {
            clearInterval(this.marketExpiryCleanupTimer);
            this.marketExpiryCleanupTimer = null;
        }
        if (this.goalMetadataTimer) {
            clearInterval(this.goalMetadataTimer);
            this.goalMetadataTimer = null;
        }
        this.goalMetadataRunning = false;
        this.partyRequestCleanupRunning = false;
        if (this.personaBackfillTimer) {
            clearInterval(this.personaBackfillTimer);
            this.personaBackfillTimer = null;
        }
        this.personaBackfillRunning = false;
        Director.stop();
        Metrics.stopEventLoopMonitor();
        this.started = false;
        return coldStop;
    },

    scheduleGeneratedColdSeed(delayMs = Config.generatedColdSeedDelayMs) {
        if (Config.enabled === false || Config.maxPlayingPopulation <= 0 || this.seedTimer) return;

        this.seedTimer = setTimeout(() => {
            this.seedTimer = null;
            GeneratedColdSeeder.seedPopulation().then((result) => {
                if (result.seeded > 0) {
                    console.info(
                        'BotPopulation :: population wave=%d seeded=%d created=%d total=%d/%d target=%d avgLevel=%s starterSpots=%d',
                        result.wave || 1,
                        result.seeded,
                        result.created,
                        result.total,
                        result.limit,
                        result.targetPopulation || result.limit,
                        Number(result.averageLevel || 0).toFixed(1),
                        result.eligible || 0
                    );
                }

                // Keep checking the next wave: once the mean bot level crosses
                // another five-level threshold, newly opened grounds are filled.
                if (this.started && result.limit > 0 && result.total < result.limit && !result.error) {
                    this.scheduleGeneratedColdSeed(Config.generatedColdSeedDelayMs);
                }
            });
        }, Math.max(1000, Number(delayMs || 0)));

        if (typeof this.seedTimer.unref === 'function') {
            this.seedTimer.unref();
        }
    },

    schedulePersonaBackfill() {
        if (this.personaBackfillTimer) return;

        const run = () => {
            if (this.personaBackfillRunning) return;
            if (this.playerActivityProfile().protected) {
                Metrics.recordBackgroundDeferral();
                return;
            }
            this.personaBackfillRunning = true;
            BotPersona.backfillGenerated().then((result) => {
                // Only a successful short read closes this one-time migration.
                // A failed write stays scheduled for a later retry.
                if (result.exhausted && this.personaBackfillTimer) {
                    clearInterval(this.personaBackfillTimer);
                    this.personaBackfillTimer = null;
                }
            }).finally(() => {
                this.personaBackfillRunning = false;
            });
        };

        run();
        this.personaBackfillTimer = setInterval(run, 2000);
        if (typeof this.personaBackfillTimer.unref === 'function') {
            this.personaBackfillTimer.unref();
        }
    },

    migrateLegacyClassProgression() {
        // Database uses one ordered connection. Never queue a migration behind
        // an active resolver: a skipped migration tick is harmless, but a
        // queued one can stretch the normal world loop into a long backlog.
        if (this.playerActivityProfile().protected) {
            Metrics.recordBackgroundDeferral();
            return Promise.resolve([]);
        }
        if (this.classProgressionMigrationRunning || this.resolving || Config.enabled === false) return Promise.resolve([]);
        this.classProgressionMigrationRunning = true;
        return LifeState.migrateLegacyClassProgression(Config.classProgressionMigrationBatchSize)
            .then((migrated) => {
                if (migrated.length) {
                    console.info('BotPopulation :: migrated class progression for %d cold bot(s)', migrated.length);
                }
                return migrated;
            })
            .catch((err) => {
                utils.infoWarn('BotPopulation', 'legacy class progression migration failed: %s', err.message);
                return [];
            })
            .finally(() => {
                this.classProgressionMigrationRunning = false;
            });
    },

    migrateLegacyColdCombatProfiles() {
        if (this.playerActivityProfile().protected) {
            Metrics.recordBackgroundDeferral();
            return Promise.resolve([]);
        }
        if (this.coldCombatProfileMigrationRunning || this.resolving || this.classProgressionMigrationRunning || Config.enabled === false) {
            return Promise.resolve([]);
        }
        this.coldCombatProfileMigrationRunning = true;
        return LifeState.migrateLegacyColdCombatProfiles(Config.coldCombatProfileMigrationBatchSize)
            .then((migrated) => {
                if (migrated.length) {
                    console.info('BotPopulation :: migrated cold combat profiles for %d bot(s)', migrated.length);
                }
                return migrated;
            })
            .catch((err) => {
                utils.infoWarn('BotPopulation', 'legacy cold combat profile migration failed: %s', err.message);
                return [];
            })
            .finally(() => {
                this.coldCombatProfileMigrationRunning = false;
            });
    },

    maybeMigrateLegacyColdCombatProfiles(timestamp = Date.now()) {
        if (this.coldCombatProfileMigrationRunning || timestamp < this.nextColdCombatProfileMigrationAt) {
            return Promise.resolve([]);
        }
        this.nextColdCombatProfileMigrationAt = timestamp + Config.coldCombatProfileMigrationIntervalMs;
        return this.migrateLegacyColdCombatProfiles();
    },

    migrateLegacyMarketTowns() {
        // This migration is deliberately bounded and serialized. Do not gate
        // it on `resolving`: both timers share a 10-second cadence, which can
        // otherwise starve the transition forever while the resolver is live.
        if (this.playerActivityProfile().protected) {
            Metrics.recordBackgroundDeferral();
            return Promise.resolve([]);
        }
        if (this.marketTownMigrationRunning || Config.enabled === false) return Promise.resolve([]);
        this.marketTownMigrationRunning = true;
        return ColdMarketListingService.migrateLegacyMarketTowns(Config.marketTownMigrationBatchSize)
            .then((migrated) => {
                const relocated = migrated.filter((entry) => entry.relocated).length;
                if (migrated.length) {
                    console.info('BotPopulation :: migrated market towns checked=%d relocated=%d', migrated.length, relocated);
                }
                return migrated;
            })
            .catch((err) => {
                utils.infoWarn('BotPopulation', 'legacy market-town migration failed: %s', err.message);
                return [];
            })
            .finally(() => {
                this.marketTownMigrationRunning = false;
            });
    },

    maybeMigrateLegacyMarketTowns(timestamp = Date.now()) {
        if (this.marketTownMigrationRunning || timestamp < this.nextMarketTownMigrationAt) return Promise.resolve([]);
        this.nextMarketTownMigrationAt = timestamp + Config.marketTownMigrationIntervalMs;
        return this.migrateLegacyMarketTowns();
    },

    expireStaleMarketStores(timestamp = Date.now()) {
        if (this.playerActivityProfile(timestamp).protected) {
            Metrics.recordBackgroundDeferral();
            return Promise.resolve([]);
        }
        if (this.marketExpiryCleanupRunning || Config.enabled === false) return Promise.resolve([]);
        this.marketExpiryCleanupRunning = true;
        const World = invoke('GameServer/World/World');
        const hotSessions = (World.user?.sessions || []).filter((session) => (
            session?.actor
            && session?.coldMarketState?.stats?.marketStore
        ));
        return ColdMarketListingService.maintainHotMarketStores(hotSessions, Config.marketExpiryCleanupBatchSize, timestamp)
            .then((hotMaintained) => ColdMarketListingService.expireStaleMarketStores(Config.marketExpiryCleanupBatchSize, timestamp)
                .then((coldMaintained) => [...hotMaintained, ...coldMaintained]))
            .then((maintained) => {
                if (maintained.length) {
                    const closed = maintained.filter((result) => result.closed).length;
                    const revalidated = maintained.filter((result) => result.revalidated).length;
                    console.info('BotPopulation :: market stores maintained=%d closed=%d revalidated=%d', maintained.length, closed, revalidated);
                }
                return maintained;
            })
            .catch((err) => {
                utils.infoWarn('BotPopulation', 'expired market cleanup failed: %s', err.message);
                return [];
            })
            .finally(() => {
                this.marketExpiryCleanupRunning = false;
            });
    },

    maybeExpireStaleMarketStores(timestamp = Date.now()) {
        if (this.marketExpiryCleanupRunning || timestamp < this.nextMarketExpiryCleanupAt) return Promise.resolve([]);
        this.nextMarketExpiryCleanupAt = timestamp + Config.marketExpiryCleanupIntervalMs;
        return this.expireStaleMarketStores(timestamp);
    },

    recordHotTick(session) {
        if (Config.enabled === false) return;
        if (!session || !session.accountId || !String(session.accountId).startsWith('bot_')) return;
        Metrics.recordHotTick();
    },

    markHot(session, reason = 'hot') {
        if (Config.enabled === false) return Promise.resolve(null);
        return LifeState.markHot(session, reason);
    },

    cooldownSession(session, reason = 'manual', options = {}) {
        if (Config.enabled === false) return Promise.resolve({ ok: false, reason: 'disabled' });
        return Cooldown.cooldown(session, reason, options);
    },

    requestActivation(stateOrName, reason = 'manual', options = {}) {
        if (Config.enabled === false) return Promise.resolve({ ok: false, reason: 'disabled' });
        return HotActivation.activate(stateOrName, reason, options);
    },

    tickPhasePolicy() {
        if (this.phasePolicyRunning || Config.enabled === false || Config.phasePolicyEnabled === false) {
            return Promise.resolve({ cooled: [], activated: [] });
        }

        this.phasePolicyRunning = true;
        return this.activateNearPlayers()
            .then((activated) => this.cooldownEligibleHot().then((cooled) => ({ activated, cooled })))
            .catch((err) => {
                utils.infoWarn('BotPopulation', 'phase policy failed: %s', err.message);
                return { activated: [], cooled: [] };
            })
            .finally(() => {
                this.phasePolicyRunning = false;
            });
    },

    realPlayerSessions() {
        const World = invoke('GameServer/World/World');
        return (World.user?.sessions || []).filter(PlayerActivitySignal.isRealPlayerSession);
    },

    playerActivityProfile(timestamp = Date.now()) {
        let sessions = [];
        let realPlayers = [];
        try {
            sessions = invoke('GameServer/World/World').user?.sessions || [];
            realPlayers = this.realPlayerSessions();
        } catch (err) {
            sessions = [];
            realPlayers = [];
        }
        return PlayerActivitySignal.observe({
            sessions,
            realPlayers,
            now: timestamp,
            graceMs: Config.playerProtectionGraceMs
        });
    },

    refreshSchedulerTelemetry() {
        if (Config.enabled === false || Config.backgroundResolverEnabled === false) return null;
        const profile = this.schedulerProfile();
        Metrics.recordSchedulerProfile(profile);
        return profile;
    },

    resolveClanSimulation() {
        if (this.clanSimulationRunning || ClanSimulationConfig.enabled === false) return Promise.resolve(null);
        const activity = this.playerActivityProfile();
        if (activity?.protected) return Promise.resolve({ deferred: true, reason: 'player_protection' });

        this.clanSimulationRunning = true;
        const startedAt = Date.now();
        return ClanSimulationService.resolveBatch(ClanSimulationConfig.resolveBatchSize, {
            budgetMs: ClanSimulationConfig.resolveBudgetMs
        }).then((founder) => ClanEconomyService.resolveBatch(ClanSimulationConfig.resolveBatchSize, {
            budgetMs: Math.max(1, ClanSimulationConfig.resolveBudgetMs - (Date.now() - startedAt))
        }).then((economy) => ClanGoalService.resolveBatch(ClanSimulationConfig.resolveBatchSize, {
            budgetMs: Math.max(1, ClanSimulationConfig.resolveBudgetMs - (Date.now() - startedAt))
        }).then((goals) => ClanMarketService.resolveBatch(ClanSimulationConfig.resolveBatchSize, {
            budgetMs: Math.max(1, ClanSimulationConfig.resolveBudgetMs - (Date.now() - startedAt))
        }).then((market) => ClanPartyService.resolveBatch(ClanSimulationConfig.resolveBatchSize, {
            budgetMs: Math.max(1, ClanSimulationConfig.resolveBudgetMs - (Date.now() - startedAt))
        }).then((party) => ({ founder, economy, goals, market, party })))))).catch((error) => {
            utils.infoWarn('ClanSimulation', 'bounded resolve failed: %s', error.message);
            return {
                founder: { attempted: 0, created: 0, joined: 0, blocked: 0 },
                economy: { attempted: 0, levelUps: 0, contributions: 0, blocked: 0 },
                goals: { attempted: 0, changed: 0, completed: 0 },
                market: { attempted: 0, purchases: 0, deposited: 0, levelUps: 0, blocked: 0 },
                party: { attempted: 0, started: 0, resolved: 0, succeeded: 0, failed: 0 },
                error: error.message
            };
        }).finally(() => {
            this.clanSimulationRunning = false;
        });
    },

    reconcileGoalMetadata() {
        if (this.goalMetadataRunning || Config.enabled === false || Config.backgroundResolverEnabled === false) {
            return Promise.resolve([]);
        }
        const activity = this.playerActivityProfile();
        const lagMs = Math.max(0, Number(Metrics.currentEventLoopLag()) || 0);
        const lagAbort = Math.max(0, Number(Config.schedulerLagAbortMs) || 0);
        if (lagAbort > 0 && lagMs >= lagAbort) {
            Metrics.recordBackgroundDeferral();
            return Promise.resolve([]);
        }

        const protectedPass = !!activity?.protected;
        const batchSize = Math.max(1, Number(protectedPass
            ? Config.goalMetadataPlayerBatchSize
            : Config.goalMetadataIdleBatchSize) || (protectedPass ? 2 : 8));
        const budgetMs = Math.max(25, Number(protectedPass
            ? Config.goalMetadataPlayerBudgetMs
            : Config.goalMetadataIdleBudgetMs) || (protectedPass ? 75 : 500));
        const deadlineAt = Date.now() + budgetMs;
        const staleDeadlineAt = Date.now() + Math.max(25, Math.floor(budgetMs / 2));
        this.goalMetadataRunning = true;

        const reviewStale = () => {
            if (Date.now() >= staleDeadlineAt) return Promise.resolve([]);
            return LifeState.staleGoalCandidates(batchSize, Date.now()).then((states) => (
                this.runInSchedulerSlices(states, (state) => GoalService.review(state).catch((error) => {
                    utils.infoWarn('BotGoals', 'bounded metadata review failed for %s: %s', state.name, error?.message || error);
                    return null;
                }), staleDeadlineAt)
            ));
        };

        return reviewStale()
            .then((staleResults) => this.releaseWarehouseMaterials(deadlineAt).then((warehouseResults) => ({
                staleResults,
                warehouseResults
            })))
            .then(({ staleResults, warehouseResults }) => this.reconcileMarketGoals(deadlineAt, batchSize).then((marketResults) => [
                ...staleResults,
                ...warehouseResults,
                ...marketResults
            ]))
            .catch((error) => {
                utils.infoWarn('BotGoals', 'bounded metadata reconcile failed: %s', error?.message || error);
                return [];
            })
            .finally(() => {
                this.goalMetadataRunning = false;
            });
    },

    isRestingActivationState(state) {
        const activity = state?.activity || 'hunting';
        if (activity === 'resting' || activity === 'dead') return true;

        const vitals = state?.vitals || {};
        const hpPct = Number(vitals.hp || 0) / Math.max(1, Number(vitals.maxHp || vitals.hp || 1));
        const mpPct = Number(vitals.mp || 0) / Math.max(1, Number(vitals.maxMp || vitals.mp || 1));
        return hpPct < 0.35 || mpPct < 0.20;
    },

    activateNearPlayers() {
        const players = this.realPlayerSessions();
        if (players.length === 0) return Promise.resolve([]);

        const BotManager = invoke('GameServer/Bot/BotManager');
        const activated = [];
        const ambientActivated = [];
        let chain = Promise.resolve();

        players.forEach((playerSession) => {
            chain = chain.then(() => {
                const actor = playerSession.actor;
                const loc = {
                    locX: actor.fetchLocX(),
                    locY: actor.fetchLocY(),
                    locZ: actor.fetchLocZ()
                };
                const existingNearby = nearbyHotCount(BotManager.sessions, actor);
                const densityDeficit = Math.max(0, Config.nearPlayerHotTarget - existingNearby);
                // Craft shops are persistent town infrastructure. They must not
                // compete with the ambient-density budget, otherwise a full row
                // of public stations can only appear in several policy ticks.
                return LifeState.coldNear(loc, Config.activationRadius, 100)
                    .then((states) => {
                        // A cold traveller has no hot equivalent for its
                        // persisted route. Keep it cold until its resolver
                        // reaches the destination, instead of spawning a
                        // hunter/resting bot stranded on a road or plaza.
                        // A persisted background party is one lifecycle unit.
                        // Ambient visibility must not materialize one member
                        // as a solo hot bot and silently dissolve the group.
                        const available = states.filter((state) => (
                            !['pk_hunting', 'traveling'].includes(state.activity) &&
                            !state.stats?.supplyErrand &&
                            !state.party?.partyId
                        ));
                        const merchants = available.filter((state) => state.activity === 'merchant' && state.stats?.marketStore);
                        const crafters = available.filter((state) => state.activity === 'crafting' && state.stats?.craftShop);
                        const ambientRemaining = Math.min(
                            Math.max(0, Config.maxActivationsPerScan - ambientActivated.length),
                            Math.max(0, densityDeficit - crafters.length)
                        );
                        const candidates = [...crafters, ...merchants, ...activationCandidatesForPlayer(
                            available.filter((state) => state.activity !== 'merchant' && state.activity !== 'crafting'),
                            actor.fetchLevel()
                        )].slice(0, crafters.length + ambientRemaining);
                        const floorAware = FloorAwareActivationPolicy.filterCandidates(candidates, {
                            playerLoc: loc,
                            reason: 'near_player'
                        }).accepted;
                        return floorAware.reduce((stateChain, state) => (
                            stateChain.then(() => {
                                return this.requestActivation(state, 'near_player', {
                                    recoverOnActivation: this.isRestingActivationState(state),
                                    readyOnActivation: true,
                                    keepStoreLocation: (state.activity === 'merchant' && !!state.stats?.marketStore)
                                        || (state.activity === 'crafting' && !!state.stats?.craftShop),
                                    playerLoc: loc
                                });
                            }).then((result) => {
                                if (result.ok) {
                                    activated.push(result);
                                    if (state.activity !== 'crafting' || !state.stats?.craftShop) ambientActivated.push(result);
                                }
                            })
                        ), Promise.resolve());
                    });
            });
        });

        return chain.then(() => activated);
    },

    cooldownEligibleHot() {
        const BotManager = invoke('GameServer/Bot/BotManager');
        const now = Date.now();
        const players = this.realPlayerSessions();
        const cooldownRadius = Math.max(Config.cooldownRadius, Config.activationRadius);
        const candidates = BotManager.sessions
            .filter((session) => session.actor && session.accountId && String(session.accountId).startsWith('bot_'))
            .filter((session) => {
                if (session.chatArrivalActive) return false;
                if (session.plan === 'merchant' && !session.coldMarketState && !session.coldCraftState) return false;
                // Red-name bots are part of the visible PK population, not
                // disposable ambient population. Keep them hot until their
                // karma is genuinely cleared.
                if (session.actor.fetchKarma?.() > 0) return false;
                if (session.partyCompanion === true || session.followPlayerSession) return false;
                const lastHotAt = session.populationHotAt || 0;
                if (lastHotAt && now - lastHotAt < Config.cooldownGraceMs) return false;
                if (players.length === 0) return true;
                return players.every((playerSession) => (
                    distance2d(session.actor, playerSession.actor) > cooldownRadius
                ));
            })
            .sort((a, b) => {
                const aDistance = players.length
                    ? Math.min(...players.map((player) => distance2d(a.actor, player.actor)))
                    : Infinity;
                const bDistance = players.length
                    ? Math.min(...players.map((player) => distance2d(b.actor, player.actor)))
                    : Infinity;
                return bDistance - aDistance;
            })
            .slice(0, Config.cooldownBatchSize);

        return candidates.reduce((chain, session) => (
            chain.then((results) => this.cooldownSession(session, 'policy').then((result) => {
                if (result.ok) results.push(result);
                return results;
            }))
        ), Promise.resolve([]));
    },

    cleanupStalePartyRequests(timestamp = Date.now(), batchSize = Config.partyRequestCleanupBatchSize) {
        const cleanupInterval = Math.max(5000, Number(Config.partyRequestCleanupIntervalMs) || 30000);
        if (timestamp < this.nextPartyRequestCleanupAt) return Promise.resolve(0);
        return LifeState.expireStalePartyRequests(Math.max(1, Number(batchSize) || Config.partyRequestCleanupBatchSize))
            .catch((error) => {
                utils.infoWarn('BotPopulation', 'party request cleanup failed: %s', error?.message || error);
                return 0;
            })
            .finally(() => {
                this.nextPartyRequestCleanupAt = Date.now() + cleanupInterval;
            });
    },

    runPartyRequestCleanup(batchSize = Config.partyRequestCleanupBatchSize) {
        if (this.partyRequestCleanupRunning) return Promise.resolve(0);
        this.partyRequestCleanupRunning = true;
        return this.cleanupStalePartyRequests(Date.now(), batchSize)
            .finally(() => {
                this.partyRequestCleanupRunning = false;
            });
    },

    formBackgroundParties() {
        // Formation rewrites party membership.  It must not overlap with the
        // scheduler after that scheduler has already selected solo candidates.
        // Player protection limits this work; it no longer disables the queue
        // or its TTL cleanup completely.
        if (this.partyFormationRunning || Config.enabled === false || Config.backgroundPartyEnabled === false) {
            return Promise.resolve([]);
        }
        const activity = this.playerActivityProfile();
        if (this.partyRequestCleanupRunning) {
            this.partyFormationPending = true;
            return Promise.resolve([]);
        }
        if (this.resolving) {
            // Keep the cleanup independent from the resolver. Formation will
            // be retried by the interval after the current pass is complete.
            this.partyFormationPending = true;
            return activity.protected
                ? Promise.resolve([])
                : this.runPartyRequestCleanup(Config.partyRequestCleanupBatchSize).then(() => []);
        }

        const formationBudgetMs = this.partyFormationBudgetMs(activity);
        if (formationBudgetMs <= 0) {
            Metrics.recordPartyFormationDeferral();
            return activity.protected
                ? Promise.resolve([])
                : this.runPartyRequestCleanup(Config.partyRequestCleanupBatchSize).then(() => []);
        }

        this.partyFormationRunning = true;
        this.partyFormationPending = false;
        // A live player gets the whole formation budget. Cleanup runs from
        // its own low-priority timer and must not sit in front of the
        // candidate query in this critical path.
        const cleanup = activity.protected
            ? Promise.resolve(0)
            : this.runPartyRequestCleanup(Config.partyRequestCleanupBatchSize);
        const startedAt = Date.now();
        const deadlineAt = startedAt + formationBudgetMs;
        let budgetStopRecorded = false;
        const budgetReached = () => {
            if (Date.now() < deadlineAt) return false;
            if (!budgetStopRecorded) {
                budgetStopRecorded = true;
                Metrics.recordPartyFormationBudgetStop();
            }
            return true;
        };
        const timedStage = (name, work) => {
            const stageStartedAt = Date.now();
            return Promise.resolve().then(work).finally(() => {
                Metrics.recordPartyFormationStage(name, Date.now() - stageStartedAt);
            });
        };
        const formationWork = () => {
            return timedStage('cleanup', () => cleanup)
            // Discovery covers the complete eligible pool. Full inventory and
            // cold-combat state are hydrated only for selected members.
            .then(() => timedStage('candidate_projection', () => LifeState.coldPartyCandidateProjections()
                .then((states) => ({
                    states,
                    partyRequestBacklog: states.some((state) => state.stats?.partyRequest?.status === 'open'),
                    requiredPartyRequestCount: states.filter((state) => (
                        state.stats?.partyRequest?.status === 'open'
                        && state.stats?.partyRequest?.priority === 'required'
                    )).length
                }))))
            .then(({ states, partyRequestBacklog, requiredPartyRequestCount }) => {
                const willingStates = states.filter((state) => PersonaPartyPolicy.backgroundIntent(state).accept);
                const requiredStates = willingStates.filter((state) => (
                    state.stats?.partyRequest?.status === 'open'
                    && state.stats?.partyRequest?.priority === 'required'
                ));
                const reclaim = activity.protected
                    ? Promise.resolve([])
                    : this.reclaimBackgroundPartyCapacity(requiredStates, requiredPartyRequestCount, {
                        deadlineAt,
                        markBudgetStop: () => budgetReached()
                    });
                const recruit = activity.protected
                    ? Promise.resolve(new Set())
                    : reclaim.then(() => this.recruitBackgroundMembers(willingStates, {
                        deadlineAt,
                        markBudgetStop: () => budgetReached()
                    }));
                return reclaim.then(() => recruit).then((recruitedIds) => ({
                    states: willingStates.filter((state) => !recruitedIds.has(Number(state.characterId))),
                    partyRequestBacklog,
                    requiredPartyRequestCount
                }));
            })
            .then(({ states, partyRequestBacklog, requiredPartyRequestCount }) => {
                const activeParties = BackgroundPartyState.counts().active || 0;
                const slots = Math.max(0, maxBackgroundPartiesForBacklog(requiredPartyRequestCount) - activeParties);
                if (slots <= 0) return [];
                // A live player keeps a small formation reserve, but that
                // reserve must not turn into a burst of simultaneous party
                // writes while the foreground session is active.
                const maxNewParties = Math.min(
                    slots,
                    Config.partyFormationBatchSize,
                    activity.protected ? 1 : Config.partyFormationBatchSize
                );
                const activePartiesBySpot = BackgroundPartyState.active().reduce((counts, party) => {
                    const spotId = String(party.spotId || '');
                    if (spotId) counts.set(spotId, Number(counts.get(spotId) || 0) + 1);
                    return counts;
                }, new Map());
                const groups = this.groupPartyCandidatesByObjective(states, { prioritizePartyWait: partyRequestBacklog, activePartiesBySpot });
                const created = [];

                return groups.reduce((chain, group) => chain.then(() => {
                    if (created.length >= maxNewParties || budgetReached()) return null;
                    if (group.length < Config.partyMinSize) return null;

                    const selectedMembers = PartyComposition.selectMembers(group, {
                        minSize: Config.partyMinSize,
                        maxSize: Config.partyMaxSize
                    });
                    if (selectedMembers.length < Config.partyMinSize) {
                        const requiredIds = group
                            .filter((state) => state.stats?.partyRequest?.status === 'open'
                                && state.stats?.partyRequest?.priority === 'required')
                            .map((state) => state.characterId);
                        return LifeState.deferUnformablePartyRequests(requiredIds, 'no_compatible_level_match')
                            .catch((error) => {
                                utils.infoWarn('BotPopulation', 'failed to defer unformable party requests: %s', error?.message || error);
                                return 0;
                            });
                    }
                    return timedStage('candidate_hydration', () => hydratePartyCandidates(selectedMembers)).then((members) => {
                        if (members.length !== selectedMembers.length) return null;
                        const leader = PartyComposition.chooseLeader(members);
                        const objectiveMember = members.find((member) => (
                            member.stats?.partyRequest?.status === 'open'
                            && member.stats?.partyRequest?.priority === 'required'
                        )) || members.find((member) => partyObjectiveForState(member)) || leader;
                        const objective = partyObjectiveForState(objectiveMember);
                        const partySpot = partySpotForLeader(leader, objective?.spotId || null);
                        const partyId = `bgp_${Date.now().toString(36)}_${leader.characterId}`;
                        const nextResolveAt = Date.now() + 45000 + Math.round(Math.random() * 90000);
                        const coverage = PartyComposition.roleCoverage(members);
                        const party = {
                            partyId,
                            leaderId: leader.characterId,
                            memberIds: members.map((state) => state.characterId),
                            spotId: partySpot?.id || leader.spotId,
                            startedAt: Date.now(),
                            nextResolveAt,
                            cohesion: 0.55 + Math.random() * 0.25,
                            risk: 0.18 + Math.random() * 0.22,
                            roleCoverage: coverage,
                            stats: {
                                formedAt: Date.now(),
                                memberNames: members.map((state) => state.name),
                                personaFormation: Object.fromEntries(members.map((member) => [
                                    member.characterId,
                                    PersonaPartyPolicy.explain(member, members.filter((peer) => peer !== member), coverage)
                                ])),
                                route: partySpot?.route || null,
                                objective: objective || null,
                                acquisitionGoal: objectiveMember.stats?.equipmentPlan?.status === 'active'
                                    ? objectiveMember.stats.equipmentPlan
                                    : null
                            }
                        };
                        const partyEvent = {
                            characterId: leader.characterId,
                            eventType: 'party',
                            summary: `${leader.name} formed a party near ${party.spotId}`,
                            meta: {
                                partyId,
                                spotId: party.spotId,
                                memberIds: party.memberIds,
                                route: party.stats.route
                            },
                            weight: 2,
                            createdAt: Date.now()
                        };

                        return timedStage('party_commit', () => commitPartyMembership(party, members, partyEvent)).then(({ party: savedParty, assigned, failed, eventCommitted }) => {
                            if (!savedParty || failed.length || assigned.length !== members.length) {
                                return savedParty
                                    ? dissolveBackgroundParty(savedParty, 'party_assignment_failed', assigned.length).then(() => null)
                                    : null;
                            }
                            const eventWrite = eventCommitted
                                ? Promise.resolve()
                                : LifeEvents.record(
                                    partyEvent.characterId,
                                    partyEvent.eventType,
                                    partyEvent.summary,
                                    partyEvent.meta,
                                    partyEvent.weight
                                );
                            return eventWrite.then(() => {
                                Metrics.recordPartyFormation();
                                created.push(savedParty);
                                console.info(
                                    'BotPopulation :: formed background party %s spot=%s members=%d leader=%s',
                                    savedParty.partyId,
                                    savedParty.spotId || 'none',
                                    savedParty.memberIds.length,
                                    leader.name
                                );
                                return savedParty;
                            });
                        });
                    });
                }), Promise.resolve()).then(() => created);
            });
        };
        return Database.cooperatively(formationWork, Config.partyFormationSliceMs)
            .catch((err) => {
                utils.infoWarn('BotPopulation', 'background party formation failed: %s', err.message);
                return [];
            })
            .finally(() => {
                Metrics.recordPartyFormationDuration(Date.now() - startedAt);
                this.partyFormationRunning = false;
            });
    },

    groupPartyCandidatesBySpot(states = [], options = {}) {
        return groupBySpot(states, options);
    },

    partyFormationBudgetMs(activity = this.playerActivityProfile()) {
        const baseBudget = activity?.protected
            ? Number(Config.partyFormationPlayerBudgetMs) || 600
            : Number(Config.partyFormationIdleBudgetMs) || 500;
        const lagMs = Math.max(0, Number(Metrics.currentEventLoopLag()) || 0);
        const lagThrottle = Math.max(0, Number(Config.schedulerLagThrottleMs) || 0);
        const lagAbort = Math.max(0, Number(Config.schedulerLagAbortMs) || 0);
        if (lagAbort > 0 && lagMs >= lagAbort) return 0;
        if (lagAbort > lagThrottle && lagMs > lagThrottle) {
            const pressure = Math.min(1, (lagMs - lagThrottle) / (lagAbort - lagThrottle));
            return Math.max(25, Math.round(baseBudget * (1 - pressure)));
        }
        if (lagAbort === 0 && lagThrottle > 0 && lagMs > lagThrottle) {
            const pressure = Math.min(1, (lagMs - lagThrottle) / lagThrottle);
            return Math.max(25, Math.round(baseBudget * (1 - pressure)));
        }
        return Math.max(25, baseBudget);
    },

    schedulerProfile() {
        const activity = this.playerActivityProfile();
        const idle = !activity.protected;
        const lagMs = Math.max(0, Number(Metrics.currentEventLoopLag()) || 0);
        const configured = idle
            ? Config.schedulerIdleBudgetMs
            : activity.activeParty ? Config.schedulerPartyBudgetMs : Config.schedulerPlayerBudgetMs;
        const baseBudget = Math.max(25, Number(configured) || 250);
        const lagThrottle = Math.max(0, Number(Config.schedulerLagThrottleMs) || 0);
        const lagAbort = Math.max(0, Number(Config.schedulerLagAbortMs) || 0);
        let budget = baseBudget;

        if (lagAbort > 0 && lagMs >= lagAbort) {
            budget = 0;
        } else if (lagAbort > lagThrottle && lagMs > lagThrottle) {
            const pressure = Math.min(1, (lagMs - lagThrottle) / (lagAbort - lagThrottle));
            budget = Math.round(baseBudget * (1 - pressure));
        } else if (lagAbort === 0 && lagThrottle > 0 && lagMs > lagThrottle) {
            const pressure = Math.min(1, (lagMs - lagThrottle) / lagThrottle);
            budget = Math.round(baseBudget * (1 - pressure));
        }

        return {
            idle,
            players: activity.realPlayers,
            activity,
            lagMs,
            budgetMs: budget > 0
                ? Math.min(budget, Math.max(25, Config.schedulerIntervalMs - 25))
                : 0,
            maxResolvesPerTick: Math.min(100, Math.max(1, Number(idle
                ? Config.schedulerIdleMaxResolvesPerTick
                : Config.schedulerPlayerMaxResolvesPerTick) || 25)),
            allowBackgroundParties: !activity.protected,
            allowAuxiliaryBackground: !activity.protected
        };
    },

    schedulerBudgetMs() {
        return this.schedulerProfile().budgetMs;
    },

    groupPartyCandidatesByObjective(states = [], options = {}) {
        const grouped = new Map();
        (states || []).forEach((state) => {
            const key = partyObjectiveKeyForState(state);
            if (!grouped.has(key)) grouped.set(key, []);
            grouped.get(key).push(state);
        });
        return Array.from(grouped.entries())
            .map(([key, group]) => ({
                key,
                spotId: partyObjectiveSpotForState(group[0]),
                states: group.sort((a, b) => Number(a.level || 1) - Number(b.level || 1)),
                partyWaiters: group.filter((state) => state.activity === 'party_wait'
                    || state.stats?.partyRequest?.status === 'open').length
            }))
            .sort((a, b) => {
                if (options.prioritizePartyWait && a.partyWaiters !== b.partyWaiters) {
                    return b.partyWaiters - a.partyWaiters;
                }
                const aActive = Number(options.activePartiesBySpot?.get(a.spotId) || 0);
                const bActive = Number(options.activePartiesBySpot?.get(b.spotId) || 0);
                if (aActive !== bActive) return aActive - bActive;
                return b.states.length - a.states.length;
            })
            .map((group) => group.states);
    },

    maxBackgroundPartiesForBacklog,
    partySessionExpired,
    partyRequestForPlan,
    partyObjectiveForState,
    expirePartyRequestForState,

    refreshBackgroundPartyRequirements(parties = [], options = {}) {
        const timestamp = Date.now();
        const deadlineAt = Number(options.deadlineAt || Infinity);
        const budgetReached = () => {
            if (Date.now() < deadlineAt) return false;
            options.markBudgetStop?.();
            return true;
        };
        const refreshMs = Math.max(1000, Number(Config.partyRequirementRefreshMs) || 5 * 60 * 1000);
        const batchSize = Math.max(1, Number(Config.partyRequirementRefreshBatchSize) || 8);
        const refreshable = (parties || [])
            .filter((party) => timestamp - Number(party.stats?.lastRequirementRefreshAt || 0) >= refreshMs)
            .sort((a, b) => Number(a.stats?.lastRequirementRefreshAt || 0) - Number(b.stats?.lastRequirementRefreshAt || 0))
            .slice(0, batchSize);
        if (!refreshable.length) return Promise.resolve([]);

        let spots = [];
        try {
            spots = SpotProfiles.ensure();
        } catch (err) {
            // Unit/integration harnesses may not load the world spot index;
            // keep the refresh best-effort and let the normal party resolver
            // retry it on the next formation pass.
            utils.infoWarn('BotPopulation', 'party requirement refresh spot index unavailable: %s', err.message);
            return Promise.resolve([]);
        }
        return statesForParties(refreshable.map((party) => party.partyId)).then((membersByParty) => refreshable.reduce((chain, party) => chain.then(async (refreshed) => {
            if (budgetReached()) return refreshed;
            const members = membersByParty.get(String(party.partyId)) || [];
            let changed = false;
            const refreshedPlans = new Map();
            for (const member of members) {
                if (budgetReached()) return refreshed;
                const previousPlan = member.stats?.equipmentPlan;
                let nextPlan;
                try {
                    nextPlan = GearAcquisitionPlanner.planFor(member, { spots });
                } catch (err) {
                    utils.infoWarn('BotPopulation', 'party requirement refresh failed for %s: %s', member.name, err.message);
                    continue;
                }
                refreshedPlans.set(Number(member.characterId), nextPlan);
                if (acquisitionRequirementKey(previousPlan) === acquisitionRequirementKey(nextPlan)) continue;
                const nextState = {
                    ...member,
                    stats: { ...(member.stats || {}), equipmentPlan: nextPlan }
                };
                const saved = await LifeState.upsertState(nextState, 'party_requirement_refresh');
                changed = changed || !!saved;
            }
            const refreshedMembers = members.map((member) => {
                const nextPlan = refreshedPlans.get(Number(member.characterId)) || member.stats?.equipmentPlan;
                return nextPlan ? { ...member, stats: { ...(member.stats || {}), equipmentPlan: nextPlan } } : member;
            });
            const releasable = party.stats?.objective?.priority === 'required'
                ? refreshedMembers.filter((member) => (
                    member.stats?.equipmentPlan?.partyNeed !== 'required'
                    && member.stats?.equipmentPlan?.requiresParty !== true
                ))
                : [];
            const departures = refreshedMembers.length - releasable.length >= Config.partyMinSize
                ? releasable
                : [];
            await departures.reduce((chain, member) => chain.then(() => (
                LifeState.leaveParty(member, 'party_objective_complete')
            )), Promise.resolve());
            const retainedMembers = refreshedMembers.filter((member) => (
                !departures.some((departure) => Number(departure.characterId) === Number(member.characterId))
            ));
            const objectiveMember = retainedMembers.find((member) => (
                member.stats?.equipmentPlan?.partyNeed === 'required'
            )) || retainedMembers.find((member) => partyObjectiveForState(member));
            const objective = objectiveMember ? partyObjectiveForState(objectiveMember) : null;
            const nextLeaderId = leaderIdForMembers(party, retainedMembers);
            const nextParty = {
                ...party,
                leaderId: nextLeaderId,
                memberIds: retainedMembers.map((member) => member.characterId),
                roleCoverage: PartyComposition.roleCoverage(retainedMembers),
                spotId: objective?.spotId || party.spotId,
                stats: {
                    ...(party.stats || {}),
                    objective: objective || null,
                    acquisitionGoal: objectiveMember?.stats?.equipmentPlan?.status === 'active'
                        ? objectiveMember.stats.equipmentPlan
                        : null,
                    lastRequirementRefreshAt: timestamp
                }
            };
            if (Number(nextLeaderId) !== Number(party.leaderId)) {
                await syncPartyLeader(retainedMembers, nextParty, nextLeaderId);
            }
            await BackgroundPartyState.createOrUpdate(nextParty);
            return changed || departures.length ? [...refreshed, party.partyId] : refreshed;
        }), Promise.resolve([])));
    },

    reclaimBackgroundPartyCapacity(partyWaitStates = [], partyWaitCount = partyWaitStates.length, options = {}) {
        if (!partyWaitStates.length) return Promise.resolve([]);
        const activeParties = BackgroundPartyState.active();
        const availableSlots = Math.max(0, maxBackgroundPartiesForBacklog(partyWaitCount) - activeParties.length);
        const wantedSlots = Math.min(
            Config.partyFormationBatchSize,
            Math.floor(partyWaitStates.length / Math.max(1, Config.partyMinSize))
        );
        const reclaimCount = Math.max(0, wantedSlots - availableSlots);
        if (!reclaimCount || !activeParties.length) return Promise.resolve([]);

        return this.refreshBackgroundPartyRequirements(activeParties, options)
            .then(() => {
                if (Number(options.deadlineAt || Infinity) <= Date.now()) {
                    options.markBudgetStop?.();
                    return null;
                }
                return LifeState.partyRequirementCounts(activeParties.map((party) => party.partyId));
            })
            .then((counts) => {
                if (!counts) return [];
                const countByPartyId = new Map(counts.map((count) => [count.partyId, count]));
                return activeParties
                    .filter((party) => Number(countByPartyId.get(party.partyId)?.requiredMembers || 0) === 0)
                    .sort((a, b) => Number(a.startedAt || 0) - Number(b.startedAt || 0))
                    .slice(0, reclaimCount);
            })
            .then((parties) => parties.reduce((chain, party) => (
                chain.then((reclaimed) => dissolveBackgroundParty(party, 'party_capacity_reclaimed', party.memberIds?.length || 0)
                    .then(() => [...reclaimed, party]))
            ), Promise.resolve([])));
    },

    recruitBackgroundMembers(candidates = [], options = {}) {
        const deadlineAt = Number(options.deadlineAt || Infinity);
        const budgetReached = () => {
            if (Date.now() < deadlineAt) return false;
            options.markBudgetStop?.();
            return true;
        };
        const claimed = new Set();
        const parties = BackgroundPartyState.active()
            .filter((party) => (party.memberIds || []).length < Config.partyMaxSize)
            .sort((a, b) => (a.memberIds || []).length - (b.memberIds || []).length);

        return statesForParties(parties.map((party) => party.partyId)).then((membersByParty) => parties.reduce((chain, party) => chain.then(() => {
            if (budgetReached()) return null;
            const members = membersByParty.get(String(party.partyId)) || [];
                if (members.length < Config.partyMinSize) return null;
                const persistedMemberIds = new Set((party.memberIds || []).map(Number));
                const membershipMismatch = members.length !== persistedMemberIds.size
                    || members.some((member) => !persistedMemberIds.has(Number(member.characterId)));
                if (members.length >= Config.partyMaxSize) {
                    if (!membershipMismatch) return null;
                    const electedLeaderId = leaderIdForMembers(party, members);
                    const reconciledParty = {
                        ...party,
                        leaderId: electedLeaderId,
                        memberIds: members.map((member) => member.characterId),
                        roleCoverage: PartyComposition.roleCoverage(members),
                        stats: {
                            ...(party.stats || {}),
                            memberNames: members.map((member) => member.name),
                            lastMembershipRepairAt: Date.now()
                        }
                    };
                    return commitPartyMembership(reconciledParty, members).then(({ party: repaired, failed }) => {
                        if (!repaired || failed.length) return null;
                        console.info('BotPopulation :: reconciled background party %s members=%d', party.partyId, members.length);
                        return repaired;
                    });
                }
                const partyObjective = party.stats?.objective || null;
                const nearby = candidates.filter((state) => (
                    !claimed.has(Number(state.characterId))
                    && (partyObjective
                        ? (partyObjectiveKeyForState(state) === partyObjective.objectiveKey
                            || partyObjectivesShareRoute(partyObjective, partyObjectiveForState(state))
                            || (state.stats?.partyRequest?.priority !== 'required'
                                && partyObjectiveSpotForState(state) === partyObjective.spotId))
                        : state.spotId === party.spotId)
                ));
                const recruits = PartyComposition.selectRecruits(members, nearby, { maxSize: Config.partyMaxSize });
                if (!recruits.length) return null;

                return hydratePartyCandidates(recruits).then((hydratedRecruits) => {
                    if (hydratedRecruits.length !== recruits.length) return null;
                    // Elect an attached leader before the atomic write. If the
                    // persisted leader departed, retained members and recruits
                    // receive the replacement in the same transaction.
                    const electedLeaderId = leaderIdForMembers(party, members)
                        || Number(hydratedRecruits[0]?.characterId || 0);
                    const assignmentParty = { ...party, leaderId: electedLeaderId };
                    const allMembers = [...members, ...hydratedRecruits];
                    const finalLeaderId = leaderIdForMembers(assignmentParty, allMembers);
                    const nextParty = {
                        ...party,
                        leaderId: finalLeaderId,
                        memberIds: allMembers.map((member) => member.characterId),
                        roleCoverage: PartyComposition.roleCoverage(allMembers),
                        stats: {
                            ...(party.stats || {}),
                            memberNames: allMembers.map((member) => member.name),
                            lastRecruitAt: Date.now()
                        }
                    };
                    const recruitEvent = {
                        characterId: finalLeaderId,
                        eventType: 'party_recruit',
                        summary: `${members[0].name} recruited ${hydratedRecruits.map((recruit) => recruit.name).join(', ')} near ${party.spotId}`,
                        meta: {
                            partyId: party.partyId,
                            recruitIds: hydratedRecruits.map((recruit) => recruit.characterId),
                            spotId: party.spotId
                        },
                        weight: 1,
                        createdAt: Date.now()
                    };
                    // Validate and persist the complete resulting membership in
                    // one transaction, including retained members. This makes
                    // recruitment resilient to a simultaneous party release.
                    const changedMembers = [
                        ...(Number(finalLeaderId) !== Number(party.leaderId)
                            ? members.filter((member) => Number(member.party?.leaderId || 0) !== Number(finalLeaderId))
                            : []),
                        ...hydratedRecruits
                    ];
                    const commitMembers = Database.isReady() ? allMembers : changedMembers;
                    return commitPartyMembership(nextParty, commitMembers, recruitEvent)
                        .then(({ party: updatedParty, failed, eventCommitted }) => {
                            if (!updatedParty || failed.length) return null;
                            hydratedRecruits.forEach((recruit) => claimed.add(Number(recruit.characterId)));
                            const eventWrite = eventCommitted
                                ? Promise.resolve()
                                : LifeEvents.record(
                                    recruitEvent.characterId,
                                    recruitEvent.eventType,
                                    recruitEvent.summary,
                                    recruitEvent.meta,
                                    recruitEvent.weight
                                );
                            return eventWrite.then(() => {
                                Metrics.recordPartyRecruit(hydratedRecruits.length);
                                console.info('BotPopulation :: recruited %d bot(s) into %s near %s', hydratedRecruits.length, party.partyId, party.spotId || 'none');
                                return updatedParty;
                            });
                        });
                });
            }), Promise.resolve())).then(() => claimed);
    },

    recoverExpiredColdOwnerLeases(timestamp = Date.now()) {
        if (this.coldOwnerRecoveryRunning || timestamp < this.nextColdOwnerRecoveryAt) {
            return Promise.resolve({ affectedRows: 0, rows: [] });
        }
        this.coldOwnerRecoveryRunning = true;
        this.nextColdOwnerRecoveryAt = timestamp + Math.max(1000, Number(Config.coldOwnerRecoveryIntervalMs) || 5000);
        return ColdSimulationOwner.recoverExpiredLeases(timestamp).finally(() => {
            this.coldOwnerRecoveryRunning = false;
        });
    },

    resolveOwnedColdState(state) {
        const partition = ColdSimulationOwner.eligibility(state);
        if (!partition.ok) {
            Metrics.recordColdOwnerLegacyDeferred(partition.reason);
            return this.resolveColdState(state);
        }

        const startedAt = Date.now();
        const leaseMs = Math.max(2000, Number(Config.coldOwnerLeaseMs) || ColdSimulationOwner.DEFAULT_LEASE_MS);
        const timeoutMs = Math.min(leaseMs - 1000, Math.max(1000, Number(Config.coldOwnerResolveTimeoutMs) || 10000));
        let activeToken = null;
        Metrics.recordColdOwnerSelected();

        const releaseActive = () => activeToken?.ok
            ? ColdSimulationOwner.release(activeToken).catch(() => ({ ok: false, reason: 'release_error' }))
            : Promise.resolve({ ok: false, reason: 'missing_claim' });

        return ColdSimulationOwner.claim(state, { timestamp: startedAt, leaseMs }).then((claim) => {
            if (!claim.ok) {
                if (['legacy_activity', 'background_party', 'warehouse_state', 'market_state', 'craft_state', 'player_workflow'].includes(claim.reason)) {
                    Metrics.recordColdOwnerLegacyDeferred(claim.reason);
                    return this.resolveColdState(state);
                }
                Metrics.recordSkippedResolve(`cold_owner_claim_${claim.reason || 'rejected'}`);
                return { ok: false, reason: claim.reason || 'claim_rejected', state };
            }
            activeToken = claim;
            const claimedState = {
                ...state,
                simulation: {
                    ownerId: claim.ownerId,
                    revision: claim.revision,
                    leaseId: claim.leaseId,
                    leaseUntil: claim.leaseUntil
                }
            };

            return withTimeout(() => {
                if (joinedBackgroundParty(claimedState)) throw new Error('joined_party_after_claim');
                const elapsedMs = claimedState.timing?.lastResolvedAt
                    ? Math.max(1000, startedAt - claimedState.timing.lastResolvedAt)
                    : 60000;
                const lifecycleState = expirePartyRequestForState(claimedState, startedAt);
                const spot = lifecycleState.activity === 'hunting' ? SpotProfiles.findForState(lifecycleState) : null;
                if (lifecycleState.activity === 'hunting' && !spot) {
                    const error = new Error('missing_owner_spot');
                    error.code = 'COLD_OWNER_MISSING_SPOT';
                    throw error;
                }
                const result = BackgroundResolver.resolveSolo({
                    state: lifecycleState,
                    spot,
                    pressure: Director.pressureForState(lifecycleState),
                    targetNpcId: directDropTargetNpcId(lifecycleState.stats?.equipmentPlan),
                    elapsedMs,
                    rng: deterministicRandom(lifecycleState),
                    timestamp: startedAt
                });
                return LifeState.prepareResolve(lifecycleState, result, { persist: false, timestamp: startedAt })
                    .then((nextState) => ({ nextState, result }));
            }, timeoutMs).then(({ nextState, result }) => {
                Metrics.recordColdOwnerResolved();
                if (!nextState || joinedBackgroundParty(nextState)) {
                    const error = new Error('owner_result_invalidated');
                    error.code = 'COLD_OWNER_INVALIDATED';
                    throw error;
                }
                return ColdSimulationOwner.commit(activeToken, nextState, { leaseMs }).then((committed) => {
                    if (!committed.ok) {
                        Metrics.recordSkippedResolve(`cold_owner_commit_${committed.reason || 'rejected'}`);
                        return releaseActive().then(() => ({ ok: false, reason: committed.reason || 'commit_rejected', state }));
                    }
                    activeToken = committed;
                    const committedState = LifeState.cachedState(state.characterId) || nextState;
                    return LifeState.syncResolvedState(committedState)
                        .then(() => LifeEvents.recordMany(state.characterId, result.events || []))
                        .then(() => {
                            Metrics.recordBackgroundResolve();
                            Metrics.recordCombat(result.debug);
                            GlobalChat.maybeAnnounce(committedState, result.events || []);
                            return releaseActive().then((released) => ({
                                ok: true,
                                state: LifeState.cachedState(state.characterId) || committedState,
                                debug: result.debug,
                                release: released
                            }));
                        });
                });
            });
        }).catch((error) => {
            if (error?.code === 'COLD_OWNER_TIMEOUT') Metrics.recordColdOwnerTimeout();
            else if (!error?.coldOwnerRecorded) Metrics.recordColdOwnerError(error);
            Metrics.recordSkippedResolve(error?.code === 'COLD_OWNER_TIMEOUT' ? 'cold_owner_timeout' : 'cold_owner_error');
            return releaseActive().then(() => ({ ok: false, reason: error?.message || 'owner_error', state }));
        }).finally(() => Metrics.recordResolveDuration(Date.now() - startedAt));
    },

    tickBudgeted() {
        // Cold simulation is worker-owned. Keep this compatibility entrypoint
        // inert so an old timer or plugin cannot accidentally reintroduce a
        // second main-thread resolver competing with the worker CAS loop.
        return Promise.resolve([]);
    },

    resolveDueParties(deadlineAt = Infinity) {
        if (Config.backgroundPartyEnabled === false) return Promise.resolve([]);

        return BackgroundPartyState.due(Config.maxPartyResolvesPerTick)
            .then((parties) => this.runInSchedulerSlices(parties, (party) => this.resolveBackgroundParty(party), deadlineAt));
    },

    checkpointPressure() {
        const database = Database.stats();
        const checkpoint = database.checkpoint || {};
        const last = checkpoint.last || {};
        const lastReset = checkpoint.lastReset || {};
        const walBytes = Math.max(0, Number(last.afterBytes || last.beforeBytes || 0));
        const generationBytes = Math.max(0, Number(last.generationBytes || 0));
        const growthBytes = lastReset.at ? generationBytes : walBytes;
        const resetWalBytes = Math.max(0, Number(options.default.Database?.checkpointResetWalBytes) || 0);
        const resetGrowthBytes = Math.max(1, Number(options.default.Database?.checkpointResetGrowthBytes) || 64 * 1024 * 1024);
        const resetDue = resetWalBytes > 0
            && walBytes >= resetWalBytes
            && (!lastReset.at || growthBytes >= resetGrowthBytes);
        return {
            database,
            checkpoint,
            last,
            lastReset,
            walBytes,
            generationBytes,
            growthBytes,
            resetGrowthBytes,
            resetDue
        };
    },

    runAdaptiveWalReset(timestamp = Date.now()) {
        const resetWalBytes = Math.max(0, Number(options.default.Database?.checkpointResetWalBytes) || 0);
        if (!resetWalBytes || this.walResetRunning || timestamp < Number(this.nextWalResetAt || 0)) {
            return Promise.resolve(null);
        }
        const activity = this.playerActivityProfile(timestamp);
        if (activity.protected) return Promise.resolve(null);
        if (this.resolving || this.warehouseCleanupRunning || this.stateRetentionRunning || this.partyFormationRunning) {
            return Promise.resolve(null);
        }

        const pressure = this.checkpointPressure();
        const { database, checkpoint, last, lastReset, walBytes, growthBytes, resetGrowthBytes } = pressure;
        if (walBytes < resetWalBytes || Number(database.pending || 0) > 0 || checkpoint.inFlight) {
            return Promise.resolve(null);
        }
        if (lastReset.at && growthBytes < resetGrowthBytes) return Promise.resolve(null);
        const logFrames = Math.max(0, Number(last.logFrames || 0));
        const checkpointedFrames = Math.max(0, Number(last.checkpointedFrames || 0));
        if (!last.ok || last.mode !== 'passive' || Number(last.busy || 0) > 0 || checkpointedFrames < logFrames) {
            return Promise.resolve(null);
        }

        const retryMs = Math.max(1000, Number(options.default.Database?.checkpointResetRetryMs) || 5000);
        const cooldownMs = Math.max(retryMs, Number(options.default.Database?.checkpointResetCooldownMs) || 60000);
        const busyTimeoutMs = Math.max(1, Math.min(250, Number(options.default.Database?.checkpointResetBusyTimeoutMs) || 50));
        this.walResetRunning = true;
        this.nextWalResetAt = timestamp + retryMs;
        return Database.checkpoint({ mode: 'truncate', busyTimeoutMs }).then((result) => {
            this.lastWalResetResult = { ...result, requestedAt: timestamp };
            if (result?.ok && Number(result.busy || 0) === 0) {
                this.nextWalResetAt = Date.now() + cooldownMs;
                console.info(
                    'DB          :: adaptive WAL truncate complete wal=%dMB frames=%d/%d duration=%dms',
                    Math.round(Number(result.afterBytes || walBytes) / 1024 / 1024),
                    Number(result.checkpointedFrames || 0),
                    Number(result.logFrames || 0),
                    Math.round(Number(result.durationMs || 0))
                );
            }
            return result;
        }).catch((error) => {
            this.lastWalResetResult = { ok: false, error: error?.message || String(error), requestedAt: timestamp };
            utils.infoWarn('DB', 'adaptive WAL restart failed: %s', error?.message || error);
            return null;
        }).finally(() => {
            this.walResetRunning = false;
        });
    },

    runWarehouseCleanup(timestamp = Date.now()) {
        if (Config.warehouseCleanupEnabled === false || Config.enabled === false
            || this.warehouseCleanupRunning || this.stateRetentionRunning
            || timestamp < Number(this.nextWarehouseCleanupAt || 0)) {
            return Promise.resolve(null);
        }

        const activity = this.playerActivityProfile(timestamp);
        if (activity.protected) {
            Metrics.recordBackgroundDeferral();
            Metrics.recordWarehouseCleanupDeferral('player_protected');
            return Promise.resolve(null);
        }
        // This timer normally fires before the 5-second reset timer because
        // both intervals share the same event loop phase. Yielding here gives
        // a due reset a deterministic quiet window instead of starving it
        // behind a succession of short cleanup transactions.
        if (this.checkpointPressure().resetDue) {
            Metrics.recordWarehouseCleanupDeferral('wal_pressure');
            return this.runAdaptiveWalReset(timestamp);
        }
        const lagMs = Math.max(0, Number(Metrics.currentEventLoopLag()) || 0);
        const lagLimit = Math.max(1, Number(Config.schedulerLagThrottleMs) || 40);
        if (lagMs >= lagLimit) {
            Metrics.recordWarehouseCleanupDeferral('event_loop_lag');
            return Promise.resolve(null);
        }
        if (Number(Database.stats().pending || 0) > 0) {
            Metrics.recordWarehouseCleanupDeferral('database_queue');
            return Promise.resolve(null);
        }

        const startedAt = Date.now();
        const budgetMs = Math.max(1, Math.min(50, Number(Config.warehouseCleanupBudgetMs) || 12));
        this.warehouseCleanupRunning = true;
        return Database.cooperatively(() => BotWarehouse.cleanupHistoricalBatch({
            cursor: this.warehouseCleanupCursor,
            ownerLimit: Config.warehouseCleanupOwnersPerTick,
            maxUnitsPerOwner: Config.warehouseCleanupUnitsPerOwner,
            deadlineAt: startedAt + budgetMs
        }), Math.min(budgetMs, Math.max(1, Number(Config.schedulerSliceMs) || 12))).then((result) => {
            this.warehouseCleanupCursor = Math.max(0, Number(result?.cursor || this.warehouseCleanupCursor));
            this.warehouseCleanupPassUnits += Math.max(0, Number(result?.units || 0));
            if (result?.exhausted) {
                const pauseMs = this.warehouseCleanupPassUnits > 0
                    ? Math.max(1000, Number(Config.warehouseCleanupPassPauseMs) || 60000)
                    : Math.max(60000, Number(Config.warehouseCleanupIdlePauseMs) || (6 * 60 * 60 * 1000));
                this.warehouseCleanupCursor = 0;
                this.warehouseCleanupPassUnits = 0;
                this.nextWarehouseCleanupAt = Date.now() + pauseMs;
            }
            Metrics.recordWarehouseCleanup(result || {}, Date.now() - startedAt);
            return result;
        }).catch((error) => {
            Metrics.recordWarehouseCleanup({ errors: 1, cursor: this.warehouseCleanupCursor }, Date.now() - startedAt);
            utils.infoWarn('BotWarehouse', 'bounded historical cleanup failed: %s', error?.message || error);
            return null;
        }).finally(() => {
            this.warehouseCleanupRunning = false;
        });
    },

    runStateRetention(timestamp = Date.now()) {
        if (Config.stateRetentionEnabled === false || Config.enabled === false
            || this.stateRetentionRunning || this.warehouseCleanupRunning
            || timestamp < Number(this.nextStateRetentionAt || 0)) {
            return Promise.resolve(null);
        }

        const activity = this.playerActivityProfile(timestamp);
        if (activity.protected) {
            Metrics.recordBackgroundDeferral();
            Metrics.recordStateRetentionDeferral('player_protected');
            return Promise.resolve(null);
        }
        if (this.checkpointPressure().resetDue) {
            Metrics.recordStateRetentionDeferral('wal_pressure');
            return this.runAdaptiveWalReset(timestamp);
        }
        const lagMs = Math.max(0, Number(Metrics.currentEventLoopLag()) || 0);
        const lagLimit = Math.max(1, Number(Config.schedulerLagThrottleMs) || 40);
        if (lagMs >= lagLimit) {
            Metrics.recordStateRetentionDeferral('event_loop_lag');
            return Promise.resolve(null);
        }
        if (Number(Database.stats().pending || 0) > 0) {
            Metrics.recordStateRetentionDeferral('database_queue');
            return Promise.resolve(null);
        }

        const startedAt = Date.now();
        const budgetMs = Math.max(1, Math.min(50, Number(Config.stateRetentionBudgetMs) || 12));
        this.stateRetentionRunning = true;
        return Database.cooperatively(() => PersistentStateRetention.runNextBatch({
            timestamp,
            batchSize: Config.stateRetentionBatchSize,
            activityRetentionMs: Config.activityJournalRetentionMs,
            activityRowsPerPair: Config.activityJournalRowsPerPair,
            activityMaxRows: Config.activityJournalMaxRows,
            auditRetentionMs: Config.aiAuditRetentionMs,
            toolOutcomeMaxRows: Config.toolOutcomeMaxRows,
            llmTurnMaxRows: Config.llmTurnMaxRows,
            staleLlmTurnMs: Config.staleLlmTurnMs,
            compactedConversationRetentionMs: Config.compactedConversationRetentionMs,
            conversationMaxUncompactedRows: Config.conversationMaxUncompactedRows
        }), Math.min(budgetMs, Math.max(1, Number(Config.schedulerSliceMs) || 12))).then((result) => {
            const durationMs = Date.now() - startedAt;
            this.stateRetentionPassRows += Math.max(0, Number(result?.rowsRemoved || 0));
            if (result?.cycleComplete) {
                const pauseMs = this.stateRetentionPassRows > 0
                    ? Math.max(1000, Number(Config.stateRetentionPassPauseMs) || 60000)
                    : Math.max(60000, Number(Config.stateRetentionIdlePauseMs) || (6 * 60 * 60 * 1000));
                this.stateRetentionPassRows = 0;
                this.nextStateRetentionAt = Date.now() + pauseMs;
            }
            Metrics.recordStateRetention(result || {}, durationMs, durationMs > budgetMs);
            return result;
        }).catch((error) => {
            Metrics.recordStateRetention({ errors: 1 }, Date.now() - startedAt);
            utils.infoWarn('BotPopulation', 'bounded persistent-state retention failed: %s', error?.message || error);
            return null;
        }).finally(() => {
            this.stateRetentionRunning = false;
        });
    },

    releaseWarehouseMaterials(deadlineAt = Infinity) {
        if (Date.now() >= deadlineAt) return Promise.resolve([]);
        return BotWarehouse.releaseColdBatch(Config.maxWarehouseReleasesPerTick, deadlineAt)
            .then((released) => {
                if (released.length) {
                    const resumedMarkets = released.filter((result) => result.resumed).length;
                    const craftItems = released.flatMap((result) => result.items).filter((item) => item.reason === 'craft')
                        .reduce((sum, item) => sum + Number(item.amount || 0), 0);
                    const marketItems = released.flatMap((result) => result.items).filter((item) => item.reason === 'market')
                        .reduce((sum, item) => sum + Number(item.amount || 0), 0);
                    const enchantItems = released.flatMap((result) => result.items).filter((item) => item.reason === 'enchant')
                        .reduce((sum, item) => sum + Number(item.amount || 0), 0);
                    console.info('BotPopulation :: warehouse materials released bots=%d resumedMarkets=%d craftItems=%d enchantItems=%d marketItems=%d', released.length, resumedMarkets, craftItems, enchantItems, marketItems);
                }
                return released;
            })
            .catch((err) => {
                utils.infoWarn('BotPopulation', 'warehouse material release failed: %s', err.message);
                return [];
            });
    },

    reconcileMarketGoals(deadlineAt = Infinity, limit = Config.maxMarketGoalReconcilesPerTick) {
        return LifeState.marketGoalCandidates(limit)
            .then((states) => this.runInSchedulerSlices(states, (state) => {
                    const spot = SpotProfiles.findForState(state);
                    return GoalService.review(state, { spot }).then((goalSnapshot) => {
                        const travel = GoalExecutor.beginMarketTravel(state, goalSnapshot?.current);
                        if (!travel) return null;
                        return LifeState.upsertState(travel, 'reconciled_market_travel').then((saved) => {
                            if (saved) {
                                console.info('BotPopulation :: reconciled market travel for %s', state.name);
                            }
                            return saved;
                        });
                    });
                }, deadlineAt).then((results) => results.filter(Boolean)))
            .catch((err) => {
                utils.infoWarn('BotPopulation', 'market-goal reconcile failed: %s', err.message);
                return [];
            });
    },

    yieldSchedulerSlice(sliceStartedAt) {
        Metrics.recordSchedulerYield(Date.now() - sliceStartedAt);
        return new Promise((resolve) => setImmediate(resolve));
    },

    async runInSchedulerSlices(items, work, deadlineAt = Infinity) {
        const results = [];
        let sliceStartedAt = Date.now();
        const sliceMs = Math.max(1, Number(Config.schedulerSliceMs) || 12);

        for (const item of items || []) {
            if (Date.now() >= deadlineAt) {
                Metrics.recordSchedulerBudgetStop();
                break;
            }
            results.push(await work(item));
            if (Date.now() >= deadlineAt) {
                Metrics.recordSchedulerBudgetStop();
                break;
            }
            if (Date.now() - sliceStartedAt >= sliceMs) {
                await this.yieldSchedulerSlice(sliceStartedAt);
                sliceStartedAt = Date.now();
            }
        }

        return results;
    },

    resolveBackgroundParty(party) {
        const startedAt = Date.now();
        if (partySessionExpired(party, startedAt)) {
            return dissolveBackgroundParty(party, 'party_session_rotation', party.memberIds?.length || 0);
        }
        return LifeState.statesForParty(party.partyId).then((members) => {
            if (members.length < Config.partyMinSize) {
                const recordedIds = new Set((party.memberIds || []).map(Number));
                const reason = recordedIds.size !== members.length ? 'state_mismatch' : 'too_few_members';
                return dissolveBackgroundParty(party, reason, members.length);
            }

            if (party.stats?.travel?.reason === 'party_spot_replan') {
                const arrivalAt = Number(party.stats.travel.arrivalAt || 0);
                if (arrivalAt > startedAt) {
                    return BackgroundPartyState.createOrUpdate({ ...party, nextResolveAt: arrivalAt })
                        .then((updatedParty) => ({ ok: true, party: updatedParty || party, debug: { activity: 'party_travel' } }));
                }
                const destinationSpotId = party.stats.travel.spotId || party.spotId;
                const recordedArrival = members.find((member) => member.stats?.travel?.reason === 'party_spot_replan')
                    ?.stats?.travel?.to;
                const destinationSpot = SpotProfiles.findById(destinationSpotId)
                    || SpotService.findById(destinationSpotId)
                    || {
                        id: destinationSpotId,
                        name: party.stats.travel.regionName,
                        center: recordedArrival || null
                    };
                const arrivedMembers = members.map((member) => finishPartySpotTravel(
                    member,
                    startedAt,
                    destinationSpot,
                    party.stats.travel
                ));
                return arrivedMembers.reduce((chain, member) => (
                    chain.then(() => LifeState.upsertState(member, 'party_spot_arrival'))
                ), Promise.resolve()).then(() => BackgroundPartyState.createOrUpdate(
                    finishPartyTravelRecord(party, startedAt)
                )).then((updatedParty) => LifeEvents.record(
                    party.leaderId,
                    'party_travel',
                    `Party ${party.partyId} arrived near ${party.stats.travel.regionName || party.spotId}`,
                    { partyId: party.partyId, spotId: party.spotId },
                    1
                ).then(() => ({ ok: true, party: updatedParty || party, debug: { activity: 'party_arrival' } })));
            }

            const leader = members.find((state) => state.characterId === party.leaderId) || members[0];
            const objectiveSpotId = party.stats?.objective?.spotId || null;
            const objectiveSpot = objectiveSpotId ? SpotProfiles.findById(objectiveSpotId) : null;
            const spot = objectiveSpot || SpotProfiles.findForState({
                ...leader,
                spotId: party.spotId,
                party: {
                    ...(leader.party || {}),
                    partyId: party.partyId,
                    role: PartyComposition.roleForState(leader)
                },
                stats: {
                    ...(leader.stats || {}),
                    routeMode: 'party'
                }
            }, { mode: 'party', role: PartyComposition.roleForState(leader) }) || SpotProfiles.findForState(leader);
            if (!spot) {
                Metrics.recordSkippedResolve('party_missing_spot');
                return { ok: false, reason: 'missing_spot', party };
            }


            const leaderPhysicalSpot = SpotService.findCurrentSpot(leader.loc);
            const physicalSpotId = leaderPhysicalSpot?.id || leader.spotId || party.spotId;
            if (physicalSpotId && physicalSpotId !== spot.id) {
                const travellingMembers = members.map((member) => beginPartySpotTravel(member, spot, startedAt) || member);
                const arrivalAt = startedAt + HUNTING_TRAVEL_MS;
                return travellingMembers.reduce((chain, member) => (
                    chain.then(() => LifeState.upsertState(member, 'party_spot_travel'))
                ), Promise.resolve()).then(() => BackgroundPartyState.createOrUpdate({
                    ...party,
                    spotId: spot.id,
                    nextResolveAt: arrivalAt,
                    stats: {
                        ...(party.stats || {}),
                        travel: {
                            reason: 'party_spot_replan',
                            regionName: spot.name,
                            spotId: spot.id,
                            startedAt,
                            arrivalAt
                        }
                    }
                })).then((updatedParty) => ({
                    ok: true,
                    party: updatedParty || party,
                    debug: { activity: 'party_travel', spotId: spot.id }
                }));
            }

            const elapsedMs = party.stats?.lastResolveAt ? Math.max(1000, Date.now() - party.stats.lastResolveAt) : 60000;
            const targetNpcId = partyTargetNpcId(party, leader);
            const result = BackgroundPartyResolver.resolve({
                party,
                members,
                spot,
                pressure: Director.pressureForState(leader),
                targetNpcId,
                elapsedMs
            });
            const deadMemberIds = new Set();

            return result.memberResults.reduce((chain, memberResult) => (
                chain.then((resolvedMembers) => LifeState.applyResolve(memberResult.state, memberResult.result)
                    .then((updated) => updated ? [...resolvedMembers, updated] : resolvedMembers))
            ), Promise.resolve([])).then((resolvedMembers) => {
                const deadMembers = resolvedMembers.filter((member) => member.activity === 'dead');
                deadMembers.forEach((member) => deadMemberIds.add(Number(member.characterId)));
                return deadMembers.reduce((chain, member) => (
                    chain.then(() => LifeState.leaveParty(member, 'death'))
                ), Promise.resolve()).then(() => resolvedMembers.filter((member) => member.activity !== 'dead'));
            }).then((resolvedMembers) => {
                let breakTaken = false;
                return resolvedMembers.reduce((chain, member) => (
                chain.then((activeMembers) => GoalService.review(member, { spot }).then((goalSnapshot) => {
                    if (breakTaken || !canTakePartyMarketBreak(party, resolvedMembers, member)) {
                        return [...activeMembers, member];
                    }
                    const travel = GoalExecutor.beginMarketTravel(member, goalSnapshot?.current);
                    if (!travel) return [...activeMembers, member];
                    return LifeState.leaveParty(travel, 'market_break').then((departed) => {
                        if (departed) breakTaken = true;
                        return departed ? activeMembers : [...activeMembers, member];
                    });
                }))
                ), Promise.resolve([]));
            }).then((activeMembers) => {
                if (activeMembers.length < Config.partyMinSize) {
                    const reason = deadMemberIds.size > 0 ? 'death' : 'market_break';
                    return dissolveBackgroundParty(party, reason, activeMembers.length);
                }
                return BackgroundPartyState.createOrUpdate({
                ...party,
                leaderId: (activeMembers.find((member) => member.characterId === party.leaderId) || PartyComposition.chooseLeader(activeMembers) || {}).characterId || party.leaderId,
                memberIds: activeMembers.map((member) => member.characterId),
                spotId: spot.id,
                nextResolveAt: result.nextResolveAt,
                cohesion: result.partyPatch.cohesion,
                risk: result.partyPatch.risk,
                roleCoverage: PartyComposition.roleCoverage(activeMembers),
                stats: {
                    ...(party.stats || {}),
                    ...(result.partyPatch.stats || {}),
                    lastMarketBreakAt: activeMembers.length < members.length ? Date.now() : party.stats?.lastMarketBreakAt || null,
                    route: spot.route || party.stats?.route || null
                }
                });
            }).then((updatedParty) => {
                Metrics.recordPartyResolve();
                Metrics.recordCombat(result.debug);
                const recruitment = PartyRecruitmentChat.maybeAnnounce(updatedParty, members, spot);
                const persistedParty = recruitment.announced
                    ? BackgroundPartyState.createOrUpdate(recruitment.party)
                    : Promise.resolve(updatedParty);
                return persistedParty.then((savedParty) => ({ party: savedParty || updatedParty, recruitment }));
            }).then(({ party: updatedParty }) => {
                return Promise.all(result.events.map((event) => (
                    LifeEvents.record(event.characterId || party.leaderId, event.type, event.summary, event.meta, event.weight)
                ))).then(() => ({
                    ok: true,
                    party: updatedParty,
                    debug: result.debug
                })).then((resolved) => {
                    GlobalChat.maybeAnnounce(leader, result.events);
                    return resolved;
                });
            });
        }).catch((err) => {
            utils.infoWarn('BotPopulation', 'background party resolve failed for %s: %s', party.partyId, err.message);
            Metrics.recordSkippedResolve('party_resolve_failed');
            return { ok: false, reason: 'resolve_failed', party };
        }).finally(() => {
            Metrics.recordResolveDuration(Date.now() - startedAt);
        });
    },

    resolveColdState(state, workerRequest = null) {
        const startedAt = Date.now();
        const precomputedResult = workerRequest?.precomputedResult || null;
        if (joinedBackgroundParty(state)) {
            Metrics.recordSkippedResolve('joined_party_before_resolve');
            return Promise.resolve({ ok: false, reason: 'joined_party', state });
        }
        const cleanupState = inventoryCleanupTravelState(state, startedAt);
        if (cleanupState) {
            const { cleanup, ...travelState } = cleanupState;
            return LifeState.upsertState(travelState, 'inventory_cleanup_market_travel')
                    .then((saved) => (saved ? {
                        ok: true,
                        state: saved,
                        debug: {
                            activity: 'inventory_cleanup_travel',
                            slots: cleanup.itemCount,
                            npcOnlySlots: cleanup.npcOnlySlots,
                            reason: cleanup.cleanupReason
                        }
                    } : {
                        ok: false,
                        reason: 'state_write_rejected',
                        state
                    }))
                    .finally(() => Metrics.recordResolveDuration(Date.now() - startedAt));
        }
        const elapsedMs = state.timing?.lastResolvedAt ? Math.max(1000, startedAt - state.timing.lastResolvedAt) : 60000;
        // These transitions have no planning, market search, or inventory work
        // between their persisted deadline and the next state change.
        if (state.activity === 'traveling' || (state.activity === 'resting' && Number(state.stats?.restUntil || 0) > 0)) {
            const requestLifecycleState = expirePartyRequestForState(state, startedAt);
            const result = precomputedResult || BackgroundResolver.resolveSolo({
                state: requestLifecycleState,
                spot: null,
                pressure: Director.pressureForState(state),
                elapsedMs,
                timestamp: startedAt
            });
            if (joinedBackgroundParty(state)) {
                Metrics.recordSkippedResolve('joined_party_during_transition');
                return Promise.resolve({ ok: false, reason: 'joined_party', state });
            }
            return LifeState.applyResolve(requestLifecycleState, result).then((updatedState) => {
                if (!updatedState) {
                    Metrics.recordSkippedResolve('transition_apply_failed');
                    return { ok: false, reason: 'apply_failed', state };
                }
                Metrics.recordBackgroundResolve();
                Metrics.recordCombat(result.debug);
                const recoveredForMarket = state.activity === 'resting'
                    && (canResumeAffordableWeaponMarketPlan(updatedState)
                        || canResumeWarehouseMarketSale(updatedState));
                const marketHandoff = recoveredForMarket
                    ? GoalService.review(updatedState).then((goalSnapshot) => {
                        const timestamp = Date.now();
                        const travelState = GoalExecutor.beginMarketTravel(updatedState, goalSnapshot?.current, timestamp);
                        return travelState
                            ? LifeState.upsertState(travelState, 'goal_market_travel_after_recovery').then((saved) => saved || travelState)
                            : updatedState;
                    }).catch((err) => {
                        utils.infoWarn('BotGoals', 'post-recovery market handoff failed for %s: %s', state.name, err.message);
                        return updatedState;
                    })
                    : Promise.resolve(updatedState);
                return marketHandoff.then((finalState) => LifeEvents.recordMany(state.characterId, result.events).then(() => ({
                    ok: true,
                    state: finalState,
                    debug: result.debug
                })));
            }).finally(() => Metrics.recordResolveDuration(Date.now() - startedAt));
        }
        if (GearAcquisitionPlanner.isCraftService(state)) {
            const { equipmentPlan, ...serviceStats } = state.stats || {};
            const serviceState = {
                ...state,
                timing: { ...(state.timing || {}), nextResolveAt: null },
                stats: serviceStats
            };
            return LifeState.upsertState(serviceState, 'craft_service_idle')
                .then((saved) => ({ ok: true, state: saved || serviceState, debug: { activity: 'craft_service_idle' } }))
                .finally(() => Metrics.recordResolveDuration(Date.now() - startedAt));
        }
        const staleShopping = state?.activity === 'shopping'
            && !state.stats?.marketReturn
            && state.currentRegion !== 'Giran';
        const passiveActivity = ['traveling', 'shopping', 'merchant', 'crafting', 'dead'].includes(state?.activity) && !staleShopping;
        const workerPlan = workerRequest?.precomputedPlan || null;
        const previousPlan = workerPlan ? workerPlan.previousPlan : state.stats?.equipmentPlan;
        // A travelling bot does not fight at a spot during this resolve, but its
        // gear plan still needs the complete atlas.  Passing [] here turned every
        // in-progress craft route into `blocked` on its first travel tick.
        const spots = SpotProfiles.ensure();
        const replanContext = workerPlan
            ? { failure: workerPlan.replanFailure || null }
            : GearAcquisitionPlanner.replanContextFor(state, previousPlan, startedAt);
        let acquisitionPlan = workerPlan?.acquisitionPlan || null;
        if (!acquisitionPlan) {
            const reusablePartyRequest = !state.party?.partyId
                && previousPlan?.next
                && replanContext.planCurrent
                && !replanContext.failure
                && state.stats?.partyRequest?.status === 'open'
                && Number(state.stats.partyRequest.reviewAt || 0) > startedAt;
            const upgradedPlan = reusablePartyRequest
                ? previousPlan
                : GearAcquisitionPlanner.planFor(state, { spots, ...replanContext });
            const previousRefresh = previousPlan?.recipeId && !reusablePartyRequest
                ? GearAcquisitionPlanner.planFor(state, { spots, recipeId: previousPlan.recipeId, ...replanContext })
                : null;
            const rawAcquisitionPlan = GearAcquisitionPlanner.shouldFinishPreviousPlan(previousPlan, previousRefresh)
                ? { ...previousRefresh, finishBeforeUpgrade: true }
                : upgradedPlan;
            const finalizedPlan = reusablePartyRequest
                ? previousPlan
                : GearAcquisitionPlanner.finalizePlan(state, previousPlan, rawAcquisitionPlan, replanContext, startedAt);
            acquisitionPlan = {
                ...finalizedPlan,
                marketFallback: finalizedPlan.status === 'active' && finalizedPlan.strategy === 'craft'
                    && Number(finalizedPlan.startedAt || startedAt) + 20 * 60 * 1000 <= Date.now()
            };
        }
        const partyRequest = partyRequestForPlan(state, acquisitionPlan, startedAt);
        const plannedStats = { ...(state.stats || {}), equipmentPlan: acquisitionPlan };
        if (partyRequest) plannedStats.partyRequest = partyRequest;
        else delete plannedStats.partyRequest;
        const plannedState = {
            ...state,
            stats: plannedStats
        };
        const planEvents = CraftTelemetry.planEvents(state, previousPlan, acquisitionPlan);
        if (replanContext.failure) {
            planEvents.push({
                type: 'gear_acquisition_fallback',
                summary: `${state.name} abandoned an unproductive ${previousPlan.target?.name || `item ${replanContext.failure.targetId}`} drop route`,
                weight: 3,
                meta: {
                    reason: replanContext.failure.reason,
                    targetId: replanContext.failure.targetId,
                    npcId: replanContext.failure.npcId,
                    resolves: replanContext.failure.resolves,
                    targetKills: replanContext.failure.targetKills,
                    nextStrategy: acquisitionPlan.strategy
                }
            });
        }
        if (plannedState.activity === 'crafting') {
            return ColdCraftingService.craft(plannedState).then((craft) => {
                const completed = craft.reason === 'crafted'
                    || craft.reason === 'component_crafted'
                    || craft.reason === 'dual_sword_combined';
                const reason = craft.reason === 'component_crafted'
                    ? 'cold_component_craft_complete'
                    : craft.reason === 'dual_sword_combined'
                        ? 'cold_dual_sword_combine_complete'
                        : craft.reason === 'crafted' ? 'cold_craft_complete' : 'cold_craft_wait';
                // A persisted plan can say ready_to_craft even when an earlier
                // component craft consumed the raw inputs for the next batch,
                // or a station may be temporarily unavailable. Do not pin the
                // bot at a station: re-enter hunting so the acquisition planner
                // can select the missing material again.
                const recoveredState = !completed
                    ? {
                        ...(craft.state || plannedState),
                        activity: 'hunting',
                        stats: {
                            ...((craft.state || plannedState).stats || {}),
                            travel: null
                        },
                        timing: {
                            ...((craft.state || plannedState).timing || {}),
                            nextResolveAt: Date.now() + 30000
                        }
                    }
                    : craft.state || plannedState;
                return LifeState.upsertState(recoveredState, reason).then((saved) => {
                    const supplemented = craft.supplementedMaterials || [];
                    const supplyEvent = supplemented.length
                        ? LifeEvents.record(state.characterId, 'craft_supplemented', `${state.name} received ${supplemented.map((item) => `${item.amount} ${item.name}`).join(', ')} for crafting`, {
                            recipeId: craft.recipeId,
                            materials: supplemented
                        }, 2)
                        : Promise.resolve(null);
                    if (!completed) return supplyEvent.then(() => ({ ok: true, state: saved || craft.state || plannedState, debug: craft }));
                    const eventType = craft.reason === 'component_crafted'
                        ? 'component_craft'
                        : craft.reason === 'dual_sword_combined' ? 'dual_sword_combine' : 'equipment_craft';
                    const quantity = Math.max(1, Number(craft.batchCount || 1));
                    const verb = craft.reason === 'dual_sword_combined' ? 'combined' : 'crafted';
                    const summary = `${state.name} ${verb} ${quantity > 1 ? `${quantity}x ` : ''}${craft.productName} at ${craft.stationId}`;
                    return supplyEvent.then(() => LifeEvents.record(state.characterId, eventType, summary, {
                        recipeId: craft.recipeId,
                        productId: craft.productId,
                        stationId: craft.stationId
                    }, ['crafted', 'dual_sword_combined'].includes(craft.reason) ? 3 : 2)).then(() => (
                        { ok: true, state: saved || craft.state || plannedState, debug: craft }
                    ));
                });
            })
                .finally(() => Metrics.recordResolveDuration(Date.now() - startedAt));
        }
        const requiredPartyRequest = partyRequest?.priority === 'required';
        // A deferred request still owns the safe fallback route until the
        // planner either reopens it or replaces the unavailable target. Do
        // not let the cooldown hand control back to SpotProfiles while the
        // persisted gear plan still points at an unsafe source.
        const deferredPartyRequest = partyRequest?.status === 'deferred'
            && (acquisitionPlan?.partyNeed === 'required'
                || acquisitionPlan?.requiresParty === true);
        const partyRouteWaiting = (requiredPartyRequest || deferredPartyRequest)
            && !state.party?.partyId;
        const partyFallback = partyRouteWaiting && !passiveActivity
            ? GearAcquisitionPlanner.safeFallbackForPlan(state, acquisitionPlan, spots)
            : null;
        const fallbackSpot = partyRouteWaiting && !passiveActivity
            ? (partyFallback && SpotProfiles.findById(partyFallback.spotId)) || SpotProfiles.findForState({
                ...plannedState,
                spotId: null,
                stats: Object.fromEntries(Object.entries(plannedState.stats || {})
                    .filter(([key]) => key !== 'equipmentPlan'))
            })
            : null;
        const routedState = fallbackSpot
            ? { ...plannedState, activity: 'hunting', spotId: fallbackSpot.id }
            : plannedState;
        const currentSpotId = plannedState.spotId || null;
        const travellingState = ColdCraftingService.beginTravel(routedState) || routedState;
        const travel = travellingState.stats?.travel;
        const travelEvents = travellingState !== plannedState && travel?.stationId
            ? [CraftTelemetry.stationTravelEvent(plannedState, travel)]
            : [];
        const selectedSpot = passiveActivity
            ? null
            : fallbackSpot || SpotProfiles.findForState(travellingState);
        const huntingTravelState = selectedSpot && !passiveActivity
            ? beginHuntingTravel(travellingState, selectedSpot, startedAt, { currentSpotId })
            : null;
        const effectiveState = huntingTravelState || travellingState;
        const spot = effectiveState.activity === 'traveling' ? null : selectedSpot;
        if (!spot && !passiveActivity && effectiveState.activity !== 'traveling') {
            Metrics.recordSkippedResolve('missing_spot');
            Metrics.recordResolveDuration(Date.now() - startedAt);
            return Promise.resolve({ ok: false, reason: 'missing_spot', state });
        }

        const result = precomputedResult || BackgroundResolver.resolveSolo({
            state: effectiveState,
            spot,
            pressure: Director.pressureForState(state),
            targetNpcId: partyRouteWaiting
                ? Number(partyFallback?.npcId || 0)
                : directDropTargetNpcId(acquisitionPlan),
            elapsedMs
        });

        if (joinedBackgroundParty(state)) {
            Metrics.recordSkippedResolve('joined_party_after_planning');
            return Promise.resolve({ ok: false, reason: 'joined_party', state });
        }

        return LifeState.applyResolve(effectiveState, result)
            .then((updatedState) => {
            if (!updatedState) {
                Metrics.recordSkippedResolve('cold_apply_failed');
                return { ok: false, reason: 'apply_failed', state };
            }

            Metrics.recordBackgroundResolve();
            Metrics.recordCombat(result.debug);
            if (updatedState.activity === 'crafting') {
                return { ok: true, state: updatedState, debug: result.debug };
            }
            return ColdMarketListingService.reconcileInventory(updatedState)
                .then((inventoryLifecycle) => ColdMarketListingService.resolve(inventoryLifecycle.state))
                .then((marketLifecycle) => {
                    const completedSale = marketLifecycle.closed && marketLifecycle.reason === 'sold_out';
                    const goalReady = completedSale
                        ? GoalService.complete(marketLifecycle.state.characterId)
                        : Promise.resolve(null);
                    return goalReady.then(() => marketLifecycle);
                }).then((marketLifecycle) => GoalService.current(marketLifecycle.state.characterId)
                    .then((goalSnapshot) => {
                        if (goalSnapshot?.current?.status === 'active') return goalSnapshot;
                        const returnSpot = SpotProfiles.findById(marketLifecycle.state.stats?.marketReturn?.spotId);
                        return GoalService.review(marketLifecycle.state, { spot: returnSpot || spot });
                    })
                    .then((goalSnapshot) => ColdMarketService.tryPurchase(marketLifecycle.state, goalSnapshot?.current)
                        .then((marketResult) => ({ marketLifecycle, marketResult, goal: goalSnapshot?.current || null }))))
                .then(({ marketLifecycle, marketResult, goal }) => {
                    const purchasedState = marketResult.state || marketLifecycle.state || updatedState;
                    if (marketResult.purchased) {
                        const batchState = {
                            ...purchasedState,
                            activity: 'shopping',
                            timing: {
                                ...(purchasedState.timing || {}),
                                activityStartedAt: Number(purchasedState.timing?.activityStartedAt || Date.now()),
                                nextResolveAt: Date.now() + 1000
                            }
                        };
                        // Keep the bot in town for one prompt follow-up pass.
                        // The next scheduler tick replans from the purchased
                        // inventory and can buy another item in this same town
                        // without returning to the hunting ground in between.
                        return LifeState.upsertState(batchState, 'market_batch_continue')
                            .then((saved) => saved || batchState);
                    }
                    const listingIntent = marketListingIntent(purchasedState, goal);
                    const listingPromise = !marketLifecycle.closed && listingIntent.shouldOpen
                        ? ColdMarketListingService.open(listingIntent.state, {
                            forcedCleanup: listingIntent.cleanup || null
                        })
                        : Promise.resolve({ state: purchasedState, listed: false });
                    const marketStatePromise = listingPromise.then((listingResult) => {
                        const listingState = listingResult.state || purchasedState;
                        if (listingState.activity === 'merchant') return listingState;
                        if (listingResult.listed) return listingState;
                        const returnState = GoalExecutor.finishMarketVisit(listingState);
                        return returnState
                            ? LifeState.upsertState(returnState, 'market_visit_complete').then((saved) => saved || returnState)
                            : listingState;
                    });
                    return marketStatePromise.then((persistedState) => persistedState || purchasedState)
                        .then((marketState) => ColdMarketTradeChat.maybeAnnounce(marketState).then((result) => result.state || marketState))
                        .then((marketState) => GoalService.review(marketState, { spot }).catch((err) => {
                        utils.infoWarn('BotGoals', 'goal review failed for %s: %s', marketState.name, err.message);
                        return null;
                    }).then((goalSnapshot) => {
                        const travelState = GoalExecutor.beginMarketTravel(marketState, goalSnapshot?.current);
                        return travelState ? LifeState.upsertState(travelState, 'goal_market_travel') : marketState;
                    }));
                }).then((finalState) => {
                    const craftEvents = CraftTelemetry.progressEvents(state, acquisitionPlan, updatedState);
                    return LifeEvents.recordMany(state.characterId, [...planEvents, ...travelEvents, ...result.events, ...craftEvents])
                        .then(() => finalState);
                })
                .then((finalState) => {
                    GlobalChat.maybeAnnounce(finalState, result.events);
                    return {
                        ok: true,
                        state: finalState,
                        debug: result.debug
                    };
                });
        }).finally(() => {
            Metrics.recordResolveDuration(Date.now() - startedAt);
        });
    },

    executeWorkerLifecycleCommand(state, request = {}) {
        if (!request.precomputedResult) {
            return Promise.resolve({ ok: false, reason: 'worker_result_required', state });
        }
        return this.resolveColdState(state, request);
    },

    prepareInventoryCleanupProposal(state, timestamp = Date.now(), simulation = null) {
        return inventoryCleanupTravelState(state, timestamp, simulation);
    },

    reconcileWorkerPartyGoals(party, timestamp = Date.now()) {
        return reconcileWorkerPartyGoals(party, timestamp);
    },

    coldWorkerSnapshot() {
        return ColdSimulationCoordinator.snapshot();
    },

    summary() {
        return Status.summary();
    },

    logSummary(reason = 'summary') {
        const summary = this.summary();
        console.info('BotPopulation :: %s %s', reason, summary.line);
        return summary;
    }
};

PopulationService.arrivalPointForState = (state, spot) => SpotService.arrivalPointForState(state, spot);
PopulationService.beginPartySpotTravel = beginPartySpotTravel;
PopulationService.finishPartySpotTravel = finishPartySpotTravel;
PopulationService.finishPartyTravelRecord = finishPartyTravelRecord;
PopulationService.marketListingIntent = marketListingIntent;

module.exports = PopulationService;
