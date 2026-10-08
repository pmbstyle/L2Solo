const assert = require('assert');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('fx-market-case');
const fs = require('node:fs');
require('../src/Global');
fixture.assertConfigured(options.default);
process.on('exit', () => fs.rmSync(fixture.directory, { recursive: true, force: true }));
const NativeChoice = require('./helpers/nativeMarketChoice');

(async () => {
const DataCache = invoke('GameServer/DataCache');
const Database = invoke('Database');
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const BotAfkMarket = invoke('GameServer/Bot/Economy/BotAfkMarketService');
const GoalExecutor = invoke('GameServer/Bot/Goals/GoalExecutor');
const Funding = invoke('GameServer/Bot/Economy/PurchaseFunding');
const { character, amount } = require('./helpers/nativeMarketFixture');
DataCache.init();
try {
const base = {
    characterId: 7, name: 'NpcBuyer', accountName: 'bot_7', phase: 'cold', activity: 'hunting',
    level: 30, adena: 300000, inventory: {}, loc: { locX: 83000, locY: 148000, locZ: -3400 },
    vitals: { hp: 2000, maxHp: 2000, mp: 1000, maxMp: 1000 },
    stats: { generatedCold: true, classId: 1, role: 'dps', build: { grade: 'd', classId: 1, level: 30 }, equipment: [] }
};
const plan = GearAcquisitionPlanner.staticNpcUpgradePlan(base);
assert.strictEqual(plan?.market?.sourceType, 'npc', 'the fixture must plan an NPC purchase');
const state = { ...base, stats: { ...base.stats, equipmentPlan: plan } };

// ARCH-NOTE: FX-C1 defers without a capture; an old NPC acquisition plan
// cannot choose the wish. This unchanged wallet/class/plan has a native deficit.
const native = await NativeChoice.capture(state, {}, 'npc_original_300k');
assert.strictEqual(native.read.activity.activity, 'hunting');
assert.strictEqual(native.goals.length, 1);
assert.strictEqual(native.goals[0].priority, 50);
assert.strictEqual(native.goals.find(row => row.type === 'upgrade_gear'), undefined);
assert.strictEqual(Funding.spendable(native.state, 0, { itemId: plan.target.selfId }), 0,
    'the authored NPC plan does not bypass the real money packet');
// Separate execution seam: these are the authored plan's route inputs,
// not a claimed native selected shopping leaf or an approved purchase.
const goal = { type: 'upgrade_gear', priority: 50, status: 'active',
    target: { itemId: Number(plan.target.selfId), amount: 1, adena: plan.market.price },
    plan: { kind: 'market_buy', priceSource: 'offer', sourceType: 'npc', marketTown: plan.market.town,
        estimatedCost: plan.market.price, expectedBenefit: 'market_search_for_gear' } };
assert.strictEqual(Number(goal.target.itemId), Number(plan.target.selfId));
assert.strictEqual(goal.plan.priceSource, 'offer');
assert.strictEqual(goal.plan.sourceType, 'npc');
assert(goal.plan.expectedBenefit.startsWith('market_search_for_'));
const activeGoal = { ...goal, status: 'active' };
assert.strictEqual(BotAfkMarket.canTradeRemotely(state, activeGoal), false,
    'an NPC-shop plan is not bought through a remote WTB');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const bestOffer = MarketOpportunity.bestOffer;
try {
    MarketOpportunity.bestOffer = () => ({ sourceType: 'afk_bot_store', price: Math.floor(plan.market.price * 0.95),
        town: plan.market.town, available: true });
    assert.strictEqual(BotAfkMarket.canTradeRemotely(state, activeGoal), false,
        'a cheaper bot listing does not turn an NPC-shop plan into a WTB');
} finally { MarketOpportunity.bestOffer = bestOffer; }
const travel = GoalExecutor.beginMarketTravel(state, activeGoal, Date.now());
assert.strictEqual(travel, null, 'an authored NPC route without a currently funded useful purchase cannot start a new trip');

Database.init();
await character(Database, 7, 'NpcBuyer', 'bot_7', base.loc);
await Database.setItem(7, { selfId: 57, name: 'Adena', amount: 300000, enchant: 0, equipped: false, slot: 0 });
await LifeState.init();
await AfkTrade.init();
const inventory = LifeState.inventorySummaryFromItems(await Database.fetchItems(7));
await LifeState.upsertState({ ...state, inventory, stats: { ...state.stats, money: [300000, 0, 0, 0] }, timing: {} }, 'fixture_npc_route');
const price = Math.floor(plan.market.price * 0.85);
const posted = await AfkTrade.publishBot(7, { kind: 'buy_ad', storeType: AfkTrade.BUY,
    title: 'WTB NPC target', town: plan.market.town, locX: 0, locY: 0, locZ: 0,
    lines: [{ selfId: Number(plan.target.selfId), name: plan.target.name, count: 1, price, enchant: 0 }] });
assert.strictEqual(Number(posted.escrowAdena), 0);
assert.strictEqual(amount(await Database.fetchItems(7), 57), 300000);
assert.strictEqual(BotAfkMarket.buyOrderEscrow(7), 0);
const result = await BotAfkMarket.reconcile(LifeState.snapshot(7), activeGoal);
assert.strictEqual(result.withdrawn, true, 'the conditional WTB is removed before the NPC trip');
assert.strictEqual(AfkTrade.ownerRecords(7).length, 0);
assert.strictEqual(BotAfkMarket.buyOrderEscrow(7), 0);
assert.strictEqual(amount(await Database.fetchItems(7), 57), 300000, 'an unaccepted WTB never moves the original wallet');
assert.strictEqual(amount(await Database.fetchItems(7), plan.target.selfId), 0, 'withdrawal is not an NPC purchase');
assert.strictEqual(LifeState.snapshot(7).adena, 300000);
console.log(JSON.stringify({ sourcePlanTarget: plan.target.selfId, npcTown: plan.market.town,
    escrow: 0, walletAfterRemoval: amount(await Database.fetchItems(7), 57), purchased: 0 }));
console.log('Bot NPC plan purchase route checks passed');
} finally {
    await AfkTrade._resetForTests();
    BotAfkMarket._resetForTests?.();
    await Database.close();
}
})().catch(error => { console.error(error); process.exitCode = 1; });
