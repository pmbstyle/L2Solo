const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const NeedsEvaluator = invoke('GameServer/Bot/Goals/NeedsEvaluator');
const PopulationService = invoke('GameServer/Bot/Population/PopulationService');
const BuyStoreService = invoke('GameServer/Bot/Economy/ColdMarketBuyStoreService');
const { lifecycleKind } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');

DataCache.init();

// "Can the bot pay for this purchase" is asked in several places. Each one is
// pinned here on the same fixture: a level 30 bot and its NPC kit plan
// (price P, operating reserve R), at a wallet of exactly P + R and one less.
const base = {
    characterId: 7, name: 'Funding', accountName: 'bot_7', phase: 'cold', activity: 'hunting',
    level: 30, inventory: {}, loc: { locX: 83000, locY: 148000, locZ: -3400 },
    vitals: { hp: 2000, maxHp: 2000, mp: 1000, maxMp: 1000 },
    stats: { generatedCold: true, classId: 1, role: 'dps', build: { grade: 'd', classId: 1, level: 30 }, equipment: [] }
};
const plan = GearAcquisitionPlanner.staticNpcUpgradePlan({ ...base, adena: 300000 });
assert.strictEqual(plan?.market?.sourceType, 'npc', 'the fixture must plan an NPC purchase');
const price = Number(plan.market.price);
const reserve = Number(plan.market.reserve);
assert(price > 0 && reserve > 0);
const withPlan = (adena, equipmentPlan = plan) => ({ ...base, adena, stats: { ...base.stats, equipmentPlan } });

// 1. NeedsEvaluator: the gear goal is funded when the wallet covers P + R.
const gearGoal = (state) => NeedsEvaluator.evaluate(state).find((candidate) => candidate.type === 'upgrade_gear');
assert.strictEqual(gearGoal(withPlan(price + reserve)).plan.requiredAdena, 0, 'needs: P + R is funded');
assert.strictEqual(gearGoal(withPlan(price + reserve - 1)).plan.requiredAdena, 1, 'needs: one short');

// 2. PopulationService: a weapon market plan resumes after a rest only when funded.
const weaponPlan = { ...plan, target: { ...plan.target, slot: 7 } };
assert.strictEqual(PopulationService.canResumeAffordableMarketPlan(withPlan(price + reserve, weaponPlan)), true,
    'resume: P + R is funded');
assert.strictEqual(PopulationService.canResumeAffordableMarketPlan(withPlan(price + reserve - 1, weaponPlan)), false,
    'resume: one short');

// 3. Kernel: a hunting bot with a funded market plan is a command (town) bot.
assert.strictEqual(lifecycleKind(withPlan(price + reserve)), 'command', 'kernel: P + R is funded');
assert.notStrictEqual(lifecycleKind(withPlan(price + reserve - 1)), 'command', 'kernel: one short');

// 4. Planner: a re-priced market plan for the target is funded at the live
// price plus the operating reserve, max(500, level x 250, 10% of the wallet).
const fundedAt = (adena) => GearAcquisitionPlanner.fundedMarketPlanForTarget({ ...base, adena }, plan.target.selfId);
let minimum = price;
while (minimum < price + Math.max(500, 30 * 250, Math.ceil(minimum * 0.1))) minimum += 1;
assert(fundedAt(minimum), 'planner: funded at the computed minimum');
assert.strictEqual(fundedAt(minimum - 1), null, 'planner: one short');

// 5. WTB bid: spendable = wallet - max(plan reserve, operating reserve).
// (Before 2026-10-02: max(100, plan reserve, 10% of the wallet).) The bid
// itself is the bot's belief (group E), never above the plan's price or
// what it may spend.
const BotMarketPricing = invoke('GameServer/Bot/Economy/BotMarketPricing');
const template = DataCache.items.find((item) => Number(item.selfId) === Number(plan.target.selfId));
const fair = BotMarketPricing.priceAt({ selfId: plan.target.selfId, basePrice: Number(template.template.price) }, 0.85);
const bidGoal = { type: 'upgrade_gear', target: { itemId: plan.target.selfId, adena: price },
    plan: { priceSource: 'offer', estimatedCost: price, reserve } };
