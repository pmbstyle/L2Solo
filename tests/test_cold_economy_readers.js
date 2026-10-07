'use strict';
const assert = require('node:assert/strict');
require('../src/Global'); invoke('GameServer/DataCache').init();
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Decision = require('../src/GameServer/Bot/Population/ColdEconomyDecision');
const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const Needs = invoke('GameServer/Bot/Goals/NeedsEvaluator');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const Market = invoke('GameServer/Bot/Economy/BotAfkMarketService');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Improvement = invoke('GameServer/Bot/Economy/BotImprovementService');
const SafeEnchant = invoke('GameServer/Bot/Economy/ColdSafeEnchantService');
const Floor = invoke('GameServer/Bot/Population/SurvivalFloor');
const state = { characterId: 7191, name: 'DecisionReader', level: 30, exp: 0, sp: 0, adena: 0, phase: 'cold', activity: 'hunting',
    updatedAt: 1e12, currentRegion: 'Giran', spotId: null, inventory: {}, loc: { locX: 145224, locY: 120001, locZ: -4500 },
    timing: { nextResolveAt: 1e12 + 60000 }, vitals: { hp: 1000, maxHp: 1000, mp: 500, maxMp: 500 },
    stats: { classId: 1, classProgressionLevel: 30, classProgressionClassId: 1, money: [30000, 1e-5, 3000, 30000] } };
const fixture = { inputKey: 'native-reader-input', riskWeight: 1, projection: { values: new Map([[391, .39]]), nodes: [] },
    watchList: [{ itemId: 391, amount: 1, worth: 39000, kind: undefined }], network: { demands: new Map(),
        activity: { activity: 'shopping', itemId: 391, amount: 1, price: 30000, rootKey: 'power:391' },
        queue: [{ key: 'power:391', price: 30000, object: { itemId: 391, amount: 1, materials: [{ selfId: 1864, amount: 2 }] } }] } };
const original = { full: Economy.forState, owner: Afk.ownerRecords, upsert: Life.upsertState, floor: Floor.forState };
const decisions = Coordinator.economyDecisions;
(async () => {
    Economy.resetCounters();
    Economy.forState = (value, deps) => { if (value?.phase === 'cold') throw Error('main cold wish build'); return original.full(value, deps); };
    Afk.ownerRecords = () => [];
    Life.upsertState = async value => value;
    Floor.forState = () => ({ action: null });
    try {
        for (const present of [true, false]) {
            decisions.forget(state.characterId); if (present) decisions.accept(state.characterId, Decision.capture(fixture, state));
            const context = Coordinator.contextFor(state, { spots: new Map(), parties: new Map(), occupancy: {} });
            assert.equal(context.targetNpcId, null);
            const improvement = await Improvement.reviewCold(state); assert.equal(improvement.changed, false);
            const needs = Needs.evaluate(state);
            if (present) assert.equal(needs[0].target.itemId, 391); else assert.deepEqual(needs, []);
            assert.deepEqual(Market.buyLines(state, null), [], 'unfunded wallet cannot open a buy ad');
            await Market.reconcileBuyAds(state, null, []);
            invoke('GameServer/Bot/AI/HealingPotionStock').restockPlan(state);
            invoke('GameServer/Inventory/ShotStock').restockPlan(state, { unitPrice: 0 });
            await invoke('GameServer/Bot/Economy/ColdShotEconomyService').reviewDemand(state, state.updatedAt);
            const withdrawal = SafeEnchant.warehouseRequests(state, [{ selfId: 1864, amount: 10 }]);
            assert.deepEqual(withdrawal, present ? [{ selfId: 1864, amount: 2, reason: 'craft' }] : []);
            invoke('GameServer/Bot/Economy/MarketPricing').traderContext(state);
            invoke('GameServer/Bot/Economy/CraftProfitPolicy').contextFor(state);
            invoke('GameServer/Bot/Population/PartyRequestPlanner').partyRequestForPlan(state, { status: 'active', strategy: 'drop',
                target: { selfId: 391 }, next: { kind: 'drop', itemId: 391, spotId: 'need', npcId: 20101, requiresParty: true } });
            invoke('GameServer/Bot/Population/PartyGoalPolicy').itemNeed(state, { selfId: 391 });
            const packet = { wishFocus: ['power:391', 1], dormantWishes: [], money: [30000, 1e-5, 3000, 30000], decisionSeq: 99, activityLeaf: 17 };
            const result = { patch: {}, materialize: { exp: 0, sp: 0, adena: 0, items: [] }, events: [], debug: {} };
            const projected = await Life.prepareResolve(state, result, { persist: false, projectClassProgression: true,
                timestamp: state.updatedAt + 1, statsPacket: packet });
            for (const key of Object.keys(packet)) assert.deepEqual(projected.stats[key], packet[key], 'whole worker packet ' + key);
            const retained = await Life.prepareResolve({ ...state, activity: 'resting' }, result,
                { persist: false, projectClassProgression: true, timestamp: state.updatedAt + 1 });
            assert.deepEqual(retained.stats.money, state.stats.money, 'main retains existing packet without a worker packet');
        }
        decisions.accept(state.characterId, Decision.capture(fixture, state));
        const held = Decision.economyFor(state, { knowledgeEnabled: false });
        assert(Math.abs(held.worth(391) - Math.fround(.39) / state.stats.money[1]) < .001);
        assert.equal(held.worth(2000), held.price(2000), 'unknown item falls back to native belief');
        assert.deepEqual(Needs.evaluate({ ...state, inventory: { 391: { selfId: 391, amount: 1 } } }), [], 'bag guard suppresses bought gear');
        // Captured-wire classification control; native graph selection and
        // physical scroll consumption are tested separately in the town fixture.
        decisions.accept(state.characterId, Decision.capture({ ...fixture, network: { ...fixture.network,
            queue: [{ object: { materials: [{ selfId: 955, amount: 2 }, { selfId: 957, amount: 3 },
                { selfId: 1864, amount: 7 }] } }] } }, state));
        assert.deepEqual(SafeEnchant.warehouseRequests(state, [
            { selfId: 955, amount: 1 }, { selfId: 957, amount: 5 }, { selfId: 1864, amount: 9 },
            { selfId: 1869, amount: 20 }
        ]), [{ selfId: 955, amount: 1, reason: 'enchant' }, { selfId: 957, amount: 3, reason: 'enchant' },
            { selfId: 1864, amount: 7, reason: 'craft' }]);
        assert.deepEqual(Economy.summary().mainColdForState, {}, 'all main cold readers avoid full model');
        console.log('test_cold_economy_readers: ok');
    } finally {
        Economy.forState = original.full; Afk.ownerRecords = original.owner; Life.upsertState = original.upsert; Floor.forState = original.floor;
        decisions.forget(state.characterId);
    }
    process.exit(0);
})().catch(error => { console.error(error.stack); process.exit(1); });
