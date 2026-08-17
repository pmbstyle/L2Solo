const DataCache = invoke('GameServer/DataCache');
const C4RecipeItems = invoke('GameServer/Items/C4RecipeItems');
const C4DualSwordCombinations = invoke('GameServer/Items/C4DualSwordCombinations');
const ProgressionRates = invoke('GameServer/ProgressionRates');
const BotRoles = invoke('GameServer/Bot/AI/BotRoles');
const BotEquipmentCompatibility = invoke('GameServer/Bot/AI/BotEquipmentCompatibility');
const BotWeaponCompatibility = invoke('GameServer/Bot/AI/BotWeaponCompatibility');
const CraftShopService = invoke('GameServer/Bot/Economy/CraftShopService');
const CraftSupplementMaterials = invoke('GameServer/Bot/Economy/CraftSupplementMaterials');
const MAX_RESOLVED_SOURCE_CACHE = 512;
let sourceIndexCache = { spots: null, rewards: null, byItemId: new Map(), resolved: new Map() };
const BotGear = invoke('GameServer/Bot/AI/BotGear');
const GearLifecycle = invoke('GameServer/Bot/AI/GearLifecycle');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const NpcShopBuyLists = invoke('GameServer/World/Generics/NpcShopBuyLists');
const BotRaidSafety = invoke('GameServer/Bot/AI/BotRaidSafety');

const RANKS = ['none', 'd', 'c', 'b', 'a', 's'];
const WEAPON_SLOTS = new Set([7, 14]);
const ARMOR_SLOTS = new Set([6, 9, 10, 11, 12, 15]);
const JEWEL_SLOTS = new Set([1, 2, 3, 4, 5]);
const RATE_MODEL_VERSION = 5;
const DIRECT_FAILURE_RESOLVE_LIMIT = 8;
const DIRECT_DROP_EXHAUSTION_MULTIPLIER = 3;
const DIRECT_ROUTE_COOLDOWN_MS = 60 * 60 * 1000;
const PARTY_ROUTE_FAILURE_ATTEMPT_LIMIT = 2;
const PAIRED_SLOTS = Object.freeze({ 1: 2, 2: 1, 4: 5, 5: 4 });
const NPC_GEAR_MAX_RANK = 'd';
let staticNpcItemIdsCache = null;
let itemCatalogSource = null;
let itemCatalogById = new Map();

function catalogItem(selfId) {
    const items = DataCache.items || [];
    if (itemCatalogSource !== items) {
        itemCatalogSource = items;
        itemCatalogById = new Map(items.map((item) => [Number(item.selfId), item]));
    }
    return itemCatalogById.get(Number(selfId)) || null;
}

function isRealCatalogItem(item = {}) {
    const selfId = Number(item.selfId || 0);
    const name = String(item.template?.name || '').trim();
    // A loaded row is not automatically a usable game item.  The datapack has
    // legacy placeholder rows (for example, the D-grade weapon named "0").
    // Do not let an anonymous or malformed catalog record become a bot goal,
    // party-loot candidate, or equipped item just because its combat stats are
    // otherwise present.
    return Number.isInteger(selfId) && selfId > 0
        && name.length > 0
        && name !== '0';
}

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

function excludedTargetIds(options = {}) {
    return new Set((options.excludedTargetIds || []).map(Number).filter((selfId) => selfId > 0));
}

function classIdFor(state = {}) {
    return Number(state.stats?.classId ?? state.classId ?? 0);
}

function pairedSlots(slot) {
    const value = Number(slot || 0);
    return PAIRED_SLOTS[value] ? [value, PAIRED_SLOTS[value]].sort((a, b) => a - b) : [value];
}

function equippedSlotsFor(entry = {}, fallbackSlot = 0) {
    const amount = Math.max(0, Number(entry.amount ?? (entry.equipped ? 1 : 0)));
    const slot = Number(entry.slot || fallbackSlot || 0);
    const explicit = Array.isArray(entry.equippedSlots)
        ? [...new Set(entry.equippedSlots.map(Number).filter((value) => value > 0))]
        : [];
    if (explicit.length) return explicit.slice(0, amount || explicit.length).sort((a, b) => a - b);
    if (!entry.equipped || amount < 1 || slot <= 0) return [];
    // Legacy cold snapshots only had one boolean for a selfId. If two copies
    // of paired jewellery are present, both paperdoll sides are the useful and
    // native interpretation; the next physical sync persists them separately.
    if (amount === 1) return [slot];
    const slots = pairedSlots(slot);
    return slots.slice(0, Math.min(amount, slots.length));
}

function equipmentSlotKey(slot) {
    const value = Number(slot || 0);
    if (WEAPON_SLOTS.has(value)) return 'weapon';
    return String(value);
}

function isCraftService(state = {}) {
    return state.activity === 'crafting'
        && !!state.stats?.craftShop
        && (Boolean(state.stats?.craftStationId) || Number(state.stats?.generatedIndex || 0) >= 10000);
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
        const item = catalogItem(row.selfId);
        return item ? [item] : [];
    });
}

function equippedInventoryItems(inventory = {}) {
    const rows = Array.isArray(inventory) ? inventory : Object.values(inventory);
    return rows.flatMap((row) => {
        if (Number(row?.amount || 0) < 1) return [];
        const item = catalogItem(row.selfId);
        if (!item) return [];
        return equippedSlotsFor(row, item.etc?.slot).map((slot) => ({
            ...item,
            etc: { ...(item.etc || {}), slot }
        }));
    });
}

function hasEquippedTwoHandedWeapon(state = {}) {
    return equippedInventoryItems(state.inventory).some((item) => (
        Number(item.etc?.slot || 0) === 14
        && String(item.template?.kind || '').startsWith('Weapon.')
    ));
}

function missingRequiredDualSword(state = {}, role = roleFor(state), classId = classIdFor(state)) {
    const allowedKinds = BotEquipmentCompatibility.weaponKindsFor(role, classId);
    if (allowedKinds.length !== 1 || allowedKinds[0] !== 'Weapon.Dual') return false;
    return !equippedInventoryItems(state.inventory).some((item) => item.template?.kind === 'Weapon.Dual');
}

function itemScore(item, role, classId) {
    const stats = item.stats || {};
    const slot = Number(item.etc?.slot || 0);
    if (WEAPON_SLOTS.has(slot)) return BotWeaponCompatibility.scoreWeapon(stats.pAtk, stats.mAtk, role, classId);
    if (JEWEL_SLOTS.has(slot)) return Number(stats.mDef || 0);
    return Number(stats.pDef || 0) + Number(item.etc?.mp || 0);
}

function rankIndex(rank) {
    const index = RANKS.indexOf(String(rank || 'none').toLowerCase());
    return index < 0 ? 0 : index;
}

function combatReadiness(state = {}) {
    const role = roleFor(state);
    const equipped = equippedInventoryItems(state.inventory);
    const weapon = equipped.find((item) => WEAPON_SLOTS.has(Number(item.etc?.slot || 0)));
    const armor = equipped.filter((item) => ARMOR_SLOTS.has(Number(item.etc?.slot || 0)));
    const weaponRank = rankIndex(weapon?.etc?.rank);
    const armorRank = armor.length
        ? armor.reduce((sum, item) => sum + rankIndex(item.etc?.rank), 0) / armor.length
        : 0;
    const baseKit = (weapon ? 0.25 : 0) + Math.min(0.45, armor.length * 0.1);
    const roleAdjustment = role === 'tank' ? 0.45
        : ['healer', 'buffer'].includes(role) ? -0.7
            : role === 'mage' ? -0.25 : 0;

    return {
        role,
        hasWeapon: Boolean(weapon),
        armorCount: armor.length,
        weaponRank,
        armorRank,
        effectiveLevel: Math.max(1, Number(state.level || 1))
            + weaponRank * 1.25
            + armorRank * 0.65
            + baseKit
            + roleAdjustment
    };
}

