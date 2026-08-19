const DataCache = invoke('GameServer/DataCache');
const BotEconomyPricing = invoke('GameServer/Bot/Economy/BotEconomyPricing');
const C4RecipeItems = invoke('GameServer/Items/C4RecipeItems');
const C4EnchantScrolls = invoke('GameServer/Items/C4EnchantScrolls');
const CraftShopService = invoke('GameServer/Bot/Economy/CraftShopService');

const SELLABLE_KINDS = ['Weapon.', 'Armor.', 'Other.Material'];
const NPC_ONLY_KINDS = ['Other.Recipe', 'Other.Spellbook'];
const NPC_LIQUIDATION_MAX_UNIT_PRICE = 1000;
const WAREHOUSE_GEAR_MIN_BASE_PRICE = 1000;
const TRADE_MIN_LEVEL = 10;
const INVENTORY_SLOT_LIMIT = 80;
const NPC_ONLY_CLEANUP_MIN_SLOTS = 3;
const GRADE_ORDER = Object.freeze({ none: 0, d: 1, c: 2, b: 3, a: 4, s: 5 });

function templateFor(selfId) {
    return (DataCache.items || []).find((item) => Number(item.selfId) === Number(selfId)) || null;
}

function priceFor(state, item, template) {
    const basePrice = Number(template?.template?.price || 0);
    if (basePrice <= 0) return 0;
    const seed = (Number(state.characterId || 0) * 31) + (Number(item.selfId || 0) * 17);
    const percent = 70 + (Math.abs(seed) % 21);
    const adjustment = Math.max(50, Math.min(100, Number(state?.stats?.marketPricing?.[Number(item.selfId)]?.percent || 100)));
    return BotEconomyPricing.scalePrice(basePrice * percent * adjustment / 10000);
}

function basePrice(item, template = templateFor(item?.selfId)) {
    return Math.max(0, Number(template?.template?.price || 0));
}

function kindFor(item, template = templateFor(item?.selfId)) {
    return item?.kind || template?.template?.kind || '';
}

function isEnchantScroll(item) {
    return !!C4EnchantScrolls.resolve(item?.selfId);
}

function gradeIndex(rank) {
    return GRADE_ORDER[String(rank || 'none').trim().toLowerCase().replaceAll('_', '-')] || 0;
}

function recipeInfo(item) {
    const recipe = C4RecipeItems.resolve(item?.selfId);
    if (!recipe) return null;
    const product = templateFor(recipe.productId);
    return { recipe, product, productRank: product?.etc?.rank || 'none' };
}

function isRecipeItem(item, template = templateFor(item?.selfId)) {
    return !!recipeInfo(item)
        && (kindFor(item, template).startsWith('Other.Recipe')
            || String(item?.name || template?.template?.name || '').toLowerCase().startsWith('recipe'));
}

function isBelowCGrade(item) {
    const info = recipeInfo(item);
    return !!info && gradeIndex(info.productRank) < gradeIndex('c');
}

function isNpcOnlyItem(item, template = templateFor(item?.selfId)) {
    const kind = kindFor(item, template);
    const name = String(item?.name || template?.template?.name || '').toLowerCase();
    return NPC_ONLY_KINDS.some((prefix) => kind.startsWith(prefix))
        || isRecipeItem(item, template)
        || name.includes('spellbook');
}

function canLearnRecipe(state, item) {
    const info = recipeInfo(item);
    if (!info || info.recipe.type !== 'dwarven' || isBelowCGrade(item)) return false;
    const craftLevel = Number(state?.craftLevel ?? state?.stats?.dwarvenCraftLevel
        ?? CraftShopService.craftLevelFor(state) ?? 0);
    if (craftLevel <= 0) return false;
    return craftLevel >= Number(info.recipe.level || 0);
}

function recipeDisposition(state, item, knownRecipeIds = []) {
    const info = recipeInfo(item);
    if (!info || !isRecipeItem(item)) return null;
    const known = new Set((knownRecipeIds || []).map((value) => Number(value)));
    if (!canLearnRecipe(state, item)) return { action: 'npc', reason: 'recipe_not_learnable' };
    if (known.has(Number(info.recipe.recipeId))) return { action: 'npc', reason: 'recipe_already_known' };
    return { action: 'learn', reason: 'recipe_book', recipe: info.recipe };
}

