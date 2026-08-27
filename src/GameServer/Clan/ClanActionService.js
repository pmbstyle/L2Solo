const Database = invoke('Database');
const Config = invoke('GameServer/Clan/ClanSimulationConfig');
const Contracts = invoke('GameServer/Clan/ClanSimulationContracts');
const GoalService = invoke('GameServer/Clan/ClanGoalService');
const EconomyService = invoke('GameServer/Clan/ClanEconomyService');
const WarehouseService = invoke('GameServer/Clan/ClanWarehouseService');
const MarketService = invoke('GameServer/Clan/ClanMarketService');
const PartyService = invoke('GameServer/Clan/ClanPartyService');
const OrderService = invoke('GameServer/Clan/ClanOrderService');
const TitleService = invoke('GameServer/Clan/ClanTitleService');
const StageMetrics = invoke('GameServer/Clan/ClanStageMetrics');

const ACTION_TYPES = Object.freeze({
    PLAN: 'goal_plan',
    CONTRIBUTION: 'contribution',
    WAREHOUSE: 'warehouse',
    MARKET: 'market',
    PARTY: 'party',
    TITLES: 'member_titles'
});
// Bump when a deploy adds a recovery behavior that must revisit durable goals
// whose previous bootstrap action already succeeded under older code.
const BOOTSTRAP_RECOVERY_VERSION = 5;

const metrics = {
    bootstraps: 0,
    planned: 0,
    claimed: 0,
    resolved: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    retried: 0,
    deferred: 0,
    budgetStops: 0,
    budgetOverruns: 0,
    releasedUnstarted: 0,
    releaseConflicts: 0,
    leaseRecoveries: 0,
    durationMs: 0,
    durationSamples: 0,
    durationMaxMs: 0,
    queueAgeMs: 0,
    queueAgeSamples: 0,
    queuePending: 0,
    queueReady: 0,
    queueRunning: 0,
    queueExpiredRunning: 0,
    queueOldestPendingAgeMs: 0,
    queueOldestReadyAgeMs: 0,
    queueOldestRunningAgeMs: 0,
    queueMaxAttempt: 0,
    queueObservedAt: 0,
    stages: new Map(),
    actionCounts: new Map(),
    reasonCounts: new Map()
};

let bootstrapped = false;

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
    if (value) map.set(String(value), (map.get(String(value)) || 0) + 1);
}

function recordAction(action, field = 'claimed') {
    record(metrics.actionCounts, `${action.actionType}:${field}`);
}

function actionPayload(action) {
    return parseJson(action?.payloadJson, {});
}

function recordQueueStats(stats = {}) {
    metrics.queuePending = number(stats.pending);
    metrics.queueReady = number(stats.ready);
    metrics.queueRunning = number(stats.running);
    metrics.queueExpiredRunning = number(stats.expiredRunning);
    metrics.queueOldestPendingAgeMs = number(stats.oldestPendingAgeMs);
    metrics.queueOldestReadyAgeMs = number(stats.oldestReadyAgeMs);
    metrics.queueOldestRunningAgeMs = number(stats.oldestRunningAgeMs);
    metrics.queueMaxAttempt = number(stats.maxAttempt);
    metrics.queueObservedAt = number(stats.observedAt, Date.now());
}

async function refreshQueueStats() {
    const startedAt = Date.now();
    try {
        const stats = await Database.fetchClanActionQueueStats();
        recordQueueStats(stats);
        return stats;
    } finally {
        StageMetrics.record(metrics.stages, 'queue_stats', Date.now() - startedAt);
    }
}

function actionTypeFor(clan, goal) {
    if (!clan || !goal || goal.status === 'completed') return null;
    // The bots execute an equipment route through their normal lifecycle, but
    // the clan re-evaluates the weakest/highest-priority beneficiary on the
    // bounded retry cadence. This also repairs a lost durable plan binding
    // without turning equipment into a per-combat-tick scheduler job.
    if (goal.type === 'equipment') return ACTION_TYPES.PLAN;
    if (number(clan.level) <= 1) return ACTION_TYPES.CONTRIBUTION;
    switch (String(goal.plan?.kind || '')) {
        case 'warehouse': return ACTION_TYPES.WAREHOUSE;
        case 'market': return ACTION_TYPES.MARKET;
        case 'farm': return ACTION_TYPES.PARTY;
        default: return ACTION_TYPES.PLAN;
    }
}

