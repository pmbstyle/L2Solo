const assert = require('assert');

require('../src/Global');

// A hot bot's buy store (a private_buy_store near the player) buys from an AFK
// sell store. The trade commits while the buyer is hot, so no cold state is
// synced: the buy line must still be lowered and saved the hot way
// (syncMarketSession, as a sale to that store does), or the store keeps
// wanting what it already bought and the match loop buys it again and again.
const DataCache = invoke('GameServer/DataCache');
const Database = invoke('Database');
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const BuyStore = invoke('GameServer/Bot/Economy/ColdMarketBuyStoreService');
const BotLifeState = invoke('GameServer/Bot/Population/BotLifeState');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');

DataCache.init();

const BONE = 1872;
const SELLER = 9100;
const BUYER = 9200;

async function run() {
    Database.execute = () => Promise.resolve([]);
    Database.updateCharacterLocation = async () => {};
    Database.updateCharacterExperience = async () => {};
    Database.updateCharacterVitals = async () => {};
    Database.reconcileBotClanMembership = async () => ({ repairedMembers: 0, repairedParties: 0 });
    Database.reconcileBotClanGoals = async () => ({ repairedMembers: 0, repairedParties: 0 });

    const sellStore = { id: 7, ownerId: SELLER, storeType: 1, town: 'Giran',
        items: [{ selfId: BONE, name: 'Animal Bone', price: 50, count: 50, afkTradeLineId: 1 }] };
    const buyLive = { storeType: 3, budgetBacked: true, items: [{ selfId: BONE, name: 'Animal Bone', price: 60, count: 10 }] };
    const buyerState = { characterId: BUYER, accountName: `bot${BUYER}`, name: 'HotBuyer', level: 30, adena: 100000,
        phase: 'hot', activity: 'merchant', currentRegion: 'Giran', inventory: { 57: { selfId: 57, name: 'Adena', amount: 100000 } },
        stats: { marketStore: { storeType: 3, budgetBacked: true, items: buyLive.items.map((item) => ({ ...item })) } },
        loc: { locX: 1, locY: 2, locZ: 3 }, vitals: {}, timing: {} };
    await BotLifeState.upsertState(buyerState, 'hot_activation');
    let storeType = 3;
    const broadcasts = [];
    const ServerResponse = invoke('GameServer/Network/Response');
    ServerResponse.charInfo = () => Buffer.from('charInfo');
    const session = { coldMarketState: { ...buyerState }, actor: {
        fetchPrivateStore: () => buyLive,
        setPrivateStoreType: (type) => { storeType = type; },
        setPrivateStore: () => {},
        session: { dataSendToOthers: (packet) => broadcasts.push(String(packet)) },
        backpack: { fetchItems: () => [] }
    } };
    AfkTrade.findOwnerProjection = (ownerId) => (Number(ownerId) === SELLER
        ? { actor: { fetchPrivateStore: () => sellStore, fetchName: () => 'AfkSeller' } } : null);
    MarketOpportunity.findBuyOffers = (selfId) => buyLive.items
        .filter((item) => Number(item.selfId) === Number(selfId) && Number(item.count) > 0)
        .map((item) => ({ sourceType: 'private_buy_store', sourceId: BUYER, price: item.price, count: item.count, session }));
    MarketOpportunity.reserveBuy = () => true;
    MarketOpportunity.commitBuy = () => {};
    MarketOpportunity.releaseBuy = () => {};
    let trades = 0;
    AfkTrade.buyFromShop = () => { trades++; return Promise.resolve({ ok: true, coldState: null }); };

    const result = await BuyStore.matchAfkPlayerShop(SELLER, { maxTrades: 64 });
    assert.strictEqual(trades, 1, 'a hot buy store buys what it wants once');
    assert.strictEqual(result.trades.length, 1);
    assert.deepStrictEqual(buyLive.items, [], 'the bought line leaves the live buy store');
    assert.strictEqual(storeType, 0, 'a sold-out hot buy store closes, as after a player\'s sale');
    assert.deepStrictEqual(broadcasts, ['charInfo'], 'and nearby players see it closed');
    assert.strictEqual(BotLifeState.snapshot(BUYER).phase, 'hot', 'the buyer row stays hot');

    // A cold buy order whose owner was activated while the trade ran: the offer
    // has no session, the online one is found and its live store is lowered.
    const BotManager = invoke('GameServer/Bot/BotManager');
    const activated = { characterId: BUYER + 1, accountName: 'bot9201', name: 'Activated', level: 30, adena: 100000,
        phase: 'hot', activity: 'merchant', currentRegion: 'Giran', inventory: { 57: { selfId: 57, name: 'Adena', amount: 100000 } },
        stats: { marketStore: { storeType: 3, items: [{ selfId: BONE, price: 60, count: 5 }] } },
        loc: { locX: 1, locY: 2, locZ: 3 }, vitals: {}, timing: {} };
    await BotLifeState.upsertState(activated, 'hot_activation');
    const liveAfter = { storeType: 3, items: [{ selfId: BONE, name: 'Animal Bone', price: 60, count: 5 }] };
    const online = { coldMarketState: { ...activated }, actor: { fetchId: () => BUYER + 1, fetchPrivateStore: () => liveAfter,
        setPrivateStoreType: () => {}, setPrivateStore: () => {}, backpack: { fetchItems: () => [] } } };
    BotManager.sessions = [...(BotManager.sessions || []), online];
    let wanted = 5;
    MarketOpportunity.findBuyOffers = (selfId) => (Number(selfId) === BONE && wanted > 0
        ? [{ sourceType: 'cold_buy_store', sourceId: BUYER + 1, price: 60, count: wanted, buyerState: activated }] : []);
    const lowered = await BuyStore.matchAfkPlayerShop(SELLER, { maxTrades: 1 });
    wanted = 0;
    assert.strictEqual(lowered.trades.length, 1);
    assert.deepStrictEqual(liveAfter.items, [], 'the online session\'s live store is lowered');
    console.log('AFK hot buy store fill checks passed');
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
