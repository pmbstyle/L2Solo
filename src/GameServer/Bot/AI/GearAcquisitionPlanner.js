const DataCache = invoke('GameServer/DataCache');
const C4RecipeItems = invoke('GameServer/Items/C4RecipeItems');
const ProgressionRates = invoke('GameServer/ProgressionRates');
const BotRoles = invoke('GameServer/Bot/AI/BotRoles');
const CraftShopService = invoke('GameServer/Bot/Economy/CraftShopService');

const RANKS = ['none', 'd', 'c', 'b', 'a', 's'];
const WEAPON_SLOTS = new Set([7, 14]);
const ARMOR_SLOTS = new Set([6, 9, 10, 11, 12, 15]);
const JEWEL_SLOTS = new Set([1, 2, 3, 4, 5]);

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

function preferredTarget(state = {}, options = {}) {
    const role = roleFor(state);
    const owned = inventoryMap(state.inventory);
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
        .sort((a, b) => {
            const aSlot = Number(a.item.etc?.slot || 0);
            const bSlot = Number(b.item.etc?.slot || 0);
            const priority = (slot) => WEAPON_SLOTS.has(slot) ? 3 : ARMOR_SLOTS.has(slot) ? 2 : 1;
            return priority(bSlot) - priority(aSlot) || itemScore(b.item, role) - itemScore(a.item, role) || Number(b.item.template?.price || 0) - Number(a.item.template?.price || 0);
        });
    return candidates[0] || null;
}

function preferredDropTarget(state = {}) {
    const role = roleFor(state);
    const owned = inventoryMap(state.inventory);
    return (DataCache.items || [])
        .filter((item) => suitable(item, state, role, 'none'))
        .filter((item) => Number(owned.get(Number(item.selfId)) || 0) < 1)
        .sort((a, b) => itemScore(b, role) - itemScore(a, role) || Number(b.template?.price || 0) - Number(a.template?.price || 0))[0] || null;
}

function itemDropChance(reward, itemId, kind = 'drop') {
    const rate = kind === 'spoil' ? ProgressionRates.profile().spoil : ProgressionRates.profile().drop;
    return (reward?.[kind === 'spoil' ? 'spoils' : 'rewards'] || []).reduce((sum, group) => {
        const groupChance = Math.min(100, Math.max(0, Number(group.overall || 0) * rate)) / 100;
        const itemChance = (group.items || [])
            .filter((item) => Number(item.selfId) === Number(itemId))
            .reduce((itemSum, item) => itemSum + Number(item.chance || 0) / 100, 0);
        return sum + groupChance * itemChance;
    }, 0);
}

function sourceForItem(itemId, spots = []) {
    const spotByNpc = new Map();
    const spotByName = new Map();
    (spots || []).forEach((spot) => (spot.npcEntries || []).forEach((entry) => {
        if (entry.selfId) spotByNpc.set(Number(entry.selfId), spot);
        if (entry.name) spotByName.set(String(entry.name).trim().toLowerCase(), spot);
    }));
    return (DataCache.npcRewards || []).flatMap((reward) => ['drop'].map((kind) => {
        const chance = itemDropChance(reward, itemId, kind);
        const spot = spotByNpc.get(Number(reward.selfId))
            || spotByName.get(String(reward.template?.name || '').trim().toLowerCase());
        if (!chance || !spot) return null;
        return { npcId: Number(reward.selfId), npcName: reward.template?.name || `NPC ${reward.selfId}`, kind, chance, spotId: spot.id, spotLevel: Number(spot.avgLevel || 1) };
    })).filter(Boolean).sort((a, b) => b.chance - a.chance);
}

function stationRecipeIds() {
    const service = { level: 70, stats: { classId: 57 } };
    const allowed = CraftShopService.availableRecipes(service);
    return new Set(CraftShopService.CraftStations.flatMap((station) => (
        CraftShopService.stationRecipes(station, allowed).map((recipe) => Number(recipe.recipeId))
    )));
}

