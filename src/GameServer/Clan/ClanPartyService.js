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
const ClanOrderService = invoke('GameServer/Clan/ClanOrderService');
const ClanRules = invoke('GameServer/Clan/ClanRules');

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
    supportClanJoins: 0,
    supportGuestsUsed: 0,
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

function operationMinimumLevel(goal) {
    const sourceLevel = number(goal?.target?.sourceLevel ?? goal?.plan?.sourceLevel, 1);
    return GoalPolicy.operationLevelThreshold(sourceLevel);
}

function eligibleClanMembers(clan, goal) {
    if (String(goal?.controlledBy || '') === 'player') return clan.members || [];
    const minimumLevel = operationMinimumLevel(goal);
    return (clan.members || []).filter((member) => number(member.level) >= minimumLevel);
}

function operationRoster(clan, goal, guests = [], options = {}) {
    const assigned = parseIds(goal.assignedMemberIds);
    const eligible = eligibleClanMembers(clan, goal);
    const candidates = assigned.length
        ? assigned.map((id) => memberById(clan, id)).filter(Boolean)
        : eligible;
    const guestById = new Map(guests.map((guest) => [number(guest.characterId ?? guest.id), guest]));
    const selected = GoalPolicy.operationMembers([...candidates, ...guests], Config.operationMaxMembers);
    const clanIds = new Set((clan.members || []).map((member) => number(member.characterId ?? member.id)));
    const selectedMembers = selected.map((id) => memberById(clan, id) || guestById.get(number(id))).filter(Boolean);
    const guestMemberIds = selected.filter((id) => !clanIds.has(number(id)));
    const clanMemberIds = selected.filter((id) => clanIds.has(number(id)));
    const playerControlled = String(goal.controlledBy || '') === 'player';
    return {
        selected,
        clanMemberIds,
        guestMemberIds,
        selectedMembers,
        ready: selected.length >= Config.operationMinMembers
            && (playerControlled || options.allowRoleFallback || GoalPolicy.hasReadyRoles(selectedMembers))
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

async function reclaimPlayerOrderParties(clan, goal) {
    const assigned = new Set(parseIds(goal.assignedMemberIds));
    const partyIds = [...new Set((clan?.members || [])
        .filter((member) => assigned.has(number(member.characterId ?? member.id)) && String(member.partyId || ''))
        .map((member) => String(member.partyId)))]
        .filter((partyId) => {
            const party = BackgroundPartyState.find(partyId);
            // A direct player order supersedes any earlier autonomous clan
            // objective carried by the selected members. Once the new goal
            // has a partyId this reclaim path is no longer entered.
            return party?.status === 'active';
        });
    let releasedMembers = 0;
    const reclaimedPartyIds = [];
    for (const partyId of partyIds) {
        const dissolved = await BackgroundPartyState.setStatus(partyId, 'dissolved');
        if (!dissolved) continue;
        const released = await LifeState.releaseDissolvedPartyMembers(partyId, 'player_clan_order_reclaimed');
        releasedMembers += number(released);
        reclaimedPartyIds.push(partyId);
    }
    metrics.supportPartiesReclaimed += reclaimedPartyIds.length;
    metrics.supportMembersReleased += releasedMembers;
    return { reclaimedPartyIds, releasedMembers };
}

async function refreshOperationRoster(clan, goal) {
    const assigned = parseIds(goal.assignedMemberIds).sort((left, right) => left - right);
    if (String(goal.controlledBy || '') === 'player' && assigned.length) return { changed: false, goal };
    const eligible = eligibleClanMembers(clan, goal);
    const clanMemberIds = new Set(eligible.map((member) => number(member.characterId ?? member.id)).filter(Boolean));
    const retained = assigned.filter((id) => clanMemberIds.has(Number(id)));
    const available = GoalPolicy.operationMembers(eligible, Config.operationMaxMembers);
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

function missingSupportRoles(members = []) {
    const roles = new Set(members.map((member) => ClanPolicy.rosterRole(member)));
    return ['tank', 'healer', 'buffer'].filter((role) => !roles.has(role));
}

async function prepareOperationRoster(clan, goal) {
    if (String(goal.controlledBy || '') === 'player') {
        return { clan, goal, roster: operationRoster(clan, goal), joinedMemberIds: [] };
    }

    let currentClan = clan;
    let currentGoal = goal;
    const minimumLevel = operationMinimumLevel(goal);
    const sourceLevel = Math.max(minimumLevel, number(goal?.target?.sourceLevel ?? goal?.plan?.sourceLevel, minimumLevel));
    let candidates = await LifeState.clanOperationCandidates({
        targetClanId: clan.id,
        minLevel: minimumLevel,
        targetLevel: sourceLevel,
        limit: 64
    });
    const baseRoster = operationRoster(currentClan, currentGoal);
    const joinedMemberIds = [];
    const attempted = new Set();

    for (const role of missingSupportRoles(baseRoster.selectedMembers)) {
        const candidate = candidates.find((entry) => number(entry.clanId) === 0
            && ClanPolicy.rosterRole(entry) === role
            && !attempted.has(number(entry.characterId)));
        if (!candidate) continue;
        attempted.add(number(candidate.characterId));
        const joined = await Database.joinAutonomousClan({
            clanId: currentClan.id,
            characterId: candidate.characterId,
            memberLimit: ClanRules.memberLimit(currentClan.level),
            maxBotMemberShare: Config.maxBotMemberShare
        });
        if (joined.ok) joinedMemberIds.push(number(candidate.characterId));
    }

    if (joinedMemberIds.length) {
        metrics.supportClanJoins += joinedMemberIds.length;
        if (typeof ClanService.reload === 'function') await ClanService.reload();
        const projected = await GoalService.clanProjectionById(currentClan.id);
        if (projected?.state?.goal) {
            currentClan = projected;
            currentGoal = projected.state.goal;
            const refreshed = await refreshOperationRoster(currentClan, currentGoal);
            if (!refreshed.ok && refreshed.code) return { clan: currentClan, goal: currentGoal, error: refreshed };
            if (refreshed.changed) {
                currentGoal = refreshed.goal;
                currentClan = {
                    ...currentClan,
                    state: {
                        ...(currentClan.state || {}),
                        goal: currentGoal,
                        updatedAt: number(refreshed.updatedAt, number(currentClan.state?.updatedAt))
                    }
                };
            }
        }
        candidates = await LifeState.clanOperationCandidates({
            targetClanId: currentClan.id,
            minLevel: minimumLevel,
            targetLevel: sourceLevel,
            limit: 64
        });
    }

    const selectedGuests = [];
    let roster = operationRoster(currentClan, currentGoal, selectedGuests);
    const addGuest = (candidate) => {
        if (!candidate || selectedGuests.some((guest) => number(guest.characterId) === number(candidate.characterId))) return;
        selectedGuests.push(candidate);
        roster = operationRoster(currentClan, currentGoal, selectedGuests);
    };
    missingSupportRoles(roster.selectedMembers).forEach((role) => {
        addGuest(candidates.find((candidate) => ClanPolicy.rosterRole(candidate) === role));
    });
    for (const candidate of candidates) {
        if (roster.selected.length >= Config.operationMinMembers) break;
        addGuest(candidate);
    }
    roster = operationRoster(currentClan, currentGoal, selectedGuests, { allowRoleFallback: true });
    return { clan: currentClan, goal: currentGoal, roster, joinedMemberIds };
}

async function startOperation(clan, goal, roster = operationRoster(clan, goal)) {
    if (!roster.ready) {
        recordReason(Contracts.REASON_CODES.PARTY_NOT_READY);
        return { ok: false, code: Contracts.REASON_CODES.PARTY_NOT_READY, skipped: true };
    }
    const selected = roster.selected;
    const result = await Database.startAutonomousClanOperation({
        clanId: clan.id,
        operationKey: operationKey(clan, goal),
        operationType: 'farm',
        targetNpcId: number(goal.plan?.sourceId) || (String(goal.controlledBy || '') === 'player' ? 0 : Config.bloodMarkSourceNpcId),
        leaderId: number(clan.leaderId),
        memberIds: roster.clanMemberIds,
        guestMemberIds: roster.guestMemberIds,
        expectedGoalUpdatedAt: number(clan.state?.updatedAt) || null
    });
    if (result.ok && !result.idempotent) {
        metrics.operationsStarted += 1;
        metrics.supportGuestsUsed += roster.guestMemberIds.length;
    }
    if (!result.ok && result.code === Contracts.REASON_CODES.PARTY_MEMBER_RESERVATION_CONFLICT) {
        metrics.memberReservationConflicts += 1;
    }
    recordReason(result.code);
    return { ...result, memberIds: selected, guestMemberIds: roster.guestMemberIds };
}

async function resolveActiveOperation(clan, goal, operation, options = {}) {
    const memberIds = parseIds(operation.memberIdsJson);
    const operationStates = await LifeState.statesByIds(memberIds, { ownerId: 'legacy_main' });
    const hydratedLevels = operationStates.map((state) => number(state.level)).filter((level) => level > 0);
    const hydratedAverage = hydratedLevels.length
        ? hydratedLevels.reduce((sum, level) => sum + level, 0) / hydratedLevels.length
        : averageLevel(clan, memberIds);
    const killerLevel = Math.max(1, Math.round(hydratedAverage));
    const forceFailure = options.forceFailure === true;
    let drops = [];
    if (!forceFailure) {
        const targetNpcId = number(operation.targetNpcId) || (String(goal.controlledBy || '') === 'player' ? 0 : Config.bloodMarkSourceNpcId);
        drops = BackgroundDropResolver.rollForFight({
            spot: {
                npcSelfIds: [targetNpcId].filter(Boolean),
                avgLevel: Math.max(1, number(goal.target?.sourceLevel || goal.plan?.sourceLevel, 60))
            },
            killerLevel,
            npcSelfId: targetNpcId,
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
    if (String(goal.controlledBy || '') === 'player') {
        const progress = await ClanOrderService.syncProgress(clan, 0, success ? 'party_reward_applied' : reasonCode);
        return { ...completion, drops, order: progress.order, goal: progress.goal, advanced: false };
    }
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
    const playerControlled = String(clan?.state?.mode || '') === 'player_managed'
        && String(clan?.state?.goal?.controlledBy || '') === 'player';
    if (!clan || !playerControlled && number(clan.level) !== 2) return { ok: true, skipped: true, reason: 'level_not_farmable' };
    let currentClan = clan;
    let goal = clan.state?.goal;
    if (!goal || goal.type !== 'item' || goal.plan?.kind !== 'farm' || number(goal.progress) >= number(goal.required)) {
        return { ok: true, skipped: true, reason: 'farm_goal_missing' };
    }

    let reclaimed = { reclaimedPartyIds: [], releasedMembers: 0 };
    if (!String(goal.partyId || '')) {
        reclaimed = playerControlled
            ? await reclaimPlayerOrderParties(currentClan, goal)
            : await reclaimRequiredRoleParties(currentClan);
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

    let prepared = null;
    if (!String(goal.partyId || '')) {
        prepared = await prepareOperationRoster(currentClan, goal);
        if (prepared.error) return prepared.error;
        currentClan = prepared.clan;
        goal = prepared.goal;
        if (!prepared.roster.ready) {
            recordReason(Contracts.REASON_CODES.PARTY_NOT_READY);
            return { ok: false, code: Contracts.REASON_CODES.PARTY_NOT_READY, skipped: true };
        }
    }

    const active = await Database.fetchActiveAutonomousClanOperation(currentClan.id);
    if (!active) {
        prepared = prepared || await prepareOperationRoster(currentClan, goal);
        if (prepared.error) return prepared.error;
        const started = await startOperation(currentClan, goal, prepared.roster);
        return {
            ...started,
            joinedMemberIds: prepared.joinedMemberIds,
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
            supportClanJoins: metrics.supportClanJoins,
            supportGuestsUsed: metrics.supportGuestsUsed,
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
