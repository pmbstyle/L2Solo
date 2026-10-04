const assert = require('assert');
require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const Database = invoke('Database');
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const LifeEvents = invoke('GameServer/Bot/Population/BotLifeEvents');
const StaticBuyerService = invoke('GameServer/Bot/Economy/StaticBuyerService');
const StaticMerchantPricing = invoke('GameServer/Bot/Economy/StaticMerchantPricing');
const MarketTelemetry = invoke('GameServer/Bot/Economy/MarketTelemetry');
const Service = invoke('GameServer/Bot/Economy/ColdWealthCraftService');

// Craft levels come from the skill tree.
DataCache.init();

const originals = {
    items: DataCache.items,
    fetchCharacterRecipes: Database.fetchCharacterRecipes,
    fetchItems: Database.fetchItems,
    craftInventoryItems: Database.craftInventoryItems,
    resolveByRecipeId: Recipes.resolveByRecipeId,
    offers: AfkTrade.offers,
    buyFromShop: AfkTrade.buyFromShop,
    sellToShop: AfkTrade.sellToShop,
    upsertState: LifeState.upsertState,
    refreshInventory: LifeState.refreshInventory,
    applyNpcLiquidation: LifeState.applyNpcLiquidation,
    record: LifeEvents.record,
    buyersInTown: StaticBuyerService.buyersInTown,
    staticPriceFor: StaticMerchantPricing.priceFor,
    staticBuyerSale: MarketTelemetry.staticBuyerSale
};

