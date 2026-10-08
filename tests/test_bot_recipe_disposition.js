const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const Database = invoke('Database');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const MarketListingPolicy = invoke('GameServer/Bot/Economy/MarketListingPolicy');
const MarketTownPolicy = invoke('GameServer/Bot/Economy/MarketTownPolicy');
const C4RecipeItems = invoke('GameServer/Items/C4RecipeItems');
const ColdMarketListingService = invoke('GameServer/Bot/Economy/ColdMarketListingService');
const MarketBuyerActivity = invoke('GameServer/Bot/Economy/MarketBuyerActivity');
const BotWarehouse = invoke('GameServer/Bot/Economy/BotWarehouseService');
const Commit = require('../src/GameServer/Bot/Economy/EconomyCommit');

DataCache.init();

const recipe = C4RecipeItems.resolve(2298);
const dRecipe = C4RecipeItems.resolve(2153);
const lowGradeRecipe = C4RecipeItems.resolve(2250);
const spellbook = DataCache.items.find((item) => item?.template?.kind === 'Other.Spellbook');
assert(recipe && dRecipe && lowGradeRecipe && spellbook,
    'the datapack must contain recipe and spellbook fixtures');

const original = {
    fetchCharacterRecipes: Database.fetchCharacterRecipes,
    setCharacterRecipe: Database.setCharacterRecipe,
    learnColdRecipes: Database.learnColdRecipes,
    acceptLifecycleRow: LifeState.acceptLifecycleRow,
    syncInventorySummary: Database.syncInventorySummary,
    upsertState: LifeState.upsertState,
    learnCraftableRecipes: LifeState.learnCraftableRecipes,
    applyNpcLiquidation: LifeState.applyNpcLiquidation,
    refreshBuyerActivity: MarketBuyerActivity.refresh,
    depositCold: BotWarehouse.depositCold,
    admit: Commit.admit, finish: Commit.finish
};

