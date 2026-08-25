const Database = invoke('Database');
const Config = invoke('GameServer/Clan/ClanSimulationConfig');
const Contracts = invoke('GameServer/Clan/ClanSimulationContracts');
const GoalService = invoke('GameServer/Clan/ClanGoalService');
const GoalPolicy = invoke('GameServer/Clan/ClanGoalPolicy');
const ClanPolicy = invoke('GameServer/Clan/ClanSimulationPolicy');
const ClanService = invoke('GameServer/Clan/ClanService');
const BackgroundDropResolver = invoke('GameServer/Bot/Population/BackgroundDropResolver');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const BackgroundPartyState = invoke('GameServer/Bot/Population/BackgroundPartyState');
const ClanCrestService = invoke('GameServer/Clan/ClanCrestService');

const metrics = {
    resolves: 0,
    operationsStarted: 0,
    operationsResolved: 0,
    operationsSucceeded: 0,
    operationsFailed: 0,
    drops: 0,
    levelUps: 0,
    catastrophicFailures: 0,
    memberReservationConflicts: 0,
    supportPartiesReclaimed: 0,
    supportMembersReleased: 0,
    budgetStops: 0,
    reasonCounts: new Map()
};

function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function recordReason(code) {
    if (code) metrics.reasonCounts.set(code, (metrics.reasonCounts.get(code) || 0) + 1);
}

function parseIds(value) {
    if (Array.isArray(value)) return value.map(Number).filter(Boolean);
    try {
        const parsed = JSON.parse(value || '[]');
        return Array.isArray(parsed) ? parsed.map(Number).filter(Boolean) : [];
    } catch (_) {
        return [];
    }
}

function memberById(clan, id) {
    return (clan?.members || []).find((member) => number(member.characterId ?? member.id) === number(id));
}

function averageLevel(clan, ids) {
    const levels = ids.map((id) => number(memberById(clan, id)?.level)).filter((level) => level > 0);
    return levels.length ? levels.reduce((sum, level) => sum + level, 0) / levels.length : 0;
}

function operationKey(clan, goal) {
    return `${number(clan.id)}:farm:${number(goal.updatedAt)}:${number(goal.catastrophicFailures)}`;
}

function operationRoster(clan, goal) {
    const assigned = parseIds(goal.assignedMemberIds);
    const candidates = assigned.length
        ? assigned.map((id) => memberById(clan, id)).filter(Boolean)
        : clan.members;
    const selected = GoalPolicy.operationMembers(candidates, Config.operationMaxMembers);
    const selectedMembers = selected.map((id) => memberById(clan, id)).filter(Boolean);
    return {
        selected,
        ready: selected.length >= Config.operationMinMembers && GoalPolicy.hasReadyRoles(selectedMembers)
    };
}

function sameIds(left = [], right = []) {
    return left.length === right.length && left.every((id, index) => Number(id) === Number(right[index]));
}

function protectedClanParty(party) {
    return Number(party?.stats?.objective?.clanId || party?.stats?.acquisitionGoal?.clanGoal?.clanId || 0) > 0;
}

function requiredRoleParties(clan) {
    const readyRoles = new Set((clan?.members || [])
        .filter(GoalPolicy.operationAvailable)
        .map((member) => ClanPolicy.rosterRole(member)));
    const missingRoles = ['tank', 'healer', 'buffer'].filter((role) => !readyRoles.has(role));
    const selectedPartyIds = [];
    const selected = new Set();
    missingRoles.forEach((role) => {
        const candidate = (clan?.members || [])
            .filter((member) => member?.phase === 'cold'
                && String(member?.partyId || '')
                && ClanPolicy.rosterRole(member) === role)
            .sort((left, right) => number(right.level) - number(left.level)
                || number(left.characterId ?? left.id) - number(right.characterId ?? right.id))
            .find((member) => {
                const partyId = String(member.partyId || '');
                const party = BackgroundPartyState.find(partyId);
                return party?.status === 'active' && !protectedClanParty(party) && !selected.has(partyId);
            });
        if (!candidate) return;
        const partyId = String(candidate.partyId);
        selected.add(partyId);
        selectedPartyIds.push(partyId);
    });
    return selectedPartyIds;
}

async function reclaimRequiredRoleParties(clan) {
    const partyIds = requiredRoleParties(clan);
    let releasedMembers = 0;
    const reclaimedPartyIds = [];
    for (const partyId of partyIds) {
        const dissolved = await BackgroundPartyState.setStatus(partyId, 'dissolved');
        if (!dissolved) continue;
        const released = await LifeState.releaseDissolvedPartyMembers(partyId, 'clan_operation_reclaimed');
        releasedMembers += number(released);
        reclaimedPartyIds.push(partyId);
    }
    metrics.supportPartiesReclaimed += reclaimedPartyIds.length;
    metrics.supportMembersReleased += releasedMembers;
    return { reclaimedPartyIds, releasedMembers };
}

