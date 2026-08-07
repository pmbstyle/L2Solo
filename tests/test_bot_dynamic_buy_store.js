const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const GoalState = invoke('GameServer/Bot/Goals/GoalState');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const BuyStoreService = invoke('GameServer/Bot/Economy/ColdMarketBuyStoreService');
const MarketSnapshot = invoke('GameServer/Bot/Economy/MarketSnapshot');
const TradeChat = invoke('GameServer/Bot/Economy/ColdMarketTradeChat');

DataCache.init();

const originals = {
    snapshot: LifeState.snapshot,
    upsertState: LifeState.upsertState,
    applyMarketPurchase: LifeState.applyMarketPurchase,
    applyMarketSale: LifeState.applyMarketSale,
    allStates: LifeState.allStates,
    clearGoal: GoalState.clear
};

async function run() {
    LifeState.upsertState = (state) => Promise.resolve(state);
    GoalState.clear = () => Promise.resolve(null);

    const buyerSeed = {
        characterId: 501,
        accountName: 'buyer',
        name: 'BudgetBuyer',
        level: 20,
        adena: 1000,
        phase: 'cold',
        activity: 'shopping',
        currentRegion: 'Giran',
        loc: { locX: 82000, locY: 148500, locZ: -3466 },
        inventory: { 57: { selfId: 57, name: 'Adena', amount: 1000 } },
        stats: { marketReturn: { loc: { locX: 100, locY: 200, locZ: 0 }, regionName: 'Field', spotId: 'field' } },
        timing: {},
        vitals: {}
    };
    const goal = { type: 'buy_craft_material', target: { itemId: 1864, itemName: 'Stem', amount: 5 }, plan: {} };
    const bid = BuyStoreService.bidFor(buyerSeed, goal);
    assert(bid && bid.count > 0);
    assert(bid.price * bid.count <= 900, 'a dynamic WTB must preserve its wallet reserve');

    const opened = await BuyStoreService.open(buyerSeed, goal, { now: 1000, durationMs: 60000 });
    assert.strictEqual(opened.opened, true);
    assert.strictEqual(opened.state.activity, 'merchant');
    assert.strictEqual(opened.store.storeType, 3);
    assert.strictEqual(opened.store.budgetBacked, true);
    assert(opened.store.items[0].price * opened.store.items[0].count <= buyerSeed.adena);
    assert(TradeChat.offerText(opened.store).startsWith('WTB '), 'a buy store must not advertise itself as WTS');

    const buyer = {
        ...opened.state,
        adena: 1000,
        stats: {
            ...opened.state.stats,
            marketStore: {
                ...opened.store,
                town: 'Giran',
                expiresAt: Date.now() + 60000,
                items: [{ selfId: 1864, name: 'Stem', kind: 'Other.Material', price: 100, count: 3 }]
            }
        }
    };
    LifeState.allStates = () => [buyer];
    const marketSnapshot = MarketSnapshot.snapshot();
    assert.strictEqual(marketSnapshot.dynamic.wtb, 1);
    assert.strictEqual(marketSnapshot.byTown.Giran.buyUnits, 3);
    assert(marketSnapshot.byTown['Elven Village'].fixedWtb > 0, 'starter market coverage must be visible in the market snapshot');
    const seller = {
        characterId: 502,
        accountName: 'seller',
        name: 'MaterialSeller',
        level: 20,
        adena: 0,
        phase: 'cold',
        activity: 'shopping',
        currentRegion: 'Giran',
        loc: {},
        inventory: {
            57: { selfId: 57, name: 'Adena', amount: 0 },
            1864: { selfId: 1864, name: 'Stem', amount: 2, equipped: false, stackable: true, slot: 0, kind: 'Other.Material' }
        },
        stats: {},
        timing: {},
        vitals: {}
    };

    MarketOpportunity.resetColdStores();
    MarketOpportunity.indexColdStore(buyer);
    LifeState.snapshot = (id) => Number(id) === buyer.characterId ? buyer : null;
    LifeState.applyMarketPurchase = (state, offer, qty) => Promise.resolve({
        ...state,
        adena: state.adena - offer.price * qty,
        inventory: {
            ...state.inventory,
            57: { ...state.inventory[57], amount: state.adena - offer.price * qty },
            1864: { selfId: 1864, name: 'Stem', amount: qty, equipped: false, stackable: true, slot: 0, kind: 'Other.Material' }
        },
        stats: { ...state.stats, marketWanted: null }
    });
    LifeState.applyMarketSale = (state, offer, qty) => Promise.resolve({
        ...state,
        adena: state.adena + offer.price * qty,
        inventory: {
            ...state.inventory,
            57: { ...state.inventory[57], amount: state.adena + offer.price * qty },
            1864: { ...state.inventory[1864], amount: state.inventory[1864].amount - qty }
        }
    });

    assert.strictEqual(BuyStoreService.bestTownFor(seller).town, 'Giran', 'a seller must discover demand in a neighboring market');
    const sale = await BuyStoreService.sellToBestBuyer(seller, 'Giran');
    assert.strictEqual(sale.sold, true);
    assert.strictEqual(sale.itemCount, 2);
    assert.strictEqual(sale.adena, 200);
    assert.strictEqual(sale.state.adena, 200);
    assert.strictEqual(sale.sales[0].buyer.adena, 800);
    assert.strictEqual(sale.sales[0].buyer.stats.marketStore.items[0].count, 1);

    console.log('Bot dynamic buy-store checks passed');
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => {
    LifeState.snapshot = originals.snapshot;
    LifeState.upsertState = originals.upsertState;
    LifeState.applyMarketPurchase = originals.applyMarketPurchase;
    LifeState.applyMarketSale = originals.applyMarketSale;
    LifeState.allStates = originals.allStates;
    GoalState.clear = originals.clearGoal;
    MarketOpportunity.resetColdStores();
});