function farmSourceForMaterial(itemId, state, spots, allowedRecipeIds, visited = new Set()) {
    const direct = sourceForItem(itemId, spots)[0];
    if (direct) return { ...direct, itemId: Number(itemId) };
    if (visited.has(Number(itemId))) return null;

    const component = C4RecipeItems.resolveByProductId(itemId);
    if (!component || !allowedRecipeIds.has(Number(component.recipeId))) return null;
    const nextVisited = new Set(visited).add(Number(itemId));
    for (const ingredient of component.materials || []) {
        const owned = Number(inventoryMap(state.inventory).get(Number(ingredient.selfId)) || 0);
        if (owned >= Number(ingredient.amount || 0)) continue;
        const source = farmSourceForMaterial(ingredient.selfId, state, spots, allowedRecipeIds, nextVisited);
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
    if (gradeForLevel(state.level) === 'none' && !options.recipeId) {
        const target = preferredDropTarget(state);
        const source = target ? sourceForItem(target.selfId, options.spots || [])[0] : null;
        return source ? {
            status: 'active', grade: 'none', role: roleFor(state), strategy: 'direct_drop', soloSafe: Number(state.level || 1) + 1 >= Number(source.spotLevel || Infinity),
            expectedKills: Math.ceil(1 / Math.max(source.chance, 0.000001)),
            target: { selfId: Number(target.selfId), name: target.template?.name || `Item ${target.selfId}`, slot: Number(target.etc?.slot || 0) },
            recipeId: null, materials: [], next: { ...source, itemId: Number(target.selfId) }
        } : { status: 'no_grade_drop_only', grade: 'none', role: roleFor(state), strategy: 'direct_drop', recipeId: null, materials: [], next: null };
    }
    const target = preferredTarget(state, options);
    if (!target) return { status: 'complete', reason: 'no_missing_craftable_upgrade' };

    const spots = options.spots || [];
    const directSources = sourceForItem(target.item.selfId, spots);
    const direct = directSources[0] || null;
    const materials = missingMaterials(target.recipe, state.inventory);
    const allowedRecipeIds = stationRecipeIds();
    const materialPlans = materials.map((material) => ({
        ...material,
        source: material.missing > 0
            ? farmSourceForMaterial(material.selfId, state, spots, allowedRecipeIds)
            : null
    }));
    const missingMaterialPlans = materialPlans.filter((material) => material.missing > 0);
    const nextMaterial = missingMaterialPlans.slice().sort((a, b) => (
        (b.missing / Math.max(b.source?.chance || 0.000001, 0.000001)) - (a.missing / Math.max(a.source?.chance || 0.000001, 0.000001))
    ))[0] || null;
    const directKills = direct ? 1 / Math.max(direct.chance, 0.000001) : Infinity;
    const craftKills = missingMaterialPlans.reduce((sum, material) => sum + material.missing / Math.max(material.source?.chance || 0.000001, 0.000001), 0);
    const soloSafe = direct && Number(state.level || 1) + 1 >= Number(direct.spotLevel || Infinity);
    const strategy = soloSafe && directKills <= craftKills * 0.8 ? 'direct_drop' : 'craft';
    const next = strategy === 'direct_drop'
        ? direct && { ...direct, itemId: Number(target.item.selfId) }
        : nextMaterial?.source && { ...nextMaterial.source, itemId: Number(nextMaterial.selfId) };
    const readyToCraft = strategy === 'craft' && (
        missingMaterialPlans.length === 0 || hasReadyCraftComponent(target.recipe, state, allowedRecipeIds)
    );

    return {
        status: readyToCraft ? 'ready_to_craft' : next ? 'active' : 'blocked',
        grade: String(target.item.etc?.rank || gradeForLevel(state.level)).toLowerCase(),
        role: roleFor(state),
        target: { selfId: Number(target.item.selfId), name: target.item.template?.name || `Item ${target.item.selfId}`, slot: Number(target.item.etc?.slot || 0) },
        recipeId: Number(target.recipe.recipeId),
        strategy,
        soloSafe,
        expectedKills: next ? Math.ceil(strategy === 'direct_drop' ? directKills : craftKills) : 0,
        materials: materialPlans.map(({ source, ...material }) => ({ ...material, sourceSpotId: source?.spotId || null })),
        next: next ? { spotId: next.spotId, npcId: next.npcId, npcName: next.npcName, kind: next.kind, itemId: next.itemId } : null
    };
}

function shouldFinishPreviousPlan(previous, refreshed) {
    if (!previous || !refreshed || previous.grade === refreshed.grade || previous.strategy !== 'craft') return false;
    if (!['active', 'ready_to_craft'].includes(refreshed.status)) return false;
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

module.exports = { gradeForLevel, preferredTarget, preferredDropTarget, sourceForItem, missingMaterials, planFor, shouldFinishPreviousPlan, scoreSpot, sameObjective };
