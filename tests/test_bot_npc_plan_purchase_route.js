const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const NeedsEvaluator = invoke('GameServer/Bot/Goals/NeedsEvaluator');
const BotAfkMarket = invoke('GameServer/Bot/Economy/BotAfkMarketService');
const GoalExecutor = invoke('GameServer/Bot/Goals/GoalExecutor');

DataCache.init();

// NG/D gear comes from the bot's NPC-shop plan (NeedsEvaluator). The plan
// quotes the NPC price, so the goal carries priceSource 'offer'; the NPC guard
// must still send the bot to the NPC instead of posting a WTB at 85% of it.
const base = {
    characterId: 7, name: 'NpcBuyer', accountName: 'bot_7', phase: 'cold', activity: 'hunting',
    level: 30, adena: 300000, inventory: {}, loc: { locX: 83000, locY: 148000, locZ: -3400 },
    vitals: { hp: 2000, maxHp: 2000, mp: 1000, maxMp: 1000 },
    stats: { generatedCold: true, classId: 1, role: 'dps', build: { grade: 'd', classId: 1, level: 30 }, equipment: [] }
};
const plan = GearAcquisitionPlanner.staticNpcUpgradePlan(base);
assert.strictEqual(plan?.market?.sourceType, 'npc', 'the fixture must plan an NPC purchase');
const state = { ...base, stats: { ...base.stats, equipmentPlan: plan } };
const goal = NeedsEvaluator.evaluate(state).find((candidate) => candidate.type === 'upgrade_gear');
assert.strictEqual(Number(goal?.target?.itemId), Number(plan.target.selfId));
assert.strictEqual(goal.plan.priceSource, 'offer');
assert.strictEqual(goal.plan.sourceType, 'npc', 'the goal keeps the plan\'s offer source');
assert(goal.plan.expectedBenefit.startsWith('market_search_for_'), 'the fixture goal must be funded');

const activeGoal = { ...goal, status: 'active' };
assert.strictEqual(BotAfkMarket.canTradeRemotely(state, activeGoal), false,
    'an NPC-shop plan is not bought through a remote WTB');
// Also when another bot lists the item cheaper than the NPC: the bot still
// goes to the shop town (and buys that listing there if it is cheaper).
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const bestOffer = MarketOpportunity.bestOffer;
try {
    MarketOpportunity.bestOffer = () => ({ sourceType: 'afk_bot_store', price: Math.floor(plan.market.price * 0.95),
        town: plan.market.town, available: true });
    assert.strictEqual(BotAfkMarket.canTradeRemotely(state, activeGoal), false,
        'a cheaper bot listing does not turn an NPC-shop plan into a WTB');
} finally {
    MarketOpportunity.bestOffer = bestOffer;
}
const travel = GoalExecutor.beginMarketTravel(state, activeGoal, Date.now());
assert.strictEqual(travel?.activity, 'traveling', 'the bot travels to the NPC instead');
assert.strictEqual(travel.stats.travel.townName, plan.market.town, 'to the town of the planned NPC');

(async () => {
    const original = {
        ownerRecords: AfkTrade.ownerRecords,
        closeBotRecord: AfkTrade.closeBotRecord,
        snapshot: LifeState.snapshot
    };
    try {
        // An order posted before this rule is withdrawn (its escrow comes
        // back) so the trip can pay the NPC.
        const stops = [];
        const lines = [{ id: 1, selfId: Number(plan.target.selfId), count: 1, price: Math.floor(plan.market.price * 0.85) }];
        AfkTrade.ownerRecords = () => [{ id: 11, ownerId: 7, kind: 'buy_ad', storeType: AfkTrade.BUY,
            escrowAdena: lines[0].price, revision: 1, lines }];
        AfkTrade.closeBotRecord = (ownerId) => { stops.push(ownerId); return Promise.resolve({ closed: true }); };
        LifeState.snapshot = () => state;
        const result = await BotAfkMarket.reconcile(state, activeGoal);
        assert.deepStrictEqual(stops, [7], 'the WTB for an NPC-shop plan is withdrawn');
        assert.strictEqual(result.withdrawn, true);
    } finally {
        AfkTrade.ownerRecords = original.ownerRecords;
        AfkTrade.closeBotRecord = original.closeBotRecord;
        LifeState.snapshot = original.snapshot;
        BotAfkMarket._resetForTests?.();
    }
    console.log('Bot NPC plan purchase route checks passed');
    process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
