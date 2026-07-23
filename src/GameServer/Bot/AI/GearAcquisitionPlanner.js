const DataCache = invoke('GameServer/DataCache');
const C4RecipeItems = invoke('GameServer/Items/C4RecipeItems');
const ProgressionRates = invoke('GameServer/ProgressionRates');
const BotRoles = invoke('GameServer/Bot/AI/BotRoles');
const CraftShopService = invoke('GameServer/Bot/Economy/CraftShopService');
const CraftSupplementMaterials = invoke('GameServer/Bot/Economy/CraftSupplementMaterials');
const BotGear = invoke('GameServer/Bot/AI/BotGear');
const GearLifecycle = invoke('GameServer/Bot/AI/GearLifecycle');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');

const RANKS = ['none', 'd', 'c', 'b', 'a', 's'];
const WEAPON_SLOTS = new Set([7, 14]);
const ARMOR_SLOTS = new Set([6, 9, 10, 11, 12, 15]);
const JEWEL_SLOTS = new Set([1, 2, 3, 4, 5]);
const RATE_MODEL_VERSION = 2;

function gradeForLevel(level) {
    const value = Number(level || 1);
    if (value >= 76) return 's';
    if (value >= 61) return 'a';
    if (value >= 52) return 'b';
    if (value >= 40) return 'c';
    if (value >= 20) return 'd';
    return 'none';
}

function roleFor(state = {}) {
    return state.party?.role || state.stats?.role || BotRoles.inferRole({
        fetchClassId: () => Number(state.stats?.classId || state.classId || 0)
    }) || 'dps';
}

function isCraftService(state = {}) {
    return state.activity === 'crafting'
        && !!state.stats?.craftShop
        && (Boolean(state.stats?.craftStationId) || Number(state.stats?.generatedIndex || 0) >= 10000);
}

function armorKindFor(role) {
    if (['mage', 'healer', 'buffer'].includes(role)) return 'Armor.Fabric';
    if (['archer', 'dagger'].includes(role)) return 'Armor.Leather';
    return 'Armor.Chain';
}

function weaponKindsFor(role, classId) {
    if (role === 'archer') return ['Weapon.Bow'];
    if (role === 'dagger') return ['Weapon.Knife'];
    if (['mage', 'healer', 'buffer'].includes(role)) return ['Weapon.Sword', 'Weapon.Blunt'];
    if ([44, 45, 47, 49, 50, 51, 53, 54, 56].includes(Number(classId))) return ['Weapon.Blunt'];
    return ['Weapon.Sword', 'Weapon.Blunt'];
}

function inventoryMap(inventory = {}) {
    return Array.isArray(inventory)
        ? new Map(inventory.map((item) => [Number(item.selfId), Number(item.amount || 0)]))
        : new Map(Object.values(inventory).map((item) => [Number(item.selfId), Number(item.amount || 0)]));
}

function inventoryItems(inventory = {}) {
    const rows = Array.isArray(inventory) ? inventory : Object.values(inventory);
    return rows.flatMap((row) => {
        if (Number(row?.amount || 0) < 1) return [];
        const item = (DataCache.items || []).find((entry) => Number(entry.selfId) === Number(row.selfId));
        return item ? [item] : [];
    });
}

function itemScore(item, role) {
    const stats = item.stats || {};
    const slot = Number(item.etc?.slot || 0);
    if (WEAPON_SLOTS.has(slot)) return (['mage', 'healer', 'buffer'].includes(role) ? 3 * Number(stats.mAtk || 0) + Number(stats.pAtk || 0) : 2 * Number(stats.pAtk || 0) + Number(stats.mAtk || 0));
    if (JEWEL_SLOTS.has(slot)) return Number(stats.mDef || 0);
    return Number(stats.pDef || 0) + Number(item.etc?.mp || 0);
}

