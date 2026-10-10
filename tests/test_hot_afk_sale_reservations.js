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

// The hot seller stands in Gludio: since 71143511 an ad is answered only over
// a known trip from the bot's own location; since 5e91bb1c the main thread
// reads that trip from routes the coordinator prepared (here, synchronously).
const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const EconomicTrip = invoke('GameServer/Bot/Economy/EconomicTrip');
function preparedRoutes(routeState) {
    const steps = EconomicTrip.prepare(routeState);
    let step;
    do { step = steps.next(); } while (!step.done);
    return step.value;
}
const GLUDIO = { locX: -14225, locY: 123540, locZ: -3121 };
const items = [item(57, 1000), item(VARNISH, 10), item(STEM, 10, { petLocked: true }), item(ANIMAL_BONE, 20)];
const bot = {
    fetchId: () => 930001,
    fetchName: () => 'HotSeller',
    fetchLocX: () => GLUDIO.locX,
    fetchLocY: () => GLUDIO.locY,
    fetchLocZ: () => GLUDIO.locZ,
    backpack: { fetchItems: () => items, fetchItemFromSelfId: () => null }
};
const state = {
    characterId: 930001,
    level: 30,
    loc: { ...GLUDIO },
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
    routeRows: Coordinator.routeRows,
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
    Coordinator.routeRows = preparedRoutes;
    require.cache[npcTalkPath].exports = () => {};

    const session = { shoppingTarget: { actorId: 940001 }, coldLifeState: state };
    await ShoppingState.sellAndRestock(session, bot, null, { say() {} });
    assert.deepStrictEqual(sold, [ANIMAL_BONE],
        'a hot sale to an AFK buy order must skip reserved craft materials and pet-locked items');

    // The bot sells what its decision chose for the record, no more.
    const limited = [];
    AfkTrade.sellToShop = async (_sellerId, _store, selfId, qty) => {
        limited.push([selfId, qty]);
        return { totalPrice: qty * 100 };
    };
    await ShoppingState.sellAndRestock({ shoppingTarget: { actorId: 940001, sale: { [ANIMAL_BONE]: 5 } }, coldLifeState: state },
        bot, null, { say() {} });
    assert.deepStrictEqual(limited, [[ANIMAL_BONE, 5]], 'the decided units only');

    // The buyer search of a shopping or companion bot weighs the same items,
    // by the cold bots' sale decision: buy ads in Gludio for all three, the
    // reserved varnish and the pet-locked stems paying the most.
    [[VARNISH, 10000], [STEM, 10000], [ANIMAL_BONE, 3000]].forEach(([selfId, price], index) => AfkTrade.refreshRecord({
        id: 941001 + index, ownerId: 941000 + index, ownerName: 'Buyer', ownerAccount: `bot_${941000 + index}`, kind: 'buy_ad',
        storeType: AfkTrade.BUY, status: 'active', town: 'Gludio', title: '', revision: 1, expiresAt: 0,
        locX: 1, locY: 2, locZ: 3, appearance: {},
        lines: [{ id: 9410010 + index, selfId, name: `Item ${selfId}`, count: 50, price, enchant: 0 }] }));
    try {
        const best = TradeService.findAfkBuyerForActor(bot, { name: 'Gludio' }, state, { now: 1800000000000 });
        assert.deepStrictEqual(best?.sale, { [ANIMAL_BONE]: 20 }, 'the AFK buyer search must weigh only sellable items');
        assert.strictEqual(best.score, 20 * 3000);
    } finally {
        AfkTrade._resetForTests();
    }

}

run().then(() => console.log('Hot AFK sale reservation checks passed'))
    .catch((error) => { console.error(error); process.exitCode = 1; })
    .finally(() => {
        BotManager.findSessionById = original.findSessionById;
        AfkTrade.findProjection = original.findProjection;
        AfkTrade.sellToShop = original.sellToShop;
        MarketOpportunity.findBuyOffers = original.findBuyOffers;
        ShoppingState.scheduleRestock = original.scheduleRestock;
        Coordinator.routeRows = original.routeRows;
        require.cache[npcTalkPath].exports = original.npcTalk;
    });
