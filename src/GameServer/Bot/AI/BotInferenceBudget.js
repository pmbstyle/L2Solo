const OpenRouterGateway = invoke('GameServer/Bot/AI/OpenRouterGateway');

const WINDOW_MS = 60 * 1000;
const buckets = new Map();
let reservationSequence = 0;

function actorId(session) {
    const id = Number(session?.actor?.fetchId?.() || session?.characterId || 0);
    return Number.isInteger(id) && id > 0 ? id : null;
}

function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function nonNegative(value, fallback = 0) {
    return Math.max(0, number(value, fallback));
}

function config() {
    return OpenRouterGateway.config();
}

function bucketFor(id) {
    if (!buckets.has(id)) buckets.set(id, { entries: [], lastDeniedAt: 0, lastDeniedReason: null });
    return buckets.get(id);
}

function prune(bucket, now) {
    bucket.entries = bucket.entries.filter((entry) => now - entry.startedAt < WINDOW_MS);
}

function usageValue(usage, key) {
    if (!usage || typeof usage !== 'object') return null;
    const value = Number(usage[key]);
    return Number.isFinite(value) && value >= 0 ? value : null;
}

function sum(bucket, field) {
    return bucket.entries.reduce((total, entry) => total + nonNegative(entry[field]), 0);
}

function knownCost(bucket) {
    return bucket.entries.reduce((total, entry) => total + (Number.isFinite(Number(entry.cost)) ? Number(entry.cost) : 0), 0);
}

function rejection(bucket, reason, now, retryAfterMs = 0) {
    bucket.lastDeniedAt = now;
    bucket.lastDeniedReason = reason;
    return {
        ok: false,
        reason,
        retryAfterMs: Math.max(0, Math.ceil(retryAfterMs)),
        status: null
    };
}

function reserve(session, input = {}) {
    const id = actorId(session);
    if (!id) return { ok: false, reason: 'missing_bot' };

    const cfg = config();
    if (cfg.hotBotBudgetEnabled === false || input.bypass === true) {
        return { ok: true, bypassed: true, reservation: null, status: status(session) };
    }

    const now = Number(input.now || Date.now());
    const bucket = bucketFor(id);
    prune(bucket, now);
    const maxRequests = Math.max(1, Math.floor(number(input.maxRequests, cfg.hotBotMaxRequestsPerMinute)));
    const promptBudget = Math.max(240, number(input.promptBudget, cfg.hotBotPromptTokenBudgetPerMinute));
    const completionBudget = Math.max(64, number(input.completionBudget, cfg.hotBotCompletionTokenBudgetPerMinute));
    const promptTokens = nonNegative(input.estimatedPromptTokens);
    const completionTokens = nonNegative(input.maxCompletionTokens ?? cfg.maxTokens);

    if (bucket.entries.length >= maxRequests) {
        const oldest = bucket.entries[0];
        return rejection(bucket, 'inference_budget_requests', now, oldest ? WINDOW_MS - (now - oldest.startedAt) : WINDOW_MS);
    }
    if (sum(bucket, 'promptTokens') + promptTokens > promptBudget) {
        const oldest = bucket.entries[0];
        return rejection(bucket, 'inference_budget_prompt_tokens', now, oldest ? WINDOW_MS - (now - oldest.startedAt) : WINDOW_MS);
    }
    if (sum(bucket, 'completionTokens') + completionTokens > completionBudget) {
        const oldest = bucket.entries[0];
        return rejection(bucket, 'inference_budget_completion_tokens', now, oldest ? WINDOW_MS - (now - oldest.startedAt) : WINDOW_MS);
    }

    const reservation = {
        id: `inference-${id}-${++reservationSequence}`,
        botId: id,
        startedAt: now,
        promptTokens,
        completionTokens,
        reservedPromptTokens: promptTokens,
        reservedCompletionTokens: completionTokens,
        settled: false,
        event: String(input.event || 'hot_decision').slice(0, 48),
        priority: String(input.priority || 'normal').slice(0, 24)
    };
    bucket.entries.push(reservation);
    return { ok: true, reservation, status: status(session, now) };
}

function settle(reservation, usage = null) {
    if (!reservation || reservation.settled) return false;
    const prompt = usageValue(usage, 'promptTokens');
    const completion = usageValue(usage, 'completionTokens');
    reservation.promptTokens = prompt === null ? reservation.reservedPromptTokens : prompt;
    reservation.completionTokens = completion === null ? reservation.reservedCompletionTokens : completion;
    reservation.totalTokens = reservation.promptTokens + reservation.completionTokens;
    reservation.cost = Number.isFinite(Number(usage?.cost)) ? Number(usage.cost) : null;
    reservation.settled = true;
    return true;
}

function status(session, now = Date.now()) {
    const id = actorId(session);
    const cfg = config();
    if (!id) {
        return {
            enabled: cfg.hotBotBudgetEnabled !== false,
            windowMs: WINDOW_MS,
            requests: 0,
            maxRequests: Math.max(1, Math.floor(number(cfg.hotBotMaxRequestsPerMinute, 6))),
            promptTokens: 0,
            promptBudget: Math.max(240, number(cfg.hotBotPromptTokenBudgetPerMinute, 12000)),
            completionTokens: 0,
            completionBudget: Math.max(64, number(cfg.hotBotCompletionTokenBudgetPerMinute, 2400)),
            cost: 0,
            remainingRequests: 0,
            remainingPromptTokens: 0,
            remainingCompletionTokens: 0,
            nextResetAt: null,
            lastDeniedReason: null
        };
    }

    const bucket = bucketFor(id);
    prune(bucket, now);
    const maxRequests = Math.max(1, Math.floor(number(cfg.hotBotMaxRequestsPerMinute, 6)));
    const promptBudget = Math.max(240, number(cfg.hotBotPromptTokenBudgetPerMinute, 12000));
    const completionBudget = Math.max(64, number(cfg.hotBotCompletionTokenBudgetPerMinute, 2400));
    const promptTokens = sum(bucket, 'promptTokens');
    const completionTokens = sum(bucket, 'completionTokens');
    const oldest = bucket.entries[0];
    return {
        enabled: cfg.hotBotBudgetEnabled !== false,
        windowMs: WINDOW_MS,
        requests: bucket.entries.length,
        maxRequests,
        promptTokens,
        promptBudget,
        completionTokens,
        completionBudget,
        cost: knownCost(bucket),
        remainingRequests: Math.max(0, maxRequests - bucket.entries.length),
        remainingPromptTokens: Math.max(0, promptBudget - promptTokens),
        remainingCompletionTokens: Math.max(0, completionBudget - completionTokens),
        nextResetAt: oldest ? oldest.startedAt + WINDOW_MS : null,
        lastDeniedReason: bucket.lastDeniedReason || null,
        lastDeniedAt: bucket.lastDeniedAt || null
    };
}

const BotInferenceBudget = {
    WINDOW_MS,
    reserve,
    settle,
    status,
    snapshot: status,
    reset(session = null) {
        if (session) {
            const id = actorId(session);
            if (id) buckets.delete(id);
            return;
        }
        buckets.clear();
        reservationSequence = 0;
    },
    bucketCount() { return buckets.size; }
};

module.exports = BotInferenceBudget;