function suitable(item, state, role, requiredRank = gradeForLevel(state.level)) {
    const rank = String(item.etc?.rank || 'none').toLowerCase();
    if (rank !== requiredRank) return false;
    const kind = item.template?.kind || '';
    const slot = Number(item.etc?.slot || 0);
    if (WEAPON_SLOTS.has(slot)) return weaponKindsFor(role, state.stats?.classId || state.classId).includes(kind);
    if (ARMOR_SLOTS.has(slot)) return kind === armorKindFor(role) || (!['mage', 'healer', 'buffer', 'archer', 'dagger'].includes(role) && kind === 'Armor.Shield');
    return JEWEL_SLOTS.has(slot) && kind === 'Armor.Jewel';
}

function isSlotUpgrade(item, ownedItems, role) {
    const slot = WEAPON_SLOTS.has(Number(item.etc?.slot || 0)) ? 'weapon' : Number(item.etc?.slot || 0);
    const rank = String(item.etc?.rank || 'none').toLowerCase();
    const score = itemScore(item, role);
    const price = Number(item.template?.price || 0);
    // One item per paperdoll slot is enough. Keep a same-grade replacement
    // only when it is genuinely stronger, or equally strong but from a more
    // expensive progression tier.
    return !ownedItems.some((owned) => (
        (WEAPON_SLOTS.has(Number(owned.etc?.slot || 0)) ? 'weapon' : Number(owned.etc?.slot || 0)) === slot
        && String(owned.etc?.rank || 'none').toLowerCase() === rank
        && (itemScore(owned, role) > score
            || (itemScore(owned, role) === score && Number(owned.template?.price || 0) >= price))
    ));
}

function cGradePriceCap(level) {
    const value = Number(level || 1);
    if (value < 44) return 2290000;
    if (value < 48) return 2870000;
    if (value < 50) return 4300000;
    return Infinity;
}

function preferredTarget(state = {}, options = {}) {
    const role = roleFor(state);
    const owned = inventoryMap(state.inventory);
    const ownedItems = inventoryItems(state.inventory);
    const stationService = { level: 70, stats: { classId: 57 } };
    const availableToStations = CraftShopService.availableRecipes(stationService);
    const publishedRecipeIds = new Set(CraftShopService.CraftStations.flatMap((station) => (
        CraftShopService.stationRecipes(station, availableToStations).map((recipe) => Number(recipe.recipeId))
    )));
    const recipes = Object.values(C4RecipeItems.loadRecipeItems() || {}).filter((recipe) => (
        recipe.type === 'dwarven' && publishedRecipeIds.has(Number(recipe.recipeId))
    ));
    const recipeRank = options.recipeId
        ? String((DataCache.items || []).find((item) => Number(item.selfId) === Number(recipes.find((recipe) => Number(recipe.recipeId) === Number(options.recipeId))?.productId))?.etc?.rank || '')
        : null;
    const recipesByProduct = new Map(recipes.map((recipe) => [Number(recipe.productId), recipe]));
    const candidates = (DataCache.items || [])
        .filter((item) => suitable(item, state, role, recipeRank || gradeForLevel(state.level)) && recipesByProduct.has(Number(item.selfId)))
        .map((item) => ({ item, recipe: recipesByProduct.get(Number(item.selfId)) }))
        .filter(({ recipe }) => !options.recipeId || Number(recipe.recipeId) === Number(options.recipeId))
        .filter(({ item }) => Number(owned.get(Number(item.selfId)) || 0) < 1)
        .filter(({ item }) => isSlotUpgrade(item, ownedItems, role))
        .sort((a, b) => {
            const aSlot = Number(a.item.etc?.slot || 0);
            const bSlot = Number(b.item.etc?.slot || 0);
            const priority = (slot) => WEAPON_SLOTS.has(slot) ? 3 : ARMOR_SLOTS.has(slot) ? 2 : 1;
            return priority(bSlot) - priority(aSlot) || itemScore(b.item, role) - itemScore(a.item, role) || Number(b.item.template?.price || 0) - Number(a.item.template?.price || 0);
        });
    const requiredRank = recipeRank || gradeForLevel(state.level);
    // A C-grade character should upgrade in affordable steps rather than
    // commit all of its material gathering to the final C weapon immediately.
    // Keep the top tier available from level 50, shortly before B-grade.
    const affordable = requiredRank === 'c'
        ? candidates.filter(({ item }) => Number(item.template?.price || 0) <= cGradePriceCap(state.level))
        : candidates;
    // At a C-tier cap, wait for the next level band instead of silently
    // falling through to a top-C weapon once the current band is complete.
    return requiredRank === 'c' ? affordable[0] || null : candidates[0] || null;
}