function suitable(item, state, role, requiredRank = gradeForLevel(state.level)) {
    if (!isRealCatalogItem(item)) return false;
    const rank = String(item.etc?.rank || 'none').toLowerCase();
    if (rank !== requiredRank) return false;
    const kind = item.template?.kind || '';
    const slot = Number(item.etc?.slot || 0);
    const classId = classIdFor(state);
    if (WEAPON_SLOTS.has(slot)) return BotWeaponCompatibility.isSuitableWeapon(
        kind,
        item.template?.name,
        item.stats?.pAtk,
        item.stats?.mAtk,
        role,
        classId
    ) && (
        slot === 7
        || BotEquipmentCompatibility.allowsTwoHandedWeapon(kind, role, classId)
    );
    if (slot === 8) return BotEquipmentCompatibility.usesShield(role, classId)
        && kind === 'Armor.Shield'
        && !hasEquippedTwoHandedWeapon(state);
    if ([10, 11, 15].includes(slot)) return kind === BotEquipmentCompatibility.armorKindFor(role, classId);
    if ([6, 9, 12].includes(slot)) return kind === 'Armor.Wear';
    return JEWEL_SLOTS.has(slot) && kind === 'Armor.Jewel';
}

function isSlotUpgrade(item, ownedItems, role, classId) {
    const slot = WEAPON_SLOTS.has(Number(item.etc?.slot || 0)) ? 'weapon' : Number(item.etc?.slot || 0);
    const rank = String(item.etc?.rank || 'none').toLowerCase();
    const score = itemScore(item, role, classId);
    const price = Number(item.template?.price || 0);
    // One item per paperdoll slot is enough. Keep a same-grade replacement
    // only when it is genuinely stronger, or equally strong but from a more
    // expensive progression tier.
    return !ownedItems.some((owned) => (
        (WEAPON_SLOTS.has(Number(owned.etc?.slot || 0)) ? 'weapon' : Number(owned.etc?.slot || 0)) === slot
        && String(owned.etc?.rank || 'none').toLowerCase() === rank
        && (itemScore(owned, role, classId) > score
            || (itemScore(owned, role, classId) === score && Number(owned.template?.price || 0) >= price))
    ));
}

function slotPriority(item) {
    const slot = Number(item?.etc?.slot || 0);
    if (WEAPON_SLOTS.has(slot)) return 8;
    if (ARMOR_SLOTS.has(slot)) return 4;
    return JEWEL_SLOTS.has(slot) ? 1 : 0;
}

function currentSlotScore(item, ownedItems = [], role, classId) {
    const slot = WEAPON_SLOTS.has(Number(item?.etc?.slot || 0)) ? 'weapon' : Number(item?.etc?.slot || 0);
    return ownedItems
        .filter((owned) => (
            (WEAPON_SLOTS.has(Number(owned.etc?.slot || 0)) ? 'weapon' : Number(owned.etc?.slot || 0)) === slot
        ))
        .reduce((best, owned) => Math.max(best, itemScore(owned, role, classId)), 0);
}

function candidateEffort(candidate, state, options = {}) {
    const item = candidate?.item;
    if (!item) return Infinity;
    const spots = options.spots || [];
    const offer = marketOfferForTarget(item, state, options);
    const availableAdena = Number(state.adena || state.inventory?.[57]?.amount || 0);
    const marketEffortValue = offer
        ? (availableAdena >= Number(offer.price || 0)
            ? 4
            : marketEffort(offer, state))
        : Infinity;
    // A few callers only ask for a deterministic preferred item (tests,
    // diagnostics and a pre-route preview). Do not scan every NPC reward and
    // every component tree when no spot atlas is available.
    if (!spots.length) return marketEffortValue;
    const direct = bestSourceForState(sourceForItem(item.selfId, spots, state, options), state);
    const directEffort = direct
        ? (1 / Math.max(Number(direct.expectedYield || 0), 0.000001))
            * (soloSafeForSource(state, direct) ? 1 : 1.35)
        : Infinity;
    if (!candidate.recipe) return Math.min(directEffort, marketEffortValue);

    const allowedRecipeIds = options.allowedRecipeIds || stationRecipeIds();
    const materialEffort = missingMaterials(candidate.recipe, state.inventory)
        .filter((material) => material.missing > 0 && !CraftSupplementMaterials.isSupplementalMaterial(material.selfId))
        .reduce((sum, material) => {
            const source = farmSourceForMaterial(material.selfId, state, spots, allowedRecipeIds, material.missing, new Set(), options);
            return sum + (source ? material.missing / Math.max(Number(source.expectedYield || 0), 0.000001) : 1000000);
        }, 8);
    return Math.min(directEffort, marketEffortValue, materialEffort);
}

function shortlistCandidates(candidates = [], options = {}) {
    if (options.recipeId) return candidates;
    const bySlot = candidates.reduce((groups, candidate) => {
        const slot = WEAPON_SLOTS.has(Number(candidate.item.etc?.slot || 0))
            ? 'weapon'
            : String(candidate.item.etc?.slot || 0);
        groups[slot] = groups[slot] || [];
        groups[slot].push(candidate);
        return groups;
    }, {});
    // Evaluate a few entry and mid-tier candidates per paperdoll slot. The
    // later effort model decides between them, but excluding the long tail
    // keeps cold population ticks bounded and stops a fresh character from
    // treating the best-in-slot item as its default target.
    return Object.values(bySlot).flatMap((entries) => entries
        .sort((left, right) => Number(left.item.template?.price || 0) - Number(right.item.template?.price || 0)
            || Number(left.item.selfId) - Number(right.item.selfId))
        .slice(0, 3));
}

function progressionPriceCap(rank, level) {
    const value = Number(level || 1);
    const caps = {
        d: value < 24 ? 180000 : value < 30 ? 420000 : 800000,
        c: value < 44 ? 2290000 : value < 48 ? 2870000 : 4300000,
        b: value < 55 ? 9000000 : 15000000,
        a: value < 66 ? 30000000 : 60000000
    };
    return caps[String(rank || '').toLowerCase()] ?? Infinity;
}

function opportunityScore(candidate, state, options = {}) {
    const role = roleFor(state);
    const classId = classIdFor(state);
    const ownedItems = inventoryItems(state.inventory);
    const improvement = Math.max(1, itemScore(candidate.item, role, classId) - currentSlotScore(candidate.item, ownedItems, role, classId) + 2);
    const effort = candidateEffort(candidate, state, options);
    // The fallback makes an unobservable route deterministic, while real
    // market/drop/craft effort always wins over template price.
    if (!Number.isFinite(effort) && !candidate.recipe) return 0;
    const normalizedEffort = Number.isFinite(effort)
        ? Math.max(1, effort)
        : Math.max(1, Number(candidate.item.template?.price || 0) / 1000);
    return (slotPriority(candidate.item) * improvement) / normalizedEffort;
}

