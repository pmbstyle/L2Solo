'use strict';

// A personal B+ kit owns its stock in both places, but the station can
// consume only the bag. Warehouse stock suppresses orders; a visit moves one
// complete craft stage before the normal executor is allowed to use it.
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const Data = invoke('GameServer/DataCache');
const ItemIndex = require('../../Item/ItemTemplateIndex');
const Profit = require('./CraftProfitPolicy');

function planFor(state) {
    const saved = state?.stats?.equipmentPlan;
    const plan = saved?.status === 'deferred' && saved.reason === 'wish_focus'
        ? invoke('GameServer/Bot/Economy/ItemDisposition').equipmentInputPlan(state, saved) : saved;
    if (!plan?.recipeId || plan.clanGoal || plan.strategy !== 'craft'
        || !['active', 'component_ready', 'ready_to_craft'].includes(plan.status)) return null;
    const target = ItemIndex.find(Data.items, Number(plan.target?.selfId));
    if (!['b', 'a', 's'].includes(String(target?.etc?.rank || '').toLowerCase())) return null;
    const recipe = Recipes.resolveByRecipeId(Number(plan.recipeId));
    return recipe ? { plan, recipe } : null;
}

// Allocate other obligations before this kit, including the retained kit's
// share and a selected production batch. This view is never persisted.
function available(state, rows = []) {
    const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');
    const retained = Disposition.retainedEquipmentAmounts(state);
    const production = Disposition.productionInputAmounts(state);
    const clan = invoke('GameServer/Clan/ClanSupplyPolicy').reservedAmounts(state);
    const stored = new Map();
    for (const row of rows) {
        const id = Number(row.selfId), count = Math.max(0, Number(row.amount || 0) - Number(row.reservedAmount || 0));
        stored.set(id, (stored.get(id) || 0) + count);
    }
    const bag = {}, warehouse = {}, combined = {};
    for (const id of new Set([...Object.keys(state.inventory || {}).map(Number), ...stored.keys()])) {
        const item = state.inventory?.[id] || {}, held = Number(retained[id] || 0)
            + Number(production[id] || 0) + Number(clan[id] || 0);
        const physical = Number(item.amount || 0);
        const free = invoke('GameServer/Bot/Economy/WealthCraftDecision').freeAmount(state, item, { [id]: held });
        const priority = Math.max(held, Number(item.protectedAmount || 0), Number(item.reservedAmount || 0),
            Number(item.starterMobLootAmount || 0), Number(state.stats?.clanMaterialDemand?.[id] || 0));
        const blocked = item.protected || item.acceptedCustomer || item.assignedClan || item.available === false;
        const bank = blocked ? 0 : Math.max(0, Number(stored.get(id) || 0) - Math.max(0, priority - physical));
        bag[id] = free; warehouse[id] = bank;
        combined[id] = { ...item, selfId: id, amount: free + bank, equipped: false, protected: false };
    }
    return { bag, warehouse, combined };
}

function keyInputs(state, recipe) {
    const Craft = invoke('GameServer/Bot/Economy/ColdCraftingService');
    const effective = Craft.recipeForState(state, recipe);
    const part = recipe.materials.find(row => Number(row.selfId) !== Number(recipe.recipeItemId));
    const item = part && ItemIndex.find(Data.items, Number(part.selfId));
    if (item?.template?.kind !== 'Other.Material') return [];
    return (effective.materials || []).filter(row => Number(row.selfId) === Number(part.selfId)
        || Number(row.selfId) === Number(recipe.recipeItemId));
}

function stage(state, rows = []) {
    const selected = planFor(state);
    if (!selected) return null;
    const stock = available(state, rows), keys = keyInputs(state, selected.recipe);
    if (keys.some(row => Number(stock.combined[row.selfId]?.amount || 0) < Number(row.amount))) return null;
    const missingKeys = keys.flatMap(row => {
        const amount = Math.min(Number(stock.warehouse[row.selfId] || 0),
            Math.max(0, Number(row.amount) - Number(stock.bag[row.selfId] || 0)));
        return amount > 0 ? [{ selfId: Number(row.selfId), amount, reason: 'craft' }] : [];
    });
    if (missingKeys.length) return { kind: 'keys', requests: missingKeys };
    const Craft = invoke('GameServer/Bot/Economy/ColdCraftingService');
    const pooled = { ...state, inventory: stock.combined };
    const recipe = Craft.readyRecipeFor(pooled, selected.recipe);
    if (!recipe) return null;
    const effective = Craft.recipeForState(pooled, recipe);
    const count = Math.min(64, Craft.requiredCraftCount(selected.recipe, recipe, pooled));
    if (!Number.isSafeInteger(count) || count < 1
        || Profit.craftableBatches(Object.values(stock.combined), effective, count) < count) return null;
    const required = Profit.requirements(effective, count);
    if (!required) return null;
    const requests = [...required].flatMap(([id, amount]) => {
        const missing = Math.min(Number(stock.warehouse[id] || 0), Math.max(0, amount - Number(stock.bag[id] || 0)));
        return missing > 0 ? [{ selfId: id, amount: missing, reason: 'craft' }] : [];
    });
    return { kind: 'recipe', recipeId: Number(recipe.recipeId), batches: count, requests };
}

module.exports = { planFor, available, keyInputs, stage };
