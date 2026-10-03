const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const NeedsEvaluator = invoke('GameServer/Bot/Goals/NeedsEvaluator');
const GoalPlanner = invoke('GameServer/Bot/Goals/GoalPlanner');

DataCache.init();

// The author: "An affordable static-shop upgrade must outrank inventory
// sales, otherwise the bot can keep opening sell stores while carrying enough
// Adena". A wealth persona's sale (74 + 12 = 86) outranked its funded NPC
// jewellery (78): the sale condition is nearly always true for a hunting bot,
// so the jewellery was never bought. For a wealth persona, wealth is gear
// value plus Adena (the author, 2026-10-02): the purchase comes first.
const NECKLACE = 910; // Necklace of Devotion, sold by NPCs
const necklace = DataCache.items.find((item) => Number(item.selfId) === NECKLACE);
assert(necklace, 'fixture item');
// A hunting bot's bag of craft materials (from a wealth bot of a saved world).
const loot = Object.fromEntries([[1864, 60], [1865, 15], [1866, 26], [1868, 108], [1869, 23], [1871, 49]]
    .map(([selfId, amount]) => [String(selfId), { selfId, amount,
        name: DataCache.items.find((item) => Number(item.selfId) === selfId)?.template?.name }]));
const bot = (persona, equipmentPlan, adena = 2000000) => ({
    characterId: 7, name: 'Saver', accountName: 'bot_7', phase: 'cold', activity: 'hunting', level: 30, adena,
    persona, inventory: loot, vitals: { hp: 2000, maxHp: 2000, mp: 1000, maxMp: 1000 },
    stats: { generatedCold: true, classId: 1, role: 'dps', build: { grade: 'd', classId: 1, level: 30 }, equipment: [], equipmentPlan }
});
const npcJewellery = { status: 'active', strategy: 'market', partyNeedReason: 'npc_progression',
    target: { selfId: NECKLACE, slot: Number(necklace.etc?.slot || 0) },
    market: { town: 'Gludio', price: 78980, reserve: 200000, sourceType: 'npc' } };
const wealth = { primaryDrive: 'wealth', traits: {} };

const needs = (state) => NeedsEvaluator.evaluate(state);
const of = (candidates, type) => candidates.find((candidate) => candidate.type === type);

const wealthNeeds = needs(bot(wealth, npcJewellery));
const purchase = of(wealthNeeds, 'upgrade_gear');
const sale = of(wealthNeeds, 'sell_inventory');
assert.strictEqual(purchase?.plan?.requiredAdena, 0, 'fixture: the jewellery is funded');
assert.strictEqual(purchase.priority, 78, 'the author\'s jewellery priority stays');
assert(sale?.plan?.personaDrive === 'wealth', 'fixture: a wealth sale is on offer');
assert(sale.priority < purchase.priority, 'a wealth sale waits for a funded purchase');
assert.strictEqual(GoalPlanner.plan(wealthNeeds, Date.now()).type, 'upgrade_gear', 'the bot buys first');

// Unfunded, the sale keeps the author's 86.
const poorNeeds = needs(bot(wealth, npcJewellery, 50000));
assert(of(poorNeeds, 'upgrade_gear').plan.requiredAdena > 0);
assert.strictEqual(of(poorNeeds, 'sell_inventory').priority, 86, 'without the money the wealth sale keeps 86');

// G9: a funded purchase from another bot (58) also beats a normal sale (74).
const botOffer = { ...npcJewellery, partyNeedReason: 'market_fallback', market: { ...npcJewellery.market, sourceType: 'afk_bot_store' } };
const ordinaryNeeds = needs({ ...bot({ primaryDrive: 'progress', traits: {} }, botOffer), level: 40,
    stats: { ...bot(null, botOffer).stats, build: { grade: 'c', classId: 1, level: 40 } } });
const bought = of(ordinaryNeeds, 'upgrade_gear');
assert.strictEqual(bought?.plan?.requiredAdena, 0, 'fixture: the purchase from a bot is funded');
assert.strictEqual(bought.priority, 58, 'the author\'s funded market priority stays');
assert(of(ordinaryNeeds, 'sell_inventory').priority < 58, 'a normal sale waits for a funded purchase from a bot');

// E9: a craft material the bot can already pay for (an offer within its
// spendable adena and cheaper than farming it) is a funded purchase too; the
// wealth sale (86) waited for nothing and outranked the material buy (82).
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const MATERIAL = 1864; // in the bag: 60 of the 100 the recipe needs
const craftPlan = { status: 'active', strategy: 'craft', recipeId: 192, target: { selfId: 89, slot: 7 },
    materials: [{ selfId: MATERIAL, amount: 100, owned: 60, missing: 40, farmEffort: 5000 }] };
const offers = AfkTrade.offers;
AfkTrade.offers = (selfId) => Number(selfId) === MATERIAL
    ? [{ selfId: MATERIAL, count: 40, price: 1000, town: 'Giran', sourceType: 'afk_bot_store', characterId: 9 }] : [];
try {
    const craftNeeds = needs(bot(wealth, craftPlan));
    const material = of(craftNeeds, 'buy_craft_material');
    assert.strictEqual(material?.priority, 82, 'fixture: the material is on offer and the author\'s priority stays');
    assert.strictEqual(material.plan.priceSource, 'offer');
    const craftSale = of(craftNeeds, 'sell_inventory');
    assert(craftSale?.plan?.personaDrive === 'wealth', 'fixture: a wealth sale is on offer');
    assert(craftSale.priority < material.priority, 'a wealth sale waits for a funded material purchase');
    assert.strictEqual(GoalPlanner.plan(craftNeeds, Date.now()).type, 'buy_craft_material', 'the bot buys the material first');

    // No offer the bot can take: no funded purchase, the sale keeps 86.
    AfkTrade.offers = () => [];
    const noOfferNeeds = needs(bot(wealth, craftPlan));
    assert.strictEqual(of(noOfferNeeds, 'buy_craft_material'), undefined, 'fixture: nothing to buy');
    assert.strictEqual(of(noOfferNeeds, 'sell_inventory').priority, 86, 'without a funded purchase the wealth sale keeps 86');
} finally {
    AfkTrade.offers = offers;
}

console.log('Funded purchase before sale checks passed');
process.exit(0);
