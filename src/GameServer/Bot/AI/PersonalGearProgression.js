'use strict';

const GearLifecycle = require('./GearLifecycle');
const Data = invoke('GameServer/DataCache');
const Index = invoke('GameServer/Item/ItemTemplateIndex');
const StarterItemCatalog = require('../../Knowledge/StarterItemCatalog');
const { GRADES: RANKS } = invoke('GameServer/Bot/AI/GearGradeRule');
function adventurer(state = {}) {
    return !state.stats?.craftStationId
        && !(state.activity === 'crafting' && state.stats?.craftShop
            && Number(state.stats?.generatedIndex) >= 10000);
}
function personal(state = {}) {
    return adventurer(state) && !invoke('GameServer/Clan/ClanSupplyPolicy').hasWarehouse(state);
}

// A milestone describes a usable kit, not a particular shopping list. The
// shared wish solver still compares buying, earning cash, drops and crafting.
function assess(state = {}, minimumRank = null) {
    // Clan custody changes where surplus goes, not the member's need for a
    // working kit. Its own wallet and native sources still fund equipment.
    if (!adventurer(state)) return { required: false, gaps: new Map() };
    const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
    const Gear = invoke('GameServer/Bot/AI/BotGear');
    const Compatibility = invoke('GameServer/Bot/AI/BotEquipmentCompatibility');
    const classId = Number(state.stats?.classId ?? state.classId ?? 0), role = Planner.roleFor(state);
    const level = Math.max(1, Number(state.level) || 1);
    const baseline = Gear.planFor({ classId, level: minimumRank === 3 ? 52 : level < 20 ? 10 : level < 40 ? 20 : 40 });
    const starters = StarterItemCatalog.ids(Data.newbieItems, true);
    const equipped = new Map();
    for (const row of Object.values(state.inventory || {})) {
        const item = Index.find(Data.items, row.selfId);
        if (!item || !Planner.equipmentCandidate(item, state, role)) continue;
        for (const slot of Planner.equippedSlotsFor(row, item.etc?.slot)) equipped.set(slot, item);
    }
    const weapon = equipped.get(7) || equipped.get(14);
    const twoHanded = !!equipped.get(14);
    const rank = minimumRank ?? (level >= 40 ? 2 : level >= 20 ? 1 : 0);
    const gaps = new Map();
    for (const entry of baseline.items) {
        const slot = Number(entry.slot);
        if (slot === 8 && twoHanded) continue;
        let current = Compatibility.isWeaponSlot(slot) ? weapon
            : equipped.get(slot) || ([10, 11].includes(slot) ? equipped.get(15) : null);
        if (slot === 15 && !current && equipped.has(10) && equipped.has(11)) {
            const chest = equipped.get(10), legs = equipped.get(11);
            current = { selfId: chest.selfId, starterKit: starters.has(Number(chest.selfId)) || starters.has(Number(legs.selfId)),
                etc: { slot: 15, rank: RANKS[Math.min(RANKS.indexOf(chest.etc?.rank || 'none'),
                    RANKS.indexOf(legs.etc?.rank || 'none'))], mp: Number(chest.etc?.mp || 0) + Number(legs.etc?.mp || 0) },
                stats: { pDef: Number(chest.stats?.pDef || 0) + Number(legs.stats?.pDef || 0) } };
        }
        const reference = Index.find(Data.items, entry.selfId);
        const minScore = level < 20 && reference ? Planner.itemScore(reference, role, classId) : 0;
        const empty = !current;
        // A usable NG weapon still owes its first D upgrade from level 20.
        // Keep that attainable floor when the bot reaches C+; the common
        // solver may buy D now or close it directly with a ready higher grade.
        const missedWeaponGrade = level >= 20 && Compatibility.isWeaponSlot(slot)
            && (!current || RANKS.indexOf(current.etc?.rank || 'none') < 1);
        const requiredRank = missedWeaponGrade ? 1 : rank;
        const inadequate = current && (RANKS.indexOf(current.etc?.rank || 'none') < requiredRank
            || level < 20 && (current.starterKit || starters.has(Number(current.selfId))
                || Planner.itemScore(current, role, classId) < minScore));
        // From C expertise, finish the working weapon and armour before
        // jewellery. Empty jewellery does not outrank an under-grade weapon.
        const priority = level >= 40 && slot === 6 ? 0 : missedWeaponGrade ? 3 : level >= 40
            ? GearLifecycle.slotPriority(slot)
            : empty ? Compatibility.isWeaponSlot(slot) ? 3 : 2 : 1;
        if (empty || inadequate) gaps.set(slot, { slot, rank: requiredRank, minScore,
            priority });
    }
    // C helmets have no Luxury exchange. Keep the opportunity without
    // holding the working kit, earning routes or higher grades behind it.
    return { required: [...gaps.values()].some(gap => gap.priority > 0), gaps, starters, role, classId, rank };
}

