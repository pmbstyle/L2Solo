const assert = require('assert');
require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const Database = invoke('Database');
const ProgressionRates = invoke('GameServer/ProgressionRates');
const TradeService = invoke('GameServer/Bot/TradeService');
const Pricing = invoke('GameServer/Bot/Economy/StaticMerchantPricing');
const Configs = invoke('GameServer/Bot/MerchantStoreConfigs');
const Shops = invoke('GameServer/World/Generics/NpcShopBuyLists');
const MarketSnapshot = invoke('GameServer/Bot/Economy/MarketSnapshot');
const StaticBuyerService = invoke('GameServer/Bot/Economy/StaticBuyerService');
const PurchaseItems = invoke('GameServer/World/Generics/PurchaseItems');

DataCache.init();
const originals = {
    profile: ProgressionRates.profile,
    update: Database.updateItemAmount,
    delete: Database.deleteItem
};
const templates = new Map(DataCache.items.map((item) => [item.selfId, item]));
const normalize = (store) => TradeService.normalizeStoreItems(store, { staticStore: true });
const storeFor = (town, storeType, selfId) => {
    const matches = Object.values(Configs).filter((store) =>
        store.town === town
        && store.storeType === storeType
        && store.items.some((line) => line.selfId === selfId)
    );
    assert.strictEqual(matches.length, 1, `expected one ${town} store of type ${storeType} for item ${selfId}`);
    return matches[0];
};

function inventoryItem(selfId, amount) {
    return {
        fetchSelfId: () => selfId,
        fetchId: () => selfId,
        fetchAmount: () => amount,
        setAmount: (value) => { amount = value; },
        fetchEquipped: () => false
    };
}

async function run() {
    for (const rate of [1, 10, 50]) {
        ProgressionRates.profile = () => ({ adena: rate });
        const cheapest = new Map();
        const addOffer = (id, price) => cheapest.set(id, Math.min(cheapest.get(id) ?? Infinity, price));
        // Enumerate actual NPC lists independently of the policy's allOffers index.
        for (const id of Shops.npcIds()) {
            for (const line of Shops.fetchForNpc(id)) {
                addOffer(line.selfId, line.price ?? templates.get(line.selfId).template.price);
            }
        }
        for (const store of Object.values(Configs).filter((entry) => entry.storeType === 1)) {
            for (const line of normalize(store)) addOffer(line.selfId, line.price);
        }
        const snapshot = MarketSnapshot.fixedStores();
        for (const [name, store] of Object.entries(Configs)) {
            const actual = normalize(store);
            const shown = snapshot.find((row) => row.ownerName === name).items;
            assert.deepStrictEqual(shown.map(({ selfId, price }) => ({ selfId, price })),
                actual.map(({ selfId, price }) => ({ selfId, price })), `${name}: observer/live parity at x${rate}`);
            if (store.storeType !== 3) continue;
            for (const line of actual) {
                const purchase = cheapest.get(line.selfId);
                assert(Number.isSafeInteger(line.price) && line.price > 0);
                if (purchase !== undefined) {
                    assert(line.price < purchase, `${name} item ${line.selfId} arbitrage at x${rate}: ${purchase} -> ${line.price}`);
                    assert(line.price <= Math.floor(purchase * 0.9), `${name}: missing buyback margin`);
                }
            }
        }
        const state = {
            characterId: 991, level: 10, inventory: {
                1921: { selfId: 1921, amount: 10, kind: 'Other.Material' }
            }, stats: {}
        };
        const cold = StaticBuyerService.candidatesFor(state, 'Gludio').find((line) => line.selfId === 1921);
        assert(cold, 'cold liquidation must still accept the configured material');
        assert.strictEqual(cold.npcPrice, normalize(storeFor('Gludio', 3, 1921)).find((line) => line.selfId === 1921).price);
        assert.strictEqual(normalize(storeFor('Talking Island', 3, 1864)).find((line) => line.selfId === 1864).price,
            TradeService.ratedPrice(1864, 0.8), 'resource liquidity without a cheaper NPC source keeps its authored price');
    }

    // Explicit static prices and future inverted coefficients must also be capped.
    const inflated = { selfId: 2006, price: 99999999, count: 10 };
    const cap = Math.floor(normalize(storeFor('Talking Island', 1, 2006)).find((line) => line.selfId === 2006).price * 0.9);
    assert.strictEqual(Pricing.priceFor(storeFor('Talking Island', 3, 2006), inflated), cap);
    assert.strictEqual(normalize({ storeType: 3, items: [inflated] })[0].price, cap);
    assert.strictEqual(TradeService.normalizeStoreItems({ storeType: 3, items: [inflated] })[0].price,
        inflated.price, 'dynamic stores retain their negotiated prices');
    assert.strictEqual(Pricing.priceFor(storeFor('Giran', 3, 219), { selfId: 219, priceRate: 100 }), 241560,
        'use Graham at 268400, not an earlier NPC list at 292800');

    // Reproduce purchase -> inventory delivery -> static buyback with real
    // trade functions and an isolated in-memory database boundary.
    Database.updateItemAmount = async () => {};
    Database.deleteItem = async () => {};
    const adena = inventoryItem(57, 1000000);
    const backpack = {
        items: [adena],
        fetchItemFromSelfId(id) { return this.items.find((item) => item.fetchSelfId() === id); },
        fetchTotalAdena: () => adena.fetchAmount(),
        deleteItem(session, id, amount, done) { adena.setAmount(adena.fetchAmount() - amount); done(); }
    };
    const actor = { backpack, fetchId: () => 991 };
    const price = Shops.fetchForNpc(7084).find((line) => line.selfId === 219).price;
    await new Promise((resolve) => {
        PurchaseItems.call({ purchaseItem(session, id, amount) {
            backpack.items.push(inventoryItem(id, amount));
            resolve();
        } }, { actor }, [{ selfId: 219, amount: 1 }], { prices: new Map([[219, price]]) });
    });
    assert.strictEqual(adena.fetchAmount(), 731600);
    const store = { storeType: 3, items: normalize(storeFor('Giran', 3, 219)) };
    const sale = await TradeService.sellToStore(actor, store, 219, 1);
    assert.strictEqual(sale.totalAdena, 241560);
    assert.strictEqual(adena.fetchAmount(), 973160, 'round trip must lose 26840 Adena, not mint millions');
    assert.strictEqual(backpack.fetchItemFromSelfId(219), undefined);
    assert.strictEqual(store.items.find((line) => line.selfId === 219).count, 999998);
    console.log('Static merchant pricing: all stores at x1/x10/x50, cold/observer parity and Sword Breaker round trip passed');
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => {
    ProgressionRates.profile = originals.profile;
    Database.updateItemAmount = originals.update;
    Database.deleteItem = originals.delete;
});