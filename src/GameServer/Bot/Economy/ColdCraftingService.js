const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const C4RecipeItems = invoke('GameServer/Items/C4RecipeItems');
const CraftShopService = invoke('GameServer/Bot/Economy/CraftShopService');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');

const STATION_CRAFTER_LEVEL = 70;

function stationForRecipe(recipeId) {
    const service = { level: STATION_CRAFTER_LEVEL, stats: { classId: 57 } };
    const recipes = CraftShopService.availableRecipes(service);
    return CraftShopService.CraftStations.find((station) => (
        CraftShopService.stationRecipes(station, recipes).some((recipe) => Number(recipe.recipeId) === Number(recipeId))
    )) || null;
}

function crafterAccount(station) {
    const index = CraftShopService.CraftStations.findIndex((entry) => entry.id === station?.id);
    return index < 0 ? null : `bot_craft_${String(index + 1).padStart(2, '0')}`;
}

function hasMaterials(state, recipe) {
    return (recipe?.materials || []).every((material) => (
        Number(state?.inventory?.[String(material.selfId)]?.amount || 0) >= Number(material.amount || 0)
    ));
}

// Equipment recipes can require another manufactured resource (for example,
// Varnish of Purity).  Craft the deepest ready component first; its output is
// then available to the parent recipe on the next cold-life tick.
function readyRecipeFor(state, recipe, visited = new Set()) {
    if (!recipe || visited.has(Number(recipe.recipeId))) return null;
    const nextVisited = new Set(visited).add(Number(recipe.recipeId));
    if (hasMaterials(state, recipe)) return recipe;

    for (const material of recipe.materials || []) {
        const owned = Number(state?.inventory?.[String(material.selfId)]?.amount || 0);
        if (owned >= Number(material.amount || 0)) continue;
        const component = C4RecipeItems.resolveByProductId(material.selfId);
        if (!component || !stationForRecipe(component.recipeId)) continue;
        const ready = readyRecipeFor(state, component, nextVisited);
        if (ready) return ready;
    }
    return null;
}

function beginTravel(state, timestamp = Date.now()) {
    const plan = state?.stats?.equipmentPlan;
    if (!state || state.activity === 'traveling' || !['active', 'ready_to_craft'].includes(plan?.status) || plan.strategy !== 'craft') return null;
    const finalRecipe = C4RecipeItems.resolveByRecipeId(plan.recipeId);
    const recipe = readyRecipeFor(state, finalRecipe);
    const station = stationForRecipe(recipe?.recipeId);
    if (!recipe || !station) return null;
    return {
        ...state,
        activity: 'traveling',
        stats: {
            ...(state.stats || {}),
            craftReturn: state.stats?.craftReturn || { loc: { ...(state.loc || {}) }, spotId: state.spotId || null, regionName: state.currentRegion || null },
            travel: {
                from: { ...(state.loc || {}) },
                to: { ...station.loc },
                startedAt: timestamp,
                arrivalAt: timestamp + 60000,
                townName: 'Giran',
                regionName: 'Giran',
                arrivalActivity: 'crafting',
                reason: recipe.recipeId === finalRecipe?.recipeId ? 'equipment_craft' : 'component_craft',
                stationId: station.id
            }
        }
    };
}

function materialRows(items, recipe) {
    return (recipe.materials || []).map((material) => {
        const row = (items || []).find((item) => Number(item.selfId) === Number(material.selfId) && Number(item.amount) >= Number(material.amount));
        return row ? { id: Number(row.id), selfId: Number(material.selfId), amount: Number(material.amount) } : null;
    }).every(Boolean) ? (recipe.materials || []).map((material) => {
        const row = (items || []).find((item) => Number(item.selfId) === Number(material.selfId) && Number(item.amount) >= Number(material.amount));
        return { id: Number(row.id), selfId: Number(material.selfId), amount: Number(material.amount) };
    }) : null;
}

async function craft(state, random = Math.random) {
    const plan = state?.stats?.equipmentPlan;
    const finalRecipe = C4RecipeItems.resolveByRecipeId(plan?.recipeId);
    const recipe = readyRecipeFor(state, finalRecipe);
    const station = stationForRecipe(recipe?.recipeId);
    if (!state || state.activity !== 'crafting' || !recipe || !station) {
        return { state, crafted: false, reason: 'not_ready' };
    }

    const account = crafterAccount(station);
    const [characters] = await Promise.all([Database.fetchCharacters(account)]);
    const crafter = characters[0];
    if (!crafter) return { state, crafted: false, reason: 'missing_station' };
    const crafterState = await LifeState.findByCharacterId(crafter.id);
    if (!crafterState || crafterState.phase !== 'cold') return { state, crafted: false, reason: 'station_busy' };

    const profile = CraftShopService.profileFor(crafterState);
    const entry = profile.entries.find((candidate) => Number(candidate.recipeId) === Number(recipe.recipeId));
    const template = (DataCache.items || []).find((item) => Number(item.selfId) === Number(recipe.productId));
    if (!entry || !template || Number(crafterState.vitals?.mp || 0) < Number(recipe.mpCost || 0)) {
        return { state, crafted: false, reason: 'station_unavailable' };
    }

    const customerItems = await Database.fetchItems(state.characterId);
    const materials = materialRows(customerItems, recipe);
    if (!materials) return { state, crafted: false, reason: 'materials_changed' };
    const success = Number(recipe.successRate || 0) >= 100 || Number(random()) * 100 < Number(recipe.successRate || 0);
    const result = await Database.craftForCustomer(crafter.id, state.characterId, {
        materials,
        product: success ? {
            selfId: Number(recipe.productId),
            name: template.template?.name || '',
            amount: Number(recipe.productCount || 1),
            stackable: !!template.etc?.stackable,
            slot: Number(template.etc?.slot || 0)
        } : null,
        crafterMp: Number(crafterState.vitals?.mp || 0) - Number(recipe.mpCost || 0),
        price: Number(entry.price || 0),
        adena: { name: 'Adena' }
    });
    await LifeState.upsertState({
        ...crafterState,
        vitals: { ...(crafterState.vitals || {}), mp: Number(crafterState.vitals?.mp || 0) - Number(recipe.mpCost || 0) }
    }, 'cold_manufacture');
    const craftReturn = state.stats?.craftReturn;
    const componentCraft = Number(recipe.recipeId) !== Number(finalRecipe?.recipeId);
    const timestamp = Date.now();
    const refreshed = await LifeState.refreshInventory({
        ...state,
        activity: componentCraft ? 'hunting' : craftReturn?.loc ? 'traveling' : 'hunting',
        stats: {
            ...(state.stats || {}),
            craftReturn: componentCraft ? craftReturn : null,
            travel: !componentCraft && craftReturn?.loc ? {
                from: { ...(state.loc || station.loc) },
                to: { ...craftReturn.loc },
                startedAt: timestamp,
                arrivalAt: timestamp + 60000,
                townName: craftReturn.regionName || 'Hunting Ground',
                regionName: craftReturn.regionName || state.currentRegion,
                spotId: craftReturn.spotId || null,
                arrivalActivity: 'hunting',
                reason: 'equipment_craft_return'
            } : null
        }
    });
    return {
        state: refreshed,
        crafted: success,
        reason: success ? componentCraft ? 'component_crafted' : 'crafted' : 'craft_failed',
        result,
        stationId: station.id,
        recipeId: recipe.recipeId,
        productId: Number(recipe.productId),
        productName: template.template?.name || `Item ${recipe.productId}`
    };
}

module.exports = { stationForRecipe, crafterAccount, hasMaterials, readyRecipeFor, beginTravel, craft };
