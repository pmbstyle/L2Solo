const assert = require('assert');

require('../src/Global');

// A bot whose gear plan needs a party waits for one while it hunts a safe
// spot. Two places decide this on the main thread: the coordinator route
// (routeFor) and the command resolve (resolveColdState). These checks pin
// who waits and which spot the waiter hunts.

const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const SpotService = invoke('GameServer/Bot/AI/SpotService');
const LevelingRoutes = invoke('GameServer/Bot/AI/LevelingRoutes');
const GearPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const ListingService = invoke('GameServer/Bot/Economy/ColdMarketListingService');
const MarketService = invoke('GameServer/Bot/Economy/ColdMarketService');
const GoalService = invoke('GameServer/Bot/Goals/GoalService');
const LifeEvents = invoke('GameServer/Bot/Population/BotLifeEvents');
const GlobalChat = invoke('GameServer/Bot/Population/BotGlobalChat');
const PopulationService = invoke('GameServer/Bot/Population/PopulationService');
const { ColdSimulationCoordinator } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');

invoke('GameServer/DataCache').init();

const originals = {
    ensure: SpotProfiles.ensure,
    findForState: SpotProfiles.findForState,
    findCurrentSpot: SpotService.findCurrentSpot,
    arrivalPointForState: SpotService.arrivalPointForState,
    isSpotAllowedForState: LevelingRoutes.isSpotAllowedForState,
    safeFallbackForPlan: GearPlanner.safeFallbackForPlan,
    cachedState: LifeState.cachedState,
    applyResolve: LifeState.applyResolve,
    upsertState: LifeState.upsertState,
    reconcileInventory: ListingService.reconcileInventory,
    resolveListing: ListingService.resolve,
    tryPurchase: MarketService.tryPurchase,
    current: GoalService.current,
    review: GoalService.review,
    recordMany: LifeEvents.recordMany,
    globalAnnounce: GlobalChat.maybeAnnounce
};

const spot = (id, locX) => ({ id, name: id, center: { locX, locY: 0, locZ: 0 } });
const currentSpot = spot('current_ground', 10);
const planSpot = spot('plan_ground', 6010);
const levelSpot = spot('level_ground', 12010);
const plannedFallback = spot('planned_fallback', 18010);
const unsafeFallback = spot('unsafe_fallback', 24010);
const genericFallback = spot('generic_fallback', 30010);
const profiles = [currentSpot, planSpot, levelSpot, plannedFallback, unsafeFallback, genericFallback];

const partyPlan = {
    status: 'active',
    strategy: 'direct_drop',
    partyNeed: 'required',
    requiresParty: true,
    target: { selfId: 88 },
    next: { spotId: planSpot.id, npcId: 77, itemId: 88 }
};
const soloPlan = { ...partyPlan, partyNeed: 'solo_ok', requiresParty: false };
const requiredRequest = { status: 'open', priority: 'required', objectiveKey: 'direct_drop:plan_ground:77',
    spotId: planSpot.id, npcId: 77, itemId: 88, targetId: 88, requestedAt: Date.now(), attempts: 0 };
const clanObjective = { status: 'open', priority: 'required', objectiveKey: 'clan:7:raid', reason: 'clan_hunt',
    spotId: planSpot.id, npcId: 77, clanId: 7, clanGoalKey: 'clan:7:raid' };

// The level search answers with the plan's spot while the bot has a plan, and
// with the generic fallback for a waiter's plan-free search.
const searches = [];
function findForStateStub(state, options = {}) {
    searches.push({ spotId: state.spotId ?? null, plan: !!state.stats?.equipmentPlan, options });
    if (state.spotId === null && !state.stats?.equipmentPlan) return genericFallback;
    return state.stats?.equipmentPlan ? planSpot : levelSpot;
}

function routeState(characterId, stats, extra = {}) {
    return { characterId, name: `Waiter${characterId}`, phase: 'cold', activity: 'hunting', level: 30,
        spotId: currentSpot.id, currentRegion: currentSpot.name, loc: { ...currentSpot.center },
        vitals: { hp: 1000, maxHp: 1000, mp: 500, maxMp: 500 }, inventory: {}, adena: 1000,
        timing: { lastResolvedAt: Date.now() - 30000 }, stats, ...extra };
}