async function refreshOperationRoster(clan, goal) {
    const assigned = parseIds(goal.assignedMemberIds).sort((left, right) => left - right);
    const clanMemberIds = new Set((clan.members || []).map((member) => number(member.characterId ?? member.id)).filter(Boolean));
    const retained = assigned.filter((id) => clanMemberIds.has(Number(id)));
    const available = GoalPolicy.operationMembers(clan.members, Config.operationMaxMembers);
    const projected = [...available, ...retained.filter((id) => !available.includes(Number(id)))]
        .slice(0, Config.operationMaxMembers)
        .sort((left, right) => left - right);
    if (sameIds(assigned, projected)) return { changed: false, goal };
    const nextGoal = {
        ...goal,
        assignedMemberIds: projected,
        updatedAt: Date.now()
    };
    const persisted = await Database.updateAutonomousClanGoal({
        clanId: clan.id,
        goal: nextGoal,
        expectedUpdatedAt: number(clan.state?.updatedAt) || null,
        eventType: 'party_roster_refreshed',
        reasonCode: Contracts.REASON_CODES.PARTY_NOT_READY
    });
    return { ...persisted, changed: !!persisted.ok, goal: persisted.goal || nextGoal };
}

async function startOperation(clan, goal) {
    const roster = operationRoster(clan, goal);
    if (!roster.ready) {
        recordReason(Contracts.REASON_CODES.PARTY_NOT_READY);
        return { ok: false, code: Contracts.REASON_CODES.PARTY_NOT_READY, skipped: true };
    }
    const selected = roster.selected;
    const result = await Database.startAutonomousClanOperation({
        clanId: clan.id,
        operationKey: operationKey(clan, goal),
        operationType: 'farm',
        targetNpcId: number(goal.plan?.sourceId) || Config.bloodMarkSourceNpcId,
        leaderId: number(clan.leaderId),
        memberIds: selected,
        expectedGoalUpdatedAt: number(clan.state?.updatedAt) || null
    });
    if (result.ok && !result.idempotent) metrics.operationsStarted += 1;
    if (!result.ok && result.code === Contracts.REASON_CODES.PARTY_MEMBER_RESERVATION_CONFLICT) {
        metrics.memberReservationConflicts += 1;
    }
    recordReason(result.code);
    return { ...result, memberIds: selected };
}

async function resolveActiveOperation(clan, goal, operation, options = {}) {
    const memberIds = parseIds(operation.memberIdsJson);
    const killerLevel = Math.max(1, Math.round(averageLevel(clan, memberIds)));
    const forceFailure = options.forceFailure === true;
    let drops = [];
    if (!forceFailure) {
        drops = BackgroundDropResolver.rollForFight({
            spot: {
                npcSelfIds: [number(operation.targetNpcId) || Config.bloodMarkSourceNpcId],
                avgLevel: Math.max(1, number(goal.target?.sourceLevel, 60))
            },
            killerLevel,
            npcSelfId: number(operation.targetNpcId) || Config.bloodMarkSourceNpcId,
            rng: typeof options.rng === 'function' ? options.rng : Math.random,
            maxItems: 1
        });
    }
    const success = !forceFailure;
    const completion = await Database.completeAutonomousClanOperation({
        operationId: operation.id,
        success,
        drops,
        reasonCode: success ? Contracts.REASON_CODES.PARTY_OPERATION_SUCCEEDED : Contracts.REASON_CODES.PARTY_CATASTROPHIC_FAILURE
    });
    if (!completion.ok) {
        recordReason(completion.code);
        return completion;
    }
    if (completion.idempotent) return completion;

    metrics.operationsResolved += 1;
    if (success) {
        metrics.operationsSucceeded += 1;
        metrics.drops += drops.reduce((sum, drop) => sum + number(drop.amount), 0);
        recordReason(Contracts.REASON_CODES.PARTY_OPERATION_SUCCEEDED);
    } else {
        metrics.operationsFailed += 1;
        recordReason(Contracts.REASON_CODES.PARTY_CATASTROPHIC_FAILURE);
        const replanned = await GoalService.recordCatastrophicFailure(
            clan.id,
            Contracts.REASON_CODES.PARTY_CATASTROPHIC_FAILURE
        );
        if (replanned.ok) metrics.catastrophicFailures += 1;
    }

    const rewardAmount = drops
        .filter((drop) => number(drop.selfId) === Config.bloodMarkItemId)
        .reduce((sum, drop) => sum + number(drop.amount), 0);
    if (success && rewardAmount > 0 && number(clan.level) === 2) {
        const demandKey = `${clan.id}:level-${number(clan.level)}:${Config.bloodMarkItemId}`;
        await Database.upsertClanMarketDemand({
            clanId: clan.id,
            itemId: Config.bloodMarkItemId,
            amount: 1,
            maxPrice: Config.bloodMarkMaxPrice,
            goalKey: demandKey,
            status: 'fulfilled'
        });
        await Database.syncClanMarketDemandSignal({
            clanId: clan.id,
            itemId: Config.bloodMarkItemId,
            amount: 1,
            maxPrice: Config.bloodMarkMaxPrice,
            goalKey: demandKey,
            status: 'fulfilled'
        });
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
            await ClanCrestService.ensureAutonomousCrest(clan.id);
            recordReason(Contracts.REASON_CODES.CONTRIBUTION_LEVEL_UP);
            if (typeof ClanService.reload === 'function') await ClanService.reload();
        } else {
            recordReason(advanced.code);
        }
    }
    return { ...completion, drops, advanced: success ? rewardAmount > 0 : null };
}

