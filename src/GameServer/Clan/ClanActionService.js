const { DiagnosticMetricMap } = require('../Bot/Population/DiagnosticMetricMap');
const DiagnosticConfig = require('../Bot/Population/PopulationConfig');
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
const ReviewEvents = require('./ClanReviewEvents');
const Diagnostics = require('../Bot/Economy/EconomyDiagnostics');
const { randomUUID } = require('node:crypto');

const ACTION_TYPES = Object.freeze({
    PLAN: 'goal_plan',
    CONTRIBUTION: 'contribution',
    WAREHOUSE: 'warehouse',
    MARKET: 'market',
    PARTY: 'party',
    TITLES: 'member_titles',
    SUPPLIES: 'supplies',
    PRODUCTION: 'production'
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
    stages: new DiagnosticMetricMap(),
    actionCounts: new DiagnosticMetricMap(),
    reasonCounts: new DiagnosticMetricMap()
};

let bootstrapped = false;
let bootstrapRetryAt = 0;

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
    if (!DiagnosticConfig.developerDiagnostics) return;
    if (value) map.set(String(value), (map.get(String(value)) || 0) + 1);
}

function recordAction(action, field = 'claimed') {
    if (!DiagnosticConfig.developerDiagnostics) return;
    record(metrics.actionCounts, `${action.actionType}:${field}`);
}

function actionPayload(action) {
    return parseJson(action?.payloadJson, {});
}

function recordQueueStats(stats = {}) {
    DiagnosticConfig.developerDiagnostics && (metrics.queuePending = number(stats.pending));
    DiagnosticConfig.developerDiagnostics && (metrics.queueReady = number(stats.ready));
    DiagnosticConfig.developerDiagnostics && (metrics.queueRunning = number(stats.running));
    DiagnosticConfig.developerDiagnostics && (metrics.queueExpiredRunning = number(stats.expiredRunning));
    DiagnosticConfig.developerDiagnostics && (metrics.queueOldestPendingAgeMs = number(stats.oldestPendingAgeMs));
    DiagnosticConfig.developerDiagnostics && (metrics.queueOldestReadyAgeMs = number(stats.oldestReadyAgeMs));
    DiagnosticConfig.developerDiagnostics && (metrics.queueOldestRunningAgeMs = number(stats.oldestRunningAgeMs));
    DiagnosticConfig.developerDiagnostics && (metrics.queueMaxAttempt = number(stats.maxAttempt));
    DiagnosticConfig.developerDiagnostics && (metrics.queueObservedAt = number(stats.observedAt, Date.now()));
}

async function refreshQueueStats() {
    const startedAt = DiagnosticConfig.developerDiagnostics ? Date.now() : 0;
    try {
        const stats = await Database.fetchClanActionQueueStats();
        recordQueueStats(stats);
        return stats;
    } finally {
        DiagnosticConfig.developerDiagnostics && StageMetrics.record(metrics.stages, 'queue_stats', Date.now() - startedAt);
    }
}

function actionTypeFor(clan, goal) {
    if (!clan || !goal || goal.status === 'completed' && !ReviewEvents.cashLevelGoal(clan, goal)) return null;
    if (goal.controlledBy === 'player') return OrderService.actionTypeForGoal(goal);
    // Equipment executes through member lifecycles. Its next review comes
    // from a changed member or warehouse, rather than a polling plan.
    if (goal.plan?.kind === 'alliance_trial' && number(clan.level) === 3
        && String(clan.state?.mode || '') === 'autonomous') return ACTION_TYPES.CONTRIBUTION;
    if (goal.type === 'equipment' || goal.type === 'strategy') return ACTION_TYPES.PLAN;
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
        return result.advanced?.ok === true || number(result.warehouse?.deposited) > 0;
    }
    if (actionType === ACTION_TYPES.WAREHOUSE) return number(result.deposited) > 0 || number(result.exchanged) > 0;
    if (actionType === ACTION_TYPES.MARKET) return result.purchased === true || result.advanced?.ok === true;
    if (actionType === ACTION_TYPES.PARTY) return result.started === true || result.resolved === true || result.succeeded === true;
    return result.changed === true;
}

