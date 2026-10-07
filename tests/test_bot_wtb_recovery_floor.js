'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const isolated = require('./helpers/isolatedSocialDatabase')('fx-market-case');
require('../src/Global');
isolated.assertConfigured(options.default);
const Data = invoke('GameServer/DataCache');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const Market = invoke('GameServer/Bot/Economy/BotAfkMarketService');
const Needs = invoke('GameServer/Bot/Goals/NeedsEvaluator');
const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
Data.init();
invoke('GameServer/Bot/Economy/MarketCounters').useSpots(() => invoke('GameServer/Bot/Population/SpotProfiles').ensure() || []);
const NOW = 1750000000000;
const order = { id: 95726, ownerId: 7, kind: 'buy_ad', storeType: Afk.BUY, escrowAdena: 37213, revision: 1,
    lines: [{ id: 1, selfId: 32, name: 'Piece Bone Gaiters', count: 1, price: 37213 }] };
const base = { characterId: 7, phase: 'cold', activity: 'dead', level: 40, adena: 20000, accountName: 'bot_pop_7',
    updatedAt: NOW, vitals: { hp: 0, maxHp: 1000, mp: 100, maxMp: 500 }, inventory: {},
    stats: { generatedCold: true, classId: 0, build: { grade: 'c', classId: 0, level: 40 }, equipment: [],
        equipmentPlan: { status: 'active', strategy: 'market', target: { selfId: 32, slot: 11 },
            market: { town: 'Gludio', price: 37213, reserve: 6250, sourceType: 'afk_bot_store' } } } };
const original = { snapshot: Life.snapshot, ownerRecords: Afk.ownerRecords, closeBotRecord: Afk.closeBotRecord };
let current = base, records = [order];
const closes = [];
// This is a real goal/reader control, with a spy at the monetary writer seam.
// It does not claim a physical SQLite escrow/refund integration measurement.
(async () => {
    try {
        Life.snapshot = () => current;
        Afk.ownerRecords = () => records;
        Afk.closeBotRecord = async (...args) => { closes.push(args); return { closed: true }; };
        Coordinator.economyDecisions.forget(7);
        const recovered = Needs.evaluate(base, { now: NOW });
        assert.equal(recovered.length, 1);
        assert.equal(recovered[0].type, 'recover');
        assert.equal(recovered[0].plan.kind, 'revive');
        assert.equal(recovered[0].target.alive, true);
        assert.equal(recovered[0].target.condition, undefined);
        const before = structuredClone(base), orderBefore = structuredClone(order);
        const kept = await Market.reconcileBuyAds(base, recovered[0], recovered);
        assert.equal(kept.changed, false, 'a real hard-floor recovery defers wish judgement and keeps the standing order');
        assert.deepEqual(closes, [], 'recovery never calls the refund/withdraw writer');
        assert.deepEqual(base, before);
        assert.deepEqual(order, orderBefore);
        // The author's NPC route exception applies even through recovery.
        current = { ...base, stats: { ...base.stats, equipmentPlan: { ...base.stats.equipmentPlan,
            market: { ...base.stats.equipmentPlan.market, sourceType: 'npc' } } } };
        const npcNeeds = Needs.evaluate(current, { now: NOW });
        const npc = await Market.reconcileBuyAds(current, npcNeeds[0], npcNeeds);
        assert.equal(npc.withdrawn, true);
        assert.deepEqual(closes.map(args => args.slice(0, 2)), [[7, 95726]]);
        closes.length = 0;
        // An ordinary state with no accepted C1 decision still has no buy need.
        current = { ...base, activity: 'hunting', vitals: { ...base.vitals, hp: 1000 } };
        const missing = Needs.evaluate(current, { now: NOW });
        assert.deepEqual(missing, []);
        await Market.reconcileBuyAds(current, null, missing);
        assert.deepEqual(closes.map(args => args.slice(0, 2)), [[7, 95726]]);
        closes.length = 0;
        records = [];
        current = base;
        assert.equal((await Market.reconcileBuyAds(base, recovered[0], recovered)).changed, false);
        assert.deepEqual(closes, [], 'without an order there is no monetary writer');
        console.log('Native hard-floor recovery/WTB reader controls passed; physical writer integration not measured');
    } finally {
        Life.snapshot = original.snapshot;
        Afk.ownerRecords = original.ownerRecords;
        Afk.closeBotRecord = original.closeBotRecord;
        Coordinator.economyDecisions.forget(7);
        Market._resetForTests();
        fs.rmSync(isolated.directory, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
