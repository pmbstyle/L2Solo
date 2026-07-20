const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const Database = invoke('Database');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const ColdCraftingService = invoke('GameServer/Bot/Economy/ColdCraftingService');
const Recipes = invoke('GameServer/Items/C4RecipeItems');

DataCache.init();

const originals = {
    fetchCharacters: Database.fetchCharacters,
    fetchItems: Database.fetchItems,
    craftForCustomer: Database.craftForCustomer,
    findByCharacterId: LifeState.findByCharacterId,
    upsertState: LifeState.upsertState,
    refreshInventory: LifeState.refreshInventory
};

async function run() {
    const finalRecipe = Recipes.resolveByRecipeId(189);
    const componentRecipe = Recipes.resolveByRecipeId(29);
    const items = componentRecipe.materials.map((material, index) => ({
        id: index + 1,
        selfId: material.selfId,
        amount: material.amount * 3
    }));
    items.push({ id: 99, selfId: 57, amount: 100000 });
    const inventory = Object.fromEntries(items.map((item) => [item.selfId, { ...item }]));
    finalRecipe.materials
        .filter((material) => Number(material.selfId) !== Number(componentRecipe.productId))
        .forEach((material) => {
            inventory[material.selfId] = { selfId: material.selfId, amount: material.amount };
        });

    Database.fetchCharacters = async () => [{ id: 900 }];
    Database.fetchItems = async () => items;
    let exchange = null;
    Database.craftForCustomer = async (_crafterId, _customerId, value) => {
        exchange = value;
        return { ok: true };
    };
    LifeState.findByCharacterId = async () => ({
        characterId: 900,
        level: 70,
        phase: 'cold',
        vitals: { mp: 1, maxMp: 1000 },
        stats: { classId: 57, craftStationId: 'resource_core' }
    });
    LifeState.upsertState = async (state) => state;
    LifeState.refreshInventory = async (state) => {
        assert.deepStrictEqual(state.inventory, {}, 'craft reconciliation must rebuild inventory from physical item rows after consuming a component');
        return {
        ...state,
        inventory: {
            ...state.inventory,
            1870: { selfId: 1870, amount: 0 },
            1871: { selfId: 1871, amount: 0 },
            1879: { selfId: 1879, amount: 3 }
        }
        };
    };

    const result = await ColdCraftingService.craft({
        characterId: 42,
        name: 'ComponentProbe',
        phase: 'cold',
        level: 30,
        activity: 'crafting',
        loc: { locX: 83396, locY: 147904, locZ: -3400 },
        inventory,
        stats: {
            equipmentPlan: { status: 'ready_to_craft', strategy: 'craft', recipeId: finalRecipe.recipeId },
            craftReturn: { loc: { locX: -8200, locY: 11300, locZ: -3100 }, spotId: '2_-24', regionName: 'Wandering' }
        }
    }, () => 0);

    assert.strictEqual(result.reason, 'component_crafted', 'the ready nested resource must be crafted before the final equipment');
    assert.strictEqual(exchange.crafterMp, 1, 'a public crafting station must not consume its MP for a cold manufacture');
    assert.strictEqual(exchange.product.amount, 3, 'a ready component batch must produce every prepared unit in one station exchange');
    assert(exchange.materials.every((material) => material.amount % 3 === 0), 'a component batch must consume materials for its full prepared quantity');
    assert.strictEqual(result.state.activity, 'traveling', 'a component craft without enough raw inputs for the next batch must leave the Giran station');
    assert.strictEqual(result.state.stats.travel.reason, 'component_craft_return', 'component crafting must return through the gatekeeper before resuming material farming');

    Database.fetchItems = async () => [];
    LifeState.refreshInventory = async (state) => {
        assert.deepStrictEqual(state.inventory, {}, 'a stale craft attempt must discard its virtual material snapshot');
        return { ...state, inventory: {} };
    };
    const stale = await ColdCraftingService.craft({
        characterId: 42,
        name: 'StaleComponentProbe',
        phase: 'cold',
        level: 30,
        activity: 'crafting',
        inventory,
        stats: { equipmentPlan: { status: 'ready_to_craft', strategy: 'craft', recipeId: finalRecipe.recipeId } }
    });
    assert.strictEqual(stale.reason, 'materials_changed', 'a virtual-only material must not be sent to a public station');
    assert.deepStrictEqual(stale.state.inventory, {}, 'the following acquisition plan must see the physical inventory only');

    const adenaItems = componentRecipe.materials.map((material, index) => ({
        id: index + 1,
        selfId: material.selfId,
        amount: material.amount
    }));
    adenaItems.push({ id: 99, selfId: 57, amount: 0 });
    Database.fetchItems = async () => adenaItems;
    LifeState.refreshInventory = async (state) => ({ ...state, inventory: {} });
    const unaffordable = await ColdCraftingService.craft({
        characterId: 42,
        name: 'UnfundedComponentProbe',
        phase: 'cold',
        level: 30,
        activity: 'crafting',
        inventory: Object.fromEntries(adenaItems.map((item) => [item.selfId, { ...item }])),
        stats: { equipmentPlan: { status: 'ready_to_craft', strategy: 'craft', recipeId: finalRecipe.recipeId } }
    });
    assert.strictEqual(unaffordable.reason, 'insufficient_adena', 'an unaffordable batch must remain a local bot outcome rather than reject the scheduler');
    console.log('Bot cold component chain checks passed');
}

run().catch((err) => {
    console.error(err);
    process.exitCode = 1;
}).finally(() => {
    Object.assign(Database, {
        fetchCharacters: originals.fetchCharacters,
        fetchItems: originals.fetchItems,
        craftForCustomer: originals.craftForCustomer
    });
    Object.assign(LifeState, {
        findByCharacterId: originals.findByCharacterId,
        upsertState: originals.upsertState,
        refreshInventory: originals.refreshInventory
    });
});
