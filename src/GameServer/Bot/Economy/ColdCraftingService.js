const ClanCrafting = require('../../Clan/ClanCraftingPolicy');
const ItemTemplateIndex = require('../../Item/ItemTemplateIndex');
const Karma = require('../../Karma');
const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const C4RecipeItems = invoke('GameServer/Items/C4RecipeItems');
const C4DualSwordCombinations = invoke('GameServer/Items/C4DualSwordCombinations');
const CraftShopService = invoke('GameServer/Bot/Economy/CraftShopService');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const TownRespawn = invoke('GameServer/World/TownRespawn');
const ColdTrip = invoke('GameServer/Bot/Population/ColdTrip');
const Profit = require('./CraftProfitPolicy');
const Production = require('./ProductionPolicy');
const Workshops = require('./CraftWorkshopService');

const NATIVE_TRAVEL_MS = ColdTrip.AUTHOR_TRIP_MS;

const isStationService = state => CraftShopService.isStationService(state);

function stationForRecipe(recipeId, state = null) {
    const combination = C4DualSwordCombinations.resolveByRecipeId(recipeId);
    if (combination) return combination.station;
    const provider = state?.stats?.equipmentPlan?.craftProviders?.[recipeId];
    if (provider?.workshop) {
        const selected = Workshops.lookup(provider.characterId, recipeId, state);
        // The agreement is the dwarf and his published fee; his save revision
        // is read here and checked again by the craft after the async reads.
        if (!selected || provider.price != null && Number(selected.entryPrice) !== Number(provider.price)) return null;
        return { id: `workshop_${provider.characterId}`, characterId: provider.characterId,
            loc: selected.state.loc, townName: selected.state.currentRegion, workshop: true,
            recipeId: Number(recipeId), price: selected.price, entryPrice: selected.entryPrice,
            revision: Number(selected.state.simulation?.revision || 0),
            capacityBatches: Math.min(64, Math.floor(Number(selected.state.vitals?.mp || 0) / Math.max(1, Number(selected.recipe.mpCost || 0)))) };
    }
    if (provider && state.stats.equipmentPlan.clanGoal?.clanId
        && (!Production.buyersDisabled() || state.stats.equipmentPlan.clanGoal.orderId)) return {
        id: `clan_crafter_${provider.characterId}`, characterId: provider.characterId,
        loc: provider.loc, clan: true
    };
    if (Production.buyersDisabled()) return null;
    return CraftShopService.publishedStationRecipes().stationByRecipeId.get(Number(recipeId)) || null;
}

function crafterAccount(station) {
    const index = CraftShopService.CraftStations.findIndex((entry) => entry.id === station?.id);
    return index < 0 ? null : `bot_craft_${String(index + 1).padStart(2, '0')}`;
}

function componentFor(state, selfId) {
    return C4RecipeItems.resolveByRecipeId(state?.stats?.equipmentPlan?.componentRecipes?.[selfId])
        || C4RecipeItems.resolveByProductId(selfId);
}

function recipeForState(state, recipe) {
    const provider = state?.stats?.equipmentPlan?.craftProviders?.[recipe?.recipeId];
    if (!recipe || !provider || provider.known || provider.workshop) return recipe;
    const materials = recipe.materials.map(row => ({ ...row }));
    const scroll = materials.find(row => Number(row.selfId) === Number(recipe.recipeItemId));
    if (scroll) scroll.amount += 1;
    else materials.push({ selfId: Number(recipe.recipeItemId), amount: 1 });
    return { ...recipe, materials };
}

function hasMaterials(state, recipe) {
    recipe = recipeForState(state, recipe);
    const required = Profit.requirements(recipe);
    return !!required && [...required].every(([id, amount]) => Number(state?.inventory?.[id]?.amount || 0) >= amount);
}

// Equipment recipes can require another manufactured resource (for example,
// Varnish of Purity).  Craft the deepest ready component first; its output is
// then available to the parent recipe on the next cold-life tick.
function readyRecipeFor(state, recipe, visited = new Set()) {
    if (!recipe || visited.has(Number(recipe.recipeId))) return null;
    const plan = state?.stats?.equipmentPlan;
    if (!visited.size && !plan?.clanGoal && Number(plan?.recipeId) === Number(recipe.recipeId)
        && requiredCraftCount(recipe, recipe, state) === 0) return null;
    const nextVisited = new Set(visited).add(Number(recipe.recipeId));
    if (hasMaterials(state, recipe)) return recipe;

    for (const [id, amount] of Profit.requirements(recipe) || []) {
        const owned = Number(state?.inventory?.[id]?.amount || 0);
        if (owned >= amount) continue;
        const component = componentFor(state, id);
        if (!component || !stationForRecipe(component.recipeId, state)) continue;
        const ready = readyRecipeFor(state, component, nextVisited);
        if (ready) return ready;
    }
    return null;
}

