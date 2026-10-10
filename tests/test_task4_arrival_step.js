'use strict';
// Task 4 B3, question 1 = A (user 2026-10-10): on arrival a cold bot buys
// only the card's step: this item in this town, at most the plan's unit
// price (goal.target.adena), at most what is still missing (the card leaf's
// amount less what reached the bag or accepted incoming since the decision).
// A miss plans nothing on main: the worker is asked for a new card. The board
// line is funded by the goal's terms, the ones its offer was budgeted with.
// Native ColdMarketService in a sandbox with declared adapters; no game DB.
const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const root = require('node:path').resolve(__dirname, '..');
let current, offer, decision = null, offered = [], quoted = [], funded = [], refreshes = [], refreshedOn = [];
const dependencies = {
    'GameServer/Bot/Population/BotLifeState': {
        cachedState: () => current, hotRow: () => null, marketPurchaseBlocker: () => null,
        subscribeChanges: () => () => {}, subscribeMarketReviewChanges: () => () => {},
        upsertState: async next => (current = next)
    },
    // The held card (economyDecisions.decided); a refresh records the state
    // the worker would be posted.
    'GameServer/Bot/Population/ColdSimulationCoordinator': { economyDecisions: { decided: () => decision },
        requestEconomyRefresh: id => { refreshes.push(id); refreshedOn.push(current); } },
    'GameServer/Bot/Economy/MarketOpportunity': { botCanBuy: () => true, fixedStoreOffers: () => [], npcOffersAll: () => [],
        bestOffer: (_id, options) => { offered.push(options); return offer && options.accept(offer) ? offer : null; } },
    'GameServer/Bot/Economy/MarketTelemetry': { offerChanged: () => {}, noOffer: () => {}, purchaseFailed: () => {} },
    'GameServer/Bot/Economy/PurchaseFunding': { budget: () => 100000, spendable: () => 100000,
        goalTerms: goal => goal?.plan?.valueRate === undefined ? { itemId: goal?.target?.itemId } : { r: goal.plan.valueRate },
        nativeTerms: (options, itemId) => ({ itemId, ...(options.r !== undefined ? { r: options.r } : {}) }) },
    'GameServer/Bot/Goals/GoalState': { snapshot: () => null },
    'GameServer/Bot/Economy/ColdMarketTradeChat': { maybeAnnounceWanted: state => ({ state, announced: false }) },
    'GameServer/Bot/Goals/GoalExecutor': { finishMarketVisit: state => ({ ...state, activity: 'hunting' }) },
    'GameServer/AfkTrade/AfkTradeService': { subscribeBoardChanges: () => () => {}, boardIndex: () => ({}),
        buyFromShop: async (_buyer, _store, _id, _qty, options) => { funded.push(options.funding); return { pending: true, meetingId: 1 }; } }
};
global.invoke = name => dependencies[name] || {};
const Decision = { economyFor: () => { throw Error('arrival builds no economy view'); },
    remainingToOrder: require(root + '/src/GameServer/Bot/Population/ColdEconomyDecision').remainingToOrder };
const sandbox = { module: { exports: {} }, invoke: global.invoke, utils: { infoWarn: () => {} }, Date, Promise, console,
    require: name => name === './EconomyDiagnostics' ? { active: () => false, enabled: () => false }
        : name === '../Population/ColdEconomyDecision' ? Decision
        : name === '../Population/CombinedErrandPolicy' ? { pending: () => [], ERRAND_MS: 1 }
        : name === './OfferOrder' ? { farmingOrigin: () => null, tripCost: () => () => 0 }
        : name === './OfferQuery' ? { cheapestTown: (_board, _id, options) => { quoted.push(options); return null; } } : {} };
vm.runInNewContext(fs.readFileSync(root + '/src/GameServer/Bot/Economy/ColdMarketService.js', 'utf8'), sandbox, { filename: 'ColdMarketService.js' });
const Market = sandbox.module.exports;
const bot = extra => ({ characterId: 7, name: 'Arrival', phase: 'cold', activity: 'shopping', level: 45, adena: 100000,
    currentRegion: 'Giran', stats: {}, timing: {}, inventory: {}, simulation: { revision: 3, ownerId: 'legacy_main' }, ...extra });
const gear = (adena, plan = {}) => ({ type: 'upgrade_gear', status: 'active',
    target: { itemId: 48, itemName: 'Short Gloves', adena }, plan: { marketTown: 'Giran', ...plan } });

