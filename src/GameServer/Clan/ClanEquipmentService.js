const Database = invoke('Database');
const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const Policy = invoke('GameServer/Clan/ClanEquipmentPolicy');
const Config = invoke('GameServer/Clan/ClanSimulationConfig');
const GoalPolicy = invoke('GameServer/Clan/ClanGoalPolicy');
const ClanPolicy = invoke('GameServer/Clan/ClanSimulationPolicy');
const BackgroundPartyState = invoke('GameServer/Bot/Population/BackgroundPartyState');
const DataCache = invoke('GameServer/DataCache');
const MAX_CAPACITY_TARGET_RETRIES = 5;

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

function reservationOptionsForClan(clan) {
    return {
        reservationKey: `clan-equipment:${number(clan?.id)}`,
        maxReservationGroups: SpotProfiles.MAX_CLAN_EQUIPMENT_RESERVATIONS_PER_SPOT
    };
}

function reserveGoalCapacity(planning = {}, clan = {}, assignedMemberIds = [], selectedSpot = null) {
    if (!selectedSpot) return { occupancy: planning.occupancy || {}, reserved: true };
    let occupancy = planning.occupancy || {};
    try {
        // Candidate construction may await an LLM decision. Its planning
        // snapshot can therefore be several seconds old by the time the goal
        // is applied. Always rejoin the shared one-second occupancy snapshot
        // here; reserveCapacity mutates that object so later clan actions in
        // the same batch immediately observe this reservation.
        occupancy = SpotProfiles.currentOccupancy(planning.spots || []) || occupancy;
    } catch (_) {
        // Keep deterministic harnesses and startup recovery best-effort when
        // the world spot index is not ready yet.
    }
    return {
        occupancy,
        reserved: SpotProfiles.reserveCapacity(
            occupancy,
            selectedSpot,
            assignedMemberIds.map((characterId) => ({ characterId })),
            reservationOptionsForClan(clan)
        )
    };
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

function planForMember(member, spots = [], warehouseRows = [], options = {}) {
    const planningMember = options.ignoreExistingPlan ? {
        ...member,
        stats: { ...(member?.stats || {}), equipmentPlan: undefined }
    } : member;
    const existing = existingPlanFor(planningMember);
    const state = plannerState(planningMember);
    const plannerOptions = {
        spots,
        ...(options.occupancy ? { occupancy: options.occupancy } : {}),
        ...(options.capacityUnits ? { capacityUnits: options.capacityUnits } : {}),
        ...(options.reservationKey ? { reservationKey: options.reservationKey } : {}),
        ...(options.maxReservationGroups ? { maxReservationGroups: options.maxReservationGroups } : {}),
        ...(options.excludedTargetIds ? { excludedTargetIds: options.excludedTargetIds } : {})
    };
    try {
        if (existing?.status === 'blocked') {
            const targetId = number(existing.target?.selfId);
            return GearAcquisitionPlanner.planFor(state, {
                ...plannerOptions,
                excludedTargetIds: [...new Set([
                    ...(options.excludedTargetIds || []).map(number).filter(Boolean),
                    targetId
                ].filter(Boolean))]
            });
        }
        if (existing && existing.status === 'active' && ['direct_drop', 'craft'].includes(existing.strategy)) {
            const excluded = new Set((options.excludedTargetIds || []).map(number).filter(Boolean));
            const targetExcluded = excluded.has(number(existing.target?.selfId));
            const source = targetExcluded
                ? null
                : GearAcquisitionPlanner.bestSourceForPlan(state, existing, spots, plannerOptions);
            if (source) {
                const routed = GearAcquisitionPlanner.retargetPlanSource(state, existing, source);
                if (existing.strategy !== 'craft') return routed;
                const overlay = overlayWarehouseMaterials(state, routed, warehouseRows);
                return overlay.materials.length ? { ...routed, warehouseMaterials: overlay.materials } : routed;
            }
            if (!targetExcluded && existing.strategy === 'craft' && number(existing.recipeId)) {
                const overlay = overlayWarehouseMaterials(state, existing, warehouseRows);
                const refreshed = GearAcquisitionPlanner.planFor(overlay.state, {
                    ...plannerOptions,
                    recipeId: number(existing.recipeId)
                });
                if (['active', 'ready_to_craft', 'component_ready'].includes(refreshed?.status)) {
                    return overlay.materials.length
                        ? { ...refreshed, warehouseMaterials: overlay.materials }
                        : refreshed;
                }
            }
            const targetId = number(existing.target?.selfId);
            return GearAcquisitionPlanner.planFor(state, {
                ...plannerOptions,
                excludedTargetIds: [...new Set([
                    ...(options.excludedTargetIds || []).map(number).filter(Boolean),
                    targetId
                ])]
            });
        }
        if (existing && GearAcquisitionPlanner.clanGoalPlanLocked(planningMember, existing)) return existing;
        if (existing && existing.strategy !== 'craft') return existing;
        const initial = existing || GearAcquisitionPlanner.planFor(state, plannerOptions);
        if (initial?.strategy !== 'craft' || !number(initial.recipeId)) return initial;
        const overlay = overlayWarehouseMaterials(state, initial, warehouseRows);
        if (!overlay.materials.length) return initial;
        const refreshed = GearAcquisitionPlanner.planFor(overlay.state, {
            ...plannerOptions,
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

function samePlanRoute(left, right) {
    return String(left?.next?.spotId || '') === String(right?.next?.spotId || '')
        && number(left?.next?.npcId) === number(right?.next?.npcId)
        && number(left?.next?.itemId) === number(right?.next?.itemId);
}

function memberId(member) {
    return number(member?.characterId ?? member?.id);
}

function planningMemberOrder(members = [], previousMemberId = 0, previousFulfilled = false) {
    const eligible = members
        .filter((member) => member?.phase === 'cold'
            && (!member?.partyId || memberId(member) === number(previousMemberId)))
        .sort((left, right) => memberId(left) - memberId(right));
    const previousIndex = eligible.findIndex((member) => memberId(member) === number(previousMemberId));
    if (previousIndex < 0) return eligible;
    if (!previousFulfilled) {
        return [eligible[previousIndex], ...eligible.filter((_, index) => index !== previousIndex)];
    }
    return [
        ...eligible.slice(previousIndex + 1),
        ...eligible.slice(0, previousIndex + 1)
    ];
}

function equipmentRoster(clan, beneficiary, previousGoal = null) {
    const beneficiaryId = memberId(beneficiary);
    const memberIds = new Set((clan?.members || []).map(memberId).filter(Boolean));
    const previousBeneficiaryId = number(previousGoal?.target?.memberId);
    const retained = (previousGoal?.assignedMemberIds || []).map(number)
        .filter((id) => memberIds.has(id));
    if (beneficiaryId && beneficiaryId === previousBeneficiaryId
        && retained.length >= Math.max(2, number(Config.operationMinMembers, 5))) return retained;
    const maxMembers = Math.max(2, Math.min(9, number(Config.operationMaxMembers, 9)));
    const selected = GoalPolicy.operationMembers(clan?.members || [], maxMembers);
    if (beneficiaryId && !selected.includes(beneficiaryId)) {
        if (selected.length >= maxMembers) selected.pop();
        selected.unshift(beneficiaryId);
    }
    return [...new Set(selected.map(number).filter(Boolean))];
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
    const rosterSize = Math.max(1, (goal?.assignedMemberIds || []).length);
    const maxPartySize = Math.max(2, Math.min(9, rosterSize));
    const minPartySize = Math.max(2, Math.min(maxPartySize, number(Config.operationMinMembers, 5)));
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
        clanOperation: 'equipment',
        maxPartySize,
        minPartySize,
        levelRange: 99,
        requestedAt: Date.now(),
        reviewAt: Date.now() + 300000,
        attempts: 0,
        lastMatchedAt: null
    };
}

function stateHasSameClanObjective(state, objective) {
    return String(state?.stats?.clanPartyObjective?.clanGoalKey || '') === String(objective?.clanGoalKey || '')
        && String(state?.stats?.clanPartyObjective?.objectiveKey || '') === String(objective?.objectiveKey || '')
        && number(state?.stats?.clanPartyObjective?.maxPartySize) === number(objective?.maxPartySize)
        && state?.stats?.partyRequest?.status === 'open'
        && state.stats.partyRequest.priority === objective.priority;
}

async function releasePreviousBeneficiary(clan, previousGoal, nextGoal) {
    const previousMemberId = number(previousGoal?.target?.memberId);
    if (!previousMemberId || previousMemberId === number(nextGoal?.target?.memberId)) {
        return { changed: false, releasedMembers: 0 };
    }
    const previousGoalKey = String(previousGoal?.goalKey || '');
    const parties = BackgroundPartyState.active().filter((party) => (
        String(party?.stats?.objective?.clanGoalKey || '') === previousGoalKey
    ));
    let releasedMembers = 0;
    for (const party of parties) {
        const dissolved = await BackgroundPartyState.setStatus(party.partyId, 'dissolved');
        if (dissolved) {
            releasedMembers += number(await LifeState.releaseDissolvedPartyMembers(
                party.partyId,
                'clan_equipment_goal_rotated'
            ));
        }
    }

    const current = await LifeState.findByCharacterId(previousMemberId);
    const currentPlan = current?.stats?.equipmentPlan;
    if (!current || String(currentPlan?.clanGoal?.goalKey || '') !== previousGoalKey) {
        return { changed: parties.length > 0, releasedMembers };
    }
    const stats = { ...(current.stats || {}) };
    stats.equipmentPlan = { ...currentPlan };
    delete stats.equipmentPlan.clanGoal;
    if (String(stats.clanPartyObjective?.clanGoalKey || '') === previousGoalKey) delete stats.clanPartyObjective;
    if (String(stats.partyRequest?.clanGoalKey || '') === previousGoalKey) delete stats.partyRequest;
    const saved = await LifeState.upsertState({ ...current, stats }, 'clan_equipment_beneficiary_rotated');
    return { changed: !!saved || parties.length > 0, releasedMembers };
}

async function releaseConflictingRosterParties(assignedMemberIds, goal, expectedObjective = null) {
    const roster = new Set((assignedMemberIds || []).map(number).filter(Boolean));
    if (!roster.size) return { parties: 0, releasedMembers: 0 };
    const goalKey = String(goal?.goalKey || '');
    const parties = BackgroundPartyState.active().filter((party) => {
        const memberIds = (party.memberIds || []).map(number).filter(Boolean);
        if (!memberIds.some((id) => roster.has(id))) return false;
        const partyObjective = party?.stats?.objective || null;
        const partyGoalKey = String(partyObjective?.clanGoalKey || '');
        const sameRoute = !expectedObjective || (
            String(party.spotId || '') === String(expectedObjective.spotId || '')
            && String(partyObjective?.objectiveKey || '') === String(expectedObjective.objectiveKey || '')
            && number(partyObjective?.npcId) === number(expectedObjective.npcId)
        );
        return partyGoalKey !== goalKey
            || !sameRoute
            || memberIds.some((id) => !roster.has(id));
    });
    let releasedMembers = 0;
    for (const party of parties) {
        const dissolved = await BackgroundPartyState.setStatus(party.partyId, 'dissolved');
        if (!dissolved) continue;
        releasedMembers += number(await LifeState.releaseDissolvedPartyMembers(
            party.partyId,
            'clan_equipment_party_reformed'
        ));
    }
    return { parties: parties.length, releasedMembers };
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

async function assignPartyObjective(member, clan, goal, plan, priority = 'preferred') {
    const id = number(member.characterId ?? member.id);
    const objective = clanPartyObjective(plan, goal, priority, clan.id);
    await LifeState.init();
    const current = await LifeState.findByCharacterId(id);
    if (!current) return { ok: false, code: 'member_state_missing', memberId: id };
    const currentPartyId = current.partyId || current.party?.partyId || null;
    if (objective && currentPartyId) {
        const sameGoal = String(current.stats?.clanPartyObjective?.clanGoalKey || '') === String(goal?.goalKey || '');
        return { ok: sameGoal, changed: false, memberId: id, code: sameGoal ? null : 'member_party_conflict' };
    }
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
        && String(currentPlan.clanGoal?.goalKey || '') === String(goal.goalKey)
        && samePlanRoute(currentPlan, plan)) {
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

async function planningForClan(clan, previousGoal = null, options = {}) {
    const spots = options.spots || (() => {
        try {
            return SpotProfiles.ensure();
        } catch (error) {
            recordReason('spot_index_unavailable');
            return [];
        }
    })();
    const occupancy = options.occupancy || (() => {
        try {
            return SpotProfiles.currentOccupancy(spots) || {};
        } catch (_) {
            return {};
        }
    })();
    const previousMember = (clan.members || []).find((member) => (
        number(member.characterId ?? member.id) === number(previousGoal?.target?.memberId)
    ));
    const previousFulfilled = previousMember
        ? Policy.targetFulfilled(
            previousMember,
            previousGoal,
            GearAcquisitionPlanner.equippedSlotsFor,
            (selfId) => (DataCache.items || []).find((item) => number(item.selfId) === number(selfId)) || null
        )
        : false;
    const warehouseRows = await Database.fetchClanWarehouseItems(clan.id);
    const previousMemberId = number(previousGoal?.target?.memberId);
    const reservationOptions = reservationOptionsForClan(clan);
    const members = planningMemberOrder(
        clan.members || [],
        previousMemberId,
        previousFulfilled
    );
    const planningWindow = Math.max(1, number(Config.operationMinMembers, 5));
    const plans = new Map();
    for (let index = 0; index < members.length; index++) {
        const member = members[index];
        const id = number(member.characterId ?? member.id);
        const capacityUnits = equipmentRoster(clan, member, previousGoal).length;
        plans.set(id, planForMember(member, spots, warehouseRows, {
            ignoreExistingPlan: previousFulfilled && id === previousMemberId,
            occupancy,
            capacityUnits,
            ...reservationOptions,
            excludedTargetIds: options.excludedTargetIds || []
        }));
        // Equipment planning is CPU-only and may inspect several nearby item
        // batches. Keep one clan action from monopolizing the game loop while
        // still completing the same bounded roster projection.
        if ((index + 1) % 2 === 0 && index + 1 < members.length) {
            await new Promise((resolve) => setImmediate(resolve));
        }
        const windowComplete = (index + 1) % planningWindow === 0 || index + 1 === members.length;
        if (windowComplete && [...plans.values()].some(Policy.isAcquisitionPlan)) break;
    }
    const selection = Policy.selectTargetMember(clan.members, plans, previousGoal, {
        previousFulfilled,
        roleFor: ClanPolicy.rosterRole
    });
    return {
        spots,
        occupancy,
        warehouseRows,
        plans,
        selection,
        previousFulfilled
    };
}

function selectedPlanningTarget(clan, previousGoal, planning, selectedCandidate = null) {
    const memberIdValue = number(selectedCandidate?.memberId);
    const itemId = number(selectedCandidate?.itemId);
    const slot = number(selectedCandidate?.slot);
    if (!memberIdValue) return planning.selection;
    const member = (clan.members || []).find((entry) => memberId(entry) === memberIdValue);
    const plan = planning.plans.get(memberIdValue);
    if (!member || !Policy.isAcquisitionPlan(plan)) return planning.selection;
    if (itemId && number(plan.target?.selfId) !== itemId) return planning.selection;
    if (slot && number(plan.target?.slot) !== slot) return planning.selection;
    return {
        member,
        plan,
        priority: Policy.equipmentPriority(member, plan, { roleFor: ClanPolicy.rosterRole }),
        selectedBy: 'clan_brain',
        previousMemberId: number(previousGoal?.target?.memberId) || null
    };
}

async function resolveClan(clan, previousGoal = null, options = {}) {
    metrics.resolves += 1;
    if (!clan || number(clan.level) < 3) {
        return { ok: true, skipped: true, reason: 'equipment_level_unavailable' };
    }
    const planning = options.planning || await planningForClan(clan, previousGoal, options);
    const { plans, previousFulfilled } = planning;
    const selection = selectedPlanningTarget(clan, previousGoal, planning, options.selectedCandidate);
    if (!selection) {
        metrics.noDebt += 1;
        recordReason('no_equipment_debt');
        return { ok: true, skipped: true, reason: 'no_equipment_debt', plans };
    }

    const assignedMemberIds = equipmentRoster(clan, selection.member, previousGoal);
    const selectedSpot = selection.plan?.next?.spotId
        ? planning.spots.find((spot) => String(spot.id) === String(selection.plan.next.spotId))
        : null;
    const capacityReservation = reserveGoalCapacity(planning, clan, assignedMemberIds, selectedSpot);
    if (!capacityReservation.reserved) {
        recordReason('equipment_source_capacity_changed');
        const retryCount = Math.max(0, number(options.capacityRetry));
        // This is a rare post-planning race, not the normal clan planning
        // path. Walk a few more nearby equipment targets before yielding the
        // action; the ordinary cold flow still performs only one planning pass.
        if (retryCount < MAX_CAPACITY_TARGET_RETRIES) {
            const excludedTargetIds = [...new Set([
                ...(options.excludedTargetIds || []).map(number).filter(Boolean),
                number(selection.plan?.target?.selfId)
            ].filter(Boolean))];
            const retryPlanning = await planningForClan(clan, previousGoal, {
                ...options,
                spots: planning.spots,
                occupancy: capacityReservation.occupancy,
                excludedTargetIds
            });
            return resolveClan(clan, previousGoal, {
                ...options,
                planning: retryPlanning,
                selectedCandidate: null,
                excludedTargetIds,
                capacityRetry: retryCount + 1
            });
        }
        return { ok: true, skipped: true, reason: 'equipment_sources_exhausted', plans };
    }
    const goal = Policy.buildGoal(clan, selection, previousGoal, Date.now(), {
        assignedMemberIds,
        roleFor: ClanPolicy.rosterRole
    });
    const rotation = await releasePreviousBeneficiary(clan, previousGoal, goal);
    const expectedObjective = clanPartyObjective(selection.plan, goal, 'required', clan.id);
    const partyReform = await releaseConflictingRosterParties(assignedMemberIds, goal, expectedObjective);
    const assignment = await assignPlan(selection.member, selection.plan, clan, goal);
    if (!assignment.ok) {
        metrics.assignmentFailures += 1;
        recordReason(assignment.code);
        return { ...assignment, goal, plans, selection };
    }
    const roster = new Set(assignedMemberIds);
    const partyAssignments = await (clan.members || [])
        .filter((member) => member?.phase === 'cold')
        .reduce((chain, member) => chain.then(async (results) => {
            const result = roster.has(memberId(member))
                ? await assignPartyObjective(member, clan, goal, selection.plan, 'required')
                : await assignPartyObjective(member, clan, goal, null);
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
        rotation,
        partyReform,
        partyAssignments,
        previousFulfilled,
        expectedUpdatedAt: number(latestState.updatedAt) || null
    };
}

const ClanEquipmentService = {
    resolveClan,
    planningForClan,
    planForMember,
    reserveGoalCapacity,
    releaseConflictingRosterParties,
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
