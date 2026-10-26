const assert = require('assert');

require('../src/Global');

// A bot whose gear plan needs a party waits for one while it hunts a safe
// spot. Two places decide this: the bot's route (BotRoute, in the worker)
// and the command resolve (resolveColdState). These checks pin
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
const BotRoute = require('../src/GameServer/Bot/Population/BotRoute');
const PartyWaitFallback = require('../src/GameServer/Bot/Population/PartyWaitFallback');

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

function routeChecks() {
    const route = (state) => BotRoute.route(state, currentSpot, null, [], { spots: profiles, timestamp: Date.now() });

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

    // ROUTE-ROOM-3: the worker's room filter refuses a planned fallback spot
    // with no room (the plan-free level search decides), but not the spot the
    // bot stands on.
    GearPlanner.safeFallbackForPlan = () => ({ spotId: plannedFallback.id, npcId: 321 });
    const fallbackWith = (state, hasRoom) => PartyWaitFallback.spotFor(state, partyPlan, profiles,
        { excludedSpotIds: new Set(), timestamp: Date.now(), hasRoom })?.spot?.id;
    assert.strictEqual(fallbackWith(routeState(7, {}), id => id !== plannedFallback.id), genericFallback.id,
        'a full planned fallback is skipped: the plan-free search decides');
    assert.strictEqual(fallbackWith(routeState(8, {}, { spotId: plannedFallback.id }), () => false), plannedFallback.id,
        'the planned fallback the bot stands on is kept even when it counts as full');
    assert.strictEqual(fallbackWith(routeState(9, {}), () => true), plannedFallback.id,
        'a fallback with room is taken');

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

    // The coordinator follows the party request like the worker (step 1.3
    // U2): a party-only plan without a request does not wait...
    GearPlanner.safeFallbackForPlan = () => ({ spotId: plannedFallback.id, npcId: 321 });
    assert.strictEqual(route(routeState(5, { equipmentPlan: partyPlan })).spotId, planSpot.id,
        'U2: a party-only plan without a party request does not wait');

    // ...and a required request of a clan hunt waits even with a solo-safe plan.
    assert.strictEqual(route(routeState(6, { equipmentPlan: soloPlan, partyRequest: requiredRequest })).spotId,
        plannedFallback.id, 'U2: a required request waits even when the plan is solo-safe');

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
    // The worker's plan is used as it is, its drop source included (main
    // picks no source again). The plan arrives with the party request the
    // worker built for it (main builds none), and the request's route names
    // the trip it started or the ground it fought on.
    const command = (state, plan, route) => {
        applied.length = 0;
        upserted.length = 0;
        reviewed.length = 0;
        return PopulationService.resolveColdState(state, {
            precomputedPlan: { previousPlan: null, acquisitionPlan: plan, replanFailure: null,
                partyRequest: invoke('GameServer/Bot/Population/PartyRequestPlanner')
                    .partyRequestForPlan(state, plan, Date.now(), { economy: { worth: () => 0 } }) },
            precomputedResult: workerFight(),
            route
        });
    };
    const worked = { needed: false, spotId: currentSpot.id };

    // A waiter with a worker fight is relabelled to the plan's safe fallback.
    GearPlanner.safeFallbackForPlan = () => ({ spotId: plannedFallback.id, npcId: 321 });
    let result = await command(routeState(11, {}), partyPlan, worked);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(applied.length, 1, 'the worker fight is applied');
    assert.strictEqual(applied[0].spotId, plannedFallback.id, 'a commanded waiter is placed on its safe fallback');
    assert.strictEqual(applied[0].activity, 'hunting');

    // The planned fallback is unsafe: the plan-free level search decides.
    GearPlanner.safeFallbackForPlan = () => ({ spotId: unsafeFallback.id, npcId: 321 });
    result = await command(routeState(12, {}), partyPlan, worked);
    assert.strictEqual(applied[0].spotId, genericFallback.id, 'an unsafe planned fallback gives way to the level search');

    // A clan hunt asks for a party even with a solo-safe plan: the command waits.
    GearPlanner.safeFallbackForPlan = () => ({ spotId: plannedFallback.id, npcId: 321 });
    result = await command(routeState(13, { clanPartyObjective: clanObjective }), soloPlan, worked);
    assert.strictEqual(applied[0].spotId, plannedFallback.id, 'a clan-hunt request makes a solo-safe planner wait');

    // A resting waiter finishes its rest first (step 1.3 D3).
    result = await command(routeState(14, {}, { activity: 'resting' }), partyPlan, worked);
    assert.strictEqual(applied[0].spotId, plannedFallback.id);
    assert.strictEqual(applied[0].activity, 'resting', 'D3: a found fallback does not skip the rest');

    // Not a waiter: main takes the spot the worker fought on and keeps the
    // worker fight; it runs no spot search of its own (step 1.3 U3).
    SpotProfiles.findForState = () => assert.fail('a command runs no second spot search');
    result = await command(routeState(15, {}), soloPlan, worked);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(applied.length, 1, 'U3: the worker fight on known ground is kept');
    assert.strictEqual(applied[0].spotId, currentSpot.id);
    assert.deepStrictEqual(applied[0].stats.equipmentPlan, soloPlan, 'main applies the worker\'s drop plan as is');
    assert(reviewed.length && reviewed.every((id) => id === currentSpot.id),
        'the goal review sees the ground the worker fought on');
    // A trip the worker's step started (its request's route) names its destination.
    result = await command(routeState(17, {}), soloPlan, { needed: true, spotId: levelSpot.id });
    assert.strictEqual(applied.length, 1);
    assert(reviewed.length && reviewed.every((id) => id === levelSpot.id), 'the goal review sees the trip\'s destination');
    // Without any spot in the worker's route the rest stays.
    result = await command(routeState(16, {}), soloPlan, { needed: false, spotId: null });
    assert.strictEqual(result.reason, 'missing_spot_recovery', 'no spot anywhere: the bot rests and retries');
    assert.strictEqual(upserted[0].value.activity, 'resting');
    SpotProfiles.findForState = findForStateStub;
}

// The one rule of who waits, as each caller asks it.
function waitingChecks() {
    const { waiting } = require('../src/GameServer/Bot/Population/PartyWaitFallback');
    const deferred = { ...requiredRequest, status: 'deferred', priority: 'preferred' };
    const open = { ...requiredRequest, priority: 'preferred' };
    const cases = [
        [{}, partyPlan, requiredRequest, true],
        [{}, soloPlan, requiredRequest, true],
        [{}, partyPlan, deferred, true],
        [{}, { ...soloPlan, requiresParty: true }, deferred, true],
        [{}, soloPlan, deferred, false],
        [{}, partyPlan, open, false],
        [{}, partyPlan, null, false],
        [{ party: { partyId: 'p' } }, partyPlan, requiredRequest, false]
    ];
    cases.forEach(([state, plan, request, expected], index) => {
        assert.strictEqual(waiting(state, plan, request), expected, `waiting case ${index}`);
    });
}

async function run() {
    waitingChecks();
    SpotProfiles.ensure = () => profiles;
    SpotProfiles.findForState = findForStateStub;
    SpotService.findCurrentSpot = () => currentSpot;
    SpotService.arrivalPointForState = (state, destination) => ({ ...destination.center });
    LevelingRoutes.isSpotAllowedForState = (candidate) => candidate.id !== unsafeFallback.id;
    routeChecks();
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
