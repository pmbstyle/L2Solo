const assert = require('assert');

require('../src/Global');

const Database = invoke('Database');
const ShotStock = invoke('GameServer/Inventory/ShotStock');

function inventoryItem(id, amount) {
    return {
        amount,
        fetchId() { return id; },
        fetchAmount() { return this.amount; },
        setAmount(nextAmount) { this.amount = nextAmount; }
    };
}

function actorWith({ shots, adena }) {
    const items = new Map();
    if (shots !== null) items.set(1835, inventoryItem(2, shots));
    if (adena !== null) items.set(57, inventoryItem(1, adena));

    return {
        fetchId: () => 100,
        backpack: {
            fetchItemFromSelfId(selfId) { return items.get(Number(selfId)); }
        }
    };
}

const plan = {
    kind: 'soulshot',
    rank: 'none',
    selfId: 1835,
    name: 'Soulshot: No Grade',
    price: 7
};

const originalUpdateItemAmount = Database.updateItemAmount;
const originalFetchItems = Database.fetchItems;

(async () => {
    const updates = [];
    Database.updateItemAmount = (characterId, itemId, amount) => {
        updates.push({ characterId, itemId, amount });
        return Promise.resolve();
    };

    assert.strictEqual(ShotStock.DEFAULT_TARGET_AMOUNT, 1000,
        'free starter stock must remain capped at 1000 shots');
    assert.strictEqual(ShotStock.PURCHASE_TARGET_AMOUNT, 3000,
        'paid restocking should target 3000 shots');
    updates.length = 0;

    // One restock rule for hot and cold bots (S3, user 2026-10-04), replacing
    // the author's hot "top up to 3000 with the whole wallet" and cold "NPC only
    // at 0 shots, 5% of the wallet": below 1000 shots buy up to 3000, players'
    // shops cheaper than the NPC first, keeping the consumables reserve.
    const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
    const originalOffers = AfkTrade.offers;
    const originalBuyFromShop = AfkTrade.buyFromShop;
    let offers = [];
    const shopBuys = [];
    AfkTrade.offers = () => offers;
    AfkTrade.buyFromShop = async (_characterId, store, selfId, amount, options) => {
        shopBuys.push({ store, amount, price: options.expectedPrice });
        const bag = currentActor.backpack;
        bag.fetchItemFromSelfId(57).setAmount(bag.fetchItemFromSelfId(57).fetchAmount() - amount * options.expectedPrice);
        bag.fetchItemFromSelfId(selfId).setAmount(bag.fetchItemFromSelfId(selfId).fetchAmount() + amount);
        return {};
    };
    let currentActor = null;
    try {
        // Level 1: the reserve is max(500, 250, 10% of the wallet) = 2,000 of 20,000.
        const funded = currentActor = actorWith({ shots: 999, adena: 20000 });
        const purchased = await ShotStock.purchaseActorRestock(funded, { plan, unitPrice: 7 });
        assert.strictEqual(purchased.ok, true);
        assert.strictEqual(purchased.delta, 2001, 'a funded bot below 1000 shots buys up to 3000');
        assert.strictEqual(purchased.amount, 3000);
        assert.strictEqual(purchased.cost, 14007);
        assert.strictEqual(funded.backpack.fetchItemFromSelfId(57).fetchAmount(), 5993);
        assert.deepStrictEqual(updates, [
            { characterId: 100, itemId: 1, amount: 5993 },
            { characterId: 100, itemId: 2, amount: 3000 }
        ]);

        updates.length = 0;
        const atThreshold = currentActor = actorWith({ shots: 1000, adena: 20000 });
        const skipped = await ShotStock.purchaseActorRestock(atThreshold, { plan, unitPrice: 7 });
        assert.strictEqual(skipped.changed, false, 'a bot at 1000 shots does not restock');
        assert.strictEqual(skipped.cost, 0);
        assert.deepStrictEqual(updates, []);

        // 7,000 adena keeps a 700 reserve: 900 shots, never the whole wallet.
        const partiallyFunded = currentActor = actorWith({ shots: 0, adena: 7000 });
        const partialPurchase = await ShotStock.purchaseActorRestock(partiallyFunded, { plan, unitPrice: 7 });
        assert.strictEqual(partialPurchase.ok, true);
        assert.strictEqual(partialPurchase.delta, 900, 'a short wallet buys what is above its reserve');
        assert.strictEqual(partiallyFunded.backpack.fetchItemFromSelfId(57).fetchAmount(), 700,
            'the consumables reserve is never spent');

        updates.length = 0;
        const unfunded = currentActor = actorWith({ shots: 100, adena: 500 });
        const skippedWithoutAdena = await ShotStock.purchaseActorRestock(unfunded, { plan, unitPrice: 7 });
        assert.strictEqual(skippedWithoutAdena.ok, false, 'a wallet at its reserve buys nothing');
        assert.strictEqual(skippedWithoutAdena.reason, 'not_enough_adena');
        assert.strictEqual(unfunded.backpack.fetchItemFromSelfId(1835).fetchAmount(), 100);
        assert.deepStrictEqual(updates, []);

        // Players' shops below the NPC price first, cheapest first, as many as needed; then the NPC.
        offers = [{ store: 'b', price: 6, count: 500 }, { store: 'a', price: 5, count: 1000 },
            { store: 'c', price: 7, count: 5000 }, { store: 'd', price: 6, count: 600 }];
        const shopper = currentActor = actorWith({ shots: 0, adena: 100000 });
        const shopped = await ShotStock.purchaseActorRestock(shopper, { plan, unitPrice: 7 });
        assert.deepStrictEqual(shopBuys.map((buy) => [buy.store, buy.amount, buy.price]),
            [['a', 1000, 5], ['b', 500, 6], ['d', 600, 6]], 'shops below the NPC price, cheapest first');
        assert.strictEqual(shopped.delta, 3000, 'the NPC sells the rest');
        assert.strictEqual(shopped.cost, 5000 + 3000 + 3600 + 900 * 7);
        assert.strictEqual(shopper.backpack.fetchItemFromSelfId(1835).fetchAmount(), 3000);
        offers = [];

        // The decided example: a level 30 bot with 51,000 adena and no D shots at 20 each
        // keeps max(500, 30 x 250, 5,100) = 7,500 and spends the rest.
        const dPlan = ShotStock.planForKind('soulshot', 'd');
        const example = ShotStock.restockPlan({ level: 30, adena: 51000, inventory: {} },
            { plan: dPlan, unitPrice: 20, offers: [] });
        assert.deepStrictEqual([example.amount, example.cost, example.adena - example.cost, example.reserve],
            [2175, 43500, 7500, 7500]);

        // A hot bot and its cold state with the same shots, wallet and level get the same plan.
        offers = [{ store: 'a', price: 15, count: 400 }];
        const cold = { level: 30, adena: 51000, inventory: { 1463: { selfId: 1463, amount: 200 } } };
        const hot = { ...actorWith({ shots: null, adena: 51000 }), fetchLevel: () => 30 };
        hot.backpack.fetchItemFromSelfId = (selfId) => Number(selfId) === 57
            ? inventoryItem(1, 51000) : Number(selfId) === 1463 ? inventoryItem(3, 200) : undefined;
        const coldPlan = ShotStock.restockPlan(cold, { plan: dPlan, unitPrice: 20, offers });
        const hotPlan = ShotStock.restockPlan(hot, { plan: dPlan, unitPrice: 20, offers });
        assert.deepStrictEqual(hotPlan, coldPlan, 'hot and cold bots restock by the same rule');
        assert.deepStrictEqual([coldPlan.shops[0].amount, coldPlan.npcAmount], [400, 1875]);
    } finally {
        AfkTrade.offers = originalOffers;
        AfkTrade.buyFromShop = originalBuyFromShop;
    }

    updates.length = 0;
    Database.fetchItems = () => Promise.resolve([{
        id: 2,
        selfId: 1835,
        name: 'Soulshot: No Grade',
        amount: 3000,
        equipped: 0,
        slot: 0
    }]);
    const restartMinimum = await ShotStock.ensureCharacterStock(100, {
        plan,
        targetAmount: ShotStock.DEFAULT_TARGET_AMOUNT
    });
    assert.strictEqual(restartMinimum.changed, false,
        'bot restart minimum must not truncate paid stock above 1000');
    assert.strictEqual(restartMinimum.amount, 3000,
        'paid stock should survive the bot restart inventory reconciliation');
    assert.deepStrictEqual(updates, []);

    console.log('Shot stock paid restock checks passed');
})().finally(() => {
    Database.updateItemAmount = originalUpdateItemAmount;
    Database.fetchItems = originalFetchItems;
}).catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
