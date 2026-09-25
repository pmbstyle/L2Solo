const ClanCrafting = require('../../Clan/ClanCraftingPolicy');
const ItemTemplateIndex = require('../../Item/ItemTemplateIndex');
const DataCache = invoke('GameServer/DataCache');
const C4RecipeItems = invoke('GameServer/Items/C4RecipeItems');
const C4DualSwordCombinations = invoke('GameServer/Items/C4DualSwordCombinations');
const ProgressionRates = invoke('GameServer/ProgressionRates');
const BotRoles = invoke('GameServer/Bot/AI/BotRoles');
const LevelingRoutes = invoke('GameServer/Bot/AI/LevelingRoutes');
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
const BotHuntingTargetPolicy = invoke('GameServer/Bot/AI/BotHuntingTargetPolicy');
const BotTargetScorer = invoke('GameServer/Bot/AI/BotTargetScorer');
const InventorySummary = invoke('GameServer/Bot/Population/InventorySummary');
const SpotRiskPolicy = invoke('GameServer/Bot/Population/SpotRiskPolicy');

const RANKS = ['none', 'd', 'c', 'b', 'a', 's'];
const WEAPON_SLOTS = new Set([7, 14]);
const ARMOR_SLOTS = new Set([6, 9, 10, 11, 12, 15]);
const JEWEL_SLOTS = new Set([1, 2, 3, 4, 5]);
const RATE_MODEL_VERSION = 12;
const DIRECT_FAILURE_RESOLVE_LIMIT = 8;
const DIRECT_DROP_EXHAUSTION_MULTIPLIER = 3;
const DIRECT_ROUTE_COOLDOWN_MS = 60 * 60 * 1000;
const PARTY_ROUTE_FAILURE_ATTEMPT_LIMIT = 2;
const PAIRED_SLOTS = Object.freeze({ 1: 2, 2: 1, 4: 5, 5: 4 });
const NPC_GEAR_MAX_RANK = 'd';
let staticNpcItemIdsCache = null;
let itemCatalogSource = null;
let itemCatalogById = new Map();
let npcCatalogSource = null;
let npcCatalogById = new Map();

function rateProfileSignature() {
    const rates = ProgressionRates.profile();
    return [rates.preset, rates.drop, rates.spoil, rates.adena].join(':');
}

function withRateProfile(plan) {
    if (!plan || typeof plan !== 'object') return plan;
    return {
        ...plan,
        rateModelVersion: RATE_MODEL_VERSION,
        rateProfileSignature: rateProfileSignature()
    };
}

function withinExpectedKillLimit(plan, maxExpectedKills = Infinity) {
    const requestedLimit = Number(maxExpectedKills);
    const persistedLimit = Number(plan?.expectedKillsLimit);
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
        ? requestedLimit
        : persistedLimit;
    if (!Number.isFinite(limit) || limit <= 0) return true;
    if (!['direct_drop', 'craft'].includes(String(plan?.strategy || ''))) return true;
    return Math.max(0, Number(plan?.expectedKills || 0)) <= limit;
}

function catalogItem(selfId) {
    const items = DataCache.items || [];
    if (itemCatalogSource !== items) {
        itemCatalogSource = items;
        itemCatalogById = new Map(items.map((item) => [Number(item.selfId), item]));
    }
    return itemCatalogById.get(Number(selfId)) || null;
}

