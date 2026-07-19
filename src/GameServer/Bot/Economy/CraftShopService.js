const C4RecipeItems = invoke('GameServer/Items/C4RecipeItems');
const DataCache = invoke('GameServer/DataCache');
const Database = invoke('Database');
const BotEconomyPricing = invoke('GameServer/Bot/Economy/BotEconomyPricing');

const MAX_PUBLIC_RECIPES = 16;
const GIRAN_CRAFT_ROWS = [147780, 148130, 149120, 149470, 149820];
const GIRAN_CRAFT_COLUMNS = [81020, 81380, 81740, 82100, 82460];
const GiranCraftGrid = GIRAN_CRAFT_ROWS.flatMap((locY) => (
    GIRAN_CRAFT_COLUMNS.map((locX) => Object.freeze({ locX, locY, locZ: -3466 }))
));
// The final three services sit beside, rather than beyond, the normal grid.
// These are open Giran market-square points, separated from the grid and the
// permanent Giran merchants so their models never stack.
const GiranCraftOverflowStalls = Object.freeze([
    Object.freeze({ locX: 82820, locY: 147780, locZ: -3466 }),
    Object.freeze({ locX: 83180, locY: 147780, locZ: -3466 }),
    Object.freeze({ locX: 83540, locY: 147780, locZ: -3466 })
]);
const GiranCraftStalls = Object.freeze([...GiranCraftGrid, ...GiranCraftOverflowStalls]);

const STATION_LAYOUT = [
    ['d', 'heavy', 'D Heavy: Brigandine Set', [79, 263, 266, 268, 271]],
    ['d', 'robe', 'D Robe: Mithril Set', [82, 83, 272]],
    ['d', 'light', 'D Light: Manticore Set', [80, 81, 267]],
    ['d', 'weapons', 'D Grade Weapons'],
    ['d', 'jewelry', 'D Jewelry', [50, 51, 52]],
    ['c', 'heavy', 'C Heavy: Full Plate Set', [124, 303, 305, 307]],
    ['c', 'robe', 'C Robes: Karmian & Divine', [100, 92, 282, 288, 126, 127, 302, 309]],
    ['c', 'light', 'C Light: Plated Leather Set', [104, 105, 283]],
    ['c', 'weapons', 'C Grade Weapons'],
    ['c', 'jewelry', 'C Jewelry', [59, 63, 261]],
    ['b', 'heavy', 'B Heavy: Blue Wolf & Doom', [386, 390, 406, 410, 422, 392, 408, 412, 428, 384]],
    ['b', 'robe', 'B Robes: Avadon, Blue Wolf & Doom', [372, 374, 376, 426, 398, 402, 400, 404]],
    ['b', 'light', 'B Light: Blue Wolf & Doom', [394, 410, 422, 396, 412, 428]],
    ['b', 'weapons', 'B Grade Weapons'],
    ['b', 'jewelry', 'B Jewelry: Black Ore', [335, 337, 339]],
    ['a', 'heavy', 'A Heavy: Dark Crystal & Tallum', [554, 562, 564, 546, 538, 534, 556, 566, 548, 540]],
    ['a', 'robe', 'A Robes: DC, Tallum, Nightmare, Majestic', [526, 524, 528, 530]],
    ['a', 'light', 'A Light: DC, Tallum, Nightmare, Majestic', [514, 516, 518, 520]],
    ['a', 'weapons', 'A Grade: Core Weapons', [572, 580, 586, 592, 598, 602]],
    ['a', 'jewelry', 'A Jewelry: Phoenix & Majestic', [614, 616, 618, 620, 622, 624]],
    ['a', 'heavy', 'A Heavy: Nightmare & Majestic', [558, 568, 550, 542, 536, 560, 570, 552, 544], 'a_heavy_elite'],
    ['s', 'heavy', 'S Heavy: Imperial Crusader', [653, 655, 657, 659, 661, 663]],
    ['s', 'robe', 'S Robe: Major Arcana', [673, 675, 677, 679]],
    ['s', 'light', 'S Light: Draconic', [665, 667, 669, 671]],
    ['s', 'weapons', 'S Grade: Core Weapons', [627, 631, 633, 639, 641, 643, 645, 775]],
    ['s', 'jewelry', 'S Jewelry: Tateossian', [647, 649, 651]],
    ['resource', 'core', 'Resources: Molds & Alloys', [32, 34, 35, 36, 38, 39, 40, 27, 497]],
    ['resource', 'master', 'Resources: Maestro Components', [474, 475, 476, 477, 607, 608, 609, 610, 611, 612]]
];

const CraftStations = Object.freeze(STATION_LAYOUT.map(([grade, category, title, recipeIds, stationId], index) => Object.freeze({
    id: stationId || `${grade}_${category}`,
    grade,
    category,
    title,
    recipeIds: recipeIds ? Object.freeze([...recipeIds]) : null,
    loc: Object.freeze({ ...GiranCraftStalls[index] })
})));

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

