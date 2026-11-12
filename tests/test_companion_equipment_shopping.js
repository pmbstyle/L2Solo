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
const BotSkillTraining = invoke('GameServer/Bot/BotSkillTraining');
const NpcRestock = invoke('GameServer/Bot/Economy/NpcRestockPlan');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');

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
    bestOffer: MarketOpportunity.bestOffer,
    npcOffers: MarketOpportunity.npcOffers,
    buyFromStore: TradeService.buyFromStore,
    npcPurchase: NpcRestock.purchaseForActor,
    hotRow: LifeState.hotRow,
    applyBestUpgrades: BotEquipmentUpgrade.applyBestUpgrades,
    sellAndRestock: ShoppingState.sellAndRestock,
    scheduleRestock: ShoppingState.scheduleRestock,
    skillReview: BotSkillTraining.review
};

// A hot body's refused quote (GearMarks) lives on its session; its cached row keeps the
// activation snapshot. Its next errand, through the real offer query, skips the quote it
// was refused and only that one, at a board stall or a player's live store, as a cold buyer does.
function hotQuoteAdmission(bot, town) {
    const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
    const TownTransitPolicy = invoke('GameServer/Bot/AI/TownTransitPolicy');
    const DecisionEvents = invoke('GameServer/Bot/AI/DecisionEvents');
    const { BoardIndex, offerFields } = require('../src/GameServer/AfkTrade/BoardIndex');
    const saved = { boardIndex: AfkTrade.boardIndex, offerOf: AfkTrade.offerOf, townAt: TownTransitPolicy.townAt,
        registered: World.registeredActorById, cachedState: LifeState.cachedState, user: World.user };
    try {
        const id = 920003;
        const body = { ...bot, fetchId: () => id, fetchName: () => 'HotQuoteProbe' };
        const activation = { characterId: id, phase: 'hot', level: 14, simulation: { revision: 1 }, inventory: {},
            stats: { classId: 0, role: 'dps', money: [77000, 2e-5, 15000, 0, 2e-5, 500, 1] } };
        let row = activation;
        const session = { accountId: 'bot_hot_quote_probe', actor: body, plan: 'shopping', partyCompanion: false,
            coldLifeState: activation,
            heldEconomy: { decided: true, inputHash: 3, worth: () => 1000,
                network: { activity: { activity: 'shopping', itemId: 1, amount: 1 } } } };
        body.session = session;
        LifeState.cachedState = characterId => Number(characterId) === id ? row : null;
        World.registeredActorById = characterId => Number(characterId) === id ? body : null;
        const board = new BoardIndex();
        board.put({ id: 1, kind: 'shop', storeType: 1, ownerId: 9001, town: town.name, botOwned: true,
            lines: [{ lineId: 11, selfId: 1, count: 1, price: 600 }] });
        board.put({ id: 2, kind: 'shop', storeType: 1, ownerId: 9002, town: town.name, botOwned: true,
            lines: [{ lineId: 21, selfId: 1, count: 1, price: 700 }] });
        AfkTrade.boardIndex = () => board;
        AfkTrade.offerOf = (line, at) => ({ ...offerFields(line, at), available: true });
        World.user = { sessions: [] };
        const plan = () => CompanionEquipmentShopping.planErrand(session, body, town);
        assert.strictEqual(plan()?.price, 600, 'fixture: the cheapest stall is planned first');

        // The seller refused the 600 quote (ShoppingState.equipmentPurchaseFailed's raise).
        const refuse = price => DecisionEvents.raiseDecision(session, 'goal_failed', { impossible: true,
            payload: { kind: 'gear_errand', key: 1, town: town.name, price, reason: 'afk_trade_shop_unavailable' } });
        refuse(600);
        assert.strictEqual(row.stats.gearMarks, undefined, 'fixture: the cached row keeps its activation snapshot');
        const next = plan();
        assert.strictEqual(next?.price, 700, 'a hot body refused at a stall plans the next one, not the same quote or none');
        assert.strictEqual(next.sourceId, 9002);

        // A player's live store refused its 650 quote: not planned again (the row marks it too,
        // so only the live store's admission decides).
        const seller = { fetchId: () => 990010, fetchName: () => 'LiveSeller', fetchLocX: () => -84000, fetchLocY: () => 243200,
            fetchLocZ: () => -3723, fetchIsOnline: () => true, isDead: () => false, fetchPrivateStoreType: () => 1,
            fetchPrivateStore: () => ({ kind: 'player', storeType: 1, items: [{ selfId: 1, count: 1, price: 650, objectId: 77 }] }) };
        World.user = { sessions: [{ accountId: 'live_seller', actor: seller }] };
        TownTransitPolicy.townAt = actor => actor === seller ? town.name : saved.townAt(actor);
        assert.strictEqual(plan()?.sourceType, 'private_store', 'fixture: the live store is the cheapest offer left');
        refuse(650);
        row = { ...activation, stats: { ...activation.stats, gearMarks: DecisionEvents.statsFor(session).gearMarks } };
        const afterLive = plan();
        assert.strictEqual(afterLive?.price, 700, 'a refused live store quote is not planned again; the next stall is');
        assert.strictEqual(afterLive.sourceType, 'afk_bot_store');

        // A mark the body forgot (LIFETIME) no longer hides the stall, though the row still has it.
        World.user = { sessions: [] };
        row = { ...activation, stats: { ...activation.stats, gearMarks: [{ key: 1, town: town.name, price: 600 }] } };
        session.coldLifeState = { ...session.coldLifeState, stats: { ...session.coldLifeState.stats, gearMarks: [] } };
        assert.strictEqual(plan()?.price, 600, 'a quote mark the body forgot no longer hides that stall');
    } finally {
        AfkTrade.boardIndex = saved.boardIndex; AfkTrade.offerOf = saved.offerOf; TownTransitPolicy.townAt = saved.townAt;
        World.registeredActorById = saved.registered; LifeState.cachedState = saved.cachedState; World.user = saved.user;
    }
}

