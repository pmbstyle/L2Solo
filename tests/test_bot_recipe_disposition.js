const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const Database = invoke('Database');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const MarketListingPolicy = invoke('GameServer/Bot/Economy/MarketListingPolicy');
const C4RecipeItems = invoke('GameServer/Items/C4RecipeItems');

DataCache.init();

const recipe = C4RecipeItems.resolve(2298);
const lowGradeRecipe = C4RecipeItems.resolve(2250);
const spellbook = DataCache.items.find((item) => /spellbook/i.test(item?.template?.name || ''));
assert(recipe && lowGradeRecipe && spellbook, 'the datapack must contain recipe and spellbook fixtures');

const original = {
    fetchCharacterRecipes: Database.fetchCharacterRecipes,
    setCharacterRecipe: Database.setCharacterRecipe,
    syncInventorySummary: Database.syncInventorySummary,
    upsertState: LifeState.upsertState
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
        'npc',
        'a recipe already present in the book must go to the NPC shop'
    );
    assert.strictEqual(
        ItemDisposition.recipeDisposition(craftState, craftState.inventory[2250], []).action,
        'npc',
        'a recipe producing below C-grade output must go to the NPC shop'
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
    Database.setCharacterRecipe = (characterId, recipeId, type) => {
        learned.push({ characterId, recipeId, type });
        return Promise.resolve();
    };
    Database.syncInventorySummary = () => Promise.resolve();
    LifeState.upsertState = (state) => Promise.resolve(state);

    const updated = await LifeState.learnCraftableRecipes(craftState);
    assert.deepStrictEqual(learned, [{ characterId: 7001, recipeId: recipe.recipeId, type: recipe.type }]);
    assert.strictEqual(updated.inventory[2298].amount, 1, 'learning must consume exactly one recipe item');
    assert.strictEqual(updated.inventory[2250].amount, 1, 'low-grade recipes must remain for NPC liquidation');
    assert.strictEqual(updated.inventory[spellbook.selfId].amount, 1, 'spellbooks must remain for NPC liquidation');
    assert.strictEqual(updated.stats.lastRecipeBookLearning.learned[0].recipeId, recipe.recipeId);

    console.log('Bot recipe disposition checks passed');
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => {
    Database.fetchCharacterRecipes = original.fetchCharacterRecipes;
    Database.setCharacterRecipe = original.setCharacterRecipe;
    Database.syncInventorySummary = original.syncInventorySummary;
    LifeState.upsertState = original.upsertState;
    LifeState.reset?.();
});
