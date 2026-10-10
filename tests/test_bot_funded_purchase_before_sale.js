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
const GoalPlanner = invoke('GameServer/Bot/Goals/GoalPlanner');
const Funding = invoke('GameServer/Bot/Economy/PurchaseFunding');
DataCache.init();
const NECKLACE = 910; // Necklace of Devotion, sold by NPCs
const necklace = DataCache.items.find((item) => Number(item.selfId) === NECKLACE);
assert(necklace, 'fixture item');
// A hunting bot's bag of craft materials (from a wealth bot of a saved world).
const loot = Object.fromEntries([[1864, 60], [1865, 15], [1866, 26], [1868, 108], [1869, 23], [1871, 49]]
    .map(([selfId, amount]) => [String(selfId), { selfId, amount,
        name: DataCache.items.find((item) => Number(item.selfId) === selfId)?.template?.name }]));
const bot = (persona, equipmentPlan, adena = 2000000) => ({
    // Purchases are executable only over prepared routes from where the bot
    // stands (5e91bb1c): the hunting bot is near Giran.
    characterId: 7, name: 'Saver', accountName: 'bot_7', phase: 'cold', activity: 'hunting', level: 30, adena,
    loc: { locX: 83000, locY: 148000, locZ: -3400 },
    persona, inventory: loot, vitals: { hp: 2000, maxHp: 2000, mp: 1000, maxMp: 1000 },
    stats: { generatedCold: true, classId: 1, role: 'dps', build: { grade: 'd', classId: 1, level: 30 }, equipment: [], equipmentPlan }
});
const npcJewellery = { status: 'active', strategy: 'market', partyNeedReason: 'npc_progression',
    target: { selfId: NECKLACE, slot: Number(necklace.etc?.slot || 0) },
    market: { town: 'Gludio', price: 78980, reserve: 200000, sourceType: 'npc' } };
const wealth = { primaryDrive: 'wealth', traits: {} };


// ARCH-NOTE: FX-C1 reads one genuine worker choice; NeedsEvaluator maps
// voluntary choices at priority50. The prior78/86/58/82 ladder is retired.
async function choice(state, label) {
    const result = await NativeChoice.capture(state, { nativeRoutes: true }, label);
    assert.strictEqual(result.goals.length, 1, 'one worker leaf, not simultaneous buy and sale alternatives');
    const goal = result.goals[0], leaf = result.read.activity;
    assert.strictEqual(goal.priority, 50);
    assert.strictEqual(goal.plan.wishKey, leaf.rootKey);
    assert.strictEqual(goal.plan.economyActivity, leaf.activity);
    assert.deepStrictEqual(goal.blockers, []);
    if (leaf.activity === 'shopping') {
        assert.strictEqual(goal.target.itemId, leaf.itemId);
        assert.strictEqual(goal.plan.estimatedCost, leaf.price);
        assert.strictEqual(goal.plan.requiredAdena, 0);
        assert.strictEqual(goal.type, Number(DataCache.items.find(row => Number(row.selfId) === leaf.itemId)?.etc?.slot || 0)
            ? 'upgrade_gear' : 'buy_craft_material');
        assert(Funding.spendable(result.state, 0, { itemId: leaf.itemId }) >= leaf.price,
            'the selected purchase is funded by the same actual E3 packet');
    } else if (leaf.activity === 'hunting') {
        assert.strictEqual(goal.type, leaf.funding ? 'earn_adena' : 'progress_level');
        assert.strictEqual(result.goals.find(row => row.type === 'sell_inventory'), undefined,
            'the selected hunt does not manufacture a competing sale');
    } else if (leaf.activity === 'selling') {
        assert.strictEqual(goal.type, 'sell_inventory');
        assert.deepStrictEqual(goal.target.itemIds, leaf.items || []);
    }
    assert.strictEqual(GoalPlanner.plan(result.goals, Date.now()).type, goal.type);
    return result;
}
const wealthChoice = await choice(bot(wealth, npcJewellery), 'wealth_original_2m');
assert.strictEqual(wealthChoice.read.activity.activity, 'shopping', 'the original wealthy wallet funds a native purchase');
assert.strictEqual(wealthChoice.goals[0].type, 'upgrade_gear');
assert.strictEqual(wealthChoice.goals.find(row => row.type === 'sell_inventory'), undefined,
    'buying happens first without a parallel sale leaf');

const poorChoice = await choice(bot(wealth, npcJewellery, 50000), 'poor_original_50k');
// Selling the loot is finite funding too (f75b6525): the poor wallet earns its
// missing purchase value by hunting or by selling, never by buying.
assert(['hunting', 'selling'].includes(poorChoice.read.activity.activity), 'the original poor wallet must earn its missing purchase value');
assert(poorChoice.state.stats.money[3] > 0, 'a real unfunded gap remains');
assert.strictEqual(Funding.spendable(poorChoice.state, 0, { itemId: NECKLACE }), 0,
    'the old jewellery plan alone cannot authorize its debit');

const botOffer = { ...npcJewellery, partyNeedReason: 'market_fallback', market: { ...npcJewellery.market, sourceType: 'afk_bot_store' } };
const ordinary = { ...bot({ primaryDrive: 'progress', traits: {} }, botOffer), level: 40,
    stats: { ...bot(null, botOffer).stats, build: { grade: 'c', classId: 1, level: 40 } } };
await choice(ordinary, 'ordinary_original_2m');

const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const MATERIAL = 1864;
const craftPlan = { status: 'active', strategy: 'craft', recipeId: 192, target: { selfId: 89, slot: 7 },
    materials: [{ selfId: MATERIAL, amount: 100, owned: 60, missing: 40, farmEffort: 5000 }] };
try {
    // Publish the original40x1000 lot into the actual BoardIndex/table channel.
    // An AfkTrade.offers spy cannot change what the genuine worker sees.
    AfkTrade.refreshRecord({ id: 991192, ownerId: 9, ownerName: 'Owner9', ownerAccount: 'bot_9',
        kind: 'sell_ad', storeType: AfkTrade.SELL, status: 'active', town: 'Giran', title: '', revision: 1,
        expiresAt: 0, locX: 0, locY: 0, locZ: 0, appearance: {}, lines: [{ id: 991193, selfId: MATERIAL,
            name: 'Stem', count: 40, price: 1000, enchant: 0 }] });
    assert.strictEqual(AfkTrade.boardIndex().list(MATERIAL, AfkTrade.SELL)[0].count, 40);
    assert.strictEqual(AfkTrade.boardIndex().list(MATERIAL, AfkTrade.SELL)[0].price, 1000);
    await choice(bot(wealth, craftPlan), 'craft_original_with_40x1000');
    AfkTrade._resetForTests();
    const missing = await choice(bot(wealth, craftPlan), 'craft_original_no_offer');
    assert.strictEqual(missing.goals.find(row => row.type === 'buy_craft_material'
        && row.target.itemId === MATERIAL), undefined, 'the removed material offer is not a supplied shopping leaf');
} finally { AfkTrade._resetForTests(); }
console.log('Funded purchase before sale checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
