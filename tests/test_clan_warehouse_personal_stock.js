'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const isolated = require('./helpers/isolatedSocialDatabase')('clan-warehouse-personal-stock');
require('../src/Global');
const Data = invoke('GameServer/DataCache');
Data.init();
const Database = invoke('Database');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Policy = invoke('GameServer/Clan/ClanCraftingPolicy');
const Planner = invoke('GameServer/Clan/ClanEquipmentPlanner');
const Equipment = invoke('GameServer/Clan/ClanEquipmentService');
const Index = invoke('GameServer/Bot/Economy/PersonalWarehouseIndex');
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const Shops = invoke('GameServer/Bot/Economy/CraftShopService');
const { ColdTableChannel } = require('../src/GameServer/Bot/Population/ColdTableChannel');
const { ClanPlanningCoordinator } = require('../src/GameServer/Clan/ClanPlanningCoordinator');
const id = 990600;
const stock = (selfId, amount) => ({ selfId, amount });
let storedRow = Index.prepareRow([id, 1, [[1865, 90, 0]]]);
Index.useRowSource(owner => owner === id ? storedRow : null, () => true);

function policyChecks() {
    const plan = { materials: [stock(1865, 90)] };
    const bag = { 1865: stock(1865, 43) }, stored = { 1865: stock(1865, 90) };
    const rows = [{ selfId: 1865, amount: 100, reservedAmount: 20 }];
    const before = structuredClone({ plan, bag, stored, rows });
    assert.deepEqual(Policy.warehouseMaterials(plan, bag, rows, stored), [],
        'the full personal stash plus the backpack must suppress another clan withdrawal');
    assert.deepEqual(Policy.warehouseMaterials(plan, bag, rows, { 1865: stock(1865, 20) }), [stock(1865, 27)],
        'only the deficit after both personal stores may be withdrawn');
    assert.deepEqual(Policy.warehouseMaterials(plan, {}, [{ ...rows[0], reservedAmount: 95 }],
        { 1865: stock(1865, 20) }), [stock(1865, 5)], 'clan reservations still cap the available stock');
    assert.deepEqual({ plan, bag, stored, rows }, before, 'counting stored resources never moves or mutates them');

    const staff = { recipeId: 443 };
    assert.deepEqual(Policy.warehouseMaterials(staff, {}, [stock(1865, 100)], stored), [],
        'the real Sprite staff recipe cannot request Varnish already held in personal storage');
    assert.deepEqual(Policy.warehouseMaterials(staff, {}, [stock(1865, 100)], { 4045: stock(4045, 3) }), [],
        'stored finished components also cover the raw inputs of their recipe subtree');
    assert.deepEqual(Policy.warehouseMaterials(plan, bag, rows), [stock(1865, 47)],
        'personal warehouse withdrawals keep their existing bag-only ownership calculation');
}

async function plannerChecks() {
    const inventory = Life.inventorySummaryFromItems(
        invoke('GameServer/Bot/AI/BotGear').planFor({ classId: 27, level: 40 }).items);
    for (const [selfId, amount] of Policy.requirements(Recipes.resolveByRecipeId(443))) {
        if (![1865, 4045, 1887].includes(selfId)) inventory[selfId] = stock(selfId, amount);
    }
    const member = { characterId: id, classId: 27, level: 54, phase: 'cold',
        inventory, adena: 0, currentRegion: 'Giran', stats: { classId: 27 } };
    const recipes = Shops.availableRecipes(Shops.STATION_CRAFTER);
    const request = { member, spots: [], warehouseRows: [{ selfId: 1865, kind: 'Other.Material', amount: 100 }],
        options: { strategicTarget: { itemId: 92, slot: 14 }, craftRecipes: recipes,
            allowedRecipeIds: recipes.map(recipe => recipe.recipeId), throwOnError: true } };
    const channel = new ColdTableChannel();
    channel.register('personal_warehouse', { key: row => row[0], allRows: () => [storedRow] });
    const worker = new ClanPlanningCoordinator({ tableChannel: channel });
    try {
        for (const [stored, bag, expected] of [[90, 0, 0], [20, 43, 27], [0, 43, 47]]) {
            storedRow = Index.prepareRow([id, storedRow[1] + 1, stored ? [[1865, stored, 0]] : []]);
            channel.changed('personal_warehouse', storedRow);
            if (bag) inventory[1865] = stock(1865, bag);
            else delete inventory[1865];
            const plan = Planner.planForMember(member, [], request.warehouseRows, request.options);
            assert.equal(plan.recipeId, 443, 'the fixture plans the real Sprite staff craft');
            assert.equal(plan.warehouseMaterials.find(row => row.selfId === 1865)?.amount || 0, expected);
            assert.deepEqual(await worker.plan(request, Data), plan,
                'the real planning worker must consume personal warehouse full snapshots and updates');
        }
    } finally { await worker.shutdown(); }
}

async function handoffChecks() {
    const original = { init: Life.init, find: Life.findByCharacterId, save: Life.upsertState,
        transfer: Life.applyClanMaterialTransfer };
    const clan = { id: 99 }, goal = { goalKey: 'personal-stock-test', target: { memberId: id } };
    const plan = { strategy: 'craft', status: 'active', target: { selfId: 92, slot: 14 },
        materials: [stock(1865, 90)], warehouseMaterials: [stock(1865, 90)] };
    let state = { characterId: id, simulation: { revision: 1 }, inventory: { 1865: stock(1865, 43) }, stats: {} };
    const transfers = [];
    Life.init = async () => {};
    Life.findByCharacterId = async () => state;
    Life.upsertState = async next => (state = next);
    Life.applyClanMaterialTransfer = async request => {
        transfers.push(request);
        state = { ...state, inventory: { 1865: stock(1865, state.inventory[1865].amount + request.amount) },
            simulation: { revision: state.simulation.revision + 1 } };
        return { ok: true, state };
    };
    try {
        storedRow = Index.prepareRow([id, storedRow[1] + 1, [[1865, 90, 0]]]);
        assert.equal((await Equipment.assignPlan(state, plan, clan, goal)).ok, true);
        assert.equal(transfers.length, 0, 'an old plan cannot transfer resources acquired since planning');
        storedRow = Index.prepareRow([id, storedRow[1] + 1, [[1865, 20, 0]]]);
        assert.equal((await Equipment.assignPlan(state, plan, clan, goal)).ok, true);
        assert.deepEqual(transfers.map(request => [request.selfId, request.amount]), [[1865, 27]],
            'handoff recalculates the missing amount against the current bag and personal storage');
        assert.equal((await Equipment.assignPlan(state, plan, clan, goal)).ok, true);
        assert.equal(transfers.length, 1, 'replaying the old plan cannot withdraw the same deficit again');
    } finally {
        Life.init = original.init; Life.findByCharacterId = original.find; Life.upsertState = original.save;
        Life.applyClanMaterialTransfer = original.transfer;
    }
}

(async () => {
    try {
        policyChecks();
        Database.init();
        await plannerChecks();
        await handoffChecks();
        console.log('Clan warehouse personal stock: exact deficits, worker parity and stale handoffs passed');
    } finally {
        Index.useRowSource(null);
        await Database.close();
        fs.rmSync(isolated.directory, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