function inventorySlotCount(state = {}) {
    return Object.values(state.inventory || {}).reduce((total, item) => {
        const amount = Math.max(0, Number(item?.amount || 0));
        if (amount <= 0) return total;
        if (Array.isArray(item?.instances)) return total + item.instances.length;
        if (item?.stackable === false) return total + amount;
        return total + 1;
    }, 0);
}

function npcOnlySlotCount(state = {}) {
    return Object.values(state.inventory || {}).reduce((total, item) => {
        if (!isNpcOnlyItem(item)) return total;
        const amount = Math.max(0, Number(item?.amount || 0));
        // NPC liquidation can leave a zero-amount summary entry behind while
        // its old non-stackable instances are still present in the snapshot.
        // Those instances are no longer inventory and must not retrigger town
        // cleanup.
        if (amount <= 0) return total;
        if (Array.isArray(item?.instances)) return total + Math.min(amount, item.instances.length);
        if (item?.stackable === false) return total + amount;
        return total + 1;
    }, 0);
}

function inventoryCleanupNeed(state = {}, options = {}) {
    const timestamp = Number(options.now) || Date.now();
    const slots = inventorySlotCount(state);
    const npcOnlySlots = npcOnlySlotCount(state);
    const overCapacity = slots > INVENTORY_SLOT_LIMIT;
    const accumulatedNpcOnly = npcOnlySlots >= NPC_ONLY_CLEANUP_MIN_SLOTS;
    // A normal market retry cooldown prevents pointless town loops. Residual
    // NPC-only books/recipes and a genuinely full inventory are different:
    // they are deterministic cleanup work and must get another visit even
    // when the previous market attempt ended with no player demand.
    if (Number(state.stats?.marketSellRetryAfter || 0) > timestamp
        && !overCapacity
        && !accumulatedNpcOnly) return null;
    if (!overCapacity && !accumulatedNpcOnly) return null;
    return {
        reason: overCapacity ? 'inventory_capacity' : 'npc_only_inventory',
        slots,
        npcOnlySlots,
        limit: INVENTORY_SLOT_LIMIT
    };
}

function reservedCraftAmounts(state) {
    const plan = state?.stats?.equipmentPlan;
    if (!['active', 'component_ready', 'ready_to_craft'].includes(plan?.status) || plan.strategy !== 'craft') return {};
    return (plan.materials || []).reduce((reserved, material) => {
        const selfId = Number(material.selfId || 0);
        if (!selfId) return reserved;
        reserved[selfId] = Math.max(Number(reserved[selfId] || 0), Math.min(Number(material.owned || 0), Number(material.amount || 0)));
        return reserved;
    }, {});
}

function reservedCombinationAmounts(state) {
    const plan = state?.stats?.equipmentPlan;
    if (!plan?.combine || !['active', 'component_ready', 'ready_to_craft', 'blocked'].includes(plan.status)) return {};
    return (plan.combine.requirements || []).reduce((reserved, requirement) => {
        const selfId = Number(requirement.selfId || 0);
        if (!selfId) return reserved;
        // Hot actors can acquire a component before their cold inventory
        // summary is refreshed. Reserve the objective amount itself so that
        // this short-lived stale snapshot cannot expose the new sword to sale.
        reserved[selfId] = Math.max(Number(reserved[selfId] || 0), Number(requirement.amount || 0));
        return reserved;
    }, {});
}

function reservedEquipmentAmounts(state) {
    const craft = reservedCraftAmounts(state);
    const combination = reservedCombinationAmounts(state);
    return [...new Set([...Object.keys(craft), ...Object.keys(combination)])].reduce((reserved, selfId) => {
        reserved[selfId] = Math.max(Number(craft[selfId] || 0), Number(combination[selfId] || 0));
        return reserved;
    }, {});
}

function actorItemValue(item, property, method) {
    return item?.[method] ? item[method]() : item?.[property];
}

