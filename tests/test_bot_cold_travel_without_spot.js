const assert = require('assert');

require('../src/Global');

const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const BackgroundResolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const GearPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const ColdCraftingService = invoke('GameServer/Bot/Economy/ColdCraftingService');
const ListingService = invoke('GameServer/Bot/Economy/ColdMarketListingService');
const MarketService = invoke('GameServer/Bot/Economy/ColdMarketService');
const TradeChat = invoke('GameServer/Bot/Economy/ColdMarketTradeChat');
const GoalService = invoke('GameServer/Bot/Goals/GoalService');
const GoalExecutor = invoke('GameServer/Bot/Goals/GoalExecutor');
const LifeEvents = invoke('GameServer/Bot/Population/BotLifeEvents');
const GlobalChat = invoke('GameServer/Bot/Population/BotGlobalChat');
const PopulationService = invoke('GameServer/Bot/Population/PopulationService');

const originals = {
    ensure: SpotProfiles.ensure,
    findForState: SpotProfiles.findForState,
    resolveSolo: BackgroundResolver.resolveSolo,
    planFor: GearPlanner.planFor,
    beginCraftTravel: ColdCraftingService.beginTravel,
    cachedState: LifeState.cachedState,
    applyResolve: LifeState.applyResolve,
    refreshInventory: LifeState.refreshInventory,
    upsertState: LifeState.upsertState,
    resolveListing: ListingService.resolve,
    tryPurchase: MarketService.tryPurchase,
    current: GoalService.current,
    review: GoalService.review,
    finishMarketVisit: GoalExecutor.finishMarketVisit,
    announce: TradeChat.maybeAnnounce,
    recordMany: LifeEvents.recordMany,
    globalAnnounce: GlobalChat.maybeAnnounce
};

