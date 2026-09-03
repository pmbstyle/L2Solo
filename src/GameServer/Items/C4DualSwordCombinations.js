const DataCache = invoke('GameServer/DataCache');

const RECIPE_ID_OFFSET = 900000;

const STATIONS = Object.freeze({
    pushkin: Object.freeze({
        id: 'blacksmith_pushkin',
        npcId: 7300,
        npcName: 'Pushkin',
        townName: 'Giran',
        regionName: 'Giran',
        loc: Object.freeze({ locX: 77458, locY: 148169, locZ: -3592 })
    }),
    wilbert: Object.freeze({
        id: 'blacksmith_wilbert',
        npcId: 7846,
        npcName: 'Wilbert',
        townName: 'Aden',
        regionName: 'Aden',
        loc: Object.freeze({ locX: 150608, locY: 28510, locZ: -2247 })
    }),
    helton: Object.freeze({
        id: 'blacksmith_helton',
        npcId: 7678,
        npcName: 'Helton',
        townName: 'Oren',
        regionName: 'Oren',
        loc: Object.freeze({ locX: 83684, locY: 55631, locZ: -1509 })
    })
});

// C4 multisell 1001 plus the Wilbert and Helton dual-sword lists.  Only the
// two weapon inputs are retained here: cold bots use the native blacksmith
// journey, but their population progression intentionally waives crystals,
// stones, stamps, taxes, and service Adena.  The A/S entries below are the
// C4 Blacksmith of Mammon exchanges; source item 5704 is catalogued separately
// because its C4 source page has no exchange listing.
const COMBINATIONS = Object.freeze([
    [2516, 123, 123, 'pushkin'],
    [2517, 123, 69, 'pushkin'],
    [2518, 123, 125, 'pushkin'],
    [2519, 123, 126, 'pushkin'],
    [2520, 123, 128, 'pushkin'],
    [2521, 123, 127, 'pushkin'],
    [2522, 123, 130, 'pushkin'],
    [2523, 123, 129, 'pushkin'],
    [2524, 123, 2499, 'pushkin'],
    [2525, 69, 69, 'pushkin'],
    [2526, 69, 125, 'pushkin'],
    [2527, 69, 126, 'pushkin'],
    [2528, 69, 128, 'pushkin'],
    [2529, 69, 127, 'pushkin'],
    [2530, 69, 130, 'pushkin'],
    [2531, 69, 129, 'pushkin'],
    [2532, 69, 2499, 'pushkin'],
    [2533, 125, 125, 'pushkin'],
    [2534, 125, 126, 'pushkin'],
    [2535, 125, 128, 'pushkin'],
    [2536, 125, 127, 'pushkin'],
    [2537, 125, 130, 'pushkin'],
    [2538, 125, 129, 'pushkin'],
    [2539, 125, 2499, 'pushkin'],
    [2540, 126, 126, 'pushkin'],
    [2541, 126, 128, 'pushkin'],
    [2542, 126, 127, 'pushkin'],
    [2543, 126, 130, 'pushkin'],
    [2544, 126, 129, 'pushkin'],
    [2545, 126, 2499, 'pushkin'],
    [2546, 128, 128, 'pushkin'],
    [2547, 128, 127, 'pushkin'],
    [2548, 128, 130, 'pushkin'],
    [2549, 128, 129, 'pushkin'],
    [2550, 128, 2499, 'pushkin'],
    [2551, 127, 127, 'pushkin'],
    [2552, 127, 130, 'pushkin'],
    [2553, 127, 129, 'pushkin'],
    [2554, 127, 2499, 'pushkin'],
    [2555, 130, 130, 'pushkin'],
    [2556, 130, 129, 'pushkin'],
    [2557, 130, 2499, 'pushkin'],
    [2558, 129, 129, 'pushkin'],
    [2559, 129, 2499, 'pushkin'],
    [2560, 2499, 2499, 'pushkin'],
    [2561, 72, 72, 'pushkin'],
    [2562, 72, 73, 'pushkin'],
    [2563, 72, 74, 'pushkin'],
    [2564, 72, 131, 'pushkin'],
    [2565, 72, 133, 'pushkin'],
    [2572, 73, 73, 'pushkin'],
    [2573, 73, 74, 'pushkin'],
    [2574, 73, 131, 'pushkin'],
    [2575, 73, 133, 'pushkin'],
    [2582, 74, 74, 'pushkin'],
    [2583, 74, 131, 'pushkin'],
    [2584, 74, 133, 'pushkin'],
    [2591, 131, 131, 'pushkin'],
    [2592, 131, 133, 'pushkin'],
    [2599, 133, 133, 'pushkin'],
    [2576, 73, 75, 'wilbert'],
    [2579, 73, 134, 'wilbert'],
    [2580, 73, 77, 'wilbert'],
    [2585, 74, 75, 'wilbert'],
    [2588, 74, 134, 'wilbert'],
    [2589, 74, 77, 'wilbert'],
    [2593, 131, 75, 'wilbert'],
    [2596, 131, 134, 'wilbert'],
    [2597, 131, 77, 'wilbert'],
    [2600, 133, 75, 'wilbert'],
    [2603, 133, 134, 'wilbert'],
    [2604, 133, 77, 'wilbert'],
    [2606, 75, 75, 'wilbert'],
    [2609, 75, 134, 'wilbert'],
    [2610, 75, 77, 'wilbert'],
    [2621, 134, 134, 'wilbert'],
    [2622, 134, 77, 'wilbert'],
    [2624, 77, 77, 'wilbert'],
    [2581, 73, 135, 'wilbert'],
    [2590, 74, 135, 'wilbert'],
    [2598, 131, 135, 'wilbert'],
    [2601, 133, 135, 'wilbert'],
    [2611, 75, 135, 'wilbert'],
    [2623, 134, 135, 'wilbert'],
    [2625, 77, 135, 'wilbert'],
    [2626, 135, 135, 'wilbert'],
    [2566, 72, 75, 'helton'],
    [2567, 72, 132, 'helton'],
    [2568, 72, 76, 'helton'],
    [2569, 72, 134, 'helton'],
    [2570, 72, 77, 'helton'],
    [2577, 73, 132, 'helton'],
    [2578, 73, 76, 'helton'],
    [2586, 74, 132, 'helton'],
    [2587, 74, 76, 'helton'],
    [2594, 131, 132, 'helton'],
    [2595, 131, 76, 'helton'],
    [2602, 133, 76, 'helton'],
    [2571, 72, 135, 'helton'],
    [2607, 75, 132, 'helton'],
    [2608, 75, 76, 'helton'],
    [2612, 132, 132, 'helton'],
    [2613, 132, 76, 'helton'],
    [2614, 132, 134, 'helton'],
    [2615, 132, 77, 'helton'],
    [2617, 76, 76, 'helton'],
    [2618, 76, 134, 'helton'],
    [2619, 76, 77, 'helton'],
    [2616, 132, 135, 'helton'],
    [2620, 76, 135, 'helton'],
    [5233, 142, 142, 'pushkin'],
    [5705, 142, 79, 'pushkin'],
    [5706, 79, 79, 'pushkin'],
    [6580, 80, 2500, 'pushkin']
]);

