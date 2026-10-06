'use strict';
const assert = require('node:assert/strict');
delete process.env.L2NODE_SHARED_CONFIG_FILE;
process.env.L2NODE_CONFIG_FILE = 'config/default.ini';
const { createWorld, Database } = require('./helpers/c4QuestHarness');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Goals = invoke('GameServer/Bot/Goals/GoalState');
const GoalService = invoke('GameServer/Bot/Goals/GoalService');
const Gear = invoke('GameServer/Bot/AI/GearPlanSelection');
const Warehouse = invoke('GameServer/Bot/Economy/BotWarehouseService');
const Market = invoke('GameServer/Bot/Economy/BotAfkMarketService');
const Errands = require('../src/GameServer/Bot/Population/CombinedErrandPolicy');
const id = 719112, buyerId = 719113;

async function run() {
    const world = await createWorld([{ id, level: 60 }, { id: buyerId, level: 60 }], 'saved-state-budget');
    const sale = Market.saleDecision;
    try {
        await Database.createAccount('bot_budget_probe', 'test');
        await Database.execute(["UPDATE characters SET username='bot_budget_probe'"]);
        await Life.init();
        for (const characterId of [id, buyerId]) await Database.setItem(characterId,
            { selfId: 57, name: 'Adena', amount: 1000000, slot: 0 });
        for (let i = 0; i < 60; i++) await Database.setItem(id,
            { selfId: 1864 + i, name: `Probe${i}`, amount: 30, slot: 0 });
        const focus = ['gear:1', 1234.56789, 100000];
        const dormant = [['gear:2', 3, 4, 5, 1234.56789, 6]];
        let state = await Life.upsertState({ characterId: id, accountName: 'bot_budget_probe', name: 'BudgetProbe',
            level: 60, phase: 'cold', activity: 'hunting', adena: 1000000, currentRegion: 'Giran',
            inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)),
            loc: { locX: 83396, locY: 147904, locZ: -3400 }, timing: {},
            vitals: { hp: 187, maxHp: 187, mp: 74, maxMp: 74 },
            stats: { classId: 0, playedHours: 1234.56789, wishFocus: focus, dormantWishes: dormant,
                marketTrades: { material: 3 }, priceBeliefs: { old: 1 },
                equipmentPlan: { strategy: 'farm', economyInputKey: 'legacy'.repeat(400), inputKey: 'legacy' },
                huntEfficiency: [{ exp: 1234.56789, kills: 12.34567, adena: 123.456, loot: 78.901,
                    cycleMs: 1234.56789, at: 1791200000000 }] } }, 'saved_budget_seed');
        const planned = Gear.selectAcquisitionPlan(state, state.stats.equipmentPlan);
        state = await Life.upsertState({ ...state, stats: { ...state.stats, equipmentPlan: planned.acquisitionPlan } }, 'saved_budget_plan');
        // Main consumes a real worker-shaped decision for the same native plan.
        const Decisions = require('../src/GameServer/Bot/Population/ColdEconomyDecision');
        const coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
        coordinator.economyDecisions.accept(id, Decisions.capture(planned.economy, state));
        const goal = await GoalService.review(state);
        assert(goal?.current, 'the native plan receives a native goal review');

        for (let i = 0; i < 30; i++) await Database.execute([
            'INSERT INTO warehouse_items(characterId,selfId,name,amount,enchant) VALUES(?,1864,\'Stem\',1,0)', [id]]);
        Market.saleDecision = () => ({ listings: [{ selfId: 1864, count: 60 }], npc: [], answers: [] });
        const withdrawal = await Warehouse.releaseCold(state);
        Market.saleDecision = sale;
        assert(withdrawal.released && withdrawal.items.length === 30);
        state = withdrawal.state;
        const candidates = Array.from({ length: 20 }, (_, i) => ({ selfId: 1864 + i, count: i + 1, npcPrice: 2 }));
        state = await Life.applyNpcLiquidation(state, candidates);
        assert(state);

        const item = (await Database.fetchItems(id)).find(row => row.selfId === 1864);
        const { shop } = await Database.createAfkTradeShop(id, { kind: 'sell_ad', storeType: 1, town: 'Giran',
            lines: [{ objectId: item.id, selfId: 1864, name: 'Stem', count: 3, price: 100, stackable: true }] });
        for (let i = 0; i < 3; i++) {
            const result = await Database.buyFromAfkTradeShop(buyerId,
                { shopId: shop.id, ownerId: id, lineId: shop.lines[0].id, amount: 1 });
            assert(result && !result.error);
            for (const [characterId, counts] of Object.entries(result.marketTrades)) Life.acceptMarketTrades(characterId, counts);
        }
        assert.equal((await Database.fetchBotMarketCounts()).find(row => row.characterId === id).deals, 3);

        let pending = Life.cachedState(id);
        for (let i = 0; i < 20; i++) pending = Errands.enqueue(pending,
            { selfId: i + 1, amount: 1, town: 'Giran', at: Date.now() });
        assert.equal(Errands.pending(pending).length, 8);
        await Life.upsertState(pending, 'saved_budget_errands');
        const [row] = await Database.execute(['SELECT statsJson FROM bot_life_state WHERE characterId=?', [id]]);
        const [goalRow] = await Database.execute(['SELECT goalJson FROM bot_goal_state WHERE characterId=?', [id]]);
        const stats = JSON.parse(row.statsJson);
        for (const [record, field] of [[stats.lastNpcLiquidation, 'sold'], [stats.lastWarehouseWithdrawal, 'items']]) {
            assert(record[field].length <= 8 && Buffer.byteLength(JSON.stringify(record)) <= 120);
            assert(record[field].every(tuple => tuple.length === 3 && tuple.every(Number.isFinite)));
            assert(Object.values(record).filter(value => !Array.isArray(value)).every(Number.isFinite));
        }
        assert.equal(stats.playedHours, 1234.56789);
        assert.deepEqual(stats.wishFocus, focus); assert.deepEqual(stats.dormantWishes, dormant);
        assert.equal(stats.huntEfficiency[0].exp, 1230);
        assert.equal(stats.huntEfficiency[0].adena, 123);
        assert.equal(stats.huntEfficiency[0].at, 1791200000000);
        assert.equal(stats.huntEfficiency[0].cycleMs, 1234.56789);
        const serialized = row.statsJson + goalRow.goalJson;
        for (const key of ['economyInputKey', 'inputKey', 'marketTrades', 'inputHash', 'priceBeliefs'])
            assert(!serialized.includes('"' + key + '"'), key + ' must not be saved');
        assert.notEqual(options.default.Database.path, require('node:path').resolve('tmp/nodel2.sqlite'));
        console.log('Saved budget: native gear/goal, 60-item bag, 30 withdrawals, 20 NPC sales and 3 board deals passed');
    } finally { Market.saleDecision = sale; Goals.reset(); await world.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