function workDone(actionType, result = {}) {
    if (actionType === ACTION_TYPES.CONTRIBUTION) {
        return (result.results || []).some((entry) => entry?.ok)
            || result.advanced?.ok === true
            || number(result.warehouse?.deposited) > 0;
    }
    if (actionType === ACTION_TYPES.WAREHOUSE) return number(result.deposited) > 0;
    if (actionType === ACTION_TYPES.MARKET) return result.purchased === true || result.advanced?.ok === true;
    if (actionType === ACTION_TYPES.PARTY) return result.started === true || result.resolved === true || result.succeeded === true;
    return result.changed === true;
}

function deferredRetryDelay(actionType, result = {}) {
    const reason = String(result?.code || result?.reason || '');
    if (
        actionType === ACTION_TYPES.PLAN &&
        result?.pending === true &&
        reason === 'clan_llm_pending'
    ) {
        return Math.min(1000, Config.actionRetryMs);
    }
    if (actionType === ACTION_TYPES.TITLES && result?.pending === true) {
        return Math.min(1000, Config.actionRetryMs);
    }
    if (actionType === ACTION_TYPES.TITLES && result?.retryable === true) {
        return Config.actionRetryMs;
    }
    if (
        actionType === ACTION_TYPES.PARTY &&
        result?.skipped === true &&
        reason === Contracts.REASON_CODES.PARTY_NOT_READY
    ) {
        return Config.actionRetryMs;
    }
    return null;
}

async function bootstrap() {
    if (bootstrapped) return { attempted: 0, created: 0 };
    bootstrapped = true;
    const playerManaged = await Database.ensurePlayerManagedClans();
    const clans = await Database.fetchClansNeedingAction(Config.resolveBatchSize * 4);
    let created = 0;
    for (const clan of clans) {
        const result = await Database.enqueueClanAction({
            clanId: clan.clanId,
            actionKey: `clan:${Number(clan.clanId)}:recovery:v${BOOTSTRAP_RECOVERY_VERSION}:${Number(clan.updatedAt) || 0}`,
            actionType: ACTION_TYPES.PLAN,
            priority: 75,
            payload: { reason: 'runtime_bootstrap', clanId: Number(clan.clanId) }
        });
        if (result.created) created += 1;
    }
    let titleCreated = 0;
    let titleAttempted = 0;
    if (Config.llmTitleManagementEnabled !== false && TitleService.available()) {
        const titleClans = await Database.fetchAutonomousClansNeedingTitles(Math.max(64, Config.maxBotClans));
        titleAttempted = titleClans.length;
        for (const clan of titleClans) {
            const rosterKey = `${Number(clan.memberCount)}:${Number(clan.memberIdSum)}:${Number(clan.maxMemberId)}`;
            const result = await Database.enqueueClanAction({
                clanId: clan.clanId,
                actionKey: `clan:${Number(clan.clanId)}:titles:v1:${rosterKey}`,
                actionType: ACTION_TYPES.TITLES,
                priority: 20,
                payload: { reason: 'untitled_members', rosterKey }
            });
            if (result.created) titleCreated += 1;
        }
    }
    metrics.bootstraps += 1;
    metrics.planned += created + titleCreated;
    return { attempted: clans.length, created, playerManaged, titleAttempted, titleCreated };
}

