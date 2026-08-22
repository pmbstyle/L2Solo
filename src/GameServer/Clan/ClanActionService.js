const Database = invoke('Database');
const Config = invoke('GameServer/Clan/ClanSimulationConfig');
const Contracts = invoke('GameServer/Clan/ClanSimulationContracts');
const GoalService = invoke('GameServer/Clan/ClanGoalService');
const EconomyService = invoke('GameServer/Clan/ClanEconomyService');
const WarehouseService = invoke('GameServer/Clan/ClanWarehouseService');
const MarketService = invoke('GameServer/Clan/ClanMarketService');
const PartyService = invoke('GameServer/Clan/ClanPartyService');

const ACTION_TYPES = Object.freeze({
    PLAN: 'goal_plan',
    CONTRIBUTION: 'contribution',
    WAREHOUSE: 'warehouse',
    MARKET: 'market',
    PARTY: 'party'
});

const metrics = {
    bootstraps: 0,
    planned: 0,
    claimed: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    retried: 0,
    budgetStops: 0,
    queueAgeMs: 0,
    queueAgeSamples: 0,
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

function actionTypeFor(clan, goal) {
    if (!clan || !goal || goal.status === 'completed') return null;
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

async function bootstrap() {
    if (bootstrapped) return { attempted: 0, created: 0 };
    bootstrapped = true;
    const clans = await Database.fetchClansNeedingAction(Config.resolveBatchSize * 4);
    let created = 0;
    for (const clan of clans) {
        const result = await Database.enqueueClanAction({
            clanId: clan.clanId,
            actionKey: `clan:${Number(clan.clanId)}:recovery:${Number(clan.updatedAt) || 0}`,
            actionType: ACTION_TYPES.PLAN,
            priority: 75,
            payload: { reason: 'runtime_bootstrap', clanId: Number(clan.clanId) }
        });
        if (result.created) created += 1;
    }
    metrics.bootstraps += 1;
    metrics.planned += created;
    return { attempted: clans.length, created };
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

async function loadClan(clanId) {
    return GoalService.clanProjectionById(clanId);
}

async function execute(action) {
    const clan = await loadClan(action.clanId);
    if (!clan) return { ok: false, code: 'target_not_autonomous' };
    const payload = actionPayload(action);
    let result;
    switch (String(action.actionType)) {
        case ACTION_TYPES.PLAN:
            result = await GoalService.resolveClan(clan, { actionId: Number(action.id) });
            break;
        case ACTION_TYPES.CONTRIBUTION:
            result = await EconomyService.resolveClan(clan, {
                batchSize: 1,
                deadlineAt: Date.now() + Math.max(1, Config.actionLeaseMs - 1000),
                actionId: Number(action.id),
                goalUpdatedAt: Number(payload.goalUpdatedAt) || null
            });
            break;
        case ACTION_TYPES.WAREHOUSE:
            result = await WarehouseService.resolveClan(clan, {
                batchSize: 1,
                deadlineAt: Date.now() + Math.max(1, Config.actionLeaseMs - 1000),
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
        default:
            return { ok: false, code: 'unknown_clan_action_type' };
    }
    return result || { ok: true };
}

async function resolveAction(action) {
    const startedAt = Date.now();
    metrics.running += 1;
    recordAction(action, 'running');
    try {
        const result = await execute(action);
        const ok = result?.ok !== false;
        const reasonCode = result?.code || result?.reason || (ok ? '' : 'clan_action_failed');
        const resolved = await Database.resolveClanAction({
            actionId: action.id,
            status: ok ? 'succeeded' : 'failed',
            result,
            reasonCode
        });
        if (!resolved.ok) return resolved;
        if (resolved.idempotent) return resolved;

        const clan = await loadClan(action.clanId);
        const goal = clan?.state?.goal || null;
        const advanced = result?.advanced?.ok === true || result?.advanced === true;
        if (clan && advanced) {
            await schedulePlanAfterLevelUp(clan, action, result);
        } else if (clan && goal && !(String(action.actionType) === ACTION_TYPES.PLAN && goal.status === 'completed')) {
            const productive = ok && workDone(String(action.actionType), result);
            const delay = ok && productive ? 0 : Config.actionRetryMs;
            await scheduleNext(clan, goal, action, result, delay);
            if (delay > 0) metrics.retried += 1;
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
        await Database.resolveClanAction({
            actionId: action.id,
            status: 'failed',
            result: { error: reasonCode },
            reasonCode: 'clan_action_exception'
        });
        metrics.failed += 1;
        record(metrics.reasonCounts, 'clan_action_exception');
        return { ok: false, code: 'clan_action_exception', error: reasonCode };
    } finally {
        metrics.running = Math.max(0, metrics.running - 1);
    }
}

const ClanActionService = {
    config: Config,
    actionTypes: ACTION_TYPES,
    bootstrap,
    resolveAction,

    resolveBatch(options = {}) {
        if (!Config.enabled) return Promise.resolve({ attempted: 0, claimed: 0, succeeded: 0, failed: 0, budgetStopped: false });
        const budgetMs = Math.max(1, number(options.budgetMs, Config.resolveBudgetMs));
        const deadlineAt = Date.now() + budgetMs;
        const safeLimit = Math.max(1, Math.min(100, Math.floor(number(options.limit, Config.actionBatchSize))));
        return bootstrap().then(async (boot) => {
            const summary = {
                bootstrap: boot,
                attempted: 0,
                claimed: 0,
                succeeded: 0,
                failed: 0,
                budgetStopped: false
            };
            while (summary.attempted < safeLimit) {
                if (Date.now() >= deadlineAt) {
                    summary.budgetStopped = true;
                    metrics.budgetStops += 1;
                    break;
                }
                const actions = await Database.claimClanActions({
                    limit: Math.min(safeLimit - summary.attempted, Config.actionBatchSize),
                    leaseMs: Config.actionLeaseMs
                });
                if (!actions.length) break;
                metrics.claimed += actions.length;
                summary.claimed += actions.length;
                actions.forEach((action) => {
                    metrics.queueAgeMs += Math.max(0, Date.now() - number(action.createdAt, Date.now()));
                    metrics.queueAgeSamples += 1;
                    recordAction(action);
                });
                for (const action of actions) {
                    if (Date.now() >= deadlineAt) {
                        summary.budgetStopped = true;
                        metrics.budgetStops += 1;
                        break;
                    }
                    const result = await resolveAction(action);
                    summary.attempted += 1;
                    if (result.status === 'succeeded') summary.succeeded += 1;
                    if (result.status === 'failed' || result.ok === false) summary.failed += 1;
                }
                if (summary.budgetStopped) break;
            }
            return summary;
        });
    },

    metrics() {
        return {
            bootstraps: metrics.bootstraps,
            planned: metrics.planned,
            claimed: metrics.claimed,
            running: metrics.running,
            succeeded: metrics.succeeded,
            failed: metrics.failed,
            retried: metrics.retried,
            budgetStops: metrics.budgetStops,
            queueAgeMs: metrics.queueAgeMs,
            queueAgeSamples: metrics.queueAgeSamples,
            queueAgeAvgMs: metrics.queueAgeSamples ? Math.round(metrics.queueAgeMs / metrics.queueAgeSamples) : 0,
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
