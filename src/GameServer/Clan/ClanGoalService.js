const Database = invoke('Database');
const Config = invoke('GameServer/Clan/ClanSimulationConfig');
const Contracts = invoke('GameServer/Clan/ClanSimulationContracts');
const ContributionPolicy = invoke('GameServer/Clan/ClanContributionPolicy');
const GoalPolicy = invoke('GameServer/Clan/ClanGoalPolicy');
const ClanSimulationPolicy = invoke('GameServer/Clan/ClanSimulationPolicy');
const ClanEquipmentService = invoke('GameServer/Clan/ClanEquipmentService');
const ClanGoalCandidateService = invoke('GameServer/Clan/ClanGoalCandidateService');
const ClanContextAssembler = invoke('GameServer/Clan/ClanContextAssembler');
const ClanBrain = invoke('GameServer/Clan/ClanBrain');
const ClanCrestService = invoke('GameServer/Clan/ClanCrestService');
const ClanService = invoke('GameServer/Clan/ClanService');
const DataCache = invoke('GameServer/DataCache');

const metrics = {
    resolves: 0,
    goalsCreated: 0,
    goalsUpdated: 0,
    goalsCompleted: 0,
    activeGoals: 0,
    demandCreated: 0,
    demandRefreshed: 0,
    preparationCycles: 0,
    replans: 0,
    catastrophicFailures: 0,
    levelUps: 0,
    budgetStops: 0,
    planCounts: new Map(),
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

function record(map, value) {
    if (value) map.set(value, (map.get(value) || 0) + 1);
}

function goalComparable(goal) {
    if (!goal) return null;
    const copy = JSON.parse(JSON.stringify(goal));
    delete copy.createdAt;
    delete copy.updatedAt;
    if (copy.plan) delete copy.plan.selectedAt;
    return copy;
}

async function clanProjection(clanId = null) {
    const hasClanId = Number(clanId) > 0;
    const rows = await Database.execute([`
        SELECT simulated.clanId, simulated.stateJson,
               clans.name, clans.level, clans.leaderId,
               members.id AS characterId, members.name AS memberName,
               members.title AS memberTitle, members.classId, members.level AS memberLevel, members.clanId AS memberClanId,
               life.accountName, life.activity, life.phase, life.adena, life.currentRegion,
               life.partyId,
               life.simulationOwner, life.simulationRevision, life.inventorySummary, life.statsJson
        FROM clan_simulation_clans simulated
        JOIN clans ON clans.id = simulated.clanId
        JOIN characters members ON members.clanId = simulated.clanId
        LEFT JOIN bot_life_state life ON life.characterId = members.id
        ${hasClanId ? 'WHERE simulated.clanId = ?' : ''}
        ORDER BY simulated.clanId ASC, members.id ASC
    `, hasClanId ? [Number(clanId)] : []], hasClanId ? 'clan-goal:projection-one' : 'clan-goal:projection');
    const byId = new Map();
    rows.forEach((row) => {
        const clanId = number(row.clanId);
        if (!byId.has(clanId)) {
            byId.set(clanId, {
                id: clanId,
                name: String(row.name || ''),
                level: number(row.level),
                leaderId: number(row.leaderId),
                state: parseJson(row.stateJson, {}),
                members: []
            });
        }
        const member = {
            characterId: number(row.characterId),
            id: number(row.characterId),
            name: String(row.memberName || ''),
            title: String(row.memberTitle || ''),
            classId: number(row.classId, -1),
            level: number(row.memberLevel),
            clanId: number(row.memberClanId),
            accountName: String(row.accountName || ''),
            activity: String(row.activity || ''),
            phase: String(row.phase || ''),
            currentRegion: String(row.currentRegion || ''),
            partyId: row.partyId || null,
            simulationOwner: String(row.simulationOwner || 'legacy_main'),
            adena: number(row.adena),
            simulationRevision: number(row.simulationRevision),
            inventory: parseJson(row.inventorySummary, {}),
            stats: parseJson(row.statsJson, {})
        };
        if (!ClanSimulationPolicy.isStaticService(member)) byId.get(clanId).members.push(member);
    });
    return [...byId.values()];
}

async function clanProjectionById(clanId) {
    const clans = await clanProjection(clanId);
    return clans[0] || null;
}

function bloodMarkSourceLevel() {
    return number((DataCache.npcs || [])
        .find((npc) => number(npc.selfId) === number(Config.bloodMarkSourceNpcId))
        ?.template?.level, 60);
}

function levelingProgress(members = [], count = Config.operationMinMembers) {
    const requiredMembers = Math.max(1, number(count, Config.operationMinMembers));
    const levels = members
        .filter(GoalPolicy.operationAvailable)
        .map((member) => number(member.level))
        .filter((level) => level > 0)
        .sort((left, right) => right - left)
        .slice(0, requiredMembers);
    // The fifth fighter is the gating member for a five-bot operation. An
    // average could mark the preparation goal complete while one member is
    // still below the source threshold, which would stop future replans.
    return levels.length >= requiredMembers ? Math.min(...levels) : 0;
}

async function contextFor(clan) {
    const level = number(clan.level);
    const members = clan.members || [];
    if (level <= 1) {
        const summary = (await Database.fetchClanContributionSummary(clan.id, level))[0] || { amount: 0 };
        const warehouse = (await Database.fetchClanWarehouseItems(clan.id))
            .filter((item) => Number(item.selfId) === 57)
            .reduce((sum, item) => sum + number(item.amount), 0);
        return {
            required: ContributionPolicy.scaledAdenaRequirement(level),
            progress: number(summary.amount),
            warehouse,
            itemId: 0,
            itemName: '',
            partyReady: false,
            members
        };
    }
    if (level >= 3) return { required: 1, progress: 1, warehouse: 1, itemId: Config.bloodMarkItemId, itemName: 'Blood Mark', members };

    const warehouseRows = await Database.fetchClanWarehouseItems(clan.id);
    const stock = warehouseRows
        .filter((item) => Number(item.selfId) === Number(Config.bloodMarkItemId))
        .reduce((sum, item) => sum + Math.max(0, number(item.amount) - number(item.reservedAmount)), 0);
    const demands = await Database.fetchClanMarketDemands({ clanId: clan.id, itemId: Config.bloodMarkItemId, status: 'open', limit: 4 });
    const latestDemand = demands.sort((left, right) => number(right.updatedAt) - number(left.updatedAt))[0] || null;
    const sourceLevel = bloodMarkSourceLevel();
    const targetLevel = GoalPolicy.operationLevelThreshold(sourceLevel);
    const readyMembers = GoalPolicy.levelReadyMembers(members, sourceLevel);
    if (stock < 1 && readyMembers.length < Config.operationMinMembers) {
        return {
            required: targetLevel,
            progress: levelingProgress(members),
            warehouse: stock,
            itemId: Config.bloodMarkItemId,
            itemName: 'Blood Mark',
            sourceNpcId: Config.bloodMarkSourceNpcId,
            sourceLevel,
            levelingTargetLevel: targetLevel,
            levelingProgress: levelingProgress(members),
            marketDemand: latestDemand,
            partyReady: false,
            craftReady: false,
            members
        };
    }
    return {
        required: 1,
        progress: stock,
        warehouse: stock,
        itemId: Config.bloodMarkItemId,
        itemName: 'Blood Mark',
        sourceNpcId: Config.bloodMarkSourceNpcId,
        sourceLevel,
        marketOffer: false,
        marketOfferPrice: 0,
        marketDemandFresh: false,
        marketDemand: latestDemand,
        // Missing support inside the clan is repaired by ClanPartyService.
        // It must not keep a level-ready Blood Mark goal in prepare forever.
        partyReady: true,
        craftReady: false,
        members,
        operationMembers: readyMembers
    };
}

async function cancelLegacyBloodMarkDemand(clan, context) {
    const demand = context?.marketDemand;
    if (!demand) return null;
    const cancelled = await Database.upsertClanMarketDemand({
        clanId: clan.id,
        itemId: Config.bloodMarkItemId,
        amount: Math.max(1, number(demand.amount, 1)),
        maxPrice: Math.max(1, number(demand.maxPrice, Config.bloodMarkMaxPrice)),
        goalKey: demand.goalKey,
        status: 'cancelled'
    });
    await Database.syncClanMarketDemandSignal({
        clanId: clan.id,
        itemId: Config.bloodMarkItemId,
        amount: Math.max(1, number(demand.amount, 1)),
        maxPrice: Math.max(1, number(demand.maxPrice, Config.bloodMarkMaxPrice)),
        goalKey: demand.goalKey,
        status: 'cancelled'
    });
    return cancelled;
}

async function resolveClan(clan, options = {}) {
    if (!clan) return { ok: true, skipped: true, reason: 'target_not_autonomous' };
    if (number(clan.level) >= 3) {
        const previous = clan.state?.goal || null;
        const candidateSnapshot = await ClanGoalCandidateService.snapshotFor(clan, previous, options);
        const brain = candidateSnapshot.decisionNeeded
            ? ClanBrain.choose(clan, candidateSnapshot, options)
            : null;
        if (brain?.pending) {
            return {
                ok: true,
                clanId: clan.id,
                level: number(clan.level),
                changed: false,
                skipped: true,
                pending: true,
                reason: brain.reasonCode,
                decisionKey: brain.key,
                context: {
                    candidateCount: candidateSnapshot.candidates.length,
                    cacheHit: candidateSnapshot.cacheHit
                }
            };
        }
        const equipment = await ClanEquipmentService.resolveClan(clan, previous, {
            ...options,
            planning: candidateSnapshot.planning,
            selectedCandidate: brain?.candidate || null
        });
        if (equipment.skipped) {
            return {
                ok: true,
                clanId: clan.id,
                level: number(clan.level),
                changed: false,
                skipped: true,
                reason: equipment.reason,
                goal: previous,
                context: { members: clan.members || [] }
            };
        }
        if (!equipment.ok) {
            return equipment;
        }
        const goal = equipment.goal;
        const changed = JSON.stringify(goalComparable(previous)) !== JSON.stringify(goalComparable(goal));
        let persisted = { ok: true, goal: previous };
        if (changed) {
            const eventType = !previous ? 'equipment_goal_created'
                : equipment.previousFulfilled ? 'equipment_goal_advanced'
                    : 'equipment_goal_updated';
            persisted = await Database.updateAutonomousClanGoal({
                clanId: clan.id,
                goal,
                expectedUpdatedAt: number(equipment.expectedUpdatedAt ?? clan.state?.updatedAt) || null,
                eventType,
                reasonCode: goal.plan?.reasonCode || ''
            });
            if (persisted.ok) {
                if (!previous) metrics.goalsCreated += 1;
                else metrics.goalsUpdated += 1;
                if (brain?.source === 'llm') {
                    await Database.recordClanGoalEvent({
                        clanId: clan.id,
                        eventType: 'llm_goal_selected',
                        goalType: goal.type,
                        plan: goal.plan?.kind || '',
                        reasonCode: brain.reasonCode || 'llm_goal_selected',
                        payload: {
                            candidateId: brain.candidateId,
                            route: brain.route,
                            target: goal.target,
                            context: brain.contextTelemetry || null,
                            usage: brain.usage || null
                        }
                    });
                }
            }
        }
        record(metrics.planCounts, goal.plan?.kind);
        metrics.activeGoals += goal.status !== 'completed' ? 1 : 0;
        return {
            ok: !!persisted.ok,
            clanId: clan.id,
            level: number(clan.level),
            changed,
            goal: persisted.goal || goal,
            context: {
                members: clan.members || [],
                plans: equipment.plans,
                candidateCount: candidateSnapshot.candidates.length,
                candidateCacheHit: candidateSnapshot.cacheHit,
                decisionSource: brain?.source || 'deterministic',
                decisionReason: brain?.reasonCode || candidateSnapshot.decisionReason
            },
            assignment: equipment.assignment,
            reason: persisted.code || null
        };
    }
    const context = await contextFor(clan);
    const cancelledDemand = await cancelLegacyBloodMarkDemand(clan, context);
    const previous = clan.state?.goal || null;
    if (number(clan.level) === 2 && number(context.progress) >= number(context.required)) {
        const advanced = await Database.advanceAutonomousClanLevel({
            clanId: clan.id,
            fromLevel: 2,
            toLevel: 3,
            requiredAmount: 1,
            requiredItemId: Config.bloodMarkItemId,
            requiredItemAmount: 1
        });
        if (advanced.ok) {
            metrics.levelUps += 1;
            metrics.goalsCompleted += previous?.status === 'completed' ? 0 : 1;
            record(metrics.reasonCounts, Contracts.REASON_CODES.CONTRIBUTION_LEVEL_UP);
            await ClanCrestService.ensureAutonomousCrest(clan.id);
            if (typeof ClanService.reload === 'function') await ClanService.reload();
            return {
                ok: true,
                clanId: clan.id,
                level: 3,
                changed: true,
                goal: null,
                advanced,
                context,
                reason: advanced.code || null
            };
        }
        if (advanced.code !== 'level_already_advanced') {
            return { ok: false, clanId: clan.id, level: 2, changed: false, goal: previous, advanced, context, reason: advanced.code };
        }
        return {
            ok: true,
            clanId: clan.id,
            level: number(advanced.level, 3),
            changed: false,
            skipped: true,
            goal: previous,
            advanced,
            context,
            reason: advanced.code
        };
    }
    let goal = GoalPolicy.buildGoal(clan, context, previous, {
        timestamp: Date.now(),
        failureThreshold: Config.catastrophicFailureThreshold
    });
    const demand = null;
    if (goal.type === 'item' && demand?.created && !context.marketOffer) {
        context.marketDemandFresh = true;
        goal = GoalPolicy.buildGoal(clan, context, previous, {
            timestamp: Date.now(),
            failureThreshold: Config.catastrophicFailureThreshold
        });
    }

    const changed = JSON.stringify(goalComparable(previous)) !== JSON.stringify(goalComparable(goal));
    let persisted = { ok: true, goal: previous };
    if (changed) {
        const eventType = !previous ? 'goal_created'
            : goal.status === 'completed' ? 'goal_completed'
                : previous.plan?.kind !== goal.plan?.kind ? 'goal_plan_selected' : 'goal_progress';
        persisted = await Database.updateAutonomousClanGoal({
            clanId: clan.id,
            goal,
            expectedUpdatedAt: number(clan.state?.updatedAt) || null,
            eventType,
            reasonCode: goal.plan?.reasonCode || ''
        });
        if (persisted.ok) {
            if (!previous) metrics.goalsCreated += 1;
            else metrics.goalsUpdated += 1;
            if (goal.status === 'completed' && previous?.status !== 'completed') metrics.goalsCompleted += 1;
        }
    }
    if (goal.status === 'completed') record(metrics.reasonCounts, Contracts.REASON_CODES.GOAL_COMPLETED);
    else record(metrics.reasonCounts, goal.plan?.reasonCode);
    record(metrics.planCounts, goal.plan?.kind);
    if (goal.status === 'preparing') metrics.preparationCycles += 1;
    if (goal.status !== 'completed') metrics.activeGoals += 1;
    return {
        ok: !!persisted.ok,
        clanId: clan.id,
        level: number(clan.level),
        changed,
        goal: persisted.goal || goal,
        demand,
        cancelledDemand,
        context,
        reason: persisted.code || null
    };
}

async function recordCatastrophicFailure(clanId, reasonCode = Contracts.REASON_CODES.PARTY_CATASTROPHIC_FAILURE) {
    const clans = await clanProjection();
    const clan = clans.find((entry) => number(entry.id) === number(clanId));
    if (!clan?.state?.goal) return { ok: false, code: 'goal_missing' };
    const context = await contextFor(clan);
    const next = GoalPolicy.replanGoal(clan.state.goal, {
        ...context,
        level: number(clan.level),
        members: clan.members
    }, reasonCode, {
        failureThreshold: Config.catastrophicFailureThreshold
    });
    const result = await Database.updateAutonomousClanGoal({
        clanId: clan.id,
        goal: next,
        expectedUpdatedAt: number(clan.state.updatedAt) || null,
        eventType: 'goal_replanned',
        reasonCode
    });
    if (result.ok) {
        metrics.catastrophicFailures += 1;
        metrics.replans += 1;
        record(metrics.reasonCounts, Contracts.REASON_CODES.GOAL_REPLANNED);
    }
    return { ...result, goal: next };
}

const ClanGoalService = {
    config: Config,
    policy: GoalPolicy,
    clanProjection,
    clanProjectionById,
    resolveClan,
    recordCatastrophicFailure,

    resolveBatch(limit = Config.resolveBatchSize, options = {}) {
        if (!Config.enabled) return Promise.resolve({ attempted: 0, changed: 0, budgetStopped: false });
        const deadlineAt = Date.now() + Math.max(1, number(options.budgetMs, Config.resolveBudgetMs));
        return clanProjection().then(async (clans) => {
            const summary = { attempted: 0, changed: 0, completed: 0, budgetStopped: false };
            for (const clan of clans.slice(0, Math.max(1, number(limit, Config.resolveBatchSize)))) {
                if (Date.now() >= deadlineAt) {
                    summary.budgetStopped = true;
                    metrics.budgetStops += 1;
                    break;
                }
                const result = await resolveClan(clan, { deadlineAt });
                summary.attempted += 1;
                summary.changed += result.changed ? 1 : 0;
                summary.completed += result.goal?.status === 'completed' ? 1 : 0;
            }
            metrics.resolves += summary.attempted;
            return summary;
        });
    },

    metrics() {
        return {
            resolves: metrics.resolves,
            goalsCreated: metrics.goalsCreated,
            goalsUpdated: metrics.goalsUpdated,
            goalsCompleted: metrics.goalsCompleted,
            activeGoals: metrics.activeGoals,
            demandCreated: metrics.demandCreated,
            demandRefreshed: metrics.demandRefreshed,
            preparationCycles: metrics.preparationCycles,
            replans: metrics.replans,
            catastrophicFailures: metrics.catastrophicFailures,
            levelUps: metrics.levelUps,
            budgetStops: metrics.budgetStops,
            planCounts: Object.fromEntries(metrics.planCounts.entries()),
            reasonCounts: Object.fromEntries(metrics.reasonCounts.entries()),
            equipment: ClanEquipmentService.metrics(),
            candidates: ClanGoalCandidateService.metrics(),
            context: ClanContextAssembler.metrics(),
            llm: ClanBrain.metrics()
        };
    },

    resetMetrics() {
        Object.keys(metrics).forEach((key) => {
            if (metrics[key] instanceof Map) metrics[key].clear();
            else metrics[key] = 0;
        });
    }
};

module.exports = ClanGoalService;
