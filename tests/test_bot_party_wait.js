const assert = require('assert');

const fs = require('node:fs');
const nodePath = require('node:path');
const isolated = require('./helpers/isolatedSocialDatabase')('bot_party_wait', nodePath.resolve(__dirname, '..'));
require('./helpers/databaseIsolation');
require('../src/Global');
isolated.assertConfigured(options.default);
invoke('GameServer/DataCache').init();

const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const GearPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const PopulationService = invoke('GameServer/Bot/Population/PopulationService');
const BackgroundResolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const ColdMarketListingService = invoke('GameServer/Bot/Economy/ColdMarketListingService');
const ColdMarketService = invoke('GameServer/Bot/Economy/ColdMarketService');
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
    reviewGoal: GoalService.review,
    beginMarketTravel: GoalExecutor.beginMarketTravel,
    recordMany: LifeEvents.recordMany
};

// A bot waiting for a party keeps its gear plan with no clock: the plan is
// chosen again only when an input of the choice moves (here its kit), however
// long it waits, and the open request carries the key it was chosen under.
function planKeptWhileWaiting() {
    const Selection = invoke('GameServer/Bot/AI/GearPlanSelection');
    const Providers = invoke('GameServer/Bot/Economy/WishProviders');
    const Requests = invoke('GameServer/Bot/Population/PartyRequestPlanner');
    const stubbed = ['planFor', 'combatReadiness', 'bestSourceForPlan', 'replacementPlanFor', 'fundedMarketPlanForTarget',
        'finalizePlan', 'isPlanSourceViableForState'];
    const saved = Object.fromEntries(stubbed.map(name => [name, GearPlanner[name]]));
    const savedCraft = Providers.personalCraftPlan;
    let planned = 0;
    const plan = { status: 'active', strategy: 'direct_drop', requiresParty: true, partyNeed: 'required',
        target: { selfId: 100 }, next: { spotId: 'x', npcId: 1 } };
    Object.assign(GearPlanner, { planFor: () => { planned++; return plan; }, combatReadiness: () => ({ hasWeapon: true }),
        bestSourceForPlan: () => ({ spotId: 'x', npcId: 1 }), replacementPlanFor: () => null,
        fundedMarketPlanForTarget: () => null, finalizePlan: (_state, _previous, next) => next,
        isPlanSourceViableForState: () => true });
    Providers.personalCraftPlan = () => null;
    try {
        const wish = { key: 'power:100:7', object: { itemId: 100, slot: 7 }, funded: false };
        // Every step rebuilds the economy: the build's own memo is gone.
        const economy = () => ({ network: { queue: [wish], focus: [wish.key],
            activity: { rootKey: wish.key, activity: 'hunting', key: 'hunt:x' } }, statsPacket: {} });
        const step = (state, timestamp) => {
            const chosen = Selection.selectAcquisitionPlan(state, plan, { timestamp, preparedEconomy: economy(),
                preparedReplanContext: { routeCurrent: true, failure: null } });
            return { chosen, request: { status: 'open', planKey: chosen.planKey } };
        };
        const timestamp = Date.now();
        const bot = { characterId: 9150, level: 30, activity: 'hunting', inventory: { 1: { selfId: 1, equipped: true, slot: 7 } }, stats: { classId: 1 } };
        // The step that opens the request moves an input of the choice (the
        // request's status): the next one chooses under the waiting key.
        const opened = step({ ...bot, stats: { ...bot.stats, partyRequest: step(bot, timestamp).request } }, timestamp);
        assert.strictEqual(planned, 2, 'fixture: the plan is chosen without and then with the open request');
        const waiting = { ...bot, stats: { ...bot.stats, partyRequest: opened.request } };
        const later = step(waiting, timestamp + 2 * 60 * 60 * 1000);
        assert.strictEqual(later.chosen.reusablePartyRequest, true);
        assert.strictEqual(planned, 2, 'two hours of waiting on the same inputs: the plan is kept');
        const regeared = { ...waiting, inventory: { 2: { selfId: 2, equipped: true, slot: 7 } } };
        assert.strictEqual(step(regeared, timestamp + 60 * 1000).chosen.reusablePartyRequest, false);
        assert.strictEqual(planned, 3, 'a new kit piece: the plan is chosen again at once');
        const request = Requests.partyRequestForPlan(waiting, plan, timestamp, { economy: { worth: () => 0 }, planKey: later.chosen.planKey });
        assert.strictEqual(request.planKey, later.chosen.planKey, 'the request keeps the choice key');
    } finally {
        Object.assign(GearPlanner, saved);
        Providers.personalCraftPlan = savedCraft;
    }
}

