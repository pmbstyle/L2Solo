function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

const PLAN_STATUSES = new Set(['active', 'blocked', 'component_ready', 'ready_to_craft']);

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

function goalKey(clanId, member, plan) {
    return [
        'clan-equipment',
        number(clanId),
        memberId(member),
        number(plan?.target?.selfId),
        number(plan?.target?.slot)
    ].join(':');
}

function targetFulfilled(member, goal, equippedSlotsFor) {
    const itemId = number(goal?.target?.itemId);
    const slot = number(goal?.target?.slot);
    const item = member?.inventory?.[String(itemId)];
    if (!item?.equipped || !itemId || !slot || typeof equippedSlotsFor !== 'function') return false;
    return equippedSlotsFor(item, item.slot).some((equippedSlot) => (
        equippedSlot === slot
        || [7, 14].includes(equippedSlot) && [7, 14].includes(slot)
    ));
}

function selectTargetMember(members = [], plans = new Map(), previousGoal = null, options = {}) {
    const previousMemberId = number(previousGoal?.target?.memberId);
    const previousMember = members.find((member) => memberId(member) === previousMemberId);
    const previousPlan = plans.get(previousMemberId);

    // One clan goal owns one beneficiary until the item is actually equipped.
    // This prevents a replan from jumping to another member while the current
    // member is still waiting for a drop, craft, or market purchase.
    if (previousMember && isAcquisitionPlan(previousPlan)
        && previousPlan.status !== 'blocked'
        && previousGoal?.status !== 'completed'
        && !options.previousFulfilled) {
        return { member: previousMember, plan: previousPlan, preserved: true };
    }

    return members
        .filter((member) => member?.phase === 'cold' && !member?.partyId)
        .map((member) => ({ member, plan: plans.get(memberId(member)) }))
        .filter((entry) => isAcquisitionPlan(entry.plan))
        .sort((left, right) => (
            planPriority(right.plan) - planPriority(left.plan)
            || number(left.member.level) - number(right.member.level)
            || memberId(left.member) - memberId(right.member)
        ))[0] || null;
}

function buildGoal(clan, selection, previousGoal = null, timestamp = Date.now()) {
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
        assignedMemberIds: [memberIdValue],
        partyId: null,
        catastrophicFailures: sameTarget ? number(previousGoal.catastrophicFailures) : 0,
        status,
        reasonCodes: [`clan_equipment_${route}`],
        goalKey: goalKey(clan.id, member, plan),
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
    planPriority,
    routeFor,
    selectTargetMember,
    targetFulfilled
};
