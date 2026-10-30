const assert = require('assert');

require('../src/Global');
// The errand buys D soulshots from an NPC offer: off by default since T116 (no C4 NPC sells them).
invoke('GameServer/Bot/Population/PopulationConfig').staticShotsDisabled = false;

const BotSupplyErrand = invoke('GameServer/Bot/AI/BotSupplyErrand');
const BotTownTravel = invoke('GameServer/Bot/AI/BotTownTravel');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const ShoppingState = invoke('GameServer/Bot/AI/States/ShoppingState');
const FollowingState = invoke('GameServer/Bot/AI/States/FollowingState');
const BotSupplyErrandModule = invoke('GameServer/Bot/AI/BotSupplyErrand');
const TradeService = invoke('GameServer/Bot/TradeService');
const DataCache = invoke('GameServer/DataCache');
const BotTradeService = invoke('GameServer/Bot/BotTradeService');
const BotRoles = invoke('GameServer/Bot/AI/BotRoles');
const BotPartyChat = invoke('GameServer/Bot/AI/BotPartyChat');
const BotAgentTools = invoke('GameServer/Bot/AI/BotAgentTools');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const BotAI = invoke('GameServer/Bot/BotAI');

function item(id, selfId, amount, name = 'Soulshot: D-grade') {
    let count = amount;
    return {
        fetchId: () => id,
        fetchSelfId: () => selfId,
        fetchAmount: () => count,
        setAmount: (value) => { count = value; },
        fetchName: () => name
    };
}

