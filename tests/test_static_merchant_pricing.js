const assert = require('assert');
const crypto = require('crypto');
require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const Database = invoke('Database');
const ProgressionRates = invoke('GameServer/ProgressionRates');
const TradeService = invoke('GameServer/Bot/TradeService');
const Pricing = invoke('GameServer/Bot/Economy/StaticMerchantPricing');
const Configs = invoke('GameServer/Bot/MerchantStoreConfigs');
const Shops = invoke('GameServer/World/Generics/NpcShopBuyLists');
const MarketSnapshot = invoke('GameServer/Bot/Economy/MarketSnapshot');
const PurchaseItems = invoke('GameServer/World/Generics/PurchaseItems');
const NpcSellRules = invoke('GameServer/Items/NpcSellRules');

DataCache.init();
const originals = {
    profile: ProgressionRates.profile,
    update: Database.updateItemAmount,
    delete: Database.deleteItem
};
const templates = new Map(DataCache.items.map((item) => [item.selfId, item]));
const normalize = (store) => TradeService.normalizeStoreItems(store, { staticStore: true });
const botLines = store => store.items.map(line => ({ selfId: line.selfId, count: line.count ?? 1,
    price: Pricing.botPriceFor(store, line) })).filter(line => line.price > 0);
// The 330 retained lines after removing permanent refined-material buyback:
// moving player prices must not change any retained bot payout or shot price.
// x10/x50 moved once when the payout cap read the one NPC table (town
// sellers): 4 jewelry payouts no longer sit under fallback lists no NPC sells.
const baselineBotPrices = {
    1: '650518d7b76a4b21e7dc71255cad60543aee1ca6e291dda45783cfad1cb4f794',
    10: 'a5f70e02681bb4a84613486029ab153743db24808598334544b08dc7c90057b6',
    50: '848b3d3cd1d1391201a1df73179ad3653862a2bbf1d80472346e8b8af4e9fa24'
};

function inventoryItem(selfId, amount) {
    return {
        fetchSelfId: () => selfId,
        fetchId: () => selfId,
        fetchAmount: () => amount,
        fetchStackable: () => templates.get(selfId)?.etc?.stackable === true,
        setAmount: (value) => { amount = value; },
        fetchEquipped: () => false
    };
}

async function run() {
    for (const rate of [1, 10, 50]) {
        ProgressionRates.profile = () => ({ adena: rate, multiplier: rate });
        const retainedPrices = Object.entries(Configs).flatMap(([name, store]) => (
            store.items.map(line => [name, line.selfId, Pricing.botPriceFor(store, line)])
        ));
        assert.strictEqual(crypto.createHash('sha256').update(JSON.stringify(retainedPrices)).digest('hex'),
            baselineBotPrices[rate], `every retained bot price matches the baseline at x${rate}`);
        const cheapest = new Map();
        const addOffer = (id, price) => cheapest.set(id, Math.min(cheapest.get(id) ?? Infinity, price));
        // Enumerate actual NPC lists independently of the policy's NPC price table.
        for (const id of Shops.npcIds()) {
            for (const line of Shops.fetchForNpc(id)) {
                addOffer(line.selfId, line.price ?? templates.get(line.selfId).template.price);
            }
        }
        for (const store of Object.values(Configs).filter((entry) => entry.storeType === 1)) {
            for (const line of normalize(store)) addOffer(line.selfId, line.price);
        }
        for (const offer of Pricing.sellersOf(1835)) {
            const line = Configs[offer.sourceName].items.find(item => item.selfId === 1835);
            assert.strictEqual(offer.price, TradeService.ratedPrice(1835, line.priceRate),
                `shot trip supply stays authored at x${rate}`);
        }
        const snapshot = MarketSnapshot.fixedStores();
        for (const [name, store] of Object.entries(Configs)) {
            const actual = normalize(store);
            const shown = snapshot.find((row) => row.ownerName === name).items;
            assert.deepStrictEqual(shown.map(({ selfId, price }) => ({ selfId, price })),
                actual.map(({ selfId, price }) => ({ selfId, price })), `${name}: observer/live parity at x${rate}`);
            if (store.storeType !== 3) continue;
            for (const line of botLines(store)) {
                const purchase = cheapest.get(line.selfId);
                assert(Number.isSafeInteger(line.price) && line.price > 0);
                if (purchase !== undefined) {
                    assert(line.price < purchase, `${name} item ${line.selfId} arbitrage at x${rate}: ${purchase} -> ${line.price}`);
                    assert(line.price <= Math.floor(purchase * 0.9), `${name}: missing buyback margin`);
                }
            }
            for (const line of actual) {
                assert.strictEqual(line.price, NpcSellRules.npcBuyPrice(templates.get(line.selfId).template.price),
                    `${name}: empty player board uses C4 buy-back at x${rate}`);
            }
        }
        assert.strictEqual(botLines(Configs['4manda']).find((line) => line.selfId === 1864).price,
            TradeService.ratedPrice(1864, 0.8), 'resource liquidity without a cheaper NPC source keeps its authored price');
    }

    ProgressionRates.profile = () => ({ adena: 1, multiplier: 1 });
    // Explicit static prices and future inverted coefficients must also be capped.
    const inflated = { selfId: 2006, price: 99999999, count: 10 };
    const cap = Math.floor(normalize(Configs.TomRiddle).find((line) => line.selfId === 2006).price * 0.9);
    assert.strictEqual(Pricing.botPriceFor(Configs.Addicted, inflated), cap);
    assert.strictEqual(normalize({ storeType: 3, items: [inflated] })[0].price,
        NpcSellRules.npcBuyPrice(templates.get(inflated.selfId).template.price));
    assert.strictEqual(TradeService.normalizeStoreItems({ storeType: 3, items: [inflated] })[0].price,
        inflated.price, 'dynamic stores retain their negotiated prices');
    ProgressionRates.profile = () => ({ adena: 10, multiplier: 10 });
    assert.strictEqual(Pricing.botPriceFor(Configs.Veteranas, { selfId: 219, priceRate: 100 }), 483120,
        'at x10 use Graham at 536800, not an earlier NPC list at 585600');
    ProgressionRates.profile = () => ({ adena: 1, multiplier: 1 });

    // Reproduce purchase -> inventory delivery -> static buyback with real
    // trade functions and an isolated in-memory database boundary.
    Database.updateItemAmount = async () => {};
    Database.deleteItem = async () => {};
    const adena = inventoryItem(57, 1000000);
    const backpack = {
        items: [adena],
        fetchItems() { return this.items; },
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
    const store = { storeType: 3, items: normalize(Configs.Veteranas) };
    const sale = await TradeService.sellToStore(actor, store, 219, 1);
    const buyback = NpcSellRules.npcBuyPrice(templates.get(219).template.price);
    assert.strictEqual(sale.totalAdena, buyback);
    assert.strictEqual(adena.fetchAmount(), 731600 + buyback, 'the player round trip uses ordinary C4 buy-back');
    assert.strictEqual(backpack.fetchItemFromSelfId(219), undefined);
    assert.strictEqual(store.items.find((line) => line.selfId === 219).count, 999998);
    console.log('Static merchant pricing: bot ceilings, player C4/observer parity at x1/x10/x50 and Sword Breaker round trip passed');
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => {
    ProgressionRates.profile = originals.profile;
    Database.updateItemAmount = originals.update;
    Database.deleteItem = originals.delete;
});
