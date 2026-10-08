'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
const isolated = require('./helpers/isolatedSocialDatabase')('cold-craft-cash-receipt');
require('../src/Global');
isolated.assertConfigured(options.default);
const DataCache = invoke('GameServer/DataCache');
const ColdCraftingService = invoke('GameServer/Bot/Economy/ColdCraftingService');
const CraftShopService = invoke('GameServer/Bot/Economy/CraftShopService');
DataCache.init();

async function verifyAuthoredPhysicalCraft() {
    const Database = invoke('Database');
    const Life = invoke('GameServer/Bot/Population/BotLifeState');
    const recipe = invoke('GameServer/Items/C4RecipeItems').resolveByRecipeId(198);
    assert(recipe, 'the authored Crystal Staff recipe198 exists');
    const inputs = new Map();
    for (const material of recipe.materials) {
        inputs.set(Number(material.selfId), Number(inputs.get(Number(material.selfId)) || 0)
            + Number(material.amount));
    }
    const nativeItem = selfId => DataCache.items.find(row => Number(row.selfId) === Number(selfId));
    const crystalId = [...inputs.keys()].find(id => /^Crystal:/i.test(nativeItem(id)?.template?.name || ''));
    const gemstoneId = [...inputs.keys()].find(id => /^Gemstone(?:\s|:)/i.test(nativeItem(id)?.template?.name || ''));
    console.log('Authored recipe inputs:', JSON.stringify({
        recipeId: recipe.recipeId,
        productId: recipe.productId,
        materials: [...inputs].map(([id, amount]) => ({ id, amount, name: nativeItem(id)?.template?.name }))
    }));
    assert(crystalId && gemstoneId, 'the actual selected C weapon recipe requires crystals and gemstones');
    const nativeStation = ColdCraftingService.stationForRecipe(recipe.recipeId);
    assert(nativeStation, 'the actual recipe is published by a native station');
    const held = (items, selfId) => items.filter(row => Number(row.selfId) === selfId)
        .reduce((sum, row) => sum + Number(row.amount), 0);
    const item = (selfId, amount) => ({ selfId, amount, name: nativeItem(selfId)?.template?.name || `Item ${selfId}`,
        equipped: false, slot: 0, enchant: 0 });
    async function seed(accountName, name, classId, level, rows, stats = {}) {
        await Database.createAccount(accountName, 'fixture');
        const race = Number(DataCache.classTemplates.find(row => Number(row.classId) === classId)?.template?.race || 0);
        const id = Number((await Database.createCharacter(accountName, { name, race, classId, sex: 0,
            face: 0, hair: 0, hairColor: 0, maxHp: 1000, maxMp: 1000, ...nativeStation.loc })).insertId);
        const exp = Number(DataCache.experience[level - 1]);
        await Database.execute(['UPDATE characters SET level=?, exp=?, hp=1000, mp=1000 WHERE id=?', [level, exp, id]]);
        for (const row of rows) await Database.setItem(id, row);
        return Life.upsertState({ characterId: id, accountName, name, phase: 'cold', activity: 'crafting',
            level, exp, loc: { ...nativeStation.loc }, currentRegion: 'Giran',
            adena: held(rows, 57), inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)),
            vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 },
            stats: { classId, generatedCold: true, ...stats }, timing: {} }, 'native_gear_craft_fixture');
    }
    async function image(ids) {
        return Promise.all(ids.map(async id => ({
            items: await Database.fetchItems(id),
            character: (await Database.execute(['SELECT * FROM characters WHERE id=?', [id]]))[0],
            life: (await Database.execute(['SELECT * FROM bot_life_state WHERE characterId=?', [id]]))[0],
            cache: structuredClone(Life.cachedState(id))
        })));
    }
    isolated.assertConfigured(options.default);
    try {
        await Database.init();
        assert(Database.isReady());
        await Life.init();
        const crafter = await seed(ColdCraftingService.crafterAccount(nativeStation), 'NativeGearStation',
            57, 70, [item(57, 1000000)], { craftStationId: nativeStation.id, generatedIndex: 10000 });
        let customer = await seed('bot_native_gear_customer', 'NativeGearCustomer', 10, 40,
            [item(57, 1000000), ...[...inputs].filter(([id]) => id !== crystalId && id !== gemstoneId)
                .map(([id, amount]) => item(id, amount))], {
                equipmentPlan: { status: 'ready_to_craft', strategy: 'craft', recipeId: recipe.recipeId,
                    target: { selfId: recipe.productId } }
            });
        const ids = [customer.characterId, crafter.characterId];
        const noGrantBefore = await image(ids);
        const physical = noGrantBefore[0].items;
        const supplemented = await ColdCraftingService.supplementMaterials(customer.characterId, physical, recipe);
        assert.strictEqual(supplemented.items, physical, 'preparation returns the same physical rows');
        assert.deepStrictEqual(supplemented.supplemented, [], 'preparation grants no crystal or gemstone');
        assert.deepStrictEqual(await image(ids), noGrantBefore, 'preparation cannot create inputs or mutate SQL/cache');
        async function refuse(label) {
            customer = await Life.upsertState({ ...customer, activity: 'crafting',
                inventory: Life.inventorySummaryFromItems(await Database.fetchItems(customer.characterId)) },
            'native_gear_input_acquired');
            const before = await image(ids);
            const result = await ColdCraftingService.craft(customer, () => 0);
            assert.strictEqual(result.crafted, false, label);
            assert.strictEqual(result.reason, 'not_ready', label);
            assert.deepStrictEqual(await image(ids), before, `${label}: all SQL rows, wallets and caches stay unchanged`);
        }
        await refuse('no physical crystals or gemstones');
        await Database.setItem(customer.characterId, item(crystalId, inputs.get(crystalId) - 1));
        await refuse('one crystal short and no gemstone');
        const crystal = (await Database.fetchItems(customer.characterId)).find(row => Number(row.selfId) === crystalId);
        await Database.updateItemAmount(customer.characterId, crystal.id, inputs.get(crystalId));
        await refuse('all crystals still require the physical gemstones');
        await Database.setItem(customer.characterId, item(gemstoneId, inputs.get(gemstoneId) - 1));
        await refuse('one gemstone short');
        const gemstone = (await Database.fetchItems(customer.characterId)).find(row => Number(row.selfId) === gemstoneId);
        await Database.updateItemAmount(customer.characterId, gemstone.id, inputs.get(gemstoneId));
        customer = await Life.upsertState({ ...customer, activity: 'crafting',
            inventory: Life.inventorySummaryFromItems(await Database.fetchItems(customer.characterId)) },
        'native_gear_all_inputs_acquired');
        // A hot station is an actual native service denial before exchange.
        const coldCrafter = Life.cachedState(crafter.characterId);
        await Life.upsertState({ ...coldCrafter, phase: 'hot' }, 'native_gear_station_hot');
        const unavailableBefore = await image(ids);
        const unavailableInput = structuredClone(customer);
        const unavailable = await ColdCraftingService.craft(customer, () => 0);
        assert.strictEqual(unavailable.reason, 'station_busy');
        assert.strictEqual(unavailable.crafted, false);
        assert.deepStrictEqual(customer, unavailableInput, 'station refusal cannot mutate caller state');
        assert.deepStrictEqual(await image(ids), unavailableBefore, 'unavailable station changes no SQL/cache rows');
        await Life.upsertState({ ...Life.cachedState(crafter.characterId), phase: 'cold' },
            'native_gear_station_restored', { releaseHot: true });
        assert.strictEqual((await Life.findByCharacterId(crafter.characterId)).phase, 'cold',
            'the explicit hot ownership handback restores the native station before receipt controls');

        // A real SQLite abort occurs after transaction-local ingredient deletes
        // and before product insertion. Rollback preserves all physical facts;
        // the existing refresh may update reconciliation metadata separately.
        await Database.execute([`CREATE TRIGGER refuse_native_gear_product BEFORE INSERT ON items
            WHEN NEW.characterId = ${customer.characterId} AND NEW.selfId = ${recipe.productId}
            BEGIN SELECT RAISE(ABORT, 'native_gear_product_refused'); END;`, []]);
        const rollbackBefore = await image(ids);
        const rollbackInput = structuredClone(customer);
        const rejected = await ColdCraftingService.craft(customer, () => 0);
        assert.strictEqual(rejected.crafted, false);
        assert.strictEqual(rejected.reason, 'craft_rejected');
        assert.strictEqual(rejected.error, 'native_gear_product_refused', 'existing transaction error identity is retained');
        assert.deepStrictEqual(customer, rollbackInput, 'failed transaction cannot mutate its caller state');
        const rollbackAfter = await image(ids);
        assert.deepStrictEqual(rollbackAfter.map(row => ({ items: row.items, character: row.character })),
            rollbackBefore.map(row => ({ items: row.items, character: row.character })),
            'real transaction failure rolls back ingredients/product/wallet/physical characters');
        await Database.execute(['DROP TRIGGER refuse_native_gear_product', []]);
        const before = await image(ids);
        const entry = CraftShopService.profileFor(crafter).entries.find(row => row.recipeId === recipe.recipeId);
        assert(entry && Number.isSafeInteger(entry.price) && entry.price > 0, 'native published fee is positive');
        const result = await ColdCraftingService.craft(customer, () => 0);
        assert.strictEqual(result.crafted, true, 'all authored physical inputs enable one native manufacture');
        assert.strictEqual(result.recipeId, recipe.recipeId);
        assert.strictEqual(result.reason, 'crafted');
        assert.strictEqual(result.batchCount, 1);
        assert.deepStrictEqual(result.supplementedMaterials, []);
        const afterItems = await Database.fetchItems(customer.characterId);
        const stationItems = await Database.fetchItems(crafter.characterId);
        for (const [id, amount] of inputs) {
            assert.strictEqual(held(before[0].items, id) - held(afterItems, id), amount,
                `authored recipe consumes exactly ${amount} physical input ${id}`);
            assert.strictEqual(Number(result.state.inventory[id]?.amount || 0), held(afterItems, id),
                `the returned inventory cannot retain consumed input ${id}`);
        }
        assert.strictEqual(held(afterItems, recipe.productId), recipe.productCount, 'exactly one recipe output');
        assert.strictEqual(held(afterItems, 57), held(before[0].items, 57) - entry.price);
        assert.strictEqual(held(stationItems, 57), held(before[1].items, 57) + entry.price);
        assert.strictEqual(held(afterItems, 57) + held(stationItems, 57),
            held(before[0].items, 57) + held(before[1].items, 57), 'fee transfers conserve both physical wallets');
        assert.strictEqual(result.state.adena, held(afterItems, 57), 'returned wallet follows the committed physical debit');
        const settled = await Life.upsertState(result.state, 'native_gear_craft_settled');
        assert.strictEqual(Life.cachedState(customer.characterId).adena, held(afterItems, 57));
        assert.strictEqual(settled.inventory[recipe.productId].amount, recipe.productCount);
        for (const id of inputs.keys()) assert.strictEqual(Number(settled.inventory[id]?.amount || 0), 0);
        const persisted = (await Database.execute(['SELECT inventorySummary, adena FROM bot_life_state WHERE characterId=?',
            [customer.characterId]]))[0];
        assert.strictEqual(persisted.adena, held(afterItems, 57));
        const persistedInventory = JSON.parse(persisted.inventorySummary);
        assert.strictEqual(persistedInventory[recipe.productId].amount, recipe.productCount);
        for (const id of inputs.keys()) assert.strictEqual(Number(persistedInventory[id]?.amount || 0), 0);
        const duplicateBefore = await image(ids);
        const duplicate = await ColdCraftingService.craft({ ...settled, activity: 'crafting' }, () => 0);
        assert.strictEqual(duplicate.crafted, false, 'consumed inputs cannot manufacture a second output');
        assert.strictEqual(duplicate.reason, 'not_ready');
        assert.deepStrictEqual(await image(ids), duplicateBefore, 'duplicate attempt changes no SQL rows, wallet or cache');
        // Native zero-balance control: the existing receipt amount 0 is valid.
        const exactFeeCustomer = await seed('bot_native_gear_exact_fee', 'NativeGearExactFee', 10, 40,
            [item(57, entry.price), ...[...inputs].map(([id, amount]) => item(id, amount))], {
                equipmentPlan: { status: 'ready_to_craft', strategy: 'craft', recipeId: recipe.recipeId,
                    target: { selfId: recipe.productId } }
            });
        const exactFeeInput = structuredClone(exactFeeCustomer);
        const exactFeeCraft = await ColdCraftingService.craft(exactFeeCustomer, () => 0);
        assert.strictEqual(exactFeeCraft.crafted, true);
        assert.strictEqual(exactFeeCraft.state.adena, 0, 'a native zero cash receipt is valid and authoritative');
        assert.strictEqual(held(await Database.fetchItems(exactFeeCustomer.characterId), 57), 0);
        assert.deepStrictEqual(exactFeeCustomer, exactFeeInput, 'successful receipt reconciliation clones caller state');

        // Repeat the paid exchange through a real bot workshop. This path
        // accepts transaction lifecycle rows before the final inventory refresh.
        const Workshop = invoke('GameServer/Bot/Economy/CraftWorkshopService');
        const populationConfig = invoke('GameServer/Bot/Population/PopulationConfig');
        const oldBuyersDisabled = populationConfig.staticBuyersDisabled;
        const workshopOwner = await seed('bot_native_gear_workshop', 'NativeGearWorkshop',
            57, 70, [item(57, 1000000)], { role: 'crafter' });
        await Database.setCharacterRecipe(workshopOwner.characterId, recipe.recipeId, recipe.type);
        const publishedWorkshop = await Workshop.review(workshopOwner);
        assert(publishedWorkshop.stats.workshop.entries.some(row => row.recipeId === recipe.recipeId),
            'the physical learned recipe produces a native public workshop offer');
        const workshopCustomer = await seed('bot_native_gear_workshop_customer', 'NativeGearWorkshopBuyer',
            10, 40, [item(57, 1000000), ...[...inputs].map(([id, amount]) => item(id, amount))], {
                equipmentPlan: { status: 'ready_to_craft', strategy: 'craft', recipeId: recipe.recipeId,
                    target: { selfId: recipe.productId } }
            });
        try {
            populationConfig.staticBuyersDisabled = true;
            const selectedWorkshop = ColdCraftingService.stationForRecipe(recipe.recipeId, workshopCustomer);
            assert.strictEqual(selectedWorkshop.characterId, workshopOwner.characterId);
            assert.strictEqual(selectedWorkshop.workshop, true);
            assert(Number.isSafeInteger(selectedWorkshop.price) && selectedWorkshop.price > 0);
            const workshopIds = [workshopCustomer.characterId, workshopOwner.characterId];
            const workshopBefore = await image(workshopIds);
            const workshopInput = structuredClone(workshopCustomer);
            const workshopResult = await ColdCraftingService.craft(workshopCustomer, () => 0);
            assert.strictEqual(workshopResult.crafted, true);
            assert.strictEqual(workshopResult.reason, 'crafted');
            assert.strictEqual(workshopResult.batchCount, 1);
            assert(workshopResult.result.customerState, 'the exchange returns the actual native customer lifecycle row');
            const workshopAfter = await image(workshopIds);
            for (const [id, amount] of inputs) {
                assert.strictEqual(held(workshopBefore[0].items, id) - held(workshopAfter[0].items, id), amount);
                assert.strictEqual(Number(workshopResult.state.inventory[id]?.amount || 0), 0);
            }
            assert.strictEqual(held(workshopAfter[0].items, recipe.productId), recipe.productCount);
            assert.strictEqual(held(workshopAfter[0].items, 57), 1000000 - selectedWorkshop.price);
            assert.strictEqual(held(workshopAfter[1].items, 57), 1000000 + selectedWorkshop.price);
            assert.strictEqual(held(workshopAfter[0].items, 57) + held(workshopAfter[1].items, 57), 2000000);
            assert.strictEqual(workshopResult.state.adena, held(workshopAfter[0].items, 57),
                'paid workshop row publication cannot restore pre-exchange cash');
            assert.deepStrictEqual(workshopCustomer, workshopInput, 'workshop adoption clones caller state');
            const workshopSettled = await Life.upsertState(workshopResult.state, 'native_workshop_craft_settled');
            assert.strictEqual(workshopSettled.adena, held(workshopAfter[0].items, 57));
            assert.strictEqual(Life.cachedState(workshopCustomer.characterId).adena, workshopSettled.adena);
            const [workshopRow] = await Database.execute(['SELECT adena, inventorySummary FROM bot_life_state WHERE characterId=?',
                [workshopCustomer.characterId]]);
            assert.strictEqual(workshopRow.adena, workshopSettled.adena);
            assert.strictEqual(JSON.parse(workshopRow.inventorySummary)[recipe.productId].amount, recipe.productCount);
            const workshopDuplicateBefore = await image(workshopIds);
            const workshopDuplicate = await ColdCraftingService.craft({ ...workshopSettled, activity: 'crafting' }, () => 0);
            assert.strictEqual(workshopDuplicate.crafted, false);
            assert.strictEqual(workshopDuplicate.reason, 'not_ready');
            assert.deepStrictEqual(await image(workshopIds), workshopDuplicateBefore);
            const currentStation = ColdCraftingService.stationForRecipe(recipe.recipeId, workshopSettled);
            const batchCustomer = await seed('bot_workshop_batch_customer', 'WorkshopBatchBuyer', 0, 40,
                [item(57, 1000000), ...[...inputs].map(([id, amount]) => item(id, amount * 2))], {
                    equipmentPlan: { status: 'ready_to_craft', strategy: 'craft', recipeId: recipe.recipeId,
                        outputAmount: recipe.productCount * 2, target: { selfId: recipe.productId },
                        craftProviders: { [recipe.recipeId]: { ...currentStation, known: false } } }
                });
            await Database.execute(['UPDATE characters SET locX=0,locY=0 WHERE id=?', [batchCustomer.characterId]]);
            const batchResult = await ColdCraftingService.craft(batchCustomer, () => 0);
            assert.equal(batchResult.crafted, true, 'fighter uses the agreed dwarf without learning his recipe');
            assert.equal(batchResult.batchCount, 2, 'final own-use execution respects requested output');
            assert.equal(held(await Database.fetchItems(batchCustomer.characterId), recipe.productId), recipe.productCount * 2);
            assert.equal((await Database.fetchCharacterRecipes(batchCustomer.characterId)).length, 0);
            assert.equal(batchResult.state.adena, 1000000 - currentStation.price * 2);
            assert.equal(ColdCraftingService.stationForRecipe(recipe.recipeId, batchCustomer), null,
                'changed agreed workshop revision never silently selects a different dwarf');
            console.log('Native paid workshop conservation:', JSON.stringify({
                recipeId: recipe.recipeId,
                fee: selectedWorkshop.price,
                exchangeLifecycleAdena: workshopResult.result.customerState.adena,
                customer: workshopRow.adena,
                crafter: held(workshopAfter[1].items, 57),
                duplicateRefused: true
            }));
        } finally {
            populationConfig.staticBuyersDisabled = oldBuyersDisabled;
            Workshop.remove(workshopOwner.characterId);
        }
        // Private receipt validation controls use the existing unit facade
        // boundary. They do not claim a native committed exchange or funding.
        const nativeExchange = Database.craftForCustomer;
        const receiptCustomer = await seed('bot_native_receipt_validation', 'NativeReceiptValidation', 10, 40,
            [item(57, 1000000), ...[...inputs].map(([id, amount]) => item(id, amount))], {
                equipmentPlan: { status: 'ready_to_craft', strategy: 'craft', recipeId: recipe.recipeId,
                    target: { selfId: recipe.productId } }
            });
        const receiptInput = structuredClone(receiptCustomer);
        const receiptIds = [receiptCustomer.characterId, crafter.characterId];
        try {
            for (const amount of [undefined, null, '929920', NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
                Database.craftForCustomer = async () => ({ customerAdena: { amount } });
                const invalidBefore = await image(receiptIds);
                await assert.rejects(ColdCraftingService.craft(receiptCustomer, () => 0),
                    { name: 'TypeError', message: 'Invalid customer craft cash receipt' });
                assert.deepStrictEqual(receiptCustomer, receiptInput, 'invalid private receipt cannot mutate caller input');
                assert.deepStrictEqual(await image(receiptIds), invalidBefore, 'invalid facade receipt reaches no later SQL/cache writer');
            }
            // Existing public-station unit facades may omit the whole result.
            // These controls perform no physical exchange and prove only the
            // prior facade contract; native paid conservation is checked above.
            for (const receipt of [undefined, null, {}]) {
                const customerItems = await Database.fetchItems(receiptCustomer.characterId);
                const crafterItems = await Database.fetchItems(crafter.characterId);
                Database.craftForCustomer = async () => receipt;
                const fallback = await ColdCraftingService.craft(receiptCustomer, () => 0);
                assert.strictEqual(fallback.crafted, true);
                assert.strictEqual(fallback.result, receipt);
                assert.strictEqual(fallback.state.adena, receiptCustomer.adena);
                assert.deepStrictEqual(receiptCustomer, receiptInput, 'missing receipt preserves caller state');
                assert.deepStrictEqual(await Database.fetchItems(receiptCustomer.characterId), customerItems);
                assert.deepStrictEqual(await Database.fetchItems(crafter.characterId), crafterItems);
            }
        } finally {
            Database.craftForCustomer = nativeExchange;
        }

        console.log('Native authored craft conservation:', JSON.stringify({ recipeId: recipe.recipeId,
            productId: recipe.productId, inputs: [...inputs], fee: entry.price, output: recipe.productCount,
            crystalId, gemstoneId, duplicateRefused: true }));
    } finally {
        await Database.close();
        require('node:fs').rmSync(isolated.directory, { recursive: true, force: true });
    }
}

verifyAuthoredPhysicalCraft().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
