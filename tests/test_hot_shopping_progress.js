const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
require('../src/Global');

const Events = invoke('GameServer/Bot/AI/DecisionEvents');
Events.held = () => ({});
Events.raiseDecision = () => {};
const Shopping = invoke('GameServer/Bot/AI/States/ShoppingState');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Meetings = invoke('GameServer/AfkTrade/TradeMeetingService');
const Shots = invoke('GameServer/Inventory/ShotStock');
const Restock = invoke('GameServer/Bot/Economy/NpcRestockPlan');
const Potions = invoke('GameServer/Bot/AI/HealingPotionStock');
const Rebuff = invoke('GameServer/Bot/AI/HotTownRebuff');
const Improvements = invoke('GameServer/Bot/Economy/BotImprovementService');
const Chatter = invoke('GameServer/Bot/AI/TownChatter');
const Journal = invoke('GameServer/Bot/AI/BotEventJournal');
const Safety = invoke('GameServer/Bot/AI/BotRaidSafety');
const Warehouse = invoke('GameServer/Bot/Economy/BotWarehouseService');
const Market = invoke('GameServer/Bot/Economy/MarketOpportunity');
const world = invoke('GameServer/World/World');

let now = Date.now(), serial = 0, current, prepared = false, purchases = 0, failures = 0;
const timers = new Map();
const original = { now: Date.now, setTimeout, clearTimeout, clearInterval };
const ai = { getClosestTown: () => ({ name: 'Gludio' }), say() {} };
const target = { locX: -14590, locY: 123360, locZ: -3112, town: 'Gludio' };
const bot = { fetchId: () => 920081, fetchName: () => 'ShopProgress', fetchClassId: () => 1,
    fetchLevel: () => 24, fetchLocX: () => -12736, fetchLocY: () => 122816, fetchLocZ: () => -3112,
    isDead: () => false, state: { fetchTowards: () => false, inMotion: () => false },
    backpack: { fetchItemFromSelfId: () => ({ fetchAmount: () => 1000 }), fetchItems: () => [] },
    automation: { abortAll() {} }, moveTo() { this.moves++; }, moves: 0 };

Life.cachedState = () => current;
Life.hotRow = () => ({ characterId: bot.fetchId(), phase: 'hot' });
Meetings.hasPreparation = () => prepared;
Improvements.chosen = () => null;
Shots.liveRestockTarget = () => null;
Shots.planForActor = () => ({ selfId: 1835, name: 'Soulshot: No Grade' });
Shots.purchaseActorRestock = async () => ({ ok: true, delta: 0, cost: 0 });
Restock.quoteFor = () => ({ price: 1 });
Restock.purchaseForActor = async () => ({ ok: ++purchases > failures, receipts: [] });
Potions.purchasePotionFor = () => ({ selfId: 1060, name: 'Healing Potion' });
Potions.localNpcPrice = () => 1;
Potions.operationalReserve = () => 0;
Rebuff.syncVisit = () => null;
Rebuff.needsVisit = () => false;
Chatter.say = () => {};
Journal.record = () => {};
world.user = { sessions: [] };

async function elapse(ms) {
    const until = now + ms;
    for (;;) {
        const next = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]); now = next[1].at;
        await next[1].fn();
    }
    now = until;
}