function unreservedActorItems(state, items = []) {
    const reserved = reservedEquipmentAmounts(state);
    (items || []).filter((item) => !!actorItemValue(item, 'equipped', 'fetchEquipped')).forEach((item) => {
        const selfId = Number(actorItemValue(item, 'selfId', 'fetchSelfId') || 0);
        reserved[selfId] = Math.max(0, Number(reserved[selfId] || 0) - Number(actorItemValue(item, 'amount', 'fetchAmount') || 0));
    });
    return (items || []).filter((item) => {
        if (actorItemValue(item, 'equipped', 'fetchEquipped')) return true;
        const selfId = Number(actorItemValue(item, 'selfId', 'fetchSelfId') || 0);
        const protectedAmount = Math.min(
            Number(actorItemValue(item, 'amount', 'fetchAmount') || 0),
            Number(reserved[selfId] || 0)
        );
        reserved[selfId] = Math.max(0, Number(reserved[selfId] || 0) - protectedAmount);
        // Actor inventories keep non-stackable gear in separate rows. For a
        // partially reserved stack, retaining the whole row is conservative
        // and avoids splitting a live item merely for an incidental town task.
        return protectedAmount <= 0;
    });
}

function isTradeEligible(state = {}) {
    // Purpose-built static merchant/craft services are not adventurers and
    // retain their normal storefronts. Generated characters start selling
    // only once their first leveling/gear loop has had time to produce useful
    // surplus.
    if (!state.stats?.generatedCold) return true;
    return Number(state.level || 1) >= TRADE_MIN_LEVEL;
}

function protectedStarterLootAmount(item, kind) {
    const kindName = String(kind || '');
    // Low-level resources remain sellable once the character reaches the
    // trading phase: they are a legitimate early Adena source. No-grade and
    // D-grade gear is junk by policy and must be liquidated in the NPC shop,
    // including copies that came from protected starter-mob loot.
    if (kindName.startsWith('Other.Material')
        || ((kindName.startsWith('Weapon.') || kindName.startsWith('Armor.'))
            && gradeIndex(item?.rank || templateFor(item?.selfId)?.etc?.rank || 'none') < gradeIndex('c'))) return 0;
    return Math.max(0, Math.min(Number(item?.amount || 0), Number(item?.starterMobLootAmount || 0)));
}

function saleCandidates(state, options = {}) {
    if (!isTradeEligible(state)) return [];
    const limit = options.unlimited
        ? Number.MAX_SAFE_INTEGER
        : Math.max(1, Math.min(20, Number(options.limit) || 8));
    const reserved = { ...reservedEquipmentAmounts(state), ...(options.reserved || {}) };
    return Object.values(state?.inventory || {}).flatMap((item) => {
        const selfId = Number(item?.selfId || 0);
        const amount = Number(item?.amount || 0);
        const rawEquippedCount = Number(item?.equippedCount ?? (item?.equipped ? 1 : 0));
        const equippedCount = Math.max(0, Number.isFinite(rawEquippedCount) ? rawEquippedCount : 0);
        const sellableAmount = Math.max(0, amount - equippedCount - Number(reserved[selfId] || 0));
        if (!selfId || selfId === 57 || sellableAmount <= 0) return [];

        const template = templateFor(selfId);
        const kind = kindFor(item, template);
        const npcOnly = isNpcOnlyItem(item, template);
        if (options.onlyNpc === true && !npcOnly) return [];
        if (!npcOnly
            && !isEnchantScroll(item)
            && !SELLABLE_KINDS.some((prefix) => kind.startsWith(prefix))) return [];

        // Recipes and spellbooks are explicit NPC-only cleanup targets. They
        // must not inherit the generic starter-loot protection, otherwise a
        // generated bot can carry the same book forever after a market visit.
        const protectedAmount = npcOnly ? 0 : protectedStarterLootAmount(item, kind);
        const sellableCount = Math.max(0, sellableAmount - protectedAmount);
        const base = basePrice(item, template);
        // Recipes and spellbooks must still be liquidatable when their datapack
        // price is zero. The NPC path applies its own minimum price of one.
        const price = npcOnly ? Math.max(1, priceFor(state, item, template), Math.floor(base * 0.5)) : priceFor(state, item, template);
        if (price <= 0 || sellableCount <= 0) return [];
        return [{
            selfId,
            name: item.name || template?.template?.name || `Item ${selfId}`,
            kind,
            rank: item.rank || template?.etc?.rank || 'none',
            count: sellableCount,
            price,
            basePrice: base
        }];
    }).sort((a, b) => b.price - a.price || a.selfId - b.selfId).slice(0, limit);
}

