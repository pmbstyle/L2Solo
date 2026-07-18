const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const Database = invoke('Database');
const BotRoles = invoke('GameServer/Bot/AI/BotRoles');
const CraftShopService = invoke('GameServer/Bot/Economy/CraftShopService');
const GeneratedColdSeeder = invoke('GameServer/Bot/Population/GeneratedColdSeeder');
const C4RecipeItems = invoke('GameServer/Items/C4RecipeItems');

DataCache.init();

const originalSetCharacterRecipe = Database.setCharacterRecipe;

async function run() {
    const artisan = {
        characterId: 120,
        level: 28,
        stats: { classId: 56 }
    };
    assert.strictEqual(BotRoles.inferRole(56), 'crafter', 'Artisan must no longer be treated as generic DPS');
    assert.strictEqual(BotRoles.inferRole(57), 'crafter', 'Warsmith must no longer be treated as generic DPS');
    assert.strictEqual(CraftShopService.isServiceCrafter(artisan), true);
    assert.strictEqual(CraftShopService.craftLevelFor(artisan), 3, 'Artisan craft level must match the C4 Create Item tree');

    const profile = CraftShopService.profileFor(artisan);
    assert.strictEqual(profile.type, 'dwarven');
    assert.strictEqual(profile.town, 'Giran');
    assert(profile.entries.length > 0 && profile.entries.length <= CraftShopService.MAX_PUBLIC_RECIPES, 'a service crafter must publish a compact recipe portfolio');
    assert(profile.entries.every((entry) => Number.isSafeInteger(entry.recipeId) && entry.price >= 0), 'published entries must be valid C4 manufacture offers');
    assert.deepStrictEqual(profile.loc, CraftShopService.locationFor(artisan.characterId), 'the Giran stall must remain stable across activation');

    const learned = [];
    Database.setCharacterRecipe = (characterId, recipeId, type) => {
        learned.push({ characterId, recipeId, type });
        return Promise.resolve();
    };
    await CraftShopService.ensureRecipes(artisan.characterId, profile);
    assert.deepStrictEqual(learned, profile.entries.map((entry) => ({
        characterId: artisan.characterId,
        recipeId: entry.recipeId,
        type: 'dwarven'
    })), 'the visible service portfolio must be persisted in the normal recipe book');

    const invalid = CraftShopService.profileFor({
        ...artisan,
        stats: {
            classId: 56,
            craftShop: {
                title: 'Custom smith',
                loc: { locX: 1, locY: 2, locZ: 3 },
                entries: [{ recipeId: 999999, price: 50 }]
            }
        }
    });
    assert.notStrictEqual(invalid.entries[0]?.recipeId, 999999, 'persisted offers must be revalidated against craft level and recipe data');
    assert.strictEqual(invalid.title, 'Custom smith');

    assert.strictEqual(CraftShopService.CraftStations.length, 26, 'Giran must expose the full D/C/B/A/S crafting market, including split A-heavy demand');
    CraftShopService.CraftStations.forEach((station, index) => {
        const service = {
            characterId: 10000 + index,
            level: 70,
            stats: {
                classId: 57,
                generatedIndex: 10000 + index,
                craftStationId: station.id
            }
        };
        const serviceProfile = CraftShopService.profileFor(service);
        assert.strictEqual(serviceProfile.title, station.title, `${station.id} must retain its readable plaza title`);
        assert.deepStrictEqual(serviceProfile.loc, station.loc, `${station.id} must keep its assigned Giran stall`);
        assert(serviceProfile.entries.length > 0, `${station.id} must publish craftable recipes`);
        serviceProfile.entries.forEach((entry) => {
            const recipe = C4RecipeItems.resolveByRecipeId(entry.recipeId);
            assert(recipe, `${station.id} must reference a real C4 recipe`);
            assert(DataCache.items.some((item) => item.selfId === recipe.productId), `${station.id} output must exist in the datapack`);
            [recipe.recipeItemId, ...recipe.materials.map((material) => material.selfId)].forEach((itemId) => {
                assert(DataCache.items.some((item) => item.selfId === itemId), `${station.id} material ${itemId} must exist in the datapack`);
            });
        });

        const staleProfile = CraftShopService.profileFor({
            ...service,
            stats: {
                ...service.stats,
                craftShop: {
                    stationId: station.id,
                    title: 'Old station title',
                    loc: { locX: 1, locY: 2, locZ: 3 },
                    entries: [{ recipeId: 999999, price: 50 }]
                }
            }
        });
        assert.strictEqual(staleProfile.title, station.title, `${station.id} must refresh a persisted station title`);
        assert.deepStrictEqual(staleProfile.loc, station.loc, `${station.id} must refresh a persisted station location`);
        assert.notStrictEqual(staleProfile.entries[0]?.recipeId, 999999, `${station.id} must refresh a persisted station catalogue`);
    });

    ['a_heavy_elite', 's_heavy', 's_robe', 's_light', 's_weapons', 's_jewelry'].forEach((stationId) => {
        const station = CraftShopService.CraftStations.find((entry) => entry.id === stationId);
        assert(station, `${stationId} must have a dedicated Giran station`);
    });

    const sealedAGradeRecipes = Object.values(C4RecipeItems.loadRecipeItems())
        .filter((recipe) => recipe.successRate === 100 && recipe.productId >= 5287 && recipe.productId <= 5329);
    assert.strictEqual(sealedAGradeRecipes.length, 29, 'all C4 sealed A-grade armor recipes must remain available');
    sealedAGradeRecipes.forEach((recipe) => {
        assert(DataCache.items.some((item) => item.selfId === recipe.productId), `sealed output ${recipe.productId} must exist in the datapack`);
        [recipe.recipeItemId, ...recipe.materials.map((material) => material.selfId)].forEach((itemId) => {
            assert(DataCache.items.some((item) => item.selfId === itemId), `sealed recipe ${recipe.recipeId} dependency ${itemId} must exist in the datapack`);
        });
    });

    const activeCraftState = {
        characterId: artisan.characterId,
        phase: 'hot',
        activity: 'crafting',
        stats: { classId: 56, craftShop: profile }
    };
    const seedSelection = GeneratedColdSeeder.craftServiceSeedState(activeCraftState, {
        characterId: artisan.characterId,
        phase: 'cold',
        activity: 'crafting'
    });
    assert.strictEqual(seedSelection.state, activeCraftState, 'a repeated seed must retain the active craft service state');
    assert.strictEqual(seedSelection.shouldSeedState, false, 'an existing craft service must not be reinserted as cold');

    console.log('Bot craft shop checks passed');
}

run().finally(() => {
    Database.setCharacterRecipe = originalSetCharacterRecipe;
}).catch((error) => {
    process.exitCode = 1;
    throw error;
});
