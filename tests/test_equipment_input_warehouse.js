'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('equipment-input-warehouse');
require('../src/Global'); fixture.assertConfigured(options.default);
const Data = invoke('GameServer/DataCache'), Database = invoke('Database');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Selection = invoke('GameServer/Bot/AI/GearPlanSelection');
const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const Policy = invoke('GameServer/Bot/Economy/CraftWarehousePolicy');
const Warehouse = invoke('GameServer/Bot/Economy/BotWarehouseService');
const Index = invoke('GameServer/Bot/Economy/PersonalWarehouseIndex');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Luxury = invoke('GameServer/Bot/Economy/BotLuxuryExchange');
const Market = invoke('GameServer/Bot/Economy/BotAfkMarketService');
const Native = require('./helpers/nativeMarketFixture');
const id = 938021, point = { locX: 83396, locY: 147904, locZ: -3400 };
const originalSale = Market.saleDecision;
async function run() {
    try {
        Data.init(); await Database.init(); await Life.init();
        await Native.character(Database, id, 'EquipmentInputs', 'bot_equipment_inputs', point);
        await Database.execute(['UPDATE characters SET classId=40,level=57 WHERE id=?', [id]]);
        for (const [selfId, amount] of [[57, 1000000], [1458, 855]]) {
            const item = Data.items.find(row => row.selfId === selfId);
            await Database.setItem(id, { selfId, name: item.template.name, amount, stackable: true });
        }
        let state = await Life.upsertState({ characterId: id, accountName: 'bot_equipment_inputs', name: 'EquipmentInputs',
            level: 57, phase: 'cold', activity: 'hunting', currentRegion: 'Giran', loc: point, timing: {},
            inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)),
            stats: { classId: 40 } }, 'equipment_input_fixture');
        const recipe = Luxury.recipes().get(439), exchange = { kind: 'luxury_exchange', ...recipe };
        assert.equal(recipe.materials[0].amount, 475, 'the native C tunic uses D crystals');
        const key = 'power:439:10';
        const wish = { key, object: { itemId: 439, slot: 10 }, plan: {
            kind: 'luxury_exchange', improvement: exchange,
            grossRequirements: [{ key: 'item:1458', amount: 475 }] } };
        const economy = { network: { activity: { rootKey: 'stock:shots', activity: 'shopping' },
            queue: [{ key: 'stock:shots', object: { itemId: 3949 } }, wish], plans: new Map([[key, wish.plan]]) },
            projection: { roots: ['stock:shots', key] } };
        const plan = Selection.selectAcquisitionPlan(state, null, { preparedEconomy: economy }).acquisitionPlan;
        assert.equal(plan.status, 'deferred', 'shots keep ownership of the current action');
        assert.equal(plan.target.selfId, 439, 'the next concrete equipment project survives without a previous plan');
        assert.equal(plan.heldInputs[1458], 475, 'only the finite tunic requirement is captured');
        state = await Life.upsertState({ ...state, stats: { ...state.stats, equipmentPlan: plan } }, 'equipment_input_pause');
        let rows = [];
        Index.useRowSource(owner => Number(owner) === id ? Index.prepareRow([id, 1, rows]) : undefined, () => true);
        const refreshWarehouse = async () => {
            rows = (await Database.fetchWarehouseItems(id)).map(row => [Number(row.selfId), Number(row.amount), Number(row.enchant || 0)]);
        };
        assert.equal(Disposition.saleCandidates(state, { unlimited: true, keptAmounts: {} }).find(row => row.selfId === 1458)?.count, 380);
        assert.equal(Disposition.warehouseCandidates(state).find(row => row.selfId === 1458)?.amount, 475,
            'a paused C exchange parks its own share even if the exchange is already affordable');
        assert.equal(Warehouse.beginCraftReturn(state), null, 'a paused project cannot interrupt the shot errand');
        const deposit = await Warehouse.depositCold(state); state = deposit.state;
        assert.equal(deposit.count, 475);
        assert.equal(Native.amount(await Database.fetchItems(id), 1458), 380);
        await refreshWarehouse();
        assert.equal(Native.amount(await Database.fetchWarehouseItems(id), 1458), 475);
        // Restart/reload the authoritative state, rather than carrying an in-memory reservation.
        const [saved] = await Database.execute(['SELECT * FROM bot_life_state WHERE characterId=?', [id]]);
        state = Life.acceptLifecycleRow(saved);
        assert.equal(state.stats.equipmentPlan.heldInputs[1458], 475);
        assert.equal(Selection.deferredWishPlan(state.stats.equipmentPlan, {}, state).heldInputs[1458], 475,
            'a banked reserve survives reviews without absorbing later production purchases');
        const stock = Economy.stockReader(state, () => 0)(1458, key);
        assert.equal(stock.owned + stock.incoming, 855, 'the planner remembers the warehouse without counting it twice');
        assert.equal(stock.incoming, 475, 'stored resources are remembered but are not executable bag inputs');
        assert.equal(Disposition.saleCandidates(state, { unlimited: true, keptAmounts: {} }).find(row => row.selfId === 1458)?.count, 380,
            'banked crystals do not reserve the same share from the bag again');
        const pooled = Index.saleState(state);
        assert.equal(Disposition.saleCandidates(pooled, { unlimited: true, keptAmounts: {} }).find(row => row.selfId === 1458)?.count, 380,
            'a combined market projection protects the banked share exactly once');
        Market.saleDecision = () => ({ listings: [{ selfId: 1458, count: 380 }], npc: [], answers: [] });
        const waiting = await Warehouse.releaseCold(state, { inTown: true, economy: { network: { queue: [] } } });
        assert(!waiting.items.some(row => row.selfId === 1458), 'market demand cannot take the paused warehouse reserve');
        assert.equal(Policy.stage(state, Object.values(Index.inventory(state))), null);

        const temporary = { strategy: 'direct_drop', status: 'active', target: { selfId: 471, slot: 11 } };
        const switched = Selection.withRetainedCraftPreparation(state, state.stats.equipmentPlan, temporary);
        assert.equal(switched.inputPreparation.exchange.itemId, 439, 'changing equipment targets retains an exchange as well as a recipe');
        const finished = Life.reconcileFulfilledEquipmentPlan({ ...state, inventory: { ...state.inventory,
            471: { selfId: 471, amount: 1, equipped: true, equippedCount: 1, equippedSlots: [11], slot: 11 } },
            stats: { ...state.stats, equipmentPlan: switched } });
        assert.equal(finished.stats.equipmentPlan.target.selfId, 439, 'completing the temporary item restores the waiting exchange');
        assert.equal(finished.stats.equipmentPlan.heldInputs[1458], 475);
        const retainedStock = Policy.available({ ...state, stats: { ...state.stats, equipmentPlan: switched } },
            Object.values(Index.inventory(state)));
        assert.equal(retainedStock.bag[1458], 380, 'a different project may use the unreserved bag');
        assert.equal(retainedStock.warehouse[1458], 0, 'a different project cannot consume the parked exchange inputs');
        assert.equal(Economy.stockReader({ ...state, stats: { ...state.stats, equipmentPlan: switched } }, () => 0)(1458, key).incoming,
            475, 'the older project still remembers its banked inputs while a different equipment goal owns the action');

        const Recipes = invoke('GameServer/Items/C4RecipeItems');
        const cRecipe = Recipes.resolveVariantsByProductId(439).find(row => row.successRate === 100);
        const cCraft = { ...state, stats: { ...state.stats, equipmentPlan: { strategy: 'craft', status: 'active',
            target: { selfId: 439, slot: 10 }, recipeId: cRecipe.recipeId, materials: cRecipe.materials,
            craftProviders: { [cRecipe.recipeId]: { publicStation: true } } } } };
        assert.equal(Policy.planFor(cCraft).recipe.recipeId, cRecipe.recipeId, 'C recipes also own their warehouse stock');

        // The real shared graph may keep equipment out of the spending queue
        // while survival shots own the action. Its admitted gear roots still
        // justify retaining the next project, including crystal preparation.
        const native = { ...state, characterId: id + 1, stats: { classId: 40 }, inventory: {
            1458: { selfId: 1458, amount: 855 }, 178: { selfId: 178, amount: 1 }
        } };
        for (const [selfId, slot] of [[45, 6], [62, 12], [200, 14], [436, 10], [471, 11], [608, 9],
            [847, 2], [848, 1], [879, 4], [890, 5], [911, 3]])
            native.inventory[selfId] = { selfId, amount: 1, equipped: true, equippedCount: 1, equippedSlots: [slot], slot };
        const earring = { kind: 'luxury_exchange', ...Luxury.recipes().get(852) };
        const sharing = { ...native, stats: { ...native.stats, equipmentPlan: {
            strategy: 'luxury_exchange', status: 'active', target: { selfId: 852, slot: 1 },
            exchange: earring, materials: earring.materials, inputPreparation: plan
        } } };
        assert.equal(Disposition.saleCandidates(sharing, { unlimited: true, keptAmounts: {} }).find(row => row.selfId === 1458)?.count,
            185, 'two separate equipment projects add their own shares instead of protecting only the larger requirement');
        const Crystals = invoke('GameServer/Bot/Economy/BotCrystallization');
        const previousConversion = { ...plan, materials: [...plan.materials, { selfId: 178, amount: 1 }],
            heldInputs: { ...plan.heldInputs, 178: 1 } };
        const separateConversion = { ...sharing, stats: { ...sharing.stats, equipmentPlan: {
            ...sharing.stats.equipmentPlan, inputPreparation: previousConversion } } };
        assert.equal(Crystals.freeReader(separateConversion)(178), 0,
            'a new exchange cannot crystallize an older project’s prepared weapon');
        const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
        // Stock nobody sells takes no focus (T178): another bot sells the shots.
        const shotBoard = new BoardIndex();
        shotBoard.put({ id: 938050, ownerId: id + 9, storeType: 1, kind: 'shop', town: 'Giran',
            lines: [{ lineId: 938051, selfId: 3949, count: 100000, price: 90, enchant: 0 }] });
        const context = Economy.forState(native, { timestamp: 1800000000000, board: shotBoard, spots: [],
            routeRows: invoke('GameServer/Bot/Economy/EconomicTrip').towns.map(() => [true, 0, 0]),
            rememberContext: false, withNodes: true, knowledgeEnabled: false });
        assert.equal(context.network.activity.rootKey, 'stock:shots');
        const next = Selection.selectAcquisitionPlan(native, null, { preparedEconomy: context }).acquisitionPlan;
        assert.equal(next.status, 'deferred');
        assert.equal(next.target.slot, 10, 'the native choice retains the next robe upgrade');
        assert.equal(next.heldInputs[1458], Math.min(855, next.exchange.materials[0].amount),
            'the native choice captures its finite requirement rather than losing the whole stock');
        const stronger = { kind: 'luxury_exchange', ...Luxury.recipes().get(441) };
        const preparing = { ...native, inventory: {}, stats: { ...native.stats, equipmentPlan: {
            strategy: 'luxury_exchange', status: 'active', target: { selfId: 441, slot: 10 }, exchange: stronger,
            materials: [...stronger.materials, { selfId: 178, amount: 1 }] } } };
        const preparation = Policy.stage(preparing, [{ selfId: 1458, amount: 855 }, { selfId: 178, amount: 1 }]);
        assert.equal(preparation.kind, 'crystallize', 'warehouse recovery does not wait for crystals that the stored weapon must produce');
        assert.deepEqual(preparation.requests, [{ selfId: 178, amount: 1, reason: 'craft' }]);

        const quoted = { ...native, inventory: { ...native.inventory } };
        delete quoted.inventory[1458];
        const board = new BoardIndex();
        board.put({ id: 938030, ownerId: quoted.characterId, storeType: 1, kind: 'shop', town: 'Elven Village',
            lines: [{ lineId: 938031, selfId: 1458, count: 855, price: 1190, enchant: 0 }] });
        const quotedContext = Economy.forState(quoted, { timestamp: 1800000000000, board, spots: [],
            routeRows: invoke('GameServer/Bot/Economy/EconomicTrip').towns.map(() => [true, 0, 0]),
            rememberContext: false, withNodes: true, knowledgeEnabled: false });
        const recovered = Selection.selectAcquisitionPlan(quoted, null, { preparedEconomy: quotedContext }).acquisitionPlan;
        assert(recovered.heldInputs[1458] > 0 && recovered.heldInputs[1458] <= 855,
            'already advertised backed crystals can recover their equipment owner');
        const reclaiming = { ...quoted, stats: { ...quoted.stats, equipmentPlan: recovered } };
        const Pricing = invoke('GameServer/Bot/Economy/MarketPricing');
        const pricing = Pricing.traderContext(reclaiming, { board, economy: quotedContext });
        const [line] = board.ownerLines(quoted.characterId);
        assert.equal(pricing.saleCount(line), 855 - recovered.heldInputs[1458],
            'the backed quote cannot sell the recovered project’s share');
        const review = Pricing.look(reclaiming, [{ ...line, pricing: { price: 1190, seenCounter: 0 } }], pricing);
        assert.equal(review.withdrawals.length, 1, 'the ordinary board review returns the physical quote through native custody');
        const duplicated = { ...separateConversion, inventory: { ...separateConversion.inventory } };
        delete duplicated.inventory[178];
        const duplicateBoard = new BoardIndex();
        duplicateBoard.put({ id: 938040, ownerId: duplicated.characterId, storeType: 1, kind: 'shop', town: 'Giran',
            lines: [938041, 938042].map(lineId => ({ lineId, selfId: 178, count: 1, price: 1000000, enchant: 0 })) });
        const duplicatePricing = Pricing.traderContext(duplicated, { board: duplicateBoard, economy: context });
        const duplicateLines = duplicateBoard.ownerLines(duplicated.characterId);
        assert.deepEqual(duplicateLines.map(row => duplicatePricing.saleCount(row)), [1, 0],
            'two backed copies cannot each claim the one unreserved copy');
        assert.deepEqual(duplicateLines.map(row => duplicatePricing.saleCount(row)), [1, 0],
            'repeated observation and execution reads preserve the same allocation');
        const duplicateReview = Pricing.look(duplicated, duplicateLines.map(row => ({ ...row,
            pricing: { price: 1000000, seenCounter: Number.MAX_SAFE_INTEGER } })), duplicatePricing);
        assert.equal(duplicateReview.withdrawals[0].lineId, 938042,
            'the native withdrawal is assigned to the backed copy that must return to its equipment owner');

        // The bank suppresses purchases as advisory incoming stock. Once
        // survival is satisfied the shared graph has no executable leaf;
        // both a full selection and compact reuse must resume the warehouse
        // owner without a test manually changing its status to active.
        const sated = { ...native, characterId: id, adena: 2000000, inventory: { ...native.inventory,
            3949: { selfId: 3949, amount: 100000 }, 736: { selfId: 736, amount: 100 },
            1061: { selfId: 1061, amount: 100 } }, stats: { classId: 40, equipmentPlan: plan,
            persona: { primaryDrive: 'progression', understanding: 1,
                traits: { ambition: 0, commitment: 0, caution: 0, empathy: 0, sociability: 0 } } } };
        delete sated.inventory[1458]; delete sated.inventory[178];
        const satedContext = Economy.forState(sated, { timestamp: 1800000000000, board: new BoardIndex(), spots: [],
            routeRows: invoke('GameServer/Bot/Economy/EconomicTrip').towns.map(() => [true, 0, 0]),
            rememberContext: false, withNodes: true, knowledgeEnabled: false });
        assert.equal(satedContext.network.activity, null, 'banked inputs are not directly executable');
        const resumed = Selection.selectAcquisitionPlan(sated, plan, { preparedEconomy: satedContext }).acquisitionPlan;
        assert.equal(resumed.status, 'active', 'the full selector resumes the ready stored project');
        assert.equal(Warehouse.beginCraftReturn({ ...sated, stats: { ...sated.stats, equipmentPlan: resumed } })?.stats.travel.reason,
            'craft_warehouse', 'the selected project starts its ordinary warehouse trip');
        assert.equal(Selection.deferredAcquisitionPlan(sated, plan, { network: { activity: null } }).status,
            'active', 'the worker compact null-action branch resumes the same stored project');
        const cancelled = Selection.deferredAcquisitionPlan(sated, { ...plan, reason: 'cancelled' }, { network: { activity: null } });
        assert.equal(cancelled.strategy, 'none');
        assert.equal(cancelled.reason, 'cancelled', 'warehouse readiness cannot revive an explicitly cancelled project');

        // The physical withdrawal still takes only what is missing from the bag.
        Market.saleDecision = () => ({ listings: [], npc: [], answers: [] });
        state = await Life.upsertState({ ...state, stats: { ...state.stats, equipmentPlan: resumed } }, 'equipment_input_resume');
        const stage = Policy.stage(state, Object.values(Index.inventory(state)));
        assert.deepEqual(stage.requests, [{ selfId: 1458, amount: 95, reason: 'craft' }]);
        assert.equal(Warehouse.beginCraftReturn(state)?.stats.travel.reason, 'craft_warehouse');
        const released = await Warehouse.releaseCold(state, { inTown: true, economy: { network: { queue: [] } } });
        state = released.state;
        assert(released.items.some(row => row.selfId === 1458 && row.amount === 95 && row.reason === 'craft'));
        assert.equal(Native.amount(await Database.fetchItems(id), 1458), 475, 'the physical bag contains the exchange inputs');
        assert.equal(Native.amount(await Database.fetchWarehouseItems(id), 1458), 380);
        Market.saleDecision = originalSale;
        const result = await Database.applyBotImprovement(id, exchange, { coldState: state });
        state = Life.acceptLifecycleRow(result.coldLifeRow);
        assert.equal(Native.amount(await Database.fetchItems(id), 1458), 0, 'the exchange consumes real crystals');
        assert((await Database.fetchItems(id)).some(row => row.selfId === 439 && row.equipped), 'the bot wears its C tunic');
        assert(!state.stats.equipmentPlan, 'the completed project releases its reserve');
        await refreshWarehouse();
        Market.saleDecision = () => ({ listings: [{ selfId: 1458, count: 380 }], npc: [], answers: [] });
        const surplus = await Warehouse.releaseCold(state, { inTown: true, economy: { network: { queue: [] } } });
        state = surplus.state;
        await refreshWarehouse();
        const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
        const crystal = (await Database.fetchItems(id)).find(row => row.selfId === 1458);
        await Afk.publishBot(id, { kind: 'shop', storeType: 1, town: 'Giran', title: 'Old crystal quote', ...point,
            lines: [{ selfId: 1458, objectId: crystal.id, count: 380, price: 1190, stackable: true }] });
        assert.equal(Native.amount(await Database.fetchItems(id), 1458), 0, 'the old shop physically holds its quote');
        state = await Life.upsertState({ ...Life.snapshot(id), stats: { ...Life.snapshot(id).stats, equipmentPlan: {
            strategy: 'none', status: 'deferred', reason: 'wish_focus', target: { selfId: 852, slot: 1 },
            exchange: earring, materials: earring.materials, heldInputs: { 1458: 195 }
        } } }, 'equipment_input_quote_recovered');
        const livePricing = Pricing.traderContext(state, { board: Afk.boardIndex(), economy: quotedContext });
        const withdrawal = Pricing.look(state, Afk.boardIndex().ownerLines(id), livePricing);
        assert.equal(withdrawal.withdrawals.length, 1);
        await Market.applyReview(id, withdrawal, { coldAuthority: { revision: state.simulation.revision } });
        assert.equal(Native.amount(await Database.fetchItems(id), 1458), 380, 'native withdrawal returns the exact escrow stock');
        assert.equal(Afk.boardIndex().ownerLines(id).filter(row => row.selfId === 1458).length, 0);
        state = Life.snapshot(id);
        const recoveredDeposit = await Warehouse.depositCold(state);
        assert.equal(recoveredDeposit.count, 195, 'the recovered project parks only its own physical share');
        assert.equal(Native.amount(await Database.fetchItems(id), 1458), 185);
        assert.equal(Native.amount(await Database.fetchWarehouseItems(id), 1458), 195);
        const guardedId = id + 3;
        await Native.character(Database, guardedId, 'GuardedCrystalInput', 'bot_guarded_crystal', point);
        await Database.execute(['UPDATE characters SET classId=40,level=57 WHERE id=?', [guardedId]]);
        await Database.setItem(guardedId, { selfId: 178, name: 'Bone Staff', amount: 1, stackable: false });
        const guarded = await Life.upsertState({ ...separateConversion, characterId: guardedId,
            accountName: 'bot_guarded_crystal', name: 'GuardedCrystalInput',
            inventory: Life.inventorySummaryFromItems(await Database.fetchItems(guardedId)) }, 'retained_crystal_input_fixture');
        await assert.rejects(Database.applyBotImprovement(guardedId,
            { kind: 'crystallize', npcId: Crystals.npcId, sourceSelfId: 178, amount: 1 }, { coldState: guarded }),
        /improvement_source_changed/, 'the native transaction independently protects the older project’s conversion input');
        assert.equal(Native.amount(await Database.fetchItems(guardedId), 178), 1, 'the rejected conversion leaves its physical input untouched');
        console.log('Equipment inputs: next project, pause, native warehouse, reload, retained exchange and physical C upgrade passed');
    } finally {
        Market.saleDecision = originalSale; Index.useRowSource();
        await Database.close(); fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