function publicCraftPlan(state) {
    const plan = state?.stats?.equipmentPlan;
    return !!plan?.craftProviders?.[plan.recipeId]?.workshop;
}
function beginTravel(state, timestamp = Date.now()) {
    if (Karma.closesTowns(state?.stats?.karma) || (!Production.buyersDisabled() && ClanCrafting.isPersonalCraft(state) && !publicCraftPlan(state))) return null;
    const plan = state?.stats?.equipmentPlan;
    if (!state || state.activity === 'traveling' || !['active', 'component_ready', 'ready_to_craft'].includes(plan?.status) || plan.strategy !== 'craft') return null;
    const finalRecipe = C4RecipeItems.resolveByRecipeId(plan.recipeId)
        || C4DualSwordCombinations.resolveByRecipeId(plan.recipeId);
    let recipe = readyRecipeFor(state, finalRecipe);
    const station = stationForRecipe(recipe?.recipeId, state);
    if (!recipe || !station) return null;
    const nearestTown = TownRespawn.getClosestTown(state.loc?.locX, state.loc?.locY, state.loc?.locZ);
    return ColdTrip.toTown(state, {
        to: { ...station.loc },
        townName: station.townName || 'Giran',
        regionName: station.regionName || station.townName || 'Giran',
        viaTown: nearestTown?.name || null,
        arrivalActivity: 'crafting',
        reason: C4DualSwordCombinations.isCombination(recipe)
            ? 'dual_sword_combine'
            : recipe.recipeId === finalRecipe?.recipeId ? 'equipment_craft' : 'component_craft',
        stationId: station.id
    }, timestamp, {
        craftReturn: state.stats?.craftReturn || { loc: { ...(state.loc || {}) }, spotId: state.spotId || null, regionName: state.currentRegion || null }
    });
}

// The trip back from a craft station to the spot the bot left (craftReturn).
function returnTrip(state, from, craftReturn, reason, timestamp) {
    const returnTown = TownRespawn.getClosestTown(craftReturn.loc.locX, craftReturn.loc.locY, craftReturn.loc.locZ);
    return ColdTrip.toSpot(state, {
        from: { ...from },
        to: { ...craftReturn.loc },
        townName: returnTown?.name || craftReturn.regionName || 'Hunting Ground',
        regionName: craftReturn.regionName || state.currentRegion,
        viaTown: returnTown?.name || null,
        spotId: craftReturn.spotId || null,
        arrivalActivity: 'hunting',
        arrivalEvent: 'returned_to_spot',
        reason
    }, timestamp, { extraStats: { craftReturn: null } });
}

function materialRows(items, recipe, multiplier = 1) {
    return Profit.materials(items, recipe, multiplier);
}

function hasNonSupplementalMaterials(items, recipe, multiplier = 1) {
    return Profit.craftableBatches(items, recipe, multiplier) >= multiplier;
}

async function supplementMaterials(characterId, items) {
    // The same public result shape; every crystal and gemstone is now a real input.
    return { items, supplemented: [] };
}

// The background resolver carries a virtual inventory between materializations,
// while crafting changes the physical rows transactionally.  Rebuild from the
// latter after either path, otherwise consumed inputs can linger in the
// summary and send a bot back to a station with phantom materials.
function refreshPhysicalInventory(state) {
    return LifeState.refreshInventory({ ...state, inventory: {} }, { equip: true });
}

function craftableBatchCount(items, recipe, requested = 1) {
    return Profit.craftableBatches(items, recipe, requested);
}