function preferredDropTarget(state = {}) {
    const role = roleFor(state);
    const owned = inventoryMap(state.inventory);
    return (DataCache.items || [])
        .filter((item) => suitable(item, state, role, 'none'))
        .filter((item) => Number(owned.get(Number(item.selfId)) || 0) < 1)
        .sort((a, b) => itemScore(b, role) - itemScore(a, role) || Number(b.template?.price || 0) - Number(a.template?.price || 0))[0] || null;
}

function preferredNoGradeTarget(state = {}) {
    const role = roleFor(state);
    const ownedItems = inventoryItems(state.inventory);
    const classId = Number(state.stats?.classId || state.classId || 0);
    const planned = BotGear.planFor({ classId, level: Math.max(GearLifecycle.GEAR_FOCUS_LEVEL, Number(state.level || 1)) });
    const uniqueItems = new Set();

    return planned.items
        .map((desired) => (DataCache.items || []).find((item) => Number(item.selfId) === Number(desired.selfId)))
        .filter(Boolean)
        .filter((item) => {
            if (uniqueItems.has(Number(item.selfId))) return false;
            uniqueItems.add(Number(item.selfId));
            return isSlotUpgrade(item, ownedItems, role);
        })
        .sort((a, b) => GearLifecycle.slotPriority(b.etc?.slot) - GearLifecycle.slotPriority(a.etc?.slot)
            || Number(a.template?.price || 0) - Number(b.template?.price || 0))[0] || null;
}

function marketOfferForTarget(target, state = {}, options = {}) {
    if (!target) return null;
    if (typeof options.findMarketOffer === 'function') return options.findMarketOffer(target, state) || null;
    const towns = [...new Set([
        state.currentRegion,
        ...Object.keys(MarketOpportunity.TOWN_NPC_SELLERS || {}),
        'Giran'
    ].filter(Boolean))];
    return towns
        .map((town) => MarketOpportunity.bestOffer(target.selfId, {
            town,
            budget: Infinity,
            buyerCharacterId: state.characterId
        }))
        .filter(Boolean)
        .sort((left, right) => Number(left.price) - Number(right.price))[0] || null;
}

function expectedAdenaPerKill(state = {}) {
    return Math.max(20, Number(state.level || 1) * 25);
}

function marketEffort(offer, state) {
    return offer ? Number(offer.price || Infinity) / expectedAdenaPerKill(state) : Infinity;
}

function itemDropChance(reward, itemId, kind = 'drop') {
    return itemDropYield(reward, itemId, kind).chance;
}

function itemDropYield(reward, itemId, kind = 'drop', context = {}) {
    return (reward?.[kind === 'spoil' ? 'spoils' : 'rewards'] || []).reduce((sum, group) => {
        const roll = ProgressionRates.rewardGroupRoll(group, kind, context, () => 0);
        const groupChance = Number(roll.chance || 0) / 100;
        const selectionChance = (group.items || [])
            .filter((item) => Number(item.selfId) === Number(itemId))
            .reduce((itemSum, item) => itemSum + Number(item.chance || 0) / 100, 0);
        const averageAmount = (group.items || [])
            .filter((item) => Number(item.selfId) === Number(itemId))
            .reduce((itemSum, item) => itemSum + (Number(item.chance || 0) / 100) * ((Number(item.min || 1) + Number(item.max || item.min || 1)) / 2), 0);
        return {
            chance: sum.chance + groupChance * selectionChance,
            expectedYield: sum.expectedYield + groupChance * averageAmount * Number(roll.amountMultiplier || 1)
        };
    }, { chance: 0, expectedYield: 0 });
}

