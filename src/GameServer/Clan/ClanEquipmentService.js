const Crafting = require('./ClanCraftingPolicy');
const CraftShops = invoke('GameServer/Bot/Economy/CraftShopService');
const Database = invoke('Database');
const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const Policy = invoke('GameServer/Clan/ClanEquipmentPolicy');
const Config = invoke('GameServer/Clan/ClanSimulationConfig');
const GoalPolicy = invoke('GameServer/Clan/ClanGoalPolicy');
const ClanPolicy = invoke('GameServer/Clan/ClanSimulationPolicy');
const ClanRaidPolicy = require('./ClanRaidPolicy');
const ClanRaidFailurePolicy = require('./ClanRaidFailurePolicy');
const BackgroundPartyState = invoke('GameServer/Bot/Population/BackgroundPartyState');
const DataCache = invoke('GameServer/DataCache');
const { planForMember } = require('./ClanEquipmentPlanner');
const PlanningWorker = require('./ClanPlanningCoordinator');
const MAX_CAPACITY_TARGET_RETRIES = 5;
let craftingCatalog = null;
let craftingCatalogItems = null;

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

function planningFingerprint(clan) {
    return JSON.stringify(clan && {
        id: clan.id, level: clan.level, leaderId: clan.leaderId,
        updatedAt: clan.state?.updatedAt, warehouseRevision: clan.state?.warehouseRevision,
        mode: clan.state?.mode, goal: clan.state?.goal, productionGoal: clan.state?.productionGoal,
        rateProfile: GearAcquisitionPlanner.rateProfileSignature(),
        members: (clan.members || []).map((member) => ({
            id: memberId(member), level: member.level, classId: member.classId,
            phase: member.phase, owner: member.simulationOwner, partyId: member.partyId,
            equipment: Object.values(member.inventory || {}).filter((item) => item?.equipped === true)
                .map(({ selfId, slot, equippedSlots, equippedCount, enchant }) => ({ selfId, slot, equippedSlots, equippedCount, enchant }))
        }))
    });
}

function beneficiaryFingerprint(member) {
    return JSON.stringify(member && {
        inventory: member.inventory, adena: member.adena, region: member.currentRegion,
        plan: member.stats?.equipmentPlan
    });
}

function planningDeferred(message) {
    return Object.assign(new Error(message), { code: 'clan_planning_deferred' });
}

async function validatePlanning(clan, planning, selection = null) {
    if (!planning.workerFingerprint) return;
    const current = await invoke('GameServer/Clan/ClanGoalService').clanProjectionById(clan.id);
    const id = memberId(selection?.member);
    const beneficiaryChanged = id && planning.beneficiaryFingerprints?.[id] !== beneficiaryFingerprint(
        current?.members?.find((member) => memberId(member) === id));
    if (planning.workerFingerprint !== planningFingerprint(current) || beneficiaryChanged) {
        recordReason('clan_planning_stale');
        throw planningDeferred('clan planning snapshot changed');
    }
}

