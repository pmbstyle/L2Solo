'use strict';

const RANKS = ['none', 'd', 'c', 'b', 'a', 's'];
function personal(state = {}) {
    return !(Number(state.clanId ?? state.stats?.clanId) > 0)
        && !state.stats?.craftStationId
        && !(state.activity === 'crafting' && state.stats?.craftShop
            && Number(state.stats?.generatedIndex) >= 10000);
}

// A milestone describes a usable kit, not a particular shopping list. The
// shared wish solver still compares buying, earning cash, drops and crafting.
function assess(state = {}) {
    if (!personal(state)) return { required: false, gaps: new Map() };
    const Data = invoke('GameServer/DataCache');
    const Index = invoke('GameServer/Item/ItemTemplateIndex');
    const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
    const Gear = invoke('GameServer/Bot/AI/BotGear');
    const Compatibility = invoke('GameServer/Bot/AI/BotEquipmentCompatibility');
    const classId = Number(state.stats?.classId ?? state.classId ?? 0), role = Planner.roleFor(state);
    const level = Math.max(1, Number(state.level) || 1);
    if (level >= 40) return { required: false, gaps: new Map() };
    const baseline = Gear.planFor({ classId, level: level < 20 ? 10 : 20 });
    const starters = new Set((Data.newbieItems || []).flatMap(row => row.items || [])
        .filter(row => row.equipped).map(row => Number(row.selfId)));
    const equipped = new Map();
    for (const row of Object.values(state.inventory || {})) {
        const item = Index.find(Data.items, row.selfId);
        if (!item || !Planner.equipmentCandidate(item, state, role)) continue;
        for (const slot of Planner.equippedSlotsFor(row, item.etc?.slot)) equipped.set(slot, item);
    }
    const weapon = equipped.get(7) || equipped.get(14);
    const twoHanded = !!equipped.get(14);
    const rank = level >= 20 ? 1 : 0;
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
        const inadequate = current && (RANKS.indexOf(current.etc?.rank || 'none') < rank
            || level < 20 && (current.starterKit || starters.has(Number(current.selfId))
                || Planner.itemScore(current, role, classId) < minScore));
        if (empty || inadequate) gaps.set(slot, { slot, rank, minScore,
            priority: empty ? Compatibility.isWeaponSlot(slot) ? 3 : 2 : 1 });
    }
    return { required: gaps.size > 0, gaps, starters, role, classId };
}

function priority(item, slot, assessment) {
    const gap = assessment.gaps.get(Number(slot))
        || (Number(slot) === 15 ? assessment.gaps.get(10) || assessment.gaps.get(11)
            : [10, 11].includes(Number(slot)) ? assessment.gaps.get(15) : null);
    if (!gap) return 0;
    const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
    if (RANKS.indexOf(item.etc?.rank || 'none') < gap.rank) return 0;
    if (gap.rank === 0 && (assessment.starters.has(Number(item.selfId))
        || Planner.itemScore(item, assessment.role, assessment.classId) < gap.minScore)) return 0;
    return gap.priority;
}

module.exports = { personal, assess, priority };