function soloSafeForSource(state = {}, source = {}) {
    return Number(state.level || 1) >= Number(source.spotLevel || Infinity) + 2;
}

function bestSourceForState(sources = [], state = {}) {
    return sources.find((source) => soloSafeForSource(state, source)) || sources[0] || null;
}

function sourceForItem(itemId, spots = [], state = {}) {
    const spotByNpc = new Map();
    const spotByName = new Map();
    (spots || []).forEach((spot) => (spot.npcEntries || []).forEach((entry) => {
        if (entry.selfId) spotByNpc.set(Number(entry.selfId), spot);
        if (entry.name) spotByName.set(String(entry.name).trim().toLowerCase(), spot);
    }));
    return (DataCache.npcRewards || []).flatMap((reward) => ['drop'].map((kind) => {
        const spot = spotByNpc.get(Number(reward.selfId))
            || spotByName.get(String(reward.template?.name || '').trim().toLowerCase());
        const { chance, expectedYield } = itemDropYield(reward, itemId, kind, {
            npcLevel: Number(spot?.avgLevel || 0),
            killerLevel: Number(state.level || 0)
        });
        if (!chance || !spot) return null;
        return { npcId: Number(reward.selfId), npcName: reward.template?.name || `NPC ${reward.selfId}`, kind, chance, expectedYield, spotId: spot.id, spotLevel: Number(spot.avgLevel || 1) };
    })).filter(Boolean).sort((a, b) => b.expectedYield - a.expectedYield);
}

function stationRecipeIds() {
    const service = { level: 70, stats: { classId: 57 } };
    const allowed = CraftShopService.availableRecipes(service);
    return new Set(CraftShopService.CraftStations.flatMap((station) => (
        CraftShopService.stationRecipes(station, allowed).map((recipe) => Number(recipe.recipeId))
    )));
}

function farmSourceForMaterial(itemId, state, spots, allowedRecipeIds, requiredAmount = 1, visited = new Set()) {
    const direct = bestSourceForState(sourceForItem(itemId, spots, state), state);
    if (direct) return { ...direct, itemId: Number(itemId) };
    if (visited.has(Number(itemId))) return null;

    const component = C4RecipeItems.resolveByProductId(itemId);
    if (!component || !allowedRecipeIds.has(Number(component.recipeId))) return null;
    const nextVisited = new Set(visited).add(Number(itemId));
    const componentCrafts = Math.max(1, Math.ceil(Number(requiredAmount || 1) / Math.max(1, Number(component.productCount || 1))));
    for (const ingredient of component.materials || []) {
        const owned = Number(inventoryMap(state.inventory).get(Number(ingredient.selfId)) || 0);
        const required = Number(ingredient.amount || 0) * componentCrafts;
        if (owned >= required || CraftSupplementMaterials.isSupplementalMaterial(ingredient.selfId)) continue;
        const source = farmSourceForMaterial(ingredient.selfId, state, spots, allowedRecipeIds, required - owned, nextVisited);
        if (source) return source;
    }
    return null;
}

function hasReadyCraftComponent(recipe, state, allowedRecipeIds, visited = new Set()) {
    if (!recipe || visited.has(Number(recipe.recipeId))) return false;
    const nextVisited = new Set(visited).add(Number(recipe.recipeId));
    for (const material of recipe.materials || []) {
        const owned = Number(inventoryMap(state.inventory).get(Number(material.selfId)) || 0);
        if (owned >= Number(material.amount || 0)) continue;
        const component = C4RecipeItems.resolveByProductId(material.selfId);
        if (!component || !allowedRecipeIds.has(Number(component.recipeId))) continue;
        if ((component.materials || []).every((ingredient) => (
            Number(inventoryMap(state.inventory).get(Number(ingredient.selfId)) || 0) >= Number(ingredient.amount || 0)
        )) || hasReadyCraftComponent(component, state, allowedRecipeIds, nextVisited)) return true;
    }
    return false;
}

