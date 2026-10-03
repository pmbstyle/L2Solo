// Manual craft orders use the same travelling customers, learned dwarf recipes
// and atomic crafts as automatic clan production. Planning stays on clan actions.
const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Shops = invoke('GameServer/Bot/Economy/CraftShopService');
const ColdCrafting = invoke('GameServer/Bot/Economy/ColdCraftingService');
const Gear = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const Spots = invoke('GameServer/Bot/AI/SpotService');
const Crafting = require('./ClanCraftingPolicy');
const ItemIndex = require('../Item/ItemTemplateIndex');
const idOf = member => Number(member.characterId ?? member.id);
const itemName = id => ItemIndex.find(DataCache.items, id)?.template?.name || `Item ${id}`;

function recipesForItem(itemId) {
    return Object.values(Recipes.loadRecipeItems()).filter(recipe => recipe.type === 'dwarven'
        && Number(recipe.productId) === Number(itemId))
        .sort((a, b) => b.successRate - a.successRate || a.recipeId - b.recipeId);
}

async function planFor(order, clan, remaining, options = {}) {
    const base = { kind: 'prepare', selectedAt: Date.now() };
    const recipes = recipesForItem(order.itemId);
    if (!recipes.length) return { ...base, reasonCode: 'clan_craft_recipe_unavailable' };
    const roster = order.memberIds?.length ? order.memberIds : clan.state.memberIds;
    const states = await Life.statesByIds(roster);
    const crafters = states.filter(state => state.phase === 'cold' && Number(state.vitals?.hp) > 0 && Shops.craftLevelFor(state) > 0
        && !['dead', 'respawning'].includes(state.activity));
    const knowledge = await Database.execute([`SELECT recipes.characterId, recipes.recipeId FROM character_recipes recipes
        JOIN characters members ON members.id = recipes.characterId WHERE members.clanId = ?`, [clan.id]]);
    const known = (member, recipe) => knowledge.some(row => Number(row.characterId) === idOf(member)
        && Number(row.recipeId) === Number(recipe.recipeId));
    const providerFor = recipe => crafters.filter(state => Shops.craftLevelFor(state) >= recipe.level)
        .sort((a, b) => Number(known(b, recipe)) - Number(known(a, recipe)) || idOf(a) - idOf(b))[0];
    const recipe = recipes.find(candidate => providerFor(candidate)) || recipes[0];
    const crafter = providerFor(recipe);
    const craft = { recipeId: recipe.recipeId, recipeItemId: recipe.recipeItemId, level: recipe.level,
        successRate: recipe.successRate, productCount: recipe.productCount,
        remaining, crafterId: crafter ? idOf(crafter) : null, crafterName: crafter?.name || null,
        learned: !!crafter && known(crafter, recipe), materials: [], stage: 'blocked' };
    if (!crafter) return { ...base, craft, reasonCode: 'clan_craft_crafter_unavailable' };
    const customer = states.find(state => state.stats?.equipmentPlan?.clanGoal?.orderId === order.id)
        || states.filter(state => state.phase === 'cold' && Number(state.vitals?.hp) > 0 && !['dead', 'respawning'].includes(state.activity))
            .sort((a, b) => Number(idOf(a) === idOf(crafter)) - Number(idOf(b) === idOf(crafter)) || idOf(a) - idOf(b))[0];
    if (!customer) return { ...base, craft, reasonCode: 'clan_craft_customer_unavailable' };
    const providers = {};
    const componentRecipes = {};
    const allowed = new Set();
    const visit = (current, seen = new Set()) => {
        if (!current || seen.has(current.recipeId)) return;
        seen.add(current.recipeId);
        const member = providerFor(current);
        if (!member) return;
        providers[current.recipeId] = { characterId: idOf(member), known: known(member, current),
            recipeItemId: current.recipeItemId, loc: member.loc };
        allowed.add(current.recipeId);
        for (const material of current.materials) {
            const child = recipesForItem(material.selfId).find(candidate => providerFor(candidate));
            if (child) { componentRecipes[material.selfId] = child.recipeId; visit(child, seen); }
        }
    };
    visit(recipe);
    const rows = await Database.fetchClanWarehouseItems(clan.id);
    const inventory = { ...customer.inventory };
    for (const row of rows) {
        const selfId = Number(row.selfId);
        const available = Math.max(0, Number(row.amount) - Number(row.reservedAmount));
        inventory[selfId] = { ...(inventory[selfId] || {}), selfId, name: row.name,
            amount: Number(inventory[selfId]?.amount || 0) + available };
    }
    const demand = Crafting.requirements(recipe, inventory, allowed, 1, providers, componentRecipes);
    craft.customerId = idOf(customer);
    craft.customerName = customer.name;
    craft.materials = [...demand].map(([selfId, required]) => ({ selfId, name: itemName(selfId), required,
        available: Number(inventory[selfId]?.amount || 0),
        missing: Math.max(0, required - Number(inventory[selfId]?.amount || 0)),
        component: !!componentRecipes[selfId] }));
    const nativePlan = { strategy: 'craft', recipeId: recipe.recipeId,
        target: { selfId: Number(order.itemId), name: itemName(order.itemId),
            slot: Number(ItemIndex.find(DataCache.items, order.itemId)?.etc?.slot || 0) },
        craftProviders: providers, componentRecipes, materials: Gear.missingMaterials(recipe, inventory),
        clanGoal: { clanId: clan.id, goalKey: `player-order:${order.id}:craft`, orderId: order.id }, next: null };
    const ready = ColdCrafting.readyRecipeFor({ ...customer, inventory,
        stats: { ...customer.stats, equipmentPlan: nativePlan } }, recipe);
    nativePlan.status = ready?.recipeId === recipe.recipeId ? 'ready_to_craft' : ready ? 'component_ready' : 'active';
    nativePlan.warehouseMaterials = Crafting.warehouseMaterials(nativePlan, customer.inventory, rows);
    craft.nativePlan = nativePlan;
    if (ready) {
        craft.stage = ready.recipeId === recipe.recipeId ? 'crafting' : 'components';
        craft.nextItemName = itemName(ready.productId);
        return { kind: 'craft', craft, reasonCode: ready.recipeId === recipe.recipeId
            ? 'clan_craft_ready' : 'clan_craft_component_ready', selectedAt: Date.now() };
    }
    const shortages = craft.materials.filter(material => material.missing > 0 && !material.component);
    for (const material of shortages) {
        const source = options.source === null ? null : options.source
            || Gear.sourceForItem(material.selfId, Spots.ensureIndexed(), customer)
                .find(candidate => Number(candidate.npcLevel || candidate.spotLevel) <= Math.max(...states.map(state => state.level)) + 5);
        if (!source) continue;
        craft.stage = 'resources';
        craft.nextItemName = material.name;
        return { kind: 'farm', craft, sourceId: Number(source.npcId), sourceName: source.npcName,
            sourceSpotId: source.spotId, sourceLevel: Number(source.npcLevel || source.spotLevel),
            reasonCode: 'clan_craft_collecting_materials', selectedAt: Date.now() };
    }
    return { ...base, craft, reasonCode: 'clan_craft_material_source_unavailable' };
}