async function scheduleTitleReview(clan) {
    if (Config.llmTitleManagementEnabled === false || !TitleService.available() || number(clan?.level) < 3) {
        return { ok: true, scheduled: false, reason: 'titles_disabled_or_unavailable' };
    }
    const memberIds = (clan.members || [])
        .map((member) => number(member.characterId || member.id))
        .filter(Boolean)
        .sort((left, right) => left - right);
    const missingIds = (clan.members || [])
        .filter((member) => !String(member.title || '').trim())
        .map((member) => number(member.characterId || member.id))
        .filter(Boolean)
        .sort((left, right) => left - right);
    if (!missingIds.length) return { ok: true, scheduled: false, reason: 'titles_complete' };
    const rosterKey = `${memberIds.length}:${memberIds.reduce((sum, id) => sum + id, 0)}:${memberIds.at(-1) || 0}`;
    const queued = await Database.enqueueClanAction({
        clanId: clan.id,
        actionKey: `clan:${number(clan.id)}:titles:v1:${rosterKey}`,
        actionType: ACTION_TYPES.TITLES,
        priority: 20,
        payload: { reason: 'untitled_members', memberIds: missingIds, rosterKey }
    });
    if (queued.created) metrics.planned += 1;
    return queued;
}

async function scheduleNext(clan, goal, parentAction, result, delayMs = 0) {
    const type = actionTypeFor(clan, goal);
    if (!type) return { ok: true, scheduled: false, reason: 'goal_completed_or_missing' };
    const delay = Math.max(0, Number(delayMs) || 0);
    const actionKey = `clan:${Number(clan.id)}:after:${Number(parentAction.id)}:${type}:${Number(goal.updatedAt) || 0}`;
    const queued = await Database.enqueueClanAction({
        clanId: clan.id,
        actionKey,
        actionType: type,
        priority: type === ACTION_TYPES.PLAN ? 75 : 50,
        availableAt: Date.now() + delay,
        payload: {
            parentActionId: Number(parentAction.id),
            goalUpdatedAt: Number(goal.updatedAt) || 0,
            goalType: String(goal.type || ''),
            plan: String(goal.plan?.kind || ''),
            result: result && typeof result === 'object' ? result : {}
        }
    });
    if (queued.created) metrics.planned += 1;
    return queued;
}

async function schedulePlanAfterLevelUp(clan, parentAction, result) {
    const actionKey = `clan:${Number(clan.id)}:after:${Number(parentAction.id)}:goal_plan:level_up`;
    const queued = await Database.enqueueClanAction({
        clanId: clan.id,
        actionKey,
        actionType: ACTION_TYPES.PLAN,
        priority: 100,
        payload: {
            parentActionId: Number(parentAction.id),
            reason: 'level_up',
            result: result && typeof result === 'object' ? result : {}
        }
    });
    if (queued.created) metrics.planned += 1;
    return queued;
}

async function schedulePlanAfterMarketMiss(clan, parentAction, result) {
    const actionKey = `clan:${Number(clan.id)}:after:${Number(parentAction.id)}:goal_plan:market_replan`;
    const queued = await Database.enqueueClanAction({
        clanId: clan.id,
        actionKey,
        actionType: ACTION_TYPES.PLAN,
        priority: 100,
        payload: {
            parentActionId: Number(parentAction.id),
            reason: Contracts.REASON_CODES.MARKET_NO_OFFER,
            result: result && typeof result === 'object' ? result : {}
        }
    });
    if (queued.created) metrics.planned += 1;
    return queued;
}

async function loadClan(clanId) {
    return GoalService.clanProjectionById(clanId);
}