function reviewDelayFor(actionType, goal, result = {}, ok = true, productive = workDone(actionType, result)) {
    if (!ok) return Config.actionRetryMs;
    // Assigning a different item is not acquisition progress. Let the roster
    // execute the assignment before another plan can replace it.
    if (actionType === ACTION_TYPES.PLAN && goal?.type === 'equipment') return Config.equipmentReviewMs;
    if (productive) return 0;
    if (actionType === ACTION_TYPES.PLAN) {
        return Config.goalReviewMs;
    }
    return Config.actionRetryMs;
}

function deferredRetryDelay(actionType, result = {}) {
    const reason = String(result?.code || result?.reason || '');
    if ([ACTION_TYPES.SUPPLIES, ACTION_TYPES.WAREHOUSE].includes(actionType) && result?.warehousePending === true) {
        return Config.actionRetryMs;
    }
    if ([ACTION_TYPES.PLAN, ACTION_TYPES.PRODUCTION].includes(actionType) && result?.retryable === true && reason === 'clan_planning_deferred') {
        return Math.min(5000, Config.actionRetryMs);
    }
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

async function scheduleProduction(clan) {
    if (require('./ClanStrategyPolicy').active(clan)) return;
    if (number(clan.level) >= 3) return;
    if (clan.state?.goal?.controlledBy === 'player' && clan.state.goal.status !== 'completed') return;
    const [active] = await Database.execute([`SELECT id FROM clan_actions WHERE clanId = ?
        AND actionType = 'production' AND status IN ('pending', 'running') LIMIT 1`, [clan.id]]);
    if (active) return;
    await Database.enqueueClanAction({ clanId: clan.id,
        actionType: ACTION_TYPES.PRODUCTION, priority: 30,
        actionKey: `clan:${clan.id}:production:${randomUUID()}` });
}

async function resolveProduction(clan, options = {}) {
    const strategy = require('./ClanStrategyPolicy').active(clan);
    if (strategy) return { ok: true, skipped: true, reason: 'strategy_focus' };
    if (clan.state?.goal?.controlledBy === 'player' && clan.state.goal.status !== 'completed') {
        return { ok: true, skipped: true, reason: 'player_order_active' };
    }
    if (number(clan.level) >= 3) return { ok: true, skipped: true };
    const service = invoke('GameServer/Clan/ClanEquipmentService');
    let result;
    try { result = await service.resolveClan(clan, clan.state?.productionGoal || null, { ...options, ownerSection: 'productionGoal' }); }
    catch (error) {
        if (error.code !== 'clan_planning_deferred') throw error;
        return { ok: true, retryable: true, reason: 'clan_planning_deferred' };
    }
    if (!result.ok || result.persistedGoal) return result;
    if (!result.goal && !result.recruitmentScan) return result;
    const saved = await Database.updateAutonomousClanGoal({ clanId: clan.id, ownerSection: 'productionGoal',
        goal: result.goal || clan.state?.productionGoal || null,
        expectedUpdatedAt: result.expectedUpdatedAt ?? number(clan.state?.updatedAt),
        recruitmentDemand: result.recruitmentDemand, recruitmentScan: result.recruitmentScan, eventType: null });
    if (!saved.ok) return { ...saved, reason: saved.code };
    return { ...result, ok: true, goal: saved.goal, retryable: !!result.continuation,
        ...(result.continuation ? { reason: 'clan_planning_deferred' } : {}) };
}

// A clan whose review met an action still leased by an earlier process: its
// review waits for the lease end (`until`), the event that ends this wait,
// instead of being raised again on every pass until the lease runs out.
const leaseWaits = new Map();

function releaseLeaseWaits(at = Date.now()) {
    for (const [clanId, until] of leaseWaits) {
        if (until > at) continue;
        leaseWaits.delete(clanId);
        ReviewEvents.changed(clanId, 'pending_review');
    }
}

// The other end of the wait: this process resolved an action of the clan
// before its lease ran out.
function endLeaseWait(clanId) {
    if (!leaseWaits.delete(number(clanId))) return;
    Diagnostics.count('clan_review', 'lease_wait', 'resolved');
    ReviewEvents.changed(number(clanId), 'pending_review');
}

// The open plan and supplies actions of the drained clans, one read per
// drain. A pending action takes the change (it reads its input when it
// runs); otherwise a running one, with its lease end.
async function openReviewActions(clanIds) {
    const types = [ACTION_TYPES.PLAN, ACTION_TYPES.SUPPLIES];
    const rows = await Database.execute([`SELECT a.clanId, a.actionType, a.status, a.leaseUntil, a.availableAt, s.mode FROM clan_actions a
        JOIN clan_simulation_clans s ON s.clanId = a.clanId
        WHERE a.clanId IN (${clanIds.map(() => '?').join(',')}) AND a.actionType IN (?, ?) AND a.status IN ('pending','running')`,
    [...clanIds, ...types]], 'clan-review:active');
    const open = new Map();
    for (const row of rows) {
        const key = `${number(row.clanId)}:${row.actionType}`;
        if (open.get(key)?.status !== 'pending') open.set(key, row);
    }
    Diagnostics.count('clan_review', 'active_read', 'batched');
    Diagnostics.count('clan_review', 'active_read', 'replaced', clanIds.length * types.length);
    return open;
}

async function scheduleReviews() {
    const at = Date.now();
    releaseLeaseWaits(at);
    const events = await ReviewEvents.drain(Database);
    if (!events.length) return;
    let open;
    try { open = await openReviewActions(events.map(event => event.clanId)); } catch (error) {
        for (const event of events) for (const cause of event.causes) ReviewEvents.changed(event.clanId, cause);
        throw error;
    }
    for (let index = 0; index < events.length; index++) {
        const event = events[index];
        try {
            for (const actionType of [ACTION_TYPES.PLAN, ACTION_TYPES.SUPPLIES]) {
                const active = open.get(`${event.clanId}:${actionType}`);
                // A running action owns its captured input. Keep the event for
                // a later pass instead of discarding a concurrent change: at
                // its lease end, or at once when the lease has run out.
                if (active) {
                    if (active.status === 'running') {
                        const until = number(active.leaseUntil);
                        if (until > at) {
                            leaseWaits.set(event.clanId, Math.max(leaseWaits.get(event.clanId) || 0, until));
                            Diagnostics.count('clan_review', 'lease_wait', 'parked');
                        } else ReviewEvents.changed(event.clanId, 'pending_review');
                    }
                    // A pending review reads fresh inputs, but a delayed
                    // strategy review must become ready on a real change.
                    if (active.status === 'running' || actionType !== ACTION_TYPES.PLAN
                        || active.mode !== 'autonomous' || number(active.availableAt) <= at) continue;
                }
                await Database.enqueueClanAction({ clanId: event.clanId, actionType, priority: actionType === ACTION_TYPES.PLAN ? 75 : 40,
                    coalescePending: actionType === ACTION_TYPES.PLAN,
                    actionKey: `clan:${event.clanId}:event:${randomUUID()}:${actionType}`, payload: { reasons: event.causes } });
            }
        } catch (error) {
            // drain() already removed every event of this batch: put the failing
            // one and all later ones back with their own causes.
            ReviewEvents.changed(event.clanId, 'review_retry');
            for (const rest of events.slice(index)) for (const cause of rest.causes) ReviewEvents.changed(rest.clanId, cause);
            throw error;
        }
    }
}

async function bootstrap() {
    if (bootstrapped || Date.now() < bootstrapRetryAt) return { attempted: 0, created: 0 };
    bootstrapped = true;
    // The flag only keeps one bootstrap in flight: a failed one is rerun by the
    // first resolve pass after one normal clan interval, not by every
    // continuation pass (a lasting fault would rerun all its reads each second).
    try { return await bootstrapOnce(); } catch (error) {
        bootstrapped = false;
        bootstrapRetryAt = Date.now() + Config.resolveIntervalMs;
        throw error;
    }
}

async function bootstrapOnce() {
    let afterId = 0, coalesced = 0;
    for (;;) {
        const page = await Database.repairClanProgressionQueue({ afterId });
        coalesced += page.cancelled;
        if (!page.scanned) break;
        afterId = page.afterId;
        // The repair also runs with players online; never hold main's DB
        // queue for the whole saved backlog (64 actions / 8 ms per transaction,
        // yielding at the next action boundary).
        await new Promise(resolve => setImmediate(resolve));
    }
    if (coalesced) utils.infoSuccess('ClanAction', 'coalesced %d obsolete progression actions', coalesced);
    const playerManaged = await Database.ensurePlayerManagedClans();
    const clans = await Database.fetchClansNeedingAction(Config.resolveBatchSize * 4);
    let created = 0;
    for (const clan of clans) {
        const result = await Database.enqueueClanAction({
            clanId: clan.clanId,
            actionKey: `clan:${Number(clan.clanId)}:recovery:v${BOOTSTRAP_RECOVERY_VERSION}:${Number(clan.updatedAt) || 0}`,
            actionType: ACTION_TYPES.PLAN,
            coalescePending: true,
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
    DiagnosticConfig.developerDiagnostics && (metrics.bootstraps += 1);
    DiagnosticConfig.developerDiagnostics && (metrics.planned += created + titleCreated);
    return { attempted: clans.length, created, playerManaged, titleAttempted, titleCreated, coalesced };
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
    if (queued.created) DiagnosticConfig.developerDiagnostics && (metrics.planned += 1);
    return queued;
}

async function scheduleNext(clan, goal, parentAction, delayMs = 0) {
    const type = actionTypeFor(clan, goal);
    if (!type) return { ok: true, scheduled: false, reason: 'goal_completed_or_missing' };
    const delay = Math.max(0, Number(delayMs) || 0);
    const actionKey = `clan:${Number(clan.id)}:after:${Number(parentAction.id)}:${type}:${Number(goal.updatedAt) || 0}`;
    const queued = await Database.enqueueClanAction({
        clanId: clan.id,
        actionKey,
        actionType: type,
        coalescePending: true,
        priority: [ACTION_TYPES.PLAN, ACTION_TYPES.CONTRIBUTION].includes(type) ? 75 : 50,
        availableAt: Date.now() + delay,
        payload: {
            parentActionId: Number(parentAction.id),
            goalUpdatedAt: Number(goal.updatedAt) || 0,
            goalType: String(goal.type || ''),
            plan: String(goal.plan?.kind || '')
        }
    });
    if (queued.created) DiagnosticConfig.developerDiagnostics && (metrics.planned += 1);
    return queued;
}

async function schedulePlanAfterLevelUp(clan, parentAction) {
    const actionKey = `clan:${Number(clan.id)}:after:${Number(parentAction.id)}:goal_plan:level_up`;
    const queued = await Database.enqueueClanAction({
        clanId: clan.id,
        actionKey,
        actionType: ACTION_TYPES.PLAN,
        priority: 100,
        payload: {
            parentActionId: Number(parentAction.id),
            reason: 'level_up'
        }
    });
    if (queued.created) DiagnosticConfig.developerDiagnostics && (metrics.planned += 1);
    return queued;
}

async function schedulePlanAfterMarketMiss(clan, parentAction) {
    const actionKey = `clan:${Number(clan.id)}:after:${Number(parentAction.id)}:goal_plan:market_replan`;
    const queued = await Database.enqueueClanAction({
        clanId: clan.id,
        actionKey,
        actionType: ACTION_TYPES.PLAN,
        priority: 100,
        payload: {
            parentActionId: Number(parentAction.id),
            reason: Contracts.REASON_CODES.MARKET_NO_OFFER
        }
    });
    if (queued.created) DiagnosticConfig.developerDiagnostics && (metrics.planned += 1);
    return queued;
}

async function loadClan(clanId) {
    const clan = await GoalService.clanProjectionById(clanId);
    if (clan) ReviewEvents.track(clan);
    else ReviewEvents.untrack(clanId);
    return clan;
}

async function execute(action, options = {}) {
    const projectionStartedAt = DiagnosticConfig.developerDiagnostics ? Date.now() : 0;
    const clan = await loadClan(action.clanId).finally(() => {
        DiagnosticConfig.developerDiagnostics && StageMetrics.record(metrics.stages, 'projection', Date.now() - projectionStartedAt);
    });
    if (!clan) return { ok: false, code: 'target_not_autonomous' };
    const payload = actionPayload(action);
    const reasons = new Set([payload.reason, ...(payload.reasons || [])]);
    const requestedDeadline = Number(options.deadlineAt);
    const leaseDeadline = Date.now() + Math.max(1, Config.actionLeaseMs - 1000);
    const deadlineAt = Number.isFinite(requestedDeadline)
        ? Math.min(requestedDeadline, leaseDeadline)
        : leaseDeadline;
    const actionType = String(action.actionType);
    const executeStartedAt = DiagnosticConfig.developerDiagnostics ? Date.now() : 0;
    let result;
    try {
        switch (actionType) {
            case ACTION_TYPES.PLAN: {
                // The beneficiary got its item (BotLifeState.enqueueEquipmentGoalAdvance):
                // below level 3 the equipment goal is the production goal, so pick the
                // next one now instead of at the next 15-min production review.
                const productionRequest = clan.state?.recruitmentDemand || clan.state?.recruitmentScan;
                if (number(clan.level) < 3 && (reasons.has('equipment_goal_completed')
                    || productionRequest?.ownerSection === 'productionGoal' && (reasons.has('recruitment_input')
                        || reasons.has('runtime_bootstrap')))) {
                    const main = await GoalService.resolveClan(clan, { actionId: Number(action.id), reviewCauses: payload.reasons || [] });
                    if (!main.ok || main.advanced?.ok) { result = main; break; }
                    const fresh = await loadClan(clan.id);
                    // The native payer/operation remains in its old action chain,
                    // even when this PLAN needs another bounded recruitment page.
                    // A funded level gets its native executor before equipment.
                    await scheduleNext(fresh, fresh.state?.goal, action);
                    if (ReviewEvents.cashLevelGoal(fresh) && fresh.state.goal.status === 'completed') { result = main; break; }
                    const production = await resolveProduction(fresh, { reviewCauses: payload.reasons || [] });
                    result = { ...main, ok: production.ok !== false, retryable: !!production.retryable || !!production.continuation,
                        reason: production.reason || main.reason,
                        production: { ownerSection: 'productionGoal', goalKey: production.goal?.goalKey || null,
                            reason: production.reason, joined: production.joined?.accepted || null } };
                    break;
                }
                result = String(clan.state?.mode || '') === 'player_managed'
                    && String(clan.state?.goal?.controlledBy || '') === 'player'
                    && clan.state?.goal?.status !== 'completed'
                    ? await OrderService.resolveClan(clan, {
                        actionId: Number(action.id),
                        reasonCode: String(payload.reason || '') === Contracts.REASON_CODES.MARKET_NO_OFFER
                            ? Contracts.REASON_CODES.MARKET_NO_OFFER
                            : ''
                    })
                    : await GoalService.resolveClan(clan, { actionId: Number(action.id), reviewCauses: payload.reasons || [] });
                break;
            }
            case ACTION_TYPES.CONTRIBUTION:
                result = await EconomyService.resolveClan(clan, { deadlineAt });
                break;
            case ACTION_TYPES.PRODUCTION:
                result = await resolveProduction(clan, { reviewCauses: payload.reasons || [] });
                break;
            case ACTION_TYPES.SUPPLIES:
                result = await WarehouseService.resolveClan(clan, { deadlineAt,
                    batchSize: Config.warehouseDepositBatchSize });
                {
                    const exchange = await invoke('GameServer/Clan/ClanWarehouseEquipmentService').resolveClan(clan.id, { deadlineAt });
                    result.exchanged = number(exchange.exchanged); result.warehousePending = exchange.pending === true;
                }
                await scheduleProduction(clan);
                break;
            case ACTION_TYPES.WAREHOUSE:
                result = await WarehouseService.resolveClan(clan, {
                    batchSize: 1,
                    deadlineAt,
                    actionId: Number(action.id)
                });
                {
                    const exchange = await invoke('GameServer/Clan/ClanWarehouseEquipmentService').resolveClan(clan.id, { deadlineAt });
                    result.exchanged = number(exchange.exchanged); result.warehousePending = exchange.pending === true;
                }
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
        const durationMs = DiagnosticConfig.developerDiagnostics ? Date.now() - executeStartedAt : 0;
        DiagnosticConfig.developerDiagnostics && StageMetrics.record(metrics.stages, 'execute', durationMs);
        DiagnosticConfig.developerDiagnostics && StageMetrics.record(metrics.stages, `execute:${actionType}`, durationMs);
    }
    return result || { ok: true };
}

function settledOutcome(action, { resolved, result, ok, reasonCode }, startedAt) {
    if (ok) {
        DiagnosticConfig.developerDiagnostics && (metrics.succeeded += 1);
        recordAction(action, 'succeeded');
    } else {
        DiagnosticConfig.developerDiagnostics && (metrics.failed += 1);
        recordAction(action, 'failed');
        record(metrics.reasonCounts, reasonCode);
    }
    return { ...resolved, result, durationMs: Date.now() - startedAt };
}

async function resolveAction(action, options = {}) {
    const startedAt = Date.now();
    let resolutionRecorded = false;
    let settled = null;
    DiagnosticConfig.developerDiagnostics && (metrics.running += 1);
    recordAction(action, 'running');
    try {
        const result = await execute(action, options);
        const eventWait = String(action.actionType) === ACTION_TYPES.PARTY
            && String(result?.code || result?.reason || '') === Contracts.REASON_CODES.PARTY_NOT_READY
            && String((await loadClan(action.clanId))?.state?.mode || '') === 'autonomous';
        const ok = result?.ok !== false || eventWait;
        const reasonCode = result?.code || result?.reason || (ok ? '' : 'clan_action_failed');
        const retryDelay = eventWait ? null : deferredRetryDelay(String(action.actionType), result);
        if (retryDelay !== null) {
            const deferStartedAt = DiagnosticConfig.developerDiagnostics ? Date.now() : 0;
            const released = await Database.releaseClanAction({
                actionId: action.id,
                availableAt: Date.now() + retryDelay,
                expectedAttempt: action.attempt,
                expectedLeaseUntil: action.leaseUntil
            }).finally(() => {
                DiagnosticConfig.developerDiagnostics && StageMetrics.record(metrics.stages, 'defer', Date.now() - deferStartedAt);
            });
            if (!released.ok) {
                DiagnosticConfig.developerDiagnostics && (metrics.releaseConflicts += 1);
                return released;
            }
            DiagnosticConfig.developerDiagnostics && (metrics.deferred += 1);
            DiagnosticConfig.developerDiagnostics && (metrics.retried += 1);
            recordAction(action, 'deferred');
            record(metrics.reasonCounts, reasonCode);
            return {
                ...released,
                deferred: true,
                result,
                durationMs: Date.now() - startedAt
            };
        }
        const settleStartedAt = DiagnosticConfig.developerDiagnostics ? Date.now() : 0;
        const resolved = await Database.resolveClanAction({
            actionId: action.id,
            status: ok ? 'succeeded' : 'failed',
            result,
            reasonCode
        }).finally(() => {
            DiagnosticConfig.developerDiagnostics && StageMetrics.record(metrics.stages, 'settle', Date.now() - settleStartedAt);
        });
        if (!resolved.ok) {
            DiagnosticConfig.developerDiagnostics && (metrics.releaseConflicts += 1);
            return resolved;
        }
        if (!resolved.idempotent) metrics.resolved += 1;
        resolutionRecorded = true;
        if (resolved.idempotent) return resolved;
        settled = { resolved, result, ok, reasonCode };

        const followUpStartedAt = DiagnosticConfig.developerDiagnostics ? Date.now() : 0;
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
            if ([ACTION_TYPES.TITLES, ACTION_TYPES.SUPPLIES, ACTION_TYPES.PRODUCTION].includes(String(action.actionType))) {
                // Auxiliary actions do not alter the goal execution chain.
            } else if (clan && advanced) {
                await schedulePlanAfterLevelUp(clan, action);
            } else if (clan && require('./ClanStrategyPolicy').active(clan) && String(action.actionType) === ACTION_TYPES.PLAN) {
                // This is a cheap progress/opportunity check, never a periodic
                // LLM call. It also wakes stalled equipment and funding goals.
                const reviewGoal = { type: 'strategy', status: 'executing', updatedAt: clan.state.strategy.lastDecisionAt };
                await scheduleNext(clan, reviewGoal, action, Config.goalReviewMs);
                // Native level payments/quests still have their own executor.
                if (goal && actionTypeFor(clan, goal) !== ACTION_TYPES.PLAN) await scheduleNext(clan, goal, action);
            } else if (clan && playerMarketWait) {
                await scheduleNext(clan, goal, action, Config.actionRetryMs);
                DiagnosticConfig.developerDiagnostics && (metrics.retried += 1);
            } else if (clan && marketMiss) {
                await schedulePlanAfterMarketMiss(clan, action);
            } else if (ReviewEvents.cashLevelGoal(clan, goal) && String(action.actionType) === ACTION_TYPES.CONTRIBUTION) {
                // One native payment attempt per changed input. A warehouse
                // deposit is progress, but cannot replace missing leader SP.
            } else if (clan && goal && !(String(action.actionType) === ACTION_TYPES.PLAN && goal.status === 'completed'
                && !ReviewEvents.cashLevelGoal(clan, goal))) {
                const productive = ok && workDone(String(action.actionType), result);
                const autonomous = String(clan.state?.mode || '') === 'autonomous';
                if (!autonomous || String(action.actionType) === ACTION_TYPES.PLAN && goal.type !== 'equipment' || productive) {
                    const delay = autonomous ? 0 : reviewDelayFor(String(action.actionType), goal, result, ok, productive);
                    await scheduleNext(clan, goal, action, delay);
                    if (delay > 0) DiagnosticConfig.developerDiagnostics && (metrics.retried += 1);
                }
            }
        } finally {
            DiagnosticConfig.developerDiagnostics && StageMetrics.record(metrics.stages, 'follow_up', Date.now() - followUpStartedAt);
        }
        return settledOutcome(action, settled, startedAt);
    } catch (error) {
        const reasonCode = error?.message || 'clan_action_exception';
        if (settled) {
            // The action itself is already settled; only its follow-up
            // scheduling failed, so report the stored status, not a failure.
            record(metrics.reasonCounts, 'clan_follow_up_exception');
            utils.infoWarn('ClanAction', 'follow-up of %s action %d failed: %s', String(action.actionType), Number(action.id), reasonCode);
            return { ...settledOutcome(action, settled, startedAt), followUpError: reasonCode };
        }
        const settleStartedAt = DiagnosticConfig.developerDiagnostics ? Date.now() : 0;
        const resolved = await Database.resolveClanAction({
            actionId: action.id,
            status: 'failed',
            result: { error: reasonCode },
            reasonCode: 'clan_action_exception'
        }).finally(() => {
            DiagnosticConfig.developerDiagnostics && StageMetrics.record(metrics.stages, 'settle', Date.now() - settleStartedAt);
        });
        if (resolved?.ok) {
            if (!resolved.idempotent && !resolutionRecorded) metrics.resolved += 1;
            resolutionRecorded = true;
        } else {
            DiagnosticConfig.developerDiagnostics && (metrics.releaseConflicts += 1);
        }
        DiagnosticConfig.developerDiagnostics && (metrics.failed += 1);
        record(metrics.reasonCounts, 'clan_action_exception');
        return { ok: false, code: 'clan_action_exception', error: reasonCode };
    } finally {
        const durationMs = DiagnosticConfig.developerDiagnostics ? Math.max(0, Date.now() - startedAt) : 0;
        DiagnosticConfig.developerDiagnostics && (metrics.durationMs += durationMs);
        DiagnosticConfig.developerDiagnostics && (metrics.durationSamples += 1);
        DiagnosticConfig.developerDiagnostics && (metrics.durationMaxMs = Math.max(metrics.durationMaxMs, durationMs));
        DiagnosticConfig.developerDiagnostics && StageMetrics.record(metrics.stages, 'total', durationMs);
        if (Number.isFinite(Number(options.deadlineAt)) && Date.now() > Number(options.deadlineAt)) {
            DiagnosticConfig.developerDiagnostics && (metrics.budgetOverruns += 1);
        }
        DiagnosticConfig.developerDiagnostics && (metrics.running = Math.max(0, metrics.running - 1));
    }
}

const ClanActionService = {
    config: Config,
    actionTypes: ACTION_TYPES,
    bootstrap,
    startEvents(onWake) { return ReviewEvents.start(invoke('GameServer/Bot/Population/BotLifeState'), invoke('GameServer/AfkTrade/AfkTradeService'), onWake); },
    stopEvents() { leaseWaits.clear(); ReviewEvents.stop(); },
    hasEvents: () => ReviewEvents.pending() > 0,
    scheduleReviews,
    scheduleTitleReview,
    reviewDelayFor,
    resolveAction,

    resolveBatch(options = {}) {
        if (!Config.enabled) return Promise.resolve({ attempted: 0, claimed: 0, resolved: 0, released: 0, succeeded: 0, failed: 0, leftRunning: 0, budgetStopped: false });
        const budgetMs = Math.max(1, number(options.budgetMs, Config.resolveBudgetMs));
        const safeLimit = Math.max(1, Math.min(100, Math.floor(number(options.limit, Config.actionBatchSize))));
        const batchStartedAt = DiagnosticConfig.developerDiagnostics ? Date.now() : 0;
        const bootstrapStartedAt = DiagnosticConfig.developerDiagnostics ? Date.now() : 0;
        return bootstrap().catch((error) => {
            // Recovery is retried by the next pass; the queued actions still run.
            utils.infoWarn('ClanAction', 'bootstrap failed: %s', error?.message || error);
            return { attempted: 0, created: 0, error: error?.message || String(error) };
        }).finally(() => {
            DiagnosticConfig.developerDiagnostics && StageMetrics.record(metrics.stages, 'bootstrap', Date.now() - bootstrapStartedAt);
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
            await scheduleReviews();
            if (DiagnosticConfig.developerDiagnostics) await refreshQueueStats();
            // Bootstrap and queue telemetry are admission overhead, not clan
            // work. Starting the execution budget before those reads caused a
            // live queue to claim and release the same oldest action forever
            // whenever SQLite needed more than the 80ms idle budget.
            const deadlineAt = Date.now() + budgetMs;
            let drained = false;
            while (summary.attempted < safeLimit) {
                if (Date.now() >= deadlineAt) {
                    summary.budgetStopped = true;
                    DiagnosticConfig.developerDiagnostics && (metrics.budgetStops += 1);
                    break;
                }
                const claimStartedAt = DiagnosticConfig.developerDiagnostics ? Date.now() : 0;
                const claim = await Database.claimClanAction({
                    leaseMs: Config.actionLeaseMs
                }).finally(() => {
                    DiagnosticConfig.developerDiagnostics && StageMetrics.record(metrics.stages, 'claim', Date.now() - claimStartedAt);
                });
                DiagnosticConfig.developerDiagnostics && (metrics.leaseRecoveries += number(claim?.recovered));
                const action = claim?.action || null;
                if (!action) { drained = true; break; }
                DiagnosticConfig.developerDiagnostics && (metrics.claimed += 1);
                summary.claimed += 1;
                DiagnosticConfig.developerDiagnostics && (metrics.queueAgeMs += Math.max(0, Date.now() - number(action.createdAt, Date.now())));
                DiagnosticConfig.developerDiagnostics && (metrics.queueAgeSamples += 1);
                recordAction(action);

                if (Date.now() >= deadlineAt) {
                    const releaseStartedAt = DiagnosticConfig.developerDiagnostics ? Date.now() : 0;
                    const released = await Database.releaseClanAction({
                        actionId: action.id,
                        expectedAttempt: action.attempt,
                        expectedLeaseUntil: action.leaseUntil
                    }).finally(() => {
                        DiagnosticConfig.developerDiagnostics && StageMetrics.record(metrics.stages, 'release', Date.now() - releaseStartedAt);
                    });
                    if (released.ok) {
                        DiagnosticConfig.developerDiagnostics && (metrics.releasedUnstarted += 1);
                        summary.released += 1;
                    } else {
                        DiagnosticConfig.developerDiagnostics && (metrics.releaseConflicts += 1);
                    }
                    summary.budgetStopped = true;
                    DiagnosticConfig.developerDiagnostics && (metrics.budgetStops += 1);
                    break;
                }

                const resolvedBefore = metrics.resolved;
                const result = await resolveAction(action, { deadlineAt });
                endLeaseWait(action.clanId);
                summary.attempted += 1;
                if (result.status === 'succeeded') summary.succeeded += 1;
                if (result.status === 'failed' || result.ok === false) summary.failed += 1;
                if (metrics.resolved > resolvedBefore) summary.resolved += 1;
            }
            // The caller reads only queue.ready, and only to continue soon: a
            // drained queue (no claimable action) has none ready, and a budget
            // stop continues anyway. Read the stats only when the batch limit
            // stopped the loop (the same path with the diagnostics on).
            const readStats = !drained && !summary.budgetStopped;
            Diagnostics.count('clan_actions', 'queue_stats', readStats ? 'read' : 'skipped');
            const queue = readStats ? await refreshQueueStats() : { ready: 0 };
            summary.leftRunning = number(queue.running);
            summary.queue = queue;
            return summary;
        }).finally(() => {
            DiagnosticConfig.developerDiagnostics && StageMetrics.record(metrics.stages, 'batch_total', Date.now() - batchStartedAt);
        });
    },

    metrics() {
        if (!DiagnosticConfig.developerDiagnostics) return { enabled: false };
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
        bootstrapRetryAt = 0;
        Object.keys(metrics).forEach((key) => {
            if (metrics[key] instanceof Map) metrics[key].clear();
            else metrics[key] = 0;
        });
    }
};

module.exports = ClanActionService;