function requiredCraftCount(finalRecipe, recipe, state, requestedOutput = null, visited = new Set()) {
    if (!finalRecipe || !recipe || visited.has(Number(finalRecipe.recipeId))) return 1;
    const desired = requestedOutput === null
        ? Math.max(0, Math.max(1, Number(state?.stats?.equipmentPlan?.outputAmount || finalRecipe.productCount || 1))
            - (state?.stats?.equipmentPlan?.clanGoal ? 0 : Number(state?.inventory?.[finalRecipe.productId]?.amount || 0)))
        : Math.max(0, Number(requestedOutput || 0));
    const crafts = Profit.batchesFor(finalRecipe, desired);
    if (crafts === null) return 0;
    if (Number(finalRecipe.recipeId) === Number(recipe.recipeId)) return crafts;
    const nextVisited = new Set(visited).add(Number(finalRecipe.recipeId));
    for (const [id, amount] of Profit.requirements(finalRecipe) || []) {
        const component = componentFor(state, id);
        if (!component) continue;
        const owned = Number(state?.inventory?.[id]?.amount || 0);
        if (!Number.isSafeInteger(amount * crafts)) return 0;
        const needed = Math.max(0, amount * crafts - owned);
        if (Number(component.recipeId) === Number(recipe.recipeId)) return Math.ceil(needed / Math.max(1, Number(recipe.productCount || 1)));
        const nested = requiredCraftCount(component, recipe, state, needed, nextVisited);
        if (nested > 1 || Number(component.recipeId) === Number(recipe.recipeId)) return nested;
    }
    return 1;
}

function hasCombinationIngredients(items, recipe) {
    // The native blacksmith exchange may consume the currently worn sword;
    // ordinary craft readiness excludes equipped inputs.
    const required = Profit.requirements(recipe), amounts = new Map();
    for (const item of items || []) amounts.set(Number(item.selfId), (amounts.get(Number(item.selfId)) || 0) + Number(item.amount || 0));
    return !!required && [...required].every(([id, count]) => (amounts.get(id) || 0) >= count);
}

async function combineDualSword(state, recipe, station) {
    const items = await Database.fetchItems(state.characterId);
    if (!hasCombinationIngredients(items, recipe)) {
        return { state: await refreshPhysicalInventory(state), crafted: false, reason: 'materials_changed' };
    }
    const template = ItemTemplateIndex.find(DataCache.items, recipe.productId);
    if (!template) return { state, crafted: false, reason: 'missing_product' };

    let result;
    try {
        result = await Database.combineInventoryItems(state.characterId, {
            ingredients: recipe.materials,
            product: {
                selfId: Number(recipe.productId),
                name: template.template?.name || '',
                amount: 1,
                slot: Number(template.etc?.slot || 0)
            }
        });
    } catch (error) {
        return {
            state: await refreshPhysicalInventory(state),
            crafted: false,
            reason: 'combine_rejected',
            error: String(error?.message || error)
        };
    }

    const craftReturn = state.stats?.craftReturn;
    const refreshed = await refreshPhysicalInventory(craftReturn?.loc
        ? returnTrip(state, state.loc || station.loc, craftReturn, 'dual_sword_combine_return', Date.now())
        : { ...state, activity: 'hunting', stats: { ...(state.stats || {}), craftReturn: null, travel: null } });
    return {
        state: refreshed,
        crafted: true,
        reason: 'dual_sword_combined',
        result,
        stationId: station.id,
        recipeId: recipe.recipeId,
        productId: Number(recipe.productId),
        productName: template.template?.name || `Item ${recipe.productId}`,
        batchCount: 1
    };
}

