const ItemTemplateIndex = require('../../Item/ItemTemplateIndex');
const BeginnerShots = require('../../Items/C4BeginnerShots');
const ClanCrafting = require('../../Clan/ClanCraftingPolicy');
const DataCache = invoke('GameServer/DataCache');
const BotMarketPricing = invoke('GameServer/Bot/Economy/BotMarketPricing');
const C4RecipeItems = invoke('GameServer/Items/C4RecipeItems');
const C4EnchantScrolls = invoke('GameServer/Items/C4EnchantScrolls');
const NpcSellRules = invoke('GameServer/Items/NpcSellRules');
const { CRYSTAL_IDS } = invoke('GameServer/Items/C4EnchantRules');
const CraftShopService = invoke('GameServer/Bot/Economy/CraftShopService');
const ClanSimulationConfig = invoke('GameServer/Clan/ClanSimulationConfig');
const InventoryLimits = require('../../Inventory/InventoryLimits');

const SELLABLE_KINDS = ['Weapon.', 'Armor.', 'Other.Material', 'Other.Shot'];
const NPC_ONLY_KINDS = ['Other.Recipe', 'Other.Spellbook'];
const NPC_LIQUIDATION_MAX_UNIT_PRICE = 1000;
const WAREHOUSE_GEAR_MIN_BASE_PRICE = 1000;
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


function templateFor(selfId) {
    return ItemTemplateIndex.findLast(DataCache.items, selfId, templateFor) || null;
}

// Canonical quest classification cannot be overridden by a saved gear kind.
function isQuestItem(item, template = templateFor(item?.selfId)) {
    return template?.template?.kind === 'Other.Quest'
        || item?.kind === 'Other.Quest' || item?.template?.kind === 'Other.Quest';
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

let StarterItemCatalog = null; // loaded on first use, as the inline require did, then kept

function isStarterEquipment(item, template = templateFor(item?.selfId)) {
    StarterItemCatalog ||= require('../../Knowledge/StarterItemCatalog');
    const starterItemIds = StarterItemCatalog.snapshotIds(DataCache.newbieItems, isStarterEquipment);
    return starterItemIds.has(Number(item?.selfId)) && isEquipmentItem(item, template);
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
    return !!info && info.recipe.type === 'dwarven' && isRecipeItem(item);
}

const CRYSTALS = new Set(Object.values(CRYSTAL_IDS));

function isGradeCrystal(item) {
    return CRYSTALS.has(Number(item?.selfId));
}

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
const CONSUMABLE_KINDS = new Set(['Other', 'Other.None', 'Other.Arrow', 'Other.Potion', 'Other.Scroll', 'Other.Tattoo']);
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

function isNpcOnlyItem(item, template = templateFor(item?.selfId), state = null) {
    if (isQuestItem(item, template)) return false;
    if (isStarterEquipment(item, template)) return true;
    if (isEquipmentItem(item, template)) return false;
    if (isSkillBookItem(item, template)
        || invoke('GameServer/Skills/SkillBookCatalog').isBook(Number(item?.selfId))) return true;
    if (isMarketRecipeItem(item)) return false;
    const kind = kindFor(item, template);
    return kind === 'Other.Tattoo'
        || NPC_ONLY_KINDS.some((prefix) => kind.startsWith(prefix))
        || isSpareConsumable(item, template)
        || isRecipeItem(item, template)
        // Some later C4 skill books lost their canonical Other.Spellbook
        // kind in the source datapack. Orc skill books are named Amulet.
        // Bots receive skills for free, so all books are NPC cleanup.
        || isSkillBookItem(item, template);
}

// A bot learns a recipe it can craft (crafter class, craft level).
function canLearnRecipe(state, item) {
    const info = recipeInfo(item);
    if (!info || info.recipe.type !== 'dwarven'
        || !invoke('GameServer/Items/ItemAcquisitionCatalog').allowsRecipe(info.recipe)) return false;
    return CraftShopService.canCraft(state, info.recipe);
}

function recipeDisposition(state, item, knownRecipeIds = []) {
    const info = recipeInfo(item);
    if (!info || !isRecipeItem(item)) return null;
    if (!invoke('GameServer/Items/ItemAcquisitionCatalog').hasSource(item.selfId)
        || !invoke('GameServer/Items/ItemAcquisitionCatalog').allowsRecipe(info.recipe))
        return { action: 'keep', reason: 'no_acquisition_source' };
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
    return liquidationSlotCount(state, item => isNpcOnlyItem(item, undefined, state), candidates);
}

function skillBookSlotCount(state = {}, candidates) {
    return liquidationSlotCount(state, (item) => isSkillBookItem(item) && isNpcOnlyItem(item, undefined, state), candidates);
}

function soloSaleSlotLimit(state = {}, timestamp = Date.now()) {
    return !(state.party?.partyId || state.partyId)
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
    // Spare creation gear is sold during a town visit, but one unequipped
    // starter weapon must not send a newly spawned hunter straight to town.
    const limit = InventoryLimits.forState(state);
    const overCapacity = slots > limit;
    const accumulatedNpcOnly = skillBookSlots > 0 || npcOnlySlots >= NPC_ONLY_CLEANUP_MIN_SLOTS;
    const surplusGearSlots = slots >= NPC_SURPLUS_GEAR_MIN_SLOTS
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
    // character has enough to clean up. A genuinely full inventory remains
    // actionable regardless of level.
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
        limit
    };
}

