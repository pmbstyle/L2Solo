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

    const funded = actorWith({ shots: 1000, adena: 20000 });
    const purchased = await ShotStock.purchaseActorRestock(funded, { plan });
    assert.strictEqual(purchased.ok, true);
    assert.strictEqual(purchased.delta, 2000, 'a funded bot below target should buy up to 3000 shots');
    assert.strictEqual(purchased.amount, 3000);
    assert.strictEqual(purchased.cost, 14000);
    assert.strictEqual(funded.backpack.fetchItemFromSelfId(1835).fetchAmount(), 3000);
    assert.strictEqual(funded.backpack.fetchItemFromSelfId(57).fetchAmount(), 6000);
    assert.deepStrictEqual(updates, [
        { characterId: 100, itemId: 1, amount: 6000 },
        { characterId: 100, itemId: 2, amount: 3000 }
    ]);

    updates.length = 0;
    const partiallyFunded = actorWith({ shots: 1000, adena: 7000 });
    const partialPurchase = await ShotStock.purchaseActorRestock(partiallyFunded, { plan });
    assert.strictEqual(partialPurchase.ok, true);
    assert.strictEqual(partialPurchase.delta, 1000,
        'a bot that cannot afford the full target should buy as many shots as its Adena allows');
    assert.strictEqual(partialPurchase.amount, 2000);
    assert.strictEqual(partialPurchase.cost, 7000);
    assert.strictEqual(partiallyFunded.backpack.fetchItemFromSelfId(1835).fetchAmount(), 2000);
    assert.strictEqual(partiallyFunded.backpack.fetchItemFromSelfId(57).fetchAmount(), 0);
    assert.deepStrictEqual(updates, [
        { characterId: 100, itemId: 1, amount: 0 },
        { characterId: 100, itemId: 2, amount: 2000 }
    ]);

    updates.length = 0;
    const stocked = actorWith({ shots: 3000, adena: 20000 });
    const skippedAtTarget = await ShotStock.purchaseActorRestock(stocked, { plan });
    assert.strictEqual(skippedAtTarget.changed, false, 'stock at target must not trigger a purchase');
    assert.strictEqual(skippedAtTarget.cost, 0);
    assert.deepStrictEqual(updates, []);

    const unfunded = actorWith({ shots: 1000, adena: 0 });
    const skippedWithoutAdena = await ShotStock.purchaseActorRestock(unfunded, { plan });
    assert.strictEqual(skippedWithoutAdena.ok, false, 'a bot without Adena must not receive paid restock');
    assert.strictEqual(skippedWithoutAdena.reason, 'not_enough_adena');
    assert.strictEqual(unfunded.backpack.fetchItemFromSelfId(1835).fetchAmount(), 1000);
    assert.deepStrictEqual(updates, []);

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
