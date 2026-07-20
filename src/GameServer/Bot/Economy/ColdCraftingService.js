const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const C4RecipeItems = invoke('GameServer/Items/C4RecipeItems');
const CraftShopService = invoke('GameServer/Bot/Economy/CraftShopService');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const CraftSupplementMaterials = invoke('GameServer/Bot/Economy/CraftSupplementMaterials');
const TownRespawn = invoke('GameServer/World/TownRespawn');

const STATION_CRAFTER_LEVEL = 70;
const NATIVE_TRAVEL_MS = 25000;

function isStationService(state = {}) {
    return Boolean(state.stats?.craftStationId)
        || Number(state.stats?.generatedIndex || 0) >= 10000;
}

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
        CraftSupplementMaterials.isSupplementalMaterial(material.selfId)
            || Number(state?.inventory?.[String(material.selfId)]?.amount || 0) >= Number(material.amount || 0)
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
        if (owned >= Number(material.amount || 0) || CraftSupplementMaterials.isSupplementalMaterial(material.selfId)) continue;
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
    const nearestTown = TownRespawn.getClosestTown(state.loc?.locX, state.loc?.locY);
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
                arrivalAt: timestamp + NATIVE_TRAVEL_MS,
                townName: 'Giran',
                regionName: 'Giran',
                viaTown: nearestTown?.name || null,
                method: 'soe_gatekeeper',
                arrivalActivity: 'crafting',
                reason: recipe.recipeId === finalRecipe?.recipeId ? 'equipment_craft' : 'component_craft',
                stationId: station.id
            }
        }
    };
}

function materialRows(items, recipe, multiplier = 1) {
    return (recipe.materials || []).map((material) => {
        const amount = Number(material.amount || 0) * Number(multiplier || 1);
        const row = (items || []).find((item) => Number(item.selfId) === Number(material.selfId) && Number(item.amount) >= amount);
        return row ? { id: Number(row.id), selfId: Number(material.selfId), amount } : null;
    }).every(Boolean) ? (recipe.materials || []).map((material) => {
        const amount = Number(material.amount || 0) * Number(multiplier || 1);
        const row = (items || []).find((item) => Number(item.selfId) === Number(material.selfId) && Number(item.amount) >= amount);
        return { id: Number(row.id), selfId: Number(material.selfId), amount };
    }) : null;
}

function hasNonSupplementalMaterials(items, recipe, multiplier = 1) {
    return (recipe?.materials || []).every((material) => {
        if (CraftSupplementMaterials.isSupplementalMaterial(material.selfId)) return true;
        const row = (items || []).find((item) => Number(item.selfId) === Number(material.selfId));
        return Number(row?.amount || 0) >= Number(material.amount || 0) * Number(multiplier || 1);
    });
}

async function supplementMaterials(characterId, items, recipe, multiplier = 1) {
    const missing = (recipe?.materials || []).flatMap((material) => {
        if (!CraftSupplementMaterials.isSupplementalMaterial(material.selfId)) return [];
        const current = (items || []).find((item) => Number(item.selfId) === Number(material.selfId));
        const amount = Number(current?.amount || 0);
        const required = Number(material.amount || 0) * Number(multiplier || 1);
        if (amount >= required) return [];
        const template = (DataCache.items || []).find((item) => Number(item.selfId) === Number(material.selfId));
        return [{ material, current, amount: required - amount, name: template?.template?.name || `Item ${material.selfId}` }];
    });
    if (!missing.length) return { items, supplemented: [] };
    await missing.reduce((chain, entry) => chain.then(() => (
        entry.current
            ? Database.updateItemAmount(characterId, entry.current.id, Number(entry.current.amount || 0) + entry.amount)
            : Database.setItem(characterId, { selfId: Number(entry.material.selfId), name: entry.name, amount: entry.amount, stackable: true, slot: 0 })
    )), Promise.resolve());
    return { items: await Database.fetchItems(characterId), supplemented: missing.map(({ material, amount, name }) => ({ selfId: Number(material.selfId), amount, name })) };
}

