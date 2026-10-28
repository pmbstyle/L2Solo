const Sources = require('../../Items/ItemAcquisitionCatalog');
const ClanCrafting = require('../../Clan/ClanCraftingPolicy');
const ItemTemplateIndex = require('../../Item/ItemTemplateIndex');
const GameCatalogue = require('../../Knowledge/GameDataCatalogue').native();
const DataCache = invoke('GameServer/DataCache');
const C4RecipeItems = invoke('GameServer/Items/C4RecipeItems');
const C4DualSwordCombinations = invoke('GameServer/Items/C4DualSwordCombinations');
const ProgressionRates = invoke('GameServer/ProgressionRates');
const BotRoles = invoke('GameServer/Bot/AI/BotRoles');
const LevelingRoutes = invoke('GameServer/Bot/AI/LevelingRoutes');
const HuntEfficiency = invoke('GameServer/Bot/AI/BotHuntEfficiency');
const BotEquipmentCompatibility = invoke('GameServer/Bot/AI/BotEquipmentCompatibility');
const BotWeaponCompatibility = invoke('GameServer/Bot/AI/BotWeaponCompatibility');
const { gradeForLevel } = invoke('GameServer/Bot/AI/GearGradeRule');
const CraftShopService = invoke('GameServer/Bot/Economy/CraftShopService');
const CraftSupplementMaterials = invoke('GameServer/Bot/Economy/CraftSupplementMaterials');
// Common materials have hundreds of sources. Retain only their sorted index
// positions per shared input key, rather than a plain source object per row.
// ARCH-NOTE: PERF on 1,000 native states/2,045 spots: retained heap plus
// numeric backing falls 37.80 -> 6.78 MB; all source rows/order/targets match.
// Mean lookup 0.49 -> 0.62 ms. FIFO/key semantics stay intact; per-decision
// sourceCache still shares the plain result until that decision returns.
const MAX_RESOLVED_SOURCE_CACHE = 128;
const MAX_SOURCE_YIELDS = 16384;
// Rows are as long as an item's index records (up to ~3,300 for a material
// every monster drops): the bound counts cells, one per record (9 bytes for
// rules plus 4 for its eligible ordinal) and one per eligible record (4 for
// its level-ordered ordinal): 1 MiB of ordinals in total, plus ~32 bytes per
// distinct target level of a row. One row per item serves every killer level.
const MAX_SOURCE_FACT_RULE_CELLS = 262144;
let sourceIndexCache = { byItemId: null, resolved: new Map(), yields: new Map(),
    plainYields: new Map(), deepYields: new Map(), plainRatesKey: null, huntable: new Map(), factRules: new Map(), factRulesKey: null, factRuleCells: 0 };
const BotGear = invoke('GameServer/Bot/AI/BotGear');
const PurchaseFunding = invoke('GameServer/Bot/Economy/PurchaseFunding');
const GearLifecycle = invoke('GameServer/Bot/AI/GearLifecycle');
const Progression = invoke('GameServer/Bot/AI/PersonalGearProgression');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const OfferOrder = require('../Economy/OfferOrder');
const SpotIndex = require('./SpotIndex');
const SpotEconomics = require('../Economy/SpotEconomics');
const NpcShopBuyLists = invoke('GameServer/World/Generics/NpcShopBuyLists');
const BotRaidSafety = invoke('GameServer/Bot/AI/BotRaidSafety');
const BotHuntingTargetPolicy = invoke('GameServer/Bot/AI/BotHuntingTargetPolicy');
const Diagnostics = require('../Economy/EconomyDiagnostics');
const BotTargetScorer = invoke('GameServer/Bot/AI/BotTargetScorer');
const BotTargetMatchup = invoke('GameServer/Bot/AI/BotTargetMatchup');
const InventorySummary = invoke('GameServer/Bot/Population/InventorySummary');
const SpotRiskPolicy = invoke('GameServer/Bot/Population/SpotRiskPolicy');
const BotHuntingGroundPolicy = invoke('GameServer/Bot/AI/BotHuntingGroundPolicy');

const RANKS = ['none', 'd', 'c', 'b', 'a', 's'];
const { equipmentSlotKey, equipmentReplacementConflict } = BotEquipmentCompatibility;
const ARMOR_SLOTS = new Set([6, 9, 10, 11, 12, 15]);
const JEWEL_SLOTS = new Set([1, 2, 3, 4, 5]);
// Saved plans older than this version are re-planned (BotLifeState, ClanEquipmentPlanner).
// 17: the income model is the bot's measured hour value (BotHuntEfficiency.hourValue).
const RATE_MODEL_VERSION = 17;
const RAID_MIN_ROSTER_LABOR = 7;
const DIRECT_FAILURE_RESOLVE_LIMIT = 8;
const DIRECT_DROP_EXHAUSTION_MULTIPLIER = 3;
const DIRECT_ROUTE_COOLDOWN_MS = 60 * 60 * 1000;
const PARTY_ROUTE_FAILURE_ATTEMPT_LIMIT = 2;
const PAIRED_SLOTS = Object.freeze({ 1: 2, 2: 1, 4: 5, 5: 4 });
const NPC_GEAR_MAX_RANK = 'd';

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
    return Math.max(0, Number(plan?.expectedEffort ?? plan?.expectedKills ?? 0)) <= limit;
}

function catalogItem(selfId) {
    return ItemTemplateIndex.findLast(DataCache.items, selfId, catalogItem) || null;
}

function catalogNpc(selfId) {
    return ItemTemplateIndex.find(DataCache.npcs, selfId) || null;
}

function isRealCatalogItem(item = {}) {
    const selfId = Number(item.selfId || 0);
    // Catalog classification wins over old inventory/worker projections.
    if (item.template?.kind === 'Other.Quest'
        || catalogItem(selfId)?.template?.kind === 'Other.Quest') return false;
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
    if (BotEquipmentCompatibility.isWeaponSlot(slot)) return BotWeaponCompatibility.scoreWeapon(stats.pAtk, stats.mAtk, role, classId);
    if (JEWEL_SLOTS.has(slot)) return Number(stats.mDef || 0);
    return Number(stats.pDef || 0) + Number(item.etc?.mp || 0);
}

function rankIndex(rank) {
    const index = RANKS.indexOf(String(rank || 'none').toLowerCase());
    return index < 0 ? 0 : index;
}

function recoveryWake(state = {}) {
    const weapon = equippedInventoryItems(state.inventory).find(item => BotEquipmentCompatibility.isWeaponSlot(Number(item.etc?.slot)));
    return [Number(state.level || 1), weapon ? rankIndex(weapon.etc?.rank) : -1, state.party?.partyId ? 1 : 0];
}

function recoveryEntryLive(entry, state, timestamp, wake) {
    if (!Array.isArray(entry.wake)) return Number(entry.until || 0) > timestamp;
    const current = wake || recoveryWake(state);
    return entry.wake.length === 3 && entry.wake.every((value, n) => Number(value) === current[n]);
}

// One planner decision judges the same bot against every candidate source
// (partyNeedAssessmentForSource per drop source, per material source), and
// its readiness depends only on the bot. Like ClanRaidPolicy's per-pass
// readiness cache, it is computed once per bot object for the duration of
// one planner decision (see readinessScoped below). Within a
// call the planner changes equipment only on copied states/inventories.
let readinessScope = null;
const MAX_SOURCE_ASSESSMENTS = 128;
const SUPPORT_ROLES = new Set(['healer', 'buffer']);
const SOURCE_ASSESSMENTS = Object.freeze({
    missing_weapon: Object.freeze({ need: 'required', reason: 'missing_weapon' }),
    unprepared_support: Object.freeze({ need: 'required', reason: 'unprepared_support' }),
    underleveled: Object.freeze({ need: 'required', reason: 'underleveled' }),
    tight_level_margin: Object.freeze({ need: 'preferred', reason: 'tight_level_margin' }),
    solo_ready: Object.freeze({ need: 'solo_ok', reason: 'solo_ready' })
});

function readinessRecord(state) {
    if (!readinessScope || !state || typeof state !== 'object') return null;
    let record = readinessScope.get(state);
    if (!record) {
        record = { readiness: computeCombatReadiness(state), assessments: null };
        readinessScope.set(state, record);
    }
    return record;
}

function combatReadiness(state = {}) {
    const record = readinessRecord(state);
    return record ? { ...record.readiness } : computeCombatReadiness(state);
}

