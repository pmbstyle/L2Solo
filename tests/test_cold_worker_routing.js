const assert = require('assert');

require('../src/Global');

const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const SpotService = invoke('GameServer/Bot/AI/SpotService');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const PartyRequestPlanner = invoke('GameServer/Bot/Population/PartyRequestPlanner');
const {
    ColdSimulationCoordinator,
    compactPartyMemberContext
} = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');

const originalFindForState = SpotProfiles.findForState;
const originalFindCurrentSpot = SpotService.findCurrentSpot;
const originalArrivalPointForState = SpotService.arrivalPointForState;
const originalSafeFallbackForPlan = GearAcquisitionPlanner.safeFallbackForPlan;
const originalCachedState = LifeState.cachedState;

try {
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
    const targetSpot = { id: 'mid-level-field', name: 'Mid-level fields' };
    const destinationFor = (state) => ({
        locX: 125000 + Number(state.characterId || 0),
        locY: -176000,
        locZ: -1000
    });
    SpotService.findCurrentSpot = () => currentSpot;
    SpotService.arrivalPointForState = destinationFor;
    SpotProfiles.findForState = (state, options) => {
        if (options?.mode === 'party') {
            assert.strictEqual(state.stats.routeMode, 'party');
            assert(state.party?.partyId);
        }
        return targetSpot;
    };

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

    console.log('Cold worker leveling route planning checks passed');
} finally {
    SpotProfiles.findForState = originalFindForState;
    SpotService.findCurrentSpot = originalFindCurrentSpot;
    SpotService.arrivalPointForState = originalArrivalPointForState;
    GearAcquisitionPlanner.safeFallbackForPlan = originalSafeFallbackForPlan;
    LifeState.cachedState = originalCachedState;
}