function clanPlan(plan, clan, goal) {
    const partyNeed = plan.partyNeed === 'required' ? 'required' : 'preferred';
    return {
        ...plan,
        expectedKillsLimit: Config.equipmentMaxExpectedKills,
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

function activeRaidPartyForClan(clanId) {
    const id = number(clanId);
    if (!id) return null;
    const partyPolicy = require('../Bot/Population/ClanEquipmentPartyPolicy');
    return BackgroundPartyState.active().find((party) => {
        const objective = party?.stats?.objective;
        const started = ['preparing', 'ready'].includes(party?.stats?.raidPreparation?.status)
            || party?.stats?.raidEncounter?.status === 'active';
        const minPartySize = Math.max(2, number(objective?.minPartySize, ClanRaidPolicy.MIN_MEMBERS));
        const viableRoster = (party?.memberIds || []).length >= minPartySize;
        return party?.status !== 'dissolved'
            && number(objective?.clanId) === id
            && (objective?.sourceKind === 'raid' || objective?.raidBoss === true)
            && started
            && viableRoster
            && !partyPolicy.abandonedRaid(party)
            && !['defeated', 'failed'].includes(party?.stats?.raidEncounter?.status);
    }) || null;
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

function equipmentRoster(clan, beneficiary, previousGoal = null, plan = null) {
    const beneficiaryId = memberId(beneficiary);
    if (plan && (!plan.next?.spotId || ['ready_to_craft', 'component_ready'].includes(plan.status))) return [beneficiaryId];
    if (plan?.next?.sourceKind === 'raid' || plan?.next?.raidBoss === true) {
        const profile = invoke('GameServer/RaidBoss/RaidBossSourceCatalog').findById(plan.next.spotId);
        return profile ? ClanRaidPolicy.roster(clan, profile, beneficiary, previousGoal) : [];
    }
    const safety = require('../Bot/Population/ClanEquipmentPartyPolicy');
    const objective = { ...plan?.next, clanOperation: 'equipment', clanId: clan.id };
    const eligible = (clan?.members || []).filter(member => safety.allowed(member, objective));
    const memberIds = new Set(eligible.map(memberId).filter(Boolean));
    const previousBeneficiaryId = number(previousGoal?.target?.memberId);
    const retained = (previousGoal?.assignedMemberIds || []).map(number)
        .filter((id) => memberIds.has(id));
    const requiresSpoiler = String(plan?.next?.kind || '') === 'spoil';
    const retainedHasSpoiler = retained.some((id) => (
        ClanPolicy.rosterRole((clan?.members || []).find((member) => memberId(member) === id)) === 'spoiler'
    ));
    if (beneficiaryId && beneficiaryId === previousBeneficiaryId
        && retained.length >= Math.max(2, number(Config.operationMinMembers, 5))
        && (!requiresSpoiler || retainedHasSpoiler)) return retained;
    const maxMembers = Math.max(2, Math.min(9, number(Config.operationMaxMembers, 9)));
    const selected = GoalPolicy.operationMembers(eligible, maxMembers);
    if (beneficiaryId && memberIds.has(beneficiaryId) && !selected.includes(beneficiaryId)) {
        if (selected.length >= maxMembers) selected.pop();
        selected.unshift(beneficiaryId);
    }
    if (requiresSpoiler && !selected.some((id) => (
        ClanPolicy.rosterRole((clan?.members || []).find((member) => memberId(member) === id)) === 'spoiler'
    ))) {
        const spoiler = eligible.find((member) => (
            member?.phase === 'cold' && !member?.partyId && ClanPolicy.rosterRole(member) === 'spoiler'
        ));
        const spoilerId = memberId(spoiler);
        if (spoilerId) {
            if (selected.length >= maxMembers) selected.pop();
            selected.push(spoilerId);
        }
    }
    return [...new Set(selected.map(number).filter(Boolean))];
}

function clanPartyObjective(plan, goal, priority = 'preferred', clanId = 0) {
    // A craft plan with missing components still has a farming route in
    // `next`; a ready-to-craft plan has no route and therefore needs no party.
    if (['ready_to_craft', 'component_ready'].includes(plan?.status)
        || !['farm', 'craft'].includes(String(goal?.plan?.kind || '')) || !plan?.next?.spotId) return null;
    const strategy = String(plan.strategy || 'direct_drop');
    const targetItemId = number(plan.next.itemId || plan.target?.selfId);
    const npcId = number(plan.next.npcId);
    const objectiveKey = npcId > 0
        ? [strategy, plan.next.spotId, npcId].join(':')
        : [strategy, plan.next.spotId, npcId, targetItemId].join(':');
    const rosterSize = Math.max(1, (goal?.assignedMemberIds || []).length);
    const maxPartySize = Math.max(2, Math.min(9, rosterSize));
    const raid = plan.next?.sourceKind === 'raid' || plan.next?.raidBoss === true;
    const minPartySize = raid
        ? Math.max(2, Math.min(maxPartySize, ClanRaidPolicy.MIN_MEMBERS))
        : Math.max(2, Math.min(maxPartySize, number(Config.operationMinMembers, 5)));
    return {
        status: 'open',
        priority,
        objectiveKey,
        reason: 'clan_equipment',
        partyNeedReason: 'clan_equipment',
        strategy,
        sourceKind: raid ? 'raid' : String(plan.next.kind || 'drop'),
        rewardKind: String(plan.next.kind || 'drop'),
        raidBoss: raid,
        sharedEncounter: raid,
        raidBossTemplateId: raid ? number(plan.next.raidBossTemplateId || plan.next.npcId) : null,
        spotId: plan.next.spotId,
        npcId: npcId || null,
        itemId: targetItemId || null,
        targetId: number(plan.target?.selfId) || null,
        beneficiaryId: number(goal.target?.memberId),
        targetName: plan.target?.name || null,
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
    delete stats.clanMaterialDemand;
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
        const sameRoute = !!expectedObjective && (
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
        const result = await (LifeState.applyClanMaterialTransfer ? (request) => LifeState.applyClanMaterialTransfer(request, true) : Database.transferClanWarehouseToMember)({
            clanId: clan.id,
            characterId: current.characterId,
            selfId: material.selfId,
            amount: material.amount,
            goalKey: `${goal.goalKey}:warehouse:${material.selfId}:${number(state.simulation?.revision ?? state.simulationRevision)}`,
            expectedSimulationRevision: number(state.simulation?.revision ?? state.simulationRevision)
        });
        results.push(result);
        if (!result.ok) {
            recordReason(result.code || 'warehouse_handoff_failed');
            continue;
        }
        invoke('GameServer/Bot/AI/BotClanChat').onWithdrawal(state, result);
        if (result.state) { state = result.state; continue; }
        state = {
            ...state,
            simulationRevision: number(result.simulationRevision, number(state.simulation?.revision ?? state.simulationRevision)),
            inventory: { ...(state.inventory || {}) }
        };
        state = await LifeState.refreshInventory(state, { equip: true });
        state = {
            ...state,
            simulationRevision: number(result.simulationRevision, number(state.simulation?.revision ?? state.simulationRevision))
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
        delete stats.clanMaterialDemand;
        if (stats.partyRequest?.clanGoalKey === old.clanGoalKey) delete stats.partyRequest;
        const saved = await LifeState.upsertState({ ...current, stats }, 'clan_equipment_party_clear');
        return { ok: !!saved, changed: !!saved, memberId: id };
    }
    if (stateHasSameClanObjective(current, objective)) return { ok: true, changed: false, memberId: id };
    const nextObjective = { ...objective, clanId: number(clan.id) };
    const partyRequest = nextObjective;
    const saved = await LifeState.upsertState({
        ...current,
        activity: current.phase === 'cold' && current.activity === 'hunting' ? 'party_wait' : current.activity,
        stats: {
            ...(current.stats || {}),
            clanId: number(clan.id),
            clanMaterialDemand: Object.fromEntries(Crafting.requirements(Crafting.resolveRecipe(plan?.recipeId), {}, null, 1, plan?.craftProviders, plan?.componentRecipes)),
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
    if (handoff.results.some(result => !result.ok)) return { ok: false, code: 'warehouse_handoff_deferred', handoff };
    plan = { ...plan, clanMaterialDemand: Object.fromEntries(Crafting.requirements(Crafting.resolveRecipe(plan.recipeId), {}, null, 1, plan.craftProviders, plan.componentRecipes)) };

    const currentPlan = currentState.stats?.equipmentPlan;
    if (currentPlan?.clanGoal?.clanId
        && number(currentPlan.clanGoal.clanId) !== number(clan.id)
        && !samePlanTarget(currentPlan, plan)) {
        return { ok: false, code: 'member_equipment_plan_conflict', memberId: id, handoff };
    }
    if (samePlanTarget(currentPlan, plan)
        && number(currentPlan.clanGoal?.clanId) === number(clan.id)
        && String(currentPlan.clanGoal?.goalKey || '') === String(goal.goalKey)
        && samePlanRoute(currentPlan, plan)
        && ['status', 'strategy', 'recipeId', 'materials', 'craftProviders', 'componentRecipes', 'next'].every(key => (
            JSON.stringify(currentPlan[key]) === JSON.stringify(plan[key])
        ))) {
        return { ok: true, changed: false, memberId: id, handoff };
    }

    const nextState = {
        ...currentState,
        stats: {
            ...(currentState.stats || {}),
            clanId: number(clan.id),
            equipmentPlan: clanPlan(plan, clan, goal),
            clanMaterialDemand: plan.clanMaterialDemand,
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

async function craftingOptions(clan) {
    const service = { level: 70, stats: { classId: 57 } };
    if (!craftingCatalog || craftingCatalogItems !== DataCache.items) {
        const all = CraftShops.availableRecipes(service);
        craftingCatalog = { all, published: CraftShops.CraftStations.flatMap(station => CraftShops.stationRecipes(station, all)) };
        craftingCatalogItems = DataCache.items;
    }
    const all = craftingCatalog.all;
    const published = new Map(craftingCatalog.published.map(recipe => [Number(recipe.recipeId), recipe]));
    const providers = {};
    const crafters = (clan.members || []).filter(member => member.phase === 'cold'
        && (!member.partyId || Number(member.stats?.clanPartyObjective?.clanId) === Number(clan.id))
        && !['dead', 'respawning'].includes(member.activity)
        && CraftShops.craftLevelFor(member) > 0);
    if (!crafters.length) return { craftRecipes: [...published.values()], allowedRecipeIds: [...published.keys()], craftProviders: providers };
    const rows = await Database.execute([`SELECT recipes.characterId, recipes.recipeId FROM character_recipes recipes
        JOIN characters members ON members.id = recipes.characterId WHERE members.clanId = ?`, [clan.id]], 'clan-craft:recipes');
    const knownByMember = new Map();
    for (const row of rows) {
        const id = Number(row.characterId);
        if (!knownByMember.has(id)) knownByMember.set(id, new Set());
        knownByMember.get(id).add(Number(row.recipeId));
    }
    for (const recipe of all) {
        const eligible = crafters.filter(member => CraftShops.craftLevelFor(member) >= Number(recipe.level));
        const crafter = eligible.find(member => knownByMember.get(memberId(member))?.has(Number(recipe.recipeId))) || eligible[0];
        if (!crafter) continue;
        const known = knownByMember.get(memberId(crafter))?.has(Number(recipe.recipeId)) || false;
        // Prefer a public service over teaching an unknown recipe unnecessarily.
        if (!known && published.has(Number(recipe.recipeId))) continue;
        providers[recipe.recipeId] = { characterId: memberId(crafter), known,
            recipeItemId: Number(recipe.recipeItemId), loc: crafter.loc || { locX: 83400, locY: 148600, locZ: -3400 } };
        const materials = recipe.materials.map(row => ({ ...row }));
        if (!known) {
            const scroll = materials.find(row => Number(row.selfId) === Number(recipe.recipeItemId));
            if (scroll) scroll.amount += 1;
            else materials.push({ selfId: Number(recipe.recipeItemId), amount: 1 });
        }
        published.set(Number(recipe.recipeId), { ...recipe, materials });
    }
    return { craftRecipes: [...published.values()], allowedRecipeIds: [...published.keys()], craftProviders: providers };
}

async function planningForClan(clan, previousGoal = null, options = {}) {
    // A planning pass compares the same clan snapshot against many raid bosses.
    // Readiness only depends on the member snapshot, so calculate it once per
    // member instead of rebuilding equipped-item projections for every boss.
    const raidReadinessCache = new Map();
    const candidateSpots = options.spots || (() => {
        try {
            const profiles = SpotProfiles.ensure();
            const liveRaidIds = invoke('GameServer/RaidBoss/RaidBossSourceCatalog').liveTemplateIds();
            return profiles.flatMap((profile) => {
                if (profile.raidBoss !== true) return [profile];
                if (!liveRaidIds.has(number(profile.raidBossTemplateId))) return [];
                const assessment = ClanRaidPolicy.assessment(
                    clan,
                    profile,
                    previousGoal,
                    { readinessCache: raidReadinessCache }
                );
                if (!assessment.ready) return [];
                const raidRosterSize = assessment.eligible.length;
                return [{ ...profile, raidRosterSize, raidEstimate: assessment.raidEstimate }];
            });
        } catch (error) {
            recordReason('spot_index_unavailable');
            return [];
        }
    })();
    const blockedRaidSpots = ClanRaidFailurePolicy.blockedSpotIds(previousGoal);
    const spots = candidateSpots.filter((profile) => !blockedRaidSpots.has(String(profile.id)));
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
    const craftOptions = await craftingOptions(clan);
    const previousMemberId = number(previousGoal?.target?.memberId);
    const reservationOptions = reservationOptionsForClan(clan);
    const previousAssigned = new Set((previousGoal?.assignedMemberIds || []).map(number).filter(Boolean));
    const spoilCapable = (clan.members || []).some((member) => (
        member?.phase === 'cold'
        && (!member?.partyId || previousAssigned.has(memberId(member)))
        && String(member?.simulationOwner || 'legacy_main') === 'legacy_main'
        && ClanPolicy.rosterRole(member) === 'spoiler'
    ));
    const members = planningMemberOrder(
        clan.members || [],
        previousMemberId,
        previousFulfilled
    );
    const planningWindow = Math.max(1, number(Config.operationMinMembers, 5));
    const plans = new Map();
    const workerFingerprint = PlanningWorker.enabled() ? planningFingerprint(clan) : null;
    // Unrelated clan members continue earning loot while the worker calculates.
    // Validate their roster/equipment, but fence consumable inventory and adena
    // only for the beneficiary selected for application, avoiding retry starvation.
    const beneficiaryFingerprints = workerFingerprint
        ? Object.fromEntries(members.map((member) => [memberId(member), beneficiaryFingerprint(member)]))
        : null;
    let workerContext;
    const planningDeadline = number(options.planningDeadline)
        || Date.now() + Math.min(45000, Math.max(1000, Config.actionLeaseMs - 5000));
    if (workerFingerprint && members.length) {
        try { workerContext = await PlanningWorker.context(); }
        catch (error) { throw planningDeferred(error.message); }
    }
    for (let index = 0; index < members.length; index++) {
        if (workerFingerprint && Date.now() >= planningDeadline) throw planningDeferred('clan planning deadline');
        const member = members[index];
        const id = number(member.characterId ?? member.id);
        const capacityUnits = equipmentRoster(clan, member, previousGoal).length;
        const memberSpots = spots.filter((spot) => spot.raidBoss !== true
            || ClanRaidPolicy.availableMember(member, spot,
                new Set((previousGoal?.assignedMemberIds || []).map(number).filter(Boolean))));
        const memberOptions = {
            ...craftOptions,
            ignoreExistingPlan: previousFulfilled && id === previousMemberId,
            occupancy,
            capacityUnits,
            spoilCapable,
            allowRaidSources: memberSpots.some((spot) => spot.raidBoss === true),
            maxExpectedKills: Config.equipmentMaxExpectedKills,
            ...reservationOptions,
            excludedTargetIds: options.excludedTargetIds || []
        };
        let plan;
        if (workerFingerprint) {
            try {
                plan = await PlanningWorker.plan({ member, spots: memberSpots, warehouseRows, options: memberOptions, context: workerContext, deadlineAt: planningDeadline });
                if (Date.now() >= planningDeadline) throw planningDeferred('clan planning deadline');
            } catch (error) {
                recordReason('clan_planning_worker_unavailable');
                throw planningDeferred(error.message);
            }
        } else {
            // Synchronous harnesses use the identical pure planner. Runtime enables
            // the worker at startup and never falls back here after a worker failure.
            plan = planForMember(member, memberSpots, warehouseRows, memberOptions);
        }
        plans.set(id, plan);
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
        previousFulfilled,
        workerFingerprint,
        beneficiaryFingerprints,
        planningDeadline
    };
}

async function recordRaidFailure(party, timestamp = Date.now()) {
    const objective = party?.stats?.objective;
    const encounter = party?.stats?.raidEncounter;
    const clanId = number(objective?.clanId);
    const goalKey = String(objective?.clanGoalKey || '');
    if (!clanId || !goalKey || encounter?.status !== 'failed') {
        return { ok: false, skipped: true, code: 'raid_failure_context_missing' };
    }

    for (let attempt = 0; attempt < 2; attempt++) {
        const clan = await invoke('GameServer/Clan/ClanGoalService').clanProjectionById(clanId);
        const current = clan?.state?.goal;
        if (!current || String(current.goalKey || '') !== goalKey) {
            return { ok: true, skipped: true, code: 'raid_goal_changed' };
        }
        if (String(current.controlledBy || '') === 'player') {
            return { ok: true, skipped: true, code: 'player_order_controls_replan' };
        }
        if (String(current.raidFailure?.partyId || '') === String(party.partyId)
            && number(current.raidFailure?.failedAt) === number(encounter.failedAt, timestamp)) {
            return { ok: true, skipped: true, code: 'raid_failure_already_recorded', goal: current };
        }

        const failure = ClanRaidFailurePolicy.decision(current.raidFailure, encounter);
        const next = {
            ...current,
            raidFailure: {
                ...failure,
                failedAt: number(encounter.failedAt, timestamp),
                partyId: party.partyId,
                failureReason: String(encounter.failureReason || 'party_death')
            },
            partyId: null,
            catastrophicFailures: number(current.catastrophicFailures) + 1,
            status: 'executing',
            reasonCodes: [...new Set([...(current.reasonCodes || []), failure.reasonCode])],
            updatedAt: timestamp
        };
        const saved = await Database.updateAutonomousClanGoal({
            clanId,
            goal: next,
            expectedUpdatedAt: number(clan.state?.updatedAt) || null,
            eventType: 'equipment_raid_failed',
            reasonCode: failure.reasonCode
        });
        if (saved.ok) {
            await Database.enqueueClanAction({
                clanId,
                actionKey: `clan:${clanId}:raid-failed:${failure.bossTemplateId}:${number(encounter.failedAt, timestamp)}`,
                actionType: 'goal_plan',
                priority: 90,
                availableAt: timestamp,
                payload: {
                    reason: 'equipment_raid_failed',
                    goalKey,
                    bossTemplateId: failure.bossTemplateId,
                    retryAllowed: failure.retryAllowed
                }
            });
            recordReason(failure.reasonCode);
            return { ...saved, failure };
        }
        if (saved.code !== 'ownership_conflict') return { ...saved, failure };
    }
    return { ok: false, code: 'ownership_conflict' };
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
    if (!clan || !number(clan.id)) {
        return { ok: true, skipped: true, reason: 'equipment_level_unavailable' };
    }
    const activeRaidParty = activeRaidPartyForClan(clan.id);
    if (activeRaidParty) {
        recordReason('raid_in_progress');
        return {
            ok: true,
            skipped: true,
            reason: 'raid_in_progress',
            goal: previousGoal,
            partyId: activeRaidParty.partyId
        };
    }
    const planning = options.planning || await planningForClan(clan, previousGoal, options);
    const { plans, previousFulfilled } = planning;
    const selection = selectedPlanningTarget(clan, previousGoal, planning, options.selectedCandidate);
    await validatePlanning(clan, planning, selection);
    const raidPartyAfterPlanning = activeRaidPartyForClan(clan.id);
    if (raidPartyAfterPlanning) {
        recordReason('raid_in_progress');
        return {
            ok: true,
            skipped: true,
            reason: 'raid_in_progress',
            goal: previousGoal,
            partyId: raidPartyAfterPlanning.partyId
        };
    }
    if (!selection) {
        metrics.noDebt += 1;
        recordReason('no_equipment_debt');
        return { ok: true, skipped: true, reason: 'no_equipment_debt', plans };
    }
    if (planning.workerFingerprint && selection.plan?.strategy === 'market') {
        const currentOffer = invoke('GameServer/Bot/Economy/MarketOpportunity').bestOffer(selection.plan.target.selfId, {
            town: selection.plan.market?.town,
            buyerCharacterId: memberId(selection.member)
        });
        if (!currentOffer || Number(currentOffer.price) !== Number(selection.plan.market?.price)
            || currentOffer.sourceType !== selection.plan.market?.sourceType) {
            throw planningDeferred('clan planning market offer changed');
        }
    }

    const assignedMemberIds = equipmentRoster(clan, selection.member, previousGoal, selection.plan);
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
                planningDeadline: planning.planningDeadline,
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
    const craftReady = ['ready_to_craft', 'component_ready'].includes(selection.plan?.status);
    const craftMembers = craftReady ? Object.values(selection.plan.craftProviders || {}).map(provider => number(provider.characterId)) : [];
    const partyReform = await releaseConflictingRosterParties([...new Set([...assignedMemberIds, ...craftMembers])], goal, expectedObjective);
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
    craftingOptions,
    planForMember,
    planningFingerprint,
    validatePlanning,
    equipmentRoster,
    activeRaidPartyForClan,
    recordRaidFailure,
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
            worker: PlanningWorker.metrics(),
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
