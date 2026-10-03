const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const C4RecipeItems = invoke('GameServer/Items/C4RecipeItems');
const CraftShopService = invoke('GameServer/Bot/Economy/CraftShopService');
const ColdCraftingService = invoke('GameServer/Bot/Economy/ColdCraftingService');

DataCache.init();

// The published station recipes were computed in five places on every call.
// They now come from one table built per item catalogue; it must describe the
// same recipes and stations as a direct computation from the station layout.
const stationService = { level: 70, stats: { classId: 57 } };
const itemIds = new Set(DataCache.items.map((item) => Number(item.selfId)));
const direct = (craftLevel) => [...new Map(Object.values(C4RecipeItems.loadRecipeItems())
    .filter((recipe) => recipe?.type === 'dwarven' && Number(recipe.level || 0) <= craftLevel
        && itemIds.has(Number(recipe.productId)))
    .map((recipe) => [Number(recipe.recipeId), recipe])).values()]
    .sort((a, b) => Number(a.recipeId) - Number(b.recipeId));

for (const [state, craftLevel] of [[stationService, 9], [{ level: 40, stats: { classId: 56 } }, 4], [{ level: 45, stats: { classId: 57 } }, 5]]) {
    assert.strictEqual(CraftShopService.craftLevelFor(state), craftLevel, 'fixture: craft level');
    assert.deepStrictEqual(CraftShopService.availableRecipes(state).map((recipe) => recipe.recipeId),
        direct(craftLevel).map((recipe) => recipe.recipeId), `craft level ${craftLevel} must see every dwarven recipe up to its level`);
}
assert.deepStrictEqual(CraftShopService.availableRecipes({ level: 70, stats: { classId: 0 } }), [],
    'a non-crafter has no service recipes');

const allowed = direct(9);
const firstStation = new Map();
for (const station of CraftShopService.CraftStations) {
    for (const recipe of CraftShopService.stationRecipes(station, allowed)) {
        if (!firstStation.has(Number(recipe.recipeId))) firstStation.set(Number(recipe.recipeId), station.id);
    }
}
const published = CraftShopService.publishedStationRecipes();
assert(published.recipes.length > 100, 'fixture: the stations publish the progression catalogue');
assert.deepStrictEqual(published.recipes.map((recipe) => Number(recipe.recipeId)), [...firstStation.keys()],
    'every published recipe once, in station order');
assert.deepStrictEqual([...published.ids], [...firstStation.keys()]);
for (const [recipeId, stationId] of firstStation) {
    assert.strictEqual(published.stationByRecipeId.get(recipeId).id, stationId, `recipe ${recipeId} goes to its first station`);
    assert.strictEqual(ColdCraftingService.stationForRecipe(recipeId).id, stationId, `cold crafting routes recipe ${recipeId} to the same station`);
}

assert.strictEqual(CraftShopService.publishedStationRecipes(), published, 'the table is built once per item catalogue');
const originalItems = DataCache.items;
DataCache.items = originalItems.filter((item) => Number(item.selfId) !== Number(published.recipes[0].productId));
try {
    assert(!CraftShopService.publishedStationRecipes().ids.has(Number(published.recipes[0].recipeId)),
        'a changed item catalogue rebuilds the table');
} finally {
    DataCache.items = originalItems;
}
console.log('Craft station catalogue checks passed');
