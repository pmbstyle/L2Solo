const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const World = invoke('GameServer/World/World');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const BotSupplyErrand = invoke('GameServer/Bot/AI/BotSupplyErrand');
const TradeService = invoke('GameServer/Bot/TradeService');
const LangfuseTracing = invoke('GameServer/Bot/AI/LangfuseTracing');

function inventoryItem(id, selfId, amount) {
    let count = amount;
    return {
        fetchId: () => id,
        fetchSelfId: () => selfId,
        fetchAmount: () => count,
        setAmount: (value) => { count = value; },
        fetchName: () => 'Soulshot: D-grade'
    };
}

async function main() {
    const originalItems = DataCache.items;
    const originalWorldUser = World.user;
    const originalBuy = TradeService.buyFromStore;
    const originalStartObservation = LangfuseTracing.startObservation;
    const observations = [];
    const botItem = inventoryItem(700, 1463, 0);
    const bot = {
        fetchId: () => 7100,
        backpack: { fetchItemFromSelfId: (selfId) => Number(selfId) === 1463 ? botItem : null }
    };
    const store = {
        storeType: 1,
        town: 'Talking Island',
        items: [{ selfId: 1864, price: 10, count: 2 }]
    };
    const merchant = {
        fetchId: () => 7200,
        fetchName: () => 'IslandMats',
        fetchLocX: () => -84168,
        fetchLocY: () => 244729,
        fetchLocZ: () => -3730,
        fetchPrivateStore: () => store
    };
    const merchantSession = { actor: merchant };
    let calls = 0;
    try {
        DataCache.init();
        World.user = { sessions: [merchantSession] };
        LangfuseTracing.startObservation = (name, input, metadata) => {
            observations.push({ name, input, metadata });
            return { end() {} };
        };

        assert.strictEqual(MarketOpportunity.bestSupplyOffer(1864), null,
            'group F retires configured material supply even while its actor is live');
        const offer = MarketOpportunity.bestSupplyOffer(1463);
        assert(offer, 'configured shots remain in the fixed supply table until 3.6');
        assert.strictEqual(offer.sourceType, 'configured_store');
        assert.strictEqual(offer.sourceId, offer.sourceName);
        assert.strictEqual(offer.count, Infinity);
        assert(offer.price > 0);

        TradeService.buyFromStore = async (_bot, liveStore, selfId, amount, options) => {
            calls += 1;
            assert.notStrictEqual(liveStore, store, 'shot supply uses the server-owned table, not a material merchant');
            assert.strictEqual(selfId, 1463);
            assert.strictEqual(options.expectedUnitPrice, offer.price);
            const line = liveStore.items.find((entry) => entry.selfId === selfId);
            line.count -= amount;
            botItem.setAmount(botItem.fetchAmount() + amount);
            return { qty: amount, totalAdena: amount * options.expectedUnitPrice, name: 'Soulshot: D-grade' };
        };

        const overdraw = await BotSupplyErrand.purchaseAtDestination(bot, {
            workflowId: 'workflow-stock-reject',
            sourceType: 'configured_store',
            sourceId: 7200,
            sourceName: 'IslandMats',
            itemId: 1864,
            amount: 3,
            unitPrice: 10
        });
        assert.strictEqual(overdraw.ok, false);
        assert.strictEqual(overdraw.reason, 'configured_supply_retired');
        assert.strictEqual(calls, 0, 'a stale configured material errand must be rejected before TradeService');
        assert.strictEqual(store.items[0].count, 2);

        const bought = await BotSupplyErrand.purchaseAtDestination(bot, {
            workflowId: 'workflow-stock-ok',
            sourceType: 'configured_store',
            sourceId: offer.sourceId,
            sourceName: offer.sourceName,
            itemId: 1463,
            amount: 1,
            unitPrice: offer.price
        });
        assert.strictEqual(bought.ok, true);
        assert.strictEqual(calls, 1);
        assert.strictEqual(store.items[0].count, 2, 'player-facing material stock is untouched');
        assert.strictEqual(botItem.fetchAmount(), 1);
        assert(observations.some((entry) => entry.name === 'bot.workflow.supply.purchase' && entry.metadata.workflowId === 'workflow-stock-ok'));
        console.log('Configured supply store checks passed');
    } finally {
        DataCache.items = originalItems;
        World.user = originalWorldUser;
        TradeService.buyFromStore = originalBuy;
        LangfuseTracing.startObservation = originalStartObservation;
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
