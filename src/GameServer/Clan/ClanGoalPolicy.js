const ClanPolicy = invoke('GameServer/Clan/ClanSimulationPolicy');
const Contracts = invoke('GameServer/Clan/ClanSimulationContracts');
const Config = invoke('GameServer/Clan/ClanSimulationConfig');

function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function uniqueIds(values = []) {
    return [...new Set((values || []).map((value) => number(value)).filter(Boolean))].sort((a, b) => a - b);
}

function roleRank(role) {
    return { tank: 0, healer: 1, buffer: 2, dps: 3, mage: 4, crafter: 5, spoiler: 6 }[role] ?? 9;
}

function operationAvailable(member) {
    return member?.phase === 'cold'
        && !member?.partyId
        && String(member?.simulationOwner || 'legacy_main') === 'legacy_main';
}

function operationMembers(members = [], limit = Config.operationMaxMembers) {
    const ranked = members
        .filter(operationAvailable)
        .map((member) => ({
            member,
            role: ClanPolicy.rosterRole(member),
            level: number(member.level),
            id: number(member.characterId ?? member.id)
        }))
        .sort((left, right) => roleRank(left.role) - roleRank(right.role)
            || right.level - left.level
            || left.id - right.id);
    const maxMembers = Math.max(1, Math.min(9, number(limit, Config.operationMaxMembers)));
    const selected = [];
    const selectedIds = new Set();
    ['tank', 'healer', 'buffer'].forEach((role) => {
        const entry = ranked.find((candidate) => candidate.role === role && !selectedIds.has(candidate.id));
        if (!entry || selected.length >= maxMembers) return;
        selected.push(entry);
        selectedIds.add(entry.id);
    });
    ranked.forEach((entry) => {
        if (selected.length >= maxMembers || selectedIds.has(entry.id)) return;
        selected.push(entry);
        selectedIds.add(entry.id);
    });
    return selected.map((entry) => entry.id);
}

function hasReadyRoles(members = []) {
    const available = members.filter(operationAvailable);
    const roles = new Set(available.map((member) => ClanPolicy.rosterRole(member)));
    return available.length >= Config.operationMinMembers
        && roles.has('tank') && roles.has('healer') && roles.has('buffer');
}

function planReason(plan, context = {}) {
    if (plan === 'warehouse') return context.progress >= context.required ? Contracts.REASON_CODES.GOAL_COMPLETED : 'warehouse_progress';
    if (plan === 'market') return context.marketOffer ? 'market_offer_available' : 'market_demand_open';
    if (plan === 'craft') return 'craft_ready';
    if (plan === 'farm') return 'party_ready';
    return Contracts.REASON_CODES.PARTY_NOT_READY;
}

function planCandidates(goal, context = {}, options = {}) {
    const avoid = new Set((options.avoidPlans || []).map(String));
    if (context.progress >= context.required) return ['warehouse'];
    if (goal.type === 'level') {
        return avoid.has('warehouse') ? ['prepare'] : ['warehouse', 'prepare'];
    }
    const ordered = [];
    if (context.warehouse >= context.required && !avoid.has('warehouse')) ordered.push('warehouse');
    if ((context.marketOffer || context.marketDemandFresh) && !avoid.has('market')) ordered.push('market');
    if (context.craftReady && !avoid.has('craft')) ordered.push('craft');
    if (context.partyReady && !avoid.has('farm')) ordered.push('farm');
    if (!avoid.has('prepare')) ordered.push('prepare');
    return ordered.length ? ordered : ['prepare'];
}

function selectExecutionPlan(goal, context = {}, options = {}) {
    const plan = planCandidates(goal, context, options)[0];
    return {
        kind: plan,
        sourceId: plan === 'farm' ? number(context.sourceNpcId) || null : null,
        beneficiaryId: number(context.beneficiaryId) || null,
        selectedAt: number(options.timestamp, Date.now()),
        reasonCode: planReason(plan, context)
    };
}

