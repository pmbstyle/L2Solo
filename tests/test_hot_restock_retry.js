'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
invoke('GameServer/DataCache').init();
const saved = [];
function stub(object, key, value) { const old = object[key]; saved.push(() => object[key] = old); object[key] = value; }
const events = [], timers = [], raised = [];
stub(invoke('GameServer/Bot/AI/DecisionEvents'), 'raiseDecision', (session, name) => raised.push(name));
const Shopping = invoke('GameServer/Bot/AI/States/ShoppingState');
const Shot = invoke('GameServer/Inventory/ShotStock');
const Restock = invoke('GameServer/Bot/Economy/NpcRestockPlan');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const bot = { fetchId: () => 970031, fetchName: () => 'RetryShopper',
    fetchLocX: () => 83396, fetchLocY: () => 147904, fetchLocZ: () => -3400,
    backpack: { fetchItemFromSelfId: () => null } };
const session = { actor: bot, plan: 'shopping', shoppingLiveShotStopChecked: true,
    shoppingTarget: { town: 'Giran' }, dataSendToOthers() {} };
const ai = { getClosestTown: () => ({ name: 'Giran' }) };
let failed = true;
(async () => {
    try {
        stub(global, 'setTimeout', fn => { timers.push(fn); return 1; });
        stub(utils, 'infoWarn', () => {});
        stub(Life, 'hotRow', () => ({ phase: 'hot' }));
        stub(Shot, 'planForActor', () => ({ selfId: 1835 }));
        stub(Shot, 'purchaseActorRestock', async () => ({ ok: true, delta: 0, cost: 0 }));
        stub(Shot, 'describe', () => 'shots');
        stub(Restock, 'quoteFor', () => null);
        stub(Restock, 'purchaseForActor', async () => {
            if (failed) throw Error('npc_seller_changed');
            return { ok: true, receipts: [] };
        });
        const Potions = invoke('GameServer/Bot/AI/HealingPotionStock');
        stub(Potions, 'purchasePotionFor', () => ({ selfId: 1060 }));
        stub(Potions, 'localNpcPrice', () => 0);
        const Rebuff = invoke('GameServer/Bot/AI/HotTownRebuff');
        stub(Rebuff, 'syncVisit', () => null);
        stub(Rebuff, 'needsVisit', () => false);
        stub(invoke('GameServer/Bot/AI/TownChatter'), 'say', () => {});
        stub(invoke('GameServer/Bot/AI/BotEventJournal'), 'record', async event => { events.push(event); });
        stub(invoke('GameServer/Bot/AI/TownNpcApproach'), 'reset', () => {});
        stub(invoke('GameServer/Bot/AI/CompanionNavigationRecovery'), 'clear', () => {});
        const attempt = async () => {
            session.shoppingRestockRetryAt = 0;
            Shopping.scheduleRestock(session, bot, null, ai);
            assert.equal(timers.length, 2);
            await timers.shift()(); await timers.shift()();
        };
        await attempt();
        assert.equal(session.plan, 'shopping', 'a refused purchase keeps the visit active');
        assert.equal(session.lastDecision.action, 'shopping_retry');
        assert.equal(events.length, 0, 'a failed debit cannot publish shopping_completed');
        assert.deepEqual(raised, [], 'a restock retried within the visit raises nothing');
        Shopping.scheduleRestock(session, bot, null, ai);
        assert.equal(timers.length, 0, 'the retry waits instead of looping each AI tick');
        failed = false;
        // A craft refused in the field holds its mark until the bot's next look at the market.
        const Wealth = invoke('GameServer/Bot/Economy/WealthCraftDecision');
        session.decisionStats = { townLook: { n: 3 }, wealthRefused: { look: 3, recipes: [79] } };
        assert(Wealth.refused({ stats: session.decisionStats }, 79));
        await attempt();
        assert.equal(session.plan, 'hunting');
        assert.equal(events.at(-1).eventType, 'shopping_completed', 'a later successful purchase ends the visit');
        assert.equal(session.decisionStats.townLook.n, 4, 'a near visit\'s end is the bot\'s look at the market');
        assert(!Wealth.refused({ stats: session.decisionStats }, 79), 'its look ends the craft refusal mark');
        assert.deepEqual(raised.splice(0), ['goal_done:visit'], 'its end wakes the build once, no second town arrival');
        session.plan = 'shopping'; session.shoppingLiveShotStopChecked = true; session.shoppingTarget = { town: 'Giran' };
        failed = true;
        await attempt(); await attempt(); await attempt();
        assert.equal(session.plan, 'hunting', 'persistent failure cannot trap the bot in town forever');
        assert.equal(events.at(-1).eventType, 'shopping_deferred');
        assert.equal(events.at(-1).meta.reason, 'npc_seller_changed');
        assert.deepEqual(raised.splice(0), ['goal_failed:visit'], 'a restock given up ends the visit once, failed');
        // The body's arrival in town: once a trip, at its first tick there (its trip's
        // start stamps shopTimer), whatever stages its visit then runs.
        const visit = { actor: bot, plan: 'shopping', shopTimer: 1, shoppingDoneAnnounced: true, heldEconomy: { network: { activity: null } } };
        Shopping.tick(visit, bot, null, ai); Shopping.tick(visit, bot, null, ai);
        assert.deepEqual(raised.splice(0), ['arrived_town'], 'one arrival a visit');
        const field = { ...bot, fetchLocX: () => 163095, fetchLocY: () => -216000, fetchLocZ: () => -3616 };
        const trip = { ...visit, shopTimer: 2, actor: field };
        Shopping.tick(trip, field, null, ai);
        assert.deepEqual(raised.splice(0), [], 'none on the way, before it stands in a town');
        trip.actor = bot; trip.heldEconomy = { network: { activity: { activity: 'shopping', town: 'Giran' } } };
        Shopping.tick(trip, bot, null, ai);
        assert.deepEqual(raised.splice(0), ['arrived_town:own'], 'the trip its held leaf ordered to this town is the leaf\'s own');
        // A trip the leaf did not order (the bag's cleanup, a flight from unsafe ground, a
        // player's ask) to that same town wakes the build, as the far rule (Sections.leafVisit)
        // does, also when a fight first deferred it.
        const Travel = invoke('GameServer/Bot/AI/BotTownTravel');
        const walker = { ...bot, state: { fetchHits: () => false, fetchCasts: () => false }, moveTo() {}, fetchKarma: () => 0 };
        const giran = { getClosestTown: () => ({ name: 'Giran', x: 83396, y: 147904, z: -3400 }) };
        const cleanup = { actor: walker, plan: 'hunting', shoppingDoneAnnounced: true, heldEconomy: trip.heldEconomy, currentTargetId: 7 };
        assert.equal(Travel.request(cleanup, walker, giran, 'Inventory full.', { forced: true, announce: false }), 'deferred');
        cleanup.currentTargetId = undefined;
        assert.equal(Travel.request(cleanup, walker, giran, cleanup.pendingTownTrip.reason, { announce: false }), 'walk');
        Shopping.tick(cleanup, walker, null, ai);
        assert.deepEqual(raised.splice(0), ['arrived_town'], 'a forced trip to the leaf\'s town is not the leaf\'s own');
        const ordered = { ...cleanup, townArrival: undefined, shopTimer: undefined, pendingTownTrip: undefined };
        Travel.request(ordered, walker, giran, 'Heading to town for my next planned purchase.', { announce: false });
        Shopping.tick(ordered, walker, null, ai);
        assert.deepEqual(raised.splice(0), ['arrived_town:own'], 'the leaf\'s own trip after it is again its own');
        console.log('Hot restock: refusal, delayed retry, success and bounded deferral; one town arrival a visit passed');
    } finally { saved.reverse().forEach(restore => restore()); }
})().catch(error => { console.error(error); process.exitCode = 1; });