function missingMaterials(recipe, inventory) {
    const owned = inventoryMap(inventory);
    return (recipe?.materials || []).map((material) => ({
        selfId: Number(material.selfId),
        amount: Number(material.amount || 0),
        owned: Number(owned.get(Number(material.selfId)) || 0),
        missing: Math.max(0, Number(material.amount || 0) - Number(owned.get(Number(material.selfId)) || 0))
    }));
}

function planFor(state = {}, options = {}) {
    if (isCraftService(state)) {
        return { status: 'service', strategy: 'none', recipeId: null, materials: [], next: null };
    }
    if (!GearLifecycle.isGearFocusActive(state)) {
        return {
            status: 'deferred',
            phase: GearLifecycle.phaseFor(state),
            strategy: 'none',
            recipeId: null,
            materials: [],
            next: null
        };
    }
    if (!GearLifecycle.allowsCrafting(state) || gradeForLevel(state.level) === 'none') {
        const target = preferredNoGradeTarget(state) || preferredDropTarget(state);
        const source = target ? bestSourceForState(sourceForItem(target.selfId, options.spots || [], state), state) : null;
        const offer = marketOfferForTarget(target, state, options);
        const directKills = source ? 1 / Math.max(source.expectedYield, 0.000001) : Infinity;
        const buy = offer && marketEffort(offer, state) <= directKills;
        return target && buy ? {
            status: 'active', phase: GearLifecycle.phaseFor(state), grade: 'none', role: roleFor(state), strategy: 'market', soloSafe: true, requiresParty: false,
            rateModelVersion: RATE_MODEL_VERSION,
            expectedKills: Math.ceil(marketEffort(offer, state)),
            target: { selfId: Number(target.selfId), name: target.template?.name || `Item ${target.selfId}`, slot: Number(target.etc?.slot || 0) },
            market: { town: offer.town || 'Giran', price: Number(offer.price), sourceType: offer.sourceType },
            recipeId: null, materials: [], next: null
        } : source ? {
            status: 'active', grade: 'none', role: roleFor(state), strategy: 'direct_drop', soloSafe: soloSafeForSource(state, source), requiresParty: !soloSafeForSource(state, source),
            rateModelVersion: RATE_MODEL_VERSION,
            expectedKills: Math.ceil(1 / Math.max(source.expectedYield, 0.000001)),
            target: { selfId: Number(target.selfId), name: target.template?.name || `Item ${target.selfId}`, slot: Number(target.etc?.slot || 0) },
            recipeId: null, materials: [], next: { ...source, itemId: Number(target.selfId) }
        } : { status: 'no_grade_drop_only', grade: 'none', role: roleFor(state), strategy: 'direct_drop', rateModelVersion: RATE_MODEL_VERSION, recipeId: null, materials: [], next: null };
    }
    const target = preferredTarget(state, options);
    if (!target) return { status: 'complete', reason: 'no_missing_craftable_upgrade' };

    const spots = options.spots || [];
    const directSources = sourceForItem(target.item.selfId, spots, state);
    const direct = bestSourceForState(directSources, state);
    const materials = missingMaterials(target.recipe, state.inventory);
    const allowedRecipeIds = stationRecipeIds();
    const materialPlans = materials.map((material) => ({
        ...material,
        source: material.missing > 0
            ? farmSourceForMaterial(material.selfId, state, spots, allowedRecipeIds, material.missing)
            : null
    }));
    const missingMaterialPlans = materialPlans.filter((material) => material.missing > 0 && !CraftSupplementMaterials.isSupplementalMaterial(material.selfId));
    const nextMaterial = missingMaterialPlans.slice().sort((a, b) => (
        (b.missing / Math.max(b.source?.expectedYield || 0.000001, 0.000001)) - (a.missing / Math.max(a.source?.expectedYield || 0.000001, 0.000001))
    ))[0] || null;
    const directKills = direct ? 1 / Math.max(direct.expectedYield, 0.000001) : Infinity;
    const craftKills = missingMaterialPlans.reduce((sum, material) => sum + material.missing / Math.max(material.source?.expectedYield || 0.000001, 0.000001), 0);
    const offer = marketOfferForTarget(target.item, state, options);
    const buy = offer && marketEffort(offer, state) <= Math.min(directKills, craftKills);
    const soloSafe = direct && soloSafeForSource(state, direct);
    const strategy = buy ? 'market' : soloSafe && directKills <= craftKills * 0.8 ? 'direct_drop' : 'craft';
    const next = strategy === 'direct_drop'
        ? direct && { ...direct, itemId: Number(target.item.selfId) }
        : strategy === 'craft' ? nextMaterial?.source && { ...nextMaterial.source, itemId: Number(nextMaterial.selfId) } : null;
    // Keep final-equipment readiness distinct from an available intermediate
    // craft.  Both routes go to a station, but reporting a ready Cokes batch
    // as "can craft Atuba Mace" made the progression telemetry lie and hid
    // the remaining work in a long component chain.
    const readyToCraft = strategy === 'craft' && missingMaterialPlans.length === 0;
    const componentReady = strategy === 'craft'
        && !readyToCraft
        && hasReadyCraftComponent(target.recipe, state, allowedRecipeIds);
    // A ready final recipe or component is a station action, not a request to
    // fight at the next (possibly unsafe) material source.  Let it leave the
    // party gate and finish the prepared manufacture first.
    const requiresParty = !readyToCraft && !componentReady
        && Boolean(next && !soloSafeForSource(state, next));

    return {
        status: readyToCraft ? 'ready_to_craft' : componentReady ? 'component_ready' : strategy === 'market' || next ? 'active' : 'blocked',
        phase: GearLifecycle.phaseFor(state),
        grade: String(target.item.etc?.rank || gradeForLevel(state.level)).toLowerCase(),
        role: roleFor(state),
        rateModelVersion: RATE_MODEL_VERSION,
        target: { selfId: Number(target.item.selfId), name: target.item.template?.name || `Item ${target.item.selfId}`, slot: Number(target.item.etc?.slot || 0) },
        recipeId: Number(target.recipe.recipeId),
        strategy,
        soloSafe,
        requiresParty,
        expectedKills: next ? Math.ceil(strategy === 'direct_drop' ? directKills : craftKills) : 0,
        market: buy ? { town: offer.town || 'Giran', price: Number(offer.price), sourceType: offer.sourceType } : null,
        materials: materialPlans.map(({ source, ...material }) => ({ ...material, sourceSpotId: source?.spotId || null })),
        next: next ? { spotId: next.spotId, npcId: next.npcId, npcName: next.npcName, kind: next.kind, itemId: next.itemId } : null
    };
}

