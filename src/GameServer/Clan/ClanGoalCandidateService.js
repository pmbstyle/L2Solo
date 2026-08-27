const EquipmentService = invoke('GameServer/Clan/ClanEquipmentService');
const EquipmentPolicy = invoke('GameServer/Clan/ClanEquipmentPolicy');
const ClanPolicy = invoke('GameServer/Clan/ClanSimulationPolicy');

const CACHE_TTL_MS = 30 * 1000;
const MAX_CACHE_ENTRIES = 128;
const DEFAULT_LIMIT = 8;
const cache = new Map();

const metrics = {
    builds: 0,
    cacheHits: 0,
    buildMs: 0,
    buildMaxMs: 0,
    candidates: 0
};

function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function memberId(member) {
    return number(member?.characterId ?? member?.id);
}

function equipmentFingerprint(member = {}) {
    return Object.values(member.inventory || {})
        .filter((item) => item?.equipped === true)
        .map((item) => [
            number(item.selfId),
            number(item.slot),
            String(item.rank || item.etc?.rank || '')
        ].join('.'))
        .sort()
        .join(',');
}

function fingerprint(clan, previousGoal = null) {
    const members = (clan?.members || []).map((member) => [
        memberId(member),
        number(member.level),
        number(member.simulationRevision),
        String(member.phase || ''),
        String(member.partyId || ''),
        equipmentFingerprint(member)
    ].join('.')).join(',');
    return [
        number(clan?.id),
        number(clan?.level),
        number(clan?.state?.updatedAt),
        number(clan?.state?.warehouseRevision),
        String(previousGoal?.goalKey || ''),
        String(previousGoal?.status || ''),
        number(previousGoal?.updatedAt),
        members
    ].join(':');
}

function prune(now = Date.now()) {
    for (const [key, entry] of cache) {
        if (now - entry.createdAt > CACHE_TTL_MS) cache.delete(key);
    }
    while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
}

function routeSnapshot(plan = {}) {
    const kind = EquipmentPolicy.routeFor(plan);
    return {
        kind,
        available: kind !== 'prepare' && String(plan.status || '') !== 'blocked',
        status: String(plan.status || ''),
        expectedKills: Math.max(0, Math.ceil(number(plan.expectedKills))),
        partyNeed: String(plan.partyNeed || (plan.requiresParty ? 'required' : 'solo_ok')),
        source: plan.next ? {
            spotId: plan.next.spotId || null,
            npcId: number(plan.next.npcId) || null,
            npcName: plan.next.npcName || null
        } : null,
        market: plan.market ? {
            town: plan.market.town || null,
            price: Math.max(0, number(plan.market.price)),
            sourceType: plan.market.sourceType || null
        } : null
    };
}

function candidateFor(clan, member, plan, previousGoal, rank) {
    const id = memberId(member);
    const targetId = number(plan?.target?.selfId);
    const slot = number(plan?.target?.slot);
    const role = ClanPolicy.rosterRole(member);
    const priority = EquipmentPolicy.equipmentPriority(member, plan, { roleFor: ClanPolicy.rosterRole });
    const current = previousGoal?.type === 'equipment'
        && number(previousGoal.target?.memberId) === id
        && number(previousGoal.target?.itemId) === targetId
        && number(previousGoal.target?.slot) === slot;
    const route = routeSnapshot(plan);
    return {
        id: `equipment:${number(clan.id)}:${id}:${targetId}:${slot}`,
        type: 'equipment',
        memberId: id,
        itemId: targetId,
        slot,
        beneficiary: {
            id,
            name: String(member.name || member.memberName || `Member ${id}`),
            level: Math.max(1, number(member.level, 1)),
            role
        },
        item: {
            id: targetId,
            name: String(plan.target?.name || `Item ${targetId}`),
            grade: String(plan.grade || 'none'),
            slot
        },
        assessment: {
            serverRank: rank,
            priority: Math.round(priority),
            current,
            reason: String(plan.reason || plan.partyNeedReason || plan.status || '')
        },
        route,
        blockers: route.available ? [] : [String(plan.reason || plan.partyNeedReason || 'no_executable_route')]
    };
}

function decisionReason(previousGoal, planning, candidates) {
    if (!previousGoal || previousGoal.type !== 'equipment') return 'no_equipment_goal';
    if (planning.previousFulfilled) return 'goal_fulfilled';
    if (previousGoal.status === 'blocked') return 'goal_blocked';
    if (!candidates.some((candidate) => candidate.assessment.current)) return 'current_candidate_missing';
    return 'goal_progressing';
}