async function run() {
    planKeptWhileWaiting();
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
    let spotSelectionStates = [];
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
    const unsafeSpot = { ...fallbackSpot, id: 'unsafe_target', name: 'Unsafe target' };
    SpotProfiles.findForState = (candidateState) => {
        spotSelectionStates.push({
            spotId: candidateState?.spotId || null,
            hasEquipmentPlan: Boolean(candidateState?.stats?.equipmentPlan)
        });
        return candidateState?.stats?.equipmentPlan ? unsafeSpot : fallbackSpot;
    };
    const requiredPlan = {
        status: 'active',
        partyNeed: 'required',
        requiresParty: true,
        target: { selfId: 88 },
        next: { spotId: 'unsafe_target', npcId: 77, itemId: 88 },
        strategy: 'farm'
    };
    let retiredPlannerCalls = 0;
    GearPlanner.planFor = () => { retiredPlannerCalls++; throw Error('main must defer without the worker plan'); };
    BackgroundResolver.resolveSolo = (options) => {
        resolverOptions = options;
        return {
            patch: { activity: 'hunting', spotId: options.state.spotId, vitals: options.state.vitals || {} },
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
    GoalService.review = () => Promise.resolve({ current: null });
    GoalExecutor.beginMarketTravel = () => null;
    LifeEvents.recordMany = () => Promise.resolve();

    const beforeDeferred = Number(PopulationService.planDeferred || 0);
    const missingWorker = await PopulationService.resolveColdState(state);
    assert.strictEqual(missingWorker.ok, true);
    assert.strictEqual(missingWorker.state.spotId, state.spotId, 'no worker cannot invent an acquisition fallback route');
    assert.strictEqual(missingWorker.state.stats.equipmentPlan, undefined);
    assert.strictEqual(missingWorker.state.stats.partyRequest, undefined);
    assert.strictEqual(PopulationService.planDeferred, beforeDeferred + 1);
    assert.strictEqual(retiredPlannerCalls, 0);
    // A worker plan carries the request the worker built with the bot's
    // economy: main takes it as sent and builds none of its own.
    const workerRequest = { status: 'open', priority: 'required', objectiveKey: 'farm:unsafe_target:77', spotId: 'unsafe_target',
        npcId: 77, itemId: 88, targetId: 88, requestedAt: Date.now(), attempts: 3 };
    const fromWorker = await PopulationService.resolveColdState(state,
        { precomputedPlan: { acquisitionPlan: requiredPlan, partyRequest: workerRequest } });
    assert.strictEqual(fromWorker.ok, true);
    assert.deepStrictEqual(applied.stats.partyRequest, workerRequest, 'main keeps the worker\'s request as sent');
    // Historical already-admitted acquisition metadata, not a fabricated
    // current worker leaf: without a worker plan main keeps the saved request
    // (the worker builds it), and the fallback reader routes on it.
    const historicalRequired = { ...state, stats: { ...state.stats, equipmentPlan: requiredPlan,
        partyRequest: { status: 'open', priority: 'required', objectiveKey: 'farm:unsafe_target:77', spotId: 'unsafe_target',
            npcId: 77, itemId: 88, targetId: 88, requestedAt: Date.now(), attempts: 0 } } };
    const result = await PopulationService.resolveColdState(historicalRequired);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(applied.activity, 'hunting', 'a required party request must keep the bot progressing solo');
    assert.strictEqual(applied.spotId, fallbackSpot.id, 'an unmatched requester must use a safe fallback spot');
    assert.strictEqual(applied.stats.partyRequest.priority, 'required');
    assert.strictEqual(applied.stats.partyWaitUntil, undefined, 'the non-blocking request must not create a wait deadline');
    assert(applied.timing.nextResolveAt > Date.now(), 'the fallback hunt must retain a normal combat deadline');
    assert.strictEqual(resolverOptions.targetNpcId, 0, 'fallback combat must not pretend to farm the unsafe acquisition target');

    resolverOptions = null;
    spotSelectionStates = [];
    const deferredState = {
        ...state,
        characterId: 9103,
        stats: {
            travel: null,
            equipmentPlan: requiredPlan,
            partyRequest: {
                status: 'deferred',
                priority: 'required',
                objectiveKey: 'farm:unsafe_target:77',
                spotId: 'unsafe_target',
                npcId: 77,
                itemId: 88,
                targetId: 88,
                deferredUntil: Date.now() + 60000,
                attempts: 1
            }
        }
    };
    const deferredResult = await PopulationService.resolveColdState(deferredState);
    assert.strictEqual(deferredResult.ok, true);
    assert.strictEqual(resolverOptions.targetNpcId, 0,
        'a deferred party request must keep using safe fallback combat instead of returning to the unsafe target');
    assert.strictEqual(deferredResult.state.spotId, fallbackSpot.id,
        'a deferred party request must not send the bot back to the stale gear spot');
    assert.strictEqual(deferredResult.state.stats.partyRequest.status, 'deferred');
    assert(spotSelectionStates.some((entry) => entry.spotId === null && entry.hasEquipmentPlan === false),
        'deferred fallback selection must evaluate level routing without the stale equipment plan');

    // Replanning belongs to the worker; main continues the historical safe
    // route and cooldown until it receives a new admitted plan.
    const recoveryResult = await PopulationService.resolveColdState({
        ...state,
        characterId: 9105,
        stats: {
            travel: null,
            equipmentPlan: {
                status: 'active',
                grade: 'd',
                plannedForLevel: 30,
                strategy: 'direct_drop',
                partyNeed: 'required',
                requiresParty: true,
                target: { selfId: 88 },
                next: { spotId: 'unsafe_target', npcId: 77, itemId: 88 },
                targetProgress: { npcId: 77, resolves: 0, targetKills: 0 }
            },
            partyRequest: {
                status: 'deferred',
                priority: 'required',
                objectiveKey: 'direct_drop:unsafe_target:77',
                spotId: 'unsafe_target',
                npcId: 77,
                itemId: 88,
                targetId: 88,
                deferredUntil: Date.now() + 60000,
                attempts: 2
            }
        }
    });
    assert.strictEqual(recoveryResult.ok, true);
    assert.strictEqual(recoveryResult.state.stats.partyRequest.status, 'deferred',
        'without a worker replacement main retains the recruitment cooldown');
    assert.strictEqual(recoveryResult.state.stats.equipmentPlan.strategy, 'direct_drop',
        'main must not manufacture the retired planner market replacement');
    assert.strictEqual(resolverOptions.targetNpcId, 0, 'the historical required source still uses its safe fallback');
    assert.strictEqual(retiredPlannerCalls, 0);

    const preferredPlan = {
        status: 'active',
        partyNeed: 'preferred',
        requiresParty: false,
        target: { selfId: 88 },
        next: { spotId: 'preferred_target', npcId: 77, itemId: 88 },
        strategy: 'direct_drop'
    };
    resolverOptions = null;
    const preferredResult = await PopulationService.resolveColdState({ ...state, characterId: 9102,
        stats: { ...state.stats, equipmentPlan: preferredPlan } });
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
    const deferred = invoke('GameServer/Bot/Population/PartyRequestPlanner').partyRequestForPlan(oldRequestState, requestPlan, timestamp, { economy: { worth: () => 0 } });
    assert.strictEqual(deferred.status, 'deferred', 'an unmatched request must leave the open queue after its TTL');
    assert(deferred.deferredUntil > timestamp, 'deferred request must carry a cooldown deadline');
    assert.strictEqual(
        PopulationService.partyObjectiveForState({ stats: { partyRequest: deferred, equipmentPlan: requestPlan } }),
        null,
        'deferred requests must not keep a formation objective alive'
    );
    const duringCooldown = invoke('GameServer/Bot/Population/PartyRequestPlanner').partyRequestForPlan({
        ...oldRequestState,
        stats: { ...oldRequestState.stats, partyRequest: deferred }
    }, requestPlan, timestamp + 1000, { economy: { worth: () => 0 } });
    assert.strictEqual(duringCooldown.status, 'deferred', 'a request must stay deferred during its cooldown');
    const reopened = invoke('GameServer/Bot/Population/PartyRequestPlanner').partyRequestForPlan({
        ...oldRequestState,
        stats: { ...oldRequestState.stats, partyRequest: deferred }
    }, requestPlan, deferred.deferredUntil + 1, { economy: { worth: () => 0 } });
    assert.strictEqual(reopened.status, 'open', 'a deferred request must be eligible for a fresh formation attempt');

    SpotProfiles.findForState = (candidate) => {
        assert.strictEqual(candidate.stats.equipmentPlan.phase, 'leveling');
        return fallbackSpot;
    };
    const deleveled = { ...state, level: 29, exp: 90, stats: {
        equipmentPlan: { status: 'active', strategy: 'direct_drop', grade: 'd',
            plannedForLevel: 30, target: { selfId: 88 },
            next: { spotId: 'unsafe_target', npcId: 77, itemId: 88 },
            partyNeed: 'required', requiresParty: true },
        deathExperience: { expBeforeDeath: 100, expLost: 10, penaltyAppliedAt: timestamp }
    } };
    // Invoke the native public finalizer on the original delevel/death facts.
    // Its actual recovery output is historical admitted metadata here; main
    // does not pretend to have performed the worker's planner build.
    const recoveryPlan = GearPlanner.finalizePlan(deleveled, deleveled.stats.equipmentPlan, {}, {}, timestamp);
    assert.strictEqual(GearPlanner.levelingRecoveryFor(deleveled).reason, 'level_regression');
    const admittedRecovery = { ...deleveled, stats: { ...deleveled.stats, equipmentPlan: recoveryPlan } };
    const recovered = await PopulationService.resolveColdState(admittedRecovery);
    assert.strictEqual(recovered.ok, true);
    assert.strictEqual(recovered.state.stats.equipmentPlan.reason, 'level_regression');
    assert.strictEqual(resolverOptions.targetNpcId, 0,
        'the production solo resolve must stop forcing the acquisition NPC after delevel');
    assert.strictEqual(resolverOptions.spot.id, fallbackSpot.id);
    assert.strictEqual(recovered.state.stats.partyRequest, undefined);
    const nextTick = await PopulationService.resolveColdState(recovered.state);
    assert.strictEqual(nextTick.state.stats.equipmentPlan.phase, 'leveling',
        'a subsequent production resolve must not immediately recreate the failed objective');

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
    GoalService.review = originals.reviewGoal;
    GoalExecutor.beginMarketTravel = originals.beginMarketTravel;
    LifeEvents.recordMany = originals.recordMany;
    fs.rmSync(isolated.directory, { recursive: true, force: true });
});
