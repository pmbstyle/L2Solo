const assert = require('assert');
require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const Database = invoke('Database');
const TradeService = invoke('GameServer/Bot/TradeService');
const Item = invoke('GameServer/Item/Item');

function item(id, selfId, amount, name) {
    return new Item(id, {
        selfId,
        name,
        kind: selfId === 57 ? 'Other.Currency' : 'Other.Material',
        amount,
        stackable: true,
        equipped: false,
        slot: 0
    });
}

function bag(items) {
    return {
        items,
        fetchItems() { return this.items; },
        fetchItemFromSelfId(selfId) { return this.items.find((entry) => Number(entry.fetchSelfId()) === Number(selfId)); },
        stackableExists(selfId) {
            const found = this.fetchItemFromSelfId(selfId);
            return found ? Promise.resolve(found) : Promise.reject(new Error('missing_stack'));
        },
        updateAmount(id, amount) {
            const found = this.items.find((entry) => Number(entry.fetchId()) === Number(id));
            if (found) found.setAmount(amount);
        },
        insertItem(id, selfId, data) {
            this.items.push(item(id, selfId, data.amount, data.name || 'Varnish'));
        }
    };
}

function actor(id, adena = 100) {
    return {
        fetchId: () => id,
        backpack: bag([item(id * 10, 57, adena, 'Adena')])
    };
}

