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
        let reconcileResult = () => Promise.resolve({ changed: true, withdrawn: true, state: refunded });
        BotAfkMarketService.reconcile = (state, current) => {
            calls.push('reconcile');
            assert.strictEqual(current, goal);
            return reconcileResult();
        };
        GoalExecutor.beginMarketTravel = (state) => { calls.push(`travel:${state.adena}`); return { ...state, activity: 'traveling' }; };
        LifeState.upsertState = (value) => Promise.resolve(value);
        LifeEvents.recordMany = () => Promise.resolve(null);
        SpotProfiles.ensure = () => [];
        SpotProfiles.findForState = () => null;
        const fallback = PopulationService.resolveColdState;
        const command = () => PopulationService.executeWorkerLifecycleCommand(base,
            { precomputedResult: { patch: {}, events: [], materialize: { exp: 0, sp: 0, adena: 0, items: [] } } });

        // 1. The worker's lifecycle command before another fight: the order is
        // withdrawn and the trip starts from the refunded wallet in one pass.
        LifeState.cachedState = () => base;
        let result = await command();
        assert.deepStrictEqual(calls, ['travel:700000', 'reconcile', 'travel:1500000'], 'withdraw, then leave with the money');
        assert.strictEqual(result.state.activity, 'traveling');
        assert.strictEqual(result.state.adena, 1500000);

        // The order cannot be withdrawn (an error, or the goal keeps it): no trip.
        PopulationService.resolveColdState = () => Promise.resolve({ ok: true, reason: 'resolved' });
        for (const failure of [() => Promise.reject(new Error('db')), () => Promise.resolve({ changed: false, state: base })]) {
            calls.length = 0;
            reconcileResult = failure;
            result = await command();
            assert.deepStrictEqual(calls, ['travel:700000', 'reconcile'], 'no trip while the money stays in the order');
            assert.strictEqual(result.reason, 'resolved', 'the bot goes on with its fight');
        }
        PopulationService.resolveColdState = fallback;

        // 2. The handoff right after a rest.
        calls.length = 0;
        reconcileResult = () => Promise.resolve({ changed: true, withdrawn: true, state: refunded });
        LifeState.cachedState = () => null;
        BackgroundResolver.resolveSolo = () => ({ patch: { activity: 'hunting' }, events: [],
            materialize: { exp: 0, sp: 0, adena: 0, items: [] }, nextResolveAt: Date.now() + 30000, debug: { activity: 'recovered' } });
        LifeState.applyResolve = () => Promise.resolve(base);
        const rested = await PopulationService.resolveColdState({ ...base, activity: 'resting',
            stats: { ...base.stats, restUntil: Date.now() - 1 } });
        assert.deepStrictEqual(calls, ['travel:700000', 'reconcile', 'travel:1500000'], 'after a rest too');
        assert.strictEqual(rested.state.activity, 'traveling');

        // No money in an order: the trip starts at once, nothing to withdraw.
        calls.length = 0;
        AfkTrade.findOwnerProjection = () => null;
        const rich = { ...base, adena: 2_000_000 };
        LifeState.applyResolve = () => Promise.resolve(rich);
        const trip = await PopulationService.resolveColdState({ ...rich, activity: 'resting',
            stats: { ...rich.stats, restUntil: Date.now() - 1 } });
        assert.deepStrictEqual(calls, ['travel:2000000']);
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