// The background resolver carries a virtual inventory between materializations,
// while crafting changes the physical rows transactionally.  Rebuild from the
// latter after either path, otherwise consumed inputs can linger in the
// summary and send a bot back to a station with phantom materials.
function refreshPhysicalInventory(state) {
    return LifeState.refreshInventory({ ...state, inventory: {} });
}

function craftableBatchCount(items, recipe, requested = 1) {
    return (recipe?.materials || []).reduce((count, material) => {
        if (CraftSupplementMaterials.isSupplementalMaterial(material.selfId)) return count;
        const owned = Number((items || []).find((item) => Number(item.selfId) === Number(material.selfId))?.amount || 0);
        return Math.min(count, Math.floor(owned / Math.max(1, Number(material.amount || 1))));
    }, Math.max(1, Number(requested || 1)));
}

function requiredCraftCount(finalRecipe, recipe, state, requestedOutput = null, visited = new Set()) {
    if (!finalRecipe || !recipe || visited.has(Number(finalRecipe.recipeId))) return 1;
    const desired = requestedOutput === null ? Math.max(1, Number(finalRecipe.productCount || 1)) : Math.max(0, Number(requestedOutput || 0));
    const crafts = Math.ceil(desired / Math.max(1, Number(finalRecipe.productCount || 1)));
    if (Number(finalRecipe.recipeId) === Number(recipe.recipeId)) return Math.max(1, crafts);
    const nextVisited = new Set(visited).add(Number(finalRecipe.recipeId));
    for (const material of finalRecipe.materials || []) {
        const component = C4RecipeItems.resolveByProductId(material.selfId);
        if (!component) continue;
        const owned = Number(state?.inventory?.[String(material.selfId)]?.amount || 0);
        const needed = Math.max(0, Number(material.amount || 0) * crafts - owned);
        if (Number(component.recipeId) === Number(recipe.recipeId)) return Math.ceil(needed / Math.max(1, Number(recipe.productCount || 1)));
        const nested = requiredCraftCount(component, recipe, state, needed, nextVisited);
        if (nested > 1 || Number(component.recipeId) === Number(recipe.recipeId)) return nested;
    }
    return 1;
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
    const stationService = isStationService(crafterState);
    const crafterMp = Number(crafterState.vitals?.mp || 0);
    if (!entry || !template || (!stationService && crafterMp < Number(recipe.mpCost || 0))) {
        return { state, crafted: false, reason: 'station_unavailable' };
    }

    const componentCraft = Number(recipe.recipeId) !== Number(finalRecipe?.recipeId);
    const customerItems = await Database.fetchItems(state.characterId);
    const requestedBatch = componentCraft ? requiredCraftCount(finalRecipe, recipe, state) : 1;
    const batchCount = componentCraft ? craftableBatchCount(customerItems, recipe, requestedBatch) : 1;
    if (!batchCount || !hasNonSupplementalMaterials(customerItems, recipe, batchCount)) {
        const reconciled = await refreshPhysicalInventory(state);
        return { state: reconciled, crafted: false, reason: 'materials_changed' };
    }
    const supplemental = await supplementMaterials(state.characterId, customerItems, recipe, batchCount);
    const materials = materialRows(supplemental.items, recipe, batchCount);
    if (!materials) return { state, crafted: false, reason: 'materials_changed' };
    const success = Number(recipe.successRate || 0) >= 100 || Number(random()) * 100 < Number(recipe.successRate || 0);
    const price = Number(entry.price || 0) * batchCount;
    const adena = Number(customerItems.find((item) => Number(item.selfId) === 57)?.amount || 0);
    if (adena < price) {
        return {
            state: await refreshPhysicalInventory(state),
            crafted: false,
            reason: 'insufficient_adena',
            requiredAdena: price,
            availableAdena: adena
        };
    }
    let result;
    try {
        result = await Database.craftForCustomer(crafter.id, state.characterId, {
            materials,
            product: success ? {
                selfId: Number(recipe.productId),
                name: template.template?.name || '',
                amount: Number(recipe.productCount || 1) * batchCount,
                stackable: !!template.etc?.stackable,
                slot: Number(template.etc?.slot || 0)
            } : null,
            // Public server stations are infrastructure, not ordinary players.
            // They must remain available to the whole cold population indefinitely.
            crafterMp: stationService ? crafterMp : crafterMp - Number(recipe.mpCost || 0),
            price,
            adena: { name: 'Adena' }
        });
    } catch (error) {
        // A concurrent market/craft transaction may invalidate a material or
        // Adena row. Keep this bot's retry local; never reject the scheduler.
        return {
            state: await refreshPhysicalInventory(state),
            crafted: false,
            reason: 'craft_rejected',
            error: String(error?.message || error)
        };
    }
    await LifeState.upsertState({
        ...crafterState,
        vitals: { ...(crafterState.vitals || {}), mp: stationService ? crafterMp : crafterMp - Number(recipe.mpCost || 0) }
    }, 'cold_manufacture');
    const craftReturn = state.stats?.craftReturn;
    const timestamp = Date.now();
    const returnTown = craftReturn?.loc
        ? TownRespawn.getClosestTown(craftReturn.loc.locX, craftReturn.loc.locY)
        : null;
    const refreshed = await refreshPhysicalInventory({
        ...state,
        // Decide whether to remain at the station after inventory refresh.
        // The crafted output may unlock another component, but if its raw
        // inputs are exhausted the bot must resume farming instead of idling
        // forever in the high-priority crafting queue.
        activity: componentCraft ? 'hunting' : craftReturn?.loc ? 'traveling' : 'hunting',
        stats: {
            ...(state.stats || {}),
            craftReturn: componentCraft ? craftReturn : null,
            travel: !componentCraft && craftReturn?.loc ? {
                from: { ...(state.loc || station.loc) },
                to: { ...craftReturn.loc },
                startedAt: timestamp,
                arrivalAt: timestamp + NATIVE_TRAVEL_MS,
                townName: craftReturn.regionName || 'Hunting Ground',
                regionName: craftReturn.regionName || state.currentRegion,
                viaTown: returnTown?.name || null,
                method: 'gatekeeper_spot',
                spotId: craftReturn.spotId || null,
                arrivalActivity: 'hunting',
                reason: 'equipment_craft_return'
            } : null
        }
    });
    const continueCrafting = componentCraft && !!readyRecipeFor(refreshed, finalRecipe);
    const returnAfterComponent = componentCraft && !continueCrafting && craftReturn?.loc;
    const settled = continueCrafting
        ? { ...refreshed, activity: 'crafting' }
        : returnAfterComponent ? {
            ...refreshed,
            activity: 'traveling',
            stats: {
                ...(refreshed.stats || {}),
                craftReturn: null,
                travel: {
                    from: { ...(state.loc || station.loc) },
                    to: { ...craftReturn.loc },
                    startedAt: timestamp,
                    arrivalAt: timestamp + NATIVE_TRAVEL_MS,
                    townName: craftReturn.regionName || 'Hunting Ground',
                    regionName: craftReturn.regionName || state.currentRegion,
                    viaTown: returnTown?.name || null,
                    method: 'gatekeeper_spot',
                    spotId: craftReturn.spotId || null,
                    arrivalActivity: 'hunting',
                    reason: 'component_craft_return'
                }
            }
        } : refreshed;
    return {
        state: settled,
        crafted: success,
        reason: success ? componentCraft ? 'component_crafted' : 'crafted' : 'craft_failed',
        result,
        stationId: station.id,
        recipeId: recipe.recipeId,
        productId: Number(recipe.productId),
        productName: template.template?.name || `Item ${recipe.productId}`,
        batchCount
        , supplementedMaterials: supplemental.supplemented
    };
}

module.exports = { NATIVE_TRAVEL_MS, isStationService, stationForRecipe, crafterAccount, hasMaterials, hasNonSupplementalMaterials, readyRecipeFor, supplementMaterials, craftableBatchCount, requiredCraftCount, beginTravel, craft };
