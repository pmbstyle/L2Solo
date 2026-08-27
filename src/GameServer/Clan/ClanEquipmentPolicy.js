function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

const PLAN_STATUSES = new Set(['active', 'blocked', 'component_ready', 'ready_to_craft']);
const GRADE_RANK = Object.freeze({ none: 0, d: 1, c: 2, b: 3, a: 4, s: 5 });
const ROLE_PRIORITY = Object.freeze({
    tank: 45,
    healer: 40,
    buffer: 20,
    dps: 8,
    mage: 8,
    crafter: 4,
    spoiler: 4
});

function memberId(member) {
    return number(member?.characterId ?? member?.id);
}

function hasTarget(plan) {
    return number(plan?.target?.selfId) > 0 && number(plan?.target?.slot) > 0;
}

function isAcquisitionPlan(plan) {
    return PLAN_STATUSES.has(String(plan?.status || '')) && hasTarget(plan);
}

function routeFor(plan) {
    if (plan?.strategy === 'craft') return 'craft';
    if (plan?.strategy === 'market') return 'market';
    if (plan?.strategy === 'direct_drop') return 'farm';
    return 'prepare';
}

function planPriority(plan) {
    const statusPriority = {
        ready_to_craft: 500,
        component_ready: 450,
        active: 400,
        blocked: 300
    };
    return (statusPriority[String(plan?.status || '')] || 0)
        + Math.min(100, Math.max(0, number(plan?.expectedKills) / 10));
}

function rankFor(value) {
    return GRADE_RANK[String(value || 'none').toLowerCase()] || 0;
}

function memberRole(member, options = {}) {
    if (typeof options.roleFor === 'function') return String(options.roleFor(member) || 'dps');
    return String(member?.stats?.role || member?.party?.role || 'dps');
}

function equippedItems(member) {
    const summarized = Array.isArray(member?.stats?.equipment) ? member.stats.equipment : [];
    if (summarized.length) return summarized;
    return Object.values(member?.inventory || {}).filter((item) => item?.equipped);
}

function itemSlots(item) {
    if (Array.isArray(item?.equippedSlots) && item.equippedSlots.length) return item.equippedSlots.map(Number);
    const slot = number(item?.slot ?? item?.etc?.slot);
    return slot > 0 ? [slot] : [];
}

function itemRank(item) {
    return rankFor(item?.rank ?? item?.etc?.rank ?? item?.template?.rank);
}

function slotMatches(left, right) {
    return left === right
        || [7, 14].includes(left) && [7, 14].includes(right)
        || left === 15 && [10, 11].includes(right);
}

function equipmentPriority(member, plan, options = {}) {
    const items = equippedItems(member);
    const targetSlot = number(plan?.target?.slot);
    const targetRank = rankFor(plan?.grade);
    const currentTargetRank = items.reduce((best, item) => (
        itemSlots(item).some((slot) => slotMatches(slot, targetSlot))
            ? Math.max(best, itemRank(item))
            : best
    ), 0);
    const representedSlots = new Set(items.flatMap(itemSlots).filter((slot) => slot > 0));
    const overallStrength = items.reduce((sum, item) => sum + itemRank(item), 0);
    const expectedStrength = Math.max(1, targetRank) * 8;
    const overallDebt = Math.max(0, expectedStrength - overallStrength);
    const targetDebt = Math.max(1, targetRank - currentTargetRank);
    const missingTargetSlot = ![...representedSlots].some((slot) => slotMatches(slot, targetSlot));
    const readiness = {
        ready_to_craft: 24,
        component_ready: 14,
        active: 8,
        blocked: -100
    }[String(plan?.status || '')] || 0;
    const role = memberRole(member, options);
    return targetDebt * 100
        + overallDebt * 5
        + (missingTargetSlot ? 20 : 0)
        + (ROLE_PRIORITY[role] || 0)
        + readiness;
}

function goalKey(clanId, member, plan) {
    return [
        'clan-equipment',
        number(clanId),
        memberId(member),
        number(plan?.target?.selfId),
        number(plan?.target?.slot)
    ].join(':');
}

function targetFulfilled(member, goal, equippedSlotsFor, itemRankFor = null) {
    const itemId = number(goal?.target?.itemId);
    const slot = number(goal?.target?.slot);
    const item = member?.inventory?.[String(itemId)];
    if (!itemId || !slot || typeof equippedSlotsFor !== 'function') return false;
    if (item?.equipped && equippedSlotsFor(item, item.slot).some((equippedSlot) => (
        slotMatches(equippedSlot, slot)
    ))) return true;

    // An equipment goal represents a slot debt, not a trophy request for one
    // exact item. If another path has already equipped a strictly higher-rank
    // item in that slot, the old goal is fulfilled and must rotate instead of
    // repeatedly trying to buy an already-owned weaker item. This notably
    // covers full-body armour satisfying chest and legs goals.
    const catalogItem = typeof itemRankFor === 'function' ? itemRankFor(itemId) : null;
    const targetRank = itemRank(item) || (catalogItem && typeof catalogItem === 'object'
        ? itemRank(catalogItem)
        : rankFor(catalogItem));
    if (!targetRank) return false;
    return equippedItems(member).some((equipped) => (
        itemSlots(equipped).some((equippedSlot) => slotMatches(equippedSlot, slot))
        && itemRank(equipped) > targetRank
    ));
}