async function run() {
    const recoveredShopping = BackgroundResolver.resolveSolo({
        state: { characterId: 72, name: 'LegacyShopper', activity: 'shopping', currentRegion: 'Wandering', homeRegion: 'Wandering', stats: {} },
        spot: { id: 'starter_local', center: { locX: 10, locY: 20, locZ: 30 } }
    });
    assert.strictEqual(recoveredShopping.patch.activity, 'hunting');
    assert.deepStrictEqual(recoveredShopping.patch.loc, { locX: 10, locY: 20, locZ: 30 });

    const state = {
        characterId: 71,
        name: 'TravelingSeller',
        phase: 'cold',
        activity: 'traveling',
        timing: { lastResolvedAt: Date.now() - 30000 },
        stats: { travel: { to: { locX: 1, locY: 1, locZ: 1 }, startedAt: Date.now() - 30000, arrivalAt: Date.now() + 30000 } }
    };
    let receivedSpot = 'unset';
    let planningAtlasRequests = 0;

    SpotProfiles.ensure = () => {
        planningAtlasRequests += 1;
        return [];
    };
    SpotProfiles.findForState = () => null;
    BackgroundResolver.resolveSolo = ({ spot }) => {
        receivedSpot = spot;
        return { patch: { activity: 'traveling' }, events: [], materialize: { exp: 0, sp: 0, adena: 0, items: [] }, nextResolveAt: Date.now() + 30000, debug: { activity: 'traveling' } };
    };
    LifeState.cachedState = () => null;
    LifeState.applyResolve = () => Promise.resolve(state);
    LifeState.refreshInventory = (value) => Promise.resolve(value);
    LifeState.upsertState = (value) => Promise.resolve(value);
    ListingService.resolve = (value) => Promise.resolve({ state: value, closed: false });
    GoalService.current = () => Promise.resolve(null);
    MarketService.tryPurchase = (value) => Promise.resolve({ state: value, purchased: false });
    GoalExecutor.finishMarketVisit = () => null;
    TradeChat.maybeAnnounce = (value) => Promise.resolve({ state: value });
    GoalService.review = () => Promise.resolve(null);
    LifeEvents.recordMany = () => Promise.resolve(null);
    GlobalChat.maybeAnnounce = () => null;

    const result = await PopulationService.resolveColdState(state);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(receivedSpot, null, 'travel must resolve without a hunting spot');
    assert.strictEqual(planningAtlasRequests, 0, 'in-flight travel must not build an equipment plan or load the spot atlas');

    const readyToTravel = {
        ...state,
        characterId: 73,
        name: 'FreshCraftTraveler',
        activity: 'hunting',
        loc: { locX: 10, locY: 20, locZ: 30 },
        stats: { equipmentPlan: { status: 'ready_to_craft', strategy: 'craft', recipeId: 189 } }
    };
    GearPlanner.planFor = () => readyToTravel.stats.equipmentPlan;
    ColdCraftingService.beginTravel = (value) => ({
        ...value,
        activity: 'traveling',
        stats: {
            ...(value.stats || {}),
            travel: {
                from: value.loc,
                to: { locX: 100, locY: 200, locZ: 300 },
                startedAt: Date.now(),
                arrivalAt: Date.now() + 25000,
                arrivalActivity: 'crafting',
                reason: 'equipment_craft'
            }
        }
    });
    BackgroundResolver.resolveSolo = ({ state: value, spot }) => {
        receivedSpot = spot;
        assert.strictEqual(value.activity, 'traveling', 'a ready craft route must enter travel before resolving');
        return { patch: { activity: 'traveling', stats: value.stats }, events: [], materialize: { exp: 0, sp: 0, adena: 0, items: [] }, nextResolveAt: Date.now() + 25000, debug: { activity: 'traveling' } };
    };
    LifeState.applyResolve = () => Promise.resolve(readyToTravel);
    const freshTravelResult = await PopulationService.resolveColdState(readyToTravel);
    assert.strictEqual(freshTravelResult.ok, true, 'travel started during a cold resolve must not fail as a missing hunting spot');
    assert.strictEqual(receivedSpot, null, 'newly-started travel must resolve without a combat spot');

    let joinedDuringResolve = false;
    let applyCalled = false;
    BackgroundResolver.resolveSolo = () => {
        joinedDuringResolve = true;
        return { patch: { activity: 'traveling' }, events: [], materialize: { exp: 0, sp: 0, adena: 0, items: [] }, nextResolveAt: Date.now() + 30000, debug: { activity: 'traveling' } };
    };
    LifeState.cachedState = () => (joinedDuringResolve ? { ...state, party: { partyId: 'fresh_party' } } : null);
    LifeState.applyResolve = () => {
        applyCalled = true;
        return Promise.resolve(state);
    };
    const joinedResult = await PopulationService.resolveColdState(state);
    assert.strictEqual(joinedResult.reason, 'joined_party', 'a stale solo resolve must stop when the bot joins a party');
    assert.strictEqual(applyCalled, false, 'a stale solo resolve must not overwrite the new party state');
    console.log('Bot cold travel without spot checks passed');
}

run().catch((err) => { console.error(err); process.exitCode = 1; }).finally(() => {
    SpotProfiles.ensure = originals.ensure;
    SpotProfiles.findForState = originals.findForState;
    BackgroundResolver.resolveSolo = originals.resolveSolo;
    GearPlanner.planFor = originals.planFor;
    ColdCraftingService.beginTravel = originals.beginCraftTravel;
    LifeState.cachedState = originals.cachedState;
    LifeState.applyResolve = originals.applyResolve;
    LifeState.refreshInventory = originals.refreshInventory;
    LifeState.upsertState = originals.upsertState;
    ListingService.resolve = originals.resolveListing;
    MarketService.tryPurchase = originals.tryPurchase;
    GoalService.current = originals.current;
    GoalService.review = originals.review;
    GoalExecutor.finishMarketVisit = originals.finishMarketVisit;
    TradeChat.maybeAnnounce = originals.announce;
    LifeEvents.recordMany = originals.recordMany;
    GlobalChat.maybeAnnounce = originals.globalAnnounce;
});