function equipInventoryUpgrades(state = {}, inventory = {}) {
    const role = roleFor(state);
    const classId = classIdFor(state);
    const allowedRank = rankIndex(gradeForLevel(state.level));
    const candidates = Object.values(inventory || {}).flatMap((entry) => {
        if (Number(entry?.amount || 0) < 1) return [];
        const item = (DataCache.items || []).find((candidate) => Number(candidate.selfId) === Number(entry.selfId));
        const rank = rankIndex(item?.etc?.rank);
        return item && rank <= allowedRank && suitable(item, state, role, item.etc?.rank) ? [{ entry, item }] : [];
    });
    const pairGroup = (item) => {
        const slot = Number(item.etc?.slot || 0);
        return [1, 2].includes(slot) ? 'ears' : [4, 5].includes(slot) ? 'rings' : null;
    };
    const ordinaryCandidates = candidates.filter(({ item }) => !pairGroup(item));
    const best = ordinaryCandidates.reduce((selected, candidate) => {
        const key = equipmentSlotKey(candidate.item.etc?.slot);
        const current = selected.get(key);
        if (!current || itemScore(candidate.item, role, classId) > itemScore(current.item, role, classId)
            || itemScore(candidate.item, role, classId) === itemScore(current.item, role, classId)
                && Number(candidate.item.template?.price || 0) < Number(current.item.template?.price || 0)) {
            selected.set(key, candidate);
        }
        return selected;
    }, new Map());
    // A full body occupies both chest and legs. Decide that mutually-exclusive
    // set before applying equipment so inventory key order cannot flip the
    // result on every inventory refresh.
    const fullBody = best.get('15');
    const chest = best.get('10');
    const legs = best.get('11');
    if (fullBody && (chest || legs)) {
        const separatesScore = [chest, legs]
            .filter(Boolean)
            .reduce((sum, candidate) => sum + itemScore(candidate.item, role, classId), 0);
        if (separatesScore >= itemScore(fullBody.item, role, classId)) {
            best.delete('15');
        } else {
            best.delete('10');
            best.delete('11');
        }
    }
    const next = Object.fromEntries(Object.entries(inventory || {}).map(([key, value]) => [key, {
        ...value,
        ...(Array.isArray(value?.equippedSlots) ? { equippedSlots: [...value.equippedSlots] } : {})
    }]));
    const setUnequipped = (owned) => {
        owned.equipped = false;
        owned.equippedCount = 0;
        owned.equippedSlots = [];
    };
    if (!BotEquipmentCompatibility.usesShield(role, classId)) {
        Object.values(next).forEach((owned) => {
            const template = (DataCache.items || []).find((item) => Number(item.selfId) === Number(owned?.selfId));
            if (Number(template?.etc?.slot || 0) === 8
                && equippedSlotsFor(owned, owned.slot).includes(8)) {
                setUnequipped(owned);
            }
        });
    }
    best.forEach(({ entry, item }, key) => {
        const slot = Number(item.etc?.slot || 0);
        Object.values(next).forEach((owned) => {
            const ownedItem = (DataCache.items || []).find((candidate) => Number(candidate.selfId) === Number(owned.selfId));
            const ownedKey = ownedItem ? equipmentSlotKey(ownedItem.etc?.slot) : String(owned.slot || 0);
            if (ownedKey === key && Number(owned.selfId) !== Number(entry.selfId)) setUnequipped(owned);
        });
        if (slot === 15) {
            [10, 11].forEach((blockedSlot) => Object.values(next).forEach((owned) => {
                if (equippedSlotsFor(owned, owned.slot).includes(blockedSlot)) setUnequipped(owned);
            }));
        } else if ([10, 11].includes(slot)) {
            Object.values(next).forEach((owned) => {
                if (equippedSlotsFor(owned, owned.slot).includes(15)) setUnequipped(owned);
            });
        }
        next[String(entry.selfId)] = {
            ...next[String(entry.selfId)],
            equipped: true,
            equippedCount: 1,
            equippedSlots: [slot],
            slot
        };
    });

    ['ears', 'rings'].forEach((group) => {
        const groupCandidates = candidates.filter(({ item }) => pairGroup(item) === group);
        const slots = group === 'ears' ? [1, 2] : [4, 5];
        const selected = groupCandidates.flatMap((candidate) => (
            Array.from({ length: Math.min(2, Number(candidate.entry.amount || 0)) }, () => candidate)
        )).sort((left, right) => itemScore(right.item, role, classId) - itemScore(left.item, role, classId)
            || Number(left.item.template?.price || 0) - Number(right.item.template?.price || 0)
            || Number(left.item.selfId) - Number(right.item.selfId)).slice(0, 2);

        groupCandidates.forEach(({ entry }) => {
            const owned = next[String(entry.selfId)];
            if (owned) setUnequipped(owned);
        });
        selected.forEach(({ entry }, index) => {
            const owned = next[String(entry.selfId)];
            if (!owned) return;
            owned.equippedSlots = [...(owned.equippedSlots || []), slots[index]].sort((a, b) => a - b);
            owned.equippedCount = owned.equippedSlots.length;
            owned.equipped = true;
            owned.slot = Number(entry.slot || slots[0]);
        });
    });
    const hasTwoHandedWeapon = hasEquippedTwoHandedWeapon({ ...state, inventory: next });
    if (hasTwoHandedWeapon) {
        Object.values(next).forEach((owned) => {
            const template = (DataCache.items || []).find((item) => Number(item.selfId) === Number(owned?.selfId));
            if (Number(template?.etc?.slot || 0) === 8) setUnequipped(owned);
        });
    }
    return next;
}

function preferredTarget(state = {}, options = {}) {
    const role = roleFor(state);
    const classId = classIdFor(state);
    const missingDualSword = missingRequiredDualSword(state, role, classId);
    const owned = inventoryMap(state.inventory);
    const ownedItems = inventoryItems(state.inventory);
    const stationService = { level: 70, stats: { classId: 57 } };
    const availableToStations = CraftShopService.availableRecipes(stationService);
    const publishedRecipeIds = new Set(CraftShopService.CraftStations.flatMap((station) => (
        CraftShopService.stationRecipes(station, availableToStations).map((recipe) => Number(recipe.recipeId))
    )));
    const craftRecipes = Object.values(C4RecipeItems.loadRecipeItems() || {}).filter((recipe) => (
        recipe.type === 'dwarven' && publishedRecipeIds.has(Number(recipe.recipeId))
    ));
    const recipes = [...craftRecipes, ...C4DualSwordCombinations.loadRecipes()];
    const recipeRank = options.recipeId
        ? String((DataCache.items || []).find((item) => Number(item.selfId) === Number(recipes.find((recipe) => Number(recipe.recipeId) === Number(options.recipeId))?.productId))?.etc?.rank || '')
        : null;
    const recipesByProduct = new Map(recipes.map((recipe) => [Number(recipe.productId), recipe]));
    const excluded = excludedTargetIds(options);
    const allCandidates = (DataCache.items || [])
        .filter((item) => suitable(item, state, role, recipeRank || gradeForLevel(state.level)))
        .filter((item) => !excluded.has(Number(item.selfId)))
        .map((item) => ({ item, recipe: recipesByProduct.get(Number(item.selfId)) || null }))
        .filter(({ recipe }) => !options.recipeId || Number(recipe?.recipeId) === Number(options.recipeId))
        .filter(({ item }) => Number(owned.get(Number(item.selfId)) || 0) < 1)
        .filter(({ item }) => (missingDualSword && item.template?.kind === 'Weapon.Dual')
            || isSlotUpgrade(item, ownedItems, role, classId));
    const requiredRank = recipeRank || gradeForLevel(state.level);
    const hasCurrentGradeWeapon = ownedItems.some((item) => (
        WEAPON_SLOTS.has(Number(item.etc?.slot || 0))
        && rankIndex(item.etc?.rank) >= rankIndex(requiredRank)
    ));
    // A viable weapon is the first milestone of a new grade. Once it is
    // covered, fill the rest of the kit before considering another weapon of
    // the same grade.
    const weaponFirst = !hasCurrentGradeWeapon || missingDualSword
        ? allCandidates.filter(({ item }) => WEAPON_SLOTS.has(Number(item.etc?.slot || 0)))
        : allCandidates.filter(({ item }) => !WEAPON_SLOTS.has(Number(item.etc?.slot || 0)));
    const progressionCandidates = weaponFirst.length ? weaponFirst : allCandidates;
    const cap = progressionPriceCap(requiredRank, state.level);
    const affordable = progressionCandidates.filter(({ item }) => Number(item.template?.price || 0) <= cap);
    // The entry weapon for some weapon families costs more than the early
    // grade cap (for example, D bows and daggers). Retain the weapon-first
    // milestone rather than declaring progression complete; shortlisting
    // still prevents a leap to a top-tier option.
    const entryWeaponFallback = (!hasCurrentGradeWeapon || missingDualSword)
        && weaponFirst.length > 0;
    if (!options.recipeId && Number.isFinite(cap) && affordable.length === 0 && !entryWeaponFallback) return null;
    const effortOptions = options.allowedRecipeIds
        ? options
        : { ...options, allowedRecipeIds: stationRecipeIds() };
    const candidates = shortlistCandidates(affordable.length ? affordable : progressionCandidates, options)
        .map((candidate) => ({ candidate, score: opportunityScore(candidate, state, effortOptions) }))
        .sort((a, b) => {
            const scoreDelta = b.score - a.score;
            if (Math.abs(scoreDelta) > 0.000001) return scoreDelta;
            return slotPriority(b.candidate.item) - slotPriority(a.candidate.item)
                || Number(a.candidate.item.template?.price || 0) - Number(b.candidate.item.template?.price || 0)
                || Number(a.candidate.item.selfId) - Number(b.candidate.item.selfId);
        });
    return candidates[0]?.candidate || null;
}

