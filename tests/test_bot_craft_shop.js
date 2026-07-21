const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const Database = invoke('Database');
const BotRoles = invoke('GameServer/Bot/AI/BotRoles');
const CraftShopService = invoke('GameServer/Bot/Economy/CraftShopService');
const GeneratedColdSeeder = invoke('GameServer/Bot/Population/GeneratedColdSeeder');
const C4RecipeItems = invoke('GameServer/Items/C4RecipeItems');
const ColdMarketListingService = invoke('GameServer/Bot/Economy/ColdMarketListingService');

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

    assert.strictEqual(CraftShopService.CraftStations.length, 31, 'Giran must expose the full D/C/B/A/S market, resources and progressive C weapons');
    assert.strictEqual(new Set(CraftShopService.GiranCraftStalls.map((loc) => `${loc.locX}:${loc.locY}:${loc.locZ}`)).size, 31, 'every craft station must have its own stall');
    assert(CraftShopService.GiranCraftStalls.every((loc) => ColdMarketListingService.isGiranPlazaStallLocation(loc)), 'every craft station must remain in the actual sellable Giran plaza footprint');
    const outer = { minX: 80971, maxX: 82887, minY: 147722, maxY: 149490 };
    const width = outer.maxX - outer.minX;
    const height = outer.maxY - outer.minY;
    const perimeter = 2 * (width + height);
    const perimeterPosition = (loc) => {
        if (Number(loc.locY) === outer.minY) return Number(loc.locX) - outer.minX;
        if (Number(loc.locX) === outer.maxX) return width + Number(loc.locY) - outer.minY;
        if (Number(loc.locY) === outer.maxY) return width + height + outer.maxX - Number(loc.locX);
        return 2 * width + height + outer.maxY - Number(loc.locY);
    };
    const positions = CraftShopService.GiranCraftStalls.map(perimeterPosition);
    const adjacentDistances = positions.map((position, index) => {
        const next = positions[(index + 1) % positions.length];
        return (next - position + perimeter) % perimeter;
    });
    assert(Math.max(...adjacentDistances) - Math.min(...adjacentDistances) <= 2, 'craft stations must be evenly spaced around the outer Giran perimeter');
    CraftShopService.CraftStations.forEach((station, index) => {
        assert.strictEqual(
            CraftShopService.stationForSlot(10000 + index).id,
            station.id,
            `generated craft service ${index + 1} must stay bound to ${station.id}`
        );
        assert.strictEqual(
            CraftShopService.stationFor({
                accountName: `bot_craft_${String(index + 1).padStart(2, '0')}`,
                stats: { generatedIndex: 10000 + index, craftStationId: 'd_heavy' }
            }).id,
            station.id,
            `generated craft service ${index + 1} must repair a stale station id`
        );
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

    ['a_heavy_elite', 's_heavy', 's_robe', 's_light', 's_weapons', 's_jewelry', 'resource_core', 'resource_master', 'c_weapons_entry', 'c_weapons_mid', 'c_weapons_late'].forEach((stationId) => {
        const station = CraftShopService.CraftStations.find((entry) => entry.id === stationId);
        assert(station, `${stationId} must have a dedicated Giran station`);
    });
    const cWeaponStations = ['c_weapons_entry', 'c_weapons_mid', 'c_weapons_late', 'c_weapons_top']
        .map((stationId) => CraftShopService.CraftStations.find((station) => station.id === stationId));
    assert(cWeaponStations.every(Boolean), 'every C weapon progression tier must have a visible station');
    assert(cWeaponStations.slice(1).every((station, index) => {
        const previous = cWeaponStations[index];
        return Math.hypot(Number(station.loc.locX) - Number(previous.loc.locX), Number(station.loc.locY) - Number(previous.loc.locY)) < 250;
    }), 'C weapon progression must remain a contiguous group on the outer market perimeter');

    const nonDroppableResources = [1883, 1886, 1887, 1888, 1890, 1891, 1892, 1893, 5220, 5550, 5551, 4045, 4046, 4047, 4048, 5552, 5553, 5554];
    const resourceRecipeIds = new Set(CraftShopService.CraftStations
        .filter((station) => station.grade === 'resource')
        .flatMap((station) => station.recipeIds));
    nonDroppableResources.forEach((itemId) => {
        const recipe = C4RecipeItems.resolveByProductId(itemId);
        assert(recipe && resourceRecipeIds.has(recipe.recipeId), `crafted-only resource ${itemId} must have a Giran crafting station`);
        const isDropped = (DataCache.npcRewards || []).some((reward) => ['rewards', 'spoils'].some((kind) => (
            (reward[kind] || []).some((group) => (group.items || []).some((item) => Number(item.selfId) === itemId))
        )));
        assert.strictEqual(isDropped, false, `crafted-only resource ${itemId} must not be sourced as a direct NPC drop or spoil`);
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
        level: 70,
        exp: 123,
        sp: 456,
        phase: 'cold',
        activity: 'crafting',
        currentRegion: 'Giran',
        stats: { classId: 57, role: 'crafter', generatedIndex: 10000 }
    });
    assert.strictEqual(seedSelection.state.phase, 'hot', 'a repeated seed must retain the active craft service lifecycle');
    assert.strictEqual(seedSelection.state.level, 70, 'an existing craft service must be upgraded to its canonical level');
    assert.strictEqual(seedSelection.state.stats.classId, 57, 'an existing craft service must be upgraded to Warsmith');
    assert.strictEqual(seedSelection.shouldSeedState, false, 'an existing craft service with a shop must not be reinserted as cold');

    console.log('Bot craft shop checks passed');
}

run().finally(() => {
    Database.setCharacterRecipe = originalSetCharacterRecipe;
}).catch((error) => {
    process.exitCode = 1;
    throw error;
});
