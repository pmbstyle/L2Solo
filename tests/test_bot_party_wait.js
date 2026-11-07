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
    findById: SpotProfiles.findById,
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

    // In game every lifecycle command carries the worker's round and route
    // (executeWorkerLifecycleCommand refuses one without): main hunts the
    // worker's spot and chooses none (situations.md §8). The worker's safe
    // fallback for a waiting requester is pinned in test_party_wait_fallback,
    // its delevel recovery in test_bot_leveling_recovery.
    SpotProfiles.findById = id => ({ ...fallbackSpot, id, name: String(id) });
    const worker = (current, extra = {}) => ({ ...extra, route: { needed: false, spotId: current.spotId },
        precomputedResult: BackgroundResolver.resolveSolo({ state: current, targetNpcId: 0 }) });
    const beforeDeferred = Number(PopulationService.planDeferred || 0);
    const missingWorker = await PopulationService.resolveColdState(state, worker(state));
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
        worker(state, { precomputedPlan: { acquisitionPlan: requiredPlan, partyRequest: workerRequest } }));
    assert.strictEqual(fromWorker.ok, true);
    assert.deepStrictEqual(applied.stats.partyRequest, workerRequest, 'main keeps the worker\'s request as sent');
    assert.strictEqual(applied.spotId, state.spotId, 'main hunts the worker\'s spot, it chooses none');
    assert.equal(spotSelectionStates.length, 0, 'main searches no spot');

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
                requestedAt: timestamp - 60 * 60 * 1000,
                attempts: 2
            }
        }
    };
    // A party request is held with no clock: an hour unanswered it stays open
    // (C4 has no LFG timeout), and its next build keeps it.
    const Planner = invoke('GameServer/Bot/Population/PartyRequestPlanner');
    const held = Planner.partyRequestForPlan(oldRequestState, requestPlan, timestamp, { economy: { worth: () => 0 } });
    assert.strictEqual(held.status, 'open', 'an unanswered request stays open: no age closes it');
    assert.strictEqual(held.requestedAt, oldRequestState.stats.partyRequest.requestedAt, 'its ask time is kept');
    // Forming's no closes it: forming skips it until the bot's next build asks again.
    const closed = { ...held, status: 'closed', lastReason: 'no_compatible_level_match' };
    assert.strictEqual(
        PopulationService.partyObjectiveForState({ stats: { partyRequest: closed, equipmentPlan: requestPlan } }),
        null,
        'a closed request keeps no formation objective alive'
    );
    const reopened = Planner.partyRequestForPlan({
        ...oldRequestState,
        stats: { ...oldRequestState.stats, partyRequest: closed }
    }, requestPlan, timestamp + 1000, { economy: { worth: () => 0 } });
    assert.strictEqual(reopened.status, 'open', 'the next build asks again');
    assert.strictEqual(reopened.attempts, 2, 'a reopened request keeps its attempts');
    assert.strictEqual(reopened.requestedAt, timestamp + 1000, 'a reopened request asks anew');

    console.log('Bot party request fallback checks passed');
}

run().catch((err) => {
    console.error(err);
    process.exitCode = 1;
}).finally(() => {
    SpotProfiles.ensure = originals.ensure;
    SpotProfiles.findForState = originals.findForState;
    SpotProfiles.findById = originals.findById;
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