function npcLiquidationCandidates(state, options = {}) {
    const maxUnitPrice = Math.max(1, Number(options.maxUnitPrice) || NPC_LIQUIDATION_MAX_UNIT_PRICE);
    // Do not pass onlyNpc here: low-grade gear and cheap materials are not
    // intrinsically NPC-only, but the market policy deliberately routes them
    // to the NPC shop during cleanup. Filter the unified sale set after the
    // starter-loot protection has been applied.
    return saleCandidates(state, { unlimited: true }).filter((item) => {
        const gear = String(item.kind || '').startsWith('Weapon.') || String(item.kind || '').startsWith('Armor.');
        const lowGradeGear = gear && gradeIndex(item.rank) < gradeIndex('c');
        return isNpcOnlyItem(item) || lowGradeGear || item.basePrice <= maxUnitPrice;
    }).map((item) => ({
        ...item,
        npcPrice: Math.max(1, Math.floor(item.basePrice * 0.5))
    }));
}

// Materials remain useful for future crafting/trading regardless of their NPC
// value. Gear is worth retaining only once it has crossed out of the starter
// trash band, leaving cheap no-grade drops for liquidation.
function isWarehouseCandidate(item, template = templateFor(item?.selfId)) {
    const selfId = Number(item?.selfId || 0);
    const amount = Number(item?.amount || 0);
    const kind = item?.kind || template?.template?.kind || '';
    if (!selfId || selfId === 57 || amount <= 0 || item?.equipped) return false;
    if (isNpcOnlyItem(item, template)) return false;
    if (kind.startsWith('Other.Material')) return true;
    // Many C4 enchant scrolls are intentionally non-stackable. Preserve
    // valuable surplus in the warehouse so it cannot permanently consume
    // backpack capacity while the peer market has no ready buyer. Other
    // scrolls remain in inventory because bots consume them for travel and
    // party resurrection.
    if (isEnchantScroll(item)) return true;
    return (kind.startsWith('Weapon.') || kind.startsWith('Armor.'))
        && basePrice(item, template) > WAREHOUSE_GEAR_MIN_BASE_PRICE;
}

function warehouseCandidates(state) {
    const reserved = reservedEquipmentAmounts(state);
    return Object.values(state?.inventory || {}).filter((item) => (
        !reserved[Number(item?.selfId || 0)] && isWarehouseCandidate(item)
    ));
}

function saleSummary(state, options = {}) {
    const items = saleCandidates(state, options);
    return {
        items,
        itemCount: items.reduce((sum, item) => sum + Number(item.count || 0), 0),
        marketValue: items.reduce((sum, item) => sum + Number(item.count || 0) * Number(item.price || 0), 0)
    };
}

module.exports = {
    GRADE_ORDER,
    INVENTORY_SLOT_LIMIT,
    NPC_ONLY_CLEANUP_MIN_SLOTS,
    NPC_LIQUIDATION_MAX_UNIT_PRICE,
    NPC_ONLY_KINDS,
    TRADE_MIN_LEVEL,
    WAREHOUSE_GEAR_MIN_BASE_PRICE,
    basePrice,
    canLearnRecipe,
    craftLevelFor: (state) => Number(state?.craftLevel ?? state?.stats?.dwarvenCraftLevel
        ?? CraftShopService.craftLevelFor(state) ?? 0),
    gradeIndex,
    isTradeEligible,
    isBelowCGrade,
    isNpcOnlyItem,
    inventoryCleanupNeed,
    inventorySlotCount,
    npcOnlySlotCount,
    isWarehouseCandidate,
    npcLiquidationCandidates,
    priceFor,
    protectedStarterLootAmount,
    recipeDisposition,
    recipeInfo,
    reservedCombinationAmounts,
    reservedCraftAmounts,
    reservedEquipmentAmounts,
    saleCandidates,
    saleSummary,
    unreservedActorItems,
    warehouseCandidates
};
