const assert = require('assert');

require('../src/Global');

const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const BackgroundResolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const ListingService = invoke('GameServer/Bot/Economy/ColdMarketListingService');
const MarketService = invoke('GameServer/Bot/Economy/ColdMarketService');
const TradeChat = invoke('GameServer/Bot/Economy/ColdMarketTradeChat');
const GoalService = invoke('GameServer/Bot/Goals/GoalService');
const GoalExecutor = invoke('GameServer/Bot/Goals/GoalExecutor');
const LifeEvents = invoke('GameServer/Bot/Population/BotLifeEvents');
const GlobalChat = invoke('GameServer/Bot/Population/BotGlobalChat');
const PopulationService = invoke('GameServer/Bot/Population/PopulationService');

const originals = {
    findForState: SpotProfiles.findForState,
    resolveSolo: BackgroundResolver.resolveSolo,
    applyResolve: LifeState.applyResolve,
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
    const state = {
        characterId: 71,
        name: 'TravelingSeller',
        phase: 'cold',
        activity: 'traveling',
        timing: { lastResolvedAt: Date.now() - 30000 },
        stats: { travel: { to: { locX: 1, locY: 1, locZ: 1 }, startedAt: Date.now() - 30000, arrivalAt: Date.now() + 30000 } }
    };
    let receivedSpot = 'unset';

    SpotProfiles.findForState = () => null;
    BackgroundResolver.resolveSolo = ({ spot }) => {
        receivedSpot = spot;
        return { patch: { activity: 'traveling' }, events: [], materialize: { exp: 0, sp: 0, adena: 0, items: [] }, nextResolveAt: Date.now() + 30000, debug: { activity: 'traveling' } };
    };
    LifeState.applyResolve = () => Promise.resolve(state);
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
    console.log('Bot cold travel without spot checks passed');
}

run().catch((err) => { console.error(err); process.exitCode = 1; }).finally(() => {
    SpotProfiles.findForState = originals.findForState;
    BackgroundResolver.resolveSolo = originals.resolveSolo;
    LifeState.applyResolve = originals.applyResolve;
    ListingService.resolve = originals.resolveListing;
    MarketService.tryPurchase = originals.tryPurchase;
    GoalService.current = originals.current;
    GoalService.review = originals.review;
    GoalExecutor.finishMarketVisit = originals.finishMarketVisit;
    TradeChat.maybeAnnounce = originals.announce;
    LifeEvents.recordMany = originals.recordMany;
    GlobalChat.maybeAnnounce = originals.globalAnnounce;
});