async function run() {
    const craftState = {
        characterId: 7001,
        level: 36,
        classId: 56,
        stats: { classId: 56 },
        inventory: {
            2298: { selfId: 2298, name: 'Recipe: Stormbringer', amount: 2, kind: 'Other.Recipe' },
            2250: { selfId: 2250, name: 'Recipe: Bone Arrow', amount: 1, kind: 'Other.Recipe' },
            [spellbook.selfId]: { selfId: spellbook.selfId, name: spellbook.template.name, amount: 1, kind: 'Other.Spellbook' }
        }
    };

    assert.deepStrictEqual(
        ItemDisposition.recipeDisposition(craftState, craftState.inventory[2298], []).action,
        'learn',
        'a C-grade recipe must be learned by a capable crafter when it is not known'
    );
    assert.strictEqual(
        ItemDisposition.recipeDisposition(craftState, craftState.inventory[2298], [recipe.recipeId]).action,
        'market',
        'a duplicate C-grade recipe remains available for another crafter'
    );
    const dRecipeItem = { selfId: 2153, name: "Recipe: Tiger's Eye Earring",
        amount: 1, kind: 'Other.Recipe' };
    assert.strictEqual(ItemDisposition.isNpcOnlyItem(dRecipeItem), false,
        'D-grade equipment recipes must be marketable');
    const dMarketItem = ItemDisposition.saleCandidates({ ...craftState, classId: 28,
        stats: { classId: 28 }, inventory: { 2153: dRecipeItem } },
    { unlimited: true }).find((item) => item.selfId === 2153);
    assert(dMarketItem, 'a non-crafter should sell a D-grade recipe');
    assert.strictEqual(dMarketItem.rank, 'd', 'recipe market grade follows its product');
    assert.strictEqual(MarketTownPolicy.targetTownForItems(craftState, [dMarketItem]),
        MarketTownPolicy.dGradeMarketFor(craftState));
    assert.strictEqual(MarketTownPolicy.targetTownForItems(craftState, [{ ...dMarketItem, selfId: 2298,
        rank: 'c' }]), 'Giran');
    assert.strictEqual(MarketListingPolicy.classify(craftState, dMarketItem).action, 'market',
        'a D-grade recipe is a market item like any other: no scarce-recipe listing, no recipe-only rule (group E)');
    for (const selfId of [1786, 1787, 1788]) {
        const scroll = { selfId, amount: 2, kind: 'Other.Recipe' };
        const info = C4RecipeItems.resolve(selfId);
        assert(info, 'the local world recipe must exist');
        assert.strictEqual(ItemDisposition.recipeProductRank(scroll), 'none');
        assert.strictEqual(ItemDisposition.isNpcOnlyItem(scroll), false,
            'a no-grade weapon recipe must reach the common market evaluation');
        assert.strictEqual(ItemDisposition.recipeDisposition(craftState, scroll, []).action, 'learn');
        assert.strictEqual(ItemDisposition.recipeDisposition(craftState, scroll, [info.recipeId]).action, 'market');
        const seller = { ...craftState, classId: 28, stats: { classId: 28 }, inventory: { [selfId]: scroll } };
        assert.strictEqual(ItemDisposition.canLearnRecipe(seller, scroll), false,
            'lifting the grade restriction does not make ordinary fighters crafters');
        const candidate = ItemDisposition.saleCandidates(seller, { unlimited: true }).find(item => item.selfId === selfId);
        assert(candidate);
        assert.strictEqual(MarketListingPolicy.classify(seller, candidate).action, 'market');
        assert.strictEqual(candidate.rank, 'none');
        assert.strictEqual(ItemDisposition.recipeDisposition({ ...craftState, craftLevel: 0 }, scroll, []).action, 'market',
            'insufficient craft skill still prevents learning');
    }
    assert.strictEqual(
        ItemDisposition.recipeDisposition(craftState, craftState.inventory[2250], []).action,
        'learn',
        'a capable crafter may learn a no-grade arrow recipe'
    );
    assert.strictEqual(
        MarketListingPolicy.classify(craftState, {
            selfId: spellbook.selfId,
            name: spellbook.template.name,
            kind: spellbook.template.kind,
            count: 1,
            price: 100,
            basePrice: Number(spellbook.template.price || 0)
        }).action,
        'npc',
        'all spellbooks must be NPC-only inventory'
    );

    const learned = [];
    Database.fetchCharacterRecipes = () => Promise.resolve([]);
    // This fixture checks selected-scroll routing only. Native admission,
    // retry and physical conservation are covered by disposable DB fixtures.
    Commit.admit = async (state, kind) => ({ state, command: ['97020995-80b8-4901-8438-e46329a7d004', kind, 0] });
    Commit.finish = () => {};
    Database.learnColdRecipes = async (characterId, recipes, state) => {
        const inventory = structuredClone(state.inventory);
        for (const recipe of recipes) {
            learned.push({ characterId, recipeId: recipe.recipeId, type: recipe.type });
            inventory[recipe.recipeItemId].amount--;
        }
        return { learned: recipes, coldLifeRow: { ...state, inventory, stats: { ...state.stats,
            lastRecipeBookLearning: { learned: recipes } } } };
    };
    LifeState.acceptLifecycleRow = state => state;
    Database.syncInventorySummary = () => Promise.resolve();
    LifeState.upsertState = (state) => Promise.resolve(state);

    assert.equal(await LifeState.learnCraftableRecipes(craftState), craftState,
        'no accepted economic craft route leaves unselected scrolls intact');
    const updated = await LifeState.learnCraftableRecipes(craftState, { recipeIds: [recipe.recipeId] });
    assert.deepStrictEqual(learned, [{ characterId: 7001, recipeId: recipe.recipeId, type: recipe.type }]);
    assert.strictEqual(updated.inventory[2298].amount, 1, 'learning must consume exactly one recipe item');
    assert.strictEqual(updated.inventory[2250].amount, 1, 'unselected no-grade recipes remain intact');
    assert.strictEqual(updated.inventory[spellbook.selfId].amount, 1, 'spellbooks must remain for NPC liquidation');
    assert.strictEqual(updated.stats.lastRecipeBookLearning.learned[0].recipeId, recipe.recipeId);

    // Material recipes are no-grade but feed every craft: a capable dwarf learns them.
    const leatherRecipe = C4RecipeItems.resolve(1814);
    assert(leatherRecipe && String(DataCache.items.find((item) => item.selfId === leatherRecipe.productId)
        ?.template?.kind).startsWith('Other.Material'), 'Recipe: Leather must make a material');
    const leatherItem = { selfId: 1814, name: 'Recipe: Leather', amount: 1, kind: 'Other.Recipe' };
    assert.strictEqual(ItemDisposition.recipeDisposition(craftState, leatherItem, []).action, 'learn',
        'a dwarf must learn a material recipe its craft level allows');
    assert.strictEqual(ItemDisposition.recipeDisposition(craftState, leatherItem, [leatherRecipe.recipeId]).action, 'market',
        'a known no-grade material recipe remains available to other crafters');
    assert.strictEqual(ItemDisposition.recipeDisposition({ ...craftState, classId: 28, stats: { classId: 28 } },
        leatherItem, []).action, 'market', 'a non-crafter may offer a material recipe on the market');
    assert.strictEqual(ItemDisposition.recipeDisposition({ characterId: 7003, level: 40, classId: 55, stats: { classId: 55 } },
        leatherItem, []).action, 'market', 'a Bounty Hunter may sell a recipe but cannot learn it for production');
    learned.length = 0;
    const materialCrafter = { ...craftState, characterId: 7002, inventory: { 1814: leatherItem } };
    const learnedMaterial = await LifeState.learnCraftableRecipes(materialCrafter, { recipeIds: [leatherRecipe.recipeId] });
    assert.deepStrictEqual(learned, [{ characterId: 7002, recipeId: leatherRecipe.recipeId, type: 'dwarven' }]);
    assert.strictEqual(learnedMaterial.inventory[1814].amount, 0, 'learning must consume the material recipe');

    // A cleanup during the sale pause learns first, as the sale path does.
    const calls = [];
    LifeState.learnCraftableRecipes = async (state) => {
        calls.push('learn');
        return { ...state, inventory: { ...state.inventory, 1814: { ...state.inventory[1814], amount: 0 } } };
    };
    LifeState.applyNpcLiquidation = async (state, candidates) => {
        calls.push(['npc', ...candidates.map((item) => Number(item.selfId))]);
        return state;
    };
    MarketBuyerActivity.refresh = async () => null;
    BotWarehouse.depositCold = async (state) => ({ state, count: 0 });
    await ColdMarketListingService.open({ ...materialCrafter, phase: 'cold', activity: 'shopping', level: 36,
        inventory: { ...materialCrafter.inventory, 2250: craftState.inventory[2250] },
        stats: { classId: 56, marketSellRetryAfter: 500000 } }, { now: 1000, forcedCleanup: { reason: 'npc_only_inventory' } });
    assert.deepStrictEqual(calls, ['learn', ['npc', 2250]],
        'a sale pause still allows ordinary NPC liquidation after evaluating market alternatives');

    console.log('Bot recipe disposition checks passed');
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => {
    Database.fetchCharacterRecipes = original.fetchCharacterRecipes;
    Database.setCharacterRecipe = original.setCharacterRecipe;
    Database.learnColdRecipes = original.learnColdRecipes;
    LifeState.acceptLifecycleRow = original.acceptLifecycleRow;
    Database.syncInventorySummary = original.syncInventorySummary;
    LifeState.upsertState = original.upsertState;
    LifeState.learnCraftableRecipes = original.learnCraftableRecipes;
    LifeState.applyNpcLiquidation = original.applyNpcLiquidation;
    MarketBuyerActivity.refresh = original.refreshBuyerActivity;
    BotWarehouse.depositCold = original.depositCold;
    Commit.admit = original.admit;
    Commit.finish = original.finish;
    LifeState.reset?.();
});