function goalContext(clan = {}, context = {}) {
    const level = number(clan.level);
    if (level <= 1) {
        const required = Math.max(1, number(context.required));
        return {
            type: 'level',
            target: { level: level + 1 },
            required,
            progress: Math.min(required, Math.max(0, number(context.progress))),
            warehouse: number(context.warehouse),
            marketOffer: false,
            marketDemandFresh: false,
            partyReady: false,
            members: clan.members || []
        };
    }
    return {
        type: 'item',
        target: {
            itemId: number(context.itemId),
            itemName: String(context.itemName || 'Blood Mark')
        },
        required: Math.max(1, number(context.required, 1)),
        progress: Math.min(Math.max(1, number(context.required, 1)), Math.max(0, number(context.progress))),
        warehouse: number(context.warehouse),
        marketOffer: !!context.marketOffer,
        marketDemandFresh: !!context.marketDemandFresh,
        craftReady: !!context.craftReady,
        partyReady: !!context.partyReady,
        sourceNpcId: number(context.sourceNpcId),
        beneficiaryId: number(context.beneficiaryId),
        members: clan.members || []
    };
}

function buildGoal(clan = {}, context = {}, previousGoal = null, options = {}) {
    const timestamp = number(options.timestamp, Date.now());
    const shape = goalContext(clan, context);
    const sameTarget = previousGoal
        && previousGoal.type === shape.type
        && JSON.stringify(previousGoal.target || {}) === JSON.stringify(shape.target || {});
    const catastrophicFailures = sameTarget ? number(previousGoal.catastrophicFailures) : 0;
    const plan = selectExecutionPlan(shape, shape, {
        timestamp,
        avoidPlans: options.avoidPlans || []
    });
    const completed = shape.progress >= shape.required;
    const status = completed ? 'completed' : plan.kind === 'prepare' ? 'preparing' : 'executing';
    return {
        type: shape.type,
        target: shape.target,
        required: shape.required,
        progress: shape.progress,
        plan,
        assignedMemberIds: shape.type === 'item' && plan.kind !== 'prepare'
            ? operationMembers(shape.members, Config.operationMaxMembers)
            : [],
        partyId: null,
        catastrophicFailures,
        status,
        reasonCodes: plan.reasonCode ? [plan.reasonCode] : [],
        createdAt: sameTarget ? number(previousGoal.createdAt, timestamp) : timestamp,
        updatedAt: timestamp
    };
}

function replanGoal(goal = {}, context = {}, reasonCode, options = {}) {
    const failures = number(goal.catastrophicFailures) + 1;
    const threshold = Math.max(1, number(options.failureThreshold, 5));
    const avoidPlans = failures >= threshold && goal.plan?.kind ? [goal.plan.kind] : [];
    const next = buildGoal({ level: number(context.level, 2), members: context.members || [] }, {
        ...context,
        progress: number(goal.progress),
        required: number(goal.required),
        itemId: number(goal.target?.itemId),
        itemName: goal.target?.itemName,
        sourceNpcId: number(context.sourceNpcId),
        beneficiaryId: number(context.beneficiaryId)
    }, goal, { ...options, avoidPlans });
    next.catastrophicFailures = failures;
    next.reasonCodes = [...new Set([...(goal.reasonCodes || []), reasonCode].filter(Boolean))].slice(-8);
    next.status = next.plan.kind === 'prepare' ? 'preparing' : 'executing';
    return next;
}

function goalEquivalent(left, right) {
    const comparable = (goal) => {
        if (!goal) return null;
        const copy = JSON.parse(JSON.stringify(goal));
        delete copy.createdAt;
        delete copy.updatedAt;
        if (copy.plan) delete copy.plan.selectedAt;
        return copy;
    };
    return JSON.stringify(comparable(left)) === JSON.stringify(comparable(right));
}

module.exports = {
    buildGoal,
    goalEquivalent,
    hasReadyRoles,
    operationAvailable,
    operationMembers,
    planCandidates,
    replanGoal,
    selectExecutionPlan
};
