const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
DataCache.init();

const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const BotEquipmentUpgrade = invoke('GameServer/Bot/AI/BotEquipmentUpgrade');
const CompanionEquipmentShopping = invoke('GameServer/Bot/AI/CompanionEquipmentShopping');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const ShoppingState = invoke('GameServer/Bot/AI/States/ShoppingState');
const TradeService = invoke('GameServer/Bot/TradeService');

// A cold bot that wants gear may hold an AFK buy order for it. When the bot
// is hot and buys the item in town, that order must be withdrawn: an owned
// target must not keep a persistent buy order (BotAfkMarketService review),
// and a hot bot gets no review, so the order could fill with a second copy.
const SHORT_SWORD = 1;
const BOT_ID = 950001;
const bot = {
    fetchId: () => BOT_ID,
    fetchName: () => 'HotBuyer',
    fetchLocX: () => -84081,
    fetchLocY: () => 243227,
    fetchLocZ: () => -3723,
    backpack: { fetchItems: () => [], fetchItemFromSelfId: () => null }
};
const errand = () => ({
    kind: 'npc_equipment_purchase',
    itemId: SHORT_SWORD,
    itemName: 'Short Sword',
    price: 883,
    sourceId: 7001,
    slot: 7,
    target: { town: 'Talking Island', name: 'Lector' }
});

const original = {
    ownerRecords: AfkTrade.ownerRecords,
    closeBotRecord: AfkTrade.closeBotRecord,
    npcOffers: MarketOpportunity.npcOffers,
    buyFromStore: TradeService.buyFromStore,
    applyBestUpgrades: BotEquipmentUpgrade.applyBestUpgrades,
    planErrand: CompanionEquipmentShopping.planErrand,
    scheduleRestock: ShoppingState.scheduleRestock
};

async function buyWithOrderFor(orderItemId) {
    const stopped = [];
    AfkTrade.ownerRecords = (ownerId) => Number(ownerId) === BOT_ID
        ? [{ id: 21, kind: 'buy_ad', storeType: AfkTrade.BUY, ownerAccount: 'bot_hot_buyer', revision: 1,
            lines: [{ selfId: orderItemId, count: 1, price: 750 }] }] : [];
    AfkTrade.closeBotRecord = async (ownerId) => { stopped.push(Number(ownerId)); return { closed: true }; };
    const session = { companionShopping: errand(), coldLifeState: { characterId: BOT_ID, stats: {} } };
    await ShoppingState.sellAndRestock(session, bot, null, { getClosestTown: () => null, say() {} });
    assert.strictEqual(session.coldLifeState.stats.lastMarketPurchase.selfId, SHORT_SWORD, 'the purchase must complete');
    return stopped;
}

async function run() {
    MarketOpportunity.npcOffers = () => [{ sourceType: 'npc', sourceId: 7001, price: 883, available: true }];
    TradeService.buyFromStore = async () => ({ qty: 1, totalAdena: 883, name: 'Short Sword' });
    BotEquipmentUpgrade.applyBestUpgrades = () => [];
    CompanionEquipmentShopping.planErrand = () => null;
    ShoppingState.scheduleRestock = () => {};

    assert.deepStrictEqual(await buyWithOrderFor(SHORT_SWORD), [BOT_ID],
        'a hot purchase of the item must withdraw the bot\'s buy order for it');
    assert.deepStrictEqual(await buyWithOrderFor(SHORT_SWORD + 1), [],
        'a buy order for another item stays');
}

run().then(() => console.log('Hot purchase buy order checks passed'))
    .catch((error) => { console.error(error); process.exitCode = 1; })
    .finally(() => {
        AfkTrade.ownerRecords = original.ownerRecords;
        AfkTrade.closeBotRecord = original.closeBotRecord;
        MarketOpportunity.npcOffers = original.npcOffers;
        TradeService.buyFromStore = original.buyFromStore;
        BotEquipmentUpgrade.applyBestUpgrades = original.applyBestUpgrades;
        CompanionEquipmentShopping.planErrand = original.planErrand;
        ShoppingState.scheduleRestock = original.scheduleRestock;
    });
