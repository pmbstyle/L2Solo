'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Market = invoke('GameServer/Bot/Economy/ColdMarketService');
const Offers = invoke('GameServer/Bot/Economy/MarketOpportunity');
const Board = invoke('GameServer/AfkTrade/AfkTradeService');
const Decision = invoke('GameServer/Bot/Population/ColdEconomyDecision');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Trip = require('../src/GameServer/Bot/Economy/EconomicTrip');
const Order = require('../src/GameServer/Bot/Economy/OfferOrder');
const saved = { npc: Offers.npcOffersAll, fixed: Offers.fixedStoreOffers, board: Board.boardIndex,
    economy: Decision.economyFor, basics: Economy.basics, tripRead: Trip.read, tripCost: Order.tripCost };
const state = { characterId: 99971, phase: 'cold', activity: 'hunting', currentRegion: 'Dion',
    adena: 20, inventory: {}, stats: { money: [1000, .001, 0, 0, .01, 20, 1835] } };
let travelHours = .1, routeKnown = true, sourceRevision = 1, quoteReads = 0;
const trip = () => routeKnown ? travelHours * 1000 : Infinity;
trip.details = () => ({ known: routeKnown, hours: travelHours, fees: 0 });
const context = { moneyPrice: .001, itemUsefulness: () => .1, trip };
try {
    Offers.npcOffersAll = () => { quoteReads++; return [{ town: 'Dion', sourceType: 'npc', price: 10 }]; };
    Offers.fixedStoreOffers = () => [];
    Board.boardIndex = () => ({ towns: () => [], list: () => [], itemRevision: () => String(sourceRevision) });
    Decision.economyFor = () => context;
    Economy.basics = () => ({ kitCost: (_id, price) => price || 1 });
    assert.equal(Market.canTravelForPurchase(state, { selfId: 1835, amount: 1, town: 'Dion' }), false,
        'one useful unit does not justify its separate journey');
    assert.equal(Market.canTravelForPurchase(state, { selfId: 1835, amount: 2, town: 'Dion' }), true,
        'two actually executable units justify the same journey');
    assert.equal(Market.canTravelForPurchase({ ...state, adena: 10 }, { selfId: 1835, amount: 200, town: 'Dion' }), false,
        'desired 200 units never grant their benefit to an affordable one-unit fill');
    travelHours = 0;
    assert.equal(Market.canTravelForPurchase(state, { selfId: 1835, amount: 1, town: 'Dion' }), true,
        'the already justified town visit can buy one unit');
    routeKnown = false;
    assert.equal(Market.canTravelForPurchase(state, { selfId: 1835, amount: 2, town: 'Dion' }), false,
        'an unknown new route cannot justify a trip');
    assert.equal(Market.canTravelForPurchase(state, { selfId: 1835, amount: 2, town: 'Dion', purpose: 'clan' }), true,
        'a prior clan obligation retains its existing owner');
    routeKnown = true; travelHours = .1;
    const held = { ...context, inputKey: 'declared-held-context' };
    const tiny = { selfId: 1835, amount: 1, town: 'Dion' };
    assert.equal(Market.canTravelForPurchase(state, tiny, { economy: held }), false);
    const firstReads = quoteReads;
    assert.equal(Market.canTravelForPurchase(state, tiny, { economy: held }), false);
    assert.equal(quoteReads, firstReads, 'same refused held choice does not query quotes again');
    sourceRevision++;
    assert.equal(Market.canTravelForPurchase(state, tiny, { economy: held }), false);
    assert(quoteReads > firstReads, 'an actual source revision wakes the same held choice');
    const beforeWallet = quoteReads;
    Market.canTravelForPurchase({ ...state, adena: 10 }, tiny, { economy: held });
    assert(quoteReads > beforeWallet, 'changed own money never reuses a funding decision');
    const Events = invoke('GameServer/Bot/AI/DecisionEvents');
    const actor = { fetchLevel: () => 30, backpack: { fetchItems: () => [], fetchTotalAdena: () => 20 } };
    const session = { coldLifeState: { stats: { decisionSeq: 1 } } };
    const liveContext = { ...context, inputKey: 'hot-shopping-source', stock: () => ({}),
        network: { activity: { activity: 'shopping', itemId: 1835, amount: 2, town: 'Dion', valueHours: .2 } },
        statsPacket: { decisionSeq: 1, money: [1000, .001, 0, 0] } };
    const compact = Events.hold(session, actor, liveContext);
    const hotState = { ...state, stats: { money: liveContext.statsPacket.money } };
    Trip.read = () => trip.details();
    Order.tripCost = () => trip;
    const hotRequest = { selfId: 1835, amount: compact.network.activity.amount,
        town: compact.network.activity.town, valueHours: compact.network.activity.valueHours };
    assert.equal(compact.itemUsefulness, undefined, 'a held decision retains no graph closure');
    assert.equal(Market.canTravelForPurchase(hotState, hotRequest, { economy: compact }), true,
        'native hot hold preserves the finite utility and money conversion needed by the shared travel gate');
    assert.equal(compact.moneyPrice, context.moneyPrice);
    assert.equal(Market.canTravelForPurchase({ ...hotState, adena: 10 }, hotRequest, { economy: compact }), false,
        'a partial hot fill earns only half the retained benefit');
    const hotReads = quoteReads;
    for (let tick = 0; tick < 1000; tick++) assert.equal(Market.canTravelForPurchase(
        { ...hotState, adena: 10 }, hotRequest, { economy: Events.held(session) }), false);
    assert.equal(quoteReads, hotReads, '1000 identical refused hot departures reuse one native quote calculation');
    assert.equal(Market.canTravelForPurchase(state, tiny, { economy: { moneyPrice: .001, trip } }), false,
        'unavailable finite utility refuses a trip without throwing or rebuilding wishes');
    assert(Buffer.byteLength(JSON.stringify(compact)) < 1024, 'the held source remains a compact decision');
    const blocked = { ...state, stats: { money: [1000, .001, 0, 999999] } };
    const quoted = Market.planPurchase(blocked, 1835, 1, { currentFunding: true, cost: () => 0, purpose: 'shots', towns: ['Dion'] });
    assert.equal(quoted?.units, 1);
    assert.equal(quoted.money, 10, 'the concrete 10-adena quote funds a whole unit instead of a one-adena belief cap');
    Board.boardIndex = () => ({ towns: () => ['Dion'],
        list: () => [{ ownerId: 12345, price: 2, count: 100 }] });
    const cheaper = Market.planPurchase(blocked, 1835, 10, { currentFunding: true, cost: () => 0, purpose: 'shots', towns: ['Dion'] });
    assert.equal(cheaper?.units, 1, 'cheaper stock cannot spend the mandatory allowance at the dearer NPC quote');
    assert.equal(cheaper.money, 2);
    const capped = Market.planPurchase(blocked, 1835, 1, { currentFunding: true, cost: () => 0, purpose: 'shots', money: 1, towns: ['Dion'] });
    assert.equal(capped, null, 'an explicit authoritative one-adena cap remains protected');
    console.log('PASS shared purchase trip admission / actual quantity / current quote / obligations');
} finally {
    Offers.npcOffersAll = saved.npc; Offers.fixedStoreOffers = saved.fixed; Board.boardIndex = saved.board;
    Decision.economyFor = saved.economy; Economy.basics = saved.basics;
    Trip.read = saved.tripRead;
    Order.tripCost = saved.tripCost;
}
