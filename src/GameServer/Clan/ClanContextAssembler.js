const Database = invoke('Database');
const ClanPolicy = invoke('GameServer/Clan/ClanSimulationPolicy');

const DEFAULT_TOKEN_BUDGET = 2200;
const HARD_MAX_TOKENS = 2500;
const MAX_CANDIDATES = 8;
const MAX_HISTORY_GOALS = 5;
const MAX_RECENT_EVENTS = 6;

const SUCCESS_REASONS = new Set([
    '', 'goal_completed', 'party_operation_started', 'party_operation_succeeded',
    'party_reward_applied', 'market_item_to_clan_warehouse', 'clan_order_delivered'
]);

const metrics = {
    builds: 0,
    buildMs: 0,
    buildMaxMs: 0,
    estimatedTokens: 0,
    truncated: 0
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

function estimateTokens(value) {
    try {
        return Math.max(1, Math.ceil(JSON.stringify(value).length / 4));
    } catch (_) {
        return 1;
    }
}

function goalIdentity(goal = {}, event = {}) {
    const payload = goal && typeof goal === 'object' ? goal : {};
    const target = payload.target || {};
    if (payload.goalKey) return String(payload.goalKey);
    if (number(payload.orderId || event.orderId)) return `order:${number(payload.orderId || event.orderId)}`;
    const type = String(payload.type || event.goalType || 'goal');
    return [type, number(target.memberId), number(target.itemId), number(target.level)].join(':');
}

function compactGoal(goal = null) {
    if (!goal || typeof goal !== 'object') return null;
    return {
        id: goalIdentity(goal),
        type: String(goal.type || ''),
        status: String(goal.status || ''),
        target: goal.target ? {
            memberId: number(goal.target.memberId) || null,
            memberName: goal.target.memberName || null,
            itemId: number(goal.target.itemId) || null,
            itemName: goal.target.itemName || null,
            level: number(goal.target.level) || null
        } : null,
        progress: number(goal.progress),
        required: number(goal.required),
        plan: String(goal.plan?.kind || ''),
        reason: String(goal.plan?.reasonCode || goal.reasonCodes?.slice(-1)[0] || ''),
        failures: number(goal.catastrophicFailures),
        createdAt: number(goal.createdAt) || null,
        updatedAt: number(goal.updatedAt) || null
    };
}

function eventGoal(event) {
    const payload = parseJson(event.payloadJson, {});
    if (payload.type && payload.target) return payload;
    return {
        type: event.goalType || '',
        orderId: payload.orderId,
        target: {
            itemId: payload.itemId,
            itemName: payload.itemName
        },
        progress: payload.progress,
        required: payload.required,
        plan: { kind: event.plan, reasonCode: event.reasonCode },
        updatedAt: event.occurredAt
    };
}

function historyFromEvents(events = [], currentGoal = null) {
    const episodes = new Map();
    [...events].reverse().forEach((event) => {
        const goal = eventGoal(event);
        const key = goalIdentity(goal, event);
        if (!key || key === 'goal:0:0:0') return;
        if (!episodes.has(key)) {
            episodes.set(key, {
                id: key,
                type: String(goal.type || event.goalType || ''),
                target: compactGoal(goal)?.target || null,
                startedAt: number(event.occurredAt),
                updatedAt: number(event.occurredAt),
                progress: number(goal.progress),
                required: number(goal.required),
                plans: [],
                reasons: [],
                outcome: 'active'
            });
        }
        const episode = episodes.get(key);
        episode.startedAt = Math.min(episode.startedAt || Infinity, number(event.occurredAt));
        episode.updatedAt = Math.max(episode.updatedAt, number(event.occurredAt));
        episode.progress = Math.max(episode.progress, number(goal.progress));
        episode.required = Math.max(episode.required, number(goal.required));
        const plan = String(event.plan || goal.plan?.kind || '');
        const reason = String(event.reasonCode || goal.plan?.reasonCode || '');
        if (plan && !episode.plans.includes(plan)) episode.plans.push(plan);
        if (reason && !episode.reasons.includes(reason)) episode.reasons.push(reason);
        const type = String(event.eventType || '');
        if (/completed|succeeded/.test(type)) episode.outcome = 'completed';
        else if (/cancelled/.test(type)) episode.outcome = 'cancelled';
        else if (/failed/.test(type)) episode.outcome = 'failed';
        else if (/replanned|advanced/.test(type)) episode.outcome = 'replanned';
    });

    const currentId = goalIdentity(currentGoal || {});
    const ordered = [...episodes.values()].sort((left, right) => right.updatedAt - left.updatedAt);
    const currentEpisode = ordered.find((episode) => episode.id === currentId) || null;
    const previousGoals = ordered.filter((episode) => episode.id !== currentId).slice(0, MAX_HISTORY_GOALS);
    return { currentEpisode, previousGoals };
}

function learnedConstraints(events = []) {
    const grouped = new Map();
    events.forEach((event) => {
        const reason = String(event.reasonCode || '');
        const eventType = String(event.eventType || '');
        const failureSignal = /failed|cancelled|blocked/.test(eventType)
            || /(^|_)(no_|blocked|not_ready|unavailable|timeout|stale|missing|unreachable|failed|exception)/.test(reason);
        if (!failureSignal || SUCCESS_REASONS.has(reason) || /succeeded|completed/.test(reason)) return;
        const key = `${String(event.plan || 'unknown')}:${reason}`;
        const existing = grouped.get(key) || {
            plan: String(event.plan || ''),
            reason,
            count: 0,
            latestAt: 0
        };
        existing.count += 1;
        existing.latestAt = Math.max(existing.latestAt, number(event.occurredAt));
        grouped.set(key, existing);
    });
    return [...grouped.values()]
        .sort((left, right) => right.count - left.count || right.latestAt - left.latestAt)
        .slice(0, 5);
}

function recentEvents(events = []) {
    return events.slice(0, MAX_RECENT_EVENTS).map((event) => ({
        type: String(event.eventType || ''),
        goal: String(event.goalType || ''),
        plan: String(event.plan || ''),
        reason: String(event.reasonCode || ''),
        at: number(event.occurredAt)
    }));
}

async function meaningfulEvents(clanId, limit = 120) {
    const safeLimit = Math.max(20, Math.min(200, Math.floor(number(limit, 120))));
    return Database.execute([`
        SELECT id, clanId, eventType, goalType, plan, reasonCode, payloadJson, occurredAt
        FROM clan_goal_events
        WHERE clanId = ? AND eventType != 'action_succeeded'
        ORDER BY occurredAt DESC, id DESC
        LIMIT ${safeLimit}
    `, [number(clanId)]], 'clan-brain:history');
}

function clanSnapshot(clan = {}, planning = null) {
    const members = clan.members || [];
    const roles = ClanPolicy.roleCounts(members);
    const levels = members.map((member) => number(member.level)).filter((level) => level > 0);
    const warehouseRows = planning?.warehouseRows || [];
    return {
        id: number(clan.id),
        level: number(clan.level),
        revision: number(clan.state?.updatedAt),
        members: members.length,
        available: members.filter((member) => member.phase === 'cold' && !member.partyId).length,
        roles,
        levels: levels.length ? {
            min: Math.min(...levels),
            max: Math.max(...levels),
            average: Math.round(levels.reduce((sum, level) => sum + level, 0) / levels.length)
        } : null,
        warehouse: {
            adena: warehouseRows.filter((row) => number(row.selfId) === 57)
                .reduce((sum, row) => sum + number(row.amount), 0),
            itemStacks: warehouseRows.length
        }
    };
}

function compactCandidate(candidate) {
    return {
        id: candidate.id,
        beneficiary: candidate.beneficiary,
        item: candidate.item,
        priority: candidate.assessment.priority,
        serverRank: candidate.assessment.serverRank,
        current: candidate.assessment.current,
        route: candidate.route,
        blockers: candidate.blockers
    };
}

function fitContext(context, budget, hardMax) {
    let truncated = false;
    const result = JSON.parse(JSON.stringify(context));
    const trimOne = () => {
        if (result.history.recentMeaningfulEvents.length > 2) return result.history.recentMeaningfulEvents.pop();
        if (result.history.learnedConstraints.length > 2) return result.history.learnedConstraints.pop();
        if (result.history.previousGoals.length > 2) return result.history.previousGoals.pop();
        if (result.candidates.length > 2) return result.candidates.pop();
        return null;
    };
    while (estimateTokens(result) > budget && trimOne()) truncated = true;
    while (estimateTokens(result) > hardMax && trimOne()) truncated = true;
    return { context: result, truncated, estimatedTokens: Math.min(hardMax, estimateTokens(result)) };
}

async function assemble(clan, candidateSnapshot, options = {}) {
    const startedAt = Date.now();
    const events = await meaningfulEvents(clan.id, options.eventLimit);
    const goalHistory = historyFromEvents(events, clan.state?.goal || null);
    const base = {
        decisionReason: candidateSnapshot.decisionReason,
        clan: clanSnapshot(clan, candidateSnapshot.planning),
        currentGoal: compactGoal(clan.state?.goal || null),
        history: {
            ...goalHistory,
            learnedConstraints: learnedConstraints(events),
            recentMeaningfulEvents: recentEvents(events)
        },
        candidates: candidateSnapshot.candidates.slice(0, MAX_CANDIDATES).map(compactCandidate),
        deterministicFallbackId: candidateSnapshot.deterministicCandidateId
    };
    const fitted = fitContext(
        base,
        Math.max(800, number(options.tokenBudget, DEFAULT_TOKEN_BUDGET)),
        Math.max(DEFAULT_TOKEN_BUDGET, number(options.hardMaxTokens, HARD_MAX_TOKENS))
    );
    const durationMs = Date.now() - startedAt;
    metrics.builds += 1;
    metrics.buildMs += durationMs;
    metrics.buildMaxMs = Math.max(metrics.buildMaxMs, durationMs);
    metrics.estimatedTokens += fitted.estimatedTokens;
    if (fitted.truncated) metrics.truncated += 1;
    return {
        ...fitted,
        buildMs: durationMs,
        historyEventCount: events.length
    };
}

module.exports = {
    DEFAULT_TOKEN_BUDGET,
    HARD_MAX_TOKENS,
    MAX_CANDIDATES,
    MAX_HISTORY_GOALS,
    MAX_RECENT_EVENTS,
    estimateTokens,
    historyFromEvents,
    learnedConstraints,
    assemble,
    metrics() {
        return {
            ...metrics,
            buildAvgMs: metrics.builds ? metrics.buildMs / metrics.builds : 0,
            tokenAvg: metrics.builds ? metrics.estimatedTokens / metrics.builds : 0
        };
    },
    resetMetrics() {
        Object.keys(metrics).forEach((key) => { metrics[key] = 0; });
    }
};