// A restock pauses execution, not ownership of inputs already collected for
// the unfinished kit. Legacy paused plans retain their exchange/recipe/combine
// metadata even though GearPlanSelection records strategy='none'. Resolve a
// reservation-only view; never reactivate their travel or crafting action.
function equipmentInputPlan(state, plan = state?.stats?.equipmentPlan) {
    if (plan?.status !== 'deferred' || plan.reason !== 'wish_focus') return plan;
    const strategy = plan.exchange?.kind === 'luxury_exchange' ? 'luxury_exchange'
        : plan.recipeId ? 'craft' : plan.combine ? 'market' : null;
    if (!strategy || !Number(plan.target?.selfId)) return plan;
    const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
    const target = templateFor(plan.combine?.resultId || plan.target.selfId);
    if (!target || !Planner.considerable(target, state) || Planner.equipmentTargetFulfilled(state, plan)) return plan;
    return { ...plan, strategy, status: 'active' };
}

function reservedCraftAmounts(state, plan = equipmentInputPlan(state)) {
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
            const component = missing > 0 ? C4RecipeItems.resolveByRecipeId(plan.componentRecipes?.[selfId])
                || C4RecipeItems.resolveByProductId(selfId) : null;
            if (component) reserve(ClanCrafting.recipeForProvider(component, plan.craftProviders?.[component.recipeId]).materials,
                Math.ceil(missing / Math.max(1, Number(component.productCount || 1))), new Set(visited).add(selfId));
        }
    };
    reserve(plan.materials);
    return reserved;
}

