// Shared by the planning worker and the runtime. No live-world dependencies.
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const DualSwords = invoke('GameServer/Items/C4DualSwordCombinations');
const DataCache = invoke('GameServer/DataCache');
const ItemIndex = require('../Item/ItemTemplateIndex');

const RESOURCE_IDS = new Set([
    ...Array.from({ length: 32 }, (_, index) => 1864 + index),
    ...Array.from({ length: 9 }, (_, index) => 4039 + index),
    5220, 5549, 5550, 5551, 5552
]);
const isResource = (id) => RESOURCE_IDS.has(Number(id));
const isSupplement = (id) => /^(Crystal:|Gemstone\s)/i.test(ItemIndex.find(DataCache.items, id)?.template?.name || '');
const clanIdFor = (state) => Number(state?.clanId ?? state?.stats?.clanId ?? 0);
const resolveRecipe = (id) => Recipes.resolveByRecipeId(id) || DualSwords.resolveByRecipeId(id);
const isPersonalCraft = (state, plan = state?.stats?.equipmentPlan) => clanIdFor(state) > 0
    && plan?.strategy === 'craft' && Number(plan.clanGoal?.clanId) !== clanIdFor(state)
    // Emergency NPC exchanges consume already owned/bought blades. Ordinary
    // personal crafting and long component-farming chains stay clan-managed.
    && !(plan.weaponBridge === true && DualSwords.resolveByRecipeId(plan.recipeId));

function stockInventory(inventory = {}, rows = []) {
    const result = { ...inventory };
    for (const row of rows) {
        if (!String(row.kind || '').startsWith('Other.Material') && !Recipes.resolve(row.selfId)) continue;
        const amount = Math.max(0, Number(row.amount || 0) - Number(row.reservedAmount || 0));
        const id = Number(row.selfId);
        result[id] = { ...(result[id] || {}), selfId: id, name: row.name,
            amount: Number(result[id]?.amount || 0) + amount };
    }
    return result;
}

// Allocate each owned unit once across the entire recipe tree. Demand includes
// intermediates AND their missing inputs, so stock can shorten either route.
function requirements(recipe, inventory = {}, allowedRecipeIds = null, count = 1, providers = {}, componentRecipes = {}) {
    const owned = new Map(Object.values(inventory).map(item => [Number(item.selfId), Number(item.amount || 0)]));
    const demand = new Map();
    const visit = (current, batches, ancestors) => {
        if (!current || ancestors.has(Number(current.recipeId))) return;
        const seen = new Set(ancestors).add(Number(current.recipeId));
        const materials = (current.materials || []).map(row => ({ ...row }));
        const provider = providers[current.recipeId];
        if (provider && !provider.known) {
            const scroll = materials.find(row => Number(row.selfId) === Number(current.recipeItemId));
            if (scroll) scroll.amount += 1 / batches;
            else materials.push({ selfId: Number(current.recipeItemId), amount: 1 / batches });
        }
        for (const material of materials) {
            const id = Number(material.selfId);
            if (isSupplement(id)) continue;
            const amount = Number(material.amount) * batches;
            demand.set(id, (demand.get(id) || 0) + amount);
            const used = Math.min(amount, owned.get(id) || 0);
            owned.set(id, (owned.get(id) || 0) - used);
            const missing = amount - used;
            const child = missing > 0 ? (Recipes.resolveByRecipeId(componentRecipes[id]) || Recipes.resolveByProductId(id)) : null;
            if (child && (!allowedRecipeIds || allowedRecipeIds.has(Number(child.recipeId)))) {
                visit(child, Math.ceil(missing / Math.max(1, Number(child.productCount))), seen);
            }
        }
    };
    visit(recipe, count, new Set());
    return demand;
}

function warehouseMaterials(plan, inventory, rows) {
    const recipe = resolveRecipe(plan?.recipeId);
    // Personal storage rows have no kind, and dual recipes also consume weapons.
    // Count all available stock here; the recipe tree selects relevant items.
    const combined = { ...inventory };
    for (const row of rows) {
        const id = Number(row.selfId);
        const amount = Math.max(0, Number(row.amount || 0) - Number(row.reservedAmount || 0));
        combined[id] = { ...(combined[id] || {}), selfId: id,
            amount: Number(combined[id]?.amount || 0) + amount };
    }
    const demand = recipe ? requirements(recipe, combined, null, 1, plan.craftProviders, plan.componentRecipes) : new Map((plan?.materials || []).map(m => [Number(m.selfId), Number(m.amount)]));
    const available = new Map();
    for (const row of rows) available.set(Number(row.selfId), (available.get(Number(row.selfId)) || 0)
        + Math.max(0, Number(row.amount) - Number(row.reservedAmount || 0)));
    return [...demand].map(([selfId, required]) => ({ selfId,
        amount: Math.min(available.get(selfId) || 0, Math.max(0, required - Number(inventory?.[selfId]?.amount || 0)))
    })).filter(item => item.amount > 0);
}

module.exports = { RESOURCE_IDS, isResource, isSupplement, clanIdFor, resolveRecipe, isPersonalCraft, stockInventory, requirements, warehouseMaterials };
