const assert = require('assert');

require('../src/Global');

const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const GearPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const PopulationService = invoke('GameServer/Bot/Population/PopulationService');
const BackgroundResolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const ColdMarketListingService = invoke('GameServer/Bot/Economy/ColdMarketListingService');
const ColdMarketService = invoke('GameServer/Bot/Economy/ColdMarketService');
const ColdMarketTradeChat = invoke('GameServer/Bot/Economy/ColdMarketTradeChat');
const GoalService = invoke('GameServer/Bot/Goals/GoalService');
const GoalExecutor = invoke('GameServer/Bot/Goals/GoalExecutor');
const LifeEvents = invoke('GameServer/Bot/Population/BotLifeEvents');

const originals = {
    ensure: SpotProfiles.ensure,
    findForState: SpotProfiles.findForState,
    planFor: GearPlanner.planFor,
    upsertState: LifeState.upsertState,
    applyResolve: LifeState.applyResolve,
    refreshInventory: LifeState.refreshInventory,
    resolveSolo: BackgroundResolver.resolveSolo,
    reconcileInventory: ColdMarketListingService.reconcileInventory,
    resolveListing: ColdMarketListingService.resolve,
    currentGoal: GoalService.current,
    tryPurchase: ColdMarketService.tryPurchase,
    announceTrade: ColdMarketTradeChat.maybeAnnounce,
    reviewGoal: GoalService.review,
    beginMarketTravel: GoalExecutor.beginMarketTravel,
    recordMany: LifeEvents.recordMany,
    partyWaitReplanMs: Config.partyWaitReplanMs
};