function reservedCombinationAmounts(state, plan = equipmentInputPlan(state)) {
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

// A paused personal kit owns what was collected when it yielded the activity.
// Its missing inputs cannot claim later purchases made for another funded kit.
function capDeferredInputs(plan, amounts) {
    if (plan?.status !== 'deferred' || plan.reason !== 'wish_focus' || !plan.heldInputs) return amounts;
    return Object.fromEntries(Object.entries(amounts).map(([id, amount]) =>
        [id, Math.min(amount, Math.max(0, Number(plan.heldInputs[id]) || 0))]).filter(([, amount]) => amount > 0));
}

function equipmentMaterialAmounts(state, original = state?.stats?.equipmentPlan, options = {}) {
    const plan = equipmentInputPlan(state, original);
    const craft = options.craft === false ? {} : reservedCraftAmounts(state, plan);
    const combine = reservedCombinationAmounts(state, plan);
    const amounts = { ...craft };
    for (const [id, amount] of Object.entries(combine)) amounts[id] = Math.max(Number(amounts[id] || 0), amount);
    const rows = [
        ...(plan?.strategy === 'luxury_exchange' && plan.status === 'active' ? plan.materials || [] : []),
        ...(plan?.status === 'active' ? plan.crystalPreparation?.materials || [] : [])
    ];
    for (const row of rows) amounts[row.selfId] = Math.max(Number(amounts[row.selfId] || 0), Number(row.amount));
    return capDeferredInputs(original, amounts);
}

function collectedEquipmentInputs(state, plan = state?.stats?.equipmentPlan) {
    return Object.fromEntries(Object.entries(equipmentMaterialAmounts(state, plan)).map(([id, amount]) =>
        [id, Math.min(amount, Math.max(0, Number(state.inventory?.[id]?.amount) || 0))])
        .filter(([, amount]) => amount > 0));
}

// A selected finite production kit survives the ingredient trips. Selling
// and storage retain it; the production executor still reads its own inputs.
function productionInputAmounts(state, timestamp = Date.now()) {
    const shot = state?.stats?.shotCraft?.preparing;
    const wealth = state?.stats?.wealthCraft?.outcome === 'buying' ? state.stats.wealthCraft : null;
    const setup = shot && Number(shot.at) + 30 * 60 * 1000 > timestamp ? shot : wealth;
    const recipe = C4RecipeItems.resolveByRecipeId(Number(setup?.recipeId));
    const batches = Number(setup?.batches);
    if (!recipe || !(Number(setup.at) + 30 * 60 * 1000 > timestamp)
        || !Number.isSafeInteger(batches) || batches < 1 || batches > 64) return {};
    return Object.fromEntries(recipe.materials.map(row => [row.selfId, Number(row.amount) * batches]));
}

function saleReservations(state, reserved = reservedEquipmentAmounts(state), timestamp = Date.now()) {
    const result = { ...reserved };
    for (const [id, amount] of Object.entries(productionInputAmounts(state, timestamp)))
        result[id] = Number(result[id] || 0) + amount;
    return result;
}

// Each paused project owns its captured share, including older projects in
// the chain. Do not let a newer project sell or consume that share.
function retainedEquipmentAmounts(state) {
    const owner = state?.stats?.equipmentPlan;
    if (owner?.reason === 'cancelled') return {};
    const result = {}, seen = new Set();
    for (let retained = owner?.inputPreparation; retained && !seen.has(retained); retained = retained.inputPreparation) {
        seen.add(retained);
        const plan = equipmentInputPlan(state, retained);
        if (plan?.strategy === 'none' || plan?.status !== 'active') continue;
        for (const [id, amount] of Object.entries(equipmentMaterialAmounts(state, retained)))
            result[id] = Number(result[id] || 0) + Number(amount || 0);
    }
    return result;
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

function reservedEquipmentAmounts(state, options = {}) {
    if (!state) return {};
    const exchange = equipmentInputPlan(state);
    const inputs = equipmentMaterialAmounts(state, state.stats?.equipmentPlan, options);
    const upgrades = reservedUpgradeAmounts(state);
    const unseal = exchange?.unseal;
    if (unseal && Number(exchange.target?.selfId) === Number(unseal.productId)
        && invoke('GameServer/Items/C4Unseal').resolve(unseal.sourceId, unseal.productId)
        && ['active', 'component_ready', 'ready_to_craft', 'deferred'].includes(exchange.status))
        upgrades[unseal.sourceId] = Math.max(Number(upgrades[unseal.sourceId] || 0), 1);
    for (const [id, amount] of Object.entries(reservedHennaAmounts(state)))
        upgrades[id] = Math.max(Number(upgrades[id] || 0), amount);
    for (const [id, amount] of Object.entries(retainedEquipmentAmounts(state)))
        upgrades[id] = Math.max(Number(upgrades[id] || 0), amount);
    for (const [id, amount] of Object.entries(invoke('GameServer/Bot/AI/PersonalGearProgression').preparedAmounts(state)))
        upgrades[id] = Math.max(Number(upgrades[id] || 0), amount);
    for (const book of invoke('GameServer/Skills/SkillBookCatalog').requiredBooks(state)) {
        upgrades[book.selfId] = Math.max(Number(upgrades[book.selfId] || 0), 1);
    }
    const targetId = Number(state?.stats?.equipmentPlan?.target?.selfId || 0);
    if (targetId && Number(state?.inventory?.[targetId]?.amount || 0) > 0
        && !state.inventory[targetId].equipped) upgrades[targetId] = 1;
    const clan = options.clan === false ? {} : invoke('GameServer/Clan/ClanSupplyPolicy').reservedAmounts(state);
    return [...new Set([...Object.keys(inputs), ...Object.keys(upgrades), ...Object.keys(clan)])].reduce((reserved, selfId) => {
        reserved[selfId] = Math.max(Number(inputs[selfId] || 0),
            Number(upgrades[selfId] || 0)) + Number(clan[selfId] || 0);
        return reserved;
    }, {});
}

// Only the selected, still drawable symbol owns dye inputs. Keeping every
// usable dye would fill the bag again even though the bot can wear three symbols.
function reservedHennaAmounts(state = {}) {
    const key = state.stats?.wishFocus?.[0];
    const match = typeof key === 'string' && /^henna:(\d+)$/.exec(key);
    if (!match) return {};
    const Henna = invoke('GameServer/Henna/HennaRules');
    const classId = state.stats?.classId || state.classId;
    const slots = state.stats?.hennas || [];
    const symbol = Henna.symbol(Number(match[1]));
    if (!symbol || slots.includes(symbol.id) || slots.filter(Boolean).length >= Henna.slotsForClass(classId)
        || !Henna.availableForClass(classId).some(row => row.id === symbol.id)) return {};
    return { [symbol.dyeSelfId]: Number(symbol.dyeAmount) };
}

// Only fields read by the reservation owners above. Plan descriptions,
// observed prices, travel, progress and timestamps cannot change this input.
function reservationInputKey(state = {}) {
    const plan = equipmentInputPlan(state);
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
    return JSON.stringify([Number(plan?.target?.selfId || 0), craftInputs, combine,
        plan?.strategy === 'luxury_exchange' && plan.status === 'active' ? quantities(plan.materials) : null,
        invoke('GameServer/Clan/ClanSupplyPolicy').version(state), retainedEquipmentAmounts(state), reservedHennaAmounts(state),
        state.stats?.equipmentPlan?.heldInputs ?? null, productionInputAmounts(state)]);
}

function actorItemValue(item, property, method) {
    return item?.[method] ? item[method]() : item?.[property];
}

function unreservedActorItems(state, items = []) {
    const reserved = saleReservations(state);
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

function protectedStarterLootAmount(item, kind) {
    const kindName = String(kind || '');
    // Low-level resources and surplus NG/D gear remain sellable once the
    // market evaluates the sale. Market policy later admits the
    // gear only for exact funded demand on the supported rate presets.
    if (kindName.startsWith('Other.Material')
        || ((kindName.startsWith('Weapon.') || kindName.startsWith('Armor.'))
            && gradeIndex(item?.rank || templateFor(item?.selfId)?.etc?.rank || 'none') < gradeIndex('c'))) return 0;
    return Math.max(0, Math.min(Number(item?.amount || 0), Number(item?.starterMobLootAmount || 0)));
}

function saleFreeAmount(state, item, reserved = {}) {
    if (!item) return 0;
    const template = templateFor(item.selfId), kind = kindFor(item, template);
    const protectedAmount = isNpcOnlyItem(item, template, state) ? 0 : protectedStarterLootAmount(item, kind);
    const rawEquippedCount = Number(item.equippedCount ?? (item.equipped ? 1 : 0));
    const equippedCount = Math.max(0, Number.isFinite(rawEquippedCount) ? rawEquippedCount : 0);
    // Sale-specific starter cleanup is preserved; customer, clan and explicit
    // physical reservations use the same stock guard as production.
    return Math.min(Math.max(0, Number(item.amount || 0) - equippedCount
        - Number(reserved[item.selfId] || 0) - protectedAmount),
    invoke('GameServer/Bot/Economy/WealthCraftDecision').freeAmount(state, { ...item,
        equippedCount, starterMobLootAmount: protectedAmount }, reserved));
}

const { selectedCraftAmounts } = require('./CraftInputReservations');
function saleCandidates(state, options = {}) {
    const limit = options.unlimited
        ? Number.MAX_SAFE_INTEGER
        : Math.max(1, Math.min(20, Number(options.limit) || 8));
    const reserved = saleReservations(state, options.preparedReservations || reservedEquipmentAmounts(state), options.now);
    const clan = invoke('GameServer/Clan/ClanSupplyPolicy').reservedAmounts(state);
    for (const [id, amount] of Object.entries(reservedHennaAmounts(state)))
        reserved[id] = Math.max(Number(reserved[id] || 0), amount + Number(clan[id] || 0));
    for (const [id, amount] of Object.entries(options.reserved || {}))
        reserved[id] = Math.max(Number(reserved[id] || 0), Number(amount) + Number(clan[id] || 0));
    // Potions, crafter ammunition and travel scrolls use restock reserves:
    // the held plan's published targets (L72), else the foundation.
    // Ordinary bots retain their current ammunition independently of forecasts.
    const targets = options.keptAmounts ? null
        : invoke('GameServer/Bot/Economy/EconomyContext').keptTargets(state, { saleReservations: reserved });
    const kept = options.keptAmounts || {
        ...invoke('GameServer/Bot/AI/HealingPotionStock').keptAmounts(state, { targetAmount: targets.potions }),
        ...invoke('GameServer/Inventory/ShotStock').keptAmounts(state, null, targets.shots),
        ...invoke('GameServer/Bot/Travel/ScrollStock').keptAmounts(state) };
    for (const [selfId, amount] of Object.entries(kept)) {
        reserved[selfId] = Math.max(Number(reserved[selfId] || 0), amount + Number(clan[selfId] || 0));
    }
    const candidatesFor = (item) => {
        const selfId = Number(item?.selfId || 0);
        // Prepared reserves can describe only the bag while this projection
        // also includes warehouse or escrow stock. Personal shots stay owned.
        if (invoke('GameServer/Inventory/ShotStock').isPersonalShot(state, selfId)) return [];
        const sellableAmount = saleFreeAmount(state, item, reserved);
        if (!selfId || selfId === 57 || BeginnerShots.isRestricted(selfId) || sellableAmount <= 0) return [];

        const template = templateFor(selfId);
        // Unsupported stock stays owned; neither a board sale nor NPC cleanup
        // may turn a service item's nominal price into bot income.
        if (isQuestItem(item, template)
            || !invoke('GameServer/Items/ItemAcquisitionCatalog').hasSource(selfId)) return [];
        const kind = kindFor(item, template);
        const npcOnly = isNpcOnlyItem(item, template, state);
        if (options.onlyNpc === true && !npcOnly) return [];
        const clanProgression = isClanProgressionItem(item);
        if (!npcOnly && !clanProgression && !isMarketRecipeItem(item)
            && !invoke('GameServer/Skills/SkillBookCatalog').isBook(selfId)
            && !isEnchantScroll(item)
            && !CRYSTALS.has(selfId)
            && !SELLABLE_KINDS.some((prefix) => kind.startsWith(prefix))) return [];

        // NPC-only recipes and unmapped books are explicit cleanup targets. They
        // must not inherit the generic starter-loot protection, otherwise a
        // generated bot can carry the same book forever after a market visit.
        const sellableCount = sellableAmount;
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
        if (isClanProgressionItem(item) || isGradeCrystal(item)) return false;
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
    if (isQuestItem(item, template)) return false;
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
    // Personal surplus finances equipment. Craft inputs and accepted native
    // obligations are already protected by reservations, not spare storage.
    if (invoke('GameServer/Bot/AI/PersonalGearProgression').adventurer(state)) {
        const retained = retainedEquipmentAmounts(state);
        const Policy = require('./CraftWarehousePolicy');
        const active = Policy.planFor(state);
        if (!active && !Object.keys(retained).length) return [];
        const Warehouse = invoke('GameServer/Bot/Economy/PersonalWarehouseIndex');
        if (!Warehouse.ready()) return [];
        const stored = Warehouse.inventory(state);
        const primary = equipmentMaterialAmounts(state, state.stats?.equipmentPlan);
        const production = productionInputAmounts(state);
        const clan = invoke('GameServer/Clan/ClanSupplyPolicy').reservedAmounts(state);
        const rows = [];
        // Keep a ready stage in the bag. Otherwise park the active kit's
        // collected materials; key parts stay with the bot during the first stage.
        if (active && !Policy.stage(state, [])) {
            const stock = Policy.available(state, Object.values(stored));
            const combined = { ...state, inventory: stock.combined };
            const demand = equipmentMaterialAmounts(combined, active.plan);
            const keys = new Set(Policy.keyInputs(state, active.recipe).map(row => Number(row.selfId)));
            for (const [id, needed] of Object.entries(demand)) {
                const item = state.inventory?.[id];
                if (!item || item.equipped || keys.has(Number(id)) || !(isWarehouseCandidate(item) || isGradeCrystal(item))) continue;
                const free = Number(stock.bag[id] || 0);
                const amount = Math.min(free, Math.max(0, Number(needed) - Number(stock.warehouse[id] || 0)));
                if (amount > 0) rows.push({ ...item, amount, equipped: false, equippedCount: 0,
                    equippedSlots: [], slot: 0, craftDepositTarget: Number(active.plan.target.selfId), craftDepositKind: 'active' });
            }
        }
        for (const [id, held] of Object.entries(retained)) {
            const item = state.inventory?.[id];
            if (!item || item.equipped || !(isWarehouseCandidate(item) || isGradeCrystal(item))) continue;
            const other = Number(primary[id] || 0) + Number(production[id] || 0) + Number(clan[id] || 0);
            const free = invoke('GameServer/Bot/Economy/WealthCraftDecision').freeAmount(state, item, { [id]: other });
            const amount = Math.min(free, Math.max(0, Number(held) - Number(stored[id]?.amount || 0)));
            if (amount > 0 && !rows.some(row => Number(row.selfId) === Number(id)))
                rows.push({ ...item, amount, equipped: false, equippedCount: 0, equippedSlots: [], slot: 0,
                    craftDepositTarget: Number(state.stats?.equipmentPlan?.inputPreparation?.target?.selfId || 0), craftDepositKind: 'retained' });
        }
        return rows;
    }
    const reserved = saleReservations(state);
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
    WAREHOUSE_GEAR_MIN_BASE_PRICE,
    basePrice,
    canLearnRecipe,
    craftLevelFor: CraftShopService.craftLevelFor,
    gradeIndex,
    isBelowCGrade,
    isClanProgressionItem,
    isGradeCrystal,
    isNpcOnlyItem,
    isQuestItem,
    isRecipeItem,
    recipeProductRank,
    isMarketRecipeItem,
    isShotRecipeItem,
    isSkillBookItem,
    isStarterEquipment,
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
    equipmentMaterialAmounts,
    collectedEquipmentInputs,
    productionInputAmounts,
    saleReservations,
    capDeferredInputs,
    equipmentInputPlan,
    retainedEquipmentAmounts,
    reservationInputKey,
    saleCandidates,
    selectedCraftAmounts,
    saleFreeAmount,
    saleSummary,
    isSpareConsumable,
    unreservedActorItems,
    warehouseCandidates
};
