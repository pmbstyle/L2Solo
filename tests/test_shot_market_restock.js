const assert = require('assert');

require('../src/Global');

const ShotStock = invoke('GameServer/Inventory/ShotStock');
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const Database = invoke('Database');
const StaticMerchantPricing = invoke('GameServer/Bot/Economy/StaticMerchantPricing');
const originalOffers = AfkTrade.offers;
const originalCheapest = StaticMerchantPricing.cheapestPurchase;
const originalBuy = AfkTrade.buyFromShop;
const originalUpdate = Database.updateItemAmount;

const amounts = new Map([[57, 10000], [1835, 100]]);
const items = new Map([...amounts].map(([selfId]) => [selfId, {
    fetchId: () => selfId, fetchAmount: () => amounts.get(selfId),
    setAmount: (amount) => amounts.set(selfId, amount)
}]));
const actor = {
    fetchId: () => 100,
    backpack: { fetchItemFromSelfId: (selfId) => items.get(Number(selfId)) }
};
const plan = { selfId: 1835, kind: 'soulshot', rank: 'none', price: 7, name: 'Soulshot: No Grade' };

(async () => {
    const purchases = [];
    AfkTrade.offers = () => [{ price: 5, count: 900, store: { afkTrade: true }, sourceId: 200 }];
    AfkTrade.buyFromShop = async (_buyerId, _store, selfId, amount) => {
        purchases.push({ selfId, amount });
        amounts.set(57, amounts.get(57) - amount * 5);
        amounts.set(selfId, amounts.get(selfId) + amount);
        return {};
    };
    // One restock rule (S3): the cheaper AFK offer first, then the NPC (price 7)
    // up to 3,000 shots with only the money above the consumables reserve.
    StaticMerchantPricing.cheapestPurchase = (selfId) => (Number(selfId) === 1835 ? 7 : 0);
    const npcWrites = [];
    Database.updateItemAmount = (...args) => { npcWrites.push(args); return Promise.resolve({}); };
    const result = await ShotStock.purchaseActorRestock(actor, { plan, targetAmount: 1000, town: 'Giran' });
    assert.deepStrictEqual(purchases, [{ selfId: 1835, amount: 900 }], 'the cheaper AFK offer is bought first');
    assert.strictEqual(result.amount, 1642);
    assert.strictEqual(result.cost, 900 * 5 + 642 * 7);
    assert.strictEqual(amounts.get(57), 1006, 'the consumables reserve stays');
    assert.ok(npcWrites.length > 0, 'the rest comes from the NPC');
    console.log('Shot restock buys the cheaper AFK offer first, then the NPC above the reserve');
})().finally(() => {
    AfkTrade.offers = originalOffers;
    StaticMerchantPricing.cheapestPurchase = originalCheapest;
    AfkTrade.buyFromShop = originalBuy;
    Database.updateItemAmount = originalUpdate;
});