async function run() {
    try {
        Date.now = () => now;
        global.setTimeout = (fn, ms) => { const id = ++serial; timers.set(id, { fn, at: now + ms }); return id; };
        global.clearTimeout = global.clearInterval = id => timers.delete(id);
        const live = { characterId: bot.fetchId(), phase: 'hot', stats: {} };
        const stale = { ...live, stats: { tradeMeeting: [12941, 1, 'Gludio', -12736, 122816, -3114] } };
        const session = { actor: bot, plan: 'shopping', shoppingTarget: target, shoppingWarehouseDone: true,
            companionShopping: { kind: 'restock_shots', target }, coldLifeState: stale };
        current = live;
        Shopping.tick(session, bot, null, ai);
        assert.equal(bot.moves, 1, 'a completed meeting in an old session copy must not stop the actual shop route');
        bot.moves = 0;
        current = stale;
        Shopping.tick(session, bot, null, ai);
        assert.equal(bot.moves, 0, 'current native custody must still block ordinary shopping');
        current = null;
        Shopping.tick(session, bot, null, ai);
        assert.equal(bot.moves, 0, 'without a lifecycle cache, the inherited meeting must still be respected');
        current = live; prepared = true;
        Shopping.tick(session, bot, null, ai);
        assert.equal(bot.moves, 0, 'a meeting preparation still owns the actor before its durable marker arrives');
        prepared = false;

        // A refused restock is tried again at once (its purchase waits its counter delay)
        // until it succeeds or its attempts run out; then the bot leaves for its hunt.
        for (const failedPurchases of [1, 3]) {
            failures = failedPurchases; purchases = 0;
            const visit = { actor: bot, plan: 'shopping', shoppingTarget: target,
                shoppingDoneAnnounced: true, dataSendToOthers() {} };
            Shopping.scheduleRestock(visit, bot, null, ai);
            for (let attempt = 0; attempt < 5 && visit.plan === 'shopping'; attempt++) {
                await elapse(9000);
                Shopping.tick(visit, bot, null, ai);
            }
            assert.equal(purchases, failedPurchases === 1 ? 2 : 3);
            assert.equal(visit.plan, 'hunting', 'success or the last failed attempt must release the farming continuation');
            assert.equal(visit.shoppingDoneAnnounced, false);
            assert.equal(visit.pendingFarmDepartureAnnouncement, true);
            assert.equal(timers.size, 0, 'no purchase is left behind');
        }
        // A meeting preparation that took the bot during a refused restock owns it: the
        // visit ends with no second purchase.
        failures = 3; purchases = 0;
        const held = { actor: bot, plan: 'shopping', shoppingTarget: target, shoppingDoneAnnounced: true, dataSendToOthers() {} };
        Shopping.scheduleRestock(held, bot, null, ai);
        prepared = true;
        await elapse(9000);
        prepared = false;
        assert.equal(purchases, 1, 'meeting preparation blocks a restock retry');
        assert.equal(held.plan, 'hunting');
        assert.equal(timers.size, 0);

        let raid = null;
        Safety.syncPlayerPartyRaid = () => raid;
        const leader = { actor: { fetchIsOnline: () => true,
            fetchLocX: bot.fetchLocX, fetchLocY: bot.fetchLocY, fetchLocZ: bot.fetchLocZ } };
        const companion = kind => ({ actor: bot, plan: 'shopping', partyCompanion: true,
            followPlayerSession: leader, shoppingTarget: target, shoppingWarehouseDone: true,
            companionShopping: { kind, target } });
        const cancelForRaid = visit => {
            raid = { phase: 'combat' };
            Shopping.tick(visit, bot, null, ai);
            assert.equal(visit.plan, 'following');
            raid = null;
        };

        // A private improvement must not replace a companion's explicit errand.
        let improvements = 0;
        Improvements.chosen = () => ({ kind: 'crystallize' });
        Improvements.stationTarget = () => ({ ...target, name: 'Smith' });
        Improvements.reviewHot = () => { improvements++; return Promise.resolve(true); };
        const restockVisit = companion('restock_shots');
        Shopping.tick(restockVisit, bot, null, ai);
        assert.equal(restockVisit.shoppingTarget, target);
        assert.equal(improvements, 0, 'a restock errand cannot turn into a private improvement');

        // An improvement started before joining a party cannot restore a solo plan
        // after the commander's raid has taken over the actor.
        invoke('GameServer/Bot/AI/TownNpcApproach').plan = () => ({ ready: true });
        let finishImprovement;
        Improvements.reviewHot = () => new Promise(resolve => { finishImprovement = resolve; });
        const improvementVisit = { actor: bot, plan: 'shopping', shoppingWarehouseDone: true };
        Shopping.tick(improvementVisit, bot, null, ai);
        assert.equal(typeof finishImprovement, 'function');
        improvementVisit.partyCompanion = true;
        improvementVisit.followPlayerSession = leader;
        cancelForRaid(improvementVisit);
        finishImprovement(true);
        await Promise.resolve();
        assert.equal(improvementVisit.plan, 'following', 'an old improvement must not return the companion to solo hunting');
        assert.equal(improvementVisit.shoppingTarget, undefined);

        // A board transaction can finish after cancellation; it must not start the
        // next NPC purchase or affect a later visit, even if shopping has resumed.
        let finishBoard;
        Shots.purchaseActorRestock = () => new Promise(resolve => { finishBoard = resolve; });
        purchases = 0;
        const boardVisit = companion('restock_shots');
        Shopping.scheduleRestock(boardVisit, bot, null, ai);
        const purchaseTimer = [...timers.entries()].find(([, timer]) => timer.at === now + 4000);
        timers.delete(purchaseTimer[0]);
        const boardWork = purchaseTimer[1].fn();
        await Promise.resolve();
        assert.equal(typeof finishBoard, 'function');
        cancelForRaid(boardVisit);
        boardVisit.plan = 'shopping';
        boardVisit.companionShopping = { kind: 'restock_shots', target };
        boardVisit.shoppingTarget = target;
        Shopping.scheduleRestock(boardVisit, bot, null, ai);
        const replacement = boardVisit.shoppingRestock;
        finishBoard({ ok: true, delta: 0, cost: 0 });
        await boardWork;
        assert.equal(purchases, 0, 'a cancelled restock cannot issue another purchase');
        assert.equal(boardVisit.shoppingRestock, replacement, 'the old restock cannot change the new visit');
        cancelForRaid(boardVisit);
        await elapse(9000);
        assert.equal(timers.size, 0);

        // An equipment purchase already in flight must not create a stale restock
        // promise that would block the companion's next personal visit.
        Improvements.chosen = () => null;
        invoke('GameServer/Bot/Economy/BotAfkMarketService').freeStepBids = async () => {};
        const offer = { sourceId: 123, price: 10, town: 'Gludio', itemName: 'Sword' };
        Market.npcOffers = () => [offer];
        let finishEquipment;
        Restock.purchaseForActor = () => new Promise(resolve => { finishEquipment = resolve; });
        const gearVisit = companion('npc_equipment_purchase');
        Object.assign(gearVisit.companionShopping, { itemId: 1, sourceId: 123, price: 10 });
        const gearWork = Shopping.sellAndRestock(gearVisit, bot, null, ai);
        await Promise.resolve();
        await Promise.resolve();
        assert.equal(typeof finishEquipment, 'function');
        cancelForRaid(gearVisit);
        finishEquipment({ ok: false, receipts: [] });
        await gearWork;
        assert.equal(gearVisit.shoppingRestock, undefined);
        assert.equal(timers.size, 0, 'a cancelled equipment errand cannot schedule another town task');
        Shopping.scheduleRestock(gearVisit, bot, null, ai);
        assert.equal(timers.size, 0, 'a following companion cannot start a personal restock');

        // A late warehouse receipt cannot clear the target or phase of a new visit.
        let finishWarehouse;
        Warehouse.depositActorAtWarehouse = () => new Promise(resolve => { finishWarehouse = resolve; });
        const warehouseVisit = companion('sell_junk');
        warehouseVisit.shoppingServicePhase = 'warehouse';
        const warehouseWork = Shopping.depositAtWarehouse(warehouseVisit, bot, null, ai, target);
        cancelForRaid(warehouseVisit);
        const nextTarget = { ...target, name: 'New merchant' };
        warehouseVisit.plan = 'shopping';
        warehouseVisit.companionShopping = { kind: 'restock_shots', target: nextTarget };
        warehouseVisit.shoppingTarget = nextTarget;
        warehouseVisit.shoppingServicePhase = 'merchant';
        finishWarehouse({ count: 0, items: [] });
        await warehouseWork;
        assert.equal(warehouseVisit.shoppingTarget, nextTarget);
        assert.equal(warehouseVisit.shoppingServicePhase, 'merchant');
        assert.equal(warehouseVisit.shoppingWarehouseDone, undefined);
        console.log('Hot shopping progress: custody, retries, raid cancellation and late shopping receipts passed');
    } finally {
        Date.now = original.now;
        global.setTimeout = original.setTimeout;
        global.clearTimeout = original.clearTimeout;
        global.clearInterval = original.clearInterval;
    }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