(async () => {
    // A board line above the plan's unit price is not bought; the worker is asked.
    offer = { sourceType: 'afk_bot_store', selfId: 48, price: 80, store: { shopId: 1 }, town: 'Giran' };
    // No card (a karma plan carries none): the goal's step stands.
    current = bot();
    const above = await Market.tryPurchase(current, gear(75));
    assert.equal(above.purchased, false);
    assert.deepEqual(funded, [], 'no line above the plan price reaches the writer');
    assert.deepEqual(refreshes, [7], 'a miss asks the worker for a new card');
    assert(above.state.stats.marketRetryAfter > Date.now(), 'the bot waits instead of replanning on main');
    // The worker is posted the written return, not the state before it: a
    // card decided on the old state would never match the bot again.
    assert.equal(refreshedOn[0], above.state, 'refresh after the return is written');
    assert.equal(refreshedOn[0].activity, 'hunting');

    // A goal without the plan's unit price is not the card's step: nothing to buy.
    refreshes = []; offered = [];
    const unpriced = await Market.tryPurchase(bot(), gear(undefined));
    assert.equal(unpriced.purchased, false);
    assert.deepEqual(offered, [], 'no market lookup without the card step');
    assert.deepEqual(refreshes, [7]);

    // At the plan price the line is bought with the goal's funding terms.
    offer = { ...offer, price: 75 };
    const bought = await Market.tryPurchase(bot(), gear(75, { valueRate: 0.02 }));
    assert.equal(bought.pending, true);
    assert.deepEqual(funded.at(-1), { itemId: 48, r: 0.02 }, 'the native writer funds the root\'s place in the money queue');
    // A weapon bridge was budgeted by the whole wallet: no queue terms.
    await Market.tryPurchase(bot(), gear(75, { valueRate: 0.02, weaponBridge: true }));
    assert.deepEqual(funded.at(-1), { itemId: 48 });

    // A material: the amount is the card leaf's amount less what reached the
    // bag or accepted incoming since the decision (5 - (3 + 1 - 2) = 3).
    refreshes = [];
    decision = { activity: { activity: 'shopping', itemId: 48, amount: 5, heldAtDecision: 2 } };
    const material = { type: 'buy_craft_material', status: 'active', target: { itemId: 48, amount: 10, adena: 75 },
        plan: { marketTown: 'Giran', purpose: 'supply', valueRate: 0.02 } };
    const missed = await Market.tryPurchase(bot({ inventory: { 48: { selfId: 48, amount: 3 } }, acceptedIncoming: { 48: 1 } }), material);
    assert.equal(quoted.length, 1);
    assert.equal(quoted[0].amount, 3, 'only what is still missing');
    assert.equal(quoted[0].maxPrice, 75, 'at most the plan\'s unit price');
    assert.deepEqual([...quoted[0].towns], ['Giran'], 'only this town');
    assert.equal(missed.purchased, false);
    assert.deepEqual(refreshes, [7], 'no source here: the worker decides anew');
    // Everything arrived since the decision: nothing is bought, no lookup.
    quoted = []; refreshes = [];
    await Market.tryPurchase(bot({ inventory: { 48: { selfId: 48, amount: 5 } }, acceptedIncoming: { 48: 2 } }), material);
    assert.deepEqual(quoted, []);
    assert.deepEqual(refreshes, [7]);

    // The goal outlives its card: a meeting on the way delivered the item and
    // the arrival card hunts. Nothing is bought (not the goal's 10 again).
    for (const other of [{ activity: 'hunting', spotId: 3 }, { activity: 'shopping', itemId: 49, amount: 10 }, null]) {
        decision = { activity: other }; quoted = []; offered = []; refreshes = []; refreshedOn = [];
        current = bot({ inventory: { 48: { selfId: 48, amount: 10 } } });
        const gone = await Market.tryPurchase(current, material);
        assert.deepEqual(quoted, [], `no material lookup when the card is ${JSON.stringify(other)}`);
        assert.equal(gone.purchased, false);
        assert.equal(gone.reason, 'arrival_step_gone');
        assert.deepEqual(refreshes, [7], 'the worker decides anew');
        assert.equal(refreshedOn[0], gone.state, 'refresh after the return is written');
        const gearGone = await Market.tryPurchase(bot(), gear(75));
        assert.deepEqual(offered, [], 'no gear lookup without the card ordering it');
        assert.equal(gearGone.reason, 'arrival_step_gone');
    }
    console.log('PASS arrival step: plan price cap, remaining amount with incoming, refresh on a miss after the return, no buy when the card no longer orders the item, goal funding on the board line');
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