function preferredDropTarget(state = {}, options = {}) {
    const role = roleFor(state);
    const classId = classIdFor(state);
    const owned = inventoryMap(state.inventory);
    const excluded = excludedTargetIds(options);
    return (DataCache.items || [])
        .filter((item) => suitable(item, state, role, 'none'))
        .filter((item) => !excluded.has(Number(item.selfId)))
        .filter((item) => Number(owned.get(Number(item.selfId)) || 0) < 1)
        .sort((a, b) => itemScore(b, role, classId) - itemScore(a, role, classId) || Number(b.template?.price || 0) - Number(a.template?.price || 0))[0] || null;
}

function preferredNoGradeTarget(state = {}, options = {}) {
    const role = roleFor(state);
    const ownedItems = inventoryItems(state.inventory);
    const classId = Number(state.stats?.classId || state.classId || 0);
    const planned = BotGear.planFor({ classId, level: Math.max(GearLifecycle.GEAR_FOCUS_LEVEL, Number(state.level || 1)) });
    const uniqueItems = new Set();
    const excluded = excludedTargetIds(options);

    return planned.items
        .map((desired) => (DataCache.items || []).find((item) => Number(item.selfId) === Number(desired.selfId)))
        .filter(isRealCatalogItem)
        .filter((item) => !excluded.has(Number(item.selfId)))
        .filter((item) => {
            if (uniqueItems.has(Number(item.selfId))) return false;
            uniqueItems.add(Number(item.selfId));
            return isSlotUpgrade(item, ownedItems, role, classId);
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

function operationalAdenaReserve(state = {}) {
    const adena = Math.max(0, Number(state.adena || state.inventory?.[57]?.amount || 0));
    return Math.max(500, Number(state.level || 1) * 250, Math.ceil(adena * 0.10));
}

function marketPlan(state = {}, target, offer, options = {}) {
    const role = roleFor(state);
    const targetSlot = Number(options.targetSlot || target.etc?.slot || 0);
    const reserve = options.reserve === undefined && offer?.sourceType === 'npc'
        && rankIndex(target.etc?.rank) <= rankIndex(NPC_GEAR_MAX_RANK)
        ? operationalAdenaReserve(state)
        : Number(options.reserve || 0);
    return {
        status: 'active',
        phase: GearLifecycle.phaseFor(state),
        grade: gradeForLevel(state.level),
        role,
        strategy: 'market',
        soloSafe: true,
        partyNeed: 'solo_ok',
        partyNeedReason: options.reason || 'market_fallback',
        requiresParty: false,
        rateModelVersion: RATE_MODEL_VERSION,
        expectedKills: Math.ceil(marketEffort(offer, state)),
        target: { selfId: Number(target.selfId), name: target.template?.name || `Item ${target.selfId}`, slot: targetSlot },
        market: {
            town: offer.town || 'Giran',
            price: Number(offer.price),
            sourceType: offer.sourceType,
            reserve
        },
        recipeId: null,
        materials: [],
        next: null
    };
}

function npcOfferForTarget(target, state = {}, options = {}) {
    if (!target) return null;
    if (typeof options.findMarketOffer === 'function') {
        const offer = options.findMarketOffer(target, state);
        return offer?.sourceType === 'npc' ? offer : null;
    }
    return (MarketOpportunity.npcOffersAll(target.selfId) || [])
        .filter((offer) => offer.available !== false)
        .sort((left, right) => Number(left.price) - Number(right.price)
            || String(left.town || '').localeCompare(String(right.town || '')))[0] || null;
}

function staticNpcItems(options = {}) {
    if (typeof options.findMarketOffer === 'function') return DataCache.items || [];
    if (!staticNpcItemIdsCache?.size) {
        const itemIds = new Set((NpcShopBuyLists.allEntries?.() || []).map((entry) => Number(entry.selfId)).filter(Boolean));
        if (!itemIds.size) return [];
        staticNpcItemIdsCache = itemIds;
    }
    return (DataCache.items || []).filter((item) => staticNpcItemIdsCache.has(Number(item.selfId)));
}

function npcAdequacyLevel(state = {}) {
    return Number(state.level || 1) < 20 ? Number(state.level || 1) : 20;
}

function desiredNpcSlots(state = {}) {
    const plan = BotGear.planFor({ classId: classIdFor(state), level: npcAdequacyLevel(state) });
    const order = [7, 14, 10, 15, 11, 8, 6, 9, 12, 3, 1, 2, 4, 5];
    return (plan.items || []).map((item) => Number(item.slot || 0)).filter(Boolean)
        // A class may support both a one-handed blunt and a polearm.  Its
        // profile therefore permits shields, but a currently adequate
        // two-handed weapon makes the shield slot unavailable until the bot
        // actually transitions back to a one-handed weapon.
        .filter((slot) => slot !== 8 || !hasEquippedTwoHandedWeapon(state))
        .sort((left, right) => order.indexOf(left) - order.indexOf(right));
}

function itemMatchesDesiredSlot(item, desiredSlot) {
    const slot = Number(item?.etc?.slot || 0);
    const wanted = Number(desiredSlot || 0);
    if (WEAPON_SLOTS.has(slot) && WEAPON_SLOTS.has(wanted)) return true;
    if ([1, 2].includes(slot) && [1, 2].includes(wanted)) return true;
    if ([4, 5].includes(slot) && [4, 5].includes(wanted)) return true;
    return slot === wanted;
}

function equippedItemAtSlot(state = {}, slot) {
    const wanted = Number(slot || 0);
    return equippedInventoryItems(state.inventory).find((item) => (
        WEAPON_SLOTS.has(wanted)
            ? WEAPON_SLOTS.has(Number(item.etc?.slot || 0))
            : Number(item.etc?.slot || 0) === wanted
    )) || null;
}

function npcCandidatesForSlot(state = {}, desiredSlot, maxRank, options = {}) {
    const role = roleFor(state);
    const classId = classIdFor(state);
    const requiredDualSword = Number(desiredSlot) === 14 && missingRequiredDualSword(state, role, classId);
    const current = equippedItemAtSlot(state, desiredSlot);
    const currentRank = rankIndex(current?.etc?.rank);
    const currentScore = current ? itemScore(current, role, classId) : 0;
    const excluded = excludedTargetIds(options);
    return staticNpcItems(options).filter((item) => !excluded.has(Number(item.selfId)))
        .filter((item) => itemMatchesDesiredSlot(item, desiredSlot))
        .filter((item) => rankIndex(item.etc?.rank) <= rankIndex(maxRank))
        .filter((item) => suitable(item, state, role, item.etc?.rank))
        .filter((item) => requiredDualSword
            || rankIndex(item.etc?.rank) > currentRank
            || itemScore(item, role, classId) > currentScore)
        .map((item) => ({ item, offer: npcOfferForTarget(item, state, options) }))
        .filter(({ offer }) => offer)
        .sort((left, right) => rankIndex(right.item.etc?.rank) - rankIndex(left.item.etc?.rank)
            || Number(left.offer.price) - Number(right.offer.price)
            || itemScore(right.item, role, classId) - itemScore(left.item, role, classId));
}

function staticNpcUpgradePlan(state = {}, options = {}) {
    if (!GearLifecycle.isGearFocusActive(state)) return null;
    const targetRank = npcTargetRank(state);
    const reserve = operationalAdenaReserve(state);
    const spendable = Math.max(0, Number(state.adena || state.inventory?.[57]?.amount || 0) - reserve);
    const slots = desiredNpcSlots(state);

    if (missingRequiredDualSword(state)) {
        const dualCandidate = npcCandidatesForSlot(state, 14, targetRank, options)[0];
        if (dualCandidate) {
            return marketPlan(state, dualCandidate.item, dualCandidate.offer, {
                targetSlot: 14,
                reason: 'required_dual_sword',
                reserve
            });
        }
    }

    // First establish an adequate kit. Missing/under-grade slots select the
    // cheapest compatible item at the highest ordinary NPC grade, even when
    // the bot still needs to earn the Adena. This replaces exact-item farming
    // with a stable, shop-backed progression target.
    for (const slot of slots) {
        const current = equippedItemAtSlot(state, slot);
        if (current && rankIndex(current.etc?.rank) >= rankIndex(targetRank)) continue;
        const candidate = npcCandidatesForSlot(state, slot, targetRank, options)[0];
        if (candidate) return marketPlan(state, candidate.item, candidate.offer, {
            targetSlot: slot,
            reason: 'npc_progression',
            reserve
        });
    }

    // Within no-grade/D, spare money can improve an already complete kit.
    // At C+ an adequate D kit is only a bridge; crafting/drop/exchange
    // progression must take over instead of polishing D indefinitely.
    if (rankIndex(gradeForLevel(state.level)) > rankIndex('d')) return null;
    const role = roleFor(state);
    const classId = classIdFor(state);
    const improvements = slots.flatMap((slot) => {
        const current = equippedItemAtSlot(state, slot);
        const currentScore = current ? itemScore(current, role, classId) : 0;
        return npcCandidatesForSlot(state, slot, targetRank, options)
            .filter(({ offer }) => Number(offer.price) <= spendable)
            .map((candidate) => ({
                ...candidate,
                slot,
                gain: itemScore(candidate.item, role, classId) - currentScore
            }));
    })
        .sort((left, right) => {
            return (right.gain / Math.max(1, Number(right.offer.price))) - (left.gain / Math.max(1, Number(left.offer.price)))
                || slotPriority(right.item) - slotPriority(left.item)
                || Number(left.offer.price) - Number(right.offer.price);
        });
    const best = improvements[0];
    return best ? marketPlan(state, best.item, best.offer, {
        targetSlot: best.slot,
        reason: 'npc_progression',
        reserve
    }) : null;
}

function npcTargetRank(state = {}) {
    return rankIndex(gradeForLevel(state.level)) >= rankIndex('d') ? NPC_GEAR_MAX_RANK : 'none';
}

function staticNpcKitAdequate(state = {}) {
    const targetRank = npcTargetRank(state);
    return desiredNpcSlots(state).every((slot) => {
        const current = equippedItemAtSlot(state, slot);
        return current && rankIndex(current.etc?.rank) >= rankIndex(targetRank);
    });
}

function marketPlanForTarget(state = {}, targetId, options = {}) {
    const target = (DataCache.items || []).find((item) => Number(item.selfId) === Number(targetId));
    const role = roleFor(state);
    const ownedItems = inventoryItems(state.inventory);
    if (!target || !suitable(target, state, role, gradeForLevel(state.level))) return null;
    if (!isSlotUpgrade(target, ownedItems, role, classIdFor(state))) return null;
    const offer = marketOfferForTarget(target, state, options);
    return offer ? marketPlan(state, target, offer) : null;
}

function marketRecoveryPlanForTarget(state = {}, targetId, options = {}) {
    const exact = marketPlanForTarget(state, targetId, options);
    if (exact) return exact;
    const failedTarget = (DataCache.items || []).find((item) => Number(item.selfId) === Number(targetId));
    if (!failedTarget) return null;
    const role = roleFor(state);
    const classId = classIdFor(state);
    const ownedItems = inventoryItems(state.inventory);
    // Once the requested upgrade has been acquired, recovery is complete.
    // Do not turn one failed weapon route into an endless sequence of
    // same-slot market replacements.
    if (!suitable(failedTarget, state, role, gradeForLevel(state.level))
        || !isSlotUpgrade(failedTarget, ownedItems, role, classId)) return null;
    const failedSlot = WEAPON_SLOTS.has(Number(failedTarget.etc?.slot || 0))
        ? 'weapon'
        : Number(failedTarget.etc?.slot || 0);
    const excluded = excludedTargetIds(options);
    const cap = progressionPriceCap(gradeForLevel(state.level), state.level);
    const alternatives = (DataCache.items || [])
        .filter((item) => Number(item.selfId) !== Number(targetId))
        .filter((item) => !excluded.has(Number(item.selfId)))
        .filter((item) => {
            const slot = WEAPON_SLOTS.has(Number(item.etc?.slot || 0)) ? 'weapon' : Number(item.etc?.slot || 0);
            return slot === failedSlot;
        })
        .filter((item) => suitable(item, state, role, gradeForLevel(state.level)))
        .filter((item) => isSlotUpgrade(item, ownedItems, role, classId))
        .filter((item) => Number(item.template?.price || 0) <= cap)
        .map((item) => ({ item, offer: marketOfferForTarget(item, state, options) }))
        .filter((candidate) => candidate.offer)
        .sort((left, right) => Number(left.offer.price) - Number(right.offer.price)
            || itemScore(right.item, role, classId) - itemScore(left.item, role, classId));
    return alternatives[0] ? marketPlan(state, alternatives[0].item, alternatives[0].offer) : null;
}

function targetCombatCounter(state = {}, npcId) {
    const counter = state.stats?.targetCombat?.populationTargets?.[String(Number(npcId))] || {};
    return {
        npcId: Number(npcId || 0),
        resolves: Number(counter.resolves || 0),
        targetKills: Number(counter.targetKills || 0)
    };
}

function directPlanFailure(state = {}, plan = {}, timestamp = Date.now()) {
    if (plan?.status !== 'active' || plan.strategy !== 'direct_drop') return null;
    const targetId = Number(plan.target?.selfId || 0);
    const npcId = Number(plan.next?.npcId || 0);
    if (!targetId || !npcId) return null;
    const target = (DataCache.items || []).find((item) => Number(item.selfId) === targetId);
    if (!target || !isSlotUpgrade(target, inventoryItems(state.inventory), roleFor(state), classIdFor(state))) return null;
    const current = targetCombatCounter(state, npcId);
    const hasBaseline = Number(plan.targetProgress?.npcId || 0) === npcId;
    // Legacy plans have lifetime counters but no plan-local baseline. Let the
    // next finalize pass stamp the current values before judging this route.
    if (!hasBaseline) return null;
    const baseline = plan.targetProgress;
    const resolves = Math.max(0, current.resolves - Number(baseline.resolves || 0));
    const targetKills = Math.max(0, current.targetKills - Number(baseline.targetKills || 0));
    const ageMs = Math.max(0, Number(timestamp) - Number(plan.startedAt || timestamp));
    if (resolves < DIRECT_FAILURE_RESOLVE_LIMIT) return null;
    if (targetKills === 0) {
        return { reason: 'combat_unviable', targetId, npcId, resolves, targetKills, ageMs };
    }
    const expectedKills = Math.max(1, Number(plan.expectedKills || 1));
    if (targetKills >= Math.max(12, Math.ceil(expectedKills * DIRECT_DROP_EXHAUSTION_MULTIPLIER))) {
        return { reason: 'drop_exhausted', targetId, npcId, resolves, targetKills, ageMs };
    }
    return null;
}

function partyRouteFailure(state = {}, plan = {}, timestamp = Date.now()) {
    if (plan?.status !== 'active' || !['direct_drop', 'craft'].includes(plan.strategy)) return null;
    if (plan.partyNeed !== 'required' && plan.requiresParty !== true) return null;

    const request = state.stats?.partyRequest;
    if (request?.status !== 'deferred'
        || Number(request.attempts || 0) < PARTY_ROUTE_FAILURE_ATTEMPT_LIMIT) return null;

    const targetId = Number(plan.target?.selfId || (plan.strategy === 'direct_drop' ? plan.next?.itemId : 0) || 0);
    const npcId = Number(plan.next?.npcId || 0);
    if (!targetId || !npcId) return null;

    const requestedTargetId = Number(request.targetId || request.itemId || 0);
    const requestedNpcId = Number(request.npcId || 0);
    if (requestedTargetId > 0 && requestedTargetId !== targetId) return null;
    if (requestedNpcId > 0 && requestedNpcId !== npcId) return null;

    return {
        reason: 'party_route_unavailable',
        targetId,
        npcId,
        resolves: 0,
        targetKills: 0,
        attempts: Number(request.attempts || 0),
        ageMs: Math.max(0, Number(timestamp) - Number(plan.startedAt || timestamp))
    };
}

function replanContextFor(state = {}, previousPlan = null, timestamp = Date.now()) {
    const currentGrade = gradeForLevel(state.level);
    const currentLevel = Number(state.level || 1);
    const sameGrade = previousPlan?.grade === currentGrade;
    const recoveryTargets = sameGrade ? (previousPlan.recoveryTargets || [])
        .filter((entry) => Number(entry.until || 0) > timestamp && Number(entry.targetId || 0) > 0)
        : [];
    const failure = sameGrade
        ? (directPlanFailure(state, previousPlan, timestamp)
            || partyRouteFailure(state, previousPlan, timestamp))
        : null;
    if (failure) {
        const recovery = {
            targetId: failure.targetId,
            npcId: failure.npcId,
            reason: failure.reason,
            failedAt: timestamp,
            until: timestamp + DIRECT_ROUTE_COOLDOWN_MS
        };
        const index = recoveryTargets.findIndex((entry) => Number(entry.targetId) === failure.targetId);
        if (index >= 0) recoveryTargets[index] = recovery;
        else recoveryTargets.push(recovery);
    }
    const currentMarketRecovery = previousPlan?.strategy === 'market'
        ? recoveryTargets.find((entry) => Number(entry.targetId) === Number(previousPlan.target?.selfId || 0))
        : null;
    return {
        planCurrent: Boolean(previousPlan)
            && sameGrade
            && Number(previousPlan.plannedForLevel || 0) === currentLevel,
        failure,
        recoveryTargets,
        excludedTargetIds: recoveryTargets.map((entry) => Number(entry.targetId)),
        forceMarketTargetId: Number(failure?.targetId || currentMarketRecovery?.targetId || 0) || null
    };
}

function finalizePlan(state = {}, previousPlan = null, rawPlan = {}, context = {}, timestamp = Date.now()) {
    const sameDirectTarget = previousPlan?.status === 'active'
        && previousPlan.strategy === 'direct_drop'
        && rawPlan?.status === 'active'
        && rawPlan.strategy === 'direct_drop'
        && Number(previousPlan.target?.selfId || 0) === Number(rawPlan.target?.selfId || 0)
        && Number(previousPlan.next?.npcId || 0) === Number(rawPlan.next?.npcId || 0);
    const samePlan = previousPlan?.strategy === rawPlan?.strategy
        && Number(previousPlan?.target?.selfId || 0) === Number(rawPlan?.target?.selfId || 0)
        && Number(previousPlan?.next?.itemId || 0) === Number(rawPlan?.next?.itemId || 0);
    const targetProgress = rawPlan?.status === 'active' && rawPlan.strategy === 'direct_drop'
        ? (sameDirectTarget && previousPlan.targetProgress
            ? previousPlan.targetProgress
            : targetCombatCounter(state, rawPlan.next?.npcId))
        : null;
    const recoveryTargets = [...(context.recoveryTargets || [])];
    if (rawPlan?.strategy === 'market' && rawPlan.partyNeedReason === 'market_fallback'
        && !recoveryTargets.some((entry) => Number(entry.targetId) === Number(rawPlan.target?.selfId || 0))) {
        recoveryTargets.push({
            targetId: Number(rawPlan.target.selfId),
            npcId: null,
            reason: 'market_alternative',
            failedAt: timestamp,
            until: timestamp + DIRECT_ROUTE_COOLDOWN_MS
        });
    }
    return {
        ...rawPlan,
        startedAt: samePlan ? Number(previousPlan?.startedAt || timestamp) : timestamp,
        plannedForLevel: Number(state.level || 1),
        plannedForGrade: gradeForLevel(state.level),
        recoveryTargets,
        ...(targetProgress ? { targetProgress } : {})
    };
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
    // A target can be much stronger than the average of a mixed-level grid.
    // Safety must be evaluated against the NPC that actually drops the item,
    // not against incidental low-level mobs around it.
    return partyNeedForSource(state, source) === 'solo_ok';
}

function partyNeedAssessmentForSource(state = {}, source = {}) {
    const readiness = combatReadiness(state);
    const targetLevel = Number(source?.npcLevel || source?.spotLevel || Infinity);
    const margin = readiness.effectiveLevel - targetLevel;

    // A support with no weapon/armour cannot be treated as a safe solo farmer,
    // even when the level arithmetic happens to look favourable.  This is a
    // hard party need, while a normally equipped bot near the target level can
    // still progress alone and merely advertise a preferred party.
    const unpreparedSupport = ['healer', 'buffer'].includes(readiness.role)
        && readiness.armorCount < 2;
    if (!readiness.hasWeapon) return { need: 'required', reason: 'missing_weapon' };
    if (unpreparedSupport) return { need: 'required', reason: 'unprepared_support' };
    if (margin < -2) return { need: 'required', reason: 'underleveled' };
    if (margin < 0) return { need: 'preferred', reason: 'tight_level_margin' };
    return { need: 'solo_ok', reason: 'solo_ready' };
}

function partyNeedForSource(state = {}, source = {}) {
    return partyNeedAssessmentForSource(state, source).need;
}

function partyNeedReasonForSource(state = {}, source = {}) {
    return partyNeedAssessmentForSource(state, source).reason;
}

function bestSourceForState(sources = [], state = {}) {
    return sources.find((source) => soloSafeForSource(state, source)) || sources[0] || null;
}

function safeFallbackForPlan(state = {}, plan = {}, spots = []) {
    if (!plan || !['active', 'blocked'].includes(plan.status)) return null;
    const itemId = plan.strategy === 'direct_drop'
        ? Number(plan.target?.selfId || 0)
        : Number(plan.next?.itemId || 0);
    if (!itemId) return null;
    return sourceForItem(itemId, spots, state)
        .find((source) => partyNeedForSource(state, source) === 'solo_ok') || null;
}

function sourceIndexFor(spots = []) {
    const rewards = DataCache.npcRewards || [];
    if (sourceIndexCache.spots === spots && sourceIndexCache.rewards === rewards) {
        return sourceIndexCache.byItemId;
    }

    const npcById = new Map((DataCache.npcs || []).map((npc) => [Number(npc.selfId), npc]));
    const npcLevels = new Map((DataCache.npcs || []).map((npc) => [
        Number(npc.selfId),
        Number(npc.template?.level || 0)
    ]));
    const spotByNpc = new Map();
    const spotByName = new Map();
    const appendSpot = (index, key, spot) => {
        if (!key || !spot) return;
        const existing = index.get(key) || [];
        if (!existing.some((candidate) => candidate.id === spot.id)) existing.push(spot);
        index.set(key, existing);
    };
    (spots || []).forEach((spot) => (spot.npcEntries || []).forEach((entry) => {
        if (entry.selfId) appendSpot(spotByNpc, Number(entry.selfId), spot);
        if (entry.name) appendSpot(spotByName, String(entry.name).trim().toLowerCase(), spot);
    }));

    const byItemId = new Map();
    rewards.forEach((reward) => {
        if (BotRaidSafety.isProtectedRaidEntity(npcById.get(Number(reward.selfId)))) return;
        const spotsForNpc = [...new Map([
            ...(spotByNpc.get(Number(reward.selfId)) || []),
            ...(spotByName.get(String(reward.template?.name || '').trim().toLowerCase()) || [])
        ].map((spot) => [spot.id, spot])).values()];
        if (!spotsForNpc.length) return;
        const itemIds = new Set((reward.rewards || []).flatMap((group) => (
            (group.items || []).map((item) => Number(item.selfId || 0)).filter(Boolean)
        )));
        spotsForNpc.forEach((spot) => itemIds.forEach((id) => {
            const entries = byItemId.get(id) || [];
            if (!entries.some((entry) => entry.reward === reward && entry.spot.id === spot.id)) {
                entries.push({ reward, spot, npcLevel: npcLevels.get(Number(reward.selfId)) || 0 });
            }
            byItemId.set(id, entries);
        }));
    });

    sourceIndexCache = { spots, rewards, byItemId, resolved: new Map() };
    return byItemId;
}

function sourceForItem(itemId, spots = [], state = {}, options = {}) {
    const sourceCache = options.sourceCache;
    const cacheKey = `${Number(itemId)}:${Number(state.level || 0)}`;
    if (sourceCache?.has(cacheKey)) return sourceCache.get(cacheKey);
    const sourceIndex = sourceIndexFor(spots);
    const rates = ProgressionRates.profile();
    const resolvedKey = `${cacheKey}:${rates.drop}:${rates.adena}`;
    if (sourceIndexCache.resolved.has(resolvedKey)) {
        const cached = sourceIndexCache.resolved.get(resolvedKey);
        sourceCache?.set(cacheKey, cached);
        return cached;
    }
    const sources = (sourceIndex.get(Number(itemId)) || []).map(({ reward, spot, npcLevel }) => {
        const sourceLevel = Number(npcLevel || spot?.avgLevel || 1);
        const { chance, expectedYield } = itemDropYield(reward, itemId, 'drop', {
            npcLevel: sourceLevel,
            killerLevel: Number(state.level || 0)
        });
        if (!chance) return null;
        return { npcId: Number(reward.selfId), npcName: reward.template?.name || `NPC ${reward.selfId}`, kind: 'drop', chance, expectedYield, spotId: spot.id, spotLevel: Number(spot.avgLevel || 1), npcLevel: sourceLevel };
    }).filter(Boolean).sort((a, b) => b.expectedYield - a.expectedYield);
    if (sourceIndexCache.resolved.size >= MAX_RESOLVED_SOURCE_CACHE) {
        sourceIndexCache.resolved.delete(sourceIndexCache.resolved.keys().next().value);
    }
    sourceIndexCache.resolved.set(resolvedKey, sources);
    sourceCache?.set(cacheKey, sources);
    return sources;
}

function stationRecipeIds() {
    const service = { level: 70, stats: { classId: 57 } };
    const allowed = CraftShopService.availableRecipes(service);
    return new Set(CraftShopService.CraftStations.flatMap((station) => (
        CraftShopService.stationRecipes(station, allowed).map((recipe) => Number(recipe.recipeId))
    )));
}

function farmSourceForMaterial(itemId, state, spots, allowedRecipeIds, requiredAmount = 1, visited = new Set(), options = {}) {
    const direct = bestSourceForState(sourceForItem(itemId, spots, state, options), state);
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
        const source = farmSourceForMaterial(ingredient.selfId, state, spots, allowedRecipeIds, required - owned, nextVisited, options);
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

function combinationMetadata(recipe) {
    if (!C4DualSwordCombinations.isCombination(recipe)) return null;
    return {
        type: 'dual_sword',
        resultId: Number(recipe.productId),
        stationId: recipe.station?.id || null,
        npcId: Number(recipe.station?.npcId || 0) || null,
        requirements: (recipe.materials || []).map((material) => ({
            selfId: Number(material.selfId),
            amount: Number(material.amount || 0)
        }))
    };
}

function combinationBladeMarketPlan(target, materials, state, planningOptions) {
    const combine = combinationMetadata(target?.recipe);
    if (!combine) return null;
    const candidates = materials
        .filter((material) => Number(material.missing || 0) > 0)
        .map((material) => {
            const item = catalogItem(material.selfId);
            return item ? { material, item, offer: marketOfferForTarget(item, state, planningOptions) } : null;
        })
        .filter((candidate) => candidate?.offer)
        .sort((left, right) => Number(left.offer.price || Infinity) - Number(right.offer.price || Infinity));
    const selected = candidates[0];
    if (!selected) return null;
    return {
        ...marketPlan(state, selected.item, selected.offer, {
            reason: 'dual_sword_blade',
            reserve: operationalAdenaReserve(state)
        }),
        grade: String(target.item.etc?.rank || gradeForLevel(state.level)).toLowerCase(),
        materials,
        combine
    };
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
    const planningOptions = {
        ...options,
        allowedRecipeIds: options.allowedRecipeIds || stationRecipeIds(),
        sourceCache: options.sourceCache || new Map()
    };
    const preparedTarget = !options.recipeId && rankIndex(gradeForLevel(state.level)) > rankIndex('d')
        ? preferredTarget(state, planningOptions)
        : null;
    const preparedCraftReady = preparedTarget?.recipe
        && missingMaterials(preparedTarget.recipe, state.inventory)
            .every((material) => material.missing <= 0 || CraftSupplementMaterials.isSupplementalMaterial(material.selfId));
    const forcedMarketPlan = marketRecoveryPlanForTarget(state, options.forceMarketTargetId, options);
    if (forcedMarketPlan) return forcedMarketPlan;
    if (!options.recipeId && !preparedCraftReady) {
        const npcPlan = staticNpcUpgradePlan(state, planningOptions);
        if (npcPlan) return npcPlan;
        if (rankIndex(gradeForLevel(state.level)) <= rankIndex('d') && staticNpcKitAdequate(state)) {
            return { status: 'complete', reason: 'npc_adequate_kit', strategy: 'none', recipeId: null, materials: [], next: null };
        }
    }
    if (!GearLifecycle.allowsCrafting(state) || gradeForLevel(state.level) === 'none') {
        const target = preferredNoGradeTarget(state, planningOptions) || preferredDropTarget(state, planningOptions);
        const source = target
            ? bestSourceForState(sourceForItem(target.selfId, planningOptions.spots || [], state, planningOptions), state)
            : null;
        const offer = marketOfferForTarget(target, state, planningOptions);
        const directKills = source ? 1 / Math.max(source.expectedYield, 0.000001) : Infinity;
        const buy = offer && marketEffort(offer, state) <= directKills;
        const sourceAssessment = source ? partyNeedAssessmentForSource(state, source) : null;
        return target && buy ? {
            status: 'active', phase: GearLifecycle.phaseFor(state), grade: 'none', role: roleFor(state), strategy: 'market', soloSafe: true, requiresParty: false,
            rateModelVersion: RATE_MODEL_VERSION,
            expectedKills: Math.ceil(marketEffort(offer, state)),
            target: { selfId: Number(target.selfId), name: target.template?.name || `Item ${target.selfId}`, slot: Number(target.etc?.slot || 0) },
            market: { town: offer.town || 'Giran', price: Number(offer.price), sourceType: offer.sourceType },
            recipeId: null, materials: [], next: null
        } : source ? {
            status: 'active', grade: 'none', role: roleFor(state), strategy: 'direct_drop', soloSafe: sourceAssessment.need === 'solo_ok',
            partyNeed: sourceAssessment.need,
            partyNeedReason: sourceAssessment.reason,
            requiresParty: sourceAssessment.need === 'required',
            rateModelVersion: RATE_MODEL_VERSION,
            expectedKills: Math.ceil(1 / Math.max(source.expectedYield, 0.000001)),
            target: { selfId: Number(target.selfId), name: target.template?.name || `Item ${target.selfId}`, slot: Number(target.etc?.slot || 0) },
            recipeId: null, materials: [], next: { ...source, itemId: Number(target.selfId) }
        } : { status: 'no_grade_drop_only', grade: 'none', role: roleFor(state), strategy: 'direct_drop', rateModelVersion: RATE_MODEL_VERSION, recipeId: null, materials: [], next: null };
    }
    const target = preparedTarget || preferredTarget(state, planningOptions);
    if (!target) return { status: 'complete', reason: 'no_missing_craftable_upgrade' };

    const spots = options.spots || [];
    const materials = target.recipe ? missingMaterials(target.recipe, state.inventory) : [];
    const bladeMarketPlan = combinationBladeMarketPlan(target, materials, state, planningOptions);
    if (bladeMarketPlan) return bladeMarketPlan;
    const directSources = sourceForItem(target.item.selfId, spots, state, planningOptions);
    const direct = bestSourceForState(directSources, state);
    const allowedRecipeIds = planningOptions.allowedRecipeIds;
    const materialPlans = materials.map((material) => ({
        ...material,
        source: material.missing > 0
            ? farmSourceForMaterial(material.selfId, state, spots, allowedRecipeIds, material.missing, new Set(), planningOptions)
            : null
    }));
    const missingMaterialPlans = materialPlans.filter((material) => material.missing > 0 && !CraftSupplementMaterials.isSupplementalMaterial(material.selfId));
    const nextMaterial = missingMaterialPlans.slice().sort((a, b) => (
        (b.missing / Math.max(b.source?.expectedYield || 0.000001, 0.000001)) - (a.missing / Math.max(a.source?.expectedYield || 0.000001, 0.000001))
    ))[0] || null;
    const directKills = direct ? 1 / Math.max(direct.expectedYield, 0.000001) : Infinity;
    const craftKills = target.recipe
        ? missingMaterialPlans.reduce((sum, material) => sum + material.missing / Math.max(material.source?.expectedYield || 0.000001, 0.000001), 0)
        : Infinity;
    const offer = marketOfferForTarget(target.item, state, planningOptions);
    const buy = offer && marketEffort(offer, state) <= Math.min(directKills, craftKills);
    const directAssessment = direct ? partyNeedAssessmentForSource(state, direct) : null;
    const soloSafe = direct && directAssessment.need === 'solo_ok';
    const strategy = buy ? 'market'
        : direct && (!target.recipe || soloSafe && directKills <= craftKills * 0.8) ? 'direct_drop'
            : target.recipe ? 'craft' : 'blocked';
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
    const nextAssessment = !readyToCraft && !componentReady && next
        ? partyNeedAssessmentForSource(state, next)
        : { need: 'solo_ok', reason: 'solo_ready' };
    const partyNeed = nextAssessment.need;
    const partyNeedReason = nextAssessment.reason;
    const requiresParty = partyNeed === 'required';

    const combine = combinationMetadata(target.recipe);
    return {
        status: readyToCraft ? 'ready_to_craft' : componentReady ? 'component_ready' : strategy === 'market' || next ? 'active' : 'blocked',
        phase: GearLifecycle.phaseFor(state),
        grade: String(target.item.etc?.rank || gradeForLevel(state.level)).toLowerCase(),
        role: roleFor(state),
        rateModelVersion: RATE_MODEL_VERSION,
        target: { selfId: Number(target.item.selfId), name: target.item.template?.name || `Item ${target.item.selfId}`, slot: Number(target.item.etc?.slot || 0) },
        recipeId: target.recipe ? Number(target.recipe.recipeId) : null,
        strategy,
        soloSafe,
        partyNeed,
        partyNeedReason,
        requiresParty,
        expectedKills: next ? Math.ceil(strategy === 'direct_drop' ? directKills : craftKills) : 0,
        market: buy ? { town: offer.town || 'Giran', price: Number(offer.price), sourceType: offer.sourceType } : null,
        materials: materialPlans.map(({ source, ...material }) => ({ ...material, sourceSpotId: source?.spotId || null })),
        next: next ? { spotId: next.spotId, npcId: next.npcId, npcName: next.npcName, kind: next.kind, itemId: next.itemId } : null,
        ...(combine ? { combine } : {})
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

module.exports = { RATE_MODEL_VERSION, DIRECT_FAILURE_RESOLVE_LIMIT, PARTY_ROUTE_FAILURE_ATTEMPT_LIMIT, gradeForLevel, isCraftService, roleFor, itemScore, isRealCatalogItem, suitable, isSlotUpgrade, combatReadiness, progressionPriceCap, operationalAdenaReserve, equippedSlotsFor, equipInventoryUpgrades, preferredTarget, preferredDropTarget, preferredNoGradeTarget, marketOfferForTarget, marketPlanForTarget, marketRecoveryPlanForTarget, staticNpcUpgradePlan, staticNpcKitAdequate, itemDropChance, itemDropYield, partyNeedForSource, partyNeedReasonForSource, soloSafeForSource, bestSourceForState, safeFallbackForPlan, sourceForItem, farmSourceForMaterial, missingMaterials, directPlanFailure, partyRouteFailure, replanContextFor, finalizePlan, planFor, shouldFinishPreviousPlan, scoreSpot, sameObjective };
