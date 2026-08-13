const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const Database = invoke('Database');
const DualSwords = invoke('GameServer/Items/C4DualSwordCombinations');
const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const ColdCraftingService = invoke('GameServer/Bot/Economy/ColdCraftingService');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const ShoppingState = invoke('GameServer/Bot/AI/States/ShoppingState');
const TradeService = invoke('GameServer/Bot/TradeService');
const BotEquipmentUpgrade = invoke('GameServer/Bot/AI/BotEquipmentUpgrade');
const World = invoke('GameServer/World/World');

DataCache.init();

const saberRevolution = DualSwords.resolveByProductId(2523);
const saberSaber = DualSwords.resolveByProductId(2516);
const shamshirCaliburs = DualSwords.resolveByProductId(2576);
const stormbringerCaliburs = DualSwords.resolveByProductId(2566);
assert.strictEqual(DualSwords.loadRecipes().length, 110, 'every C4 blacksmith dual-sword result must be represented');
assert(DualSwords.loadRecipes().every((recipe) => (
    recipe.materials.reduce((sum, material) => sum + Number(material.amount || 0), 0) === 2
)), 'bot dual-sword exchanges must contain exactly two swords and no crystals, stones, stamps, or Adena');
assert.deepStrictEqual(saberRevolution.materials, [
    { selfId: 123, amount: 1 },
    { selfId: 129, amount: 1 }
], 'Saber*Sword of Revolution must require only its two source swords for bots');
assert.deepStrictEqual(saberSaber.materials, [
    { selfId: 123, amount: 2 }
], 'an identical-sword combination must reserve and consume two physical copies');
assert.strictEqual(saberSaber.station.id, 'blacksmith_pushkin', 'generic multisell 1001 combinations must use a standard blacksmith');
assert.strictEqual(shamshirCaliburs.station.id, 'blacksmith_wilbert', 'Wilbert-specific combinations must retain their native smith');
assert.strictEqual(stormbringerCaliburs.station.id, 'blacksmith_helton', 'Helton-specific combinations must retain their native smith');

function stateFor(recipe, inventory) {
    return {
        characterId: 42,
        name: 'DualProbe',
        phase: 'cold',
        level: 40,
        adena: 20000000,
        activity: 'hunting',
        currentRegion: 'Giran',
        loc: { locX: 83000, locY: 148000, locZ: -3400 },
        inventory: {
            57: { selfId: 57, amount: 20000000, stackable: true },
            ...inventory
        },
        stats: { classId: 2, role: 'dps', forcedRecipeId: recipe.recipeId }
    };
}

const oneSaber = stateFor(saberRevolution, {
    123: { selfId: 123, name: 'Saber', amount: 1, equipped: true, equippedCount: 1, equippedSlots: [7], slot: 7, rank: 'd', kind: 'Weapon.Sword' }
});
const marketPlan = GearAcquisitionPlanner.planFor(oneSaber, {
    recipeId: saberRevolution.recipeId,
    spots: [],
    findMarketOffer: (item) => Number(item.selfId) === 129
        ? { selfId: 129, price: 100000, town: 'Giran', sourceType: 'npc' }
        : null
});
assert.strictEqual(marketPlan.strategy, 'market', 'a missing source sword sold by an NPC or bot must use the ordinary market route');
assert.strictEqual(marketPlan.target.selfId, 129, 'the market goal must buy the missing Sword of Revolution, not the finished dual sword');
assert.strictEqual(marketPlan.combine.resultId, 2523, 'the component purchase must retain its final dual-sword objective');
assert.deepStrictEqual(ItemDisposition.saleCandidates({
    ...oneSaber,
    stats: { ...oneSaber.stats, equipmentPlan: marketPlan }
}), [], 'a sword reserved for an active dual combination must not be listed or liquidated');

const duplicatePlan = GearAcquisitionPlanner.planFor(stateFor(saberSaber, {
    123: { selfId: 123, name: 'Saber', amount: 1, equipped: true, equippedCount: 1, equippedSlots: [7], slot: 7, rank: 'd', kind: 'Weapon.Sword' }
}), {
    recipeId: saberSaber.recipeId,
    spots: [],
    findMarketOffer: (item) => Number(item.selfId) === 123
        ? { selfId: 123, price: 100000, town: 'Giran', sourceType: 'cold_store' }
        : null
});
const duplicateState = {
    ...stateFor(saberSaber, {
        123: { selfId: 123, name: 'Saber', amount: 1, equipped: true, equippedCount: 1, equippedSlots: [7], slot: 7, rank: 'd', kind: 'Weapon.Sword' }
    }),
    stats: { classId: 2, role: 'dps', equipmentPlan: duplicatePlan }
};
assert.strictEqual(LifeState.marketPurchaseBlocker(duplicateState, { selfId: 123 }, 1), null,
    'the active Saber*Saber objective must allow buying its reserved second non-stackable Saber');
assert.strictEqual(LifeState.marketPurchaseBlocker({ ...duplicateState, stats: { classId: 2 } }, { selfId: 123 }, 1), 'already_owned',
    'ordinary equipment purchases must retain the one-copy duplicate guard');

