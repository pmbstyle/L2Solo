const ClanCrafting = require('../../Clan/ClanCraftingPolicy');
const DataCache = invoke('GameServer/DataCache');
const BotMarketPricing = invoke('GameServer/Bot/Economy/BotMarketPricing');
const C4RecipeItems = invoke('GameServer/Items/C4RecipeItems');
const C4EnchantScrolls = invoke('GameServer/Items/C4EnchantScrolls');
const NpcSellRules = invoke('GameServer/Items/NpcSellRules');
const { CRYSTAL_IDS } = invoke('GameServer/Items/C4EnchantRules');
const CraftShopService = invoke('GameServer/Bot/Economy/CraftShopService');
const ClanSimulationConfig = invoke('GameServer/Clan/ClanSimulationConfig');

const SELLABLE_KINDS = ['Weapon.', 'Armor.', 'Other.Material', 'Other.Shot'];
const NPC_ONLY_KINDS = ['Other.Recipe', 'Other.Spellbook'];
const NPC_LIQUIDATION_MAX_UNIT_PRICE = 1000;
const WAREHOUSE_GEAR_MIN_BASE_PRICE = 1000;
const TRADE_MIN_LEVEL = 10;
const INVENTORY_SLOT_LIMIT = 80;
// A forced trip to town starts at 20 slots of either kind (the author: 3 junk, 6
// gear): a gear replacement or a purchase leaves the old piece in the bag, and
// on a young world the author's thresholds sent every bot to town every 40-60
// minutes (live test 2026-10-03: ~9,800 forced trips in 15.7 world hours).
const NPC_ONLY_CLEANUP_MIN_SLOTS = 20;
const NPC_SURPLUS_GEAR_MIN_SLOTS = 20;
// A half-full bag sends the bot to sell, as a player would: on the cold path the forced
// trip is the only thing that takes a hunting bot to town, and the thresholds above
// alone stopped every sale for hours (live, 2026-10-03: 2,513 -> 21 static sales in 2 h).
const HALF_FULL_CLEANUP_SLOTS = 40;
const CLAN_PROGRESSION_ITEM_IDS = new Set([1419]);
const GRADE_ORDER = Object.freeze({ none: 0, d: 1, c: 2, b: 3, a: 4, s: 5 });
const SHOT_PRODUCT_RANK = Object.freeze({
    1463: 'd', 1464: 'c', 1465: 'b', 1466: 'a', 1467: 's',
    2510: 'd', 2511: 'c', 2512: 'b', 2513: 'a', 2514: 's',
    3948: 'd', 3949: 'c', 3950: 'b', 3951: 'a', 3952: 's'
});

let templateIndexSource = null;
let templateIndex = new Map();

function templateFor(selfId) {
    const items = DataCache.items || [];
    if (templateIndexSource !== items) {
        templateIndexSource = items;
        templateIndex = new Map(items.map((item) => [Number(item.selfId), item]));
    }
    return templateIndex.get(Number(selfId)) || null;
}

function priceFor(state, item, template) {
    const basePrice = Number(template?.template?.price || 0);
    if (basePrice <= 0) return 0;
    const crafted = state?.stats?.shotCraft;
    if (String(template?.template?.kind || '') === 'Other.Shot'
        && Number(crafted?.productId) === Number(item.selfId)
        && Number(crafted?.unitPrice || 0) > 0) return Number(crafted.unitPrice);
    // A nominal value of the bag's item (sorting, lot sizes, summaries); a
    // board line's ask is the bot's belief (MarketListingPolicy.evaluate).
    const seed = (Number(state.characterId || 0) * 31) + (Number(item.selfId || 0) * 17);
    const percent = 70 + (Math.abs(seed) % 21);
    return BotMarketPricing.priceAt({ ...item, basePrice, enchant: saleEnchant(item) }, percent / 100);
}