function coordinatorChecks() {
    const coordinator = new ColdSimulationCoordinator();
    const index = () => ({ occupancy: {}, profiles, spots: new Map(profiles.map((entry) => [entry.id, entry])) });
    const route = (state) => coordinator.routeFor(state, currentSpot, null, [], index());

    // Waiter: a required request with a party-only plan hunts the plan's safe fallback.
    GearPlanner.safeFallbackForPlan = () => ({ spotId: plannedFallback.id, npcId: 321 });
    assert.strictEqual(route(routeState(1, { equipmentPlan: partyPlan, partyRequest: requiredRequest })).spotId,
        plannedFallback.id, 'a required waiter routes to the safe fallback of its plan');

    // A deferred request with a party-only plan still waits.
    const deferred = { ...requiredRequest, status: 'deferred', deferredUntil: Date.now() + 60000 };
    assert.strictEqual(route(routeState(2, { equipmentPlan: partyPlan, partyRequest: deferred })).spotId,
        plannedFallback.id, 'a deferred waiter keeps its safe fallback');

    // The plan's fallback is not allowed for the bot: the waiter searches level
    // ground without its plan and without its saved spot.
    GearPlanner.safeFallbackForPlan = () => ({ spotId: unsafeFallback.id, npcId: 321 });
    searches.length = 0;
    assert.strictEqual(route(routeState(3, { equipmentPlan: partyPlan, partyRequest: requiredRequest })).spotId,
        genericFallback.id, 'an unsafe planned fallback gives way to a plan-free level search');
    assert(searches.some((entry) => entry.spotId === null && !entry.plan), 'the generic search drops plan and saved spot');

    // No fallback at all: the waiter keeps the ordinary route search.
    GearPlanner.safeFallbackForPlan = () => null;
    LevelingRoutes.isSpotAllowedForState = (candidate) => candidate.id !== unsafeFallback.id
        && candidate.id !== genericFallback.id;
    SpotProfiles.findForState = (state, options) => (state.spotId === null && !state.stats?.equipmentPlan
        ? null : findForStateStub(state, options));
    assert.strictEqual(route(routeState(4, { equipmentPlan: partyPlan, partyRequest: requiredRequest })).spotId,
        planSpot.id, 'a waiter without any fallback keeps the ordinary route');
    SpotProfiles.findForState = findForStateStub;
    LevelingRoutes.isSpotAllowedForState = (candidate) => candidate.id !== unsafeFallback.id;

    // Today the coordinator asks only the plan: a party-only plan without a
    // party request waits (step 1.3 U2 moves this pin).
    GearPlanner.safeFallbackForPlan = () => ({ spotId: plannedFallback.id, npcId: 321 });
    assert.strictEqual(route(routeState(5, { equipmentPlan: partyPlan })).spotId, plannedFallback.id,
        'U2 pin: the coordinator waits on a party-only plan without a party request');

    // Today a required request of a clan hunt with a solo-safe plan does not
    // wait in the coordinator (step 1.3 U2 moves this pin).
    assert.strictEqual(route(routeState(6, { equipmentPlan: soloPlan, partyRequest: requiredRequest })).spotId,
        planSpot.id, 'U2 pin: the coordinator ignores a required request when the plan is solo-safe');

    // A party member never waits.
    const member = routeState(7, { equipmentPlan: partyPlan, partyRequest: requiredRequest },
        { party: { partyId: 'p7' } });
    assert.strictEqual(route(member).spotId, planSpot.id, 'a bot in a party does not wait for one');
}

// The worker fought at the current ground; its patch keeps that spot.
const workerFight = () => ({
    patch: { activity: 'hunting', spotId: currentSpot.id, loc: { ...currentSpot.center }, stats: {} },
    events: [],
    materialize: { exp: 100, sp: 0, adena: 50, items: [] },
    nextResolveAt: Date.now() + 30000,
    debug: { fights: 2, wins: 2 }
});

