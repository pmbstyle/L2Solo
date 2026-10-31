'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('active-craft-warehouse');
require('../src/Global'); fixture.assertConfigured(options.default);
const Data = invoke('GameServer/DataCache'), Database = invoke('Database');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const Shops = invoke('GameServer/Bot/Economy/CraftShopService');
const Market = invoke('GameServer/Bot/Economy/BotAfkMarketService');
const Warehouse = invoke('GameServer/Bot/Economy/BotWarehouseService');
const Index = invoke('GameServer/Bot/Economy/PersonalWarehouseIndex');
const Craft = invoke('GameServer/Bot/Economy/ColdCraftingService');
const Profit = require('../src/GameServer/Bot/Economy/CraftProfitPolicy');
const root = { recipeId: 99001, productId: 300, productCount: 1, successRate: 100, recipeItemId: 4191,
    materials: [{ selfId: 4191, amount: 1 }, { selfId: 4113, amount: 2 },
        { selfId: 1890, amount: 3 }, { selfId: 1459, amount: 4 }] };
const component = { recipeId: 99002, productId: 1890, productCount: 1, successRate: 100, recipeItemId: 4120,
    materials: [{ selfId: 1864, amount: 2 }, { selfId: 1869, amount: 3 }] };
const original = { byId: Recipes.resolveByRecipeId, byProduct: Recipes.resolveByProductId,
    stations: Shops.publishedStationRecipes, sale: Market.saleDecision };