async function execute(action, options = {}) {
    const projectionStartedAt = Date.now();
    const clan = await loadClan(action.clanId).finally(() => {
        StageMetrics.record(metrics.stages, 'projection', Date.now() - projectionStartedAt);
    });
    if (!clan) return { ok: false, code: 'target_not_autonomous' };
    const payload = actionPayload(action);
    const requestedDeadline = Number(options.deadlineAt);
    const leaseDeadline = Date.now() + Math.max(1, Config.actionLeaseMs - 1000);
    const deadlineAt = Number.isFinite(requestedDeadline)
        ? Math.min(requestedDeadline, leaseDeadline)
        : leaseDeadline;
    const actionType = String(action.actionType);
    const executeStartedAt = Date.now();
    let result;
    try {
        switch (actionType) {
            case ACTION_TYPES.PLAN:
                result = String(clan.state?.mode || '') === 'player_managed'
                    ? await OrderService.resolveClan(clan, {
                        actionId: Number(action.id),
                        reasonCode: String(payload.reason || '') === Contracts.REASON_CODES.MARKET_NO_OFFER
                            ? Contracts.REASON_CODES.MARKET_NO_OFFER
                            : ''
                    })
                    : await GoalService.resolveClan(clan, { actionId: Number(action.id) });
                break;
            case ACTION_TYPES.CONTRIBUTION:
                result = await EconomyService.resolveClan(clan, {
                    batchSize: 1,
                    deadlineAt,
                    actionId: Number(action.id),
                    goalUpdatedAt: Number(payload.goalUpdatedAt) || null
                });
                break;
            case ACTION_TYPES.WAREHOUSE:
                result = await WarehouseService.resolveClan(clan, {
                    batchSize: 1,
                    deadlineAt,
                    actionId: Number(action.id)
                });
                break;
            case ACTION_TYPES.MARKET:
                result = await MarketService.resolveClan(clan, { actionId: Number(action.id) });
                break;
            case ACTION_TYPES.PARTY:
                result = await PartyService.resolveClan(clan, {
                    actionId: Number(action.id),
                    rng: Math.random
                });
                break;
            case ACTION_TYPES.TITLES:
                result = await TitleService.resolveClan(clan);
                break;
            default:
                return { ok: false, code: 'unknown_clan_action_type' };
        }
    } finally {
        const durationMs = Date.now() - executeStartedAt;
        StageMetrics.record(metrics.stages, 'execute', durationMs);
        StageMetrics.record(metrics.stages, `execute:${actionType}`, durationMs);
    }
    return result || { ok: true };
}

async function resolveAction(action, options = {}) {
    const startedAt = Date.now();
    let resolutionRecorded = false;
    metrics.running += 1;
    recordAction(action, 'running');
    try {
        const result = await execute(action, options);
        const ok = result?.ok !== false;
        const reasonCode = result?.code || result?.reason || (ok ? '' : 'clan_action_failed');
        const retryDelay = deferredRetryDelay(String(action.actionType), result);
        if (retryDelay !== null) {
            const deferStartedAt = Date.now();
            const released = await Database.releaseClanAction({
                actionId: action.id,
                availableAt: Date.now() + retryDelay,
                expectedAttempt: action.attempt,
                expectedLeaseUntil: action.leaseUntil
            }).finally(() => {
                StageMetrics.record(metrics.stages, 'defer', Date.now() - deferStartedAt);
            });
            if (!released.ok) {
                metrics.releaseConflicts += 1;
                return released;
            }
            metrics.deferred += 1;
            metrics.retried += 1;
            recordAction(action, 'deferred');
            record(metrics.reasonCounts, reasonCode);
            return {
                ...released,
                deferred: true,
                result,
                durationMs: Date.now() - startedAt
            };
        }
        const settleStartedAt = Date.now();
        const resolved = await Database.resolveClanAction({
            actionId: action.id,
            status: ok ? 'succeeded' : 'failed',
            result,
            reasonCode
        }).finally(() => {
            StageMetrics.record(metrics.stages, 'settle', Date.now() - settleStartedAt);
        });
        if (!resolved.ok) {
            metrics.releaseConflicts += 1;
            return resolved;
        }
        if (!resolved.idempotent) metrics.resolved += 1;
        resolutionRecorded = true;
        if (resolved.idempotent) return resolved;

        const followUpStartedAt = Date.now();
        try {
            const clan = await loadClan(action.clanId);
            const goal = clan?.state?.goal || null;
            if (clan && String(action.actionType) !== ACTION_TYPES.TITLES) {
                await scheduleTitleReview(clan);
            }
            const advanced = result?.advanced?.ok === true || result?.advanced === true;
            const marketMiss = String(action.actionType) === ACTION_TYPES.MARKET
                && String(result?.reason || result?.code || '') === Contracts.REASON_CODES.MARKET_NO_OFFER;
            const playerMarketWait = marketMiss
                && String(clan?.state?.mode || '') === 'player_managed'
                && String(goal?.policy?.strategy || '') === 'market';
            if (String(action.actionType) === ACTION_TYPES.TITLES) {
                // Titles are an auxiliary durable clan action and do not alter
                // the goal execution chain.
            } else if (clan && advanced) {
                await schedulePlanAfterLevelUp(clan, action, result);
            } else if (clan && playerMarketWait) {
                await scheduleNext(clan, goal, action, result, Config.actionRetryMs);
                metrics.retried += 1;
            } else if (clan && marketMiss) {
                await schedulePlanAfterMarketMiss(clan, action, result);
            } else if (clan && goal && !(String(action.actionType) === ACTION_TYPES.PLAN && goal.status === 'completed')) {
                const productive = ok && workDone(String(action.actionType), result);
                const delay = ok && productive ? 0 : Config.actionRetryMs;
                await scheduleNext(clan, goal, action, result, delay);
                if (delay > 0) metrics.retried += 1;
            }
        } finally {
            StageMetrics.record(metrics.stages, 'follow_up', Date.now() - followUpStartedAt);
        }
        if (ok) {
            metrics.succeeded += 1;
            recordAction(action, 'succeeded');
        } else {
            metrics.failed += 1;
            recordAction(action, 'failed');
            record(metrics.reasonCounts, reasonCode);
        }
        return { ...resolved, result, durationMs: Date.now() - startedAt };
    } catch (error) {
        const reasonCode = error?.message || 'clan_action_exception';
        const settleStartedAt = Date.now();
        const resolved = await Database.resolveClanAction({
            actionId: action.id,
            status: 'failed',
            result: { error: reasonCode },
            reasonCode: 'clan_action_exception'
        }).finally(() => {
            StageMetrics.record(metrics.stages, 'settle', Date.now() - settleStartedAt);
        });
        if (resolved?.ok) {
            if (!resolved.idempotent && !resolutionRecorded) metrics.resolved += 1;
            resolutionRecorded = true;
        } else {
            metrics.releaseConflicts += 1;
        }
        metrics.failed += 1;
        record(metrics.reasonCounts, 'clan_action_exception');
        return { ok: false, code: 'clan_action_exception', error: reasonCode };
    } finally {
        const durationMs = Math.max(0, Date.now() - startedAt);
        metrics.durationMs += durationMs;
        metrics.durationSamples += 1;
        metrics.durationMaxMs = Math.max(metrics.durationMaxMs, durationMs);
        StageMetrics.record(metrics.stages, 'total', durationMs);
        if (Number.isFinite(Number(options.deadlineAt)) && Date.now() > Number(options.deadlineAt)) {
            metrics.budgetOverruns += 1;
        }
        metrics.running = Math.max(0, metrics.running - 1);
    }
}

