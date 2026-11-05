'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
require('./helpers/databaseIsolation');
const isolated = require('./helpers/isolatedSocialDatabase')('cold-warehouse-decision');
require('../src/Global');
invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics = true;
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
        const kit = require('./fixtures/profitable_stock_state').kitFor(56, 30);
        const nativeWeapon = kit.entries.find(item => [7, 14].includes(Number(item.slot)));
        const weapon = Data.items.find(row => Number(row.selfId) === Number(nativeWeapon?.selfId));
        assert(weapon && weapon.etc.rank === 'd', 'an actual authored native D-grade weapon is required');
        const insertedWeapon = await Database.setItem(id, { selfId: weapon.selfId, name: weapon.template.name,
            amount: 1, equipped: true, slot: Number(nativeWeapon.slot), enchant: 0 });
        for (const item of kit.entries.filter(row => ![7, 14].includes(Number(row.slot)))) {
            const authored = Data.items.find(row => Number(row.selfId) === Number(item.selfId));
            await Database.setItem(id, { selfId: Number(item.selfId), name: authored.template.name,
                amount: 1, equipped: true, slot: Number(item.slot), enchant: 0 });
        }
        // The ordinary D weapon scroll: since 82e5323c an item without a world
        // source (the D crystal scroll 957) is never an enchant alternative.
        for (const [selfId, amount] of [[955, 2]]) {
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
        const originalWeapon = (await Database.fetchItems(id)).find(row => Number(row.id) === Number(insertedWeapon.insertId));
        assert(originalWeapon && originalWeapon.selfId === weapon.selfId && originalWeapon.enchant === 0,
            'adding physical armour preserves the original weapon object and enchant');
        const Gear = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
        assert(Gear.suitable(weapon, state, Gear.roleFor(state), 'd'), 'the native weapon is compatible with its actual class');
        assert.strictEqual(invoke('GameServer/Bot/AI/PersonalGearProgression').assess(state).required, false,
            'the physical native D kit has no progression equipment gap');
        const timestamp = Date.now();
        const hunt = invoke('GameServer/Bot/AI/BotHuntEfficiency').huntIncome(state, timestamp);
        assert(hunt.perHour > 0 && hunt.spotId, `native warehouse-owner profitable hunt: ${JSON.stringify(hunt)}`);
        state = await Life.upsertState({ ...state, spotId: hunt.spotId }, 'warehouse_native_hunt_fixture');
        const spots = [require('./fixtures/profitable_stock_state').spotFor(state.spotId)];
        const stock = Economy.basics(state, { timestamp, spots }).stock('shots');
        if (stock.survivalMissing > 0) {
            assert(Number.isFinite(stock.survivalMissing) && Number.isInteger(stock.survivalMissing));
            assert.strictEqual(stock.itemId, invoke('GameServer/Inventory/ShotStock').planForState(state).selfId);
            assert.strictEqual(stock.ownedUsePerHour, stock.usePerHour);
            const current = Number(state.inventory[stock.itemId]?.amount || 0);
            assert.strictEqual(stock.current, current);
            const template = Data.items.find(row => Number(row.selfId) === stock.itemId);
            await Database.setItem(id, { selfId: stock.itemId, name: template.template.name,
                amount: stock.survivalMissing, slot: 0 });
            state = await Life.upsertState({ ...state,
                inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)) }, 'warehouse_native_stock_fixture');
            const freshStock = Economy.basics(state, { timestamp, spots }).stock('shots');
            assert.strictEqual(freshStock.survivalMissing, 0);
            assert.strictEqual(freshStock.current, current + stock.survivalMissing);
        }
        const probe = await nativeDecision(state, { timestamp, nativeRoutes: true });
        console.log(JSON.stringify({ nativeMaterials: probe.materials, queue: probe.queue }));
        const selectedScroll = 955;
        const goals = probe.queue.filter(row => row.object?.kind === 'improvement'
            && row.object.objectId === originalWeapon.id && row.object.from === 0 && row.object.scrollId === selectedScroll);
        assert(goals.length > 0, 'the actual worker admits an enchant goal for the original weapon');
        const goal = goals.reduce((best, row) => row.object.to > best.object.to ? row : best);
        const nativeNeed = goal.object.to - goal.object.from;
        const safeMax = Number(invoke('GameServer/Items/C4EnchantRules').configWith(options.default.Enchant).safeMax);
        assert(Number.isInteger(nativeNeed) && nativeNeed > 0 && goal.object.to <= safeMax);
        assert.strictEqual(goal.object.itemId, weapon.selfId, 'the native goal names the same physical weapon template');
        assert.strictEqual(goal.key, `enchant:${originalWeapon.id}:${goal.object.to}`);
        assert.deepEqual(goal.object.materials, [{ selfId: selectedScroll, amount: nativeNeed }]);
        const scrollMaterials = probe.materials.filter(([selfId]) => selfId === selectedScroll);
        assert.strictEqual(scrollMaterials.length, 1, 'the full capture has one material row for the one physical weapon');
        assert.strictEqual(scrollMaterials[0][1], nativeNeed, 'captured scroll units match the maximum actual weapon goal');
        const expectedEnchantWithdrawal = Math.min(nativeNeed, 2);
        assert(expectedEnchantWithdrawal >= 1 && expectedEnchantWithdrawal <= 2, 'the actual need exercises a nonempty bounded warehouse withdrawal');
        // The worker publishes the decision's packet with the state; main
        // serves a card only to the state carrying its decision (its echo),
        // so the card main reads is the worker's on the published state.
        state = await Life.upsertState({ ...state, stats: { ...state.stats, ...probe.statsPacket } },
            'warehouse_decision_publication');
        Coordinator.economyDecisions.accept(id, (await nativeDecision(state, { timestamp, nativeRoutes: true })).decision);
        const originalFull = Economy.forState;
        Economy.forState = () => { throw Error('main_cold_forState_forbidden'); };
        try {
            const warehouseBefore = await Database.fetchWarehouseItems(id);
            assert.equal(warehouseBefore.filter(row => Number(row.selfId) === selectedScroll)
                .reduce((amount, row) => amount + Number(row.amount), 0), 2, 'the original owner still has exactly two stored scrolls');
            const requests = Enchant.warehouseRequests(state, warehouseBefore);
            assert(requests.every(row => row.selfId === selectedScroll && row.reason === 'enchant'));
            assert.equal(requests.reduce((amount, row) => amount + row.amount, 0), expectedEnchantWithdrawal,
                'a worker scroll material must reach the native immediate-enchant path');
            const nativeReleaseOptions = { inTown: true, now: 1800000000000 };
            const predictedMarket = Warehouse.marketRequests(state, warehouseBefore,
                new Map([[selectedScroll, expectedEnchantWithdrawal]]), nativeReleaseOptions);
            assert(predictedMarket.every(row => row.selfId === selectedScroll && row.reason === 'market'
                && Number.isInteger(row.amount) && row.amount >= 0));
            const marketAmount = predictedMarket.reduce((amount, row) => amount + row.amount, 0);
            assert(marketAmount <= 2 - expectedEnchantWithdrawal, 'the market reader cannot take scrolls reserved for the native enchant goal');
            const expectedTotal = expectedEnchantWithdrawal + marketAmount;
            assert(expectedTotal > 0 && expectedTotal <= 2 && expectedTotal <= safeMax - goal.object.from);
            const expectedConsumed = Math.min(expectedTotal, safeMax - goal.object.from);
            const scrollName = warehouseBefore.find(row => Number(row.selfId) === selectedScroll).name;
            const expectedItems = [...requests, ...predictedMarket].map(row => ({
                selfId: row.selfId, name: scrollName, amount: row.amount, reason: row.reason
            }));
            const before = await Database.fetchItems(id);
            const beforeMoney = before.find(row => Number(row.selfId) === 57).amount;
            const released = await Warehouse.releaseCold(state, nativeReleaseOptions);
            console.log(JSON.stringify({ nativeNeed, requestedEnchant: requests, predictedMarket, released: released.items }));
            assert(released.released);
            assert.deepEqual(released.items, expectedItems, 'the full withdrawal vector agrees with both native readers at the same decision point');
            assert.equal(released.items.filter(row => row.reason === 'enchant').reduce((amount, row) => amount + row.amount, 0), expectedEnchantWithdrawal);
            assert.equal(released.items.filter(row => row.reason === 'market').reduce((amount, row) => amount + row.amount, 0), marketAmount);
            const after = await Database.fetchItems(id), stored = await Database.fetchWarehouseItems(id);
            assert.equal(after.find(row => Number(row.id) === originalWeapon.id).enchant, goal.object.from + expectedConsumed,
                'the safe batch consumes all physically released D scrolls before sale, within the native safe limit');
            assert.equal(after.some(row => Number(row.selfId) === selectedScroll), false, 'all withdrawn physical scrolls are consumed');
            assert.equal(stored.filter(row => Number(row.selfId) === selectedScroll)
                .reduce((amount, row) => amount + Number(row.amount), 0), 2 - expectedTotal,
            'unused physical scrolls remain in the same owner warehouse');
            assert.equal(after.find(row => Number(row.selfId) === 57).amount, beforeMoney, 'no warehouse withdrawal invents Adena');
            assert.equal(released.state.stats.lastSafeEnchant.operations, expectedConsumed);
            const row = (await Database.execute(['SELECT adena, inventorySummary, statsJson FROM bot_life_state WHERE characterId=?', [id]]))[0];
            assert.equal(row.adena, beforeMoney);
            assert.equal(JSON.parse(row.inventorySummary)[weapon.selfId].enchant, goal.object.from + expectedConsumed);
            assert.equal(JSON.parse(row.statsJson).lastSafeEnchant.operations, expectedConsumed);
            console.log(JSON.stringify({ native: true, requests, nativeNeed,
                weaponEnchant: goal.object.from + expectedConsumed, consumedScrolls: expectedConsumed,
                wallet: beforeMoney }));

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
            // The wire card belongs to the state's own decision (its echo).
            Coordinator.economyDecisions.accept(id, Decision.capture({
                projection: { values: new Map(recipe.materials.map(item => [item.selfId, 1000])) },
                network: { decisionSeq: state.stats.decisionSeq, activityLeaf: state.stats.activityLeaf, focus: state.stats.wishFocus,
                    activity: null, quantityPrepared: true, queue: [{ plan: { kind: 'craft', requirements: recipe.materials
                    .map(item => ({ key: `item:${item.selfId}`, amount: item.amount, plan: { kind: 'buy', missingAmount: item.amount } })) } }] }
            }, state));
            const overlapStored = await Database.fetchWarehouseItems(id);
            const legacy = Warehouse.craftRequests(state, overlapStored);
            const captured = Enchant.warehouseRequests(state, overlapStored);
            assert.deepEqual(captured, legacy, 'both input sources describe the same missing recipe units');
            // The remaining stock may legitimately be withdrawn for sale by
            // the native E choice. Pin its decision point and keep its result.
            const releaseOptions = { inTown: true, now: 1800000000000 };
            const market = Warehouse.marketRequests(state, overlapStored,
                new Map(recipe.materials.map(item => [item.selfId, item.amount])), releaseOptions);
            const overlap = await Warehouse.releaseCold(state, releaseOptions);
            for (const material of recipe.materials) {
                const moved = overlap.items.filter(item => item.selfId === material.selfId && item.reason === 'craft')
                    .reduce((amount, item) => amount + item.amount, 0);
                assert.equal(moved, material.amount, 'a recipe gap is withdrawn once when both readers describe it');
            }
            const overlapBag = await Database.fetchItems(id), overlapLeft = await Database.fetchWarehouseItems(id);
            for (const material of recipe.materials) {
                const expectedMarket = market.filter(item => item.selfId === material.selfId)
                    .reduce((amount, item) => amount + item.amount, 0);
                const actualMarket = overlap.items.filter(item => item.selfId === material.selfId && item.reason === 'market')
                    .reduce((amount, item) => amount + item.amount, 0);
                assert.equal(actualMarket, expectedMarket, 'extra stock follows the same native E decision');
                const bagAmount = Number(overlapBag.find(row => Number(row.selfId) === material.selfId)?.amount || 0);
                const storedAmount = Number(overlapLeft.find(row => Number(row.selfId) === material.selfId)?.amount || 0);
                assert.equal(bagAmount, material.amount + expectedMarket);
                assert.equal(storedAmount, material.amount * 3 - expectedMarket);
                assert.equal(bagAmount + storedAmount, material.amount * 4, 'all physical recipe stock is conserved');
            }
            assert.equal(overlapBag.find(row => Number(row.selfId) === 57).amount, beforeMoney);
            const savedOverlap = (await Database.execute(['SELECT inventorySummary FROM bot_life_state WHERE characterId=?', [id]]))[0];
            for (const material of recipe.materials) assert.equal(JSON.parse(savedOverlap.inventorySummary)[material.selfId]?.amount,
                overlapBag.find(row => Number(row.selfId) === material.selfId)?.amount, 'saved projection matches the physical bag');
            console.log(JSON.stringify({ capturedWire: true, recipeId: recipe.recipeId,
                materials: captured, nativeMarketRequests: market, withdrawnOnce: overlap.items,
                wallet: beforeMoney }));
        } finally { Economy.forState = originalFull; }
    } finally {
        Coordinator.economyDecisions.forget(id);
        await Database.close(); fs.rmSync(isolated.directory, { recursive: true, force: true });
    }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