async function run() {
    BotSkillTraining.review = async () => null;
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
        fetchSp: () => 0,
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
                money: [77000, 2e-5, 15000, 1200000, 4e-5, 20000, 1463],
                equipmentPlan: { status: 'no_grade_drop_only', grade: 'none', strategy: 'direct_drop' }
            },
            inventory: {}
        }
    };
    const town = { name: 'Talking Island', x: -84081, y: 243227, z: -3723 };

    hotQuoteAdmission(bot, town);
    World.user = { sessions: [] };
    World.npc = { spawns: [npc, alternateNpc] };
    MarketOpportunity.bestOffer = (selfId, options = {}) => Number(selfId) === 1 && !purchased
        && options.budget >= offer.price && (!options.accept || options.accept(offer)) ? offer : null;
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

    const genericMoves = [];
    const genericBot = {
        ...bot,
        fetchId: () => 920002,
        fetchName: () => 'GenericHotShopProbe',
        moveTo: (data) => { genericMoves.push(data); }
    };
    const afkSellerActor = {
        fetchId: () => 990001,
        fetchName: () => 'PlayerAfkSeller',
        fetchLocX: () => -85000,
        fetchLocY: () => 243250,
        fetchLocZ: () => -3723
    };
    const afkSellerSession = { accountId: 'afk_trade_player', actor: afkSellerActor };
    const genericSession = {
        accountId: 'bot_generic_hot_shop_probe',
        actor: genericBot,
        plan: 'shopping',
        partyCompanion: false,
        coldLifeState: {
            characterId: genericBot.fetchId(),
            level: 14,
            stats: {
                classId: 0,
                role: 'dps',
                equipmentPlan: {
                    status: 'active',
                    strategy: 'market',
                    target: { selfId: 1, name: 'Short Sword', slot: 7 }
                }
            },
            inventory: {}
        }
    };
    // The near decision the background thread sends this body (the
    // coordinator's economy_decided -> DecisionEvents.receive): a shopping leaf.
    const decision = { decided: true, inputHash: 1, worth: () => 1000,
        network: { activity: { activity: 'shopping', itemId: 1, amount: 1 } } };
    genericSession.coldLifeState.stats.money = [77000, 2e-5, 15000, 0, 2e-5, 500, 1];
    let genericMarketLookups = 0;
    MarketOpportunity.bestOffer = (selfId, options = {}) => {
        genericMarketLookups += 1;
        assert.strictEqual(options.budget, 1000, 'a funded autonomous shopping leaf uses its item ratio and worth cap');
        return Number(selfId) === 1 ? {
            sourceType: 'afk_player_store',
            sourceId: afkSellerActor.fetchId(),
            sourceName: afkSellerActor.fetchName(),
            town: town.name,
            selfId: 1,
            itemName: 'Short Sword',
            price: 500,
            count: 1,
            available: true,
            session: afkSellerSession
        } : null;
    };
    World.user = { sessions: [afkSellerSession] };
    const heldPlan = genericSession.coldLifeState.stats.equipmentPlan;
    ShoppingState.tick(genericSession, genericBot, null, { getClosestTown: () => town, say() {} });
    assert.strictEqual(genericSession.shoppingEquipmentPlanChecked, undefined,
        'a visit before the first decision is not a completed town visit check');
    assert.strictEqual(genericSession.coldLifeState.stats.equipmentPlan, heldPlan,
        'waiting for the first decision preserves the accepted equipment plan');
    assert.strictEqual(genericSession.plan, 'shopping', 'waiting for the first decision does not end the visit');
    assert.strictEqual(genericMarketLookups, 0);
    genericSession.heldEconomy = decision;
    ShoppingState.tick(genericSession, genericBot, null, {
        getClosestTown: () => town,
        say() {}
    });
    assert.strictEqual(genericSession.companionShopping?.kind, 'market_purchase',
        'a generic hot bot must turn its active equipment plan into an AFK market errand');
    assert.strictEqual(genericSession.shoppingTarget?.actorId, afkSellerActor.fetchId());
    assert.strictEqual(genericMarketLookups, 1,
        'the hot visit should reuse one indexed lookup for plan validation and offer selection');
    ShoppingState.tick(genericSession, genericBot, null, {
        getClosestTown: () => town,
        say() {}
    });
    assert.strictEqual(genericMarketLookups, 1, 'later movement ticks must not rescan the market');
    assert(genericMoves.length >= 1, 'the generic hot bot must route to the AFK seller');

    const nonWish = { ...genericSession, companionShopping: null, coldLifeState: { ...genericSession.coldLifeState,
        stats: { ...genericSession.coldLifeState.stats, money: [77000, 2e-5, 15000, 1200000, 4e-5, 20000, 1463] } } };
    MarketOpportunity.bestOffer = (_itemId, options = {}) => options.budget >= 500 ? { ...offer, price: 500 } : null;
    assert.strictEqual(CompanionEquipmentShopping.planErrand(nonWish, genericBot, town), null,
        'an autonomous bot cannot spend its earmarked money on an item absent from the packet');

    // One item in two slots: two funded roots of one value per Adena. The hot body budgets its
    // leaf from its own slot's row, as the cold buyer does: the second slot after the first's money.
    const Packet = invoke('GameServer/Bot/Economy/StatsPacket');
    const slots = Packet.money({ hourAdena: 77000, moneyPrice: 2e-5, refillReserve: 15000, firstUnfundedPrice: 0 });
    Packet.addFunded(slots, 4e-5, 100, 1, Packet.MONEY_ROWS, 'power:1:1');
    Packet.addFunded(slots, 4e-5, 600, 1, Packet.MONEY_ROWS, 'power:1:2');
    const slotBudget = rootKey => {
        let budget = null;
        MarketOpportunity.bestOffer = (_itemId, options = {}) => { budget = options.budget; return null; };
        CompanionEquipmentShopping.planErrand({ ...genericSession, companionShopping: null,
            heldEconomy: { decided: true, inputHash: 2, worth: () => 1e9, statsPacket: { money: slots },
                network: { activity: { activity: 'shopping', itemId: 1, amount: 1, r: 4e-5, rootKey } } } }, genericBot, town);
        return budget;
    };
    const first = slotBudget('power:1:1'), second = slotBudget('power:1:2');
    assert(first > 100, 'fixture: the first slot can spend');
    assert.strictEqual(first - second, 100, 'the second slot budgets after the first slot\'s row');

    World.user = { sessions: [] };
    MarketOpportunity.bestOffer = (selfId, options = {}) => Number(selfId) === 1 && !purchased
        && (!options.accept || options.accept(offer)) ? offer : null;

    let sameTownShoppingStarted = 0;
    ShoppingState.sellAndRestock = () => { sameTownShoppingStarted++; };
    session.companionShopping = errand;
    LifeState.hotRow = () => ({ phase: 'hot' });
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
        TownNpcApproach.talkPointFor(errand.target, bot.fetchId()),
        'an unreachable outer waypoint must fall back to the bot\'s own front-side point, not the NPC cell'
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
    NpcRestock.purchaseForActor = async (_actor, options) => {
        assert.strictEqual(options.seller.sourceId, 7001);
        assert.strictEqual(options.extras[0].selfId, 1);
        assert.strictEqual(options.extras[0].amount, 1);
        assert.strictEqual(options.extras[0].offer.price, 883);
        purchased = true;
        return { ok: true, receipts: [{ lines: [{ selfId: 1, amount: 1, unitPrice: 883 }] }] };
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
    session.companionShopping = errand;
    equippedWith = null;
    NpcRestock.purchaseForActor = async () => {
        session.actor = { fetchId: bot.fetchId };
        return { ok: true, receipts: [{ hot: false, lines: [{ selfId: 1, amount: 1, unitPrice: 883 }] }] };
    };
    await ShoppingState.sellAndRestock(session, bot, null, { getClosestTown: () => town, say() {} });
    assert.strictEqual(equippedWith, null, 'paid receipt cannot mutate the actor replaced during the NPC await');
    assert.strictEqual(restocked, 1, 'a replaced actor cannot continue the old shopping callback');
    console.log('Companion equipment shopping checks passed');
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => {
    World.user = original.user;
    World.npc = original.npc;
    MarketOpportunity.bestOffer = original.bestOffer;
    MarketOpportunity.npcOffers = original.npcOffers;
    TradeService.buyFromStore = original.buyFromStore;
    NpcRestock.purchaseForActor = original.npcPurchase;
    LifeState.hotRow = original.hotRow;
    BotEquipmentUpgrade.applyBestUpgrades = original.applyBestUpgrades;
    ShoppingState.sellAndRestock = original.sellAndRestock;
    ShoppingState.scheduleRestock = original.scheduleRestock;
    BotSkillTraining.review = original.skillReview;
});
