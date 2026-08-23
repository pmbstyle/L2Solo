const Database = invoke('Database');
const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const Policy = invoke('GameServer/Clan/ClanEquipmentPolicy');

const metrics = {
    resolves: 0,
    plans: 0,
    assignments: 0,
    partyAssignments: 0,
    assignmentFailures: 0,
    noDebt: 0,
    reasonCounts: new Map()
};

function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function parseJson(value, fallback = {}) {
    if (value && typeof value === 'object') return value;
    try {
        const parsed = JSON.parse(value || '{}');
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch (_) {
        return fallback;
    }
}

function recordReason(reason) {
    if (reason) metrics.reasonCounts.set(reason, (metrics.reasonCounts.get(reason) || 0) + 1);
}

function plannerState(member) {
    return {
        ...member,
        characterId: number(member.characterId ?? member.id),
        name: member.name || member.memberName || '',
        stats: { ...(member.stats || {}) },
        inventory: { ...(member.inventory || {}) },
        adena: number(member.adena || member.inventory?.['57']?.amount),
        currentRegion: member.currentRegion || null,
        party: { partyId: member.partyId || null }
    };
}

function existingPlanFor(member) {
    const plan = member?.stats?.equipmentPlan;
    return Policy.isAcquisitionPlan(plan) ? plan : null;
}

function warehouseAvailable(rows = [], selfId) {
    return (rows || [])
        .filter((row) => number(row.selfId) === number(selfId))
        .reduce((sum, row) => sum + Math.max(0, number(row.amount) - number(row.reservedAmount)), 0);
}

function overlayWarehouseMaterials(state, plan, warehouseRows = []) {
    if (plan?.strategy !== 'craft' || !number(plan.recipeId)) return { state, materials: [] };
    const inventory = { ...(state.inventory || {}) };
    const materials = [];
    (plan.materials || []).forEach((material) => {
        const selfId = number(material.selfId);
        const missing = Math.max(0, number(material.missing));
        if (!selfId || missing <= 0) return;
        const available = warehouseAvailable(warehouseRows, selfId);
        const amount = Math.min(missing, available);
        if (amount <= 0) return;
        const current = inventory[String(selfId)] || {};
        inventory[String(selfId)] = {
            ...current,
            selfId,
            name: current.name || (warehouseRows.find((row) => number(row.selfId) === selfId)?.name || `Item ${selfId}`),
            amount: number(current.amount) + amount
        };
        materials.push({ selfId, amount });
    });
    return {
        state: materials.length ? { ...state, inventory } : state,
        materials
    };
}

function planForMember(member, spots = [], warehouseRows = []) {
    const existing = existingPlanFor(member);
    if (existing && GearAcquisitionPlanner.clanGoalPlanLocked(member, existing)) {
        if (existing.strategy !== 'craft') return existing;
        const overlay = overlayWarehouseMaterials(plannerState(member), existing, warehouseRows);
        return overlay.materials.length
            ? { ...existing, warehouseMaterials: overlay.materials }
            : existing;
    }
    if (existing && existing.strategy !== 'craft') return existing;
    try {
        const state = plannerState(member);
        const initial = existing || GearAcquisitionPlanner.planFor(state, { spots });
        if (initial?.strategy !== 'craft' || !number(initial.recipeId)) return initial;
        const overlay = overlayWarehouseMaterials(state, initial, warehouseRows);
        if (!overlay.materials.length) return initial;
        const refreshed = GearAcquisitionPlanner.planFor(overlay.state, {
            spots,
            recipeId: number(initial.recipeId)
        });
        return {
            ...refreshed,
            warehouseMaterials: overlay.materials
        };
    } catch (error) {
        recordReason('gear_planner_unavailable');
        return { status: 'blocked', reason: 'gear_planner_unavailable', strategy: 'none', target: null };
    }
}

function clanPlan(plan, clan, goal) {
    const partyNeed = plan.partyNeed === 'required' ? 'required' : 'preferred';
    return {
        ...plan,
        clanGoal: {
            clanId: number(clan.id),
            goalKey: goal.goalKey,
            beneficiaryId: number(goal.target.memberId),
            priority: 'required',
            partyNeed,
            partyPreference: 'clan_first'
        }
    };
}

function samePlanTarget(left, right) {
    return number(left?.target?.selfId) > 0
        && number(left?.target?.selfId) === number(right?.target?.selfId)
        && number(left?.target?.slot) === number(right?.target?.slot);
}

function clanPartyObjective(plan, goal, priority = 'preferred', clanId = 0) {
    // A craft plan with missing components still has a farming route in
    // `next`; a ready-to-craft plan has no route and therefore needs no party.
    if (!['farm', 'craft'].includes(String(goal?.plan?.kind || '')) || !plan?.next?.spotId) return null;
    const strategy = String(plan.strategy || 'direct_drop');
    const targetItemId = number(plan.next.itemId || plan.target?.selfId);
    const npcId = number(plan.next.npcId);
    const objectiveKey = npcId > 0
        ? [strategy, plan.next.spotId, npcId].join(':')
        : [strategy, plan.next.spotId, npcId, targetItemId].join(':');
    return {
        status: 'open',
        priority,
        objectiveKey,
        reason: 'clan_equipment',
        partyNeedReason: 'clan_equipment',
        strategy,
        spotId: plan.next.spotId,
        npcId: npcId || null,
        itemId: targetItemId || null,
        targetId: number(plan.target?.selfId) || null,
        clanId: number(clanId) || null,
        clanGoalKey: goal.goalKey || null,
        partyPreference: 'clan_first',
        requestedAt: Date.now(),
        reviewAt: Date.now() + 300000,
        attempts: 0,
        lastMatchedAt: null
    };
}

function stateHasSameClanObjective(state, objective) {
    return String(state?.stats?.clanPartyObjective?.clanGoalKey || '') === String(objective?.clanGoalKey || '')
        && String(state?.stats?.clanPartyObjective?.objectiveKey || '') === String(objective?.objectiveKey || '')
        && state?.stats?.partyRequest?.status === 'open';
}

async function handoffWarehouseMaterials(current, plan, clan, goal) {
    const materials = (plan?.warehouseMaterials || [])
        .map((entry) => ({ selfId: number(entry.selfId), amount: Math.floor(number(entry.amount)) }))
        .filter((entry) => entry.selfId > 0 && entry.amount > 0);
    if (!materials.length) return { state: current, results: [] };

    let state = current;
    const results = [];
    for (const material of materials) {
        const result = await Database.transferClanWarehouseToMember({
            clanId: clan.id,
            characterId: current.characterId,
            selfId: material.selfId,
            amount: material.amount,
            goalKey: `${goal.goalKey}:warehouse:${material.selfId}`,
            expectedSimulationRevision: number(state.simulationRevision) || null
        });
        results.push(result);
        if (!result.ok) {
            recordReason(result.code || 'warehouse_handoff_failed');
            continue;
        }
        state = {
            ...state,
            simulationRevision: number(result.simulationRevision, number(state.simulationRevision)),
            inventory: { ...(state.inventory || {}) }
        };
        state = await LifeState.refreshInventory(state, { equip: true });
        state = {
            ...state,
            simulationRevision: number(result.simulationRevision, number(state.simulationRevision))
        };
    }
    return { state, results };
}

async function assignPartyObjective(member, clan, goal, plan) {
    const id = number(member.characterId ?? member.id);
    const objective = clanPartyObjective(plan, goal, 'preferred', clan.id);
    await LifeState.init();
    const current = await LifeState.findByCharacterId(id);
    if (!current) return { ok: false, code: 'member_state_missing', memberId: id };
    if (!objective) {
        const old = current.stats?.clanPartyObjective;
        if (!old || number(old.clanId) !== number(clan.id)) return { ok: true, changed: false, memberId: id };
        const stats = { ...(current.stats || {}) };
        delete stats.clanPartyObjective;
        if (stats.partyRequest?.clanGoalKey === old.clanGoalKey) delete stats.partyRequest;
        const saved = await LifeState.upsertState({ ...current, stats }, 'clan_equipment_party_clear');
        return { ok: !!saved, changed: !!saved, memberId: id };
    }
    if (stateHasSameClanObjective(current, objective)) return { ok: true, changed: false, memberId: id };
    const nextObjective = { ...objective, clanId: number(clan.id) };
    const currentRequest = current.stats?.partyRequest;
    const partyRequest = currentRequest?.priority === 'required' && !currentRequest?.clanGoalKey
        ? currentRequest
        : nextObjective;
    const saved = await LifeState.upsertState({
        ...current,
        stats: {
            ...(current.stats || {}),
            clanId: number(clan.id),
            clanPartyObjective: nextObjective,
            partyRequest
        }
    }, 'clan_equipment_party_objective');
    if (!saved) return { ok: false, code: 'member_state_write_failed', memberId: id };
    metrics.partyAssignments += 1;
    return { ok: true, changed: true, memberId: id };
}

async function assignPlan(member, plan, clan, goal) {
    const id = number(member.characterId ?? member.id);
    if (!id) return { ok: false, code: 'member_missing' };
    await LifeState.init();
    const current = await LifeState.findByCharacterId(id);
    if (!current) return { ok: false, code: 'member_state_missing', memberId: id };

    const handoff = await handoffWarehouseMaterials(current, plan, clan, goal);
    const currentState = handoff.state || current;

    const currentPlan = currentState.stats?.equipmentPlan;
    if (currentPlan?.clanGoal?.clanId
        && number(currentPlan.clanGoal.clanId) !== number(clan.id)
        && !samePlanTarget(currentPlan, plan)) {
        return { ok: false, code: 'member_equipment_plan_conflict', memberId: id, handoff };
    }
    if (samePlanTarget(currentPlan, plan)
        && number(currentPlan.clanGoal?.clanId) === number(clan.id)
        && String(currentPlan.clanGoal?.goalKey || '') === String(goal.goalKey)) {
        return { ok: true, changed: false, memberId: id, handoff };
    }

    const nextState = {
        ...currentState,
        stats: {
            ...(currentState.stats || {}),
            clanId: number(clan.id),
            equipmentPlan: clanPlan(plan, clan, goal),
            clanPartyObjective: clanPartyObjective(plan, goal, 'required', clan.id),
            // A stale personal request must not hide the new clan objective.
            partyRequest: clanPartyObjective(plan, goal, 'required', clan.id)
        }
    };
    const saved = await LifeState.upsertState(nextState, 'clan_equipment_goal');
    if (!saved) return { ok: false, code: 'member_state_write_failed', memberId: id, handoff };
    metrics.assignments += 1;
    return { ok: true, changed: true, memberId: id, handoff };
}

async function resolveClan(clan, previousGoal = null, options = {}) {
    metrics.resolves += 1;
    if (!clan || number(clan.level) < 3) {
        return { ok: true, skipped: true, reason: 'equipment_level_unavailable' };
    }
    const spots = options.spots || (() => {
        try {
            return SpotProfiles.ensure();
        } catch (error) {
            recordReason('spot_index_unavailable');
            return [];
        }
    })();
    const warehouseRows = await Database.fetchClanWarehouseItems(clan.id);
    const plans = new Map((clan.members || []).map((member) => [
        number(member.characterId ?? member.id),
        planForMember(member, spots, warehouseRows)
    ]));
    const previousMember = (clan.members || []).find((member) => (
        number(member.characterId ?? member.id) === number(previousGoal?.target?.memberId)
    ));
    const previousFulfilled = previousMember
        ? Policy.targetFulfilled(previousMember, previousGoal, GearAcquisitionPlanner.equippedSlotsFor)
        : false;
    const selection = Policy.selectTargetMember(clan.members, plans, previousGoal, { previousFulfilled });
    if (!selection) {
        metrics.noDebt += 1;
        recordReason('no_equipment_debt');
        return { ok: true, skipped: true, reason: 'no_equipment_debt', plans };
    }

    const goal = Policy.buildGoal(clan, selection, previousGoal, Date.now());
    const assignment = await assignPlan(selection.member, selection.plan, clan, goal);
    if (!assignment.ok) {
        metrics.assignmentFailures += 1;
        recordReason(assignment.code);
        return { ...assignment, goal, plans, selection };
    }
    const partyAssignments = await (clan.members || [])
        .filter((member) => member?.phase === 'cold' && !member?.partyId)
        .reduce((chain, member) => chain.then(async (results) => {
            const result = await assignPartyObjective(member, clan, goal, selection.plan);
            if (!result.ok) recordReason(result.code);
            results.push(result);
            return results;
        }), Promise.resolve([]));
    const [latestStateRow] = await Database.execute([
        'SELECT stateJson FROM clan_simulation_clans WHERE clanId = ?',
        [number(clan.id)]
    ]);
    const latestState = parseJson(latestStateRow?.stateJson, clan.state || {});
    metrics.plans += 1;
    recordReason(goal.plan.reasonCode);
    return {
        ok: true,
        goal,
        plans,
        selection,
        assignment,
        partyAssignments,
        previousFulfilled,
        expectedUpdatedAt: number(latestState.updatedAt) || null
    };
}

const ClanEquipmentService = {
    resolveClan,
    planForMember,
    metrics() {
        return {
            resolves: metrics.resolves,
            plans: metrics.plans,
            assignments: metrics.assignments,
            partyAssignments: metrics.partyAssignments,
            assignmentFailures: metrics.assignmentFailures,
            noDebt: metrics.noDebt,
            reasonCounts: Object.fromEntries(metrics.reasonCounts.entries())
        };
    },
    resetMetrics() {
        Object.keys(metrics).forEach((key) => {
            if (metrics[key] instanceof Map) metrics[key].clear();
            else metrics[key] = 0;
        });
    }
};

module.exports = ClanEquipmentService;
