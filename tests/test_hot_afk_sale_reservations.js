const assert = require('assert');
const path = require('path');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
DataCache.init();

const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const BotManager = invoke('GameServer/Bot/BotManager');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const ShoppingState = invoke('GameServer/Bot/AI/States/ShoppingState');
const TradeService = invoke('GameServer/Bot/TradeService');

// A hot bot selling loot to an AFK buy order offers only what a store sale
// may take (TradeService.previewSaleToStore): not the materials its craft
// plan reserves, not a pet-locked item.
const VARNISH = 1865;
const STEM = 1864;
const ANIMAL_BONE = 1872;
const npcTalkPath = require.resolve(path.join(__dirname, '../src/GameServer/World/Generics/NpcTalkResponse'));
require(npcTalkPath);

function item(selfId, amount, options = {}) {
    return {
        fetchId: () => 700000 + selfId,
        fetchSelfId: () => selfId,
        fetchName: () => `Item ${selfId}`,
        fetchAmount: () => amount,
        fetchEquipped: () => false,
        fetchPetLocked: () => options.petLocked === true
    };
}

const items = [item(57, 1000), item(VARNISH, 10), item(STEM, 10, { petLocked: true }), item(ANIMAL_BONE, 20)];
const bot = {
    fetchId: () => 930001,
    fetchName: () => 'HotSeller',
    fetchLocX: () => 0,
    fetchLocY: () => 0,
    fetchLocZ: () => 0,
    backpack: { fetchItems: () => items, fetchItemFromSelfId: () => null }
};
const state = {
    characterId: 930001,
    level: 30,
    inventory: { [VARNISH]: { selfId: VARNISH, amount: 10 }, [STEM]: { selfId: STEM, amount: 10 },
        [ANIMAL_BONE]: { selfId: ANIMAL_BONE, amount: 20 } },
    stats: { classId: 0, equipmentPlan: { status: 'active', strategy: 'craft',
        materials: [{ selfId: VARNISH, amount: 10 }] } }
};
const store = {
    storeType: 3,
    afkTrade: true,
    projectionObjectId: 940001,
    items: [VARNISH, STEM, ANIMAL_BONE].map((selfId) => ({ selfId, name: `Item ${selfId}`, count: 50, price: 100 }))
};
const projection = { session: { actor: { fetchName: () => 'Buyer', fetchPrivateStore: () => store } },
    actor: { fetchPrivateStore: () => store } };

const original = {
    findSessionById: BotManager.findSessionById,
    findProjection: AfkTrade.findProjection,
    sellToShop: AfkTrade.sellToShop,
    findBuyOffers: MarketOpportunity.findBuyOffers,
    scheduleRestock: ShoppingState.scheduleRestock,
    npcTalk: require.cache[npcTalkPath].exports
};

async function run() {
    const sold = [];
    BotManager.findSessionById = () => null;
    AfkTrade.findProjection = () => projection;
    AfkTrade.sellToShop = async (_sellerId, _store, selfId, qty) => {
        sold.push(selfId);
        return { totalPrice: qty * 100 };
    };
    MarketOpportunity.findBuyOffers = (selfId) => [{ sourceType: 'afk_bot_buy_store', price: 100, count: 50,
        selfId, sourceName: 'Buyer', locX: 1, locY: 2, locZ: 3, town: 'Gludio',
        projection: { actor: { fetchId: () => 940001 } } }];
    ShoppingState.scheduleRestock = () => {};
    require.cache[npcTalkPath].exports = () => {};

    const session = { shoppingTarget: { actorId: 940001 }, coldLifeState: state };
    await ShoppingState.sellAndRestock(session, bot, null, { say() {} });
    assert.deepStrictEqual(sold, [ANIMAL_BONE],
        'a hot sale to an AFK buy order must skip reserved craft materials and pet-locked items');

    // The buyer search of a shopping or companion bot weighs the same items.
    const asked = [];
    MarketOpportunity.findBuyOffers = (selfId) => {
        asked.push(selfId);
        return [{ sourceType: 'afk_bot_buy_store', price: 100, count: 50, selfId }];
    };
    const best = TradeService.findAfkBuyerForActor(bot, { name: 'Gludio' }, state);
    assert.deepStrictEqual(asked, [ANIMAL_BONE], 'the AFK buyer search must weigh only sellable items');
    assert.strictEqual(best.score, 20 * 100);

}

run().then(() => console.log('Hot AFK sale reservation checks passed'))
    .catch((error) => { console.error(error); process.exitCode = 1; })
    .finally(() => {
        BotManager.findSessionById = original.findSessionById;
        AfkTrade.findProjection = original.findProjection;
        AfkTrade.sellToShop = original.sellToShop;
        MarketOpportunity.findBuyOffers = original.findBuyOffers;
        ShoppingState.scheduleRestock = original.scheduleRestock;
        require.cache[npcTalkPath].exports = original.npcTalk;
    });