async function craft(state, random = Math.random) {
    const plan = state?.stats?.equipmentPlan;
    const finalRecipe = C4RecipeItems.resolveByRecipeId(plan?.recipeId)
        || C4DualSwordCombinations.resolveByRecipeId(plan?.recipeId);
    let recipe = readyRecipeFor(state, finalRecipe);
    const station = stationForRecipe(recipe?.recipeId, state);
    if (!state || (!Production.buyersDisabled() && ClanCrafting.isPersonalCraft(state) && !publicCraftPlan(state)) || state.activity !== 'crafting' || !recipe || !station) {
        return { state, crafted: false, reason: 'not_ready' };
    }
    if (C4DualSwordCombinations.isCombination(recipe)) {
        return combineDualSword(state, recipe, station);
    }

    const account = crafterAccount(station);
    const characters = station.clan || station.workshop ? [{ id: station.characterId }] : await Database.fetchCharacters(account);
    const crafter = characters[0];
    if (!crafter) return { state, crafted: false, reason: 'missing_station' };
    let crafterState = await LifeState.findByCharacterId(crafter.id);
    if (!crafterState || crafterState.phase !== 'cold') return { state, crafted: false, reason: 'station_busy' };

    let learning = false;
    if (station.clan) {
        if (crafterState.simulation?.ownerId === 'cold_simulation_owner') {
            const handedOff = await invoke('GameServer/Bot/Population/ColdSimulationOwner').handoffToMain(crafterState);
            if (!handedOff.ok) return { state, crafted: false, reason: 'clan_crafter_busy' };
            crafterState = await LifeState.findByCharacterId(crafter.id);
        }
        const clanId = Number(plan.clanGoal?.clanId);
        const [membership] = await Database.execute(['SELECT clanId FROM characters WHERE id = ?', [crafter.id]]);
        if (Number(membership?.clanId) !== clanId || (crafterState.partyId || crafterState.party?.partyId)
            || Number(crafterState.vitals?.hp) <= 0 || ['dead', 'respawning'].includes(crafterState.activity)
            || String(crafterState.simulation?.ownerId || crafterState.simulationOwner || 'legacy_main') !== 'legacy_main'
            || !CraftShopService.canCraft(crafterState, recipe)) {
            return { state, crafted: false, reason: 'clan_crafter_unavailable' };
        }
        if (Math.hypot(Number(state.loc?.locX) - Number(crafterState.loc?.locX),
            Number(state.loc?.locY) - Number(crafterState.loc?.locY)) > 1200) {
            const moved = { ...state, stats: { ...state.stats, equipmentPlan: { ...plan,
                craftProviders: { ...plan.craftProviders, [recipe.recipeId]: { ...plan.craftProviders[recipe.recipeId], loc: crafterState.loc } } } } };
            return { state: beginTravel(moved) || state, crafted: false, reason: 'clan_crafter_moved' };
        }
        const known = await Database.fetchCharacterRecipes(crafter.id);
        learning = !known.some(row => Number(row.recipeId) === Number(recipe.recipeId));
        const providers = { ...plan.craftProviders, [recipe.recipeId]: { ...plan.craftProviders[recipe.recipeId], known: !learning } };
        state = { ...state, stats: { ...state.stats, equipmentPlan: { ...plan, craftProviders: providers } } };
        recipe = recipeForState(state, recipe);
    }
    const profile = station.clan || station.workshop ? null : CraftShopService.profileFor(crafterState);
    const entry = station.workshop ? Workshops.quote(crafterState, state, recipe.recipeId)
        : station.clan ? { price: 0 } : profile.entries.find((candidate) => Number(candidate.recipeId) === Number(recipe.recipeId));
    const template = ItemTemplateIndex.find(DataCache.items, recipe.productId);
    const stationService = !station.clan && !station.workshop && isStationService(crafterState);
    const crafterMp = Number(crafterState.vitals?.mp || 0);
    if (!entry || !template || (!stationService && crafterMp < Number(recipe.mpCost || 0))) {
        return { state, crafted: false, reason: 'station_unavailable' };
    }

    const componentCraft = Number(recipe.recipeId) !== Number(finalRecipe?.recipeId);
    const customerItems = await Database.fetchItems(state.characterId);
    const requestedBatch = !learning ? requiredCraftCount(finalRecipe, recipe, state) : 1;
    const materialBatch = craftableBatchCount(customerItems, recipe, Math.min(64, requestedBatch));
    const batchCount = station.clan || station.workshop ? Math.min(materialBatch, Math.floor(crafterMp / Math.max(1, Number(recipe.mpCost)))) : materialBatch;
    if (!batchCount || !hasNonSupplementalMaterials(customerItems, recipe, batchCount)) {
        const reconciled = await refreshPhysicalInventory(state);
        return { state: reconciled, crafted: false, reason: 'materials_changed' };
    }
    const supplemental = await supplementMaterials(state.characterId, customerItems, recipe, batchCount);
    const materials = materialRows(supplemental.items, recipe, batchCount);
    if (!materials) return { state, crafted: false, reason: 'materials_changed' };
    let success = station.workshop ? null : Profit.succeeds(recipe, random);
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
        result = station.workshop ? await Workshops.craft(crafter.id, recipe.recipeId, state.characterId, {
            batches: batchCount, expectedPrice: entry.price, expectedRevision: station.revision, random, funding: { r: Number(plan.valueRate || 0) }
        }) : await Database.craftForCustomer(crafter.id, state.characterId, {
            materials,
            product: success ? {
                selfId: Number(recipe.productId),
                name: template.template?.name || '',
                kind: template.template?.kind || '',
                amount: Number(recipe.productCount || 1) * batchCount,
                stackable: !!template.etc?.stackable,
                slot: Number(template.etc?.slot || 0)
            } : null,
            // Public server stations are infrastructure, not ordinary players.
            // They must remain available to the whole cold population indefinitely.
            crafterMp: stationService ? crafterMp : crafterMp - Number(recipe.mpCost || 0) * batchCount,
            price,
            adena: { name: 'Adena' },
            ...(plan.clanGoal?.orderId ? { clanOrder: { orderId: plan.clanGoal.orderId,
                settings: plan.clanGoal.orderSettings, final: !componentCraft } } : {}),
            ...(station.clan ? { clanCraft: { clanId: Number(plan.clanGoal.clanId), recipeId: recipe.recipeId,
                learning, crafterRevision: crafterState.simulation?.revision ?? crafterState.simulationRevision ?? 0,
                customerRevision: state.simulation?.revision ?? state.simulationRevision ?? 0,
                mpCost: Number(recipe.mpCost) * batchCount } } : {})
        });
    } catch (error) {
        let failure = error;
        if (station.workshop && error.economyCommand) {
            try {
                result = await Workshops.craft(crafter.id, recipe.recipeId, state.characterId,
                    { original: error.economyCommand });
            } catch (recoveryError) { failure = recoveryError; }
        }
        if (!result) {
            // A refusal spends nothing. Keep the original header if delivery
            // is uncertain; an ordinary replan never invents a second attempt.
            return { state: await refreshPhysicalInventory(state), crafted: false, reason: 'craft_rejected',
                error: String(failure?.message || failure),
                ...(error.economyCommand ? { economyCommand: error.economyCommand } : {}) };
        }
    }
    if (station.workshop) success = result.success !== false;
    // ARCH-NOTE: E3 physical craft fees must reach the returned wallet.
    // Validate the existing exchange receipt before subsequent writers. Missing
    // receipts retain the existing zero-fee and unit-facade behavior.
    const cashReceipt = result?.customerAdena;
    const committedAdena = cashReceipt == null ? undefined : cashReceipt.amount;
    if (cashReceipt != null && (!Number.isSafeInteger(committedAdena) || committedAdena < 0)) {
        throw new TypeError('Invalid customer craft cash receipt');
    }
    if (station.clan && learning) invoke('GameServer/Bot/Economy/CraftWorkshopService').recipesChanged(crafter.id);
    if (station.workshop) {
        LifeState.acceptLifecycleRow(result.crafterState);
        const committed = LifeState.acceptLifecycleRow(result.customerState);
        state = { ...committed, stats: { ...state.stats, ...committed.stats } };
    } else if (station.clan) {
        LifeState.acceptClanCraftState(result.crafterState);
        const committed = LifeState.acceptClanCraftState(result.customerState);
        state = { ...committed, stats: { ...state.stats, clanInventoryRevision: committed.stats.clanInventoryRevision } };
        state.stats.equipmentPlan.craftProviders[recipe.recipeId].known = true;
    }
    // Workshop/clan publication may replace state with a lifecycle row. Adopt
    // the committed cash afterwards: refreshInventory preserves virtual income
    // with Math.max and cannot reconcile a paid fee from an older balance.
    if (cashReceipt != null) state = { ...state, adena: committedAdena };
    if (!station.clan && !station.workshop) await LifeState.upsertState({
        ...crafterState,
        vitals: { ...(crafterState.vitals || {}), mp: stationService ? crafterMp : crafterMp - Number(recipe.mpCost || 0) }
    }, 'cold_manufacture');
    const craftReturn = state.stats?.craftReturn;
    const timestamp = Date.now();
    // Decide whether to remain at the station after inventory refresh.
    // The crafted output may unlock another component, but if its raw
    // inputs are exhausted the bot must resume farming instead of idling
    // forever in the high-priority crafting queue.
    const refreshed = await refreshPhysicalInventory(!componentCraft && craftReturn?.loc
        ? returnTrip(state, state.loc || station.loc, craftReturn, 'equipment_craft_return', timestamp)
        : { ...state, activity: 'hunting',
            stats: { ...(state.stats || {}), craftReturn: componentCraft ? craftReturn : null, travel: null } });
    const nextReadyRecipe = componentCraft ? readyRecipeFor(refreshed, finalRecipe) : null;
    const continueCrafting = componentCraft
        && !!nextReadyRecipe
        && !C4DualSwordCombinations.isCombination(nextReadyRecipe);
    const returnAfterComponent = componentCraft && !continueCrafting && craftReturn?.loc;
    const settled = continueCrafting
        ? { ...refreshed, activity: 'crafting' }
        : returnAfterComponent
            ? returnTrip(refreshed, state.loc || station.loc, craftReturn, 'component_craft_return', timestamp)
            : refreshed;
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

module.exports = { NATIVE_TRAVEL_MS, isStationService, stationForRecipe, crafterAccount, hasMaterials, hasNonSupplementalMaterials, hasCombinationIngredients, readyRecipeFor, supplementMaterials, craftableBatchCount, requiredCraftCount, beginTravel, craft };
