const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const Database = invoke('Database');
const BotRoles = invoke('GameServer/Bot/AI/BotRoles');
const CraftShopService = invoke('GameServer/Bot/Economy/CraftShopService');
const GeneratedColdSeeder = invoke('GameServer/Bot/Population/GeneratedColdSeeder');

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
