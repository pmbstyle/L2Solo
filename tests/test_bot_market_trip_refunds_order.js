const assert = require('assert');

require('../src/Global');

const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const LifeEvents = invoke('GameServer/Bot/Population/BotLifeEvents');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const BackgroundResolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const GoalService = invoke('GameServer/Bot/Goals/GoalService');
const GoalExecutor = invoke('GameServer/Bot/Goals/GoalExecutor');
const BotAfkMarketService = invoke('GameServer/Bot/Economy/BotAfkMarketService');
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const PopulationService = invoke('GameServer/Bot/Population/PopulationService');

// A funded weapon purchase sends a bot straight to the shop after a rest. The
// purchase counts the bot's own WTB escrow as its money, but the shop is paid
// from the wallet: a buy order the goal no longer keeps (an NPC-shop plan
// holds none) must be withdrawn before the trip, as the other market callers
// do, or the bot arrives without the money.
const plan = { status: 'active', strategy: 'market', target: { selfId: 127, name: 'Crimson Sword', slot: 7 },
    market: { town: 'Giran', price: 1_000_000, reserve: 500_000, sourceType: 'npc' } };
const base = {
    characterId: 74, name: 'Buyer', level: 42, adena: 700_000, phase: 'cold', activity: 'hunting',
    currentRegion: 'Krator fields', spotId: 'krator_fields', loc: { locX: 10, locY: 20, locZ: 30 }, inventory: {},
    vitals: { hp: 1000, maxHp: 1000, mp: 600, maxMp: 600 }, timing: { lastResolvedAt: Date.now() - 30000 },
    stats: { equipmentPlan: plan }
};
const goal = { type: 'upgrade_gear', status: 'active', target: { itemId: 127 },
    plan: { expectedBenefit: 'market_search_for_weapon', marketTown: 'Giran', sourceType: 'npc' } };
const refunded = { ...base, adena: 1_500_000 };

const saved = {
    findOwnerProjection: AfkTrade.findOwnerProjection, review: GoalService.review, reconcile: BotAfkMarketService.reconcile,
    beginMarketTravel: GoalExecutor.beginMarketTravel, cachedState: LifeState.cachedState, applyResolve: LifeState.applyResolve,
    upsertState: LifeState.upsertState, recordMany: LifeEvents.recordMany, resolveSolo: BackgroundResolver.resolveSolo,
    ensure: SpotProfiles.ensure, findForState: SpotProfiles.findForState
};

(async () => {
    try {
        // 800,000 of the money is in the bot's WTB: funded only with the escrow.
        AfkTrade.findOwnerProjection = () => ({ shop: { storeType: AfkTrade.BUY, escrowAdena: 800_000 } });
        assert.strictEqual(PopulationService.canResumeAffordableMarketPlan(base), true, 'fixture: funded with the escrow');
        const calls = [];
        GoalService.review = () => Promise.resolve({ current: goal, candidates: [] });
        BotAfkMarketService.reconcile = (state, current) => {
            calls.push('reconcile');
            assert.strictEqual(current, goal);
            return Promise.resolve({ changed: true, withdrawn: true, state: refunded });
        };
        GoalExecutor.beginMarketTravel = (state) => { calls.push('travel'); return { ...state, activity: 'traveling' }; };
        LifeState.upsertState = (value) => Promise.resolve(value);
        LifeEvents.recordMany = () => Promise.resolve(null);
        SpotProfiles.ensure = () => [];
        SpotProfiles.findForState = () => null;

        // 1. The worker's lifecycle command before another fight.
        LifeState.cachedState = () => base;
        const command = await PopulationService.executeWorkerLifecycleCommand(base,
            { precomputedResult: { patch: {}, events: [], materialize: { exp: 0, sp: 0, adena: 0, items: [] } } });
        assert.deepStrictEqual(calls, ['reconcile'], 'the order is withdrawn before any trip');
        assert.strictEqual(command.state, refunded, 'the bot keeps the refunded state; the trip starts next time');

        // 2. The handoff right after a rest.
        calls.length = 0;
        LifeState.cachedState = () => null;
        BackgroundResolver.resolveSolo = () => ({ patch: { activity: 'hunting' }, events: [],
            materialize: { exp: 0, sp: 0, adena: 0, items: [] }, nextResolveAt: Date.now() + 30000, debug: { activity: 'recovered' } });
        LifeState.applyResolve = () => Promise.resolve(base);
        const rested = await PopulationService.resolveColdState({ ...base, activity: 'resting',
            stats: { ...base.stats, restUntil: Date.now() - 1 } });
        assert.deepStrictEqual(calls, ['reconcile'], 'after a rest the order is withdrawn before any trip');
        assert.strictEqual(rested.state, refunded);

        // Nothing to withdraw: the trip starts at once, as before.
        calls.length = 0;
        BotAfkMarketService.reconcile = () => { calls.push('reconcile'); return Promise.resolve({ changed: false, state: base }); };
        const trip = await PopulationService.resolveColdState({ ...base, activity: 'resting',
            stats: { ...base.stats, restUntil: Date.now() - 1 } });
        assert.deepStrictEqual(calls, ['reconcile', 'travel']);
        assert.strictEqual(trip.state.activity, 'traveling');
    } finally {
        Object.assign(AfkTrade, { findOwnerProjection: saved.findOwnerProjection });
        Object.assign(GoalService, { review: saved.review });
        Object.assign(BotAfkMarketService, { reconcile: saved.reconcile });
        Object.assign(GoalExecutor, { beginMarketTravel: saved.beginMarketTravel });
        Object.assign(LifeState, { cachedState: saved.cachedState, applyResolve: saved.applyResolve, upsertState: saved.upsertState });
        Object.assign(LifeEvents, { recordMany: saved.recordMany });
        Object.assign(BackgroundResolver, { resolveSolo: saved.resolveSolo });
        Object.assign(SpotProfiles, { ensure: saved.ensure, findForState: saved.findForState });
    }
    console.log('Bot market trip refunds order checks passed');
    process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
