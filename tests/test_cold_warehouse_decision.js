'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
require('./helpers/databaseIsolation');
const isolated = require('./helpers/isolatedSocialDatabase')('cold-warehouse-decision');
require('../src/Global');
isolated.assertConfigured(options.default);
const { DatabaseSync } = require('node:sqlite');
const Database = invoke('Database'), Data = invoke('GameServer/DataCache');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Enchant = invoke('GameServer/Bot/Economy/ColdSafeEnchantService');
const Warehouse = invoke('GameServer/Bot/Economy/BotWarehouseService');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const nativeDecision = require('./helpers/workerEconomyDecision');
const id = 730180;

(async () => {
    Data.init();
    const seed = new DatabaseSync(isolated.world);
    seed.exec(fs.readFileSync(path.resolve(__dirname, '../database/sql/sqlite.sql'), 'utf8'));
    seed.exec("INSERT INTO accounts(username,password) VALUES('bot_warehouse_decision','fixture')");
    seed.prepare(`INSERT INTO characters(id,username,name,classId,race,level,exp,sp,maxHp,maxMp,hp,mp,
        sex,face,hair,hairColor,locX,locY,locZ,newbie,newbieShotsReceived)
        VALUES(?,'bot_warehouse_decision','WarehouseDecision',56,4,30,?,20000,187,74,187,74,0,0,0,0,83396,147904,-3400,-1,0)`)
        .run(id, Number(Data.experience[29]));
    seed.close();
    await Database.init();
    try {
        await Life.init();
        await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 10000000, slot: 0 });
        const weapon = Data.items.find(row => row.etc.rank === 'd' && String(row.template.kind).startsWith('Weapon.') && row.etc.slot === 7);
        assert(weapon, 'an actual authored D-grade weapon is required');
        await Database.setItem(id, { selfId: weapon.selfId, name: weapon.template.name, amount: 1, equipped: true, slot: 7, enchant: 0 });
        for (const [selfId, amount] of [[957, 2]]) {
            const item = Data.items.find(row => Number(row.selfId) === selfId);
            const inserted = await Database.setItem(id, { selfId, name: item.template.name, amount, slot: 0 });
            await Database.transferInventoryToWarehouse(id, { id: inserted.insertId, selfId, name: item.template.name,
                amount, stackable: !!item.etc.stackable });
        }
        let state = await Life.upsertState({ characterId: id, accountName: 'bot_warehouse_decision', name: 'WarehouseDecision',
            level: 30, exp: Number(Data.experience[29]), sp: 20000, phase: 'cold', activity: 'hunting', currentRegion: 'Giran',
            loc: { locX: 83396, locY: 147904, locZ: -3400 }, adena: 10000000,
            inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)),
            vitals: { hp: 187, maxHp: 187, mp: 74, maxMp: 74 }, timing: {},
            stats: { classId: 56, classProgressionClassId: 56, classProgressionLevel: 30 } }, 'warehouse_decision_fixture');
        const probe = await nativeDecision(state);
        console.log(JSON.stringify({ nativeMaterials: probe.materials, queue: probe.queue }));
        const selectedScroll = 957;
        assert.deepEqual(probe.materials, [[selectedScroll, 3]],
            'the actual worker selects the native D crystal scroll for the equipped weapon');
        Coordinator.economyDecisions.accept(id, probe.decision);
        const originalFull = Economy.forState;
        Economy.forState = () => { throw Error('main_cold_forState_forbidden'); };
        try {
            const warehouseBefore = await Database.fetchWarehouseItems(id);
            const requests = Enchant.warehouseRequests(state, warehouseBefore);
            assert(requests.some(row => row.selfId === selectedScroll && row.amount === 2 && row.reason === 'enchant'),
                'a worker scroll material must reach the native immediate-enchant path');
            const before = await Database.fetchItems(id);
            const beforeMoney = before.find(row => Number(row.selfId) === 57).amount;
            const released = await Warehouse.releaseCold(state, { inTown: true });
            assert(released.released);
            assert(released.items.some(row => row.selfId === selectedScroll && row.amount === 2 && row.reason === 'enchant'));
            const after = await Database.fetchItems(id), stored = await Database.fetchWarehouseItems(id);
            assert.equal(after.find(row => Number(row.selfId) === weapon.selfId).enchant, 2,
                'both native warehouse scrolls enchant immediately within the same town tail');
            assert.equal(after.some(row => Number(row.selfId) === selectedScroll), false, 'both physical scrolls are consumed');
            assert.equal(stored.some(row => Number(row.selfId) === selectedScroll && row.amount > 0), false);
            assert.equal(after.find(row => Number(row.selfId) === 57).amount, beforeMoney, 'no warehouse withdrawal invents Adena');
            assert.equal(released.state.stats.lastSafeEnchant.operations, 2);
            const row = (await Database.execute(['SELECT adena, inventorySummary, statsJson FROM bot_life_state WHERE characterId=?', [id]]))[0];
            assert.equal(row.adena, beforeMoney);
            assert.equal(JSON.parse(row.inventorySummary)[weapon.selfId].enchant, 2);
            assert.equal(JSON.parse(row.statsJson).lastSafeEnchant.operations, 2);
            assert.deepEqual(Economy.summary().mainColdForState, {}, 'town readers never build a main cold network');
            console.log(JSON.stringify({ native: true, requests, weaponEnchant: 2, consumedScrolls: 2,
                wallet: beforeMoney, mainColdForState: 0 }));

            // Separate captured-wire control: the real Steel recipe's legacy
            // plan and compact worker materials refer to the same physical gap.
            // This checks native SQL transfers, not native graph selection.
            const recipe = invoke('GameServer/Items/C4RecipeItems').resolveByProductId(1880);
            assert(recipe && recipe.materials.some(item => item.selfId === 1869 && item.amount === 5));
            for (const material of recipe.materials) {
                const item = Data.items.find(row => row.selfId === material.selfId);
                const inserted = await Database.setItem(id, { selfId: material.selfId, name: item.template.name,
                    amount: material.amount * 4, slot: 0 });
                await Database.transferInventoryToWarehouse(id, { id: inserted.insertId, selfId: material.selfId,
                    name: item.template.name, amount: material.amount * 4, stackable: !!item.etc.stackable });
            }
            state = await Life.upsertState({ ...released.state, stats: { ...released.state.stats,
                money: probe.statsPacket.money,
                equipmentPlan: { status: 'active', strategy: 'craft', recipeId: recipe.recipeId,
                    target: { selfId: 1880 }, materials: recipe.materials } } }, 'warehouse_overlap_fixture');
            const Decision = require('../src/GameServer/Bot/Population/ColdEconomyDecision');
            Coordinator.economyDecisions.accept(id, Decision.capture({
                projection: { values: new Map(recipe.materials.map(item => [item.selfId, 1000])) },
                network: { activity: null, queue: [{ object: { materials: recipe.materials } }] }
            }, state));
            const overlapStored = await Database.fetchWarehouseItems(id);
            const legacy = Warehouse.craftRequests(state, overlapStored);
            const captured = Enchant.warehouseRequests(state, overlapStored);
            assert.deepEqual(captured, legacy, 'both input sources describe the same missing recipe units');
            const overlap = await Warehouse.releaseCold(state, { inTown: true });
            for (const material of recipe.materials) {
                const moved = overlap.items.filter(item => item.selfId === material.selfId && item.reason === 'craft')
                    .reduce((amount, item) => amount + item.amount, 0);
                assert.equal(moved, material.amount, 'a recipe gap is withdrawn once when both readers describe it');
            }
            const overlapBag = await Database.fetchItems(id), overlapLeft = await Database.fetchWarehouseItems(id);
            for (const material of recipe.materials) {
                assert.equal(overlapBag.find(row => Number(row.selfId) === material.selfId)?.amount, material.amount);
                assert.equal(overlapLeft.find(row => Number(row.selfId) === material.selfId)?.amount, material.amount * 3);
            }
            assert.equal(overlapBag.find(row => Number(row.selfId) === 57).amount, beforeMoney);
            assert.deepEqual(Economy.summary().mainColdForState, {});
            console.log(JSON.stringify({ capturedWire: true, recipeId: recipe.recipeId,
                withdrawnOnce: overlap.items, wallet: beforeMoney, mainColdForState: 0 }));
        } finally { Economy.forState = originalFull; }
    } finally {
        Coordinator.economyDecisions.forget(id);
        await Database.close(); fs.rmSync(isolated.directory, { recursive: true, force: true });
    }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