function computeCombatReadiness(state = {}) {
    const role = roleFor(state);
    const equipped = equippedInventoryItems(state.inventory);
    const interimClassId = BotEquipmentCompatibility.interimClassIdFor(classIdFor(state));
    const interimState = interimClassId
        ? { ...state, party: null, stats: { ...(state.stats || {}), classId: interimClassId, role: undefined } }
        : null;
    const weapon = equipped.find((item) => BotEquipmentCompatibility.isWeaponSlot(Number(item.etc?.slot || 0))
        && (suitable(item, state, role, item.etc?.rank)
            || (interimState && suitable(item, interimState, roleFor(interimState), item.etc?.rank))));
    const armor = equipped.filter((item) => ARMOR_SLOTS.has(Number(item.etc?.slot || 0))
        && suitable(item,state,role,item.etc?.rank));
    const weaponRank = rankIndex(weapon?.etc?.rank);
    const armorRank = armor.length
        ? armor.reduce((sum, item) => sum + rankIndex(item.etc?.rank), 0) / armor.length
        : 0;
    const baseKit = (weapon ? 0.25 : 0) + Math.min(0.45, armor.length * 0.1);
    const roleAdjustment = role === 'tank' ? 0.45
        : SUPPORT_ROLES.has(role) ? -0.7
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
    if (BotEquipmentCompatibility.isWeaponSlot(slot)) return BotWeaponCompatibility.isSuitableWeapon(
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
    if ([10, 11, 15].includes(slot)) {
        const preferred = BotEquipmentCompatibility.armorKindFor(role, classId);
        // The authored NG kit allows light/heavy fighter bridges before D
        // masteries; native receipt and wish compatibility must agree with it.
        return kind === preferred || rank === 'none' && ['Armor.Chain', 'Armor.Leather'].includes(preferred)
            && ['Armor.Chain', 'Armor.Leather'].includes(kind);
    }
    if ([6, 9, 12].includes(slot)) return kind === 'Armor.Wear';
    return JEWEL_SLOTS.has(slot) && kind === 'Armor.Jewel';
}

// Compatibility and the acquisition ceiling, independent of a desired grade.
// Shared wish targets/recovery can buy a useful lower-grade improvement.
function considerable(item, state = {}, role = roleFor(state), acquisitionRank = Progression.acquisitionRankFor(state)) {
    const rank = String(item?.etc?.rank || 'none').toLowerCase();
    return Sources.hasSource(item?.selfId) && RANKS.includes(rank) && rankIndex(rank) <= rankIndex(acquisitionRank)
        && suitable(item, state, role, rank);
}

// The C preparation lifts the ceiling to its level's grade, as for the wish
// that chose the target; only a target above the plain one pays the assess.
function acquisitionTargetAllowed(state = {}, plan = {}) {
    const target = catalogItem(plan?.combine?.resultId || plan?.target?.selfId);
    if (target && Progression.marketOnly(state, target)
        && (plan.strategy !== 'market' || !(Number(plan.market?.price) > 0)
            || Number(plan.market.price) > PurchaseFunding.budget(state))) return false;
    const rank = rankIndex(target?.etc?.rank);
    return !target || rank <= rankIndex(Progression.acquisitionRankFor(state))
        || rank <= rankIndex(gradeForLevel(Progression.PREPARED_LEVEL)) && Progression.preparing(state);
}

function missingPairedMilestoneSlot(state, item, progression) {
    const slot = Number(item?.etc?.slot || 0);
    if (!progression.required || rankIndex(item.etc?.rank) < (progression.rank || 2) || !PAIRED_SLOTS[slot]) return 0;
    const worn = equippedSlotsFor(state.inventory?.[item.selfId], slot);
    return pairedSlots(slot).find(side => progression.gaps.has(side) && !worn.includes(side)) || 0;
}

// A profession change can leave a sword on a polearm fighter or a dagger on
// an archer. Such a weapon must neither satisfy nor outscore the new kit.
function ownedItemFitsBuild(item, role, classId) {
    if (!isRealCatalogItem(item)) return false;
    // Starter clothes remain a usable no-grade baseline before masteries;
    // graded body armor must match the profession's chosen armor profile.
    if ([10, 11, 15].includes(Number(item.etc?.slot))
        && item.etc?.rank === 'none' && Number(classId) !== 50) return true;
    // A retail starter weapon the class profile does not list (a caster's gloves)
    // is good enough to fight with (combatReadiness), not to keep: the kit buys
    // the class's own weapon first.
    if (BotEquipmentCompatibility.isWeaponSlot(Number(item.etc?.slot || 0))
        && BotEquipmentCompatibility.isStarterWeaponKind(item.template?.kind || '', classId)) return false;
    return suitable(item, { classId }, role, item.etc?.rank);
}

function isSlotUpgrade(item, ownedItems, role, classId) {
    if (!isRealCatalogItem(item)) return false;
    const slot = BotEquipmentCompatibility.isWeaponSlot(Number(item.etc?.slot || 0)) ? 'weapon' : Number(item.etc?.slot || 0);
    const rank = String(item.etc?.rank || 'none').toLowerCase();
    const score = itemScore(item, role, classId);
    const price = Number(item.template?.price || 0);
    // One item per paperdoll slot is enough. Keep a same-grade replacement
    // only when it is genuinely stronger, or equally strong but from a more
    // expensive progression tier.
    return !ownedItems.some((owned) => (
        ownedItemFitsBuild(owned, role, classId)
        && (BotEquipmentCompatibility.isWeaponSlot(Number(owned.etc?.slot || 0)) ? 'weapon' : Number(owned.etc?.slot || 0)) === slot
        && String(owned.etc?.rank || 'none').toLowerCase() === rank
        && (itemScore(owned, role, classId) > score
            || (itemScore(owned, role, classId) === score && Number(owned.template?.price || 0) >= price))
    ));
}

function slotPriority(item) {
    const slot = Number(item?.etc?.slot || 0);
    if (BotEquipmentCompatibility.isWeaponSlot(slot)) return 8;
    if (ARMOR_SLOTS.has(slot)) return 4;
    return JEWEL_SLOTS.has(slot) ? 1 : 0;
}

function currentSlotScore(item, ownedItems = [], role, classId) {
    const slot = BotEquipmentCompatibility.isWeaponSlot(Number(item?.etc?.slot || 0)) ? 'weapon' : Number(item?.etc?.slot || 0);
    return ownedItems
        .filter((owned) => ownedItemFitsBuild(owned, role, classId))
        .filter((owned) => (
            (BotEquipmentCompatibility.isWeaponSlot(Number(owned.etc?.slot || 0)) ? 'weapon' : Number(owned.etc?.slot || 0)) === slot
        ))
        .reduce((best, owned) => Math.max(best, itemScore(owned, role, classId)), 0);
}

function candidateEffort(candidate, state, options = {}) {
    const item = candidate?.item;
    if (!item) return Infinity;
    const spots = options.spots || [];
    const offer = marketOfferForTarget(item, state, options);
    const marketEffortValue = offer
        ? (PurchaseFunding.spendable(state, options.buyOrderEscrow, { upperBound: true }) >= Number(offer.price || 0)
            ? 4
            : marketEffort(offer, state))
        : Infinity;
    // A few callers only ask for a deterministic preferred item (tests,
    // diagnostics and a pre-route preview). Do not scan every NPC reward and
    // every component tree when no spot atlas is available.
    if (!spots.length) return marketEffortValue;
    const direct = bestSourceForState(sourceForItem(item.selfId, spots, state, options), state, options);
    const directEffort = direct ? sourceEffort(direct, state, options) : Infinity;
    if (!candidate.recipe) return Math.min(directEffort, marketEffortValue);

    // Price NPC-bought blacksmith inputs before filtering out recipes whose
    // drop sources have become too low-level for the buyer.
    const blades = combinationPurchase(candidate.recipe, state, options);
    const bladeEffort = blades
        ? 8 + (blades.cost <= PurchaseFunding.spendable(state, options.buyOrderEscrow, { upperBound: true })
            ? 4 : blades.cost / expectedAdenaPerKill(state))
        : Infinity;

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
    return Math.min(directEffort, marketEffortValue, bladeEffort, missingRoute ? Infinity : materialEffort);
}

function shortlistCandidates(candidates = [], options = {}) {
    if (options.recipeId) return candidates;
    const offset = Math.max(0, Math.floor(Number(options.shortlistOffset || 0)));
    const bySlot = candidates.reduce((groups, candidate) => {
        const slot = BotEquipmentCompatibility.isWeaponSlot(Number(candidate.item.etc?.slot || 0))
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

function equipmentCandidate(item, state, role = roleFor(state)) {
    return !!item && rankIndex(item.etc?.rank) <= rankIndex(gradeForLevel(state.level))
        && suitable(item, state, role, item.etc?.rank);
}
function equipmentItemBetter(item, current, role, classId) {
    return !current || itemScore(item, role, classId) > itemScore(current, role, classId)
        || itemScore(item, role, classId) === itemScore(current, role, classId)
            && Number(item.template?.price || 0) < Number(current.template?.price || 0);
}

function equipInventoryUpgrades(state = {}, inventory = {}) {
    const role = roleFor(state);
    const classId = classIdFor(state);
    const candidates = Object.values(inventory || {}).flatMap((entry) => {
        if (Number(entry?.amount || 0) < 1) return [];
        const item = ItemTemplateIndex.find(DataCache.items, entry.selfId);
        return equipmentCandidate(item, state, role) ? [{ entry, item }] : [];
    });
    const pairGroup = (item) => {
        const slot = Number(item.etc?.slot || 0);
        return [1, 2].includes(slot) ? 'ears' : [4, 5].includes(slot) ? 'rings' : null;
    };
    const ordinaryCandidates = candidates.filter(({ item }) => !pairGroup(item));
    const best = ordinaryCandidates.reduce((selected, candidate) => {
        const key = equipmentSlotKey(candidate.item.etc?.slot);
        const current = selected.get(key);
        if (equipmentItemBetter(candidate.item, current?.item, role, classId)) {
            selected.set(key, candidate);
        }
        return selected;
    }, new Map());
    if (!best.has('weapon')) {
        // Legacy starter saves can have both a spare sword and training fists
        // worn before the bot owns its preferred weapon. Resolve the conflict
        // without stripping its last usable weapon or equipping new off-build gear.
        const worn = Object.values(inventory || {}).flatMap((entry) => {
            const item = ItemTemplateIndex.find(DataCache.items, entry.selfId);
            return String(item?.template?.kind || '').startsWith('Weapon.')
                && equippedSlotsFor(entry, item.etc?.slot).some(slot => slot === 7 || slot === 14)
                ? [{ entry, item }] : [];
        });
        if (worn.length > 1) {
            const starters = require('../../Knowledge/StarterItemCatalog').ids(DataCache.newbieItems, 'strict', classId);
            worn.sort((left, right) => Number(starters.has(Number(right.entry.selfId)))
                - Number(starters.has(Number(left.entry.selfId)))
                || itemScore(right.item, role, classId) - itemScore(left.item, role, classId)
                || Number(left.entry.selfId) - Number(right.entry.selfId));
            best.set('weapon', worn[0]);
        }
    }
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
    best.forEach(({ entry, item }) => {
        const slot = Number(item.etc?.slot || 0);
        Object.values(next).forEach((owned) => {
            const ownedItem = ItemTemplateIndex.find(DataCache.items, owned.selfId);
            const ownedSlot = Number(ownedItem?.etc?.slot || owned.slot || 0);
            if (equipmentReplacementConflict(slot, ownedSlot)
                && Number(owned.selfId) !== Number(entry.selfId)) setUnequipped(owned);
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
    const progression = Progression.acquisitionAssessment(state);
    const missingDualSword = missingRequiredDualSword(state, role, classId);
    const owned = inventoryMap(state.inventory);
    const ownedItems = inventoryItems(state.inventory);
    const craftRecipes = options.craftRecipes
        ? options.craftRecipes.filter((recipe) => recipe.type === 'dwarven' && Sources.allowsRecipe(recipe))
        : CraftShopService.publishedStationRecipes().recipes;
    // Origin admission sees the canonical recipe. A real clan provider's
    // learning scroll is the existing material cost, added only afterwards.
    const canonicalRecipes = [...craftRecipes, ...C4DualSwordCombinations.loadRecipes()].filter(recipe => Sources.allowsRecipe(recipe));
    const learningRecipe = recipe => require('../../Clan/ClanCraftingPolicy').recipeForProvider(recipe, options.craftProviders?.[recipe.recipeId]);
    const recipes = canonicalRecipes.map(learningRecipe);
    const recipeRank = options.recipeId
        ? String(ItemTemplateIndex.findRequired(DataCache.items || [], recipes.find((recipe) => Number(recipe.recipeId) === Number(options.recipeId))?.productId)?.etc?.rank || '')
        : null;
    const recipesByProduct = new Map(recipes.map((recipe) => [Number(recipe.productId), recipe]));
    const excluded = excludedTargetIds(options);
    if (!options.recipeId && !options.wishTargetId && progression.required && progression.rank === 3
        && rankIndex(gradeForLevel(state.level)) >= 4) {
        const ready = BotGear.currentRankRows(DataCache.items, gradeForLevel(state.level))
            .filter(item => !excluded.has(Number(item.selfId)) && suitable(item, state, role, gradeForLevel(state.level))
                && Progression.priority(item, Number(item.etc?.slot), progression) > 0
                && isSlotUpgrade(item, ownedItems, role, classId))
            .map(item => ({ item, offer: marketOfferForTarget(item, state,
                { ...options, maxMarketPrice: PurchaseFunding.budget(state) }) }))
            .filter(row => row.offer && Number(row.offer.price) <= PurchaseFunding.budget(state))
            .sort((left, right) => Number(left.offer.price) - Number(right.offer.price));
        if (ready.length) return { item: ready[0].item, slot: Number(ready[0].item.etc?.slot), recipe: null };
    }
    const excludedMaterials = new Set((options.excludedMaterialIds || []).map(Number));
    const acquisitionState = options.wishTargetId ? Progression.preparation(state, progression) || state : state;
    const selectedItem = options.wishTargetId && catalogItem(options.wishTargetId);
    const readyHigher = selectedItem && Progression.marketOnly(state, selectedItem, progression)
        && marketOfferForTarget(selectedItem, state, { ...options, maxMarketPrice: PurchaseFunding.budget(state) });
    const acquisitionRank = readyHigher ? gradeForLevel(state.level)
        : Progression.acquisitionRankFor(acquisitionState, acquisitionState === state ? progression : undefined);
    const closesC = progression.required && rankIndex(gradeForLevel(state.level)) > rankIndex('c');
    const targetSlotFor = item => Number(options.wishSlot || missingPairedMilestoneSlot(state, item, progression) || item.etc?.slot || 0);
    const allCandidates = (options.wishTargetId ? [catalogItem(options.wishTargetId)].filter(Boolean) : BotGear.currentRankRows(DataCache.items, recipeRank || acquisitionRank))
        .filter(item => Sources.hasSource(item.selfId))
        .filter((item) => rankIndex(item.etc?.rank) <= rankIndex(acquisitionRank))
        .filter((item) => options.wishTargetId ? considerable(item, acquisitionState, role, acquisitionRank)
            : suitable(item, state, role, recipeRank || acquisitionRank))
        .filter((item) => !closesC || Progression.priority(item, targetSlotFor(item), progression) > 0)
        .filter((item) => !excluded.has(Number(item.selfId)))
        .filter(item => !options.wishTargetId || Number(item.selfId) === Number(options.wishTargetId))
        .map((item) => ({ item, slot: targetSlotFor(item), recipe: Progression.marketOnly(state, item, progression)
            ? null : recipesByProduct.get(Number(item.selfId)) || null }))
        .filter(({ item, recipe }) => !recipeNeedsExcludedMaterial(recipe, state, excludedMaterials)
            || !!marketOfferForTarget(item, state, options))
        .filter(({ recipe }) => !options.recipeId || Number(recipe?.recipeId) === Number(options.recipeId))
        .filter(({ item }) => Number(owned.get(Number(item.selfId)) || 0) < 1
            || missingPairedMilestoneSlot(state, item, progression)
            || options.wishTargetId && PAIRED_SLOTS[options.wishSlot]
                && !equippedSlotsFor(state.inventory?.[item.selfId], item.etc?.slot).includes(Number(options.wishSlot)))
        .filter(({ item }) => options.wishTargetId && PAIRED_SLOTS[options.wishSlot]
            || missingPairedMilestoneSlot(state, item, progression)
            || (missingDualSword && item.template?.kind === 'Weapon.Dual')
            || isSlotUpgrade(item, ownedItems, role, classId));
    const requiredRank = recipeRank || acquisitionRank;
    const hasCurrentGradeWeapon = ownedItems.some((item) => (
        BotEquipmentCompatibility.isWeaponSlot(Number(item.etc?.slot || 0))
        && ownedItemFitsBuild(item, role, classId)
        && rankIndex(item.etc?.rank) >= rankIndex(requiredRank)
    ));
    // A viable weapon is the first milestone of a new grade. Once it is
    // covered, fill the rest of the kit before considering another weapon of
    // the same grade.
    const weaponFirst = !hasCurrentGradeWeapon || missingDualSword
        ? allCandidates.filter(({ item }) => BotEquipmentCompatibility.isWeaponSlot(Number(item.etc?.slot || 0)))
        : allCandidates.filter(({ item }) => !BotEquipmentCompatibility.isWeaponSlot(Number(item.etc?.slot || 0)));
    // A clan already pays for the whole admitted roster. Let attainable slot
    // upgrades compete on their gain and cost instead of hiding armour behind
    // a weapon whose only source the clan cannot yet fight.
    const progressionCandidates = options.wishTargetId || options.clanCrafting
        ? allCandidates : weaponFirst.length ? weaponFirst : allCandidates;
    const cap = progressionPriceCap(requiredRank, state.level);
    const affordable = progressionCandidates.filter(({ item }) => options.wishTargetId || Number(item.template?.price || 0) <= cap);
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
    // The spot atlas, not the crowd, marks live planning: every live planner
    // passes it, and the crowd is met at arrival (ARCH-08-b). Deviation from
    // the task text ("first candidate, first safe source"): the live-route
    // filter stays, keyed on the atlas, because it is no crowd read: it keeps
    // a goal without any reachable route from becoming a durable blocked goal.
    const liveAvailability = (options.spots || []).length > 0;
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
    const candidates = BotGear.currentRankRows(DataCache.items, 'none')
        .filter((item) => Sources.hasSource(item.selfId) && suitable(item, state, role, 'none'))
        .filter((item) => !excluded.has(Number(item.selfId)))
        .filter((item) => Number(owned.get(Number(item.selfId)) || 0) < 1)
        .sort((a, b) => itemScore(b, role, classId) - itemScore(a, role, classId) || Number(b.template?.price || 0) - Number(a.template?.price || 0));
    // Live-route filter keyed on the atlas, not the crowd: see preferredTarget.
    if (!(options.spots || []).length) return candidates[0] || null;
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
        .filter(item => Sources.hasSource(item.selfId))
        .filter((item) => !excluded.has(Number(item.selfId)))
        .filter((item) => {
            if (uniqueItems.has(Number(item.selfId))) return false;
            uniqueItems.add(Number(item.selfId));
            return isSlotUpgrade(item, ownedItems, role, classId);
        })
        .sort((a, b) => GearLifecycle.slotPriority(b.etc?.slot) - GearLifecycle.slotPriority(a.etc?.slot)
            || Number(a.template?.price || 0) - Number(b.template?.price || 0));
    // Live-route filter keyed on the atlas, not the crowd: see preferredTarget.
    if (!(options.spots || []).length) return candidates[0] || null;
    return candidates.find((item) => targetHasAvailableRoute(item, state, options)) || null;
}

// Where the bot buys from: a caller that has no spot list passes the origin
// it computed from its own (OfferOrder.farmingOrigin).
function offerOrigin(state, options) {
    return options.origin || OfferOrder.farmingOrigin(state, (spotId) => SpotIndex.spotById(options.spots, spotId));
}

// The buyer's trip cost to each town (OfferOrder.tripCost) from where it buys.
function offerTripCost(state, options) {
    return OfferOrder.tripCost(state, { origin: offerOrigin(state, options) });
}

function marketOfferForTarget(target, state = {}, options = {}) {
    if (!target) return null;
    const maxPrice = options.maxMarketPrice === undefined ? Infinity : Math.max(0, Number(options.maxMarketPrice) || 0);
    const usable = (offer) => offer && offer.available !== false
        && Number(offer.count ?? 1) > 0 && Number(offer.price) > 0 && Number(offer.price) <= maxPrice;
    const origin = offerOrigin(state, options);
    if (typeof options.findMarketOffer === 'function') {
        const offer = options.findMarketOffer(target, state, origin);
        return usable(offer) ? offer : null;
    }
    const towns = [...new Set([
        state.currentRegion,
        ...Object.keys(MarketOpportunity.TOWN_NPC_SELLERS || {}),
        'Giran'
    ].filter(Boolean))];
    return MarketOpportunity.bestOffer(target.selfId, {
        towns,
        budget: maxPrice,
        buyerCharacterId: state.characterId,
        cost: offerTripCost(state, options),
        accept: usable
    });
}

// What one kill earns the bot: its measured hour value per kill. Table hunt
// by design: the money packet is positional with a checked length
// (Database.js) and carries no per-kill value.
function expectedAdenaPerKill(state = {}) {
    return HuntEfficiency.hourValue(state).perKill;
}

function marketEffort(offer, state) {
    return offer ? Number(offer.price || Infinity) / expectedAdenaPerKill(state) : Infinity;
}

// Callers pass the bot's own buy-order escrow as options.buyOrderEscrow: the
// worker cannot see AFK shops, so the main thread hands it over.
const operationalAdenaReserve = PurchaseFunding.operatingReserve;

// Where, at what price and from whom a plan buys, and the reserve it keeps:
// every purchase keeps the operating reserve, whoever sells the item.
function marketTerms(state, offer, options = {}) {
    return {
        town: offer.town || 'Giran',
        price: Number(offer.price),
        sourceType: offer.sourceType,
        reserve: options.reserve === undefined
            ? operationalAdenaReserve(state, options.buyOrderEscrow)
            : Number(options.reserve || 0)
    };
}

function marketPlan(state = {}, target, offer, options = {}) {
    const role = roleFor(state);
    const targetSlot = Number(options.targetSlot || target.etc?.slot || 0);
    return {
        status: 'active',
        phase: GearLifecycle.phaseFor(state),
        grade: Progression.acquisitionRankFor(state),
        role,
        strategy: 'market',
        soloSafe: true,
        partyNeed: 'solo_ok',
        partyNeedReason: options.reason || 'market_fallback',
        requiresParty: false,
        rateModelVersion: RATE_MODEL_VERSION,
        expectedKills: Math.ceil(marketEffort(offer, state)),
        target: { selfId: Number(target.selfId), name: target.template?.name || `Item ${target.selfId}`, slot: targetSlot },
        market: marketTerms(state, offer, options),
        recipeId: null,
        materials: [],
        next: null
    };
}

function npcOfferForTarget(target, state = {}, options = {}) {
    if (!target) return null;
    const origin = offerOrigin(state, options);
    if (typeof options.findNpcOffer === 'function') {
        const offer = options.findNpcOffer(target, state, origin);
        return offer?.sourceType === 'npc' ? offer : null;
    }
    if (typeof options.findMarketOffer === 'function') {
        const offer = options.findMarketOffer(target, state, origin);
        return offer?.sourceType === 'npc' ? offer : null;
    }
    return OfferOrder.best(MarketOpportunity.npcOffersAll(target.selfId) || [], { cost: offerTripCost(state, options) });
}

function staticNpcItems(options = {}) {
    if (typeof options.findMarketOffer === 'function') return DataCache.items || [];
    return BotGear.currentNpcRows(DataCache.items, NpcShopBuyLists);
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

function equippedItemAtSlot(state = {}, slot) {
    const wanted = Number(slot || 0);
    return equippedInventoryItems(state.inventory).find((item) => (
        ownedItemFitsBuild(item, roleFor(state), classIdFor(state)) && (BotEquipmentCompatibility.isWeaponSlot(wanted)
            ? BotEquipmentCompatibility.isWeaponSlot(Number(item.etc?.slot || 0))
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
    return BotGear.currentSlotRows(staticNpcItems(options), Number(desiredSlot || 0), true)
        .filter((item) => !excluded.has(Number(item.selfId)))
        .filter((item) => Number(state.inventory?.[String(item.selfId)]?.amount || 0) < 1)
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

// What a bot may spend on NPC gear: its purchase budget (wallet plus its own
// buy-order escrow) above the operating reserve.
function npcPurchaseBudget(state = {}, options = {}) {
    // ARCH-NOTE: a missing usable weapon is survival; its bridge may spend the whole wallet.
    const reserveOptions = { upperBound: true };
    return { reserve: options.weaponBridge ? 0 : operationalAdenaReserve(state),
        spendable: options.weaponBridge ? PurchaseFunding.budget(state, options.buyOrderEscrow)
            : PurchaseFunding.spendable(state, options.buyOrderEscrow, reserveOptions) };
}

function staticNpcUpgradePlan(state = {}, options = {}) {
    if (!GearLifecycle.isGearFocusActive(state)) return null;
    const targetRank = npcTargetRank(state);
    const { reserve, spendable } = npcPurchaseBudget(state, options);
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
    let saving = null;
    for (const slot of slots) {
        const current = equippedItemAtSlot(state, slot);
        if (current && rankIndex(current.etc?.rank) >= rankIndex(targetRank)
            && !(requiredDual && slot === 14)) continue;
        const candidate = npcCandidatesForSlot(state, slot, targetRank, options)[0];
        if (!candidate && requiredDual && slot === 14) {
            // NPCs sell no dual swords: the dual-sword bridge combines two
            // blades. It is this class's kit weapon under the same rule.
            const dual = dualSwordBridgePlan(state, options);
            if (!dual) continue;
            if (dualSwordFunded(dual, state, options)) return dual;
            saving = saving || dual;
            continue;
        }
        if (!candidate) continue;
        const purchase = { ...candidate, slot };
        if (Number(candidate.offer.price) <= spendable) return planForCandidate(purchase);
        saving = saving || planForCandidate(purchase);
    }
    if (saving) return saving;

    // Within no-grade/D, spare money can improve an already complete kit.
    // At C+ an adequate D kit is only a bridge; crafting/drop/exchange
    // progression must take over instead of polishing D indefinitely.
    if (rankIndex(gradeForLevel(state.level)) > rankIndex('d')) return null;
    const role = roleFor(state);
    const starterWeapon = BotGear.planFor({ classId, level: 1 }).items
        .find((item) => BotEquipmentCompatibility.isWeaponSlot(Number(item.slot)));
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
// The weapon comes before armour here, and is chosen by the same rule as the
// dual-sword bridge, so an unaffordable kit weapon cannot keep the bot unarmed.
function npcWeaponBridgePlan(state = {}, options = {}) {
    const armed = combatReadiness(state).hasWeapon
        || combatReadiness({ ...state, inventory: equipInventoryUpgrades(state, state.inventory || {}) }).hasWeapon;
    if (missingRequiredDualSword(state)) {
        // An interim weapon leaves an unfunded dual sword in the kit order
        // instead of a bridge that would hold back every other purchase.
        const dual = dualSwordBridgePlan(state, options);
        return dual && (!armed || dualSwordFunded(dual, state, options)) ? dual : null;
    }
    if (armed || !GearLifecycle.isGearFocusActive(state)) return null;
    const slot = desiredNpcSlots(state).find((entry) => BotEquipmentCompatibility.isWeaponSlot(entry));
    if (!slot) return null;
    const role = roleFor(state);
    const classId = classIdFor(state);
    const targetRank = npcTargetRank(state);
    const candidates = npcCandidatesForSlot(state, slot, targetRank, options)
        .map((candidate) => ({ ...candidate, cost: Number(candidate.offer.price) }))
        .sort((left, right) => left.cost - right.cost
            || itemScore(right.item, role, classId) - itemScore(left.item, role, classId));
    // The bridge weapon keeps no level reserve (PurchaseFunding.operatingReserve).
    const { reserve, spendable } = npcPurchaseBudget(state, { ...options, weaponBridge: true });
    const choice = chooseBridge(candidates, spendable, rankIndex(targetRank));
    if (!choice) return null;
    return { ...marketPlan(state, choice.item, choice.offer, { targetSlot: slot, reason: 'npc_progression', reserve }),
        weaponBridge: true, partyNeedReason: 'weapon_bridge' };
}

// Funded = the bot can pay for every blade the combination still needs.
function dualSwordFunded(plan, state, options = {}) {
    return Number(plan.bridgeCost || 0) <= npcPurchaseBudget(state, options).spendable;
}

// Bridge choice over candidates sorted by cost: keep the bridge already
// started, else the cheapest affordable at the bridge grade, else the cheapest
// affordable, else the cheapest one to save for.
function chooseBridge(candidates, spendable, bridgeRank, keepId = 0) {
    return candidates.find((entry) => keepId && Number(entry.item.selfId) === keepId)
        || candidates.find((entry) => rankIndex(entry.item.etc?.rank) >= bridgeRank && entry.cost <= spendable)
        || candidates.find((entry) => entry.cost <= spendable)
        || candidates[0]
        || null;
}

function npcEquipmentBridgePlan(state = {}, options = {}) {
    const weapon = npcWeaponBridgePlan(state, options);
    if (weapon) return weapon;
    const role = roleFor(state);
    const incompatibleBody = equippedInventoryItems(state.inventory).some(item => (
        [10, 11, 15].includes(Number(item.etc?.slot))
        && !ownedItemFitsBuild(item, role, classIdFor(state))
    ));
    if (!incompatibleBody) return null;
    const plan = staticNpcUpgradePlan(state, options);
    return plan && [10, 11, 15].includes(Number(plan.target?.slot))
        ? { ...plan, equipmentBridge: true, partyNeedReason: 'class_armor_bridge' } : null;
}

// Why a party member leaves its party to fix its kit: it has no usable
// weapon, or it wears body armour of the wrong class and can pay for the
// NPC replacement now.
function equipmentBridgeReason(state = {}, options = {}) {
    const plan = npcEquipmentBridgePlan(state, options);
    if (plan?.weaponBridge) return 'weapon_bridge';
    return plan?.equipmentBridge
        && Number(plan.market?.price) <= PurchaseFunding.spendable(state, options.buyOrderEscrow, { itemId: plan.target?.selfId })
        ? 'class_armor_bridge' : null;
}

function marketPlanForTarget(state = {}, targetId, options = {}) {
    const target = ItemTemplateIndex.find(DataCache.items, targetId);
    const role = roleFor(state);
    const ownedItems = inventoryItems(state.inventory);
    const acquisitionState = Progression.preparation(state) || state;
    if (!target || !considerable(target, acquisitionState, role)) return null;
    const pairedSlot = missingPairedMilestoneSlot(state, target, Progression.acquisitionAssessment(state));
    if (!pairedSlot && !isSlotUpgrade(target, ownedItems, role, classIdFor(state))) return null;
    const offer = marketOfferForTarget(target, state, options);
    return offer ? marketPlan(state, target, offer, { buyOrderEscrow: options.buyOrderEscrow, targetSlot: pairedSlot }) : null;
}

function fundedMarketPlanForTarget(state = {}, targetId, options = {}) {
    const market = marketPlanForTarget(state, targetId, options);
    return market && Number(market.market.price) > 0
        && Number(market.market.price) <= PurchaseFunding.spendable(state, options.buyOrderEscrow, { itemId: market.target?.selfId })
        ? market : null;
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
    if (!considerable(failedTarget, state, role)
        || !isSlotUpgrade(failedTarget, ownedItems, role, classId)) return null;
    const failedSlot = BotEquipmentCompatibility.isWeaponSlot(Number(failedTarget.etc?.slot || 0))
        ? 'weapon'
        : Number(failedTarget.etc?.slot || 0);
    const excluded = excludedTargetIds(options);
    const cap = progressionPriceCap(gradeForLevel(state.level), state.level);
    const alternatives = BotGear.currentSlotRows(DataCache.items, failedSlot)
        .filter((item) => Number(item.selfId) !== Number(targetId))
        .filter((item) => !excluded.has(Number(item.selfId)))
        .filter((item) => considerable(item, state, role))
        .filter((item) => isSlotUpgrade(item, ownedItems, role, classId))
        .filter((item) => Number(item.template?.price || 0) <= cap)
        .map((item) => ({ item, offer: marketOfferForTarget(item, state, options) }))
        .filter((candidate) => candidate.offer)
        .sort((left, right) => Number(left.offer.price) - Number(right.offer.price)
            || itemScore(right.item, role, classId) - itemScore(left.item, role, classId));
    return alternatives[0]
        ? marketPlan(state, alternatives[0].item, alternatives[0].offer, { buyOrderEscrow: options.buyOrderEscrow })
        : null;
}

function targetCombatCounter(state = {}, npcId) {
    // Population totals count a shared party encounter only on its telemetry
    // owner; the bot's own counter of its current target covers every member.
    const telemetry = state.stats?.targetCombat || {};
    const counter = Number(telemetry.targetNpcId || 0) === Number(npcId)
        ? telemetry
        : telemetry.populationTargets?.[String(Number(npcId))] || {};
    return {
        npcId: Number(npcId || 0),
        resolves: Number(counter.resolves || 0),
        targetKills: Number(counter.targetKills || 0)
    };
}

// A party member's own counter restarts from the population totals when its
// target changes, and those totals grow only on the telemetry owner. A counter
// below the plan's baseline therefore restarted: its progress since the
// baseline is unknown, so the route is judged again from a new baseline.
function counterRestarted(counter = {}, baseline = {}) {
    return Number(counter.resolves || 0) < Number(baseline.resolves || 0)
        || Number(counter.targetKills || 0) < Number(baseline.targetKills || 0);
}

function isClanOwnedPlan(plan = {}) {
    return Number(plan?.clanGoal?.clanId || 0) > 0
        && String(plan?.clanGoal?.goalKey || '').trim() !== '';
}

function equipmentTargetFulfilled(state = {}, plan = {}) {
    const targetId = Number(plan?.target?.selfId || 0);
    if (plan?.combine?.resultId && Number(plan.combine.resultId) !== targetId) return false;
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
        && acquisitionTargetAllowed(state, plan)
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

function isPlanSourceEligible(plan = {}) {
    const npcId = Number(plan?.next?.npcId || 0);
    if (!npcId) return true;
    if (isBotEligibleSourceNpcId(npcId)) return true;
    const npc = catalogNpc(npcId);
    return isClanOwnedPlan(plan)
        && plan?.next?.sourceKind === 'raid'
        && BotRaidSafety.isRaidBoss(npc)
        && Number(plan.next.raidBossTemplateId || npcId) === npcId;
}

function sourceWithinVoluntaryHuntBand(state = {}, source = {}) {
    if (source?.sourceKind === 'raid' || source?.raidBoss === true) return true;
    const botLevel = Number(state.level || 0);
    const sourceLevel = Number(source.npcLevel || source.spotLevel || 0);
    if (!botLevel || !sourceLevel) return true;
    const economic = state.economicLower || invoke('GameServer/Bot/Economy/EquipmentIncomeRoute').economicHunt(state);
    return sourceLevel - botLevel >= sourceMinLevelGap(economic);
}

// The lowest npc-minus-bot level gap a bot hunts voluntarily: an equipment
// earning route admits fifteen levels below, an ordinary hunt the scorer's.
function sourceMinLevelGap(economicLower) {
    return economicLower ? -15 : BotTargetScorer.MIN_LEVEL_GAP;
}

function isPlanSourceViableForState(state = {}, plan = {}) {
    if (!isPlanSourceEligible(plan)) return false;
    if (plan?.next?.sourceKind === 'raid' || plan?.next?.raidBoss === true) return true;
    const npcId = Number(plan?.next?.npcId || 0);
    if (!npcId) return true;
    const npc = catalogNpc(npcId);
    return sourceWithinVoluntaryHuntBand(state, {
        npcLevel: Number(npc?.template?.level || npc?.level || 0)
    });
}

function directPlanFailure(state = {}, plan = {}, timestamp = Date.now()) {
    if (plan?.status !== 'active' || plan.strategy !== 'direct_drop') return null;
    if (isClanOwnedPlan(plan) && plan?.next?.sourceKind === 'raid') return null;
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
    // The finalize pass of the same review stamps the new baseline.
    if (counterRestarted(current, baseline)) return null;
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
    const wake = recoveryWake(state);
    const recoveryTargets = (plan.recoveryTargets || []).filter((entry) => (
        recoveryEntryLive(entry, state, timestamp, wake)
            && (Array.isArray(entry.wake) || Number(entry.targetId) !== Number(plan.target.selfId))
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
    const currentGrade = Progression.acquisitionRankFor(state);
    const currentLevel = Number(state.level || 1);
    const sameGrade = previousPlan?.grade === currentGrade;
    const levelingRecovery = levelingRecoveryFor(state, previousPlan, timestamp);
    const sourceNpcId = Number(previousPlan?.next?.npcId || 0);
    const sourceAllowed = !sourceNpcId || isPlanSourceEligible(previousPlan);
    const sourceViable = !sourceNpcId || isPlanSourceViableForState(state, previousPlan);
    const modelCurrent = Number(previousPlan?.rateModelVersion || 0) >= RATE_MODEL_VERSION
        && String(previousPlan?.rateProfileSignature || '') === rateProfileSignature();
    const wake = recoveryWake(state);
    const recoveryTargets = (previousPlan?.recoveryTargets || [])
        .filter((entry) => recoveryEntryLive(entry, state, timestamp, wake) && Number(entry.targetId || 0) > 0);
    // A retained route can fail on either side of a grade threshold. Keep
    // its failure and cooldown until expiry, even after another level-up.
    // ARCH-NOTE: the old active plan may survive a replan; replaying its
    // recorded failure immediately recreates dormancy on a wake event. Wait
    // for the new plan to stamp its baseline before judging that route again.
    const recordedFailure = (previousPlan?.recoveryTargets || []).some(entry => Array.isArray(entry.wake)
        && entry.reason === 'combat_unviable' && Number(entry.targetId) === Number(previousPlan?.target?.selfId));
    const failure = (!recordedFailure && directPlanFailure(state, previousPlan, timestamp))
            || partyRouteFailure(state, previousPlan, timestamp)
            || craftPlanFailure(state, previousPlan, timestamp);
    if (failure) {
        const recovery = {
            targetId: failure.targetId,
            npcId: failure.npcId,
            itemId: failure.itemId,
            reason: failure.reason,
            failedAt: timestamp,
            // ARCH-NOTE: dormantWishes does not exclude a gear target yet;
            // keep its numeric wake inputs in the planner's recovery list (max4).
            ...(failure.reason === 'combat_unviable' ? { wake }
                : { until: timestamp + (failure.itemId ? acquisitionCooldown(state) : DIRECT_ROUTE_COOLDOWN_MS) })
        };
        const index = recoveryTargets.findIndex((entry) => Number(entry.targetId) === failure.targetId);
        if (index >= 0) recoveryTargets[index] = recovery;
        else recoveryTargets.push(recovery);
    }
    const dormant = recoveryTargets.filter(entry => entry.reason === 'combat_unviable' && Array.isArray(entry.wake))
        .sort((a, b) => Number(b.failedAt) - Number(a.failedAt));
    const dropped = new Set(dormant.slice(4));
    for (let n = recoveryTargets.length - 1; n >= 0; n--) if (dropped.has(recoveryTargets[n])) recoveryTargets.splice(n, 1);
    const currentMarketRecovery = previousPlan?.strategy === 'market'
        ? recoveryTargets.find((entry) => Number(entry.targetId) === Number(previousPlan.target?.selfId || 0))
        : null;
    const targetSupported = (!previousPlan?.target?.selfId || Sources.hasSource(previousPlan.target.selfId))
        && (!previousPlan?.recipeId || Sources.allowsRecipe(previousPlan.recipeId));
    const acquisitionAllowed = acquisitionTargetAllowed(state, previousPlan);
    const targetAllowed = targetSupported && acquisitionAllowed;
    return {
        levelingRecovery,
        planCurrent: targetAllowed && !levelingRecovery && Boolean(previousPlan)
            && sameGrade
            && Number(previousPlan.plannedForLevel || 0) === currentLevel,
        routeCurrent: targetAllowed && !levelingRecovery && Boolean(previousPlan)
            && sameGrade
            && sourceAllowed
            && sourceViable
            && modelCurrent
            && Number(previousPlan.plannedForLevel || 0) === currentLevel,
        invalidSource: !targetSupported
            ? { reason: 'unsupported_item_source' }
            : !sourceAllowed
            ? { npcId: sourceNpcId, reason: 'protected_raid_source' }
            : !acquisitionAllowed
            ? { reason: 'c_kit_incomplete' }
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
    const currentCounter = rawPlan?.status === 'active' && rawPlan.strategy === 'direct_drop'
        ? targetCombatCounter(state, rawPlan.next?.npcId)
        : null;
    const wokeDirectTarget = currentCounter && (previousPlan?.recoveryTargets || []).some(entry =>
        entry.reason === 'combat_unviable' && Array.isArray(entry.wake)
        && Number(entry.targetId) === Number(rawPlan.target?.selfId)
        && !recoveryEntryLive(entry, state, timestamp));
    const targetProgress = currentCounter
        ? (sameDirectTarget && previousPlan.targetProgress
            && !wokeDirectTarget
            && !counterRestarted(currentCounter, previousPlan.targetProgress)
            ? previousPlan.targetProgress
            : currentCounter)
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

// The equipment plan's own leveling-recovery window (not a spot mark): one
// hour, the value it shared with the former spot death mark.
const LEVELING_RECOVERY_MS = 60 * 60 * 1000;
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
    const acquisitionLevel = Progression.preparing(state) ? Progression.PREPARED_LEVEL : level;
    const gradeRegression = rankIndex(plan.grade) > rankIndex(gradeForLevel(acquisitionLevel))
        && Number(death?.expLost || 0) > 0
        && Number(death?.penaltyAppliedAt || 0) >= Number(plan.startedAt || 0);
    const pressure = SpotRiskPolicy.deathPressure(state, plan.next?.spotId);
    const deleveled = level < baselineLevel || gradeRegression;
    if (!deleveled && !pressure) return null;
    return {
        reason: deleveled ? 'level_regression' : pressure.reason || 'death_pressure',
        startedAt: timestamp,
        until: timestamp + LEVELING_RECOVERY_MS,
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
            .reduce((itemSum, item) => itemSum + ProgressionRates.spoilItemChance(item), 0);
        const averageAmount = (group.items || [])
            .filter((item) => Number(item.selfId) === Number(itemId))
            .reduce((itemSum, item) => itemSum + ProgressionRates.spoilItemChance(item) * ((Number(item.min || 1) + Number(item.max || item.min || 1)) / 2), 0);
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

function sourceEffort(source = {}, state = {}, options = {}) {
    const attempts = 1 / Math.max(Number(source.expectedYield || 0), 0.000001);
    if (source?.sourceKind === 'raid' || source?.raidBoss === true) {
        // A boss attempt occupies a complete clan roster. Compare that lost
        // farming time with solo/craft/market routes instead of treating the
        // raid as one slightly harder monster for one beneficiary.
        const rosterLabor = Math.max(
            RAID_MIN_ROSTER_LABOR,
            Math.floor(Number(source.raidRosterSize || options.raidRosterSize || 0))
        );
        const estimate = source.raidEstimate || options.raidEstimate;
        if (!estimate) return attempts * rosterLabor;
        const chance = Math.max(0.1, Math.min(1, Number(estimate.successChance) || 0.1));
        const seconds = Math.max(0, Number(estimate.preparationSeconds) || 0)
            + Math.max(1, Number(estimate.fightSeconds) || 1)
            + (1 - chance) * Math.max(0, Number(estimate.recoverySeconds) || 0);
        // Keep the common effort unit: equivalent ordinary farming kills.
        return attempts * rosterLabor * seconds / 20 / chance;
    }
    return attempts * (soloSafeForSource(state, source) ? 1 : 1.35);
}

function partyNeedAssessmentForSource(state = {}, source = {}) {
    if (source?.sourceKind === 'raid' || source?.raidBoss === true) {
        return { need: 'required', reason: 'raid_roster_required' };
    }
    const record = readinessRecord(state);
    const readiness = record ? record.readiness : computeCombatReadiness(state);
    return SOURCE_ASSESSMENTS[sourceAssessmentReasonAt(record, readiness, sourceTargetLevel(source))];
}

function sourceTargetLevel(source) {
    return targetLevelOf(source?.npcLevel, source?.spotLevel);
}

function targetLevelOf(npcLevel, spotLevel) {
    return Number(npcLevel || spotLevel || Infinity);
}

// The level a source fact judges an index record by: sourceTargetLevel of
// its sourceTargetOf view, without building that object per record.
function sourceRecordTargetLevel(entry) {
    return targetLevelOf(sourceRecordNpcLevel(entry), sourceRecordSpotLevel(entry.spot));
}

// The bot's verdict on one non-raid record, as soloSafeForSource gives it
// for the record's target: solo_ready only.
function soloSafeAtLevel(readiness, targetLevel) {
    // An unknown (NaN) target level never yields a negative margin: solo,
    // unless a hard party need (bound -Infinity) rules every level out.
    const bound = soloLevelBound(readiness);
    return bound !== -Infinity && !(targetLevel > bound);
}

// One decision's answer per target level, shared by partyNeedAssessmentForSource
// and the source fact walk. Many items share the same target level. Keep only
// primitive answers in this decision's existing scope; overflow computes normally.
function sourceAssessmentReasonAt(record, readiness, targetLevel) {
    if (record?.assessments?.has(targetLevel)) return record.assessments.get(targetLevel);
    const reason = sourceAssessmentReason(readiness, targetLevel);
    if (record) {
        record.assessments ||= new Map();
        if (record.assessments.size < MAX_SOURCE_ASSESSMENTS) record.assessments.set(targetLevel, reason);
    }
    return reason;
}

function sourceAssessmentReason(readiness, targetLevel) {
    const hard = hardPartyReason(readiness);
    if (hard) return hard;
    if (soloSafeAtLevel(readiness, targetLevel)) return 'solo_ready';
    return readiness.effectiveLevel - targetLevel < -2 ? 'underleveled' : 'tight_level_margin';
}

function hardPartyReason(readiness) {
    if (!readiness.hasWeapon) return 'missing_weapon';
    // A support with no weapon/armour cannot be treated as a safe solo farmer,
    // even when the level arithmetic happens to look favourable.  This is a
    // hard party need, while a normally equipped bot near the target level can
    // still progress alone and merely advertise a preferred party.
    if (SUPPORT_ROLES.has(readiness.role) && readiness.armorCount < 2) return 'unprepared_support';
    return null;
}

// The highest target level the bot farms alone: a target is solo_ready
// exactly when its level <= this bound (the margin effectiveLevel - level is
// not negative). -Infinity: a hard party need, nothing is solo. An unknown
// (NaN) effective level never yields a negative margin: every level is solo.
// A NaN target level (a non-numeric npcLevel) is solo too: soloSafeAtLevel.
function soloLevelBound(readiness) {
    if (hardPartyReason(readiness)) return -Infinity;
    return Number.isNaN(readiness.effectiveLevel) ? Infinity : readiness.effectiveLevel;
}

function partyNeedForSource(state = {}, source = {}) {
    return partyNeedAssessmentForSource(state, source).need;
}

function partyNeedReasonForSource(state = {}, source = {}) {
    return partyNeedAssessmentForSource(state, source).reason;
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
    if (Number.isFinite(options.maxSourceLevel) && !(source?.sourceKind === 'raid' || source?.raidBoss)
        && sourceTargetLevel(source) > options.maxSourceLevel) return true;
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
    // A full source is met at arrival, not skipped here (ARCH-08-b).
    return options.clanCrafting ? allowedSources[0] || null : safeSources[0] || allowedSources[0] || null;
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
    if (!acquisitionTargetAllowed(state, plan)) return null;
    if (levelingRecoveryFor(state, plan, options.timestamp)) return null;
    if (plan?.status !== 'active' || plannedMaterialAcquired(state, plan)) return null;
    const itemId = itemIdForPlan(plan);
    if (!itemId) return null;
    return bestSourceForState(sourceForItem(itemId, spots, state, options), state, options);
}

function safeFallbackForPlan(state = {}, plan = {}, spots = [], options = {}) {
    if (!acquisitionTargetAllowed(state, plan)) return null;
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
        sourceKind: source.sourceKind || source.kind || 'drop',
        raidBoss: source.raidBoss === true,
        sharedEncounter: source.sharedEncounter === true,
        raidRosterSize: Number(source.raidRosterSize || 0) || null,
        raidBossTemplateId: Number(source.raidBossTemplateId || 0) || null,
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
            expectedEffort: Math.ceil(sourceEffort(source, state)),
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
    const offerOptions = { ...options, origin: offerOrigin(state, { ...options, spots }) };
    const weaponBridge = npcEquipmentBridgePlan(state, offerOptions);
    if (weaponBridge) return weaponBridge;
    const targetId = Number(previousPlan?.target?.selfId || 0);
    const excluded = new Set((options.excludedTargetIds || []).map(Number).filter(Boolean));
    if (!excluded.has(targetId) && acquisitionTargetAllowed(state, previousPlan)) {
        if (plannedMaterialAcquired(state, previousPlan)) {
            const refreshed = planFor(state, { ...options, spots, recipeId: previousPlan.recipeId });
            if (['active', 'component_ready', 'ready_to_craft', 'complete'].includes(refreshed?.status)) return refreshed;
        }
        // A new funded listing can replace a retained farm or craft route on
        // the next resolve, without waiting for that route to fail first.
        if (['direct_drop', 'craft'].includes(previousPlan.strategy)
            && previousPlan.status === 'active') {
            const market = fundedMarketPlanForTarget(state, targetId, offerOptions);
            if (market) return market;
        }
        const source = bestSourceForPlan(state, previousPlan, spots, options);
        if (source) return retargetPlanSource(state, previousPlan, source);
    }
    const market = targetId ? marketPlanForTarget(state, targetId, offerOptions) : null;
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

// Empty selections preserve the real shared view and its derived caches.
const NO_SOURCES = GameCatalogue.sourceIndexFor();
function sourceIndexFor(spots = []) {
    const byItemId = GameCatalogue.sourceIndexFor(spots);
    if (byItemId !== NO_SOURCES && byItemId !== sourceIndexCache.byItemId) {
        sourceIndexCache = { byItemId, resolved: new Map(), yields: new Map(),
            plainYields: new Map(), deepYields: new Map(), plainRatesKey: null, huntable: new Map(), factRules: new Map(), factRulesKey: null, factRuleCells: 0 };
    }
    return byItemId;
}

// The hunt-rule view of an index record: the fields the band, party and
// capacity rules read. Materialized sources and source facts share it.
function sourceTargetOf(entry) {
    const { reward, spot, kind } = entry, raidBoss = spot?.raidBoss === true;
    return { npcId: Number(reward.selfId), npcLevel: sourceRecordNpcLevel(entry), spotId: spot.id,
        spotLevel: sourceRecordSpotLevel(spot), sourceKind: raidBoss ? 'raid' : kind, raidBoss };
}
function sourceRecordNpcLevel({ spot, npcLevel }) {
    return Number(npcLevel || spot?.avgLevel || 1);
}
function sourceRecordSpotLevel(spot) {
    return Number(spot.avgLevel || 1);
}

// One materialized source of an index record for a killer level.
function materializeSource(entry, itemId, killerLevel, ratesKey) {
    const { reward, spot, kind } = entry, target = sourceTargetOf(entry);
    const { chance, expectedYield } = dropYieldFor(reward, itemId, kind, target.npcLevel, killerLevel, ratesKey);
    if (!chance) return null;
    return {
        npcId: target.npcId,
        npcName: reward.template?.name || `NPC ${reward.selfId}`,
        kind,
        chance,
        expectedYield,
        spotId: target.spotId,
        spotLevel: target.spotLevel,
        npcLevel: target.npcLevel,
        capacity: LevelingRoutes.capacityForSpot(spot),
        sourceKind: target.sourceKind,
        raidBoss: target.raidBoss,
        sharedEncounter: spot?.sharedEncounter === true,
        raidEstimate: spot?.raidEstimate || null,
        raidRosterSize: spot?.raidBoss === true
            ? Math.max(RAID_MIN_ROSTER_LABOR, Number(spot.raidRosterSize || 0))
            : null,
        raidBossTemplateId: spot?.raidBoss === true
            ? Number(spot.raidBossTemplateId || reward.selfId)
            : null
    };
}

function sourceForItem(itemId, spots = [], state = {}, options = {}) {
    if (Progression.marketOnly(state, catalogItem(itemId))) return [];
    if (Progression.isCGradeHelmet(catalogItem(itemId))) return [];
    const sourceCache = options.sourceCache;
    const spoilCapable = options.spoilCapable === true || roleFor(state) === 'spoiler';
    const allowRaidSources = options.allowRaidSources === true;
    const cacheKey = `${Number(itemId)}:${Number(state.level || 0)}:${spoilCapable ? 1 : 0}:${allowRaidSources ? 1 : 0}`;
    if (sourceCache?.has(cacheKey)) return sourceCache.get(cacheKey);
    const sourceIndex = sourceIndexFor(spots);
    // The resolved lists below belong to the cached spot list; no spots means none.
    if (sourceIndex === NO_SOURCES) {
        sourceCache?.set(cacheKey, []);
        return [];
    }
    const ratesKey = sourceYieldRatesKey();
    const resolvedKey = `${cacheKey}:${ratesKey}`;
    const entries = sourceIndex.get(Number(itemId)) || [];
    const materialize = entry => materializeSource(entry, itemId, Number(state.level || 0), ratesKey);
    const cached = sourceIndexCache.resolved.get(resolvedKey);
    if (cached) {
        const sources = Array.from(cached, ordinal => materialize(entries[ordinal]));
        sourceCache?.set(cacheKey, sources);
        return sources;
    }
    const ranked = entries.flatMap((entry, ordinal) => {
        if ((entry.kind === 'spoil' && !spoilCapable) || (entry.spot?.raidBoss === true && !allowRaidSources)) return [];
        const source = materialize(entry);
        return source ? [{ source, ordinal, effort: sourceEffort(source, state, options) }] : [];
    })
        // Effort once per source, not once per comparison.
        .sort((a, b) => a.effort - b.effort || b.source.expectedYield - a.source.expectedYield);
    const sources = ranked.map(entry => entry.source);
    if (sourceIndexCache.resolved.size >= MAX_RESOLVED_SOURCE_CACHE) {
        sourceIndexCache.resolved.delete(sourceIndexCache.resolved.keys().next().value);
    }
    const Ordinals = entries.length <= 65536 ? Uint16Array : Uint32Array;
    sourceIndexCache.resolved.set(resolvedKey, Ordinals.from(ranked, entry => entry.ordinal));
    sourceCache?.set(cacheKey, sources);
    return sources;
}

function sourceCacheSize() {
    return { resolved: sourceIndexCache.resolved.size,
        packedBytes: [...sourceIndexCache.resolved.values()].reduce((bytes, row) => bytes + row.byteLength, 0),
        yields: sourceYieldCount() };
}

function sourceYieldRatesKey() {
    const rates = ProgressionRates.profile();
    return `${rates.drop}:${rates.spoil}:${rates.adena}`;
}

// One synchronous projection reads one rate profile. Reuse the planner's
// bounded yield pairs without its route sorting or NPC-level fallback.
function sourceYieldReaderFor(killerLevel) {
    const ratesKey = sourceYieldRatesKey();
    return (source, itemId) => dropYieldFor(source.reward, itemId, source.kind,
        source.npcLevel, killerLevel, ratesKey);
}

// Finite farm and spoil facts of one item for one bot (Task 2, D4-D7, D9):
// every known source, eligible by the rules the bot hunts and spoils by, or
// with the reason it is not. Hours for `units` come from the spot's kills
// per hour (the same SpotEconomics row the bot chooses spots by) times the
// yield and the NPC's share of the spot. An hour there costs the bot its own
// hour (1, the hour measure) less what the spot gives back (valueHours);
// travel to a spot other than the current one is a round trip to the
// spot's regional town. Unknown is explicit, never free.
// invoke(), not require(): a require() in the per-source loop re-resolved the
// module path on every ready source (21% of the cold worker in a live profile).
// A spot's regional town depends only on its fixed centre and the static
// town regions: one answer per planning spot object, no per-bot state.
const spotTowns = new WeakMap();
function* spotTown(spot) {
    if (!spotTowns.has(spot)) spotTowns.set(spot, spot.center ? (yield* invoke('GameServer/Bot/Economy/EconomicTrip').regionalTown(spot.center))?.name || null : null);
    return spotTowns.get(spot);
}
// A driver slices the loop per SOURCE_FACT_STEP records: a step per record
// cost more than the record itself (the wish drains it synchronously).
// options.readyOnly (the wish's case): only ready facts are returned and
// refusals are never built as objects (74% of records). options.counts (a
// Map, for diagnostics) counts every record by 'ready' or its reason, in
// record order; it implies readyOnly.
// The synchronous wish reader's bestForWish keeps one winner using scalar
// spoilOnly, progressionRequired and hourAdena inputs; all rows are still read.
const SOURCE_FACT_STEP = 64;
function sourceSpoilerFor(state) {
    return invoke('GameServer/Bot/Population/ColdKillRewards').spoilerFor(state,
        { skills: invoke('GameServer/Bot/Population/ColdCombatProfile').skillsFor(state) }) || false;
}
function writeReadySourceFact(fact, kind, spotId, npcId, itemId, units, expectedYield,
    perHour, hours, valueHours, netHourCost, town, tripHours, tripFees, costHours) {
    fact.kind = kind; fact.spotId = spotId; fact.npcId = npcId;
    fact.itemId = itemId; fact.units = units; fact.expectedYield = expectedYield;
    fact.status = 'ready'; fact.perHour = perHour; fact.hours = hours;
    fact.valueHours = valueHours; fact.netHourCost = netHourCost;
    fact.town = town; fact.tripHours = tripHours; fact.tripFees = tripFees;
    fact.costHours = costHours;
    return fact;
}
// A source is executable only on ground the solo route executor admits.
// The bot's ground verdict per planning spot: the clauses only its build
// moves (the spot's raid flag, the level fit, the kit matchup of the bot
// alone), 2 bits per spot at its ordinal in `spots` (SpotIndex.ordinalFor):
// 0 unknown, 1 allowed, 2 refused, filled as the walk asks. The wish build
// keeps the record with the bot's held build (EconomyContext, dropped when a
// step's sections hit COMPUTED.sourceGround); kept = that record, or null.
// The reads no section of that mask names are checked by each reader against
// the copies beside the bits: the list's length, the economic hunt (the
// bot's wish focus), the matchup's highest target level (LevelingRoutes
// safetyOptions: the recovery penalty, whose clean wins move no section, and
// the route mode), the party ground flag (BotHuntingGroundPolicy) and the
// solo profile key (BotTargetMatchup.profileKey: alive, the summon beside it).
// The spot exclusions (step-counted marks, no section) are never kept.
const GROUND_ALLOWED = 1, GROUND_REFUSED = 2;
function sourceGround(spots = [], kept = null) {
    return kept?.spots === spots ? kept : { spots, length: -1, economicHunt: null, targetLevel: -1, grouped: null,
        solo: null, cells: null };
}
// Diagnostics only: one reused reader in 64 also checks its kept cells
// against a fresh verdict (source_route:ground:checked|disagree).
let groundShadows = 0;
// options.ground: a sourceGround record to read and fill (counted as
// source_route:ground:reuse|build); without one a call-local record over
// options.spots. options.matchupProfiles: the state's solo profiles at this
// timestamp, when the caller already read them (the build's income route).
function sourceRouteReader(state, options = {}) {
    const timestamp = options.timestamp ?? Date.now();
    const excluded = SpotRiskPolicy.excludedSpotIdsForStates([state], timestamp);
    const Spots = invoke('GameServer/Bot/AI/SpotService');
    const economicHunt = invoke('GameServer/Bot/Economy/EquipmentIncomeRoute').economicHunt(state);
    const soloOptions = { timestamp, mode: 'solo' };
    const targetLevel = LevelingRoutes.safetyOptions(state, soloOptions).maxTargetLevel ?? 0;
    // The hunting-ground clause admits party-only ground to a grouped bot.
    const grouped = BotHuntingGroundPolicy.isParty(state, { mode: 'solo' });
    const level = Number(state.level || 1);
    // The solo profiles, read once per reader: up front for a kept record
    // (their key is one of its copies), else at the first matchup clause.
    let profiles = options.matchupProfiles || (options.ground ? BotTargetMatchup.stateProfiles(state, soloOptions) : null);
    const solo = profiles && BotTargetMatchup.profileKey(profiles);
    const ground = options.ground || sourceGround(options.spots || []);
    const spots = ground.spots;
    const reused = ground.cells !== null && ground.length === spots.length
        && ground.economicHunt === economicHunt && ground.targetLevel === targetLevel
        && ground.grouped === grouped && ground.solo === solo;
    if (!reused) Object.assign(ground, { length: spots.length, economicHunt, targetLevel, grouped, solo,
        cells: new Uint8Array((spots.length + 3) >> 2) });
    const cells = ground.cells, diagnostic = Diagnostics.active();
    if (diagnostic && options.ground) Diagnostics.count('source_route', 'ground', reused ? 'reuse' : 'build');
    // A sampled reader notes the ordinals it checked or filled itself.
    const shadow = diagnostic && reused && (Diagnostics.enabled(state.characterId) || (++groundShadows & 63) === 0)
        ? new Set() : null;
    // An excluded spot counts once per reader, as each refusal used to.
    const countedExcluded = diagnostic ? new Set() : null;
    // The first kept clause that refuses the spot, cheap ones first: the
    // matchup verdict (profiles, NPC verdicts) is the costly one.
    const refusal = spot => {
        if (spot.raidBoss === true) return 'raid';
        if (!Spots.isSuitable(spot, level, soloOptions)
            && !(economicHunt && Number(spot.avgLevel || spot.minLevel || 1) >= level - 15)) return 'level';
        profiles ||= BotTargetMatchup.stateProfiles(state, soloOptions);
        if (!LevelingRoutes.isSpotAllowedForState(spot, state, { ...soloOptions, matchupProfiles: profiles })) return 'matchup';
        return null;
    };
    return spot => {
        const at = SpotIndex.ordinalFor(spots, spot), shift = (at & 3) << 1;
        let cell = at < 0 ? 0 : cells[at >> 2] >> shift & 3;
        if (shadow && cell && !shadow.has(at)) {
            shadow.add(at);
            Diagnostics.count('source_route', 'ground', 'checked');
            if ((refusal(spot) ? GROUND_REFUSED : GROUND_ALLOWED) !== cell) Diagnostics.count('source_route', 'ground', 'disagree');
        }
        if (cell === GROUND_REFUSED) return false;
        if (excluded.size && excluded.has(String(spot.id))) {
            if (countedExcluded && !countedExcluded.has(spot)) {
                countedExcluded.add(spot);
                Diagnostics.count('source_route', 'refused', 'excluded');
            }
            return false;
        }
        if (!cell) {
            const refused = refusal(spot);
            if (refused && diagnostic) Diagnostics.count('source_route', 'refused', refused);
            cell = refused ? GROUND_REFUSED : GROUND_ALLOWED;
            if (at >= 0) { cells[at >> 2] |= cell << shift; shadow?.add(at); }
        }
        return cell === GROUND_ALLOWED;
    };
}

function* sourceFacts(state = {}, itemId, units = 1, options = {}) {
    const ratesKey = sourceYieldRatesKey(), killerLevel = Number(state.level || 0);
    const entries = sourceIndexFor(options.spots || []).get(Number(itemId)) || [];
    const timestamp = options.timestamp ?? Date.now();
    const routeAllowed = options.routeAllowed || sourceRouteReader(state, { ...options, timestamp });
    const spotValue = options.spotValue
        || SpotEconomics.create(state, { timestamp });
    const trips = options.trips || new Map();
    const current = String(state.stats?.travel?.spotId || state.spotId || null);
    const bestForWish = options.bestForWish;
    const spoilOnly = bestForWish?.spoilOnly, progressionRequired = bestForWish?.progressionRequired;
    const hourAdena = bestForWish?.hourAdena;
    const counts = options.counts || null, readyOnly = !!(counts || options.readyOnly || bestForWish);
    let spoiler = options.spoiler;
    // Most records the bot reaches are refused as party_needed. The verdict
    // reads one readiness per call and the record's level; the counts take
    // their tally once at the end (the key keeps its first-seen place).
    let readiness = null;
    const readReadiness = () => {
        if (readiness === null) {
            const scoped = readinessRecord(state);
            readiness = scoped ? scoped.readiness : computeCombatReadiness(state);
        }
        return readiness;
    };
    const rules = sourceFactRulesFor(entries, itemId, ratesKey);
    // The bot's voluntary level band: a record below it is refused as level_band.
    const minGap = sourceMinLevelGap(!!options.economicLower);
    // The full view still reads all rows. Ready readers walk only eligible
    // ordinals; diagnostics merge the few static buckets at their first row.
    // Oversized uncached rows use the full walk without an extra ordinal array.
    const prepared = readyOnly && rules.eligible !== null;
    // Only the wish's synchronous drain walks the bot's solo-safe records
    // alone. Other generators retain their incremental counts and work order.
    if (!bestForWish || !prepared) {
        return yield* walk(prepared ? rules.eligible : null, prepared && counts ? rules.staticBuckets : [], counts, false, 0);
    }
    // The row orders each kind's eligible records by target level (the
    // record's npc level, else its spot level, else Infinity, which the band
    // never takes): the
    // level_band ones (below killerLevel + minGap) are a prefix, the safe ones
    // (up to soloLevelBound) follow, the party_needed ones are the tail. A bot
    // without Spoil refuses every spoil record as spoil_skill. Only the safe
    // window is visited: the rest is counted as buckets at their first
    // ordinal, so the reason keys keep the full walk's first-seen order.
    const { levels, drops, spoils } = rules;
    if (spoils.count && spoiler === undefined) spoiler = sourceSpoilerFor(state);
    const walkSpoils = spoils.count > 0 && !!spoiler;
    const bandRanks = killerLevel ? levelRanksBelowGap(levels, killerLevel, minGap) : 0;
    const bandDrops = drops.rankStart[bandRanks], bandSpoils = walkSpoils ? spoils.rankStart[bandRanks] : 0;
    let safeRanks = levels.length;
    if (drops.count > bandDrops || walkSpoils && spoils.count > bandSpoils) {
        safeRanks = Math.max(bandRanks, levelRanksAtMost(levels, soloLevelBound(readReadiness())));
    }
    const safeDrops = drops.rankStart[safeRanks] - bandDrops;
    const safeSpoils = walkSpoils ? spoils.rankStart[safeRanks] - bandSpoils : 0;
    let safeOrdinals = rules.eligible;
    if (safeDrops + safeSpoils < safeOrdinals.length) {
        // Back to ordinal order: the walk reads values, trips and ties in it.
        safeOrdinals = new Uint32Array(safeDrops + safeSpoils);
        safeOrdinals.set(rules.ranked.subarray(drops.base + bandDrops, drops.base + bandDrops + safeDrops));
        safeOrdinals.set(rules.ranked.subarray(spoils.base + bandSpoils, spoils.base + bandSpoils + safeSpoils), safeDrops);
        safeOrdinals.sort();
    }
    let safeBuckets = counts ? rules.staticBuckets : [];
    if (counts && safeOrdinals !== rules.eligible) {
        safeBuckets = [...safeBuckets];
        if (bandDrops) safeBuckets.push(sourceHeadBucket(drops, bandRanks));
        if (bandDrops + safeDrops < drops.count) safeBuckets.push(sourceTailBucket('party_needed', drops, safeRanks));
        // spoil_skill precedes level_band: the whole kind is one bucket.
        if (!walkSpoils && spoils.count) safeBuckets.push(sourceTailBucket('spoil_skill', spoils, 0));
        else {
            if (bandSpoils) safeBuckets.push(sourceHeadBucket(spoils, bandRanks));
            if (bandSpoils + safeSpoils < spoils.count) safeBuckets.push(sourceTailBucket('party_needed', spoils, safeRanks));
        }
        safeBuckets.sort((a, b) => a.firstOrdinal - b.firstOrdinal);
    }
    // The 'source' steps stay as many as the full walk takes.
    const ready = yield* walk(safeOrdinals, safeBuckets, counts, true, rules.eligible.length + (counts ? rules.staticBuckets.length : 0));
    if (Diagnostics.active()) {
        Diagnostics.count('source_bound', 'skip', 'records', rules.eligible.length - safeOrdinals.length);
        Diagnostics.count('source_bound', 'walk', 'records', safeOrdinals.length);
    }
    return ready;

    // One walk over ordinals (null: every record) merged with refusal buckets.
    // bounded: the ordinals are the bot's solo-safe records already.
    function* walk(ordinals, buckets, tally, bounded, plannedTurns) {
        const facts = [], length = ordinals ? ordinals.length : entries.length;
        let bestCost, partyNeeded = 0;
        let cursor = 0, bucketCursor = 0, processed = 0;
        while (cursor < length || bucketCursor < buckets.length) {
            if (processed++ % SOURCE_FACT_STEP === 0) yield 'source';
            const ordinal = cursor < length ? (ordinals ? ordinals[cursor] : cursor) : entries.length;
            const bucket = buckets[bucketCursor];
            if (bucket && bucket.firstOrdinal < ordinal) {
                let reason = bucket.reason;
                if (!reason) {
                    reason = FACT_RULE_REASONS[bucket.rule];
                    // Raid protection precedes Spoil; other static refusals follow it.
                    if (bucket.rule !== FACT_RULE_RAID && bucket.kind === 'spoil') {
                        if (spoiler === undefined) spoiler = sourceSpoilerFor(state);
                        if (!spoiler) reason = 'spoil_skill';
                    }
                }
                tally.set(reason, (tally.get(reason) || 0) + bucket.count);
                bucketCursor++;
                continue;
            }
            cursor++;
            // The fact reads the shared rule row of the record (yield and the
            // static refusals), not a materialized source per entry; the
            // level band and the deep-blue yield follow the killer level.
            const rule = rules.reasons[ordinal];
            if (rule === FACT_RULE_NO_CHANCE) continue;
            const entry = entries[ordinal], { spot, kind } = entry, npcLevel = sourceRecordNpcLevel(entry);
            // The row holds the penalty-free yield; a deep-blue record (only an
            // equipment earning route walks one) reads its penalised yield.
            const expectedYield = ProgressionRates.deepBluePenaltyPercent(npcLevel, killerLevel)
                ? dropYieldFor(entry.reward, itemId, kind, npcLevel, killerLevel, ratesKey).expectedYield
                : rules.expected[ordinal];
            let status = 'ineligible', reason = rule === FACT_RULE_RAID ? 'raid' : null;
            if (!reason && kind === 'spoil') {
                // The executor's rule: a learned Spoil, not the class (E189).
                if (spoiler === undefined) spoiler = sourceSpoilerFor(state);
                if (!spoiler) reason = 'spoil_skill';
            }
            if (!reason && rule) reason = FACT_RULE_REASONS[rule];
            if (!reason && !bounded && killerLevel && npcLevel && npcLevel - killerLevel < minGap) reason = 'level_band';
            if (!reason) {
                // A raid record never reaches here (FACT_RULE_RAID); a 'raid' kind
                // still needs its roster, as soloSafeForSource says.
                // Same raid check as partyNeedAssessmentForSource (kept there too).
                if (kind === 'raid' || !bounded && !soloSafeAtLevel(readReadiness(), sourceRecordTargetLevel(entry))) {
                    if (tally && !partyNeeded++ && !tally.has('party_needed')) tally.set('party_needed', 0);
                    if (readyOnly) continue;
                    reason = 'party_needed';
                }
                if (!reason && !routeAllowed(spot)) reason = 'route_ineligible';
            }
            let row = null, perHour = 0, trip = null, town = null;
            if (!reason) {
                status = 'unknown';
                row = spotValue(entry.spot);
                perHour = Number(row?.kills) * expectedYield
                    * Number(entry.sourceCount || 0) / Math.max(1, Number(entry.totalCount || 0));
                if (!(perHour > 0)) reason = 'yield';
                else if (!Number.isFinite(row.valueHours)) reason = 'income';
            }
            if (!reason) {
                trip = { known: true, hours: 0, fees: 0 };
                if (String(entry.spot.id) !== current) {
                    // A known town is read without a delegated generator per record.
                    town = spotTowns.has(entry.spot) ? spotTowns.get(entry.spot) : yield* spotTown(entry.spot);
                    // A caller with prepared routes (the wish) passes its own reader.
                    if (town && !trips.has(town)) trips.set(town, options.trip ? options.trip.details(town)
                        : yield* invoke('GameServer/Bot/Economy/EconomicTrip').details(state, town));
                    trip = town ? trips.get(town) : { known: false };
                }
                if (!trip?.known) reason = 'route';
            }
            if (tally) tally.set(reason || 'ready', (tally.get(reason || 'ready') || 0) + 1);
            const npcId = Number(entry.reward.selfId);
            if (reason) {
                if (!readyOnly) facts.push({ kind, spotId: spot.id, npcId, itemId: Number(itemId), units, expectedYield, status, reason });
                continue;
            }
            const hours = units / perHour, netHourCost = Math.max(0, 1 - row.valueHours);
            const spotId = spot.id, factItemId = Number(itemId), valueHours = row.valueHours;
            const tripHours = trip.hours, tripFees = trip.fees, costHours = hours * netHourCost + trip.hours;
            if (bestForWish) {
                if (spoilOnly && kind !== 'spoil') continue;
                const cost = progressionRequired ? hours + tripHours + tripFees / Math.max(1, hourAdena) : costHours;
                if (facts.length && !(cost < bestCost)) continue;
                bestCost = cost;
            }
            const fact = writeReadySourceFact(bestForWish ? facts[0] || {} : {}, kind, spotId, npcId,
                factItemId, units, expectedYield, perHour, hours, valueHours, netHourCost, town, tripHours, tripFees, costHours);
            if (bestForWish) facts[0] = fact;
            else facts.push(fact);
        }
        if (partyNeeded) tally.set('party_needed', tally.get('party_needed') + partyNeeded);
        for (let step = Math.ceil(processed / SOURCE_FACT_STEP); step < Math.ceil(plannedTurns / SOURCE_FACT_STEP); step++) yield 'source';
        return facts;
    }
}

// A party_needed or spoil_skill tail of one kind of a fact row, from rank
// on: one counts bucket at the tail's first ordinal.
function sourceTailBucket(reason, kind, rank) {
    return { rule: 0, kind: null, firstOrdinal: kind.tailFirst[rank], count: kind.count - kind.rankStart[rank], reason };
}

// The level_band head of one kind of a fact row, below rank: one counts
// bucket at the head's first ordinal.
function sourceHeadBucket(kind, rank) {
    return { rule: 0, kind: null, firstOrdinal: kind.headFirst[rank], count: kind.rankStart[rank], reason: 'level_band' };
}

// How many of the ascending levels are <= bound (a binary search).
function levelRanksAtMost(levels, bound) {
    let low = 0, high = levels.length;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (levels[middle] <= bound) low = middle + 1;
        else high = middle;
    }
    return low;
}

// How many of the ascending levels are below the band: level - killerLevel
// < minGap, strictly, as the walk refuses a record (a binary search; a NaN
// level sorts last and is never below).
function levelRanksBelowGap(levels, killerLevel, minGap) {
    let low = 0, high = levels.length;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (levels[middle] - killerLevel < minGap) low = middle + 1;
        else high = middle;
    }
    return low;
}

// The per-bot loop of sourceFacts re-derived, for every record, answers that
// depend only on the record, the item and the rates: the penalty-free yield
// pair, raid and a huntable NPC. One row per item holds them, aligned with
// the index records; it lives with the index (rebuilt with it) and follows
// the rate profile. The voluntary level band and the deep-blue yield depend
// on the killer level: sourceFacts applies them per bot (the band is a prefix
// of the level ranks). Numbers only, no bot references: 9 bytes per record,
// two 4-byte ordinals per eligible record (in record order and by target
// level) and ~32 bytes per distinct level. Static refusals use at most four
// buckets, each retaining its first ordinal, so diagnostic reason keys keep
// their full-view insertion order. A record with FACT_RULE_NO_CHANCE is never
// seen or counted by the bot: its chance is 0 at killer level 0, which holds
// at every killer level only while every reward group has overall * rate > 0
// (a deep-blue penalty lifts a 0-chance group to its floor; the game data has
// no such group).
const FACT_RULE_RAID = 1, FACT_RULE_CANNOT_HUNT = 2, FACT_RULE_NO_CHANCE = 255;
const FACT_RULE_REASONS = [null, 'raid', 'cannot_hunt'];
const NO_FACT_ORDINAL = 0xFFFFFFFF;
const NO_RANKED_KIND = { base: 0, count: 0, rankStart: new Uint32Array(1),
    headFirst: new Uint32Array([NO_FACT_ORDINAL]), tailFirst: new Uint32Array([NO_FACT_ORDINAL]) };
const NO_FACT_RULES = { entries: [], expected: new Float64Array(0), reasons: new Uint8Array(0),
    eligible: new Uint32Array(0), staticBuckets: [], cells: 0,
    levels: new Float64Array(0), ranked: new Uint32Array(0), drops: NO_RANKED_KIND, spoils: NO_RANKED_KIND };
function sourceFactRulesFor(entries, itemId, ratesKey) {
    if (!entries.length) return NO_FACT_RULES;
    if (sourceIndexCache.factRulesKey !== ratesKey) {
        sourceIndexCache.factRules = new Map();
        sourceIndexCache.factRulesKey = ratesKey;
        sourceIndexCache.factRuleCells = 0;
    }
    const cache = sourceIndexCache.factRules, key = Number(itemId);
    let rules = cache.get(key);
    if (rules && rules.entries === entries) return rules;
    if (rules) { cache.delete(key); sourceIndexCache.factRuleCells -= rules.cells; }
    // A retained row counts one cell per record and one per eligible record
    // (its level-ordered ordinal), so at most two per record.
    const retain = 2 * entries.length <= MAX_SOURCE_FACT_RULE_CELLS;
    // The cache retains <= 1 MiB of ordinal backing; room for a retained row
    // is made once it is built, for all its cells at once. Uncollected
    // evictions or rows held by an active reader can outlive the cache.
    // Oversized rows get no ordinal backing and are not retained; this
    // caller uses their full rule arrays and original walk.
    const expected = new Float64Array(entries.length), reasons = new Uint8Array(entries.length);
    const eligible = retain ? new Uint32Array(entries.length) : null;
    const staticBuckets = [], bucketsByRuleKind = new Map();
    let eligibleCount = 0;
    if (Diagnostics.active()) Diagnostics.count('source_bound', 'row', 'built');
    for (let ordinal = 0; ordinal < entries.length; ordinal++) {
        // The rule reads only the level, the raid flag and the NPC id of a
        // record: no source target object per record (L130).
        const entry = entries[ordinal], npcLevel = sourceRecordNpcLevel(entry);
        // Killer level 0 has no deep-blue penalty; nothing else of a reward
        // roll reads the killer level, so this is every bot's penalty-free yield.
        const value = dropYieldFor(entry.reward, itemId, entry.kind, npcLevel, 0, ratesKey);
        if (!value.chance) { reasons[ordinal] = FACT_RULE_NO_CHANCE; continue; }
        expected[ordinal] = value.expectedYield;
        reasons[ordinal] = entry.spot?.raidBoss === true ? FACT_RULE_RAID
            : !sourceNpcHuntable(Number(entry.reward.selfId)) ? FACT_RULE_CANNOT_HUNT : 0;
        if (!retain) continue;
        const rule = reasons[ordinal];
        if (!rule) eligible[eligibleCount++] = ordinal;
        else {
            const bucketKey = rule * 2 + Number(entry.kind === 'spoil');
            let bucket = bucketsByRuleKind.get(bucketKey);
            if (!bucket) {
                bucket = { rule, kind: entry.kind, firstOrdinal: ordinal, count: 0, reason: null };
                bucketsByRuleKind.set(bucketKey, bucket);
                staticBuckets.push(bucket);
            }
            bucket.count++;
        }
    }
    rules = { entries, expected, reasons, eligible: eligible ? eligible.subarray(0, eligibleCount) : null, staticBuckets,
        cells: entries.length, levels: null, ranked: null, drops: null, spoils: null };
    if (retain) {
        rankSourceFactRules(rules);
        rules.cells += eligibleCount;
        // Room for the whole row at once: the entries were not counted yet.
        makeFactRuleRoom(rules.cells);
        sourceIndexCache.factRuleCells += rules.cells;
        cache.set(key, rules);
        if (Diagnostics.active()) Diagnostics.count('source_bound', 'row', 'levels', rules.levels.length);
    }
    return rules;
}

function makeFactRuleRoom(cells) {
    const cache = sourceIndexCache.factRules;
    while (sourceIndexCache.factRuleCells + cells > MAX_SOURCE_FACT_RULE_CELLS && cache.size) {
        const [oldest, row] = cache.entries().next().value;
        cache.delete(oldest);
        sourceIndexCache.factRuleCells -= row.cells;
    }
}

// Orders a row's eligible records per kind (drops, then spoils, in ranked)
// by the rank of their target level among the row's distinct levels, ties
// in record order (a counting sort). For a bot whose solo bound admits the
// first r levels, rankStart[r] of a kind is its count of safe records and
// tailFirst[r] the first ordinal of its unsafe rest; for a bot whose level
// band starts at rank r, rankStart[r] is its count of banded records and
// headFirst[r] their first ordinal.
function rankSourceFactRules(rules) {
    const { entries, eligible } = rules, count = eligible.length;
    const targetLevels = new Float64Array(count);
    for (let index = 0; index < count; index++) targetLevels[index] = sourceRecordTargetLevel(entries[eligible[index]]);
    const sorted = targetLevels.slice().sort();
    let distinct = 0;
    for (let index = 0; index < count; index++) {
        if (!distinct || sorted[index] !== sorted[distinct - 1]) sorted[distinct++] = sorted[index];
    }
    const levels = sorted.slice(0, distinct);
    const kinds = [rankedKind(distinct), rankedKind(distinct)];
    const ranks = new Uint32Array(count);
    for (let index = 0; index < count; index++) {
        ranks[index] = levelRanksAtMost(levels, targetLevels[index]) - 1;
        kinds[Number(entries[eligible[index]].kind === 'spoil')].rankStart[ranks[index] + 1]++;
    }
    let base = 0;
    for (const kind of kinds) {
        for (let rank = 0; rank < distinct; rank++) kind.rankStart[rank + 1] += kind.rankStart[rank];
        kind.base = base;
        kind.count = kind.rankStart[distinct];
        base += kind.count;
    }
    const ranked = new Uint32Array(count);
    const next = kinds.map(kind => kind.rankStart.slice(0, distinct));
    for (let index = 0; index < count; index++) {
        const spoil = Number(entries[eligible[index]].kind === 'spoil');
        ranked[kinds[spoil].base + next[spoil][ranks[index]]++] = eligible[index];
    }
    for (const kind of kinds) {
        kind.headFirst[0] = NO_FACT_ORDINAL;
        for (let rank = 0; rank < distinct; rank++) {
            const first = kind.rankStart[rank] < kind.rankStart[rank + 1] ? ranked[kind.base + kind.rankStart[rank]] : NO_FACT_ORDINAL;
            kind.headFirst[rank + 1] = Math.min(first, kind.headFirst[rank]);
        }
        kind.tailFirst[distinct] = NO_FACT_ORDINAL;
        for (let rank = distinct - 1; rank >= 0; rank--) {
            const first = kind.rankStart[rank] < kind.rankStart[rank + 1] ? ranked[kind.base + kind.rankStart[rank]] : NO_FACT_ORDINAL;
            kind.tailFirst[rank] = Math.min(first, kind.tailFirst[rank + 1]);
        }
    }
    rules.levels = levels;
    rules.ranked = ranked;
    rules.drops = kinds[0];
    rules.spoils = kinds[1];
}

function rankedKind(levels) {
    return { base: 0, count: 0, rankStart: new Uint32Array(levels + 1),
        headFirst: new Uint32Array(levels + 1), tailFirst: new Uint32Array(levels + 1) };
}

// A drop yield depends only on the reward, the item and the deep-blue level
// penalty: keep it as a number pair per rate profile. Craft routes evaluate
// many materials, so the bounded source lists above are rebuilt often; this
// keeps a rebuild from recomputing every reward roll.
// Without a deep-blue penalty (every fact the hunt band admits) the pair is
// keyed by numbers, not a five-part string: the same bound, a cheaper read.
// A deep-blue drop or spoil with a whole penalty is keyed by numbers too, in
// its own map (L129): its string key was built and hashed on every read.
const PLAIN_YIELD_ITEMS = 2 ** 20;
// npc, item, kind and a 7-bit penalty (0..100) stay below 2 ** 53.
const DEEP_YIELD_NPCS = 2 ** 24;
function dropYieldFor(reward, itemId, kind, npcLevel, killerLevel, ratesKey) {
    const npcId = Number(reward.selfId), item = Number(itemId);
    const penalty = Math.min(100, ProgressionRates.deepBluePenaltyPercent(npcLevel, killerLevel));
    if ((kind === 'drop' || kind === 'spoil') && Number.isInteger(npcId) && npcId >= 0 && npcId < 2 ** 31
        && Number.isInteger(item) && item >= 0 && item < PLAIN_YIELD_ITEMS
        && (penalty === 0 || (npcId < DEEP_YIELD_NPCS && Number.isInteger(penalty)))) {
        if (sourceIndexCache.plainRatesKey !== ratesKey) {
            sourceIndexCache.plainYields = new Map();
            sourceIndexCache.deepYields = new Map();
            sourceIndexCache.plainRatesKey = ratesKey;
        }
        const pair = (npcId * PLAIN_YIELD_ITEMS + item) * 2 + (kind === 'spoil' ? 1 : 0);
        const map = penalty === 0 ? sourceIndexCache.plainYields : sourceIndexCache.deepYields;
        const key = penalty === 0 ? pair : pair * 128 + penalty;
        let value = map.get(key);
        if (!value) {
            value = itemDropYield(reward, itemId, kind, { npcLevel, killerLevel });
            if (sourceYieldCount() >= MAX_SOURCE_YIELDS) evictSourceYield();
            map.set(key, value);
        }
        return value;
    }
    const key = `${ratesKey}:${reward.selfId}:${itemId}:${kind}:${penalty}`;
    let value = sourceIndexCache.yields.get(key);
    if (!value) {
        value = itemDropYield(reward, itemId, kind, { npcLevel, killerLevel });
        if (sourceYieldCount() >= MAX_SOURCE_YIELDS) evictSourceYield();
        sourceIndexCache.yields.set(key, value);
    }
    return value;
}

function sourceYieldCount() {
    const { plainYields, deepYields, yields } = sourceIndexCache;
    return yields.size + (plainYields?.size || 0) + (deepYields?.size || 0);
}

// The yield maps share one bound; the largest gives up its oldest pair.
function evictSourceYield() {
    const { plainYields, deepYields, yields } = sourceIndexCache;
    let map = yields;
    if (plainYields && plainYields.size >= map.size) map = plainYields;
    if (deepYields && deepYields.size > map.size) map = deepYields;
    map.delete(map.keys().next().value);
}

// A catalog NPC's huntability is static per loaded NPC table (the index
// cache is rebuilt when that table changes).
function sourceNpcHuntable(npcId) {
    const huntable = sourceIndexCache.huntable;
    if (!huntable.has(npcId)) huntable.set(npcId, isBotEligibleSourceNpcId(npcId));
    return huntable.get(npcId);
}

function stationRecipeIds() {
    return CraftShopService.publishedStationRecipes().ids;
}

// This is route evidence for the clan planner; the shared wish graph owns
// the purchases and both physical crystallizations. Only authored NPC stock
// and Luxury exchanges can establish this renewable material source.
function crystalSupplyForMaterial(state, requiredAmount, options) {
    if (Number(state.level) < 52) return null;
    const Crystals = invoke('GameServer/Bot/Economy/BotCrystallization');
    const Luxury = invoke('GameServer/Bot/Economy/BotLuxuryExchange');
    let inputs = options.sourceCache?.get('crystal_supply_inputs');
    if (inputs === undefined) {
        // The quote's native trip cost is charged once below. Executable
        // leaves still require the worker's prepared trip to Giran.
        const trip = { known: true, hours: 0, fees: 0 };
        const offers = new Map();
        const purchase = id => {
            if (!offers.has(id)) offers.set(id, npcOfferForTarget(catalogItem(id), state, options));
            const offer = offers.get(id);
            return offer?.town === 'Giran' && Number(offer.price) > 0
                ? { ...offer, availableUnits: Infinity, tripHours: 0, tripFees: 0 } : null;
        };
        const d = Crystals.choices(state, purchase, trip).find(row => row.selfId && purchase(row.selfId));
        const dOffer = d && offers.get(d.selfId);
        const choices = d ? Crystals.choices(state, id => {
            const exchange = Luxury.recipes().get(id);
            return exchange ? { price: exchange.materials[0].amount * dOffer.price / d.net,
                sourceType: 'luxury', availableUnits: Infinity, tripHours: 0, tripFees: 0 } : null;
        }, trip, 0, 'c') : [];
        inputs = d ? { d, dOffer, choices } : null;
        options.sourceCache?.set('crystal_supply_inputs', inputs);
    }
    if (!inputs) return null;
    const { d, dOffer, choices } = inputs;
    const costs = choices.filter(row => row.selfId).map(row => {
        const exchange = Luxury.recipes().get(row.selfId);
        if (!exchange) return Infinity;
        const batches = Math.ceil(requiredAmount / row.net);
        const needD = Math.max(0, exchange.materials[0].amount * batches - Number(state.inventory?.[1458]?.amount || 0));
        return Math.ceil(needD / d.net) * Number(dOffer?.price || 0);
    });
    const price = Math.min(...costs);
    if (!Number.isFinite(price)) return null;
    return { kind: 'crystal_supply', itemId: 1459, requiredAmount,
        requiredTotal: requiredAmount + Number(state.inventory?.[1459]?.amount || 0),
        effort: 16 + (price <= PurchaseFunding.spendable(state, options.buyOrderEscrow, { upperBound: true })
            ? 4 : marketEffort({ ...dOffer, price }, state)) };
}

function farmSourceForMaterial(itemId, state, spots, allowedRecipeIds, requiredAmount = 1, visited = new Set(), options = {}) {
    if (visited.has(Number(itemId))) return null;
    if (Number(itemId) === 1459) {
        const supply = crystalSupplyForMaterial(state, requiredAmount, options);
        if (supply) return supply;
    }
    const purchase = marketOfferForTarget(catalogItem(itemId), state, options);
    if (purchase && Number(purchase.price) > 0 && (purchase.sourceType === 'npc'
        || Number(purchase.count ?? purchase.amount) >= requiredAmount)) return {
        kind: 'material_market', itemId: Number(itemId), requiredAmount,
        requiredTotal: requiredAmount + Number(state.inventory?.[itemId]?.amount || 0),
        effort: Number(purchase.price) * requiredAmount <= PurchaseFunding.spendable(state, options.buyOrderEscrow, { upperBound: true })
            ? 4 : marketEffort({ ...purchase, price: Number(purchase.price) * requiredAmount }, state)
    };
    const direct = bestSourceForState(sourceForItem(itemId, spots, state, options), state, options);
    const directRoute = direct ? { ...direct, itemId: Number(itemId), requiredAmount,
        requiredTotal: requiredAmount + Number(state.inventory?.[itemId]?.amount || 0),
        effort: requiredAmount * sourceEffort(direct, state, options) } : null;
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
    const next = routes.slice().sort((left, right) => right.effort - left.effort)[0];
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

function combinationPurchase(recipe, state, options = {}) {
    if (!C4DualSwordCombinations.isCombination(recipe)) return null;
    const materials = missingMaterials(recipe, state.inventory);
    const purchases = [];
    for (const material of materials.filter(entry => entry.missing > 0)) {
        const item = catalogItem(material.selfId);
        const offer = options.npcOnly
            ? npcOfferForTarget(item, state, options) : marketOfferForTarget(item, state, options);
        if (!offer || offer.available === false || Number(offer.count ?? Infinity) < material.missing) return null;
        purchases.push({ material, item, offer });
    }
    return { materials, purchases,
        cost: purchases.reduce((sum, entry) => sum + Number(entry.offer.price) * entry.material.missing, 0) };
}

function dualSwordBridgePlan(state, options = {}) {
    if (!missingRequiredDualSword(state)) return null;
    const role = roleFor(state);
    const maxRank = rankIndex(Progression.acquisitionRankFor(state));
    const excluded = excludedTargetIds(options);
    const offers = new Map();
    const purchaseOptions = { ...options, npcOnly: true, findNpcOffer: item => {
        if (!offers.has(item.selfId)) offers.set(item.selfId, npcOfferForTarget(item, state, options));
        return offers.get(item.selfId);
    } };
    const candidates = C4DualSwordCombinations.loadRecipes().filter(recipe => Sources.allowsRecipe(recipe)).flatMap(recipe => {
        const item = catalogItem(recipe.productId);
        if (!item || rankIndex(item.etc?.rank) > maxRank || excluded.has(Number(item.selfId))
            || !suitable(item, state, role, item.etc?.rank)) return [];
        const purchase = combinationPurchase(recipe, state, purchaseOptions);
        return purchase ? [{ item, recipe, ...purchase }] : [];
    }).sort((left, right) => left.cost - right.cost
        || itemScore(right.item, role, classIdFor(state)) - itemScore(left.item, role, classIdFor(state))
        || Number(left.item.selfId) - Number(right.item.selfId));
    // A started combination is kept: its first blade may already be owned.
    const previousId = Number(state.stats?.equipmentPlan?.weaponBridge && state.stats.equipmentPlan.combine?.resultId);
    const { spendable } = npcPurchaseBudget(state, options);
    const target = chooseBridge(candidates, spendable, Math.min(maxRank, rankIndex('c')), previousId);
    if (!target) return null;
    const common = { weaponBridge: true, partyNeedReason: 'weapon_bridge', bridgeCost: target.cost,
        grade: target.item.etc.rank, combine: combinationMetadata(target.recipe) };
    if (target.purchases.length) {
        const { item, offer } = target.purchases[0];
        return { ...marketPlan(state, item, offer, { buyOrderEscrow: options.buyOrderEscrow }),
            materials: target.materials, ...common };
    }
    return { status: 'ready_to_craft', strategy: 'craft', role, phase: GearLifecycle.phaseFor(state),
        target: { selfId: Number(target.item.selfId), name: target.item.template.name, slot: Number(target.item.etc.slot) },
        recipeId: target.recipe.recipeId, materials: target.materials, next: null,
        soloSafe: true, requiresParty: false, partyNeed: 'solo_ok', expectedKills: 0,
        rateModelVersion: RATE_MODEL_VERSION, ...common };
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
            reserve: operationalAdenaReserve(state, planningOptions.buyOrderEscrow)
        }),
        grade: String(target.item.etc?.rank || gradeForLevel(state.level)).toLowerCase(),
        materials,
        combine
    };
}

function rawPlanFor(state = {}, options = {}) {
    if (options.wishTargetId && !Sources.hasSource(options.wishTargetId)
        || options.recipeId && !Sources.allowsRecipe(options.recipeId)) return {
        status: 'blocked', reason: 'unsupported_item_source', strategy: 'none', target: null,
        recipeId: null, materials: [], next: null
    };
    if (isCraftService(state)) {
        return { status: 'service', strategy: 'none', recipeId: null, materials: [], next: null };
    }
    if (!options.wishTargetId && !GearLifecycle.isGearFocusActive(state)) {
        return {
            status: 'deferred',
            phase: GearLifecycle.phaseFor(state),
            strategy: 'none',
            recipeId: null,
            materials: [],
            next: null
        };
    }
    if (!options.recipeId && missingRequiredDualSword(state)) {
        const bridge = npcWeaponBridgePlan(state, options);
        if (bridge) return bridge;
    }
    const planningOptions = {
        ...options,
        allowedRecipeIds: options.allowedRecipeIds || stationRecipeIds(),
        recipeCatalog: options.craftRecipes ? new Map(options.craftRecipes.filter(recipe => Sources.allowsRecipe(recipe)).map(recipe =>
            [Number(recipe.productId), require('../../Clan/ClanCraftingPolicy').recipeForProvider(recipe, options.craftProviders?.[recipe.recipeId])])) : null,
        sourceCache: options.sourceCache || new Map()
    };
    const preparedTarget = !options.recipeId && (options.wishTargetId || rankIndex(gradeForLevel(state.level)) > rankIndex('d'))
        ? preferredTarget(state, planningOptions)
        : null;
    const preparedCraftReady = preparedTarget?.recipe
        && missingMaterials(preparedTarget.recipe, state.inventory)
            .every((material) => material.missing <= 0 || CraftSupplementMaterials.isSupplementalMaterial(material.selfId));
    const forcedMarketPlan = marketRecoveryPlanForTarget(state, options.forceMarketTargetId, options);
    if (forcedMarketPlan) return forcedMarketPlan;
    if (!options.recipeId && !options.wishTargetId && !preparedCraftReady) {
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
        const target = preparedTarget?.item || preferredNoGradeTarget(state, planningOptions) || preferredDropTarget(state, planningOptions);
        const source = target
            ? bestSourceForState(sourceForItem(target.selfId, planningOptions.spots || [], state, planningOptions), state, planningOptions)
            : null;
        const offer = marketOfferForTarget(target, state, planningOptions);
        const directEffort = source ? sourceEffort(source, state, planningOptions) : Infinity;
        const buy = offer && marketEffort(offer, state) <= directEffort;
        const sourceAssessment = source ? partyNeedAssessmentForSource(state, source) : null;
        return target && buy ? {
            status: 'active', phase: GearLifecycle.phaseFor(state), grade: 'none', role: roleFor(state), strategy: 'market', soloSafe: true, requiresParty: false,
            rateModelVersion: RATE_MODEL_VERSION,
            expectedKills: Math.ceil(marketEffort(offer, state)),
            target: { selfId: Number(target.selfId), name: target.template?.name || `Item ${target.selfId}`, slot: Number(target.etc?.slot || 0) },
            market: marketTerms(state, offer, { buyOrderEscrow: planningOptions.buyOrderEscrow }),
            recipeId: null, materials: [], next: null
        } : source ? {
            status: 'active', grade: 'none', role: roleFor(state), strategy: 'direct_drop', soloSafe: sourceAssessment.need === 'solo_ok',
            partyNeed: sourceAssessment.need,
            partyNeedReason: sourceAssessment.reason,
            requiresParty: sourceAssessment.need === 'required',
            rateModelVersion: RATE_MODEL_VERSION,
            expectedKills: Math.ceil(1 / Math.max(source.expectedYield, 0.000001)),
            expectedEffort: Math.ceil(directEffort),
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
    const directEffort = direct ? sourceEffort(direct, state, planningOptions) : Infinity;
    const craftKills = target.recipe
        ? missingMaterialPlans.reduce((sum, material) => sum + (material.source?.effort ?? Infinity), 0)
        : Infinity;
    const offer = marketOfferForTarget(target.item, state, planningOptions);
    const clanRaid = options.clanCrafting && direct?.raidBoss === true;
    const craftFirst = !clanRaid && rankIndex(target.item.etc?.rank) >= 3 && target.recipe && Number.isFinite(craftKills);
    const buy = offer && !craftFirst && marketEffort(offer, state) <= Math.min(directEffort, craftKills);
    const directAssessment = direct ? partyNeedAssessmentForSource(state, direct) : null;
    const soloSafe = direct && directAssessment.need === 'solo_ok';
    const strategy = buy ? 'market'
        : direct && (!target.recipe || !Number.isFinite(craftKills) || !craftFirst && (soloSafe || clanRaid) && directEffort <= craftKills * 0.8) ? 'direct_drop'
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
    const nextAssessment = !readyToCraft && !componentReady && next?.spotId
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
        target: { selfId: Number(target.item.selfId), name: target.item.template?.name || `Item ${target.item.selfId}`, slot: Number(target.slot || target.item.etc?.slot || 0) },
        recipeId: target.recipe ? Number(target.recipe.recipeId) : null,
        strategy,
        soloSafe,
        partyNeed,
        partyNeedReason,
        requiresParty,
        expectedKills: next ? Math.ceil(strategy === 'direct_drop' ? directKills : craftKills) : 0,
        expectedEffort: next ? Math.ceil(strategy === 'direct_drop' ? directEffort : craftKills) : 0,
        market: buy ? marketTerms(state, offer, { buyOrderEscrow: planningOptions.buyOrderEscrow }) : null,
        materials: materialPlans.map(({ source, ...material }) => ({
            ...material,
            sourceSpotId: source?.spotId || null
        })),
        next: next ? { spotId: next.spotId, npcId: next.npcId, npcName: next.npcName, kind: next.kind,
            sourceKind: next.sourceKind || next.kind, raidBoss: next.raidBoss === true,
            sharedEncounter: next.sharedEncounter === true,
            raidRosterSize: Number(next.raidRosterSize || 0) || null,
            raidEstimate: next.raidEstimate || null,
            raidBossTemplateId: Number(next.raidBossTemplateId || 0) || null,
            itemId: next.itemId, amount: next.requiredAmount || 1, requiredTotal: next.requiredTotal } : null,
        ...(combine ? { combine } : {})
    };
}

function planFor(state = {}, options = {}) {
    const recovery = options.levelingRecovery || levelingRecoveryFor(state, state.stats?.equipmentPlan, options.timestamp);
    if (recovery) return levelingRecoveryPlan(state, recovery);
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

// Each such external call is one planner decision: the outermost one opens the
// readiness scope and closes it on return, so no result outlives the call.
function readinessScoped(fn) {
    return function scopedPlannerCall(...args) {
        if (readinessScope) return fn.apply(this, args);
        readinessScope = new WeakMap();
        try {
            return fn.apply(this, args);
        } finally {
            readinessScope = null;
        }
    };
}

module.exports = { equipmentCandidate, equipmentItemBetter, RATE_MODEL_VERSION, DIRECT_FAILURE_RESOLVE_LIMIT, PARTY_ROUTE_FAILURE_ATTEMPT_LIMIT, gradeForLevel, isCraftService, roleFor, itemScore, isRealCatalogItem, suitable, considerable, isSlotUpgrade, combatReadiness, progressionPriceCap, operationalAdenaReserve, equippedSlotsFor, equipInventoryUpgrades, preferredTarget, preferredDropTarget, preferredNoGradeTarget, marketOfferForTarget, marketPlanForTarget, fundedMarketPlanForTarget, marketRecoveryPlanForTarget, staticNpcUpgradePlan, staticNpcKitAdequate, npcWeaponBridgePlan, npcEquipmentBridgePlan, equipmentBridgeReason, itemDropChance, itemDropYield, sourceIndexFor, partyNeedForSource, partyNeedReasonForSource, soloSafeForSource, sourceEffort, sourceWithinVoluntaryHuntBand, bestSourceForState, bestSourceForPlan, safeFallbackForPlan, retargetPlanSource, replacementPlanFor, sourceForItem, farmSourceForMaterial, missingMaterials, directPlanFailure, partyRouteFailure, abandonAcquisition, replanContextFor, levelingRecoveryFor, rateProfileSignature, withinExpectedKillLimit, isBotEligibleSourceNpcId, isPlanSourceEligible, isPlanSourceViableForState, isClanOwnedPlan, equipmentTargetFulfilled, clanGoalPlanLocked, finalizePlan, planFor, shouldFinishPreviousPlan, scoreSpot, sameObjective };

// One decision outside this module (a wish review) that judges a bot against
// many sources shares its readiness the same way.
function withReadiness(fn) {
    return readinessScoped(fn)();
}
module.exports.withReadiness = withReadiness;
module.exports.acquisitionTargetAllowed = acquisitionTargetAllowed;
module.exports.sourceCacheSize = sourceCacheSize;
module.exports.sourceYieldReaderFor = sourceYieldReaderFor;
module.exports.sourceFacts = sourceFacts;
module.exports.sourceRouteReader = sourceRouteReader;
module.exports.sourceGround = sourceGround;

// Only the exports that judge a bot against several sources share readiness.
for (const name of ['preferredTarget', 'preferredDropTarget', 'preferredNoGradeTarget', 'staticNpcUpgradePlan',
    'staticNpcKitAdequate', 'npcWeaponBridgePlan', 'npcEquipmentBridgePlan', 'sourceEffort', 'bestSourceForState',
    'bestSourceForPlan', 'safeFallbackForPlan', 'retargetPlanSource', 'replacementPlanFor', 'sourceForItem',
    'farmSourceForMaterial', 'planFor']) {
    module.exports[name] = readinessScoped(module.exports[name]);
}
