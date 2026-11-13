const assert = require('assert');
const Packet = require('../src/GameServer/Bot/Economy/StatsPacket');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('fx-market-case');
const fs = require('node:fs');
require('../src/Global');
fixture.assertConfigured(options.default);
process.on('exit', () => fs.rmSync(fixture.directory, { recursive: true, force: true }));
const NativeChoice = require('./helpers/nativeMarketChoice');

(async () => {
const DataCache = invoke('GameServer/DataCache');
const Funding = invoke('GameServer/Bot/Economy/PurchaseFunding');
DataCache.init();
const NECKLACE = 910; // Necklace of Devotion, sold by NPCs
const necklace = DataCache.items.find((item) => Number(item.selfId) === NECKLACE);
assert(necklace, 'fixture item');
// A hunting bot's bag of craft materials (from a wealth bot of a saved world).
const loot = Object.fromEntries([[1864, 60], [1865, 15], [1866, 26], [1868, 108], [1869, 23], [1871, 49]]
    .map(([selfId, amount]) => [String(selfId), { selfId, amount,
        name: DataCache.items.find((item) => Number(item.selfId) === selfId)?.template?.name }]));
// Its healing potions at the stock's own target, whatever use the table gives
// them: the gear is what the wallet weighs.
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const stocked = state => ({ ...state, inventory: { ...state.inventory,
    1061: { selfId: 1061, amount: Economy.basics(state).stock('potions').target } } });
const bot = (persona, equipmentPlan, adena = 2000000) => stocked({
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
    assert.strictEqual(goal.plan.wishKey, leaf.rootKey);
    assert.strictEqual(goal.plan.economyActivity, leaf.activity);
    if (leaf.activity === 'shopping') {
        assert.strictEqual(goal.target.itemId, leaf.itemId);
        assert.strictEqual(goal.plan.estimatedCost, leaf.price);
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
    assert.strictEqual(result.goals[0].type, goal.type, 'the goal is the first need');
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
assert(Packet.firstUnfundedPrice(poorChoice.state.stats.money) > 0, 'a real unfunded gap remains');
assert.strictEqual(Funding.spendable(poorChoice.state, 0, { itemId: NECKLACE }), 0,
    'the old jewellery plan alone cannot authorize its debit');

// A sale leaf names no kind the last sale visit could not place (stats.marketSellSeen) with no
// new buyer of it: it would only send the bot back to leave it in the bag again. A kind it did
// not try (or a new buyer of one) opens only itself: the kinds the visit kept stay no sale.
{
    const Providers = invoke('GameServer/Bot/Economy/WishProviders');
    const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');
    const seller = bot(wealth, npcJewellery, 50000);
    const kinds = state => Providers.liquidationCandidates(state, Economy.basics(state)).map(row => Number(row.selfId));
    const seen = Disposition.saleSeen(seller).items;
    assert(kinds(seller).some(id => seen.includes(id)), 'the loot is for sale');
    const after = { ...seller, stats: { ...seller.stats, marketSellSeen: { items: seen, buyers: null } } };
    assert(Disposition.saleRetryHolds(after), 'fixture: nothing new since the visit');
    assert.deepStrictEqual(kinds(after), kinds(seller).filter(id => !seen.includes(id)), 'the kinds the last visit kept are no sale');
    const newKind = { ...seller, stats: { ...seller.stats, marketSellSeen: { items: seen.slice(1), buyers: null } } };
    assert.deepStrictEqual(kinds(newKind), kinds(seller).filter(id => !seen.slice(1).includes(id)),
        'a kind the visit did not try is for sale, the kinds it kept are not');
    // A grade crystal no sale leaf offers (it waits on the bot's own shop) is new to the
    // retry, yet the leaf names none of the kinds the visit kept.
    const crystal = { ...after, inventory: { ...after.inventory, 1458: { selfId: 1458, amount: 20, stackable: true } } };
    assert.deepStrictEqual(kinds(crystal), kinds(after), 'a crystal in the bag sends no kept kind to sale again');
    // Soul Ore bought for the shots the bot still wishes for (its craft hold) is no new goods:
    // the retry holds and no sale offers it.
    const ore = { ...after, inventory: { ...after.inventory, 1785: { selfId: 1785, amount: 30, stackable: true } },
        stats: { ...after.stats, craftHold: [['stock:shots', [[1458, 10], [1785, 30]]]] } };
    assert(Disposition.saleRetryHolds(ore), 'an input bought for a held craft does not end the sale retry');
    assert(!kinds(ore).includes(1785), 'the held craft input is no sale');
    // A new buyer of a kept kind opens that kind alone; a better bid on a kind the bag no longer
    // holds sends the bot to sell nothing: the retry holds.
    const bids = {};
    Disposition.useBoard(() => ({ list: id => bids[id] ? [{ ownerId: 99, price: 1e9, count: 5 }] : [] }));
    try {
        const watched = { ...seller, stats: { ...seller.stats, marketSellSeen: { items: [...seen, 1458], buyers: [...seen, 1458].map(() => [0, 0]) } } };
        bids[1458] = true;
        assert(Disposition.saleRetryHolds(watched), 'a bid on goods the bag no longer holds does not end the retry');
        bids[seen[0]] = true;
        assert(!Disposition.saleRetryHolds(watched), 'a new buyer of a kept kind ends the retry');
        assert.deepStrictEqual(kinds(watched), kinds(seller).filter(id => id === seen[0] || !seen.includes(id)),
            'the kind with a new buyer is for sale, the other kept kinds are not');
    } finally { Disposition.useBoard(() => invoke('GameServer/AfkTrade/AfkTradeService').boardIndex()); }
}

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
