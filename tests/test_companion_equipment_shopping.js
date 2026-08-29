const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const World = invoke('GameServer/World/World');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const TradeService = invoke('GameServer/Bot/TradeService');
const BotEquipmentUpgrade = invoke('GameServer/Bot/AI/BotEquipmentUpgrade');
const CompanionEquipmentShopping = invoke('GameServer/Bot/AI/CompanionEquipmentShopping');
const CompanionNavigationRecovery = invoke('GameServer/Bot/AI/CompanionNavigationRecovery');
const TownNpcApproach = invoke('GameServer/Bot/AI/TownNpcApproach');
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
    const moves = [];
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
        moveTo: (data) => { moves.push(data); },
        state: {
            inMotion: () => false,
            fetchTowards: () => false
        },
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
        fetchLocZ: () => -3717,
        fetchHead: () => 52000
    };
    const alternateNpc = {
        fetchId: () => 810002,
        fetchSelfId: () => 7002,
        fetchName: () => 'Jackson',
        fetchLocX: () => -86328,
        fetchLocY: () => 244438,
        fetchLocZ: () => -3717,
        fetchHead: () => 61440
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
    const alternateOffer = {
        ...offer,
        sourceId: 7002,
        sourceName: 'Jackson',
        price: 900,
        locX: -86328,
        locY: 244438,
        locZ: -3717
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
    World.npc = { spawns: [npc, alternateNpc] };
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

    MarketOpportunity.npcOffers = (selfId, townName) => (
        Number(selfId) === 1 && townName === town.name ? [offer, alternateOffer] : []
    );
    const alternateErrand = CompanionEquipmentShopping.alternateNpcErrand(session, bot, town, errand);
    assert.strictEqual(alternateErrand?.sourceId, 7002,
        'an unreachable equipment seller must be replaced by another current-town NPC carrying the same item');
    assert.strictEqual(alternateErrand.target.actorId, alternateNpc.fetchId(),
        'the replacement errand must route to the alternate live NPC');
    assert.deepStrictEqual(alternateErrand.failedSourceIds, [7001],
        'the failed NPC must stay excluded from later route replans');

    let sameTownShoppingStarted = 0;
    ShoppingState.sellAndRestock = () => { sameTownShoppingStarted++; };
    session.companionShopping = errand;
    session.shoppingTarget = errand.target;
    session.shoppingDoneAnnounced = false;
    ShoppingState.tick(session, bot, null, {
        getClosestTown: () => town,
        say() {}
    });
    assert.strictEqual(sameTownShoppingStarted, 0,
        'being in the same town must not complete a purchase before the companion reaches the NPC');
    assert.strictEqual(moves.length, 1, 'a hot companion must request a real route to the selected NPC');
    const lectorApproach = TownNpcApproach.pointsFor(errand.target);
    assert.strictEqual(moves[0].arrivalRadius, TownNpcApproach.STAGING_ARRIVAL_RADIUS,
        'the first NPC route should stop at the street-side staging point');
    assert.deepStrictEqual(
        { locX: moves[0].to.locX, locY: moves[0].to.locY, locZ: moves[0].to.locZ },
        lectorApproach.staging,
        'the hot companion must approach the side the shopkeeper faces instead of the nearest wall'
    );
    assert.strictEqual(moves[0].pathMaxNodes, CompanionNavigationRecovery.INITIAL_ERRAND_PATH_MAX_NODES,
        'the first NPC route must use the inexpensive town-errand search budget');
    assert.strictEqual(moves[0].targetActor, null,
        'the static approach waypoint must not be overwritten with the exact NPC cell');
    session.lastPathfinding = {
        requestedTo: { ...moves[0].to },
        routeUsable: false,
        at: Date.now()
    };
    ShoppingState.tick(session, bot, null, {
        getClosestTown: () => town,
        say() {}
    });
    ShoppingState.tick(session, bot, null, {
        getClosestTown: () => town,
        say() {}
    });
    assert.deepStrictEqual(
        { locX: moves[1].to.locX, locY: moves[1].to.locY, locZ: moves[1].to.locZ },
        lectorApproach.interaction,
        'an unreachable outer waypoint must fall back to the inner front-side point, not the NPC cell'
    );
    assert.strictEqual(moves[1].pathMaxNodes, CompanionNavigationRecovery.INITIAL_ERRAND_PATH_MAX_NODES,
        'the inner front-side fallback should start with the inexpensive route budget');
    ShoppingState.sellAndRestock = original.sellAndRestock;

    CompanionNavigationRecovery.clear(session);
    session.companionShopping = { kind: 'sell_junk', target: errand.target };
    session.shoppingTarget = errand.target;
    TownNpcApproach.reset(session);
    TownNpcApproach.plan(session, bot, session.shoppingTarget, 'shopping');
    TownNpcApproach.skipStaging(session);
    for (let attempt = 0; attempt < CompanionNavigationRecovery.MAX_ROUTE_FAILURES; attempt++) {
        const failedApproach = TownNpcApproach.plan(session, bot, session.shoppingTarget, 'shopping');
        session.lastPathfinding = {
            requestedTo: { ...failedApproach.destination },
            routeUsable: false,
            at: Date.now() + attempt + 10
        };
        ShoppingState.tick(session, bot, null, {
            getClosestTown: () => town,
            say() {}
        });
        if (session.companionNavigationRecovery) session.companionNavigationRecovery.retryAt = 0;
    }
    assert.notStrictEqual(session.shoppingTarget.npcSelfId, 7001,
        'junk selling must exclude an unreachable NPC and select another physical town merchant');
    assert.deepStrictEqual(session.companionShopping.failedSourceIds, [7001],
        'generic town errands must retain failed NPC sources across route replans');

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