// A caller that already holds the plain assessment (or this one) passes it:
// the gear loops ask per item, the assessment is per bot.
function acquisitionAssessment(state = {}, current = assess(state)) {
    return current.required || Number(state.level) < 52 ? current : assess(state, 3);
}
function marketOnly(state, item, assessment = null) {
    return Number(item?.etc?.slot) > 0 && RANKS.indexOf(item.etc.rank) >= 4 && (assessment || acquisitionAssessment(state)).required;
}

function isCGradeHelmet(item) {
    return item?.etc?.rank === 'c' && Number(item.etc.slot) === 6;
}

// Expertise permits wearing higher grades, but acquisition first closes every
// usable C slot. Already worn higher-grade pieces also satisfy that milestone.
function acquisitionRankFor(state = {}, assessment = null) {
    const rank = invoke('GameServer/Bot/AI/GearAcquisitionPlanner').gradeForLevel(state.level);
    // The assessment can only lower the ceiling to its own rank, which is the
    // level's grade up to C: at or under C the level's grade is the answer.
    if (!assessment && RANKS.indexOf(rank) <= 2) return rank;
    const current = assessment || assess(state);
    return current.required && RANKS.indexOf(rank) > (current.rank || 2) ? RANKS[current.rank || 2] : rank;
}

function gapFor(slot, assessment) {
    return assessment.gaps.get(Number(slot))
        || (GearLifecycle.slotPriority(slot) === 3 ? assessment.gaps.get(7) || assessment.gaps.get(14)
            : Number(slot) === 15 ? assessment.gaps.get(10) || assessment.gaps.get(11)
            : [10, 11].includes(Number(slot)) ? assessment.gaps.get(15) : null);
}
function priority(item, slot, assessment) {
    const gap = gapFor(slot, assessment);
    if (!gap) return 0;
    const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
    if (RANKS.indexOf(item.etc?.rank || 'none') < gap.rank) return 0;
    if (gap.rank === 0 && (assessment.starters.has(Number(item.selfId))
        || Planner.itemScore(item, assessment.role, assessment.classId) < gap.minScore)) return 0;
    return gap.priority;
}

// Preparation changes the acquisition ceiling, never the wear/expertise rule.
// The future bag is short lived and uses the same class, paired-slot and armor
// selection as a physical inventory reconciliation at PREPARED_LEVEL; its
// grade is the lifted ceiling, read without building that bag.
const PREPARED_LEVEL = 40;
function preparing(state, assessment) {
    if (!personal(state) || state.level < 20 || state.level >= PREPARED_LEVEL) return false;
    return !(assessment || assess(state)).required;
}
function preparation(state, assessment) {
    return preparing(state, assessment) ? futureState(state) : null;
}
// Warehouse custody does not remove the member's own C acquisition sources.
// Early preparation keeps its existing personal-owner boundary.
function allowsCGradeAcquisition(state) {
    return adventurer(state) && (Number(state.level) >= 40 || personal(state));
}
function futureState(state) {
    const exp = Number(Data.experience[PREPARED_LEVEL - 1]);
    const next = { ...state, level: PREPARED_LEVEL, exp, stats: { ...state.stats, exp } };
    next.inventory = invoke('GameServer/Bot/AI/GearAcquisitionPlanner').equipInventoryUpgrades(next, state.inventory);
    return next;
}
function preparedAmounts(state) {
    if (!personal(state) || state.level < 20 || state.level >= PREPARED_LEVEL) return {};
    if (!Object.values(state.inventory || {}).some(row => Number(row.amount) > 0
        && Index.find(Data.items, row.selfId)?.etc?.rank === 'c')) return {};
    const reserved = {};
    for (const row of Object.values(futureState(state).inventory)) {
        if (Index.find(Data.items, row.selfId)?.etc?.rank === 'c' && row.equippedCount > 0)
            reserved[row.selfId] = Number(row.equippedCount);
    }
    return reserved;
}

module.exports = { personal, adventurer, assess, acquisitionAssessment, marketOnly, acquisitionRankFor, gapFor, priority, PREPARED_LEVEL, preparing, preparation, preparedAmounts, allowsCGradeAcquisition, isCGradeHelmet };