async function run() {
    Config.partyWaitReplanMs = 5 * 60 * 1000;
    const state = {
        characterId: 9101,
        name: 'PartyWaitProbe',
        phase: 'cold',
        level: 30,
        activity: 'hunting',
        spotId: 'cruma',
        timing: { nextResolveAt: Date.now() - 1 },
        stats: { travel: null },
        party: {},
        inventory: {}
    };
    let applied = null;
    let resolverOptions = null;
    const fallbackSpot = {
        id: 'safe_fallback',
        name: 'Safe fallback',
        avgLevel: 20,
        minLevel: 18,
        maxLevel: 22,
        density: 3,
        npcSelfIds: [1],
        npcEntries: [{ selfId: 1, count: 1 }],
        rewards: { exp: 10, sp: 1, adenaMin: 1, adenaMax: 1 },
        mob: { hp: 1, damage: 1 }
    };
    SpotProfiles.ensure = () => [];
    SpotProfiles.findForState = () => fallbackSpot;
    GearPlanner.planFor = () => ({
        status: 'active',
        partyNeed: 'required',
        requiresParty: true,
        target: { selfId: 88 },
        next: { spotId: 'unsafe_target', npcId: 77, itemId: 88 },
        strategy: 'farm'
    });
    BackgroundResolver.resolveSolo = (options) => {
        resolverOptions = options;
        return {
            patch: { activity: 'hunting', spotId: fallbackSpot.id, vitals: options.state.vitals || {} },
            materialize: { exp: 1, sp: 1, adena: 1, items: [] },
            nextResolveAt: Date.now() + 60000,
            debug: { fights: 1, wins: 1, losses: 0, deaths: 0, defeatedNpcIds: [1] },
            events: []
        };
    };
    LifeState.applyResolve = (current, result) => {
        applied = {
            ...current,
            ...result.patch,
            timing: { ...(current.timing || {}), nextResolveAt: result.nextResolveAt },
            stats: { ...(current.stats || {}) }
        };
        return Promise.resolve(applied);
    };
    LifeState.refreshInventory = (current) => Promise.resolve(current);
    LifeState.upsertState = (next) => Promise.resolve(next);
    ColdMarketListingService.reconcileInventory = (current) => Promise.resolve({ state: current, closed: false });
    ColdMarketListingService.resolve = (lifecycle) => Promise.resolve({ state: lifecycle?.state || applied || state, closed: false });
    GoalService.current = () => Promise.resolve({ current: null });
    ColdMarketService.tryPurchase = (current) => Promise.resolve({ state: current, purchased: false });
    ColdMarketTradeChat.maybeAnnounce = (current) => Promise.resolve({ state: current });
    GoalService.review = () => Promise.resolve({ current: null });
    GoalExecutor.beginMarketTravel = () => null;
    LifeEvents.recordMany = () => Promise.resolve();

    const result = await PopulationService.resolveColdState(state);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(applied.activity, 'hunting', 'a required party request must keep the bot progressing solo');
    assert.strictEqual(applied.spotId, fallbackSpot.id, 'an unmatched requester must use a safe fallback spot');
    assert.strictEqual(applied.stats.partyRequest.priority, 'required');
    assert.strictEqual(applied.stats.partyWaitUntil, undefined, 'the non-blocking request must not create a wait deadline');
    assert(applied.timing.nextResolveAt > Date.now(), 'the fallback hunt must retain a normal combat deadline');
    assert.strictEqual(resolverOptions.targetNpcId, 0, 'fallback combat must not pretend to farm the unsafe acquisition target');

    GearPlanner.planFor = () => ({
        status: 'active',
        partyNeed: 'preferred',
        requiresParty: false,
        target: { selfId: 88 },
        next: { spotId: 'preferred_target', npcId: 77, itemId: 88 },
        strategy: 'direct_drop'
    });
    resolverOptions = null;
    const preferredResult = await PopulationService.resolveColdState({ ...state, characterId: 9102 });
    assert.strictEqual(preferredResult.ok, true);
    assert.strictEqual(resolverOptions.state.spotId, 'cruma', 'a preferred request must keep its planned route while looking for a party');
    assert.strictEqual(resolverOptions.targetNpcId, 77, 'a preferred request must continue targeting its planned dropper');

    const timestamp = Date.now();
    const requestPlan = {
        status: 'active',
        partyNeed: 'required',
        requiresParty: true,
        target: { selfId: 88 },
        next: { spotId: 'unsafe_target', npcId: 77, itemId: 88 },
        strategy: 'farm'
    };
    const oldRequestState = {
        activity: 'hunting',
        stats: {
            partyRequest: {
                status: 'open',
                priority: 'required',
                objectiveKey: 'farm:unsafe_target:77',
                spotId: 'unsafe_target',
                npcId: 77,
                itemId: 88,
                targetId: 88,
                requestedAt: timestamp - Config.partyRequestMaxAgeMs - 1,
                attempts: 2
            }
        }
    };
    const deferred = PopulationService.partyRequestForPlan(oldRequestState, requestPlan, timestamp);
    assert.strictEqual(deferred.status, 'deferred', 'an unmatched request must leave the open queue after its TTL');
    assert(deferred.deferredUntil > timestamp, 'deferred request must carry a cooldown deadline');
    assert.strictEqual(
        PopulationService.partyObjectiveForState({ stats: { partyRequest: deferred, equipmentPlan: requestPlan } }),
        null,
        'deferred requests must not keep a formation objective alive'
    );
    const duringCooldown = PopulationService.partyRequestForPlan({
        ...oldRequestState,
        stats: { ...oldRequestState.stats, partyRequest: deferred }
    }, requestPlan, timestamp + 1000);
    assert.strictEqual(duringCooldown.status, 'deferred', 'a request must stay deferred during its cooldown');
    const reopened = PopulationService.partyRequestForPlan({
        ...oldRequestState,
        stats: { ...oldRequestState.stats, partyRequest: deferred }
    }, requestPlan, deferred.deferredUntil + 1);
    assert.strictEqual(reopened.status, 'open', 'a deferred request must be eligible for a fresh formation attempt');

    assert.strictEqual(PopulationService.partySessionExpired({ startedAt: timestamp - Config.partySessionMaxMs - 1 }, timestamp), true);
    assert.strictEqual(PopulationService.partySessionExpired({ startedAt: timestamp - 1000 }, timestamp), false);
    assert.strictEqual(PopulationService.partySessionExpired({
        startedAt: timestamp - Config.partySessionMaxMs - 60000,
        stats: { sessionExpiresAt: timestamp + 60000 }
    }, timestamp), false, 'a staggered session expiry must override the nominal party age');
    assert.strictEqual(PopulationService.partySessionExpired({ stats: { sessionExpiresAt: timestamp - 1 } }, timestamp), true, 'an explicit staggered session expiry must rotate the party');
    console.log('Bot party request fallback checks passed');
}

run().catch((err) => {
    console.error(err);
    process.exitCode = 1;
}).finally(() => {
    SpotProfiles.ensure = originals.ensure;
    SpotProfiles.findForState = originals.findForState;
    GearPlanner.planFor = originals.planFor;
    LifeState.upsertState = originals.upsertState;
    LifeState.applyResolve = originals.applyResolve;
    LifeState.refreshInventory = originals.refreshInventory;
    BackgroundResolver.resolveSolo = originals.resolveSolo;
    ColdMarketListingService.reconcileInventory = originals.reconcileInventory;
    ColdMarketListingService.resolve = originals.resolveListing;
    GoalService.current = originals.currentGoal;
    ColdMarketService.tryPurchase = originals.tryPurchase;
    ColdMarketTradeChat.maybeAnnounce = originals.announceTrade;
    GoalService.review = originals.reviewGoal;
    GoalExecutor.beginMarketTravel = originals.beginMarketTravel;
    LifeEvents.recordMany = originals.recordMany;
    Config.partyWaitReplanMs = originals.partyWaitReplanMs;
});