Recipes.resolveByRecipeId = id => Number(id) === root.recipeId ? root : Number(id) === component.recipeId ? component : original.byId(id);
Recipes.resolveByProductId = id => Number(id) === component.productId ? component : original.byProduct(id);
Shops.publishedStationRecipes = () => ({ stationByRecipeId: new Map([[root.recipeId, { id: 'root' }], [component.recipeId, { id: 'component' }]]) });
Market.saleDecision = () => ({ listings: [{ selfId: 1864, count: 20 }, { selfId: 1459, count: 4 }], npc: [], answers: [] });
const economy = { network: { queue: [] }, craftReservations: {} };
async function run() {
    try {
        Data.init(); await Database.init(); await Life.init();
        await Database.createAccount('bot_warehouse_stage', 'fixture');
        const id = Number((await Database.createCharacter('bot_warehouse_stage', { name: 'WarehouseStage', race: 0,
            classId: 0, maxHp: 1000, maxMp: 1000, sex: 0, face: 0, hair: 0, hairColor: 0,
            locX: 83396, locY: 147904, locZ: -3400 })).insertId);
        async function add(selfId, amount) {
            const item = Data.items.find(row => row.selfId === selfId);
            await Database.setItem(id, { selfId, name: item.template.name, amount, stackable: item.etc.stackable });
        }
        for (const [selfId, amount] of [[57, 100000], [4113, 2], [1864, 2], [1869, 2], [1459, 4]]) await add(selfId, amount);
        let state = await Life.upsertState({ characterId: id, accountName: 'bot_warehouse_stage', name: 'WarehouseStage',
            level: 55, phase: 'cold', activity: 'hunting', currentRegion: 'Giran', adena: 100000,
            loc: { locX: 83396, locY: 147904, locZ: -3400 }, vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 },
            inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)), timing: {},
            stats: { classId: 0, equipmentPlan: { status: 'active', strategy: 'craft', target: { selfId: 300, slot: 14 },
                recipeId: root.recipeId, materials: root.materials, componentRecipes: { 1890: component.recipeId },
                craftProviders: { [root.recipeId]: { publicStation: true }, [component.recipeId]: { publicStation: true } } } } }, 'warehouse_stage_fixture');
        let projected = [];
        Index.useRowSource(owner => Number(owner) === id ? Index.prepareRow([id, 1, projected]) : undefined, () => true);
        async function refreshWarehouse() {
            projected = (await Database.fetchWarehouseItems(id)).filter(row => row.amount > 0)
                .map(row => [Number(row.selfId), Number(row.amount), Number(row.enchant || 0)]);
        }
        const deposited = await Warehouse.depositCold(state); state = deposited.state;
        assert.equal(deposited.count, 8, 'the active kit deposits raw materials and its crystals');
        await refreshWarehouse();
        assert.equal((await Database.fetchWarehouseItems(id)).reduce((n, row) => n + row.amount, 0), 8);
        assert.equal((await Database.execute(['SELECT json_extract(statsJson,\'$.craftWarehouseDepositKind\') kind FROM bot_life_state WHERE characterId=?', [id]]))[0].kind, 'active');
        const waiting = await Warehouse.releaseCold(state, { inTown: true, economy });
        assert.equal(waiting.released, false, 'an incomplete stage remains stored despite market demand');
        await add(1864, 4); await add(1869, 7);
        state = await Life.syncExternalInventory(id, 'warehouse_stage_new_loot');
        const released = await Warehouse.releaseCold(state, { inTown: true, economy }); state = released.state;
        assert.deepEqual(released.items.map(row => [row.selfId, row.amount, row.reason]), [[1864, 2, 'craft'], [1869, 2, 'craft']]);
        await refreshWarehouse();
        let physical = await Database.fetchItems(id);
        const input = Profit.materials(physical, component, 3);
        assert(input, 'the physical bag contains the whole component stage');
        const crafted = await Database.craftInventoryItems(id, { materials: input,
            product: { selfId: 1890, name: 'Cokes', amount: 3, stackable: true }, mp: 1000, coldState: state });
        state = Life.acceptInventoryProjection(crafted.coldLifeRow);
        const storedComponent = await Warehouse.depositCold(state); state = storedComponent.state;
        assert.equal(storedComponent.items.find(row => row.selfId === 1890)?.amount, 3,
            'the crafted intermediate is physically deposited');
        await refreshWarehouse();
        const finalRelease = await Warehouse.releaseCold(state, { inTown: true, economy }); state = finalRelease.state;
        assert(finalRelease.items.some(row => row.selfId === 1890 && row.amount === 3 && row.reason === 'craft'));
        physical = await Database.fetchItems(id);
        assert(Craft.hasMaterials({ ...state, inventory: Life.inventorySummaryFromItems(physical) }, root),
            'physical final materials are ready, with no station scroll');

        // A visible bot uses its real backpack and the same stage rule at the
        // actual warehouse boundary; a release must not be deposited back.
        await Database.createAccount('bot_warehouse_hot', 'fixture');
        const hotId = Number((await Database.createCharacter('bot_warehouse_hot', { name: 'WarehouseHot', race: 0,
            classId: 0, maxHp: 1000, maxMp: 1000, sex: 0, face: 0, hair: 0, hairColor: 0,
            locX: 83396, locY: 147904, locZ: -3400 })).insertId);
        async function addHot(selfId, amount) {
            const item = Data.items.find(row => row.selfId === selfId);
            await Database.setItem(hotId, { selfId, name: item.template.name, amount, stackable: item.etc.stackable });
        }
        for (const [selfId, amount] of [[57, 100000], [4113, 2], [1864, 2], [1869, 2]]) await addHot(selfId, amount);
        const hotState = await Life.upsertState({ ...state, characterId: hotId, accountName: 'bot_warehouse_hot',
            name: 'WarehouseHot', phase: 'hot', activity: 'shopping', inventory: Life.inventorySummaryFromItems(await Database.fetchItems(hotId)),
            stats: { classId: 0, equipmentPlan: state.stats.equipmentPlan } }, 'warehouse_hot_fixture');
        const wrap = row => ({ ...row, setAmount(amount) { this.amount = amount; }, fetchId() { return this.id; },
            fetchSelfId() { return this.selfId; }, fetchAmount() { return this.amount; }, fetchEquipped() { return !!this.equipped; } });
        const backpack = { items: (await Database.fetchItems(hotId)).map(wrap), fetchItems() { return this.items; },
            fetchItemRaw(itemId) { return this.items.find(item => Number(item.id) === Number(itemId)); },
            insertItem(itemId, selfId, details) { this.items.push(wrap({ id: itemId, selfId, ...details })); } };
        const actor = { backpack, fetchId: () => hotId, fetchLevel: () => 55, fetchClassId: () => 0,
            fetchLocX: () => 83396, fetchLocY: () => 147904, fetchLocZ: () => -3400, isDead: () => false };
        let hotRows = [];
        Index.useRowSource(owner => Number(owner) === hotId ? Index.prepareRow([hotId, 1, hotRows]) : undefined, () => true);
        const hotDeposit = await Warehouse.depositActor(actor, hotState);
        assert.equal(hotDeposit.count, 4, 'the visible bot stores its active raw materials');
        hotRows = (await Database.fetchWarehouseItems(hotId)).map(row => [Number(row.selfId), Number(row.amount), Number(row.enchant || 0)]);
        await addHot(1864, 4); await addHot(1869, 7);
        backpack.items = (await Database.fetchItems(hotId)).map(wrap);
        const World = invoke('GameServer/World/World'), Listing = invoke('GameServer/Bot/Economy/MarketListingPolicy');
        const ColdDecision = invoke('GameServer/Bot/Population/ColdEconomyDecision');
        const oldNpc = World.npc, oldSale = Listing.npcSaleForActor, oldEconomy = ColdDecision.economyFor;
        const npc = { fetchId: () => 991, fetchSelfId: () => 992, fetchTitle: () => 'Warehouse Keeper',
            fetchLocX: () => 83396, fetchLocY: () => 147904, fetchLocZ: () => -3400 };
        World.npc = { spawns: [npc] }; Listing.npcSaleForActor = () => new Map(); ColdDecision.economyFor = () => economy;
        try {
            const visit = await Warehouse.depositActorAtWarehouse(actor, hotState,
                { actor, coldLifeState: hotState, shoppingNpcSale: new Map() },
                { actorId: 991, npcSelfId: 992, serviceRole: 'warehouse' });
            assert.deepEqual(visit.released.map(row => [row.selfId, row.amount, row.reason]), [[1864, 2, 'craft'], [1869, 2, 'craft']]);
            assert.equal(visit.count, 0, 'the hot warehouse visit does not deposit the released stage again');
        } finally { World.npc = oldNpc; Listing.npcSaleForActor = oldSale; ColdDecision.economyFor = oldEconomy; }
        console.log('Active warehouse SQLite: deposit, protected waiting, component craft, intermediate storage and final release passed');
    } finally {
        Index.useRowSource(); Recipes.resolveByRecipeId = original.byId; Recipes.resolveByProductId = original.byProduct;
        Shops.publishedStationRecipes = original.stations; Market.saleDecision = original.sale;
        await Database.close(); fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