async function assign(clan, order, goal) {
    const craft = goal.plan?.craft;
    if (goal.plan?.kind !== 'craft' || !craft?.nativePlan) return null;
    const Equipment = invoke('GameServer/Clan/ClanEquipmentService');
    await Equipment.releaseConflictingRosterParties([...new Set([craft.customerId,
        ...Object.values(craft.nativePlan.craftProviders).map(provider => provider.characterId)])], goal);
    let [member] = await Life.statesByIds([craft.customerId]);
    if (!member) return { ok: false, code: 'clan_craft_customer_unavailable' };
    if (member.simulation?.ownerId === 'cold_simulation_owner') {
        if (!await Database.materializeClanSupplies(member.characterId, member.simulation.revision,
            craft.materials.map(material => material.selfId))) return { ok: false, code: 'stale_snapshot' };
        const handoff = await invoke('GameServer/Bot/Population/ColdSimulationOwner').handoffToMain(member);
        if (!handoff.ok) return { ok: false, code: 'clan_craft_customer_unavailable' };
        [member] = await Life.statesByIds([craft.customerId]);
    }
    const assignmentGoal = { ...goal, goalKey: `player-order:${order.id}:craft`,
        target: { ...goal.target, memberId: craft.customerId }, orderSettings: {
            itemId: order.itemId, amount: order.amount, strategy: order.strategy,
            memberIds: order.memberIds, maxUnitPrice: order.maxUnitPrice, budget: order.budget } };
    return Equipment.assignPlan(member, craft.nativePlan, clan, assignmentGoal);
}

module.exports = { recipesForItem, planFor, assign };