let itemSource = null;
let recipes = [];
let byProductId = new Map();
let byRecipeId = new Map();

function aggregateMaterials(leftId, rightId) {
    const amounts = new Map();
    [leftId, rightId].forEach((selfId) => amounts.set(Number(selfId), Number(amounts.get(Number(selfId)) || 0) + 1));
    return Array.from(amounts, ([selfId, amount]) => ({ selfId, amount }));
}

function loadRecipes() {
    if (itemSource === DataCache.items) return recipes;
    itemSource = DataCache.items;
    const items = new Map((DataCache.items || []).map((item) => [Number(item.selfId), item]));
    recipes = COMBINATIONS.flatMap(([productId, leftId, rightId, stationKey]) => {
        const product = items.get(Number(productId));
        const left = items.get(Number(leftId));
        const right = items.get(Number(rightId));
        if (product?.template?.kind !== 'Weapon.Dual'
            || left?.template?.kind !== 'Weapon.Sword'
            || right?.template?.kind !== 'Weapon.Sword') return [];
        return [{
            type: 'blacksmith_exchange',
            kind: 'dual_sword_combine',
            recipeId: RECIPE_ID_OFFSET + Number(productId),
            productId: Number(productId),
            productCount: 1,
            materials: aggregateMaterials(leftId, rightId),
            successRate: 100,
            mpCost: 0,
            station: STATIONS[stationKey]
        }];
    });
    byProductId = new Map(recipes.map((recipe) => [recipe.productId, recipe]));
    byRecipeId = new Map(recipes.map((recipe) => [recipe.recipeId, recipe]));
    return recipes;
}

function resolveByProductId(productId) {
    loadRecipes();
    return byProductId.get(Number(productId)) || null;
}

function resolveByRecipeId(recipeId) {
    loadRecipes();
    return byRecipeId.get(Number(recipeId)) || null;
}

function isCombination(recipe) {
    return recipe?.kind === 'dual_sword_combine';
}

module.exports = {
    COMBINATIONS,
    RECIPE_ID_OFFSET,
    STATIONS,
    isCombination,
    loadRecipes,
    resolveByProductId,
    resolveByRecipeId
};