async function resolveClan(clan, options = {}) {
    if (!clan || number(clan.level) !== 2) return { ok: true, skipped: true, reason: 'level_not_farmable' };
    let currentClan = clan;
    let goal = clan.state?.goal;
    if (!goal || goal.type !== 'item' || goal.plan?.kind !== 'farm' || number(goal.progress) >= number(goal.required)) {
        return { ok: true, skipped: true, reason: 'farm_goal_missing' };
    }

    let reclaimed = { reclaimedPartyIds: [], releasedMembers: 0 };
    if (!String(goal.partyId || '')) {
        reclaimed = await reclaimRequiredRoleParties(currentClan);
        if (reclaimed.reclaimedPartyIds.length) {
            const projected = await GoalService.clanProjectionById(currentClan.id);
            if (projected?.state?.goal) {
                currentClan = projected;
                goal = projected.state.goal;
            }
        }
        const refreshed = await refreshOperationRoster(currentClan, goal);
        if (!refreshed.ok && refreshed.code) return refreshed;
        if (refreshed.changed) {
            goal = refreshed.goal;
            currentClan = {
                ...currentClan,
                state: {
                    ...(currentClan.state || {}),
                    goal,
                    updatedAt: number(refreshed.updatedAt, number(currentClan.state?.updatedAt))
                }
            };
        }
    }

    // Starting an operation atomically writes goal.partyId together with the
    // active operation row. If there is no party id yet and the projected
    // roster is unavailable, no active operation can require resolution. Skip
    // the database lookup and retain the durable action for a later retry.
    if (!String(goal.partyId || '') && !operationRoster(currentClan, goal).ready) {
        recordReason(Contracts.REASON_CODES.PARTY_NOT_READY);
        return { ok: false, code: Contracts.REASON_CODES.PARTY_NOT_READY, skipped: true };
    }

    const active = await Database.fetchActiveAutonomousClanOperation(currentClan.id);
    if (!active) {
        const started = await startOperation(currentClan, goal);
        return {
            ...started,
            rosterRefreshed: currentClan !== clan,
            reclaimedPartyIds: reclaimed.reclaimedPartyIds,
            releasedMembers: reclaimed.releasedMembers,
            started: !!started.ok && !started.idempotent
        };
    }
    return resolveActiveOperation(currentClan, goal, active, options);
}

const ClanPartyService = {
    config: Config,
    resolveClan,

    resolveBatch(limit = Config.resolveBatchSize, options = {}) {
        if (!Config.enabled) return Promise.resolve({ attempted: 0, budgetStopped: false });
        const deadlineAt = Date.now() + Math.max(1, number(options.budgetMs, Config.resolveBudgetMs));
        return GoalService.clanProjection().then(async (clans) => {
            const summary = {
                attempted: 0,
                started: 0,
                resolved: 0,
                succeeded: 0,
                failed: 0,
                drops: 0,
                levelUps: 0,
                catastrophicFailures: 0,
                budgetStopped: false
            };
            for (const clan of clans.slice(0, Math.max(1, number(limit, Config.resolveBatchSize)))) {
                if (Date.now() >= deadlineAt) {
                    summary.budgetStopped = true;
                    metrics.budgetStops += 1;
                    break;
                }
                const before = { ...metrics };
                const result = await resolveClan(clan, {
                    ...options,
                    budgetMs: Math.max(1, deadlineAt - Date.now())
                });
                summary.attempted += 1;
                summary.started += result.started ? 1 : 0;
                summary.resolved += Math.max(0, metrics.operationsResolved - number(before.operationsResolved));
                summary.succeeded += Math.max(0, metrics.operationsSucceeded - number(before.operationsSucceeded));
                summary.failed += Math.max(0, metrics.operationsFailed - number(before.operationsFailed));
                summary.drops += Math.max(0, metrics.drops - number(before.drops));
                summary.levelUps += Math.max(0, metrics.levelUps - number(before.levelUps));
                summary.catastrophicFailures += Math.max(0, metrics.catastrophicFailures - number(before.catastrophicFailures));
            }
            metrics.resolves += summary.attempted;
            return summary;
        });
    },

    metrics() {
        return {
            resolves: metrics.resolves,
            operationsStarted: metrics.operationsStarted,
            operationsResolved: metrics.operationsResolved,
            operationsSucceeded: metrics.operationsSucceeded,
            operationsFailed: metrics.operationsFailed,
            drops: metrics.drops,
            levelUps: metrics.levelUps,
            catastrophicFailures: metrics.catastrophicFailures,
            memberReservationConflicts: metrics.memberReservationConflicts,
            supportPartiesReclaimed: metrics.supportPartiesReclaimed,
            supportMembersReleased: metrics.supportMembersReleased,
            budgetStops: metrics.budgetStops,
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

module.exports = ClanPartyService;
