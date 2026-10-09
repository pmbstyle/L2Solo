'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
invoke('GameServer/DataCache').init();

const GoalService = invoke('GameServer/Bot/Goals/GoalService');
const GoalState = invoke('GameServer/Bot/Goals/GoalState');
const NeedsEvaluator = invoke('GameServer/Bot/Goals/NeedsEvaluator');
const GoalExecutor = invoke('GameServer/Bot/Goals/GoalExecutor');
const ColdMarketService = invoke('GameServer/Bot/Economy/ColdMarketService');
const AfkMarket = invoke('GameServer/Bot/Economy/BotAfkMarketService');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const PopulationService = invoke('GameServer/Bot/Population/PopulationService');
const restore = [];
function stub(target, name, value) {
    const old = target[name]; restore.push(() => { target[name] = old; }); target[name] = value;
}

(async () => {
    const now = Date.now();
    const state = { characterId: 61, name: 'Buyer', phase: 'cold', activity: 'hunting', adena: 1000,
        loc: { locX: 1, locY: 2, locZ: 3 }, stats: {} };
    const economy = { network: { activity: null } };
    const goal = { type: 'buy_craft_material', status: 'active', nextReviewAt: now + 60000,
        target: { itemId: 1869, amount: 2 }, plan: { expectedBenefit: 'market_buy_craft_material', marketTown: 'Giran' } };

    // The review hands back the economy it read for this state.
    const held = { type: 'progress_level', status: 'active', nextReviewAt: now + 60000, target: { level: 21 }, plan: {} };
    stub(GoalState, 'snapshot', () => ({ characterId: 61, current: held, inputHash: 7 }));
    stub(NeedsEvaluator, 'evaluate', (_, options) => { options.onEconomy(economy); return [{ inputHash: 7 }]; });
    const reviewed = await GoalService.review(state, { now });
    assert.equal(reviewed.economy, economy, 'review returns the economy it evaluated');
    const [batched] = await GoalService.reviewBatch([state], { now });
    assert.equal(batched.economy, economy, 'batch review returns the economy too');

    // The market trip passes that economy to the purchase check.
    const seen = [];
    stub(AfkMarket, 'canTradeRemotely', () => false);
    stub(ColdMarketService, 'canTravelForPurchase', (_, request, options) => { seen.push(options); return false; });
    assert.equal(GoalExecutor.beginMarketTravel(state, goal, now, { economy }), null);
    assert.equal(seen[0].economy, economy, 'canTravelForPurchase receives the caller economy');
    GoalExecutor.beginMarketTravel(state, goal, now);
    assert.equal(Object.hasOwn(seen[1], 'economy'), false, 'without an economy the service builds its own');

    // The market goal reconcile plumbs the review economy into the trip.
    const travelled = [];
    stub(LifeState, 'marketGoalCandidates', () => Promise.resolve([state]));
    stub(LifeState, 'cachedState', () => state);
    stub(LifeState, 'upsertState', saved => Promise.resolve(saved));
    stub(SpotProfiles, 'findForState', () => null);
    stub(AfkMarket, 'reconcile', async current => ({ state: current, changed: false }));
    stub(GoalService, 'reviewBatch', async () => [{ current: goal, economy }]);
    stub(GoalExecutor, 'beginMarketTravel', (current, wanted, timestamp, options) => { travelled.push(options); return null; });
    await PopulationService.reconcileMarketGoals();
    assert.equal(travelled[0]?.economy, economy, 'reconcile passes the reviewed economy to the trip');
    console.log('PASS goal review economy reaches the market trip purchase check');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
    for (const undo of restore.reverse()) undo();
});