const readyState = stateFor(saberRevolution, {
    123: { selfId: 123, name: 'Saber', amount: 1, equipped: true, equippedCount: 1, equippedSlots: [7], slot: 7, rank: 'd', kind: 'Weapon.Sword' },
    129: { selfId: 129, name: 'Sword of Revolution', amount: 1, equipped: false, equippedCount: 0, equippedSlots: [], slot: 7, rank: 'd', kind: 'Weapon.Sword' }
});
const readyPlan = GearAcquisitionPlanner.planFor(readyState, {
    recipeId: saberRevolution.recipeId,
    spots: [],
    findMarketOffer: () => null
});
assert.strictEqual(readyPlan.status, 'ready_to_craft', 'two source swords must make the blacksmith exchange ready');
assert.strictEqual(readyPlan.combine.stationId, 'blacksmith_pushkin');
const travel = ColdCraftingService.beginTravel({
    ...readyState,
    stats: { ...readyState.stats, equipmentPlan: readyPlan }
}, 1000);
assert.strictEqual(travel.stats.travel.reason, 'dual_sword_combine');
assert.strictEqual(travel.stats.travel.townName, 'Giran');
assert.strictEqual(travel.stats.travel.arrivalActivity, 'crafting');

const originals = {
    fetchItems: Database.fetchItems,
    combineInventoryItems: Database.combineInventoryItems,
    refreshInventory: LifeState.refreshInventory,
    buyFromStore: TradeService.buyFromStore,
    applyBestUpgrades: BotEquipmentUpgrade.applyBestUpgrades,
    scheduleRestock: ShoppingState.scheduleRestock,
    worldUser: World.user
};

async function run() {
    const physical = [
        { id: 1, selfId: 123, amount: 1, equipped: 1, slot: 7 },
        { id: 2, selfId: 129, amount: 1, equipped: 0, slot: 0 },
        { id: 3, selfId: 57, amount: 20000000, equipped: 0, slot: 0 }
    ];
    Database.fetchItems = async () => physical;
    let exchange = null;
    Database.combineInventoryItems = async (characterId, value) => {
        exchange = { characterId, ...value };
        return { product: { id: 99, selfId: value.product.selfId, amount: 1 } };
    };
    LifeState.refreshInventory = async (state) => ({
        ...state,
        inventory: {
            57: { selfId: 57, amount: 20000000 },
            2523: { selfId: 2523, name: 'Saber*Sword of Revolution', amount: 1, equipped: true, slot: 14, kind: 'Weapon.Dual', rank: 'c' }
        }
    });

    const result = await ColdCraftingService.craft({
        ...readyState,
        activity: 'crafting',
        stats: { ...readyState.stats, equipmentPlan: readyPlan }
    });
    assert.strictEqual(result.reason, 'dual_sword_combined');
    assert.strictEqual(result.productId, 2523);
    assert.deepStrictEqual(exchange.ingredients, saberRevolution.materials,
        'the bot exchange must consume only the two source swords');
    assert.strictEqual(exchange.product.selfId, 2523);
    assert.strictEqual(exchange.product.amount, 1);
    assert.strictEqual(result.state.inventory[57].amount, 20000000,
        'the blacksmith exchange must not charge bot Adena');

    const sellerStore = { storeType: 1, items: [{ selfId: 129, count: 1, price: 100000 }] };
    const seller = {
        fetchId: () => 77,
        fetchName: () => 'BladeSeller',
        fetchPrivateStore: () => sellerStore
    };
    World.user = { sessions: [{ actor: seller }] };
    TradeService.buyFromStore = async () => ({ qty: 1, name: 'Sword of Revolution', totalAdena: 100000 });
    BotEquipmentUpgrade.applyBestUpgrades = () => {};
    ShoppingState.scheduleRestock = () => {};
    const hotPurchaseSession = {
        coldLifeState: {
            ...oneSaber,
            stats: { ...oneSaber.stats, equipmentPlan: marketPlan }
        },
        companionShopping: {
            kind: 'market_purchase',
            itemId: 129,
            target: { actorId: 77 }
        }
    };
    await ShoppingState.sellAndRestock(hotPurchaseSession, {
        fetchId: () => 42,
        fetchName: () => 'DualProbe',
        backpack: {
            fetchItemFromSelfId: (selfId) => Number(selfId) === 57 ? { fetchAmount: () => 19900000 } : null
        }
    }, null, { say() {} });
    assert.strictEqual(hotPurchaseSession.coldLifeState.stats.equipmentPlan.combine.resultId, 2523,
        'a hot private-store component purchase must retain the final dual-sword plan');
    console.log('Bot dual-sword combine checks passed');
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => {
    Database.fetchItems = originals.fetchItems;
    Database.combineInventoryItems = originals.combineInventoryItems;
    LifeState.refreshInventory = originals.refreshInventory;
    TradeService.buyFromStore = originals.buyFromStore;
    BotEquipmentUpgrade.applyBestUpgrades = originals.applyBestUpgrades;
    ShoppingState.scheduleRestock = originals.scheduleRestock;
    World.user = originals.worldUser;
});