async function run() {
    const productId = 999999;
    const recipe = { type: 'dwarven', recipeId: 90001, level: 4, productId,
        productCount: 1, successRate: 100, mpCost: 20,
        materials: [{ selfId: 1864, amount: 2 }, { selfId: 1865, amount: 1 }] };
    const sellStore = { afkTrade: true, storeType: AfkTrade.SELL };
    const buyStore = { afkTrade: true, storeType: AfkTrade.BUY };
    const purchases = [];
    let crafted = false;
    let sold = false;
    DataCache.items = [{ selfId: productId, template: { name: 'Test Component', kind: 'Other.Material' },
        etc: { stackable: true, slot: 0 } }];
    Database.fetchCharacterRecipes = async () => [{ recipeId: recipe.recipeId }];
    Database.fetchItems = async () => crafted
        ? [{ id: 30, selfId: productId, amount: 1, equipped: false }]
        : [{ id: 10, selfId: 1864, amount: 2 }, { id: 11, selfId: 1865, amount: 1 }];
    Database.craftInventoryItems = async (_characterId, exchange) => {
        assert.strictEqual(exchange.materials.length, 2);
        assert([80, 60].includes(exchange.mp), 'each craft consumes its recipe MP');
        assert.strictEqual(exchange.product.selfId, productId);
        crafted = true;
        return { product: { id: 30, amount: 1 } };
    };
    Recipes.resolveByRecipeId = (recipeId) => recipeId === recipe.recipeId ? recipe : null;
    AfkTrade.offers = (selfId, storeType) => {
        if (storeType === AfkTrade.BUY && selfId === productId) return [{
            sourceId: 9002, price: 50000, count: 1, store: buyStore
        }];
        if (storeType !== AfkTrade.SELL) return [];
        return selfId === 1864 || selfId === 1865 ? [{
            sourceId: 9003, price: selfId === 1864 ? 10000 : 5000,
            count: selfId === 1864 ? 2 : 1, store: sellStore
        }] : [];
    };
    AfkTrade.buyFromShop = async (_characterId, _store, selfId, amount, options) => {
        purchases.push({ selfId, amount, price: options.expectedPrice });
        return { coldState: { ...options.coldState,
            adena: options.coldState.adena - amount * options.expectedPrice } };
    };
    AfkTrade.sellToShop = async (_characterId, _store, selfId, amount, options) => {
        assert.strictEqual(selfId, productId);
        assert.strictEqual(amount, 1);
        assert.strictEqual(options.objectId, 30);
        sold = true;
        return { coldState: { ...options.coldState, adena: options.coldState.adena + 50000 } };
    };
    LifeState.upsertState = async (state) => state;
    LifeState.refreshInventory = async (state) => ({ ...state, inventory: {
        ...state.inventory, [productId]: { selfId: productId, amount: 1, name: 'Test Component' }
    } });
    LifeEvents.record = async () => null;
    const state = { characterId: 9001, accountName: 'bot_pop_test', name: 'Crafter', phase: 'cold',
        activity: 'hunting', level: 60, adena: 500000, vitals: { mp: 100 }, inventory: {},
        stats: { classId: 57, generatedIndex: 1787947094937 }, persona: { primaryDrive: 'wealth' } };
    assert.strictEqual(Service.eligible(state, 1000000), true,
        'ordinary generated dwarves must not be mistaken for fixed crafting stations');
    // Karma keeps a crafter from crafting for sale: any karma above 0 blocks
    // it; none, zero or negative karma does not.
    for (const [karma, blocked] of [[undefined, false], [null, false], [0, false], [-5, false], ['0', false], [NaN, false], [1, true], ['7', true], [45, true]]) {
        assert.strictEqual(Service.eligible({ ...state, stats: { ...state.stats, karma } }), !blocked,
            `wealth craft with karma ${karma}`);
    }
    // Only crafter classes craft for profit.
    assert.strictEqual(Service.eligible({ ...state, level: 36, stats: { ...state.stats, classId: 56 } }), true);
    assert.strictEqual(Service.eligible({ ...state, stats: { ...state.stats, classId: 55 } }), false,
        'a Bounty Hunter has Create Item but does not craft');
    assert.strictEqual(Service.eligible({ ...state, level: 78, stats: { ...state.stats, classId: 118 } }), true,
        'a Maestro crafts for profit like a Warsmith');
    // A recipe above the crafter's level (7 for a level-60 Warsmith) is skipped.
    recipe.level = 8;
    assert.strictEqual(Service.chooseOpportunity(state, [{ recipeId: recipe.recipeId }]), null,
        'a recipe above the craft level is skipped');
    recipe.level = 7;
    assert(Service.chooseOpportunity(state, [{ recipeId: recipe.recipeId }]), 'a recipe at the craft level is crafted');
    recipe.level = 4;
    // A crafter with a market gear plan keeps the plan's price and reserve out
    // of its input budget.
    const planning = (adena) => ({ ...state, adena, stats: { ...state.stats, equipmentPlan: {
        status: 'active', strategy: 'market', target: { selfId: 100, name: 'Planned Gear', slot: 7 },
        market: { town: 'Giran', price: 370000, sourceType: 'npc', reserve: 10000 } } } });
    assert(Service.chooseOpportunity(state, [{ recipeId: recipe.recipeId }]),
        'fixture: without a market plan the crafter can afford the inputs');
    assert.strictEqual(Service.chooseOpportunity(planning(state.adena), [{ recipeId: recipe.recipeId }]), null,
        'a crafter saving for market gear keeps its price and reserve out of the input budget');
    assert(Service.chooseOpportunity(planning(state.adena + 380000), [{ recipeId: recipe.recipeId }]),
        'with the purchase covered the rest of the wallet buys inputs');
    const result = await Service.tryCraft(state, 1000000);
    assert(result.crafted && result.sold);
    assert(crafted && sold);
    assert.deepStrictEqual(purchases.map((purchase) => purchase.amount), [2, 1]);
    assert.strictEqual(result.spent, 25000);
    assert.strictEqual(result.revenue, 50000);
    assert.strictEqual(result.state.stats.wealthCraft.profit, 25000);
    assert.strictEqual(Service.eligible(result.state), true,
        'a completed sale must not put the crafter on an arbitrary timer');
    crafted = false;
    sold = false;
    const repeat = await Service.tryCraft(result.state, 1000001);
    assert(repeat.crafted && repeat.sold,
        `the next lifecycle can craft again when materials and a funded buyer remain: ${repeat.reason}`);
    assert.strictEqual(purchases.length, 4);

    const leather = { type: 'dwarven', recipeId: 25, level: 1, productId: 1882,
        productCount: 1, successRate: 100, mpCost: 10,
        materials: [{ selfId: 1867, amount: 6 }] };
    DataCache.items = [{ selfId: 1882, template: { name: 'Leather', kind: 'Other.Material' },
        etc: { stackable: true } }];
    Database.fetchCharacterRecipes = async () => [{ recipeId: 25 }];
    Recipes.resolveByRecipeId = (recipeId) => recipeId === 25 ? leather : null;
    AfkTrade.offers = (selfId, type) => selfId === 1867 && type === AfkTrade.SELL
        ? [{ sourceId: 9003, price: 500, count: 6, store: sellStore }] : [];
    StaticBuyerService.buyersInTown = (town) => town === 'Giran'
        ? [{ name: 'FixedBuyer', items: [{ selfId: 1882 }] }] : [];
    StaticMerchantPricing.priceFor = () => 10000;
    MarketTelemetry.staticBuyerSale = () => null;
    crafted = false;
    Database.fetchItems = async () => crafted
        ? [{ id: 31, selfId: 1882, amount: 1, equipped: false }]
        : [{ id: 12, selfId: 1867, amount: 6 }];
    Database.craftInventoryItems = async (_characterId, exchange) => {
        assert.strictEqual(exchange.product.selfId, 1882);
        crafted = true;
    };
    LifeState.refreshInventory = async (current) => ({ ...current,
        inventory: { ...current.inventory, '1882': { selfId: 1882, amount: 1 } } });
    LifeState.applyNpcLiquidation = async (current, candidates) => {
        assert.deepStrictEqual(candidates.map((candidate) => candidate.selfId), [1882]);
        return { ...current, adena: current.adena + 10000,
            inventory: { ...current.inventory, '1882': { selfId: 1882, amount: 0 } } };
    };
    const fixedResult = await Service.tryCraft({ ...state, characterId: 9004, name: 'ResourceCrafter' }, 1000000);
    assert(fixedResult.crafted && fixedResult.sold, 'profitable resources can be sold to a fixed buyer');
    assert.strictEqual(fixedResult.state.stats.wealthCraft.profit, 7000);
    assert.strictEqual(fixedResult.state.stats.wealthCraft.cashGain, 7000);

    let emptyReads = 0;
    Database.fetchCharacterRecipes = async () => { emptyReads += 1; return []; };
    const idle = { ...state, characterId: 9005, name: 'WaitingCrafter' };
    assert.strictEqual((await Service.tryCraft(idle, 1000000)).reason, 'no_profit');
    assert.strictEqual((await Service.tryCraft(idle, 1000001)).reason, 'scan_cooldown');
    assert.strictEqual(emptyReads, 1, 'empty scans should not query recipes every lifecycle tick');
    assert.strictEqual((await Service.tryCraft(idle, 1000000 + 5 * 60 * 1000)).reason, 'no_profit');
    assert.strictEqual(emptyReads, 2, 'the market is checked again after a short idle interval');
}

run().then(() => console.log('Cold wealth craft checks passed')).catch((error) => {
    process.exitCode = 1;
    throw error;
}).finally(() => {
    DataCache.items = originals.items;
    Database.fetchCharacterRecipes = originals.fetchCharacterRecipes;
    Database.fetchItems = originals.fetchItems;
    Database.craftInventoryItems = originals.craftInventoryItems;
    Recipes.resolveByRecipeId = originals.resolveByRecipeId;
    AfkTrade.offers = originals.offers;
    AfkTrade.buyFromShop = originals.buyFromShop;
    AfkTrade.sellToShop = originals.sellToShop;
    LifeState.upsertState = originals.upsertState;
    LifeState.refreshInventory = originals.refreshInventory;
    LifeState.applyNpcLiquidation = originals.applyNpcLiquidation;
    LifeEvents.record = originals.record;
    StaticBuyerService.buyersInTown = originals.buyersInTown;
    StaticMerchantPricing.priceFor = originals.staticPriceFor;
    MarketTelemetry.staticBuyerSale = originals.staticBuyerSale;
});
