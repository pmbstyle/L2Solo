'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
invoke('GameServer/DataCache').init();
const saved = [];
function stub(object, key, value) { const old = object[key]; saved.push(() => object[key] = old); object[key] = value; }
const events = [], timers = [];
stub(invoke('GameServer/Bot/AI/DecisionEvents'), 'raiseDecision', () => {});
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
        Shopping.scheduleRestock(session, bot, null, ai);
        assert.equal(timers.length, 0, 'the retry waits instead of looping each AI tick');
        failed = false;
        await attempt();
        assert.equal(session.plan, 'hunting');
        assert.equal(events.at(-1).eventType, 'shopping_completed', 'a later successful purchase ends the visit');
        session.plan = 'shopping'; session.shoppingLiveShotStopChecked = true; session.shoppingTarget = { town: 'Giran' };
        failed = true;
        await attempt(); await attempt(); await attempt();
        assert.equal(session.plan, 'hunting', 'persistent failure cannot trap the bot in town forever');
        assert.equal(events.at(-1).eventType, 'shopping_deferred');
        assert.equal(events.at(-1).meta.reason, 'npc_seller_changed');
        console.log('Hot restock: refusal, delayed retry, success and bounded deferral passed');
    } finally { saved.reverse().forEach(restore => restore()); }
})().catch(error => { console.error(error); process.exitCode = 1; });