async function commandChecks() {
    const applied = [];
    const upserted = [];
    LifeState.cachedState = () => null;
    LifeState.applyResolve = (value, result) => {
        applied.push(value);
        return Promise.resolve({ ...value, ...result.patch, stats: { ...value.stats, ...result.patch.stats } });
    };
    LifeState.upsertState = (value, reason) => {
        upserted.push({ value, reason });
        return Promise.resolve(value);
    };
    ListingService.reconcileInventory = (value) => Promise.resolve({ state: value, closed: false });
    ListingService.resolve = (lifecycle) => Promise.resolve({ state: lifecycle?.state || lifecycle, closed: false });
    MarketService.tryPurchase = (value) => Promise.resolve({ state: value, purchased: false });
    GoalService.current = () => Promise.resolve(null);
    // The goal review after the fight receives the spot main settled on.
    const reviewed = [];
    GoalService.review = (state, options) => {
        reviewed.push(options?.spot?.id || null);
        return Promise.resolve(null);
    };
    LifeEvents.recordMany = () => Promise.resolve(null);
    GlobalChat.maybeAnnounce = () => null;
    // The worker's plan is used as it is: a 'farm' plan has no drop source
    // for main to re-check.
    const command = (state, plan, context = {}) => {
        applied.length = 0;
        upserted.length = 0;
        reviewed.length = 0;
        return PopulationService.resolveColdState(state, {
            precomputedPlan: { previousPlan: null, acquisitionPlan: plan, replanFailure: null },
            precomputedResult: workerFight(),
            context
        });
    };
    const farmPartyPlan = { ...partyPlan, strategy: 'farm' };
    const farmSoloPlan = { ...soloPlan, strategy: 'farm' };
    const worked = { spot: currentSpot, route: null };

    // A waiter with a worker fight is relabelled to the plan's safe fallback.
    GearPlanner.safeFallbackForPlan = () => ({ spotId: plannedFallback.id, npcId: 321 });
    let result = await command(routeState(11, {}), farmPartyPlan, worked);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(applied.length, 1, 'the worker fight is applied');
    assert.strictEqual(applied[0].spotId, plannedFallback.id, 'a commanded waiter is placed on its safe fallback');
    assert.strictEqual(applied[0].activity, 'hunting');

    // The planned fallback is unsafe: the plan-free level search decides.
    GearPlanner.safeFallbackForPlan = () => ({ spotId: unsafeFallback.id, npcId: 321 });
    result = await command(routeState(12, {}), farmPartyPlan, worked);
    assert.strictEqual(applied[0].spotId, genericFallback.id, 'an unsafe planned fallback gives way to the level search');

    // A clan hunt asks for a party even with a solo-safe plan: the command waits.
    GearPlanner.safeFallbackForPlan = () => ({ spotId: plannedFallback.id, npcId: 321 });
    result = await command(routeState(13, { clanPartyObjective: clanObjective }), farmSoloPlan, worked);
    assert.strictEqual(applied[0].spotId, plannedFallback.id, 'a clan-hunt request makes a solo-safe planner wait');

    // A resting waiter is relabelled as hunting today (step 1.3 D3 moves this pin).
    result = await command(routeState(14, {}, { activity: 'resting' }), farmPartyPlan, worked);
    assert.strictEqual(applied[0].activity, 'hunting', 'D3 pin: a found fallback turns a resting waiter into a hunter');

    // Not a waiter: main takes the spot the coordinator chose and keeps the
    // worker fight; it runs no spot search of its own (step 1.3 U3).
    SpotProfiles.findForState = () => assert.fail('a command runs no second spot search');
    result = await command(routeState(15, {}), farmSoloPlan, worked);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(applied.length, 1, 'U3: the worker fight on known ground is kept');
    assert.strictEqual(applied[0].spotId, currentSpot.id);
    assert(reviewed.length && reviewed.every((id) => id === currentSpot.id),
        'the goal review sees the ground the worker fought on');
    // A trip the coordinator started names its destination.
    result = await command(routeState(17, {}), farmSoloPlan,
        { spot: currentSpot, route: { needed: true, spotId: levelSpot.id } });
    assert.strictEqual(applied.length, 1);
    assert(reviewed.length && reviewed.every((id) => id === levelSpot.id), 'the goal review sees the trip\'s destination');
    // Without any spot in the worker's context the rest stays.
    result = await command(routeState(16, {}), farmSoloPlan, {});
    assert.strictEqual(result.reason, 'missing_spot_recovery', 'no spot anywhere: the bot rests and retries');
    assert.strictEqual(upserted[0].value.activity, 'resting');
    SpotProfiles.findForState = findForStateStub;
}

async function run() {
    SpotProfiles.ensure = () => profiles;
    SpotProfiles.findForState = findForStateStub;
    SpotService.findCurrentSpot = () => currentSpot;
    SpotService.arrivalPointForState = (state, destination) => ({ ...destination.center });
    LevelingRoutes.isSpotAllowedForState = (candidate) => candidate.id !== unsafeFallback.id;
    coordinatorChecks();
    await commandChecks();
    console.log('Party wait fallback checks passed');
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => {
    Object.assign(SpotProfiles, { ensure: originals.ensure, findForState: originals.findForState });
    Object.assign(SpotService, { findCurrentSpot: originals.findCurrentSpot,
        arrivalPointForState: originals.arrivalPointForState });
    LevelingRoutes.isSpotAllowedForState = originals.isSpotAllowedForState;
    GearPlanner.safeFallbackForPlan = originals.safeFallbackForPlan;
    Object.assign(LifeState, { cachedState: originals.cachedState, applyResolve: originals.applyResolve,
        upsertState: originals.upsertState });
    Object.assign(ListingService, { reconcileInventory: originals.reconcileInventory, resolve: originals.resolveListing });
    MarketService.tryPurchase = originals.tryPurchase;
    Object.assign(GoalService, { current: originals.current, review: originals.review });
    LifeEvents.recordMany = originals.recordMany;
    GlobalChat.maybeAnnounce = originals.globalAnnounce;
});
