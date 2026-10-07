const assert = require('node:assert/strict');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('fx-market-case');
require('../src/Global');
fixture.assertConfigured(options.default);
const Data = invoke('GameServer/DataCache');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const Market = invoke('GameServer/Bot/Economy/BotAfkMarketService');
const Needs = invoke('GameServer/Bot/Goals/NeedsEvaluator');
const Floor = invoke('GameServer/Bot/Population/SurvivalFloor');
const Decision = invoke('GameServer/Bot/Population/ColdEconomyDecision');
const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const capture = require('./helpers/nativeMarketChoice').capture;
Data.init();
const order = { id: 95726, ownerId: 7, kind: 'buy_ad', storeType: Afk.BUY,
    escrowAdena: 37213, revision: 1, lines: [{ id: 1, selfId: 32,
        name: 'Piece Bone Gaiters', count: 1, price: 37213 }] };
const original = { snapshot: Life.snapshot, ownerRecords: Afk.ownerRecords, closeBotRecord: Afk.closeBotRecord };
const closes = [];
let current;
const base = { characterId: 7, phase: 'cold', activity: 'resting', level: 40, adena: 20000,
    accountName: 'bot_pop_7', vitals: { hp: 40, maxHp: 1000, mp: 100, maxMp: 500 }, inventory: {},
    stats: { generatedCold: true, classId: 0, build: { grade: 'c', classId: 0, level: 40 }, equipment: [],
        equipmentPlan: { status: 'active', strategy: 'market', target: { selfId: 32, slot: 11 },
            market: { town: 'Gludio', price: 37213, reserve: 6250, sourceType: 'afk_bot_store' } } } };
(async () => {
    try {
        Life.snapshot = () => current;
        Afk.ownerRecords = () => [order];
        Afk.closeBotRecord = async (...args) => { closes.push(args); return { closed: true }; };
        const native = await capture(base, {}, 'original_hp4_cached_watch_before_floor');
        current = native.state;
        assert.strictEqual(native.read.activity.activity, 'hunting');
        assert.strictEqual(Floor.forState(current), null, 'unchanged original HP4 state is voluntary');
        const watch = Decision.economyFor(current).watchList;
        assert(watch.length > 0 && watch.every(row => row.itemId !== 32),
            'the actual worker captured a different watch, not a handwritten decision');
        const originalKey = Decision.stateKey(current);
        const originalDecision = Coordinator.economyDecisions.decided(current);
        const packet = structuredClone(current.stats.money);
        const ordinary = await Market.reconcile(current, { type: 'recover', status: 'active', plan: { kind: 'rest' } });
        assert.strictEqual(ordinary.withdrawn, true, 'the original unfunded unrelated order is still withdrawn');
        assert.strictEqual(closes.length, 1);
        closes.length = 0;
        // Change only the declared new native HP observation, without changing
        // activity, timestamp, classes, money, old order or cached decision.
        current = { ...native.state, vitals: { ...native.state.vitals, hp: 0 } };
        assert.strictEqual(Decision.stateKey(current), originalKey);
        assert.strictEqual(Coordinator.economyDecisions.decided(current), originalDecision,
            'the pre-floor genuine cached capability remains exactly present');
        assert.deepStrictEqual(Decision.economyFor(current).watchList, watch);
        const floors = Needs.evaluate(current);
        assert.strictEqual(floors.length, 1);
        assert.strictEqual(floors[0].type, 'recover');
        assert.strictEqual(floors[0].plan.kind, 'revive');
        const before = structuredClone(current), beforeOrder = structuredClone(order);
        const kept = await Market.reconcile(current, floors[0]);
        assert.deepStrictEqual(closes, [], 'a cached voluntary watch cannot withdraw the order ahead of the genuine floor');
        assert.strictEqual(kept.changed, false);
        assert.deepStrictEqual(current, before);
        assert.deepStrictEqual(order, beforeOrder);
        assert.deepStrictEqual(current.stats.money, packet);
        assert.strictEqual(Coordinator.economyDecisions.decided(current), originalDecision,
            'the floor protection never forgets or rewrites native decisions');
        // The original authored NPC exception still withdraws its order.
        current = { ...current, stats: { ...current.stats, equipmentPlan: { ...current.stats.equipmentPlan,
            market: { ...current.stats.equipmentPlan.market, sourceType: 'npc' } } } };
        const npc = await Market.reconcile(current, Needs.evaluate(current)[0]);
        assert.strictEqual(npc.withdrawn, true);
        assert.deepStrictEqual(closes.map(args => args.slice(0, 2)), [[7, 95726]]);
        assert.strictEqual(current.adena, 20000);
        assert.deepStrictEqual(current.stats.money, packet);
        console.log(JSON.stringify({ scope: 'native cached worker watch plus true survival-floor consumer',
            originalHP: 40, observedHP: 0, activityUnchanged: current.activity, originalKey, watch,
            packet, nativeDecisionRetained: true, protectedRefundWriterCalls: 0,
            npcRefundWriterCalls: closes.length, physicalSQLiteSettlementClaim: false }));
        console.log('Cached native WTB floor controls passed');
    } finally {
        Life.snapshot = original.snapshot;
        Afk.ownerRecords = original.ownerRecords;
        Afk.closeBotRecord = original.closeBotRecord;
        Coordinator.economyDecisions.forget(7);
        Market._resetForTests();
        fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
