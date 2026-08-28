const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const World = invoke('GameServer/World/World');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const TradeService = invoke('GameServer/Bot/TradeService');
const BotEquipmentUpgrade = invoke('GameServer/Bot/AI/BotEquipmentUpgrade');
const CompanionEquipmentShopping = invoke('GameServer/Bot/AI/CompanionEquipmentShopping');
const ShoppingState = invoke('GameServer/Bot/AI/States/ShoppingState');

DataCache.init();

function inventoryItem(selfId, amount, equipped = false, slot = 0) {
    const template = DataCache.items.find((item) => Number(item.selfId) === Number(selfId));
    return {
        fetchId: () => selfId + 100000,
        fetchSelfId: () => selfId,
        fetchName: () => template?.template?.name || `Item ${selfId}`,
        fetchAmount: () => amount,
        fetchEquipped: () => equipped,
        fetchSlot: () => slot,
        fetchEnchantLevel: () => 0,
        fetchRank: () => template?.etc?.rank || 'none'
    };
}

const original = {
    user: World.user,
    npc: World.npc,
    hotOffers: MarketOpportunity.hotOffers,
    npcOffers: MarketOpportunity.npcOffers,
    buyFromStore: TradeService.buyFromStore,
    applyBestUpgrades: BotEquipmentUpgrade.applyBestUpgrades,
    sellAndRestock: ShoppingState.sellAndRestock,
    scheduleRestock: ShoppingState.scheduleRestock
};

async function run() {
    let purchased = false;
    let equippedWith = null;
    let restocked = 0;
    const adena = inventoryItem(57, 100000);
    const starterSword = inventoryItem(2369, 1, true, 7);
    const items = [adena, starterSword];
    const bot = {
        fetchId: () => 920001,
        fetchName: () => 'HotShopProbe',
        fetchLevel: () => 14,
        fetchClassId: () => 0,
        fetchLocX: () => -84081,
        fetchLocY: () => 243227,
        fetchLocZ: () => -3723,
        backpack: {
            fetchItems: () => items,
            fetchItemFromSelfId: (selfId) => items.find((item) => Number(item.fetchSelfId()) === Number(selfId)) || null
        }
    };
    const npc = {
        fetchId: () => 810001,
        fetchSelfId: () => 7001,
        fetchName: () => 'Lector',
        fetchLocX: () => -86385,
        fetchLocY: () => 243267,
        fetchLocZ: () => -3717
    };
    const offer = {
        sourceType: 'npc',
        sourceId: 7001,
        sourceName: 'NPC 7001',
        town: 'Talking Island',
        selfId: 1,
        itemName: 'Short Sword',
        price: 883,
        count: Infinity,
        available: true
    };
    const session = {
        accountId: 'bot_hot_shop_probe',
        actor: bot,
        partyCompanion: true,
        coldLifeState: {
            characterId: bot.fetchId(),
            level: 14,
            stats: {
                classId: 0,
                role: 'dps',
                equipmentPlan: { status: 'no_grade_drop_only', grade: 'none', strategy: 'direct_drop' }
            },
            inventory: {}
        }
    };
    const town = { name: 'Talking Island', x: -84081, y: 243227, z: -3723 };

    World.user = { sessions: [] };
    World.npc = { spawns: [npc] };
    MarketOpportunity.hotOffers = (selfId) => Number(selfId) === 1 && !purchased ? [offer] : [];
    MarketOpportunity.npcOffers = (selfId, townName) => (
        Number(selfId) === 1 && townName === town.name ? [offer] : []
    );

    const errand = CompanionEquipmentShopping.planErrand(session, bot, town);
    assert.strictEqual(errand?.kind, 'npc_equipment_purchase',
        'a hot companion must replace a stale no-grade plan with an affordable current-town NPC upgrade');
    assert.strictEqual(errand.itemId, 1);
    assert.strictEqual(errand.slot, 7, 'the hot errand must retain its paperdoll slot for balanced multi-item shopping');
    assert.strictEqual(errand.target.actorId, npc.fetchId(),
        'the hot companion must walk to the live NPC that owns the selected shop list');
    assert.strictEqual(session.coldLifeState.stats.equipmentPlan.target.selfId, 1,
        'the refreshed hot equipment plan must be retained on the session');

    let sameTownShoppingStarted = 0;
    ShoppingState.sellAndRestock = () => { sameTownShoppingStarted++; };
    session.companionShopping = errand;
    session.shoppingTarget = errand.target;
    session.shoppingDoneAnnounced = false;
    ShoppingState.tick(session, bot, null, {
        getClosestTown: () => town,
        say() {}
    });
    assert.strictEqual(sameTownShoppingStarted, 1,
        'a hot companion already in the NPC town must shop without pathing to the NPC door');
    ShoppingState.sellAndRestock = original.sellAndRestock;

    session.companionShopping = errand;
    TradeService.buyFromStore = async (_actor, store, selfId, qty, options) => {
        assert.strictEqual(store.storeType, 1);
        assert.strictEqual(selfId, 1);
        assert.strictEqual(qty, 1);
        assert.strictEqual(options.expectedUnitPrice, 883);
        purchased = true;
        return { qty: 1, totalAdena: 883, name: 'Short Sword' };
    };
    BotEquipmentUpgrade.applyBestUpgrades = (_session, options) => {
        equippedWith = options;
        return [];
    };
    ShoppingState.scheduleRestock = () => { restocked++; };

    await ShoppingState.sellAndRestock(session, bot, null, {
        getClosestTown: () => town,
        say() {}
    });

    assert.deepStrictEqual(equippedWith, { force: true },
        'new NPC equipment must be evaluated immediately instead of waiting for the normal equipment cooldown');
    assert.strictEqual(session.coldLifeState.stats.lastMarketPurchase.sourceType, 'npc');
    assert.strictEqual(session.coldLifeState.stats.lastMarketPurchase.sourceId, 7001);
    assert.strictEqual(restocked, 1,
        'the companion should continue to normal restocking after no more current-town equipment is buyable');
    console.log('Companion equipment shopping checks passed');
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => {
    World.user = original.user;
    World.npc = original.npc;
    MarketOpportunity.hotOffers = original.hotOffers;
    MarketOpportunity.npcOffers = original.npcOffers;
    TradeService.buyFromStore = original.buyFromStore;
    BotEquipmentUpgrade.applyBestUpgrades = original.applyBestUpgrades;
    ShoppingState.sellAndRestock = original.sellAndRestock;
    ShoppingState.scheduleRestock = original.scheduleRestock;
});