async function main() {
    const originals = {
        bestSupplyOffer: MarketOpportunity.bestSupplyOffer,
        request: BotTownTravel.request,
        purchase: BotSupplyErrandModule.purchaseAtDestination,
        tradePurchase: TradeService.buyFromStore,
        scheduleReturn: ShoppingState.scheduleResourceReturn,
        trade: BotTradeService.startBotTradeWithOffer,
        inferRole: BotRoles.inferRole,
        announce: BotPartyChat.announce,
        markCold: LifeState.markCold,
        botAiStop: BotAI.stop,
        botAiInit: BotAI.init,
        botAiWakeup: BotAI.wakeup,
        meetingReceipt: invoke('GameServer/AfkTrade/TradeMeetingService').receipt
    };
    const adena = item(10, 57, 100000, 'Adena');
    const shots = item(11, 1463, 991);
    const bySelfId = new Map([[57, adena], [1463, shots]]);
    const player = {
        accountId: 'player',
        actor: {
            fetchId: () => 100,
            fetchName: () => 'Slava',
            fetchIsOnline: () => true,
            fetchLocX: () => 0,
            fetchLocY: () => 0,
            fetchLocZ: () => 0,
            state: { fetchHits: () => false, fetchCasts: () => false, fetchCombats: () => false, fetchDestId: () => 1000 }
        }
    };
    const bot = {
        fetchId: () => 1,
        fetchName: () => 'Caelan',
        fetchIsOnline: () => true,
        fetchLocX: () => 0,
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
        unselect() {},
        setLocXYZ() {},
        dataSendToOthers() {},
        moveTo() {},
        backpack: { fetchItemFromSelfId: (selfId) => bySelfId.get(Number(selfId)) },
        automation: { abortAll() {} },
        state: { fetchTowards: () => false }
    };
    const session = { accountId: 'bot_1', actor: bot, partyCompanion: true, followPlayerSession: player };
    const originalItems = DataCache.items;
    try {
        const Resolver = invoke('GameServer/Bot/Population/BackgroundResolver');
        const overdue = { phase: 'cold', activity: 'shopping', name: 'Waiting',
            stats: { tradeMeeting: [99, 1], supplyErrand: { expiresAt: 1, meetingToken: 'original-supply-token' } } };
        const kept = Resolver.resolveSolo({ state: overdue, timestamp: 100000 });
        assert.strictEqual(kept.patch.stats.supplyErrand, overdue.stats.supplyErrand,
            'accepted native consent survives an expired companion workflow clock');
        assert.strictEqual(kept.events.length, 0);
        const unaccepted = { ...overdue, stats: { supplyErrand: { expiresAt: 1 } } };
        assert.strictEqual(Resolver.resolveSolo({ state: unaccepted, timestamp: 100000 }).patch.stats.supplyErrand, null,
            'ordinary unaccepted companion requests retain their existing expiry');
        const Meetings = invoke('GameServer/AfkTrade/TradeMeetingService');
        const acceptedErrand = { itemId: 1463, amount: 200, totalCost: 3400, meetingToken: 'original-supply-token' };
        let outcome = { pending: true, outcome: 'accepted', meetingId: 99 };
        Meetings.receipt = async (token, owner) => {
            assert.strictEqual(token, acceptedErrand.meetingToken);
            assert.strictEqual(owner, bot.fetchId());
            return outcome;
        };
        assert.strictEqual((await BotSupplyErrand.purchaseAtDestination(bot, acceptedErrand)).pending, true,
            'a replay keeps the original accepted obligation before any advert lookup');
        outcome = { pending: false, outcome: 'completed', meetingId: 99 };
        const delivered = await BotSupplyErrand.purchaseAtDestination(bot, acceptedErrand);
        assert.strictEqual(delivered.delta, 200);
        assert.strictEqual(delivered.item, shots);
        outcome = { pending: false, outcome: 'cancelled', meetingId: 99 };
        assert.strictEqual((await BotSupplyErrand.purchaseAtDestination(bot, acceptedErrand)).reason, 'supply_meeting_cancelled',
            'a cancelled obligation cannot become a second purchase');
        Meetings.receipt = originals.meetingReceipt;
        DataCache.items = [{ selfId: 1463, template: { name: 'Soulshot: D-grade' }, etc: { stackable: true } }];
        assert.strictEqual(MarketOpportunity.resolveSupplyItem('Soulshots D grade').selfId, 1463);
        assert.strictEqual(MarketOpportunity.normalizeItemLookup('D-grade soulshots'), 'soulshot_d_grade');
        assert.strictEqual(MarketOpportunity.normalizeItemLookup('No-grade soulshots'), 'soulshot_no_grade');
        MarketOpportunity.bestSupplyOffer = () => ({
            sourceType: 'npc', sourceId: 7004, sourceName: 'D-grade grocer', town: 'Talking Island',
            selfId: 1463, price: 17, itemName: 'Soulshot: D-grade', available: true
        });
        let arrivalCallback = null;
        let travelMode = 'walk';
        BotTownTravel.request = (_session, _bot, _ai, _reason, options) => {
            assert.strictEqual(options.allowCompanion, true);
            assert.strictEqual(options.forceScrollOfEscape, true);
            arrivalCallback = options.onArrival;
            return travelMode;
        };
        const requested = BotSupplyErrand.request(session, player, 1463, 200);
        assert.strictEqual(requested.ok, true);
        assert.strictEqual(requested.amount, 200);
        assert.strictEqual(session.companionShopping.amount, 200);

        // A real companion supply escape is parked as a cold workflow: the
        // AI loop is stopped, then resumed only by the destination callback.
        session.companionShopping = undefined;
        session.pendingResourceDelivery = undefined;
        travelMode = 'escape';
        let stopped = 0;
        let initialized = 0;
        let woken = 0;
        BotAI.stop = () => { stopped += 1; };
        BotAI.init = () => { initialized += 1; };
        BotAI.wakeup = () => { woken += 1; };
        LifeState.markCold = async () => ({ phase: 'cold', activity: 'shopping' });
        const parked = BotSupplyErrand.request(session, player, 1463, 1);
        assert.strictEqual(parked.ok, true);
        await Promise.resolve();
        assert.strictEqual(session.supplyErrandPhase, 'cold');
        assert.strictEqual(stopped, 1);
        arrivalCallback();
        assert.strictEqual(session.supplyErrandPhase, 'shopping');
        assert.strictEqual(initialized, 1);
        assert.strictEqual(woken, 1);
        session.companionShopping.amount = 200;

        TradeService.buyFromStore = async (_actor, store, selfId, amount) => {
            assert.strictEqual(store.items[0].selfId, 1463);
            assert.strictEqual(selfId, 1463);
            assert.strictEqual(amount, 200);
            shots.setAmount(1191);
            return { qty: 200, totalAdena: 3400, name: 'Soulshot: D-grade' };
        };
        ShoppingState.scheduleResourceReturn = () => {};
        await ShoppingState.sellAndRestock(session, bot, null, { say() {} });
        assert.strictEqual(session.pendingResourceDelivery.amount, 200);
        assert.strictEqual(session.pendingResourceDelivery.objectId, 11);

        let offered = null;
        BotTradeService.startBotTradeWithOffer = (_session, _player, objectId, amount) => {
            offered = { objectId, amount };
            return { ok: true, trade: { id: 'supply-trade-test' }, line: { objectId, count: amount } };
        };
        BotRoles.inferRole = () => 'dps';
        BotPartyChat.announce = () => true;
        assert.strictEqual(FollowingState.deliverPurchasedResources(session, bot, player), true);
        assert.deepStrictEqual(offered, { objectId: 11, amount: 200 });
        assert.strictEqual(session.pendingResourceDelivery.tradeId, 'supply-trade-test');

        // Selecting the bot is normal before a native trade request. A
        // selected target is not combat; delivery stays pending until the
        // native trade is actually committed with the player.
        session.pendingResourceDelivery = {
            playerSession: player,
            playerId: 100,
            objectId: 11,
            itemName: 'Soulshot: D-grade',
            amount: 1,
            purchasedAt: Date.now()
        };
        offered = null;
        assert.strictEqual(FollowingState.deliverPurchasedResources(session, bot, player), true);
        assert.deepStrictEqual(offered, { objectId: 11, amount: 1 });
        assert.strictEqual(session.pendingResourceDelivery.tradeId, 'supply-trade-test');

        session.pendingResourceDelivery = {
            playerSession: player,
            playerId: 100,
            objectId: 11,
            itemName: 'Soulshot: D-grade',
            amount: 1,
            purchasedAt: Date.now(),
            retryAt: Date.now() + 10000
        };
        offered = null;
        assert.strictEqual(
            FollowingState.deliverPurchasedResources(session, bot, player),
            false,
            'a delivery retry delay must leave the normal companion tick available'
        );
        assert.strictEqual(offered, null);

        session.pendingResourceDelivery.retryAt = undefined;
        player.actor.state.fetchCombats = () => true;
        assert.strictEqual(
            FollowingState.deliverPurchasedResources(session, bot, player),
            false,
            'waiting for a safe trade must not suppress combat or support behavior'
        );
        player.actor.state.fetchCombats = () => false;

        BotTradeService.startBotTradeWithOffer = () => ({ ok: false, reason: 'too_far' });
        assert.strictEqual(
            FollowingState.deliverPurchasedResources(session, bot, player),
            false,
            'a transient trade distance failure must leave the normal companion tick available'
        );
        BotTradeService.startBotTradeWithOffer = () => ({ ok: false, reason: 'trade_busy' });
        assert.strictEqual(
            FollowingState.deliverPurchasedResources(session, bot, player),
            false,
            'a failed trade open must leave the normal companion tick available'
        );

        // An errand request must not cancel an active fight just because the
        // player asked at the wrong moment.
        session.companionShopping = undefined;
        session.pendingResourceDelivery = undefined;
        session.currentTargetId = 777;
        bot.state.fetchHits = () => true;
        const duringFight = BotSupplyErrand.request(session, player, 1463, 1);
        assert.strictEqual(duringFight.reason, 'unsafe_combat_state');
        assert.strictEqual(session.currentTargetId, 777);
        bot.state.fetchHits = () => false;
        session.currentTargetId = undefined;

        // The player-facing rejection includes the amount to transfer, so a
        // failed affordability check is actionable rather than generic.
        const affordability = BotAgentTools.rejectionReply({
            reason: 'not_enough_adena',
            cost: 3400,
            adena: 100,
            itemName: 'Soulshot: D-grade'
        });
        assert(affordability.includes('3,400'));
        assert(affordability.includes('100'));
        assert(affordability.includes('Transfer Adena'));
    } finally {
        MarketOpportunity.bestSupplyOffer = originals.bestSupplyOffer;
        BotTownTravel.request = originals.request;
        BotSupplyErrandModule.purchaseAtDestination = originals.purchase;
        TradeService.buyFromStore = originals.tradePurchase;
        ShoppingState.scheduleResourceReturn = originals.scheduleReturn;
        BotTradeService.startBotTradeWithOffer = originals.trade;
        BotRoles.inferRole = originals.inferRole;
        BotPartyChat.announce = originals.announce;
        LifeState.markCold = originals.markCold;
        BotAI.stop = originals.botAiStop;
        BotAI.init = originals.botAiInit;
        BotAI.wakeup = originals.botAiWakeup;
        invoke('GameServer/AfkTrade/TradeMeetingService').receipt = originals.meetingReceipt;
        DataCache.items = originalItems;
    }
    console.log('LLM supply errand checks passed');
}