function rankedCandidates(clan, previousGoal, planning, limit = DEFAULT_LIMIT) {
    const previousMemberId = number(previousGoal?.target?.memberId);
    const ranked = (clan?.members || [])
        .filter((member) => member?.phase === 'cold'
            && (!member?.partyId || memberId(member) === previousMemberId))
        .map((member) => {
            const plan = planning.plans.get(memberId(member));
            return {
                member,
                plan,
                priority: EquipmentPolicy.equipmentPriority(member, plan, { roleFor: ClanPolicy.rosterRole })
            };
        })
        .filter((entry) => EquipmentPolicy.isAcquisitionPlan(entry.plan))
        .sort((left, right) => right.priority - left.priority
            || EquipmentPolicy.planPriority(right.plan) - EquipmentPolicy.planPriority(left.plan)
            || number(left.member.level) - number(right.member.level)
            || memberId(left.member) - memberId(right.member));
    const safeLimit = Math.max(1, Math.min(12, Math.floor(number(limit, DEFAULT_LIMIT))));
    return ranked.slice(0, safeLimit).map((entry, index) => (
        candidateFor(clan, entry.member, entry.plan, previousGoal, index + 1)
    ));
}

async function snapshotFor(clan, previousGoal = null, options = {}) {
    const startedAt = Date.now();
    const key = fingerprint(clan, previousGoal);
    prune(startedAt);
    const cached = cache.get(key);
    if (cached && startedAt - cached.createdAt <= CACHE_TTL_MS) {
        metrics.cacheHits += 1;
        return { ...cached.value, cacheHit: true };
    }
    const planning = await EquipmentService.planningForClan(clan, previousGoal, options);
    let candidates = rankedCandidates(clan, previousGoal, planning, options.limit);
    const selectedMember = planning.selection?.member;
    const selectedPlan = planning.selection?.plan;
    if (selectedMember && EquipmentPolicy.isAcquisitionPlan(selectedPlan)) {
        const selectedMemberId = memberId(selectedMember);
        const selectedItemId = number(selectedPlan.target?.selfId);
        const selectedSlot = number(selectedPlan.target?.slot);
        const selectedPresent = candidates.some((candidate) => (
            candidate.memberId === selectedMemberId
            && candidate.itemId === selectedItemId
            && candidate.slot === selectedSlot
        ));
        if (!selectedPresent) {
            const selectedCandidate = candidateFor(
                clan,
                selectedMember,
                selectedPlan,
                previousGoal,
                candidates.length + 1
            );
            const safeLimit = Math.max(1, Math.min(12, Math.floor(number(options.limit, DEFAULT_LIMIT))));
            candidates = candidates.length < safeLimit
                ? [...candidates, selectedCandidate]
                : [...candidates.slice(0, Math.max(0, safeLimit - 1)), selectedCandidate];
        }
    }
    const reason = decisionReason(previousGoal, planning, candidates);
    const deterministic = planning.selection
        ? candidates.find((candidate) => candidate.memberId === memberId(planning.selection.member)
            && candidate.itemId === number(planning.selection.plan?.target?.selfId)
            && candidate.slot === number(planning.selection.plan?.target?.slot)) || candidates[0] || null
        : candidates[0] || null;
    const value = {
        key,
        planning,
        candidates,
        deterministicCandidateId: deterministic?.id || null,
        decisionReason: reason,
        decisionNeeded: candidates.length > 1 && reason !== 'goal_progressing'
    };
    cache.set(key, { createdAt: Date.now(), value });
    const durationMs = Date.now() - startedAt;
    metrics.builds += 1;
    metrics.buildMs += durationMs;
    metrics.buildMaxMs = Math.max(metrics.buildMaxMs, durationMs);
    metrics.candidates += candidates.length;
    return { ...value, cacheHit: false };
}

module.exports = {
    CACHE_TTL_MS,
    DEFAULT_LIMIT,
    fingerprint,
    rankedCandidates,
    snapshotFor,
    metrics() {
        return {
            ...metrics,
            buildAvgMs: metrics.builds ? metrics.buildMs / metrics.builds : 0,
            cacheEntries: cache.size
        };
    },
    reset() {
        cache.clear();
        Object.keys(metrics).forEach((key) => { metrics[key] = 0; });
    }
};
