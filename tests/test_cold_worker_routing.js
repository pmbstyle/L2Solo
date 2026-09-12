const assert = require('assert');

require('../src/Global');

const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const SpotService = invoke('GameServer/Bot/AI/SpotService');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const DataCache = invoke('GameServer/DataCache');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const PartyRequestPlanner = invoke('GameServer/Bot/Population/PartyRequestPlanner');
const ColdNpcPlanningCatalog = require('../src/GameServer/Bot/Population/ColdNpcPlanningCatalog');
const {
    ColdSimulationCoordinator,
    compactPartyMemberContext,
    npcPlanningCatalogRows,
    admitSoloRouteTravelState
} = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');

DataCache.init();

const originalFindForState = SpotProfiles.findForState;
const originalFindCurrentSpot = SpotService.findCurrentSpot;
const originalArrivalPointForState = SpotService.arrivalPointForState;
const originalSafeFallbackForPlan = GearAcquisitionPlanner.safeFallbackForPlan;
const originalCachedState = LifeState.cachedState;

try {
    const npcCatalogRows = npcPlanningCatalogRows();
    const npcCatalog = ColdNpcPlanningCatalog.createLookup(npcCatalogRows);
    assert(Object.isFrozen(npcCatalogRows), 'the coordinator NPC catalog snapshot must be immutable');
    assert(npcCatalogRows.length > 0 && npcCatalog.itemCount > 0,
        'the cold worker must receive concrete low-tier NPC equipment offers');
    assert(Buffer.byteLength(JSON.stringify(npcCatalogRows)) < 256 * 1024,
        'the compact NPC equipment catalog must fit within the bounded worker transport');

    const npcPlanFor = (level) => GearAcquisitionPlanner.planFor({
        characterId: 7000000 + level,
        level,
        adena: 500,
        currentRegion: 'Talking Island',
        stats: { classId: 0, role: 'dps' },
        inventory: { 57: { selfId: 57, amount: 500 } }
    }, {
        spots: [],
        ...npcCatalog.plannerOptions
    });
    const noGradeNpcPlan = npcPlanFor(10);
    assert.strictEqual(noGradeNpcPlan.strategy, 'market',
        'a cold no-grade bot must plan an NPC purchase instead of direct-drop farming');
    assert.strictEqual(noGradeNpcPlan.market.sourceType, 'npc');
    assert.strictEqual(
        String(DataCache.items.find((item) => Number(item.selfId) === Number(noGradeNpcPlan.target.selfId))?.etc?.rank),
        'none'
    );

    const dGradeNpcPlan = npcPlanFor(20);
    assert.strictEqual(dGradeNpcPlan.strategy, 'market',
        'a cold D-grade bot must receive the ordinary NPC bridge plan');
    assert.strictEqual(dGradeNpcPlan.market.sourceType, 'npc');
    assert.strictEqual(
        String(DataCache.items.find((item) => Number(item.selfId) === Number(dGradeNpcPlan.target.selfId))?.etc?.rank),
        'd'
    );
    assert.notStrictEqual(dGradeNpcPlan.market.town, 'Talking Island',
        'a D-grade bot in Talking Island must route to a city that actually sells its target');
    assert(MarketOpportunity.npcOffers(dGradeNpcPlan.target.selfId, dGradeNpcPlan.market.town)
        .some((offer) => offer.available), 'the selected D-grade destination must expose the persisted NPC offer');

    const compact = compactPartyMemberContext({
        characterId: 11,
        phase: 'cold',
        activity: 'grouped',
        party: { partyId: 'compact-party', leaderId: 11 },
        simulation: { ownerId: 'legacy_main', revision: 17 },
        stats: { equipmentPlan: { huge: 'x'.repeat(20000) } },
        inventorySummary: 'x'.repeat(20000)
    });
    assert.strictEqual(compact.characterId, 11);
    assert.strictEqual(compact.partyId, 'compact-party');
    assert.strictEqual(compact.party.partyId, 'compact-party');
    assert.strictEqual(compact.simulation.revision, 17);
    assert.strictEqual(compact.compact, true);
    assert(Buffer.byteLength(JSON.stringify(compact)) < 512,
        'party context should not repeat the full inventory and equipment state');

    const fullMember = {
        characterId: 12,
        phase: 'cold',
        activity: 'resting',
        party: { partyId: 'compact-party' },
        simulation: { ownerId: 'legacy_main', revision: 18 },
        stats: { huge: 'x'.repeat(20000) },
        inventorySummary: 'x'.repeat(20000)
    };
    LifeState.cachedState = (characterId) => Number(characterId) === 11
        ? { ...fullMember, characterId: 11 }
        : fullMember;
    const contextCoordinator = new ColdSimulationCoordinator();
    const compactContext = contextCoordinator.contextFor({
        characterId: 11,
        phase: 'cold',
        activity: 'resting',
        loc: { locX: 1, locY: 2, locZ: 3 },
        stats: {}
    }, {
        spots: new Map(),
        parties: new Map([[
            11,
            { partyId: 'compact-party', leaderId: 11, memberIds: [11, 12] }
        ]]),
        occupancy: {},
        compactPartyMembers: true
    });
    assert(compactContext.partyMembers.every((member) => member.compact === true),
        'snapshot party context must compact every already-loaded member');
    assert(compactContext.partyMembers.every((member) => !member.inventorySummary),
        'snapshot party context must omit duplicated inventory payloads');
    const mixedContext = contextCoordinator.contextFor({
        characterId: 11,
        phase: 'cold',
        activity: 'resting',
        loc: { locX: 1, locY: 2, locZ: 3 },
        stats: {}
    }, {
        spots: new Map(),
        parties: new Map([[
            11,
            { partyId: 'compact-party', leaderId: 11, memberIds: [11, 12] }
        ]]),
        occupancy: {},
        compactPartyMemberIds: new Set([11])
    });
    assert.strictEqual(mixedContext.partyMembers[0].compact, true);
    assert(mixedContext.partyMembers[1].inventorySummary,
        'a member omitted from the bootstrap set must retain a full fallback state');

    const currentSpot = { id: 'starter-field', name: 'Starter fields' };
    const targetSpot = {
        id: 'mid-level-field',
        name: 'Mid-level fields',
        minLevel: 16,
        maxLevel: 22,
        avgLevel: 19,
        density: 8,
        levelCounts: { 16: 2, 18: 3, 20: 2, 22: 1 },
        capacity: 2
    };
    const destinationFor = (state) => ({
        locX: 125000 + Number(state.characterId || 0),
        locY: -176000,
        locZ: -1000
    });
    SpotService.findCurrentSpot = () => currentSpot;
    SpotService.arrivalPointForState = destinationFor;
    const routeTargetForState = (state, options) => {
        if (options?.mode === 'party') {
            assert.strictEqual(state.stats.routeMode, 'party');
            assert(state.party?.partyId);
        }
        return targetSpot;
    };
    SpotProfiles.findForState = routeTargetForState;

    const coordinator = new ColdSimulationCoordinator();
    const solo = coordinator.routeFor({
        characterId: 1,
        phase: 'cold',
        activity: 'hunting',
        level: 16,
        spotId: currentSpot.id,
        loc: { locX: 1, locY: 2, locZ: 3 },
        stats: {}
    }, currentSpot, null, [], { occupancy: {} });
    assert.strictEqual(solo.mode, 'solo');
    assert.strictEqual(solo.spotId, targetSpot.id);
    assert.deepStrictEqual(solo.destinations['1'], destinationFor({ characterId: 1 }));

    const retreatAt = Date.now();
    const retreatState = { characterId: 2, phase: 'cold', activity: 'hunting', level: 16,
        spotId: currentSpot.id, loc: { locX: 1, locY: 2, locZ: 3 },
        stats: { coldCompetition: { avoid: { spotId: currentSpot.id, until: retreatAt + 600000 } } } };
    const savedIndex = coordinator.contextIndex;
    coordinator.contextIndex = () => ({ spots: new Map([[currentSpot.id, currentSpot], [targetSpot.id, targetSpot]]), occupancy: {} });
    SpotProfiles.findForState = (state, options) => {
        assert(options.excludedSpotIds.has(currentSpot.id), 'voluntary avoidance reaches the real route selector');
        assert.strictEqual(options.timestamp, retreatAt);
        return targetSpot;
    };
    const retreatRoute = coordinator.competitionActions.retreatRoute([retreatState], null, { spotId: currentSpot.id }, retreatAt);
    assert.strictEqual(retreatRoute.cause, 'competition_avoid');
    assert.strictEqual(retreatRoute.spotId, targetSpot.id);
    assert(!retreatRoute.spotBackoff, 'a social retreat does not invent PvE deaths or escalate their backoff');
    SpotProfiles.findForState = () => null;
    assert.strictEqual(coordinator.competitionActions.retreatRoute([retreatState], null, { spotId: currentSpot.id }, retreatAt), null,
        'no suitable destination means no invented successful retreat');
    coordinator.contextIndex = savedIndex;
    SpotProfiles.findForState = routeTargetForState;

    const sharedIndex = { occupancy: {} };
    const batchRouteFor = (characterId) => coordinator.routeFor({
        characterId,
        phase: 'cold',
        activity: 'hunting',
        level: 16,
        spotId: currentSpot.id,
        loc: { locX: 1, locY: 2, locZ: 3 },
        stats: {}
    }, currentSpot, null, [], sharedIndex);
    assert(batchRouteFor(20), 'the first cold decision must reserve an available destination');
    assert(batchRouteFor(21), 'the second cold decision may consume the final destination slot');
    assert.strictEqual(batchRouteFor(22), null,
        'later decisions in the same cold snapshot must not overbook the reserved destination');

    const baseRouteState = {
        characterId: 23,
        phase: 'cold',
        activity: 'hunting',
        spotId: currentSpot.id,
        loc: { locX: 1, locY: 2, locZ: 3 },
        timing: { activityStartedAt: 500 },
        stats: { equipmentPlan: { status: 'active', strategy: 'direct_drop' } }
    };
    const proposedRouteState = {
        ...baseRouteState,
        activity: 'traveling',
        timing: { activityStartedAt: 1000, nextResolveAt: 26000 },
        stats: {
            ...baseRouteState.stats,
            travel: {
                spotId: targetSpot.id,
                reason: 'equipment_source_replan',
                arrivalAt: 26000
            }
        }
    };
    const fullDestination = {
        [targetSpot.id]: {
            count: 2,
            reservedCount: 2,
            capacity: 2,
            retained: new Set(['20', '21']),
            reservedKeys: new Set(['20', '21']),
            reservationKeys: new Set(),
            retainedReservationKeys: new Set()
        }
    };
    const rejectedRoute = admitSoloRouteTravelState(
        proposedRouteState,
        baseRouteState,
        [targetSpot],
        fullDestination,
        2000
    );
    assert.strictEqual(rejectedRoute.admitted, false,
        'a route must be checked again against capacity immediately before commit');
    assert.strictEqual(rejectedRoute.state.activity, 'hunting');
    assert.strictEqual(rejectedRoute.state.stats.travel, undefined);
    assert.strictEqual(rejectedRoute.state.stats.equipmentPlan, baseRouteState.stats.equipmentPlan,
        'rejecting stale travel must preserve the newly selected equipment alternative');
    assert.strictEqual(rejectedRoute.state.timing.nextResolveAt, 3000,
        'a rejected route should retry promptly instead of entering an unbounded wait');

    const safetyRouteState = {
        ...proposedRouteState,
        stats: {
            ...proposedRouteState.stats,
            travel: {
                ...proposedRouteState.stats.travel,
                reason: 'unsafe_ground_evacuation'
            }
        }
    };
    const admittedSafetyRoute = admitSoloRouteTravelState(
        safetyRouteState,
        baseRouteState,
        [targetSpot],
        fullDestination,
        2000
    );
    assert.strictEqual(admittedSafetyRoute.admitted, true,
        'evacuating party-only content must not be rejected by a full safe destination');
    assert.strictEqual(admittedSafetyRoute.capacityBypassed, true,
        'the exceptional capacity bypass must remain visible to diagnostics');
    assert.strictEqual(fullDestination[targetSpot.id].reservedCount, 3,
        'the safety overflow must be reserved so the same snapshot cannot overbook it again');
    const rejectedSecondSafetyRoute = admitSoloRouteTravelState(
        {
            ...safetyRouteState,
            characterId: 25
        },
        { ...baseRouteState, characterId: 25 },
        [targetSpot],
        fullDestination,
        2000
    );
    assert.strictEqual(rejectedSecondSafetyRoute.admitted, false,
        'a safety destination may exceed its soft capacity by only one bot');

    const admittedOccupancy = {};
    const admittedRoute = admitSoloRouteTravelState(
        proposedRouteState,
        baseRouteState,
        [targetSpot],
        admittedOccupancy,
        2000
    );
    assert.strictEqual(admittedRoute.admitted, true);
    assert.strictEqual(admittedOccupancy[targetSpot.id].reservedCount, 1,
        'the pre-commit admission must reserve its destination for later proposals in the batch');

    const dangerousSpot = {
        id: 'dangerous-party-room',
        name: 'Necropolis of Sacrifice',
        minLevel: 20,
        maxLevel: 24,
        avgLevel: 22,
        density: 20,
        tags: ['dungeon', 'catacomb'],
        tagsAuthoritative: true
    };
    const emergencyIndex = {
        occupancy: {
            [targetSpot.id]: {
                count: 2,
                reservedCount: 2,
                capacity: 2,
                retained: new Set(['20', '21']),
                reservedKeys: new Set(['20', '21']),
                reservationKeys: new Set(),
                retainedReservationKeys: new Set()
            }
        },
        profiles: [targetSpot],
        spots: new Map([[targetSpot.id, targetSpot]])
    };
    const unqualifiedCurrentSpot = {
        id: 'dangerous-room-grid-without-area',
        name: 'Nearby ordinary fields'
    };
    SpotService.findCurrentSpot = () => unqualifiedCurrentSpot;
    SpotProfiles.findForState = () => unqualifiedCurrentSpot;
    const emergencyRoute = coordinator.routeFor({
        characterId: 24,
        phase: 'cold',
        activity: 'hunting',
        level: 22,
        spotId: dangerousSpot.id,
        currentRegion: dangerousSpot.name,
        loc: { locX: 1, locY: 2, locZ: 3 },
        stats: { routeMode: 'party' }
    }, unqualifiedCurrentSpot, null, [], emergencyIndex);
    assert(emergencyRoute, 'a detached solo bot must receive a route out of party-only content');
    assert.strictEqual(emergencyRoute.spotId, targetSpot.id);
    assert.strictEqual(emergencyRoute.reason, 'unsafe_ground_evacuation');
    SpotService.findCurrentSpot = () => currentSpot;
    SpotProfiles.findForState = routeTargetForState;

    const party = {
        partyId: 'route-party',
        leaderId: 2,
        memberIds: [2, 3],
        spotId: currentSpot.id
    };
    const members = [
        { characterId: 2, phase: 'cold', activity: 'grouped', level: 16, spotId: currentSpot.id, loc: { locX: 1, locY: 2, locZ: 3 }, stats: {} },
        { characterId: 3, phase: 'cold', activity: 'grouped', level: 16, spotId: currentSpot.id, loc: { locX: 4, locY: 5, locZ: 6 }, stats: {} }
    ];
    const partyRoute = coordinator.routeFor(members[0], currentSpot, party, members, { occupancy: {} });
    assert.strictEqual(partyRoute.mode, 'party');
    assert.strictEqual(Object.keys(partyRoute.destinations).length, 2);
    assert.deepStrictEqual(partyRoute.destinations['3'], destinationFor(members[1]));

    const dungeonPoint = { locX: 145224, locY: 120001, locZ: -4500 };
    const lair = { ...targetSpot, id: '24_20:antharas_lair', center: dungeonPoint, name: "Antharas' Lair" };
    const displacedMembers = members.map((m, i) => ({ ...m, spotId: lair.id, vitals: { hp: 100 },
        loc: { ...dungeonPoint, ...(i ? { locZ: 160 } : {}) } }));
    const displacedParty = { ...party, spotId: lair.id };
    SpotService.findCurrentSpot = loc => SpotService.containsLocation(lair, loc) ? lair : { id: '24_20' };
    SpotProfiles.findForState = () => lair;
    SpotService.arrivalPointForState = () => dungeonPoint;
    try {
        const repairOccupancy = { [lair.id]: { count: 2, reservedCount: 2, capacity: 2,
            retained: new Set(['2', '3']), reservedKeys: new Set(['2', '3']) } };
        const repairedRoute = coordinator.routeFor(displacedMembers[0], lair, displacedParty, displacedMembers, { occupancy: repairOccupancy });
        assert(repairedRoute?.needed);
        assert.strictEqual(repairOccupancy[lair.id].reservedCount, 2, 'position repair does not reserve existing members twice');
        assert.strictEqual(repairedRoute.cause, 'position_mismatch');
        assert.strictEqual(repairedRoute.reason, 'party_spot_replan');
        const Kernel = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
        const departing = Kernel.beginRouteTravelState(displacedMembers[1], repairedRoute, 1000);
        assert.strictEqual(departing.loc.locZ, 160, 'repair uses ordinary travel, not an instant move');
        assert.strictEqual(Kernel.finishPartyRouteTravelState(departing, 2000), null);
        const arrived = Kernel.finishPartyRouteTravelState(departing, 1000 + repairedRoute.travelMs);
        assert(SpotService.containsLocation(lair, arrived.loc));
        assert.strictEqual(arrived.spotId, lair.id);
        for (const patch of [{ phase: 'hot' }, { activity: 'resting' }, { stats: { pvpEncounter: { key: 'fighting' } } }]) {
            const blockedMembers = [displacedMembers[0], { ...displacedMembers[1], ...patch }];
            assert.strictEqual(coordinator.routeFor(blockedMembers[0], lair, displacedParty, blockedMembers, { occupancy: {} }), null);
        }
        const validMembers = displacedMembers.map(m => ({ ...m, loc: dungeonPoint }));
        assert.strictEqual(coordinator.routeFor(validMembers[0], lair, displacedParty, validMembers, { occupancy: {} }), null,
            'valid positions do not cause endless repair journeys');
        // Route planning uses full cached members even when the worker payload is compact.
        LifeState.cachedState = id => displacedMembers.find(m => m.characterId === id);
        const context = coordinator.contextFor(displacedMembers[0], { spots: new Map([[lair.id, lair]]),
            parties: new Map([[displacedParty.leaderId, displacedParty]]), occupancy: repairOccupancy, compactPartyMembers: true });
        assert(context.partyMembers.every(m => m.compact));
        assert.strictEqual(context.route.cause, 'position_mismatch');

        // The leader is already here, but two teammates still occupy another spot.
        const joiningMembers = [displacedMembers[0],
            { ...displacedMembers[1], spotId: currentSpot.id },
            { ...displacedMembers[1], characterId: 4, spotId: currentSpot.id }];
        const joiningParty = { ...displacedParty, memberIds: [2, 3, 4] };
        const occupied = { [lair.id]: { count: 3, reservedCount: 3, capacity: 4,
            retained: new Set(['2', '8', '9']), reservedKeys: new Set(['2', '8', '9']) } };
        assert.strictEqual(coordinator.routeFor(joiningMembers[0], lair, joiningParty, joiningMembers, { occupancy: occupied }), null,
            'repair cannot bring two unreserved members into one remaining slot');
        assert.strictEqual(occupied[lair.id].reservedCount, 3);
        assert.deepStrictEqual([...occupied[lair.id].reservedKeys], ['2', '8', '9'], 'rejected repair leaves reservations unchanged');
        occupied[lair.id].reservedKeys.delete('9');
        occupied[lair.id].retained.delete('9');
        occupied[lair.id].count = occupied[lair.id].reservedCount = 2;
        assert(coordinator.routeFor(joiningMembers[0], lair, joiningParty, joiningMembers, { occupancy: occupied })?.needed,
            'repair can proceed when both missing reservations fit');
        assert.strictEqual(occupied[lair.id].reservedCount, 4);
        assert(occupied[lair.id].reservedKeys.has('3') && occupied[lair.id].reservedKeys.has('4'));
        assert.strictEqual(SpotProfiles.reserveCapacity(occupied, lair, [{ characterId: 5 }]), false,
            'later routes must see the space taken by the arriving party');
        // Fixing coordinates of already counted hunters must also work on an overfull spot.
        occupied[lair.id].capacity = 3;
        assert(coordinator.routeFor(joiningMembers[0], lair, joiningParty, joiningMembers, { occupancy: occupied })?.needed);
        assert.strictEqual(occupied[lair.id].reservedCount, 4, 'repeated repair cannot add reservations');
    } finally {
        SpotService.findCurrentSpot = () => currentSpot;
        SpotProfiles.findForState = routeTargetForState;
        SpotService.arrivalPointForState = destinationFor;
        LifeState.cachedState = originalCachedState;
    }

    const pressuredMembers = [
        members[0],
        {
            ...members[1],
            stats: {
                deaths: 2,
                fightsResolved: 5,
                spotRisk: { spotId: currentSpot.id, deathsAtEntry: 0, fightsAtEntry: 0 }
            }
        }
    ];
    const pressuredPartyRoute = coordinator.routeFor(
        pressuredMembers[0],
        currentSpot,
        party,
        pressuredMembers,
        { occupancy: {}, timestamp: 5000 }
    );
    assert.strictEqual(pressuredPartyRoute.reason, 'party_spot_replan');
    assert.strictEqual(pressuredPartyRoute.cause, 'death_pressure');
    assert.strictEqual(pressuredPartyRoute.spotBackoff.spotId, currentSpot.id,
        'one member hitting the death threshold must move the whole party without splitting it');
    assert.strictEqual(pressuredPartyRoute.spotBackoff.until, 5000 + 60 * 60 * 1000);

    const requestPlan = {
        status: 'active',
        strategy: 'direct_drop',
        partyNeed: 'required',
        next: { spotId: targetSpot.id, npcId: 414, itemId: 9001 },
        target: { selfId: 9001 }
    };
    const request = PartyRequestPlanner.partyRequestForPlan({
        characterId: 4,
        activity: 'hunting',
        stats: {}
    }, requestPlan, 1000);
    assert.strictEqual(request.status, 'open', 'the worker must create a durable party request for a required plan');
    assert.strictEqual(request.priority, 'required');
    const config = invoke('GameServer/Bot/Population/PopulationConfig');
    const expiredRequest = PartyRequestPlanner.partyRequestForPlan({
        characterId: 4,
        activity: 'hunting',
        stats: {
            partyRequest: {
                ...request,
                status: 'open',
                requestedAt: 1000
            }
        }
    }, requestPlan, 1000 + Math.max(30000, Number(config.partyRequestMaxAgeMs) || 15 * 60 * 1000) + 1);
    assert.strictEqual(expiredRequest.status, 'deferred', 'the worker request helper must preserve deferred recovery semantics');
    assert.strictEqual(expiredRequest.attempts, 1);

    const fallbackSpot = { id: 'solo-fallback', name: 'Solo fallback' };
    GearAcquisitionPlanner.safeFallbackForPlan = () => ({ spotId: fallbackSpot.id, npcId: 321 });
    const fallbackRoute = coordinator.routeFor({
        characterId: 5,
        phase: 'cold',
        activity: 'hunting',
        level: 16,
        spotId: currentSpot.id,
        loc: { locX: 1, locY: 2, locZ: 3 },
        stats: { equipmentPlan: requestPlan }
    }, currentSpot, null, [], {
        occupancy: {},
        spots: new Map([[fallbackSpot.id, fallbackSpot]])
    });
    assert.strictEqual(fallbackRoute.spotId, fallbackSpot.id,
        'a no-party required plan must route to a safe fallback instead of its party-only source');

    GearAcquisitionPlanner.safeFallbackForPlan = originalSafeFallbackForPlan;
    const profiles = [currentSpot, targetSpot];
    let rewardScans = 0;
    const rewards = DataCache.npcRewards;
    const originalForEach = rewards.forEach;
    rewards.forEach = function (...args) {
        rewardScans += 1;
        return originalForEach.apply(this, args);
    };
    try {
        for (const characterId of [51, 52]) {
            coordinator.routeFor({
                characterId,
                phase: 'cold',
                activity: 'hunting',
                level: 16,
                spotId: currentSpot.id,
                loc: { locX: 1, locY: 2, locZ: 3 },
                stats: { equipmentPlan: {
                    status: 'active', strategy: 'direct_drop',
                    partyNeed: 'required', target: { selfId: 1 }
                } }
            }, currentSpot, null, [], {
                profiles,
                spots: new Map(profiles.map((spot) => [spot.id, spot])),
                occupancy: {}
            });
        }
        assert.strictEqual(rewardScans, 1,
            'repeated cold fallback routes must reuse the reward index across context batches');
    } finally {
        delete rewards.forEach;
    }

    console.log('Cold worker leveling route planning checks passed');
} finally {
    SpotProfiles.findForState = originalFindForState;
    SpotService.findCurrentSpot = originalFindCurrentSpot;
    SpotService.arrivalPointForState = originalArrivalPointForState;
    GearAcquisitionPlanner.safeFallbackForPlan = originalSafeFallbackForPlan;
    LifeState.cachedState = originalCachedState;
}