async function main() {
    const originalItems = DataCache.items;
    const originals = {
        updateItemAmount: Database.updateItemAmount,
        deleteItem: Database.deleteItem,
        setItem: Database.setItem
    };
    let nextObjectId = 9000;
    try {
        DataCache.items = [
            { selfId: 1864, template: { name: 'Varnish' }, etc: { stackable: true } },
            { selfId: 1865, template: { name: 'Suede' }, etc: { stackable: true } }
        ];
        Database.updateItemAmount = async () => {};
        Database.deleteItem = async () => {};
        Database.setItem = async () => ({ insertId: ++nextObjectId });

        const store = { storeType: 1, items: [{ selfId: 1864, price: 10, count: 5 }] };
        const first = actor(1);
        const second = actor(2);
        const results = await Promise.allSettled([
            TradeService.buyFromStore(first, store, 1864, 5),
            TradeService.buyFromStore(second, store, 1864, 5)
        ]);
        assert.strictEqual(results.filter((result) => result.status === 'fulfilled').length, 1, 'finite stock must allow only one full concurrent purchase');
        assert.strictEqual(results.filter((result) => result.status === 'rejected')[0].reason.message, 'Item is not available.', 'the second buyer must see the exhausted lot');
        assert.strictEqual(store.items.length, 0, 'the finite lot must be fully consumed exactly once');
        const boughtUnits = [first, second]
            .map((buyer) => buyer.backpack.fetchItemFromSelfId(1864)?.fetchAmount() || 0)
            .reduce((sum, amount) => sum + amount, 0);
        assert.strictEqual(boughtUnits, 5, 'concurrent buyers must never receive more units than stock');

        const rollbackStore = { storeType: 1, items: [{ selfId: 1864, price: 10, count: 2 }] };
        const rollbackBuyer = actor(3);
        Database.setItem = async () => { throw new Error('forced item write failure'); };
        await assert.rejects(
            TradeService.buyFromStore(rollbackBuyer, rollbackStore, 1864, 1),
            /forced item write failure/
        );
        assert.strictEqual(rollbackStore.items[0].count, 2, 'failed item write must restore reserved stock');
        assert.strictEqual(rollbackBuyer.backpack.fetchItemFromSelfId(57).fetchAmount(), 100, 'failed item write must restore deducted Adena');
        Database.setItem = async () => ({ insertId: ++nextObjectId });

        const repricedStore = { storeType: 1, items: [{ selfId: 1864, price: 11, count: 2 }] };
        const repricedBuyer = actor(4);
        await assert.rejects(
            TradeService.buyFromStore(repricedBuyer, repricedStore, 1864, 1, { expectedUnitPrice: 10 }),
            /Store price changed/
        );
        assert.strictEqual(repricedStore.items[0].count, 2, 'a repriced lot must remain untouched');
        assert.strictEqual(repricedBuyer.backpack.fetchItemFromSelfId(57).fetchAmount(), 100, 'a repriced lot must not deduct Adena');

        const settledStore = { storeType: 1, items: [{ selfId: 1864, price: 10, count: 1 }] };
        const settledPurchase = await TradeService.buyFromStore(actor(11), settledStore, 1864, 1, {
            afterPurchase: async () => {
                assert.strictEqual(settledStore.activePurchases, 1, 'seller persistence must remain inside the active store transaction');
                throw new Error('forced post-purchase callback failure');
            }
        });
        assert.strictEqual(settledStore.activePurchases, 0);
        assert.strictEqual(settledPurchase.qty, 1, 'a failed post-commit callback must not turn a completed purchase into a failure');
        assert.match(settledPurchase.callbackWarning, /forced post-purchase callback failure/);

        const invalidStore = { storeType: 1, items: [{ selfId: 1864, price: 10, count: 2 }] };
        const invalidBuyer = actor(5);
        await assert.rejects(
            TradeService.buyFromStore(invalidBuyer, invalidStore, 1864, 'not-a-number'),
            /Invalid quantity/
        );
        await assert.rejects(
            TradeService.buyFromStore(invalidBuyer, invalidStore, 1864, 1.5),
            /Invalid quantity/
        );
        assert.strictEqual(invalidBuyer.backpack.fetchItemFromSelfId(57).fetchAmount(), 100, 'invalid quantities must not deduct Adena');
        assert.strictEqual(invalidStore.items[0].count, 2, 'invalid quantities must not reserve stock');

        const sharedBuyer = actor(6);
        const firstActorStore = { storeType: 1, items: [{ selfId: 1864, price: 10, count: 6 }] };
        const secondActorStore = { storeType: 1, items: [{ selfId: 1865, price: 10, count: 3 }] };
        await Promise.all([
            TradeService.buyFromStore(sharedBuyer, firstActorStore, 1864, 6),
            TradeService.buyFromStore(sharedBuyer, secondActorStore, 1865, 3)
        ]);
        assert.strictEqual(
            sharedBuyer.backpack.fetchItemFromSelfId(57).fetchAmount(),
            10,
            'purchases of different items and stores must serialize Adena deductions per actor'
        );

        const seller = actor(7, 0);
        seller.backpack.items.push(item(701, 1864, 2, 'Varnish'));
        const budgetBuyer = actor(8, 100);
        const buyStore = { storeType: 3, budgetBacked: true, items: [{ selfId: 1864, price: 10, count: 3 }] };
        const sold = await TradeService.sellToStore(seller, buyStore, 1864, 2, {
            buyerActor: budgetBuyer,
            afterTrade: async () => {
                assert.strictEqual(buyStore.activePurchases, 1, 'WTB persistence must remain inside the active store transaction');
                throw new Error('forced post-trade callback failure');
            }
        });
        assert.strictEqual(sold.totalAdena, 20);
        assert.match(sold.callbackWarning, /forced post-trade callback failure/, 'a committed WTB sale must survive callback failure');
        assert.strictEqual(seller.backpack.fetchItemFromSelfId(57).fetchAmount(), 20, 'seller receives the buyer bot\'s actual Adena');
        assert.strictEqual(budgetBuyer.backpack.fetchItemFromSelfId(57).fetchAmount(), 80, 'budget-backed WTB deducts the buyer wallet');
        assert.strictEqual(budgetBuyer.backpack.fetchItemFromSelfId(1864).fetchAmount(), 2, 'the purchased item enters the buyer inventory');
        assert.strictEqual(buyStore.items[0].count, 1);

        const poorBuyer = actor(9, 5);
        const protectedSeller = actor(10, 0);
        protectedSeller.backpack.items.push(item(1001, 1864, 1, 'Varnish'));
        const unaffordableStore = { storeType: 3, budgetBacked: true, items: [{ selfId: 1864, price: 10, count: 1 }] };
        await assert.rejects(
            TradeService.sellToStore(protectedSeller, unaffordableStore, 1864, 1, { buyerActor: poorBuyer }),
            /Buyer does not have enough Adena/
        );
        assert.strictEqual(protectedSeller.backpack.fetchItemFromSelfId(1864).fetchAmount(), 1, 'an unfunded WTB must not consume seller stock');
        assert.strictEqual(unaffordableStore.items[0].count, 1);

        const invalidSeller = actor(15, 0);
        invalidSeller.backpack.items.push(item(1501, 1864, 2, 'Varnish'));
        const invalidBuyStore = { storeType: 3, items: [{ selfId: 1864, price: 10, count: 2 }] };
        await assert.rejects(TradeService.sellToStore(invalidSeller, invalidBuyStore, 1864, 'wat'), /Invalid quantity/);
        await assert.rejects(TradeService.sellToStore(invalidSeller, invalidBuyStore, 1864, 1.5), /Invalid quantity/);
        assert.strictEqual(invalidSeller.backpack.fetchItemFromSelfId(1864).fetchAmount(), 2);
        assert.strictEqual(invalidBuyStore.items[0].count, 2);

        const noWalletBuyer = actor(16, 0);
        noWalletBuyer.backpack.items = [];
        await assert.rejects(
            TradeService.sellToStore(invalidSeller, { storeType: 3, budgetBacked: true, items: [{ selfId: 1864, price: 10, count: 1 }] }, 1864, 1, { buyerActor: noWalletBuyer }),
            /Buyer does not have enough Adena/
        );

        const concurrentBuyer = actor(17, 10);
        const varnishSeller = actor(18, 0);
        varnishSeller.backpack.items.push(item(1801, 1864, 1, 'Varnish'));
        const suedeSeller = actor(19, 0);
        suedeSeller.backpack.items.push(item(1901, 1865, 1, 'Suede'));
        const concurrentSales = await Promise.allSettled([
            TradeService.sellToStore(varnishSeller, { storeType: 3, budgetBacked: true, items: [{ selfId: 1864, price: 10, count: 1 }] }, 1864, 1, { buyerActor: concurrentBuyer }),
            TradeService.sellToStore(suedeSeller, { storeType: 3, budgetBacked: true, items: [{ selfId: 1865, price: 10, count: 1 }] }, 1865, 1, { buyerActor: concurrentBuyer })
        ]);
        assert.strictEqual(concurrentSales.filter((result) => result.status === 'fulfilled').length, 1, 'one buyer wallet must not fund two concurrent WTB stores');
        assert.strictEqual(concurrentBuyer.backpack.fetchItemFromSelfId(57), undefined, 'the single funded purchase must consume the buyer wallet exactly once');
        const receivedUnits = [1864, 1865].reduce((sum, id) => sum + Number(concurrentBuyer.backpack.fetchItemFromSelfId(id)?.fetchAmount() || 0), 0);
        assert.strictEqual(receivedUnits, 1, 'serialized WTB sales must transfer only the funded item');

        const lineSeller = actor(20, 0);
        lineSeller.backpack.items.push(item(2001, 1864, 1, 'Varnish'));
        const failingLineSeller = actor(21, 0);
        failingLineSeller.backpack.items.push(item(2101, 1865, 1, 'Suede'));
        const multiLineStore = {
            storeType: 3,
            items: [
                { selfId: 1864, price: 10, count: 1 },
                { selfId: 1865, price: 10, count: 1 }
            ]
        };
        const workingUpdateItemAmount = Database.updateItemAmount;
        Database.updateItemAmount = async (characterId) => {
            if (Number(characterId) === 21) throw new Error('forced second-line payout failure');
        };
        const concurrentLines = await Promise.allSettled([
            TradeService.sellToStore(lineSeller, multiLineStore, 1864, 1),
            TradeService.sellToStore(failingLineSeller, multiLineStore, 1865, 1)
        ]);
        Database.updateItemAmount = workingUpdateItemAmount;
        assert.strictEqual(concurrentLines.filter((result) => result.status === 'fulfilled').length, 1);
        assert.strictEqual(concurrentLines.filter((result) => result.status === 'rejected').length, 1);
        assert.strictEqual(multiLineStore.items.length, 1, 'a successful line must not remove another in-flight WTB line');
        assert.strictEqual(multiLineStore.items[0].selfId, 1865);
        assert.strictEqual(multiLineStore.items[0].count, 1, 'a failed WTB line must return to the store at its original quantity');
        console.log('Trade store atomicity checks passed');
    } finally {
        DataCache.items = originalItems;
        Database.updateItemAmount = originals.updateItemAmount;
        Database.deleteItem = originals.deleteItem;
        Database.setItem = originals.setItem;
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
