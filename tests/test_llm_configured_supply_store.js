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
        fetchName: () => 'Varnish'
    };
}

async function main() {
    const originalItems = DataCache.items;
    const originalWorldUser = World.user;
    const originalBuy = TradeService.buyFromStore;
    const originalStartObservation = LangfuseTracing.startObservation;
    const observations = [];
    const botItem = inventoryItem(700, 1864, 0);
    const bot = {
        fetchId: () => 7100,
        backpack: { fetchItemFromSelfId: (selfId) => Number(selfId) === 1864 ? botItem : null }
    };
    const store = {
        storeType: 1,
        town: 'Talking Island',
        items: [{ selfId: 1864, price: 10, count: 2 }]
    };
    const merchant = {
        fetchId: () => 7200,
        fetchName: () => 'Mira',
        fetchLocX: () => -84168,
        fetchLocY: () => 244729,
        fetchLocZ: () => -3730,
        fetchPrivateStore: () => store
    };
    const merchantSession = { actor: merchant };
    let calls = 0;
    try {
        DataCache.items = [{ selfId: 1864, template: { name: 'Varnish' }, etc: { stackable: true } }];
        World.user = { sessions: [merchantSession] };
        LangfuseTracing.startObservation = (name, input, metadata) => {
            observations.push({ name, input, metadata });
            return { end() {} };
        };

        const offer = MarketOpportunity.bestSupplyOffer(1864);
        assert(offer, 'live configured merchant should produce a supply offer');
        assert.strictEqual(offer.sourceType, 'configured_store');
        assert.strictEqual(offer.sourceId, 7200);
        assert.strictEqual(offer.count, 2);
        assert.strictEqual(offer.price, 10);
        assert.strictEqual(MarketOpportunity.bestSupplyOffer(1864, { amount: 3 }), null, 'a finite store must not be selected for an oversized request');

        TradeService.buyFromStore = async (_bot, liveStore, selfId, amount) => {
            calls += 1;
            assert.strictEqual(liveStore, store);
            assert.strictEqual(selfId, 1864);
            const line = liveStore.items.find((entry) => entry.selfId === selfId);
            line.count -= amount;
            botItem.setAmount(botItem.fetchAmount() + amount);
            return { qty: amount, totalAdena: amount * line.price, name: 'Varnish' };
        };

        const overdraw = await BotSupplyErrand.purchaseAtDestination(bot, {
            workflowId: 'workflow-stock-reject',
            sourceType: 'configured_store',
            sourceId: 7200,
            sourceName: 'Mira',
            itemId: 1864,
            amount: 3,
            unitPrice: 10
        });
        assert.strictEqual(overdraw.ok, false);
        assert.strictEqual(overdraw.reason, 'configured_store_stock_changed');
        assert.strictEqual(calls, 0, 'finite stock must be checked before TradeService');
        assert.strictEqual(store.items[0].count, 2);

        const bought = await BotSupplyErrand.purchaseAtDestination(bot, {
            workflowId: 'workflow-stock-ok',
            sourceType: 'configured_store',
            sourceId: 7200,
            sourceName: 'Mira',
            itemId: 1864,
            amount: 1,
            unitPrice: 10
        });
        assert.strictEqual(bought.ok, true);
        assert.strictEqual(calls, 1);
        assert.strictEqual(store.items[0].count, 1);
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