function catalogNpc(selfId) {
    const npcs = DataCache.npcs || [];
    if (npcCatalogSource !== npcs) {
        npcCatalogSource = npcs;
        npcCatalogById = new Map(npcs.map((npc) => [Number(npc.selfId), npc]));
    }
    return npcCatalogById.get(Number(selfId)) || null;
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
        && name !== '0'
        && !/^_+$/.test(name);
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
    if (BotRoles.isSpoiler(state)) return 'spoiler';
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
    const classId = classIdFor(state);
    const equipped = equippedInventoryItems(state.inventory);
    const weapon = equipped.find((item) => WEAPON_SLOTS.has(Number(item.etc?.slot || 0))
        && BotWeaponCompatibility.isCompatibleWeapon(item.template?.kind,role,classId));
    const armor = equipped.filter((item) => ARMOR_SLOTS.has(Number(item.etc?.slot || 0))
        && suitable(item,state,role,item.etc?.rank));
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

// A profession change can leave a sword on a polearm fighter or a dagger on
// an archer. Such a weapon must neither satisfy nor outscore the new kit.
function ownedItemFitsBuild(item, role, classId) {
    return !WEAPON_SLOTS.has(Number(item.etc?.slot)) && Number(classId) !== 50
        || suitable(item, { classId }, role, item.etc?.rank);
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
        ownedItemFitsBuild(owned, role, classId)
        && (WEAPON_SLOTS.has(Number(owned.etc?.slot || 0)) ? 'weapon' : Number(owned.etc?.slot || 0)) === slot
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
        .filter((owned) => ownedItemFitsBuild(owned, role, classId))
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
    const direct = bestSourceForState(sourceForItem(item.selfId, spots, state, options), state, options);
    const directEffort = direct
        ? (1 / Math.max(Number(direct.expectedYield || 0), 0.000001))
            * (soloSafeForSource(state, direct) ? 1 : 1.35)
        : Infinity;
    if (!candidate.recipe) return Math.min(directEffort, marketEffortValue);

    const allowedRecipeIds = options.allowedRecipeIds || stationRecipeIds();
    let missingRoute = false;
    const materialEffort = missingMaterials(candidate.recipe, state.inventory)
        .filter((material) => material.missing > 0 && !CraftSupplementMaterials.isSupplementalMaterial(material.selfId))
        .reduce((sum, material) => {
            const source = farmSourceForMaterial(material.selfId, state, spots, allowedRecipeIds, material.missing, new Set(), options);
            if (!source) {
                missingRoute = true;
                return sum;
            }
            return sum + source.effort;
        }, 8);
    return Math.min(directEffort, marketEffortValue, missingRoute ? Infinity : materialEffort);
}

function shortlistCandidates(candidates = [], options = {}) {
    if (options.recipeId) return candidates;
    const offset = Math.max(0, Math.floor(Number(options.shortlistOffset || 0)));
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
        .slice(offset, offset + 3));
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

function opportunityScore(candidate, state, options = {}, precomputedEffort = undefined) {
    const role = roleFor(state);
    const classId = classIdFor(state);
    const ownedItems = inventoryItems(state.inventory);
    const improvement = Math.max(1, itemScore(candidate.item, role, classId) - currentSlotScore(candidate.item, ownedItems, role, classId) + 2);
    const effort = precomputedEffort === undefined
        ? candidateEffort(candidate, state, options)
        : precomputedEffort;
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
        const item = ItemTemplateIndex.find(DataCache.items, entry.selfId);
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
    const ArmorPolicy = invoke('GameServer/Bot/AI/BotArmorPolicy');
    const availableArmor = ordinaryCandidates.filter(({item}) => ArmorPolicy.ARMOR_SLOTS.has(Number(item.etc?.slot)));
    if (ArmorPolicy.completeSets(availableArmor.map(({item}) => item)).length) {
        const current = availableArmor.filter(({entry,item}) => equippedSlotsFor(entry,item.etc?.slot).length).map(({item}) => item);
        let chosen = ArmorPolicy.optimize([...best.values()].map(({item}) => item),availableArmor.map(({item}) => item),{role,classId});
        if (ArmorPolicy.score(current,role,classId) >= ArmorPolicy.score(chosen,role,classId)) chosen = current;
        for (const slot of ArmorPolicy.ARMOR_SLOTS) best.delete(String(slot));
        for (const item of chosen) best.set(String(item.etc.slot),availableArmor.find(candidate => candidate.item === item));
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
            const template = ItemTemplateIndex.find(DataCache.items, owned?.selfId);
            if (Number(template?.etc?.slot || 0) === 8
                && equippedSlotsFor(owned, owned.slot).includes(8)) {
                setUnequipped(owned);
            }
        });
    }
    best.forEach(({ entry, item }, key) => {
        const slot = Number(item.etc?.slot || 0);
        Object.values(next).forEach((owned) => {
            const ownedItem = ItemTemplateIndex.find(DataCache.items, owned.selfId);
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
            const template = ItemTemplateIndex.find(DataCache.items, owned?.selfId);
            if (Number(template?.etc?.slot || 0) === 8) setUnequipped(owned);
        });
    }
    Object.values(next).forEach((owned) => {
        if (!Array.isArray(owned?.instances)) return;
        Object.assign(owned, InventorySummary.completeInstances(owned));
    });
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
    const craftRecipes = (options.craftRecipes || Object.values(C4RecipeItems.loadRecipeItems() || {})).filter((recipe) => (
        recipe.type === 'dwarven' && (options.craftRecipes || publishedRecipeIds.has(Number(recipe.recipeId)))
    ));
    const recipes = ClanCrafting.clanIdFor(state) && !options.clanCrafting
        ? [] : [...craftRecipes, ...C4DualSwordCombinations.loadRecipes()];
    const recipeRank = options.recipeId
        ? String((DataCache.items || []).find((item) => Number(item.selfId) === Number(recipes.find((recipe) => Number(recipe.recipeId) === Number(options.recipeId))?.productId))?.etc?.rank || '')
        : null;
    const recipesByProduct = new Map(recipes.map((recipe) => [Number(recipe.productId), recipe]));
    const excluded = excludedTargetIds(options);
    const excludedMaterials = new Set((options.excludedMaterialIds || []).map(Number));
    const allCandidates = (DataCache.items || [])
        .filter((item) => suitable(item, state, role, recipeRank || gradeForLevel(state.level)))
        .filter((item) => !excluded.has(Number(item.selfId)))
        .map((item) => ({ item, recipe: recipesByProduct.get(Number(item.selfId)) || null }))
        .filter(({ item, recipe }) => !recipeNeedsExcludedMaterial(recipe, state, excludedMaterials)
            || !!marketOfferForTarget(item, state, options))
        .filter(({ recipe }) => !options.recipeId || Number(recipe?.recipeId) === Number(options.recipeId))
        .filter(({ item }) => Number(owned.get(Number(item.selfId)) || 0) < 1)
        .filter(({ item }) => (missingDualSword && item.template?.kind === 'Weapon.Dual')
            || isSlotUpgrade(item, ownedItems, role, classId));
    const requiredRank = recipeRank || gradeForLevel(state.level);
    const hasCurrentGradeWeapon = ownedItems.some((item) => (
        WEAPON_SLOTS.has(Number(item.etc?.slot || 0))
        && ownedItemFitsBuild(item, role, classId)
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
    const candidatePool = affordable.length ? affordable : progressionCandidates;
    const liveAvailability = !!options.occupancy && (options.spots || []).length > 0;
    const candidates = [];
    // Three candidates per slot remain the normal cold-path budget. Only when
    // that entire batch has no live route do we inspect the next nearby batch.
    for (let offset = 0; ; offset += 3) {
        const batch = shortlistCandidates(candidatePool, { ...options, shortlistOffset: offset });
        if (!batch.length) break;
        candidates.push(...batch.map((candidate) => {
            const effort = candidateEffort(candidate, state, effortOptions);
            return { candidate, effort, score: opportunityScore(candidate, state, effortOptions, effort) };
        }));
        if (options.recipeId || !liveAvailability || candidates.some((entry) => Number.isFinite(entry.effort))) break;
    }
    candidates.sort((a, b) => {
            const scoreDelta = b.score - a.score;
            if (Math.abs(scoreDelta) > 0.000001) return scoreDelta;
            return slotPriority(b.candidate.item) - slotPriority(a.candidate.item)
                || Number(a.candidate.item.template?.price || 0) - Number(b.candidate.item.template?.price || 0)
                || Number(a.candidate.item.selfId) - Number(b.candidate.item.selfId);
        });
    const available = liveAvailability
        ? candidates.filter((entry) => Number.isFinite(entry.effort))
        : candidates;
    // Live planning must never turn an exhausted shortlist into a durable
    // blocked goal. Returning null preserves the recovery metadata while the
    // bot continues its normal leveling route and retries after the failed
    // target's cooldown expires.
    // Stable per-character preferences spread comparable routes without
    // sacrificing a clearly better offer. Diagnostics without an ID stay stable.
    const peers = available.filter((entry) => entry.score >= Number(available[0]?.score || 0) * 0.85);
    const index = Math.abs(Math.imul(Number(state.characterId || 0), 2654435761) >>> 0) % Math.max(1, peers.length);
    return peers[index]?.candidate || null;
}

function preferredDropTarget(state = {}, options = {}) {
    const role = roleFor(state);
    const classId = classIdFor(state);
    const owned = inventoryMap(state.inventory);
    const excluded = excludedTargetIds(options);
    const candidates = (DataCache.items || [])
        .filter((item) => suitable(item, state, role, 'none'))
        .filter((item) => !excluded.has(Number(item.selfId)))
        .filter((item) => Number(owned.get(Number(item.selfId)) || 0) < 1)
        .sort((a, b) => itemScore(b, role, classId) - itemScore(a, role, classId) || Number(b.template?.price || 0) - Number(a.template?.price || 0));
    if (!options.occupancy || !(options.spots || []).length) return candidates[0] || null;
    return candidates.find((item) => targetHasAvailableRoute(item, state, options)) || null;
}

function preferredNoGradeTarget(state = {}, options = {}) {
    const role = roleFor(state);
    const ownedItems = inventoryItems(state.inventory);
    const classId = Number(state.stats?.classId || state.classId || 0);
    const planned = BotGear.planFor({ classId, level: Math.max(GearLifecycle.GEAR_FOCUS_LEVEL, Number(state.level || 1)) });
    const uniqueItems = new Set();
    const excluded = excludedTargetIds(options);

    const candidates = planned.items
        .map((desired) => ItemTemplateIndex.find(DataCache.items, desired.selfId))
        .filter(isRealCatalogItem)
        .filter((item) => !excluded.has(Number(item.selfId)))
        .filter((item) => {
            if (uniqueItems.has(Number(item.selfId))) return false;
            uniqueItems.add(Number(item.selfId));
            return isSlotUpgrade(item, ownedItems, role, classId);
        })
        .sort((a, b) => GearLifecycle.slotPriority(b.etc?.slot) - GearLifecycle.slotPriority(a.etc?.slot)
            || Number(a.template?.price || 0) - Number(b.template?.price || 0));
    if (!options.occupancy || !(options.spots || []).length) return candidates[0] || null;
    return candidates.find((item) => targetHasAvailableRoute(item, state, options)) || null;
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
    if (typeof options.findNpcOffer === 'function') {
        const offer = options.findNpcOffer(target, state);
        return offer?.sourceType === 'npc' ? offer : null;
    }
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

function desiredNpcSlots(state = {}, plan = BotGear.planFor({ classId: classIdFor(state), level: npcAdequacyLevel(state) })) {
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
        ownedItemFitsBuild(item, roleFor(state), classIdFor(state)) && (WEAPON_SLOTS.has(wanted)
            ? WEAPON_SLOTS.has(Number(item.etc?.slot || 0))
            : Number(item.etc?.slot || 0) === wanted
                // Full-body armour occupies both paperdoll body slots. Treat
                // it as the current chest/legs item while evaluating the NPC
                // bridge kit, otherwise a stronger full-body set repeatedly
                // generates weaker chest and legs purchases.
                || Number(item.etc?.slot || 0) === 15 && [10, 11].includes(wanted))
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
    const excludedSlots = new Set((options.excludedSlots || []).map(Number));
    const classId = classIdFor(state);
    const baseline = BotGear.planFor({ classId, level: npcAdequacyLevel(state) });
    const slots = desiredNpcSlots(state, baseline).filter((slot) => !excludedSlots.has(Number(slot)));
    const requiredDual = missingRequiredDualSword(state);
    const planForCandidate = (candidate) => marketPlan(state, candidate.item, candidate.offer, {
        targetSlot: candidate.slot,
        reason: requiredDual && candidate.slot === 14 ? 'required_dual_sword' : 'npc_progression',
        reserve
    });

    // First establish an adequate kit. Missing/under-grade slots select the
    // cheapest compatible item at the highest ordinary NPC grade. An unfunded
    // weapon must not block affordable armour; retain the first target for
    // saving only when none of these basic purchases fits the budget.
    let savingTarget = null;
    for (const slot of slots) {
        const current = equippedItemAtSlot(state, slot);
        if (current && rankIndex(current.etc?.rank) >= rankIndex(targetRank)
            && !(requiredDual && slot === 14)) continue;
        const candidate = npcCandidatesForSlot(state, slot, targetRank, options)[0];
        if (!candidate) continue;
        const purchase = { ...candidate, slot };
        savingTarget = savingTarget || purchase;
        if (Number(candidate.offer.price) <= spendable) return planForCandidate(purchase);
    }
    if (savingTarget) return planForCandidate(savingTarget);

    // Within no-grade/D, spare money can improve an already complete kit.
    // At C+ an adequate D kit is only a bridge; crafting/drop/exchange
    // progression must take over instead of polishing D indefinitely.
    if (rankIndex(gradeForLevel(state.level)) > rankIndex('d')) return null;
    const role = roleFor(state);
    const starterWeapon = BotGear.planFor({ classId, level: 1 }).items
        .find((item) => WEAPON_SLOTS.has(Number(item.slot)));
    const starterTemplate = catalogItem(starterWeapon?.selfId);
    const currentWeapon = equippedItemAtSlot(state, 7);
    const hasUpgradedWeapon = currentWeapon && (rankIndex(currentWeapon.etc?.rank) > rankIndex('none')
        || starterTemplate && itemScore(currentWeapon, role, classId) > itemScore(starterTemplate, role, classId));
    const baselineArmor = new Map(baseline.items
        .filter((item) => ARMOR_SLOTS.has(Number(item.slot)))
        .map((item) => [Number(item.slot), catalogItem(item.selfId)]));
    const improvements = slots.flatMap((slot) => {
        const current = equippedItemAtSlot(state, slot);
        const currentScore = current ? itemScore(current, role, classId) : 0;
        const armor = baselineArmor.get(slot);
        // Once the weapon is beyond the starter tier, bring protection up to
        // the class/level baseline before buying another same-grade weapon.
        // Derive this from equipped items so it also works after a restart,
        // a loot upgrade, or a trade, without purchase-history flags.
        const basicArmor = !!(hasUpgradedWeapon && armor && currentScore < itemScore(armor, role, classId));
        return npcCandidatesForSlot(state, slot, targetRank, options)
            .filter(({ offer }) => Number(offer.price) <= spendable)
            .map((candidate) => ({
                ...candidate,
                slot,
                basicArmor,
                gain: itemScore(candidate.item, role, classId) - currentScore
            }));
    })
        .sort((left, right) => {
            return Number(right.basicArmor) - Number(left.basicArmor)
                || slotPriority(right.item) - slotPriority(left.item)
                || (right.gain / Math.max(1, Number(right.offer.price))) - (left.gain / Math.max(1, Number(left.offer.price)))
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

function staticNpcKitAdequate(state = {}, options = {}) {
    const targetRank = npcTargetRank(state);
    // A filled no-grade paperdoll is not a finished starter kit while the
    // current NPC catalog still contains an affordable, stronger item. This
    // distinction matters for hot companions: they may arrive in town with a
    // stale "complete" snapshot even though their live Adena now covers an
    // upgrade.
    const npcUpgrade = Object.prototype.hasOwnProperty.call(options, 'evaluatedNpcUpgrade')
        ? options.evaluatedNpcUpgrade
        : staticNpcUpgradePlan(state, options);
    if (targetRank === 'none' && npcUpgrade) return false;
    return desiredNpcSlots(state).every((slot) => {
        const current = equippedItemAtSlot(state, slot);
        return current && rankIndex(current.etc?.rank) >= rankIndex(targetRank);
    });
}

// A profession change may invalidate the equipped weapon while an older
// higher-grade farm or clan objective is still active.  Establish a usable
// NPC-bought bridge before continuing that longer route; otherwise archers
// can spend thousands of fights carrying the dagger from their former class.
function npcWeaponBridgePlan(state = {}, options = {}) {
    if (combatReadiness(state).hasWeapon) return null;
    const optimizedInventory = equipInventoryUpgrades(state, state.inventory || {});
    if (combatReadiness({ ...state, inventory: optimizedInventory }).hasWeapon) return null;
    const plan = staticNpcUpgradePlan(state, options);
    return plan?.status === 'active'
        && plan.strategy === 'market'
        && WEAPON_SLOTS.has(Number(plan.target?.slot || 0))
        ? { ...plan, weaponBridge: true, partyNeedReason: 'weapon_bridge' }
        : null;
}

function marketPlanForTarget(state = {}, targetId, options = {}) {
    const target = ItemTemplateIndex.find(DataCache.items, targetId);
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
    const failedTarget = ItemTemplateIndex.find(DataCache.items, targetId);
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

function isClanOwnedPlan(plan = {}) {
    return Number(plan?.clanGoal?.clanId || 0) > 0
        && String(plan?.clanGoal?.goalKey || '').trim() !== '';
}

function equipmentTargetFulfilled(state = {}, plan = {}) {
    const targetId = Number(plan?.target?.selfId || 0);
    const targetSlot = Number(plan?.target?.slot || 0);
    if (!targetId || !targetSlot) return false;
    const item = state?.inventory?.[String(targetId)];
    if (!item?.equipped) return false;
    return equippedSlotsFor(item, item.slot).some((slot) => (
        slot === targetSlot
        || [7, 14].includes(slot) && [7, 14].includes(targetSlot)
    ));
}

function clanGoalPlanLocked(state = {}, plan = state?.stats?.equipmentPlan) {
    const npcId = Number(plan?.next?.npcId || 0);
    return isClanOwnedPlan(plan)
        && !levelingRecoveryFor(state, plan)
        && !equipmentTargetFulfilled(state, plan)
        && !require('./EquipmentAcquisitionProgress').componentAcquired(state, plan)
        && (
            plan?.status === 'blocked' && plan?.reason === 'equipment_effort_limit'
            || plan?.status !== 'blocked' && (!npcId || isPlanSourceViableForState(state, plan))
        );
}

function isBotEligibleSourceNpcId(npcId) {
    const npc = catalogNpc(npcId);
    return !!npc && BotHuntingTargetPolicy.canHunt(npc);
}

function sourceWithinVoluntaryHuntBand(state = {}, source = {}) {
    const botLevel = Number(state.level || 0);
    const sourceLevel = Number(source.npcLevel || source.spotLevel || 0);
    if (!botLevel || !sourceLevel) return true;
    return sourceLevel - botLevel >= BotTargetScorer.MIN_LEVEL_GAP;
}

function isPlanSourceViableForState(state = {}, plan = {}) {
    const npcId = Number(plan?.next?.npcId || 0);
    if (!npcId) return true;
    if (!isBotEligibleSourceNpcId(npcId)) return false;
    const npc = catalogNpc(npcId);
    return sourceWithinVoluntaryHuntBand(state, {
        npcLevel: Number(npc?.template?.level || npc?.level || 0)
    });
}

function directPlanFailure(state = {}, plan = {}, timestamp = Date.now()) {
    if (plan?.status !== 'active' || plan.strategy !== 'direct_drop') return null;
    const targetId = Number(plan.target?.selfId || 0);
    const npcId = Number(plan.next?.npcId || 0);
    if (!targetId || !npcId) return null;
    const target = ItemTemplateIndex.find(DataCache.items, targetId);
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

// Keep the failure on the acquisition plan so it survives travel, idle ticks
// and restarts, including ticks where there is no alternative equipment.
function acquisitionCooldown(state) {
    return (120 + Math.abs(Number(state.characterId || 0)) % 121) * 60000;
}

function abandonAcquisition(state, itemId, timestamp = Date.now(), reason = 'market_unfilled') {
    const plan = state.stats?.equipmentPlan;
    if (!plan?.target?.selfId || isClanOwnedPlan(plan)) return state;
    if (Number(plan.target.selfId) !== Number(itemId)
        && Number(plan.next?.itemId) !== Number(itemId)
        && !(plan.materials || []).some((material) => Number(material.selfId) === Number(itemId))) return state;
    const recoveryTargets = (plan.recoveryTargets || []).filter((entry) => (
        Number(entry.until) > timestamp && Number(entry.targetId) !== Number(plan.target.selfId)
    ));
    recoveryTargets.push({ targetId: Number(plan.target.selfId), itemId: Number(itemId),
        reason, failedAt: timestamp, until: timestamp + acquisitionCooldown(state) });
    return { ...state, stats: { ...state.stats, partyRequest: null, marketWanted: null,
        equipmentPlan: { status: 'abandoned', strategy: 'none', grade: gradeForLevel(state.level),
            reason, recoveryTargets, target: null, next: null, materials: [] } } };
}

function craftProgress(state, plan) {
    // Count only useful ingredients, including nested recipes. Extra common
    // drops beyond the recipe's needs must not mask a missing rare blade/edge.
    const requirements = {};
    const visit = (recipe, crafts = 1, seen = new Set()) => {
        if (!recipe || seen.has(recipe.recipeId)) return;
        const nextSeen = new Set(seen).add(recipe.recipeId);
        for (const material of recipe.materials || []) {
            if (CraftSupplementMaterials.isSupplementalMaterial(material.selfId)) continue;
            const required = Number(material.amount || 0) * crafts;
            requirements[material.selfId] = (requirements[material.selfId] || 0) + required;
            const component = C4RecipeItems.resolveByProductId(material.selfId);
            if (component) visit(component, Math.ceil(required / Math.max(1, Number(component.productCount || 1))), nextSeen);
        }
    };
    visit(C4RecipeItems.resolveByRecipeId(plan.recipeId) || C4DualSwordCombinations.resolveByRecipeId(plan.recipeId));
    return Object.fromEntries(Object.entries(requirements).map(([id, required]) => (
        [id, Math.min(required, Number(state.inventory?.[id]?.amount || 0))]
    )));
}

function craftPlanFailure(state, plan, timestamp) {
    if (plan?.status !== 'active' || plan.strategy !== 'craft' || isClanOwnedPlan(plan)) return null;
    const progress = plan.acquisitionProgress;
    if (!progress || timestamp - Number(progress.at) < acquisitionCooldown(state)) return null;
    const amounts = craftProgress(state, plan);
    if (Object.entries(amounts).some(([id, amount]) => amount > Number(progress.amounts?.[id] || 0))) return null;
    return { targetId: Number(plan.target?.selfId), itemId: Number(plan.next?.itemId),
        npcId: Number(plan.next?.npcId), reason: 'craft_stalled' };
}

function recipeNeedsExcludedMaterial(recipe, state, excluded, seen = new Set()) {
    if (!excluded.size || !recipe || seen.has(recipe.recipeId)) return false;
    const nextSeen = new Set(seen).add(recipe.recipeId);
    return (recipe.materials || []).some((material) => {
        if (Number(state.inventory?.[material.selfId]?.amount || 0) >= Number(material.amount)) return false;
        return excluded.has(Number(material.selfId))
            || recipeNeedsExcludedMaterial(C4RecipeItems.resolveByProductId(material.selfId), state, excluded, nextSeen);
    });
}

function replanContextFor(state = {}, previousPlan = null, timestamp = Date.now()) {
    const currentGrade = gradeForLevel(state.level);
    const currentLevel = Number(state.level || 1);
    const sameGrade = previousPlan?.grade === currentGrade;
    const levelingRecovery = levelingRecoveryFor(state, previousPlan, timestamp);
    const sourceNpcId = Number(previousPlan?.next?.npcId || 0);
    const sourceAllowed = !sourceNpcId || isBotEligibleSourceNpcId(sourceNpcId);
    const sourceViable = !sourceNpcId || isPlanSourceViableForState(state, previousPlan);
    const modelCurrent = Number(previousPlan?.rateModelVersion || 0) >= RATE_MODEL_VERSION
        && String(previousPlan?.rateProfileSignature || '') === rateProfileSignature();
    const recoveryTargets = sameGrade ? (previousPlan.recoveryTargets || [])
        .filter((entry) => Number(entry.until || 0) > timestamp && Number(entry.targetId || 0) > 0)
        : [];
    const failure = sameGrade
        ? (directPlanFailure(state, previousPlan, timestamp)
            || partyRouteFailure(state, previousPlan, timestamp)
            || craftPlanFailure(state, previousPlan, timestamp))
        : null;
    if (failure) {
        const recovery = {
            targetId: failure.targetId,
            npcId: failure.npcId,
            itemId: failure.itemId,
            reason: failure.reason,
            failedAt: timestamp,
            until: timestamp + (failure.itemId ? acquisitionCooldown(state) : DIRECT_ROUTE_COOLDOWN_MS)
        };
        const index = recoveryTargets.findIndex((entry) => Number(entry.targetId) === failure.targetId);
        if (index >= 0) recoveryTargets[index] = recovery;
        else recoveryTargets.push(recovery);
    }
    const currentMarketRecovery = previousPlan?.strategy === 'market'
        ? recoveryTargets.find((entry) => Number(entry.targetId) === Number(previousPlan.target?.selfId || 0))
        : null;
    return {
        levelingRecovery,
        planCurrent: !levelingRecovery && !ClanCrafting.isPersonalCraft(state, previousPlan) && Boolean(previousPlan)
            && sameGrade
            && Number(previousPlan.plannedForLevel || 0) === currentLevel,
        routeCurrent: !levelingRecovery && !ClanCrafting.isPersonalCraft(state, previousPlan) && Boolean(previousPlan)
            && sameGrade
            && sourceAllowed
            && sourceViable
            && modelCurrent
            && Number(previousPlan.plannedForLevel || 0) === currentLevel,
        invalidSource: !sourceAllowed
            ? { npcId: sourceNpcId, reason: 'protected_raid_source' }
            : !sourceViable
                ? { npcId: sourceNpcId, reason: 'level_too_low' }
                : null,
        failure,
        recoveryTargets,
        excludedTargetIds: recoveryTargets.map((entry) => Number(entry.targetId)),
        excludedMaterialIds: recoveryTargets.map((entry) => Number(entry.itemId || 0)).filter(Boolean),
        forceMarketTargetId: Number(failure?.targetId || currentMarketRecovery?.targetId || 0) || null
    };
}

function finalizePlan(state = {}, previousPlan = null, rawPlan = {}, context = {}, timestamp = Date.now()) {
    const recovery = context.levelingRecovery || levelingRecoveryFor(state, previousPlan, timestamp);
    if (recovery) return levelingRecoveryPlan(state, recovery, previousPlan);
    if (ClanCrafting.isPersonalCraft(state, rawPlan)) return { status: 'deferred', strategy: 'none', reason: 'clan_managed_crafting', materials: [], next: null };
    if (clanGoalPlanLocked(state, previousPlan) && context?.allowClanGoalReplan !== true) {
        return previousPlan;
    }
    const sameDirectTarget = previousPlan?.status === 'active'
        && previousPlan.strategy === 'direct_drop'
        && rawPlan?.status === 'active'
        && rawPlan.strategy === 'direct_drop'
        && Number(previousPlan.target?.selfId || 0) === Number(rawPlan.target?.selfId || 0)
        && Number(previousPlan.next?.npcId || 0) === Number(rawPlan.next?.npcId || 0);
    const samePlan = previousPlan?.strategy === rawPlan?.strategy
        && Number(previousPlan?.target?.selfId || 0) === Number(rawPlan?.target?.selfId || 0)
        && Number(previousPlan?.next?.itemId || 0) === Number(rawPlan?.next?.itemId || 0);
    const sameClanTarget = previousPlan?.clanGoal
        && Number(previousPlan?.target?.selfId || 0) === Number(rawPlan?.target?.selfId || 0)
        && Number(previousPlan?.target?.slot || 0) === Number(rawPlan?.target?.slot || 0);
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
    const amounts = rawPlan?.strategy === 'craft' ? craftProgress(state, rawPlan) : null;
    const previousProgress = previousPlan?.acquisitionProgress;
    const sameCraftTarget = previousPlan?.strategy === 'craft'
        && Number(previousPlan.target?.selfId) === Number(rawPlan?.target?.selfId);
    const progressed = !sameCraftTarget || !previousProgress || Object.entries(amounts || {})
        .some(([id, amount]) => amount > Number(previousProgress.amounts?.[id] || 0));
    return {
        ...rawPlan,
        grade: rawPlan.grade || gradeForLevel(state.level),
        ...(amounts ? { acquisitionProgress: progressed ? { at: timestamp, amounts } : previousProgress } : {}),
        // Clan-owned gear objectives must survive the normal solo replan. The
        // route/item may be refreshed, but ownership of the beneficiary goal
        // remains durable until the target is equipped.
        ...(sameClanTarget ? { clanGoal: { ...previousPlan.clanGoal } } : {}),
        startedAt: samePlan ? Number(previousPlan?.startedAt || timestamp) : timestamp,
        plannedForLevel: Number(state.level || 1),
        plannedForGrade: gradeForLevel(state.level),
        progressionBaseline: samePlan && previousPlan?.progressionBaseline
            ? previousPlan.progressionBaseline
            : { level: Number(state.level || 1), exp: Number(state.exp || 0) },
        recoveryTargets,
        ...(targetProgress ? { targetProgress } : {})
    };
}

function levelingRecoveryFor(state = {}, plan = state.stats?.equipmentPlan, timestamp = Date.now()) {
    const stored = plan?.levelingRecovery;
    if (stored) {
        return timestamp < Number(stored.until || 0)
            || Number(state.exp || 0) < Number(stored.resumeExp || 0)
            || Number(state.level || 1) < Number(stored.resumeLevel || 1) ? stored : null;
    }
    if (plan?.status !== 'active' || !['direct_drop', 'craft'].includes(plan.strategy)) return null;
    const level = Number(state.level || 1);
    const baselineLevel = Math.max(Number(plan.progressionBaseline?.level || level),
        Number(plan.plannedForLevel || level));
    const death = state.stats?.deathExperience;
    // Old plans may already have been restamped at the reduced level while
    // retaining a target from the old grade. Recover those persisted routes too.
    const gradeRegression = rankIndex(plan.grade) > rankIndex(gradeForLevel(level))
        && Number(death?.expLost || 0) > 0
        && Number(death?.penaltyAppliedAt || 0) >= Number(plan.startedAt || 0);
    const pressure = SpotRiskPolicy.deathPressure(state, plan.next?.spotId);
    const deleveled = level < baselineLevel || gradeRegression;
    if (!deleveled && !pressure) return null;
    return {
        reason: deleveled ? 'level_regression' : pressure.reason || 'death_pressure',
        startedAt: timestamp,
        until: timestamp + SpotRiskPolicy.BACKOFF_MS,
        resumeLevel: deleveled ? Math.max(level, baselineLevel) : level,
        resumeExp: Math.max(Number(state.exp || 0), Number(plan.progressionBaseline?.exp || 0),
            Number(death?.expBeforeDeath || 0)),
        targetId: Number(plan.target?.selfId || 0),
        npcId: Number(plan.next?.npcId || 0),
        spotId: plan.next?.spotId || null
    };
}

function levelingRecoveryPlan(state, recovery, previousPlan = state.stats?.equipmentPlan) {
    return withRateProfile({
        status: 'deferred', phase: 'leveling', strategy: 'none',
        reason: recovery.reason, grade: gradeForLevel(state.level),
        target: null, next: null, materials: [], recipeId: null,
        levelingRecovery: recovery,
        recoveryTargets: previousPlan?.recoveryTargets || []
    });
}

function itemDropChance(reward, itemId, kind = 'drop') {
    return itemDropYield(reward, itemId, kind).chance;
}

function itemDropYield(reward, itemId, kind = 'drop', context = {}) {
    return (reward?.[kind === 'spoil' ? 'spoils' : 'rewards'] || []).reduce((sum, group) => {
        const roll = ProgressionRates.rewardGroupRoll(group, kind, context, () => 0);
        const groupChance = Number(roll.chance || 0) / 100;
        const matchingItems = (group.items || []).filter((item) => Number(item.selfId) === Number(itemId));
        if (kind === 'drop') {
            const selectionChance = matchingItems.reduce((itemSum, item) => (
                itemSum + ProgressionRates.dropItemSelectionChance(group, item, roll.itemRate)
            ), 0);
            const selectedYield = matchingItems.reduce((itemSum, item) => (
                itemSum
                + ProgressionRates.dropItemSelectionChance(group, item, roll.itemRate)
                    * ProgressionRates.expectedDropAmount(group, item, roll.itemRate)
            ), 0);
            return {
                chance: sum.chance + groupChance * selectionChance,
                expectedYield: sum.expectedYield + groupChance * selectedYield
            };
        }

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

function sourceOccupancyEntry(source, occupancy) {
    if (!occupancy || !source?.spotId) return null;
    return occupancy instanceof Map ? occupancy.get(source.spotId) : occupancy[source.spotId];
}

function sourceStateKey(state = {}) {
    return String(state.characterId || state.name || state.stats?.generatedIndex || '');
}

function sourceHasCapacity(source, state, options = {}) {
    const entry = sourceOccupancyEntry(source, options.occupancy);
    const units = Math.max(1, Math.floor(Number(options.capacityUnits || 1)));
    if (!entry) {
        const capacity = Number(source.capacity || LevelingRoutes.capacityForSpot(source));
        return units <= Math.max(1, capacity);
    }
    const reservationKey = String(options.reservationKey || '');
    const maxReservationGroups = Math.max(0, Math.floor(Number(options.maxReservationGroups || 0)));
    if (reservationKey && maxReservationGroups > 0) {
        const reservationKeys = entry.reservationKeys instanceof Set ? entry.reservationKeys : new Set();
        const retainedReservationKeys = entry.retainedReservationKeys instanceof Set
            ? entry.retainedReservationKeys
            : reservationKeys;
        if (reservationKeys.has(reservationKey)) {
            if (!retainedReservationKeys.has(reservationKey)) return false;
        } else if (retainedReservationKeys.size >= maxReservationGroups) {
            return false;
        }
    }
    const count = typeof entry === 'object'
        ? Number(entry.reservedCount ?? entry.count ?? 0)
        : Number(entry || 0);
    const capacity = typeof entry === 'object' && Number(entry.capacity || 0) > 0
        ? Number(entry.capacity)
        : Number(source.capacity || LevelingRoutes.capacityForSpot(source));
    if (entry.retained instanceof Set && entry.retained.has(sourceStateKey(state))) return true;
    return count + units <= Math.max(1, capacity);
}

function targetHasAvailableRoute(target, state = {}, options = {}) {
    if (!target) return false;
    if (marketOfferForTarget(target, state, options)) return true;
    return !!bestSourceForState(
        sourceForItem(target.selfId, options.spots || [], state, options),
        state,
        options
    );
}

function sourceIsExcluded(source, options = {}) {
    const excluded = options.excludedSpotIds;
    if (!excluded || !source?.spotId) return false;
    return excluded instanceof Set
        ? excluded.has(String(source.spotId)) || excluded.has(source.spotId)
        : Array.isArray(excluded) && excluded.map(String).includes(String(source.spotId));
}

function bestSourceForState(sources = [], state = {}, options = {}) {
    const allowedSources = sources
        .filter((source) => !sourceIsExcluded(source, options))
        .filter((source) => sourceWithinVoluntaryHuntBand(state, source));
    const safeSources = allowedSources.filter((source) => soloSafeForSource(state, source));
    if (!options.occupancy) return safeSources[0] || allowedSources[0] || null;
    const safeAvailable = safeSources.filter((source) => sourceHasCapacity(source, state, options));
    if (safeAvailable.length) return safeAvailable[0];
    const available = allowedSources.filter((source) => sourceHasCapacity(source, state, options));
    return available[0] || null;
}

function itemIdForPlan(plan = {}) {
    return plan.strategy === 'direct_drop'
        ? Number(plan.target?.selfId || 0)
        : Number(plan.next?.itemId || 0);
}

function plannedMaterialAcquired(state, plan) {
    return plan?.strategy === 'craft' && Number(plan.next?.requiredTotal || 0) > 0
        && Number(state.inventory?.[plan.next.itemId]?.amount || 0) >= Number(plan.next.requiredTotal);
}

function bestSourceForPlan(state = {}, plan = {}, spots = [], options = {}) {
    if (levelingRecoveryFor(state, plan, options.timestamp)) return null;
    if (ClanCrafting.isPersonalCraft(state, plan) && !options.clanCrafting) return null;
    if (plan?.status !== 'active' || plannedMaterialAcquired(state, plan)) return null;
    const itemId = itemIdForPlan(plan);
    if (!itemId) return null;
    return bestSourceForState(sourceForItem(itemId, spots, state, options), state, options);
}

function safeFallbackForPlan(state = {}, plan = {}, spots = [], options = {}) {
    if (!plan || !['active', 'blocked'].includes(plan.status)) return null;
    const itemId = plan.strategy === 'direct_drop'
        ? Number(plan.target?.selfId || 0)
        : Number(plan.next?.itemId || 0);
    if (!itemId) return null;
    return bestSourceForState(sourceForItem(itemId, spots, state, options)
        .filter((source) => soloSafeForSource(state, source)), state, options);
}

function retargetPlanSource(state = {}, plan = {}, source = null) {
    if (!source || !plan || !['direct_drop', 'craft'].includes(plan.strategy)) return plan;
    const itemId = itemIdForPlan(plan);
    if (!itemId) return plan;
    const assessment = partyNeedAssessmentForSource(state, source);
    const next = {
        spotId: source.spotId,
        npcId: Number(source.npcId || 0) || null,
        npcName: source.npcName || null,
        kind: source.kind || 'drop',
        itemId,
        amount: plan.next?.amount || 1,
        requiredTotal: plan.next?.requiredTotal
    };
    const materials = plan.strategy === 'craft'
        ? (plan.materials || []).map((material) => Number(material.selfId) === itemId
            ? { ...material, sourceSpotId: source.spotId }
            : material)
        : plan.materials;
    const current = targetCombatCounter(state, source.npcId);
    const retargeted = withRateProfile({
        ...plan,
        next,
        materials,
        soloSafe: assessment.need === 'solo_ok',
        partyNeed: assessment.need,
        partyNeedReason: assessment.reason,
        requiresParty: assessment.need === 'required',
        ...(plan.strategy === 'direct_drop' ? {
            expectedKills: Math.ceil(1 / Math.max(Number(source.expectedYield || 0), 0.000001)),
            targetProgress: Number(plan.targetProgress?.npcId) === Number(source.npcId)
                ? plan.targetProgress : {
                npcId: Number(source.npcId || 0),
                resolves: current.resolves,
                targetKills: current.targetKills
            }
        } : {})
    });
    if (!withinExpectedKillLimit(retargeted)) {
        return withRateProfile({
            ...plan,
            status: 'blocked',
            reason: 'equipment_effort_limit',
            strategy: 'none',
            target: null,
            recipeId: null,
            expectedKills: 0,
            materials: [],
            next: null
        });
    }
    return retargeted;
}

function replacementPlanFor(state = {}, previousPlan = {}, spots = [], options = {}) {
    const recovery = options.levelingRecovery || levelingRecoveryFor(state, previousPlan, options.timestamp);
    if (recovery) return levelingRecoveryPlan(state, recovery, previousPlan);
    if (ClanCrafting.isPersonalCraft(state, previousPlan) && !options.clanCrafting) return planFor(state, { ...options, spots });
    const weaponBridge = npcWeaponBridgePlan(state, options);
    if (weaponBridge) return weaponBridge;
    const targetId = Number(previousPlan?.target?.selfId || 0);
    const excluded = new Set((options.excludedTargetIds || []).map(Number).filter(Boolean));
    if (!excluded.has(targetId)) {
        if (plannedMaterialAcquired(state, previousPlan)) {
            const refreshed = planFor(state, { ...options, spots, recipeId: previousPlan.recipeId });
            if (['active', 'component_ready', 'ready_to_craft', 'complete'].includes(refreshed?.status)) return refreshed;
        }
        const source = bestSourceForPlan(state, previousPlan, spots, options);
        if (source) return retargetPlanSource(state, previousPlan, source);
    }
    const market = targetId ? marketPlanForTarget(state, targetId, options) : null;
    if (market) return market;
    if (targetId) excluded.add(targetId);
    const planner = module.exports.planFor || planFor;
    const replacement = planner(state, {
        ...options,
        spots,
        excludedTargetIds: [...excluded]
    });
    if (replacement?.status !== 'blocked') return replacement;
    return {
        status: 'complete',
        reason: 'no_available_equipment_alternative',
        strategy: 'none',
        recipeId: null,
        materials: [],
        next: null
    };
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
        const itemKinds = [
            ['drop', reward.rewards || []],
            ['spoil', reward.spoils || []]
        ].flatMap(([kind, groups]) => groups.flatMap((group) => (
            (group.items || []).map((item) => ({ id: Number(item.selfId || 0), kind })).filter((item) => item.id)
        )));
        spotsForNpc.forEach((spot) => itemKinds.forEach(({ id, kind }) => {
            const entries = byItemId.get(id) || [];
            if (!entries.some((entry) => entry.reward === reward && entry.spot.id === spot.id && entry.kind === kind)) {
                entries.push({ reward, spot, kind, npcLevel: npcLevels.get(Number(reward.selfId)) || 0 });
            }
            byItemId.set(id, entries);
        }));
    });

    sourceIndexCache = { spots, rewards, byItemId, resolved: new Map() };
    return byItemId;
}

function sourceForItem(itemId, spots = [], state = {}, options = {}) {
    const sourceCache = options.sourceCache;
    const spoilCapable = options.spoilCapable === true || roleFor(state) === 'spoiler';
    const cacheKey = `${Number(itemId)}:${Number(state.level || 0)}:${spoilCapable ? 1 : 0}`;
    if (sourceCache?.has(cacheKey)) return sourceCache.get(cacheKey);
    const sourceIndex = sourceIndexFor(spots);
    const rates = ProgressionRates.profile();
    const resolvedKey = `${cacheKey}:${rates.drop}:${rates.spoil}:${rates.adena}`;
    if (sourceIndexCache.resolved.has(resolvedKey)) {
        const cached = sourceIndexCache.resolved.get(resolvedKey);
        sourceCache?.set(cacheKey, cached);
        return cached;
    }
    const sources = (sourceIndex.get(Number(itemId)) || []).filter(({ kind }) => (
        kind !== 'spoil' || spoilCapable
    )).map(({ reward, spot, kind, npcLevel }) => {
        const sourceLevel = Number(npcLevel || spot?.avgLevel || 1);
        const { chance, expectedYield } = itemDropYield(reward, itemId, kind, {
            npcLevel: sourceLevel,
            killerLevel: Number(state.level || 0)
        });
        if (!chance) return null;
        return {
            npcId: Number(reward.selfId),
            npcName: reward.template?.name || `NPC ${reward.selfId}`,
            kind,
            chance,
            expectedYield,
            spotId: spot.id,
            spotLevel: Number(spot.avgLevel || 1),
            npcLevel: sourceLevel,
            capacity: LevelingRoutes.capacityForSpot(spot)
        };
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
    if (visited.has(Number(itemId))) return null;
    const direct = bestSourceForState(sourceForItem(itemId, spots, state, options), state, options);
    const directRoute = direct ? { ...direct, itemId: Number(itemId), requiredAmount,
        requiredTotal: requiredAmount + Number(state.inventory?.[itemId]?.amount || 0),
        effort: requiredAmount / Math.max(direct.expectedYield || 0, 0.000001) } : null;
    const component = options.recipeCatalog?.get(Number(itemId)) || C4RecipeItems.resolveByProductId(itemId);
    if (!component || !allowedRecipeIds.has(Number(component.recipeId))) return directRoute;
    const nextVisited = new Set(visited).add(Number(itemId));
    const crafts = Math.max(1, Math.ceil(requiredAmount / Math.max(1, Number(component.productCount || 1))));
    const routes = [];
    for (const ingredient of component.materials || []) {
        const owned = Number(state.inventory?.[ingredient.selfId]?.amount || 0);
        const required = Number(ingredient.amount || 0) * crafts;
        if (owned >= required || CraftSupplementMaterials.isSupplementalMaterial(ingredient.selfId)) continue;
        const source = farmSourceForMaterial(ingredient.selfId, state, spots, allowedRecipeIds, required - owned, nextVisited, options);
        // A recipe is viable only if every missing ingredient has a route.
        if (!source) return directRoute;
        routes.push(source);
    }
    const effort = 8 + routes.reduce((sum, route) => sum + route.effort, 0);
    if (directRoute && directRoute.effort <= effort) return directRoute;
    const next = routes.filter((route) => route.spotId).sort((left, right) => right.effort - left.effort)[0];
    return { ...(next || { itemId: Number(itemId), requiredAmount }), effort };
}

function hasReadyCraftComponent(recipe, state, allowedRecipeIds, visited = new Set(), options = {}) {
    if (!recipe || visited.has(Number(recipe.recipeId))) return false;
    const nextVisited = new Set(visited).add(Number(recipe.recipeId));
    for (const material of recipe.materials || []) {
        const owned = Number(inventoryMap(state.inventory).get(Number(material.selfId)) || 0);
        if (owned >= Number(material.amount || 0)) continue;
        const component = options.recipeCatalog?.get(Number(material.selfId)) || C4RecipeItems.resolveByProductId(material.selfId);
        if (!component || !allowedRecipeIds.has(Number(component.recipeId))) continue;
        if ((component.materials || []).every((ingredient) => (
            Number(inventoryMap(state.inventory).get(Number(ingredient.selfId)) || 0) >= Number(ingredient.amount || 0)
        )) || hasReadyCraftComponent(component, state, allowedRecipeIds, nextVisited, options)) return true;
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

function rawPlanFor(state = {}, options = {}) {
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
        recipeCatalog: options.craftRecipes ? new Map(options.craftRecipes.map(recipe => [Number(recipe.productId), recipe])) : null,
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
        if (rankIndex(gradeForLevel(state.level)) <= rankIndex('d') && staticNpcKitAdequate(state, {
            ...planningOptions,
            evaluatedNpcUpgrade: npcPlan
        })) {
            return { status: 'complete', reason: 'npc_adequate_kit', strategy: 'none', recipeId: null, materials: [], next: null };
        }
    }
    if (!GearLifecycle.allowsCrafting(state) || gradeForLevel(state.level) === 'none') {
        const target = preferredNoGradeTarget(state, planningOptions) || preferredDropTarget(state, planningOptions);
        const source = target
            ? bestSourceForState(sourceForItem(target.selfId, planningOptions.spots || [], state, planningOptions), state, planningOptions)
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
    const direct = bestSourceForState(directSources, state, planningOptions);
    const allowedRecipeIds = planningOptions.allowedRecipeIds;
    const materialPlans = materials.map((material) => ({
        ...material,
        source: material.missing > 0
            ? farmSourceForMaterial(material.selfId, state, spots, allowedRecipeIds, material.missing, new Set(), planningOptions)
            : null
    }));
    const missingMaterialPlans = materialPlans.filter((material) => material.missing > 0 && !CraftSupplementMaterials.isSupplementalMaterial(material.selfId));
    const nextMaterial = missingMaterialPlans.slice().sort((a, b) => (
        (b.source?.effort ?? Infinity) - (a.source?.effort ?? Infinity)
    ))[0] || null;
    const directKills = direct ? 1 / Math.max(direct.expectedYield, 0.000001) : Infinity;
    const craftKills = target.recipe
        ? missingMaterialPlans.reduce((sum, material) => sum + (material.source?.effort ?? Infinity), 0)
        : Infinity;
    const offer = marketOfferForTarget(target.item, state, planningOptions);
    const buy = offer && marketEffort(offer, state) <= Math.min(directKills, craftKills);
    const directAssessment = direct ? partyNeedAssessmentForSource(state, direct) : null;
    const soloSafe = direct && directAssessment.need === 'solo_ok';
    const strategy = buy ? 'market'
        : direct && (!target.recipe || !Number.isFinite(craftKills) || soloSafe && directKills <= craftKills * 0.8) ? 'direct_drop'
            : target.recipe ? 'craft' : 'blocked';
    const next = strategy === 'direct_drop'
        ? direct && { ...direct, itemId: Number(target.item.selfId) }
        : strategy === 'craft' ? nextMaterial?.source && { ...nextMaterial.source } : null;
    // Keep final-equipment readiness distinct from an available intermediate
    // craft.  Both routes go to a station, but reporting a ready Cokes batch
    // as "can craft Atuba Mace" made the progression telemetry lie and hid
    // the remaining work in a long component chain.
    const readyToCraft = strategy === 'craft' && missingMaterialPlans.length === 0;
    const componentReady = strategy === 'craft'
        && !readyToCraft
        && hasReadyCraftComponent(target.recipe, state, allowedRecipeIds, new Set(), planningOptions);
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
        next: next ? { spotId: next.spotId, npcId: next.npcId, npcName: next.npcName, kind: next.kind, itemId: next.itemId, amount: next.requiredAmount || 1, requiredTotal: next.requiredTotal } : null,
        ...(combine ? { combine } : {})
    };
}

function planFor(state = {}, options = {}) {
    const recovery = options.levelingRecovery || levelingRecoveryFor(state, state.stats?.equipmentPlan, options.timestamp);
    if (recovery) return levelingRecoveryPlan(state, recovery);
    if (ClanCrafting.clanIdFor(state) && !options.clanCrafting && options.recipeId) {
        options = { ...options, recipeId: null };
    }
    const excluded = new Set((options.excludedTargetIds || []).map(Number).filter(Boolean));
    const maxExpectedKills = Number(options.maxExpectedKills);
    let plan;
    for (let attempt = 0; attempt < 8; attempt++) {
        plan = rawPlanFor(state, { ...options, excludedTargetIds: [...excluded] });
        if (withinExpectedKillLimit(plan, maxExpectedKills)) break;
        const targetId = Number(plan?.target?.selfId || 0);
        if (!targetId || excluded.has(targetId)) break;
        excluded.add(targetId);
    }
    if (!withinExpectedKillLimit(plan, maxExpectedKills)) {
        return withRateProfile({
            status: 'blocked',
            reason: 'equipment_effort_limit',
            strategy: 'none',
            target: null,
            recipeId: null,
            materials: [],
            next: null
        });
    }
    return withRateProfile(plan);
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

module.exports = { RATE_MODEL_VERSION, DIRECT_FAILURE_RESOLVE_LIMIT, PARTY_ROUTE_FAILURE_ATTEMPT_LIMIT, gradeForLevel, isCraftService, roleFor, itemScore, isRealCatalogItem, suitable, isSlotUpgrade, combatReadiness, progressionPriceCap, operationalAdenaReserve, equippedSlotsFor, equipInventoryUpgrades, preferredTarget, preferredDropTarget, preferredNoGradeTarget, marketOfferForTarget, marketPlanForTarget, marketRecoveryPlanForTarget, staticNpcUpgradePlan, staticNpcKitAdequate, npcWeaponBridgePlan, itemDropChance, itemDropYield, partyNeedForSource, partyNeedReasonForSource, soloSafeForSource, sourceWithinVoluntaryHuntBand, bestSourceForState, bestSourceForPlan, safeFallbackForPlan, retargetPlanSource, replacementPlanFor, sourceForItem, farmSourceForMaterial, missingMaterials, directPlanFailure, partyRouteFailure, abandonAcquisition, replanContextFor, levelingRecoveryFor, rateProfileSignature, withinExpectedKillLimit, isBotEligibleSourceNpcId, isPlanSourceViableForState, isClanOwnedPlan, equipmentTargetFulfilled, clanGoalPlanLocked, finalizePlan, planFor, shouldFinishPreviousPlan, scoreSpot, sameObjective };