function stationForSlot(slot) {
    const rawSlot = Math.abs(Number(slot) || 0);
    // Generated craft services use a reserved index range.  Keep its first
    // account at the first physical stall instead of rotating it by 10,000.
    const serviceSlot = rawSlot >= 10000 && rawSlot < 10000 + CraftStations.length
        ? rawSlot - 10000
        : rawSlot;
    const index = serviceSlot % CraftStations.length;
    return CraftStations[index];
}

function serviceStationSlot(state = {}) {
    const accountName = String(state.accountName || state.username || '');
    const accountMatch = /^bot_craft_(\d+)$/i.exec(accountName);
    if (accountMatch) return Math.max(0, Number(accountMatch[1]) - 1);

    const generatedIndex = Number(state.stats?.generatedIndex);
    if (generatedIndex >= 10000 && generatedIndex < 10000 + CraftStations.length) {
        return generatedIndex - 10000;
    }
    return null;
}

function stationFor(state = {}) {
    const serviceSlot = serviceStationSlot(state);
    if (serviceSlot !== null) return stationForSlot(serviceSlot);

    const stationId = String(state.stats?.craftStationId || '');
    return CraftStations.find((station) => station.id === stationId)
        || stationForSlot(state.stats?.generatedIndex ?? state.characterId);
}

function portfolioStationFor(state = {}) {
    if (state.stats?.craftStationId || Number(state.stats?.generatedIndex || 0) >= 10000) {
        return stationFor(state);
    }
    const craftLevel = craftLevelFor(state);
    const grade = craftLevel >= 9 ? 's' : craftLevel >= 7 ? 'a' : craftLevel >= 5 ? 'b' : craftLevel >= 4 ? 'c' : 'd';
    return CraftStations.find((station) => station.grade === grade && station.category === 'heavy') || CraftStations[0];
}

function locationFor(characterId) {
    return { ...stationForSlot(characterId).loc };
}

function productPrice(recipe) {
    const product = (DataCache.items || []).find((item) => Number(item.selfId) === Number(recipe.productId));
    const value = Number(product?.template?.price || 0) * Math.max(1, Number(recipe.productCount || 1));
    // A manufacture fee must remain a fee, not silently turn a player-supplied
    // recipe into an NPC shop. The cap also keeps malformed item prices from
    // producing unusable C4 dialogs.
    return Math.max(100, Math.min(1000000, BotEconomyPricing.scalePrice(Math.round(value * 0.03) + Number(recipe.mpCost || 0) * 10)));
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

function compareScores(left, right) {
    for (let index = 0; index < left.length; index++) {
        if (left[index] !== right[index]) return left[index] - right[index];
    }
    return 0;
}

function topWeaponRecipes(grade, allowedRecipes) {
    const bestByKind = new Map();
    allowedRecipes.forEach((recipe) => {
        const product = (DataCache.items || []).find((item) => Number(item.selfId) === Number(recipe.productId));
        const kind = product?.template?.kind || '';
        if (String(product?.etc?.rank || '').toLowerCase() !== grade || !kind.startsWith('Weapon.')) return;
        const current = bestByKind.get(kind);
        const score = [Number(recipe.level || 0), Number(product?.template?.price || 0), Number(recipe.successRate || 0), Number(recipe.recipeId || 0)];
        const currentScore = current?.score || [];
        if (!current || compareScores(score, currentScore) > 0) {
            bestByKind.set(kind, { recipe, score });
        }
    });
    return [...bestByKind.values()]
        .map((entry) => entry.recipe)
        .sort((a, b) => Number(a.recipeId) - Number(b.recipeId));
}

function stationRecipes(station, allowedRecipes) {
    const allowedById = new Map(allowedRecipes.map((recipe) => [Number(recipe.recipeId), recipe]));
    if (station.recipeIds) {
        return station.recipeIds.map((recipeId) => allowedById.get(Number(recipeId))).filter(Boolean);
    }
    return station.category === 'weapons' ? topWeaponRecipes(station.grade, allowedRecipes) : [];
}

function generatedEntries(state) {
    const recipes = stationRecipes(portfolioStationFor(state), availableRecipes(state));
    return recipes.slice(0, MAX_PUBLIC_RECIPES).map((recipe) => ({
        recipeId: Number(recipe.recipeId),
        price: productPrice(recipe)
    }));
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
    const station = stationFor(state);
    const isStationService = Boolean(state.stats?.craftStationId)
        || Number(state.stats?.generatedIndex || 0) >= 10000;
    // Public station configuration is owned by the server.  Do not retain a
    // persisted snapshot here: it would prevent a changed catalogue, title or
    // placement from reaching an already-seeded service crafter.
    const preserveCustomShop = !isStationService;
    const entries = preserveCustomShop ? normalizeEntries(current.entries, state) : [];
    const published = entries.length ? entries : generatedEntries(state);
    return {
        type: 'dwarven',
        title: String(preserveCustomShop ? current.title || station.title : station.title).slice(0, 52),
        town: 'Giran',
        loc: preserveCustomShop && current.loc ? { ...current.loc } : { ...station.loc },
        stationId: station.id,
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
    CraftStations,
    isServiceCrafter,
    craftLevelFor,
    stationForSlot,
    stationFor,
    locationFor,
    availableRecipes,
    stationRecipes,
    profileFor,
    ensureRecipes
};
