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

function beginTravel(state, timestamp = Date.now()) {
    const plan = state?.stats?.equipmentPlan;
    if (!state || state.activity === 'traveling' || !['active', 'ready_to_craft'].includes(plan?.status) || plan.strategy !== 'craft') return null;
    const recipe = C4RecipeItems.resolveByRecipeId(plan.recipeId);
    const station = stationForRecipe(recipe?.recipeId);
    if (!recipe || !station || !hasMaterials(state, recipe)) return null;
    return {
        ...state,
        activity: 'traveling',
        stats: {
            ...(state.stats || {}),
            craftReturn: { loc: { ...(state.loc || {}) }, spotId: state.spotId || null, regionName: state.currentRegion || null },
            travel: {
                from: { ...(state.loc || {}) },
                to: { ...station.loc },
                startedAt: timestamp,
                arrivalAt: timestamp + 60000,
                townName: 'Giran',
                regionName: 'Giran',
                arrivalActivity: 'crafting',
                reason: 'equipment_craft',
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
    const recipe = C4RecipeItems.resolveByRecipeId(plan?.recipeId);
    const station = stationForRecipe(recipe?.recipeId);
    if (!state || state.activity !== 'crafting' || !recipe || !station || !hasMaterials(state, recipe)) {
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
    const timestamp = Date.now();
    const refreshed = await LifeState.refreshInventory({
        ...state,
        activity: craftReturn?.loc ? 'traveling' : 'hunting',
        stats: {
            ...(state.stats || {}),
            craftReturn: null,
            travel: craftReturn?.loc ? {
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
    return { state: refreshed, crafted: success, reason: success ? 'crafted' : 'craft_failed', result, stationId: station.id };
}

module.exports = { stationForRecipe, crafterAccount, hasMaterials, beginTravel, craft };