for (const adena of [price, Math.floor(fair) + reserve - 5000]) {
    const bid = BuyStoreService.bidFor({ ...base, adena }, bidGoal);
    const spendable = adena - Math.max(reserve, 500, 30 * 250, Math.ceil(adena * 0.1));
    assert(bid && bid.price * bid.count <= Math.min(price, spendable), `bid at ${adena}`);
}
assert.strictEqual(BuyStoreService.bidFor({ ...base, adena: reserve }, bidGoal), null, 'bid: nothing spendable, no bid');

// 6. Party review: a member in the wrong armour class leaves to buy its NPC
// replacement only when it can pay for it (was a closure in the cold worker).
const BotGear = invoke('GameServer/Bot/AI/BotGear');
const weapon = BotGear.planFor({ classId: 1, level: 30 }).items.find((item) => Number(item.slot) === 7);
const ROBE = 391; // Puma Skin Shirt: D-grade light armour, wrong for this build
const wrongArmour = (adena) => ({ ...base, adena, inventory: {
    [weapon.selfId]: { selfId: Number(weapon.selfId), amount: 1, equippedCount: 1, equipped: 1 },
    [ROBE]: { selfId: ROBE, amount: 1, equippedCount: 1, equipped: 1 } } });
const bridge = GearAcquisitionPlanner.npcEquipmentBridgePlan(wrongArmour(150000));
assert(bridge?.equipmentBridge, 'the fixture must need a class armour bridge');
// The plan picks the first slot it can afford, so check the rule at several
// wallets: the reason holds exactly when the wallet covers price + reserve.
const seen = new Set();
for (let adena = 20000; adena <= 200000; adena += 1000) {
    const plan = GearAcquisitionPlanner.npcEquipmentBridgePlan(wrongArmour(adena));
    const funded = !!plan?.equipmentBridge && adena >= Number(plan.market.price) + Number(plan.market.reserve);
    const reason = GearAcquisitionPlanner.equipmentBridgeReason(wrongArmour(adena));
    assert.strictEqual(reason, funded ? 'class_armor_bridge' : null, `bridge at ${adena}`);
    seen.add(reason);
}
assert(seen.has('class_armor_bridge') && seen.has(null), 'the wallets cover both outcomes');

// Decided by the user (2026-10-02): every purchase keeps the operating
// reserve. Before, a plan to buy from another bot stored none, a class-build
// goal without a plan used 0, and a material bid kept only max(100, 10%).
const botOffer = { selfId: plan.target.selfId, price, town: 'Giran', sourceType: 'afk_bot_store' };
const botPlan = GearAcquisitionPlanner.planFor({ ...base, adena: 300000 }, {
    spots: [], findMarketOffer: () => botOffer, findNpcOffer: () => null
});
assert.strictEqual(botPlan?.market?.sourceType, 'afk_bot_store', 'the fixture must plan a purchase from a bot');
assert.strictEqual(botPlan.market.reserve, 30000, 'a plan to buy from a bot keeps the operating reserve');
const noPlanGoal = gearGoal({ ...base, level: 40, adena: 5000000,
    stats: { ...base.stats, build: { grade: 'c', classId: 1, level: 40 } } });
assert.strictEqual(noPlanGoal?.plan?.reserve, 500000, 'a class-build goal without a plan keeps the operating reserve');
const materialBid = BuyStoreService.bidFor({ ...base, adena: 10000 }, { type: 'buy_craft_material',
    target: { itemId: 1864, amount: 1000 }, plan: { expectedBenefit: 'market_buy_craft_material' } });
assert(materialBid.price * materialBid.count <= 10000 - 7500, 'a material bid keeps the level 30 operating reserve');

console.log('Purchase funding checks passed');
process.exit(0);
