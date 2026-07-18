const assert = require('assert');

require('../src/Global');

const Database = invoke('Database');
const Shared = invoke('GameServer/Network/Shared');
const Backpack = invoke('GameServer/Actor/Backpack');

const originalFetchCharacters = Database.fetchCharacters;
const originalFetchItems = Database.fetchItems;
const originalFetchCharacterRecipes = Database.fetchCharacterRecipes;
const originalSetCharacterRecipe = Database.setCharacterRecipe;

async function run() {
    const saved = [];
    Database.setCharacterRecipe = (characterId, recipeId, type) => {
        saved.push({ characterId, recipeId, type });
        return Promise.resolve();
    };

    const backpack = new Backpack({ paperdoll: Array.from({ length: 16 }, () => ({})), items: [] });
    const actor = {
        model: {},
        fetchId: () => 77,
        fetchName: () => 'RecipeTester'
    };
    backpack.registerRecipe(actor, { recipeId: 1, recipeItemId: 1666, type: 'dwarven', level: 1, productId: 17, productCount: 500, successRate: 100, mpCost: 30 });
    assert.deepStrictEqual(saved, [{ characterId: 77, recipeId: 1, type: 'dwarven' }], 'Learning a recipe must persist its character, recipe, and book type');

    Database.fetchCharacters = () => Promise.resolve([{ id: 77, name: 'RecipeTester' }]);
    Database.fetchItems = () => Promise.resolve([]);
    Database.fetchCharacterRecipes = () => Promise.resolve([
        { recipeId: 1, type: 'dwarven' },
        { recipeId: 303, type: 'common' }
    ]);
    const [loaded] = await Shared.fetchCharacters('recipe-account');
    assert.deepStrictEqual(loaded.dwarvenRecipes, [{ recipeId: 1, type: 'dwarven' }], 'Character reload must hydrate the dwarven recipe book');
    assert.deepStrictEqual(loaded.commonRecipes, [{ recipeId: 303, type: 'common' }], 'Character reload must hydrate the common recipe book');

    console.log('Recipe persistence checks passed');
}

run().finally(() => {
    Database.fetchCharacters = originalFetchCharacters;
    Database.fetchItems = originalFetchItems;
    Database.fetchCharacterRecipes = originalFetchCharacterRecipes;
    Database.setCharacterRecipe = originalSetCharacterRecipe;
}).catch((error) => {
    process.exitCode = 1;
    throw error;
});
