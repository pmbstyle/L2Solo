const MAX_ROUTE_FAILURES = 3;
const MAX_WORK_BUDGET_FAILURES = 3;
const BASE_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 5000;
const TARGET_TOLERANCE = 96;
const DEFAULT_ARRIVAL_RADIUS = 240;
const INITIAL_ERRAND_PATH_MAX_NODES = 30000;
const RECOVERY_ERRAND_PATH_MAX_NODES = 120000;
const targetActorCache = new WeakMap();
const TRANSIENT_ERRORS = new Set(['QUEUE_FULL', 'PATH_TIMEOUT', 'PATH_PREEMPTED', 'PATH_BUDGET', 'WORKER_UNAVAILABLE', 'WORKER_EXIT', 'POOL_SHUTDOWN']);

function pointOf(actor) {
    return {
        locX: Number(actor?.fetchLocX?.() ?? actor?.locX ?? 0),
        locY: Number(actor?.fetchLocY?.() ?? actor?.locY ?? 0),
        locZ: Number(actor?.fetchLocZ?.() ?? actor?.locZ ?? 0)
    };
}

function sameTarget(first, second, tolerance = TARGET_TOLERANCE) {
    if (!first || !second) return false;
    return Math.abs(Number(first?.locX) - Number(second?.locX)) <= tolerance &&
        Math.abs(Number(first?.locY) - Number(second?.locY)) <= tolerance &&
        Math.abs(Number(first?.locZ) - Number(second?.locZ)) <= tolerance;
}

function targetKey(kind, target) {
    return [
        String(kind || 'companion'),
        Number(target?.actorId || 0),
        Math.round(Number(target?.locX || 0)),
        Math.round(Number(target?.locY || 0)),
        Math.round(Number(target?.locZ || 0))
    ].join(':');
}

function recoveryState(session, kind, target) {
    const key = targetKey(kind, target);
    if (session.companionNavigationRecovery?.key !== key) {
        session.companionNavigationRecovery = {
            key,
            failures: 0,
            lastFailureAt: 0,
            retryAt: 0,
            lastAttemptAt: 0
        };
    }
    return session.companionNavigationRecovery;
}

function clear(session) {
    if (session) delete session.companionNavigationRecovery;
}

function failedDiagnostic(session, target, state) {
    const diagnostic = session?.lastPathfinding;
    const at = Number(diagnostic?.at || 0);
    if (diagnostic?.routeUsable !== false || !at || at <= Number(state.lastFailureAt || 0)) return null;
    if (!sameTarget(diagnostic.requestedTo, target)) return null;
    return diagnostic;
}

function resolveTargetActor(target) {
    const actorId = Number(target?.actorId || 0);
    if (!actorId) return null;
    const cached = targetActorCache.get(target);
    if (Number(cached?.fetchId?.() || 0) === actorId
        && cached.fetchIsOnline?.() !== false
        && cached.isDead?.() !== true) return cached;
    targetActorCache.delete(target);

    const World = invoke('GameServer/World/World');
    const userActor = (World.user?.sessions || [])
        .find((candidate) => Number(candidate?.actor?.fetchId?.() || 0) === actorId)?.actor || null;
    const actor = userActor || (World.npc?.spawns || [])
        .find((candidate) => Number(candidate?.fetchId?.() || 0) === actorId) || null;
    if (actor) targetActorCache.set(target, actor);
    return actor;
}

function refreshTarget(target, targetActor = resolveTargetActor(target)) {
    const actor = targetActor;
    if (!actor) return target;
    target.locX = Number(actor.fetchLocX());
    target.locY = Number(actor.fetchLocY());
    target.locZ = Number(actor.fetchLocZ());
    const head = Number(actor.fetchHead?.());
    if (Number.isFinite(head)) target.head = ((head % 65536) + 65536) % 65536;
    return target;
}