function shouldFinishPreviousPlan(previous, refreshed) {
    if (!previous || !refreshed || previous.grade === refreshed.grade || previous.strategy !== 'craft') return false;
    if (!['active', 'component_ready', 'ready_to_craft'].includes(refreshed.status)) return false;
    const missing = (refreshed.materials || []).filter((material) => Number(material.missing || 0) > 0);
    const total = (refreshed.materials || []).reduce((sum, material) => sum + Number(material.amount || 0), 0);
    const remaining = missing.reduce((sum, material) => sum + Number(material.missing || 0), 0);
    return missing.length <= 1 || remaining <= total * 0.2;
}

function scoreSpot(spot, plan) {
    if (!spot || plan?.status !== 'active' || !plan.next?.spotId) return 0;
    return spot.id === plan.next.spotId ? 100000 : 0;
}

function sameObjective(left, right) {
    return Boolean(
        Number(left?.target?.selfId || 0) > 0 && Number(left?.target?.selfId) === Number(right?.target?.selfId)
        || String(left?.next?.spotId || '') && String(left?.next?.spotId) === String(right?.next?.spotId)
    );
}

module.exports = { RATE_MODEL_VERSION, gradeForLevel, isCraftService, preferredTarget, preferredDropTarget, preferredNoGradeTarget, marketOfferForTarget, itemDropChance, itemDropYield, soloSafeForSource, bestSourceForState, sourceForItem, farmSourceForMaterial, missingMaterials, planFor, shouldFinishPreviousPlan, scoreSpot, sameObjective };