const ClanActionService = {
    config: Config,
    actionTypes: ACTION_TYPES,
    bootstrap,
    scheduleTitleReview,
    resolveAction,

    resolveBatch(options = {}) {
        if (!Config.enabled) return Promise.resolve({ attempted: 0, claimed: 0, resolved: 0, released: 0, succeeded: 0, failed: 0, leftRunning: 0, budgetStopped: false });
        const budgetMs = Math.max(1, number(options.budgetMs, Config.resolveBudgetMs));
        const safeLimit = Math.max(1, Math.min(100, Math.floor(number(options.limit, Config.actionBatchSize))));
        const batchStartedAt = Date.now();
        const bootstrapStartedAt = Date.now();
        return bootstrap().finally(() => {
            StageMetrics.record(metrics.stages, 'bootstrap', Date.now() - bootstrapStartedAt);
        }).then(async (boot) => {
            const summary = {
                bootstrap: boot,
                attempted: 0,
                claimed: 0,
                resolved: 0,
                released: 0,
                succeeded: 0,
                failed: 0,
                leftRunning: 0,
                budgetStopped: false
            };
            await refreshQueueStats();
            // Bootstrap and queue telemetry are admission overhead, not clan
            // work. Starting the execution budget before those reads caused a
            // live queue to claim and release the same oldest action forever
            // whenever SQLite needed more than the 80ms idle budget.
            const deadlineAt = Date.now() + budgetMs;
            while (summary.attempted < safeLimit) {
                if (Date.now() >= deadlineAt) {
                    summary.budgetStopped = true;
                    metrics.budgetStops += 1;
                    break;
                }
                const claimStartedAt = Date.now();
                const claim = await Database.claimClanAction({
                    leaseMs: Config.actionLeaseMs
                }).finally(() => {
                    StageMetrics.record(metrics.stages, 'claim', Date.now() - claimStartedAt);
                });
                metrics.leaseRecoveries += number(claim?.recovered);
                const action = claim?.action || null;
                if (!action) break;
                metrics.claimed += 1;
                summary.claimed += 1;
                metrics.queueAgeMs += Math.max(0, Date.now() - number(action.createdAt, Date.now()));
                metrics.queueAgeSamples += 1;
                recordAction(action);

                if (Date.now() >= deadlineAt) {
                    const releaseStartedAt = Date.now();
                    const released = await Database.releaseClanAction({
                        actionId: action.id,
                        expectedAttempt: action.attempt,
                        expectedLeaseUntil: action.leaseUntil
                    }).finally(() => {
                        StageMetrics.record(metrics.stages, 'release', Date.now() - releaseStartedAt);
                    });
                    if (released.ok) {
                        metrics.releasedUnstarted += 1;
                        summary.released += 1;
                    } else {
                        metrics.releaseConflicts += 1;
                    }
                    summary.budgetStopped = true;
                    metrics.budgetStops += 1;
                    break;
                }

                const resolvedBefore = metrics.resolved;
                const result = await resolveAction(action, { deadlineAt });
                summary.attempted += 1;
                if (result.status === 'succeeded') summary.succeeded += 1;
                if (result.status === 'failed' || result.ok === false) summary.failed += 1;
                if (metrics.resolved > resolvedBefore) summary.resolved += 1;
            }
            const queue = await refreshQueueStats();
            summary.leftRunning = number(queue.running);
            summary.queue = queue;
            return summary;
        }).finally(() => {
            StageMetrics.record(metrics.stages, 'batch_total', Date.now() - batchStartedAt);
        });
    },

    metrics() {
        return {
            bootstraps: metrics.bootstraps,
            planned: metrics.planned,
            claimed: metrics.claimed,
            resolved: metrics.resolved,
            running: metrics.running,
            succeeded: metrics.succeeded,
            failed: metrics.failed,
            retried: metrics.retried,
            deferred: metrics.deferred,
            budgetStops: metrics.budgetStops,
            budgetOverruns: metrics.budgetOverruns,
            releasedUnstarted: metrics.releasedUnstarted,
            releaseConflicts: metrics.releaseConflicts,
            leaseRecoveries: metrics.leaseRecoveries,
            durationAvgMs: metrics.durationSamples ? Math.round(metrics.durationMs / metrics.durationSamples) : 0,
            durationMaxMs: metrics.durationMaxMs,
            queueAgeMs: metrics.queueAgeMs,
            queueAgeSamples: metrics.queueAgeSamples,
            queueAgeAvgMs: metrics.queueAgeSamples ? Math.round(metrics.queueAgeMs / metrics.queueAgeSamples) : 0,
            queuePending: metrics.queuePending,
            queueReady: metrics.queueReady,
            queueRunning: metrics.queueRunning,
            queueExpiredRunning: metrics.queueExpiredRunning,
            queueOldestPendingAgeMs: metrics.queueOldestPendingAgeMs,
            queueOldestReadyAgeMs: metrics.queueOldestReadyAgeMs,
            queueOldestRunningAgeMs: metrics.queueOldestRunningAgeMs,
            queueMaxAttempt: metrics.queueMaxAttempt,
            queueObservedAt: metrics.queueObservedAt,
            stages: StageMetrics.snapshot(metrics.stages),
            actionCounts: Object.fromEntries(metrics.actionCounts.entries()),
            reasonCounts: Object.fromEntries(metrics.reasonCounts.entries())
        };
    },

    resetMetrics() {
        bootstrapped = false;
        Object.keys(metrics).forEach((key) => {
            if (metrics[key] instanceof Map) metrics[key].clear();
            else metrics[key] = 0;
        });
    }
};

module.exports = ClanActionService;