function saleEnchant(item) {
    return Math.max(Number(item?.enchant || 0), ...(item?.instances || [])
        .filter((instance) => !instance.equipped)
        .map((instance) => Number(instance.enchant || 0)));
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

function recipeProductRank(item) {
    const info = recipeInfo(item);
    if (!info) return 'none';
    return String(info.product?.etc?.rank || SHOT_PRODUCT_RANK[Number(info.recipe.productId)] || 'none')
        .toLowerCase();
}

function isRecipeItem(item, template = templateFor(item?.selfId)) {
    return !!recipeInfo(item)
        && (kindFor(item, template).startsWith('Other.Recipe')
            || String(item?.name || template?.template?.name || '').toLowerCase().startsWith('recipe'));
}

function isEquipmentItem(item, template) {
    return [kindFor(item, template), template?.template?.kind || ''].some(value =>
        value.startsWith('Weapon.') || value.startsWith('Armor.'));
}

function isSkillBookItem(item, template = templateFor(item?.selfId)) {
    const kind = kindFor(item, template);
    const name = String(item?.name || template?.template?.name || '').toLowerCase();
    // Caster weapons such as Apprentice's Spellbook are equipment, even
    // when a legacy inventory summary has lost its kind.
    if (isEquipmentItem(item, template)) return false;
    return kind.startsWith('Other.Spellbook')
        || name.includes('spellbook')
        || /^amulet\b/.test(name);
}

function isClanProgressionItem(item) {
    return CLAN_PROGRESSION_ITEM_IDS.has(Number(item?.selfId || 0));
}

function isBelowCGrade(item) {
    const info = recipeInfo(item);
    return !!info && gradeIndex(info.productRank) < gradeIndex('c');
}

function isShotRecipeItem(item) {
    const info = recipeInfo(item);
    return !!info && isRecipeItem(item)
        && String(info.product?.template?.kind || '') === 'Other.Shot';
}

function isMarketRecipeItem(item) {
    const info = recipeInfo(item);
    return !!info && info.recipe.type === 'dwarven' && isRecipeItem(item)
        && gradeIndex(recipeProductRank(item)) >= gradeIndex('d');
}

const CRYSTALS = new Set(Object.values(CRYSTAL_IDS));

// Consumables a bot sells to the NPC beyond what its class keeps: arrows (a
// bot's bow spends none, Actor/BowResources), scrolls other than enchant
// scrolls (the Scrolls of Escape a bot reads for town trips are reserved up to
// their restock target in saleCandidates; no bot reads a scroll of
// resurrection, a party revival casts without an item), potions (the healing
// stock is reserved up to its restock target in saleCandidates), keys, seal
// stones and the like.
// Not spare: Adena, crystals (the shot crafters' input), clan items, any
// recipe material (a crafter's input, e.g. Rope of Magic), and an item the NPC
// pays nothing for (soul crystals, Ancient Adena): those are not bot junk.
const CONSUMABLE_KINDS = new Set(['Other', 'Other.None', 'Other.Arrow', 'Other.Potion', 'Other.Scroll']);
let recipeMaterialSource = null;
let recipeMaterialIds = new Set();

function recipeMaterials() {
    const source = C4RecipeItems.loadRecipeItems();
    if (recipeMaterialSource !== source) {
        recipeMaterialSource = source;
        recipeMaterialIds = new Set(Object.values(source || {})
            .flatMap((recipe) => (recipe.materials || []).map((material) => Number(material.selfId))));
    }
    return recipeMaterialIds;
}

function isSpareConsumable(item, template = templateFor(item?.selfId)) {
    const selfId = Number(actorItemValue(item, 'selfId', 'fetchSelfId') || 0);
    if (!selfId || selfId === 57 || CRYSTALS.has(selfId) || isEnchantScroll({ selfId })
        || CLAN_PROGRESSION_ITEM_IDS.has(selfId) || recipeMaterials().has(selfId)) return false;
    if (!CONSUMABLE_KINDS.has(kindFor(item, template))) return false;
    return basePrice(item, template) > 0;
}

function isNpcOnlyItem(item, template = templateFor(item?.selfId)) {
    if (isEquipmentItem(item, template)) return false;
    if (invoke('GameServer/Skills/SkillBookCatalog').isBook(Number(item?.selfId))) return false;
    if (isMarketRecipeItem(item)) return false;
    const kind = kindFor(item, template);
    return NPC_ONLY_KINDS.some((prefix) => kind.startsWith(prefix))
        || isSpareConsumable(item, template)
        || isRecipeItem(item, template)
        // Some later C4 skill books lost their canonical Other.Spellbook
        // kind in the source datapack. Orc skill books are named Amulet.
        // Unmapped books remain NPC cleanup; mapped C4 books have real demand.
        || isSkillBookItem(item, template);
}

// Materials feed every craft: a dwarf learns their recipes although the
// products are no-grade. Other no-grade recipes stay NPC junk.
function isMaterialRecipe(info) {
    return String(info?.product?.template?.kind || '').startsWith('Other.Material');
}

// A bot learns a recipe it can craft (crafter class, craft level).
function canLearnRecipe(state, item) {
    const info = recipeInfo(item);
    if (!info || info.recipe.type !== 'dwarven') return false;
    if (gradeIndex(recipeProductRank(item)) < gradeIndex('d') && !isMaterialRecipe(info)) return false;
    return CraftShopService.canCraft(state, info.recipe);
}

function recipeDisposition(state, item, knownRecipeIds = []) {
    const info = recipeInfo(item);
    if (!info || !isRecipeItem(item)) return null;
    const known = new Set((knownRecipeIds || []).map((value) => Number(value)));
    if (!canLearnRecipe(state, item)) return isMarketRecipeItem(item)
        ? { action: 'market', reason: 'recipe_not_learnable' }
        : { action: 'npc', reason: 'recipe_not_learnable' };
    if (known.has(Number(info.recipe.recipeId))) return isMarketRecipeItem(item)
        ? { action: 'market', reason: 'recipe_already_known' }
        : { action: 'npc', reason: 'recipe_already_known' };
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

function liquidationSlotCount(state, predicate, candidates = saleCandidates(state, { unlimited: true })) {
    // Share reservations, equipped-copy protection and trade eligibility with
    // the sale path: cleanup must describe work the town visit can execute.
    return candidates.reduce((total, item) => {
        if (!predicate(item)) return total;
        const source = state.inventory?.[item.selfId];
        return total + (source?.stackable === false || Array.isArray(source?.instances)
            ? item.count : 1);
    }, 0);
}

function npcOnlySlotCount(state = {}, candidates) {
    return liquidationSlotCount(state, isNpcOnlyItem, candidates);
}

function skillBookSlotCount(state = {}, candidates) {
    return liquidationSlotCount(state, (item) => isSkillBookItem(item) && isNpcOnlyItem(item), candidates);
}

function soloSaleSlotLimit(state = {}, timestamp = Date.now()) {
    return isTradeEligible(state) && !(state.party?.partyId || state.partyId)
        && !(Number(state.stats?.marketSellRetryAfter || 0) > timestamp)
        ? HALF_FULL_CLEANUP_SLOTS : null;
}

function inventoryCleanupNeed(state = {}, options = {}) {
    const timestamp = Number(options.now) || Date.now();
    const slots = inventorySlotCount(state);
    // One sale set serves every count below; it depends only on the state.
    const candidates = saleCandidates(state, { unlimited: true });
    const npcOnlySlots = npcOnlySlotCount(state, candidates);
    const skillBookSlots = skillBookSlotCount(state, candidates);
    const overCapacity = slots > INVENTORY_SLOT_LIMIT;
    const accumulatedNpcOnly = isTradeEligible(state)
        && (skillBookSlots > 0 || npcOnlySlots >= NPC_ONLY_CLEANUP_MIN_SLOTS);
    const surplusGearSlots = isTradeEligible(state) && slots >= NPC_SURPLUS_GEAR_MIN_SLOTS
        ? candidates.reduce((total, item) => {
            const lowGradeGear = (String(item.kind || '').startsWith('Weapon.')
                || String(item.kind || '').startsWith('Armor.'))
                && gradeIndex(item.rank) < gradeIndex('c');
            return total + (lowGradeGear && item.npcComparable !== false
                && item.basePrice <= 50000 ? Number(item.count || 0) : 0);
        }, 0) : 0;
    const accumulatedSurplus = surplusGearSlots >= NPC_SURPLUS_GEAR_MIN_SLOTS;
    // Solo bots only: a party member sells from the field (AFK listing) and leaves its
    // party for the market only with a full bag (PartyMarketBreak); and only with
    // something to sell, else the trip would repeat every retry period.
    const soloLimit = soloSaleSlotLimit(state, timestamp);
    const halfFull = soloLimit !== null && slots >= soloLimit && candidates.length > 0;
    // A normal market retry cooldown prevents pointless town loops. Residual
    // NPC-only books/recipes become deterministic cleanup work once a
    // generated character reaches its trading phase. Before that point they
    // are deferred instead of creating a market trip that cannot execute.
    // A genuinely full inventory remains actionable at every level.
    if (Number(state.stats?.marketSellRetryAfter || 0) > timestamp
        && !overCapacity
        && !accumulatedNpcOnly) return null;
    if (!overCapacity && !accumulatedNpcOnly && !accumulatedSurplus && !halfFull) return null;
    return {
        reason: overCapacity ? 'inventory_capacity'
            : accumulatedNpcOnly ? 'npc_only_inventory'
            : halfFull ? 'inventory_half_full' : 'market_surplus_inventory',
        slots,
        npcOnlySlots,
        ...(overCapacity || accumulatedNpcOnly || halfFull ? {} : { surplusGearSlots }),
        limit: INVENTORY_SLOT_LIMIT
    };
}

function reservedCraftAmounts(state) {
    const plan = state?.stats?.equipmentPlan;
    if (!['active', 'component_ready', 'ready_to_craft'].includes(plan?.status) || plan.strategy !== 'craft') return {};
    if (plan.clanGoal?.clanId && plan.recipeId) return Object.fromEntries(ClanCrafting.requirements(
        ClanCrafting.resolveRecipe(plan.recipeId), state.inventory, null, 1, plan.craftProviders, plan.componentRecipes));
    const reserved = {};
    const reserve = (materials, multiplier = 1, visited = new Set()) => {
        for (const material of materials || []) {
            const selfId = Number(material.selfId || 0);
            if (!selfId || visited.has(selfId)) continue;
            const required = Number(material.amount || 0) * multiplier;
            reserved[selfId] = Number(reserved[selfId] || 0) + required;
            const owned = Number(state.inventory?.[selfId]?.amount ?? material.owned ?? 0);
            const missing = Math.max(0, required - owned);
            const component = missing > 0 ? C4RecipeItems.resolveByProductId(selfId) : null;
            if (component) reserve(component.materials,
                Math.ceil(missing / Math.max(1, Number(component.productCount || 1))), new Set(visited).add(selfId));
        }
    };
    reserve(plan.materials);
    return reserved;
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

function reservedUpgradeAmounts(state) {
    const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
    const role = Planner.roleFor(state);
    const classId = Number(state?.stats?.classId || state?.classId || 0);
    const allowedRank = gradeIndex(Planner.gradeForLevel(state?.level));
    const equippedBySlot = new Map();
    const stagedBySlot = new Map();
    for (const entry of Object.values(state?.inventory || {})) {
        const template = templateFor(entry?.selfId);
        const slot = Number(template?.etc?.slot || 0);
        if (!isEquipmentItem(entry, template) || ![6, 9, 10, 11, 12, 15].includes(slot)) continue;
        const rank = gradeIndex(template?.etc?.rank);
        const score = Planner.itemScore(template, role, classId);
        const candidate = { selfId: Number(entry.selfId), rank, score };
        if (entry.equipped || Number(entry.equippedCount || 0) > 0) {
            equippedBySlot.set(slot, candidate);
            continue;
        }
        if (Number(entry.amount || 0) < 1 || rank > allowedRank
            || !Planner.suitable(template, state, role, template.etc?.rank)) continue;
        const current = stagedBySlot.get(slot);
        if (!current || rank > current.rank || rank === current.rank && score > current.score) {
            stagedBySlot.set(slot, candidate);
        }
    }
    const reserved = {};
    for (const [slot, candidate] of stagedBySlot) {
        const worn = slot === 15
            ? [equippedBySlot.get(15), equippedBySlot.get(10), equippedBySlot.get(11)]
                .filter(Boolean).sort((left, right) => right.rank - left.rank || right.score - left.score)[0]
            : equippedBySlot.get(slot) || ([10, 11].includes(slot) ? equippedBySlot.get(15) : null);
        if (!worn || candidate.rank > worn.rank
            || candidate.rank === worn.rank && candidate.score > worn.score) {
            reserved[candidate.selfId] = 1;
        }
    }
    return reserved;
}

function reservedEquipmentAmounts(state) {
    if (!state) return {};
    const craft = reservedCraftAmounts(state);
    const combination = reservedCombinationAmounts(state);
    const upgrades = reservedUpgradeAmounts(state);
    for (const book of invoke('GameServer/Skills/SkillBookCatalog').requiredBooks(state)) {
        upgrades[book.selfId] = Math.max(Number(upgrades[book.selfId] || 0), 1);
    }
    const targetId = Number(state?.stats?.equipmentPlan?.target?.selfId || 0);
    if (targetId && Number(state?.inventory?.[targetId]?.amount || 0) > 0
        && !state.inventory[targetId].equipped) upgrades[targetId] = 1;
    return [...new Set([...Object.keys(craft), ...Object.keys(combination), ...Object.keys(upgrades)])].reduce((reserved, selfId) => {
        reserved[selfId] = Math.max(Number(craft[selfId] || 0), Number(combination[selfId] || 0),
            Number(upgrades[selfId] || 0));
        return reserved;
    }, {});
}

// Only fields read by the reservation owners above. Plan descriptions,
// observed prices, travel, progress and timestamps cannot change this input.
function reservationInputKey(state = {}) {
    const plan = state.stats?.equipmentPlan;
    const craft = ['active', 'component_ready', 'ready_to_craft'].includes(plan?.status)
        && plan.strategy === 'craft';
    const quantities = rows => (rows || []).map(row => [Number(row.selfId || 0), Number(row.amount || 0)]);
    const clanCraft = craft && plan.clanGoal?.clanId && plan.recipeId;
    const craftInputs = !craft ? null : clanCraft
        ? [Number(plan.recipeId), Object.entries(plan.craftProviders || {})
            .map(([id, provider]) => [Number(id), !!provider && !provider.known]).sort((a, b) => a[0] - b[0]),
        Object.entries(plan.componentRecipes || {}).map(([id, recipe]) => [Number(id), Number(recipe)]).sort((a, b) => a[0] - b[0])]
        : (plan.materials || []).map(row => [Number(row.selfId || 0), Number(row.amount || 0),
            state.inventory?.[row.selfId]?.amount == null ? Number(row.owned || 0) : null]);
    const combine = plan?.combine && ['active', 'component_ready', 'ready_to_craft', 'blocked'].includes(plan.status)
        ? quantities(plan.combine.requirements) : null;
    return JSON.stringify([Number(plan?.target?.selfId || 0), craftInputs, combine]);
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
    // Low-level resources and surplus NG/D gear remain sellable once the
    // character reaches the trading phase. Market policy later admits the
    // gear only for exact funded demand on the supported rate presets.
    if (kindName.startsWith('Other.Material')
        || ((kindName.startsWith('Weapon.') || kindName.startsWith('Armor.'))
            && gradeIndex(item?.rank || templateFor(item?.selfId)?.etc?.rank || 'none') < gradeIndex('c'))) return 0;
    return Math.max(0, Math.min(Number(item?.amount || 0), Number(item?.starterMobLootAmount || 0)));
}

function saleCandidates(state, options = {}) {
    if (!isTradeEligible(state) && !options.allowPreTradeCleanup) return options.presenceOnly ? false : [];
    const limit = options.unlimited
        ? Number.MAX_SAFE_INTEGER
        : Math.max(1, Math.min(20, Number(options.limit) || 8));
    const reserved = { ...(options.preparedReservations || reservedEquipmentAmounts(state)), ...(options.reserved || {}) };
    // The healing potions, the bot's own shots and the Scrolls of Escape a bot
    // spends are kept up to their restock targets; a surplus is sold.
    const basics = options.keptAmounts ? null
        : invoke('GameServer/Bot/Economy/EconomyContext').basics(state, { saleReservations: reserved });
    const kept = options.keptAmounts || {
        ...invoke('GameServer/Bot/AI/HealingPotionStock').keptAmounts(state, { targetAmount: basics.stock('potions').target }),
        ...invoke('GameServer/Inventory/ShotStock').keptAmounts(state, basics),
        ...invoke('GameServer/Bot/Travel/ScrollStock').keptAmounts(state) };
    for (const [selfId, amount] of Object.entries(kept)) {
        reserved[selfId] = Math.max(Number(reserved[selfId] || 0), amount);
    }
    const candidatesFor = (item) => {
        const selfId = Number(item?.selfId || 0);
        if (ClanCrafting.clanIdFor(state) && (ClanCrafting.isResource(selfId)
            || Number(state.stats?.clanMaterialDemand?.[selfId] || 0) > 0)) return [];
        const amount = Number(item?.amount || 0);
        const rawEquippedCount = Number(item?.equippedCount ?? (item?.equipped ? 1 : 0));
        const equippedCount = Math.max(0, Number.isFinite(rawEquippedCount) ? rawEquippedCount : 0);
        const sellableAmount = Math.max(0, amount - equippedCount - Number(reserved[selfId] || 0));
        if (!selfId || selfId === 57 || sellableAmount <= 0) return [];

        const template = templateFor(selfId);
        const kind = kindFor(item, template);
        const npcOnly = isNpcOnlyItem(item, template);
        if (options.onlyNpc === true && !npcOnly) return [];
        const clanProgression = isClanProgressionItem(item);
        if (!npcOnly && !clanProgression && !isMarketRecipeItem(item)
            && !invoke('GameServer/Skills/SkillBookCatalog').isBook(selfId)
            && !isEnchantScroll(item)
            && !SELLABLE_KINDS.some((prefix) => kind.startsWith(prefix))) return [];

        // NPC-only recipes and unmapped books are explicit cleanup targets. They
        // must not inherit the generic starter-loot protection, otherwise a
        // generated bot can carry the same book forever after a market visit.
        const protectedAmount = npcOnly ? 0 : protectedStarterLootAmount(item, kind);
        const sellableCount = Math.max(0, sellableAmount - protectedAmount);
        const base = basePrice(item, template);
        // Recipes and spellbooks must still be liquidatable when their datapack
        // price is zero. The NPC path applies its own minimum price of one.
        const clanPrice = clanProgression
            ? Math.max(1, Number(state?.stats?.clanMarketDemand?.itemId) === selfId
                ? Number(state?.stats?.clanMarketDemand?.maxPrice || 0)
                : Number(ClanSimulationConfig.bloodMarkMaxPrice || 1))
            : 0;
        const price = clanProgression
            ? clanPrice
            : npcOnly ? Math.max(priceFor(state, item, template), NpcSellRules.npcBuyPrice(base)) : priceFor(state, item, template);
        if (price <= 0 || sellableCount <= 0) return [];
        if (options.presenceOnly) return [true];
        const candidate = {
            selfId,
            name: item.name || template?.template?.name || `Item ${selfId}`,
            kind,
            rank: isMarketRecipeItem(item)
                ? recipeProductRank(item) : item.rank || template?.etc?.rank || 'none',
            count: sellableCount,
            enchant: 0, npcComparable: true,
            price,
            basePrice: base
        };
        if (!Array.isArray(item.instances) || !item.instances.length) return [{ ...candidate,
            enchant:Number(item.enchant || 0),npcComparable:Number(item.enchant || 0)===0 }];
        const groups = new Map();
        let left = sellableCount;
        for (const instance of item.instances) {
            if (instance.equipped || left <= 0) continue;
            const count = Math.min(left, Number(instance.amount || 1));
            const enchant = Number(instance.enchant || 0);
            const row = groups.get(enchant) || { ...candidate,count:0,enchant,npcComparable:enchant===0,
                objectId:Number(instance.id),objectIds:[] };
            row.count += count;row.objectIds.push(Number(instance.id));groups.set(enchant,row);left -= count;
        }
        if (left > 0) { const row = groups.get(0) || {...candidate,count:0};row.count += left;groups.set(0,row); }
        return [...groups.values()];
    };
    if (options.presenceOnly) {
        for (const item of Object.values(state?.inventory || {})) if (candidatesFor(item).length) return true;
        return false;
    }
    return Object.values(state?.inventory || {}).flatMap(candidatesFor).sort((a, b) => {
        const craftedShotId = Number(state?.stats?.shotCraft?.productId || 0);
        const craftedPriority = Number(b.selfId === craftedShotId) - Number(a.selfId === craftedShotId);
        return craftedPriority || b.price - a.price || a.selfId - b.selfId;
    }).slice(0, limit);
}

function npcLiquidationCandidates(state, options = {}) {
    const maxUnitPrice = Math.max(1, Number(options.maxUnitPrice) || NPC_LIQUIDATION_MAX_UNIT_PRICE);
    // Do not pass onlyNpc here: low-grade gear and cheap materials are not
    // intrinsically NPC-only, but the market policy deliberately routes them
    // to the NPC shop during cleanup. Filter the unified sale set after the
    // starter-loot protection has been applied.
    return saleCandidates(state, {
        unlimited: true,
        allowPreTradeCleanup: options.allowPreTradeCleanup === true
    }).filter((item) => {
        if (isClanProgressionItem(item)) return false;
        const gear = String(item.kind || '').startsWith('Weapon.') || String(item.kind || '').startsWith('Armor.');
        const lowGradeGear = gear && gradeIndex(item.rank) < gradeIndex('c');
        return isNpcOnlyItem(item) || lowGradeGear || item.basePrice <= maxUnitPrice;
    }).map((item) => ({
        ...item,
        npcPrice: NpcSellRules.npcBuyPrice(item.basePrice)
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
    if (isClanProgressionItem(item)) return true;
    if (isNpcOnlyItem(item, template)) return false;
    if (kind.startsWith('Other.Material')) return true;
    // Many C4 enchant scrolls are intentionally non-stackable. Preserve
    // valuable surplus in the warehouse so it cannot permanently consume
    // backpack capacity while the peer market has no ready buyer. Other
    // scrolls are no bot's consumables: the NPC buys them (isSpareConsumable).
    if (isEnchantScroll(item)) return true;
    return (kind.startsWith('Weapon.') || kind.startsWith('Armor.'))
        && basePrice(item, template) > WAREHOUSE_GEAR_MIN_BASE_PRICE;
}

function warehouseCandidates(state) {
    const reserved = reservedEquipmentAmounts(state);
    return Object.values(state?.inventory || {}).flatMap((item) => {
        const equipped = Math.max(0, Number(item.equippedCount ?? (item.equipped ? 1 : 0)) || 0);
        // Reservations include equipped copies, as in unreservedActorItems.
        const keep = Math.max(equipped, Number(reserved[Number(item.selfId)] || 0));
        const amount = Math.max(0, Number(item.amount || 0) - keep);
        const candidate = { ...item, amount, equipped: false, equippedCount: 0, equippedSlots: [], slot: 0 };
        return amount > 0 && isWarehouseCandidate(candidate) ? [candidate] : [];
    });
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
    CLAN_PROGRESSION_ITEM_IDS,
    TRADE_MIN_LEVEL,
    WAREHOUSE_GEAR_MIN_BASE_PRICE,
    basePrice,
    canLearnRecipe,
    craftLevelFor: CraftShopService.craftLevelFor,
    gradeIndex,
    isTradeEligible,
    isBelowCGrade,
    isClanProgressionItem,
    isNpcOnlyItem,
    isRecipeItem,
    recipeProductRank,
    isMarketRecipeItem,
    isShotRecipeItem,
    isSkillBookItem,
    inventoryCleanupNeed,
    inventorySlotCount,
    soloSaleSlotLimit,
    npcOnlySlotCount,
    skillBookSlotCount,
    isWarehouseCandidate,
    npcLiquidationCandidates,
    priceFor,
    protectedStarterLootAmount,
    recipeDisposition,
    recipeInfo,
    reservedCombinationAmounts,
    reservedCraftAmounts,
    reservedEquipmentAmounts,
    reservationInputKey,
    saleCandidates,
    saleSummary,
    isSpareConsumable,
    unreservedActorItems,
    warehouseCandidates
};
