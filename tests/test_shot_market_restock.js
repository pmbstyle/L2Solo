const assert = require('assert');

require('../src/Global');
invoke('GameServer/DataCache').init();

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
    // The explicit restock is a funded leaf; this narrow actor fixture has no combat kit.
    session: { coldLifeState: { stats: { money: [77000, 1.3e-5, 0, 0, 4e-5, 7000, 1835] } } },
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
    // The cheaper AFK offer first, then the NPC up to the explicit target.
    StaticMerchantPricing.cheapestPurchase = (selfId) => (Number(selfId) === 1835 ? 7 : 0);
    const npcWrites = [];
    Database.updateItemAmount = (...args) => { npcWrites.push(args); return Promise.resolve({}); };
    const result = await ShotStock.purchaseActorRestock(actor, { plan, targetAmount: 1000, unitPrice: 7, town: 'Giran' });
    assert.deepStrictEqual(purchases, [{ selfId: 1835, amount: 900 }], 'the cheaper AFK offer is bought first');
    assert.strictEqual(result.amount, 1000);
    assert.strictEqual(result.cost, 900 * 5);
    assert.strictEqual(amounts.get(57), 5500, 'the explicit target stops the purchase once filled');
    assert.strictEqual(npcWrites.length, 0, 'a filled cheaper target needs no NPC purchase');
    console.log('Shot restock buys the cheaper AFK offer first, then the NPC above the reserve');
})().finally(() => {
    AfkTrade.offers = originalOffers;
    StaticMerchantPricing.cheapestPurchase = originalCheapest;
    AfkTrade.buyFromShop = originalBuy;
    Database.updateItemAmount = originalUpdate;
});