function selectTargetMember(members = [], plans = new Map(), previousGoal = null, options = {}) {
    const previousMemberId = number(previousGoal?.target?.memberId);
    const previousMember = members.find((member) => memberId(member) === previousMemberId);
    const previousPlan = plans.get(previousMemberId);

    const ranked = members
        .filter((member) => member?.phase === 'cold'
            && (!member?.partyId || memberId(member) === previousMemberId))
        .map((member) => {
            const plan = plans.get(memberId(member));
            return { member, plan, priority: equipmentPriority(member, plan, options) };
        })
        .filter((entry) => isAcquisitionPlan(entry.plan))
        .sort((left, right) => (
            right.priority - left.priority
            || planPriority(right.plan) - planPriority(left.plan)
            || number(left.member.level) - number(right.member.level)
            || memberId(left.member) - memberId(right.member)
        ));
    const selected = ranked[0] || null;
    if (!selected) return null;

    // Keep a current beneficiary only while its equipment debt is at least as
    // important as the best alternative. This gives a nearly-finished craft a
    // small stability bonus, but lets a weaker tank/healer or a materially
    // worse-equipped member take over at the next clan review.
    if (previousMember && isAcquisitionPlan(previousPlan)
        && previousPlan.status !== 'blocked'
        && previousGoal?.status !== 'completed'
        && !options.previousFulfilled) {
        const previousPriority = equipmentPriority(previousMember, previousPlan, options);
        if (memberId(selected.member) === previousMemberId || previousPriority >= selected.priority) {
            return { member: previousMember, plan: previousPlan, priority: previousPriority, preserved: true };
        }
    }
    return {
        ...selected,
        rotated: previousMemberId > 0 && previousMemberId !== memberId(selected.member),
        previousMemberId: previousMemberId || null
    };
}

function buildGoal(clan, selection, previousGoal = null, timestamp = Date.now(), options = {}) {
    if (!selection?.member || !selection?.plan) return null;
    const member = selection.member;
    const plan = selection.plan;
    const memberIdValue = memberId(member);
    const itemId = number(plan.target?.selfId);
    const sameTarget = previousGoal?.type === 'equipment'
        && number(previousGoal.target?.memberId) === memberIdValue
        && number(previousGoal.target?.itemId) === itemId
        && number(previousGoal.target?.slot) === number(plan.target?.slot);
    const route = routeFor(plan);
    const status = plan.status === 'blocked'
        ? 'blocked'
        : ['active', 'ready_to_craft', 'component_ready'].includes(plan.status)
            ? 'executing'
            : 'preparing';

    return {
        type: 'equipment',
        target: {
            memberId: memberIdValue,
            memberName: String(member.name || ''),
            memberLevel: number(member.level),
            itemId,
            itemName: String(plan.target?.name || `Item ${itemId}`),
            slot: number(plan.target?.slot),
            grade: String(plan.grade || 'none'),
            strategy: String(plan.strategy || 'unknown')
        },
        required: 1,
        progress: 0,
        plan: {
            kind: route,
            sourceId: number(plan.next?.npcId) || null,
            beneficiaryId: memberIdValue,
            selectedAt: timestamp,
            reasonCode: `clan_equipment_${route}`
        },
        assignedMemberIds: Array.isArray(options.assignedMemberIds) && options.assignedMemberIds.length
            ? [...new Set(options.assignedMemberIds.map(number).filter(Boolean))]
            : [memberIdValue],
        partyId: null,
        catastrophicFailures: sameTarget ? number(previousGoal.catastrophicFailures) : 0,
        status,
        reasonCodes: [`clan_equipment_${route}`],
        goalKey: goalKey(clan.id, member, plan),
        priorityScore: number(selection.priority),
        beneficiaryRole: String(options.roleFor?.(member) || member?.stats?.role || 'dps'),
        createdAt: sameTarget ? number(previousGoal.createdAt, timestamp) : timestamp,
        updatedAt: timestamp
    };
}

module.exports = {
    PLAN_STATUSES,
    buildGoal,
    goalKey,
    hasTarget,
    isAcquisitionPlan,
    equipmentPriority,
    planPriority,
    routeFor,
    selectTargetMember,
    targetFulfilled
};
