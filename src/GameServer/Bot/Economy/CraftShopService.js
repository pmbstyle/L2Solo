const C4RecipeItems = invoke('GameServer/Items/C4RecipeItems');
const DataCache = invoke('GameServer/DataCache');
const Database = invoke('Database');

const MAX_PUBLIC_RECIPES = 5;
const GiranCraftStalls = Object.freeze([
    { locX: 81020, locY: 147780, locZ: -3466 },
    { locX: 81020, locY: 148130, locZ: -3466 },
    { locX: 81020, locY: 149120, locZ: -3466 },
    { locX: 81380, locY: 147780, locZ: -3466 },
    { locX: 81380, locY: 148130, locZ: -3466 },
    { locX: 81380, locY: 149120, locZ: -3466 },
    { locX: 82460, locY: 147780, locZ: -3466 },
    { locX: 82460, locY: 148130, locZ: -3466 },
    { locX: 82460, locY: 149120, locZ: -3466 },
    { locX: 82780, locY: 147780, locZ: -3466 },
    { locX: 82780, locY: 148130, locZ: -3466 },
    { locX: 82780, locY: 149120, locZ: -3466 }
]);

function isServiceCrafter(state = {}) {
    const classId = Number(state.classId || state.stats?.classId || 0);
    return classId === 56 || classId === 57;
}

function craftLevelFor(state = {}) {
    const classId = Number(state.classId || state.stats?.classId || 0);
    const level = Number(state.level || 1);
    if (classId === 57) {
        if (level >= 70) return 9;
        if (level >= 62) return 8;
        if (level >= 55) return 7;
        if (level >= 49) return 6;
        if (level >= 43) return 5;
        return 0;
    }
    if (classId === 56) {
        if (level >= 36) return 4;
        if (level >= 28) return 3;
        if (level >= 20) return 2;
    }
    return 0;
}

function locationFor(characterId) {
    const index = Math.abs(Number(characterId) || 0) % GiranCraftStalls.length;
    return { ...GiranCraftStalls[index] };
}

function productPrice(recipe) {
    const product = (DataCache.items || []).find((item) => Number(item.selfId) === Number(recipe.productId));
    const value = Number(product?.template?.price || 0) * Math.max(1, Number(recipe.productCount || 1));
    // A manufacture fee must remain a fee, not silently turn a player-supplied
    // recipe into an NPC shop. The cap also keeps malformed item prices from
    // producing unusable C4 dialogs.
    return Math.max(100, Math.min(100000, Math.round(value * 0.03) + Number(recipe.mpCost || 0) * 10));
}

function availableRecipes(state) {
    const craftLevel = craftLevelFor(state);
    if (!isServiceCrafter(state) || craftLevel <= 0) return [];
    const unique = new Map();
    Object.values(C4RecipeItems.loadRecipeItems() || {}).forEach((recipe) => {
        if (recipe?.type !== 'dwarven' || Number(recipe.level || 0) > craftLevel) return;
        if (!(DataCache.items || []).some((item) => Number(item.selfId) === Number(recipe.productId))) return;
        unique.set(Number(recipe.recipeId), recipe);
    });
    return [...unique.values()].sort((a, b) => Number(a.recipeId) - Number(b.recipeId));
}

function generatedEntries(state) {
    const recipes = availableRecipes(state);
    if (!recipes.length) return [];
    const start = Math.abs(Number(state.characterId) || 0) % recipes.length;
    const count = Math.min(MAX_PUBLIC_RECIPES, recipes.length);
    return Array.from({ length: count }, (_, offset) => {
        const recipe = recipes[(start + offset) % recipes.length];
        return { recipeId: Number(recipe.recipeId), price: productPrice(recipe) };
    });
}

function normalizeEntries(entries, state) {
    const allowed = new Map(availableRecipes(state).map((recipe) => [Number(recipe.recipeId), recipe]));
    const seen = new Set();
    return (Array.isArray(entries) ? entries : []).flatMap((entry) => {
        const recipeId = Number(entry?.recipeId);
        const recipe = allowed.get(recipeId);
        const price = Number(entry?.price);
        if (!recipe || seen.has(recipeId) || !Number.isSafeInteger(price) || price < 0) return [];
        seen.add(recipeId);
        return [{ recipeId, price }];
    }).slice(0, MAX_PUBLIC_RECIPES);
}

function profileFor(state = {}) {
    const current = state.stats?.craftShop || {};
    const entries = normalizeEntries(current.entries, state);
    const published = entries.length ? entries : generatedEntries(state);
    const craftLevel = craftLevelFor(state);
    return {
        type: 'dwarven',
        title: String(current.title || `Dwarven Craft Lv. ${craftLevel}`).slice(0, 52),
        town: 'Giran',
        loc: current.loc ? { ...current.loc } : locationFor(state.stats?.generatedIndex ?? state.characterId),
        entries: published
    };
}

function ensureRecipes(characterId, profile) {
    const recipeIds = [...new Set((profile?.entries || []).map((entry) => Number(entry.recipeId)).filter(Number.isSafeInteger))];
    return recipeIds.reduce((chain, recipeId) => (
        chain.then(() => Database.setCharacterRecipe(characterId, recipeId, 'dwarven'))
    ), Promise.resolve()).then(() => profile);
}

module.exports = {
    MAX_PUBLIC_RECIPES,
    GiranCraftStalls,
    isServiceCrafter,
    craftLevelFor,
    locationFor,
    availableRecipes,
    profileFor,
    ensureRecipes
};
