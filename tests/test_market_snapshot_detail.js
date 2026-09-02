const assert = require('assert');

require('../src/Global');

const MarketSnapshot = invoke('GameServer/Bot/Economy/MarketSnapshot');

const now = Date.now();
const itemsById = new Map([[1864, {
    selfId: 1864,
    template: { name: 'Stem', kind: 'Other.Material' }
}]]);
const states = [{
    characterId: 11,
    name: 'Crafter',
    adena: 1000,
    stats: { marketWanted: { itemId: 1864, lastMissingAt: now } }
}];
const stores = [{
    id: 'player:20',
    source: 'player',
    ownerId: 20,
    ownerName: 'Seller',
    storeType: 1,
    side: 'wts',
    title: 'Materials',
    town: 'Giran',
    loc: null,
    items: [{ selfId: 1864, name: 'Stem', kind: 'Other.Material', count: 3, price: 80 }]
}, {
    id: 'bot:21',
    source: 'bot',
    ownerId: 21,
    ownerName: 'Buyer',
    storeType: 3,
    side: 'wtb',
    title: 'WTB Stem',
    town: 'Giran',
    loc: null,
    items: [{ selfId: 1864, name: 'Stem', kind: 'Other.Material', count: 2, price: 60 }]
}, {
    id: 'fixed:Nika',
    source: 'fixed',
    ownerId: null,
    ownerName: 'Nika',
    storeType: 3,
    side: 'wtb',
    title: 'Buy materials',
    town: 'Giran',
    loc: null,
    items: [{ selfId: 1864, name: 'Stem', kind: 'Other.Material', count: 999999, price: 55 }]
}];
const transactions = {
    recentPeerTrades: [{
        id: 1,
        at: now - 1000,
        channel: 'wts',
        selfId: 1864,
        itemName: 'Stem',
        quantity: 2,
        unitPrice: 75,
        adena: 150,
        town: 'Giran',
        seller: { characterId: 20, name: 'Seller' },
        buyer: { characterId: 11, name: 'Crafter' }
    }],
    recentPlayerTrades: [],
    recentStaticTrades: [],
    recentNpcTrades: [],
    byItem: [{ selfId: 1864, name: 'Stem', trades: 2, items: 4, adena: 300, channels: {} }],
    byTown: { Giran: { trades: 2, items: 4, adena: 300 } }
};

const detail = MarketSnapshot.buildDetail({ states, stores, transactions, now, itemsById });
assert.strictEqual(detail.historyScope, 'server_start');
assert.deepStrictEqual(detail.summary, {
    wtsStores: 1,
    wtbStores: 2,
    sellUnits: 3,
    buyUnits: 2,
    fixedSellUnits: 0,
    fixedBuyUnits: 999999,
    trades: 2,
    tradedAdena: 300
});
assert.deepStrictEqual(detail.byTown.Giran, { wts: 1, wtb: 1, fixedWts: 0, fixedWtb: 1, sellUnits: 3, buyUnits: 2 });
assert.strictEqual(detail.items.length, 1);
assert.strictEqual(detail.items[0].name, 'Stem');
assert.strictEqual(detail.items[0].wts.minPrice, 80);
assert.strictEqual(detail.items[0].wtb.maxPrice, 60);
assert.strictEqual(detail.items[0].wtb.organicUnits, 2);
assert.strictEqual(detail.items[0].wtb.fixedUnits, 999999);
assert.strictEqual(detail.items[0].demand.bots, 1);
assert.strictEqual(detail.items[0].demand.fundedUnits, 1);
assert.strictEqual(detail.items[0].lastTradePrice, 75);
assert.deepStrictEqual(detail.items[0].sources, ['bot', 'fixed', 'player']);
assert.deepStrictEqual(detail.items[0].towns, ['Giran']);
assert.strictEqual(detail.transactions.recent.length, 1);

const DataCache = invoke('GameServer/DataCache');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const Database = invoke('Database');
const World = invoke('GameServer/World/World');
const originalAllStates = LifeState.allStates;
const originalFetchAfkTradeShops = Database.fetchAfkTradeShops;
const originalUser = World.user;

(async () => {
    DataCache.init();
    LifeState.allStates = () => states;
    Database.fetchAfkTradeShops = () => Promise.resolve([]);
    World.user = { sessions: [] };
    const liveDetail = await MarketSnapshot.detail();
    assert(liveDetail.stores.some((store) => store.source === 'fixed'), 'the live market endpoint must include fixed traders');
    assert(liveDetail.items.some((item) => item.selfId === 1864), 'the live market endpoint must merge active planned demand');
    console.log('Market snapshot detail checks passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => {
    LifeState.allStates = originalAllStates;
    Database.fetchAfkTradeShops = originalFetchAfkTradeShops;
    World.user = originalUser;
});