// E283: when the route to the supply seller is exhausted, the hidden errand
// must end through the normal supply return (reveal beside the leader, hot
// again, supply phase cleared), not stay invisible in the shopping phase.
async function exhaustedSupplyRouteReturnsVisibly() {
    const Recovery = invoke('GameServer/Bot/AI/CompanionNavigationRecovery');
    const Approach = invoke('GameServer/Bot/AI/TownNpcApproach');
    const Chatter = invoke('GameServer/Bot/AI/TownChatter');
    const PopulationService = invoke('GameServer/Bot/Population/PopulationService');
    const HotBoard = invoke('GameServer/Bot/Economy/HotBoardReviewService');
    const Response = invoke('GameServer/Network/Response');
    const originals = {
        charInfo: Response.charInfo, relationChanged: Response.relationChanged,
        move: Recovery.move, resolveTargetActor: Recovery.resolveTargetActor, refreshTarget: Recovery.refreshTarget,
        approachPlan: Approach.plan, say: Chatter.say, markHot: PopulationService.markHot,
        naturalBreak: HotBoard.naturalBreak, setTimeout: global.setTimeout
    };
    const timers = [];
    const hot = [];
    const said = [];
    let stopped = 0;
    let initialized = 0;
    let routeAttempts = 0;
    try {
        Recovery.move = () => { routeAttempts += 1; return { status: 'exhausted', failures: 3 }; };
        Recovery.resolveTargetActor = () => null;
        Recovery.refreshTarget = (target) => target;
        Approach.plan = () => null;
        Chatter.say = (_session, _ai, key) => { said.push(key); };
        PopulationService.markHot = async (_session, reason) => { hot.push(reason); };
        HotBoard.naturalBreak = () => {};
        Response.charInfo = () => 'charInfo';
        Response.relationChanged = () => 'relationChanged';
        global.setTimeout = (callback, delay) => { timers.push({ callback, delay }); return timers.length; };

        let leaderX = 5000;
        const leader = { actor: { fetchId: () => 100, fetchIsOnline: () => true,
            fetchLocX: () => leaderX, fetchLocY: () => 0, fetchLocZ: () => 0 } };
        const placed = [];
        const sent = [];
        const bot = {
            fetchId: () => 2, fetchName: () => 'Runner', fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0,
            setLocXYZ: (point) => { placed.push(point); }, unselect() {}, automation: { abortAll() {} },
            backpack: { fetchItems: () => [] }, state: { fetchTowards: () => false, fetchCasts: () => false }
        };
        const session = {
            accountId: 'bot_2', actor: bot, plan: 'shopping', partyCompanion: true, followPlayerSession: leader,
            companionShopping: { kind: 'player_resource_purchase', workflowId: 'supply-e283', itemId: 1463, amount: 1,
                target: { locX: 1000, locY: 0, locZ: 0, name: 'Grocer' } },
            shoppingTarget: { locX: 1000, locY: 0, locZ: 0, name: 'Grocer' },
            resumeAfterShopping: { followPlayerSession: leader },
            shoppingWarehouseDone: true,
            supplyErrandHidden: true,
            supplyErrandPhase: 'shopping',
            // The decision the body holds (DecisionEvents.held): no craft, no improvement.
            heldEconomy: { network: { activity: null }, personalCraft: null },
            dataSendToOthers: (packet) => { sent.push(packet); }
        };
        const ai = {
            getClosestTown: () => ({ name: 'Talking Island', x: 0, y: 0, z: 0 }),
            stop: () => { stopped += 1; session.aiActive = false; },
            init: () => { initialized += 1; session.aiActive = true; }
        };
        session.aiActive = true;

        ShoppingState.tick(session, bot, null, ai);
        // BotAI runs a state tick only while aiActive; stopping it keeps the
        // next tick from re-entering the exhausted branch before the return.
        assert.strictEqual(session.aiActive, false, 'the AI loop pauses until the supply return fires');
        assert.strictEqual(timers.length, 1, 'an exhausted supply route schedules exactly one supply return');
        assert.strictEqual(session.companionShopping?.kind, 'player_resource_purchase',
            'the errand stays readable until the normal return consumes it');

        leaderX = 6000;
        timers[0].callback();
        await new Promise((resolve) => originals.setTimeout(resolve, 0));

        assert.strictEqual(session.supplyErrandHidden, false, 'the supply runner must become visible again');
        assert.strictEqual(session.supplyErrandPhase, undefined, 'the supply phase must end');
        assert.deepStrictEqual(hot, ['supply_errand_return'], 'the cold supply record must be marked hot once');
        assert.strictEqual(session.plan, 'following');
        assert.strictEqual(session.companionShopping, undefined);
        assert.strictEqual(session.resumeAfterShopping, undefined);
        assert.deepStrictEqual(placed, [{ locX: 6080, locY: 0, locZ: 0 }], 'the runner reappears beside the leader');
        assert.deepStrictEqual(sent, ['charInfo', 'relationChanged'], 'nearby clients receive the runner again');
        assert(said.includes('supply-return'), 'the runner reports its empty return');
        assert.strictEqual(session.aiActive, true, 'the AI loop runs again after the return');
        assert(stopped >= 1 && initialized >= 1);
        assert.strictEqual(routeAttempts, 1, 'no new route is tried after the errand ended');
    } finally {
        Recovery.move = originals.move;
        Recovery.resolveTargetActor = originals.resolveTargetActor;
        Recovery.refreshTarget = originals.refreshTarget;
        Approach.plan = originals.approachPlan;
        Chatter.say = originals.say;
        PopulationService.markHot = originals.markHot;
        HotBoard.naturalBreak = originals.naturalBreak;
        Response.charInfo = originals.charInfo;
        Response.relationChanged = originals.relationChanged;
        global.setTimeout = originals.setTimeout;
    }
    console.log('Exhausted supply route return checks passed');
}

main().then(() => exhaustedSupplyRouteReturnsVisibly()).catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