function move(session, bot, target, kind, options = {}) {
    const targetActor = options.targetActor === undefined
        ? resolveTargetActor(target)
        : options.targetActor;
    refreshTarget(target, targetActor);
    const now = Date.now();
    const state = recoveryState(session, kind, target);
    const point = pointOf(bot);
    if (!state.budgetAnchor || Math.hypot(point.locX - state.budgetAnchor.locX, point.locY - state.budgetAnchor.locY) >= 96
        || Math.abs(point.locZ - state.budgetAnchor.locZ) >= 64) {
        state.budgetAnchor = point;
        state.budgetFailures = 0;
    }
    const failure = failedDiagnostic(session, target, state);

    if (failure) {
        state.lastFailureAt = Number(failure.at);
        if (TRANSIENT_ERRORS.has(failure.error)) {
            // A running search repeatedly exhausting its own work allowance
            // is different from waiting for capacity in the worker queue.
            if (failure.error === 'PATH_BUDGET') state.budgetFailures++;
            if (state.budgetFailures >= MAX_WORK_BUDGET_FAILURES) {
                return { status: 'exhausted', failures: state.failures, reason: 'work_budget_exhausted', diagnostic: failure };
            }
            state.retryAt = now + BASE_RETRY_DELAY_MS + Math.abs(Number(bot?.fetchId?.() || 0) % 1000);
            return { status: 'waiting', failures: state.failures, retryAt: state.retryAt, reason: 'budget_deferred' };
        }
        state.failures += 1;
        state.retryAt = now + Math.min(MAX_RETRY_DELAY_MS, BASE_RETRY_DELAY_MS * state.failures);
        // A failed town waypoint can be the sticky plan that caused the empty
        // route. Let the next bounded attempt ask TownPathfinder for a fresh
        // waypoint instead of replaying the same dead end.
        session.townRoutePlan = null;
    }

    if (state.budgetFailures >= MAX_WORK_BUDGET_FAILURES) {
        return { status: 'exhausted', failures: state.failures, reason: 'work_budget_exhausted', diagnostic: session.lastPathfinding };
    }

    if (state.failures >= MAX_ROUTE_FAILURES) {
        return {
            status: 'exhausted',
            failures: state.failures,
            diagnostic: failure || session.lastPathfinding || null
        };
    }

    if (state.retryAt > now) {
        return { status: 'waiting', failures: state.failures, retryAt: state.retryAt };
    }

    const pendingTarget = session.pendingPathRequest?.requestedTo;
    const activeTarget = session.activeMoveGoal?.requestedTo;
    const movingToTarget = sameTarget(pendingTarget, target) ||
        sameTarget(activeTarget, target) ||
        !!session.moveTimer;
    if (movingToTarget || bot.state?.inMotion?.() || bot.state?.fetchTowards?.()) {
        return { status: 'moving', failures: state.failures };
    }

    const forceRepath = state.failures > 0;
    const moveData = {
        from: pointOf(bot),
        to: { ...target },
        arrivalRadius: Math.max(0, Number(options.arrivalRadius ?? DEFAULT_ARRIVAL_RADIUS)),
        pathMaxNodes: state.failures > 0
            ? RECOVERY_ERRAND_PATH_MAX_NODES
            : INITIAL_ERRAND_PATH_MAX_NODES,
        targetActor,
        ...(forceRepath ? { forceRepath: true } : {})
    };
    state.lastAttemptAt = now;
    bot.moveTo(moveData);
    return { status: 'started', failures: state.failures, forceRepath };
}

module.exports = {
    BASE_RETRY_DELAY_MS,
    MAX_RETRY_DELAY_MS,
    MAX_ROUTE_FAILURES,
    DEFAULT_ARRIVAL_RADIUS,
    INITIAL_ERRAND_PATH_MAX_NODES,
    RECOVERY_ERRAND_PATH_MAX_NODES,
    TARGET_TOLERANCE,
    clear,
    move,
    refreshTarget,
    resolveTargetActor,
    sameTarget,
    targetKey
};
