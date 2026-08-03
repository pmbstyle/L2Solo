const OpenRouterGateway = invoke('GameServer/Bot/AI/OpenRouterGateway');

const WINDOW_MS = 60 * 1000;
const LIMITS = Object.freeze({
    perBotMaxRequests: 6,
    perBotPromptTokens: 12000,
    perBotCompletionTokens: 2400,
    globalMaxRequests: 240,
    globalPromptTokens: 300000,
    globalCompletionTokens: 64000
});
const buckets = new Map();
const globalBucket = { entries: [], inFlight: 0, lastDeniedAt: 0, lastDeniedReason: null };
const globalWaiters = [];
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

function globalConfig() {
    const cfg = config();
    return {
        maxInFlight: Math.max(1, Math.floor(number(cfg.maxConcurrentRequests, 32))),
        maxRequests: LIMITS.globalMaxRequests,
        promptBudget: LIMITS.globalPromptTokens,
        completionBudget: LIMITS.globalCompletionTokens
    };
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

function budgetEntries(bucket) {
    return bucket.entries.filter((entry) => entry.bypass !== true);
}

function budgetCount(bucket) {
    return budgetEntries(bucket).length;
}

function budgetSum(bucket, field) {
    return budgetEntries(bucket).reduce((total, entry) => total + nonNegative(entry[field]), 0);
}

function knownCost(bucket) {
    return bucket.entries.reduce((total, entry) => total + (Number.isFinite(Number(entry.cost)) ? Number(entry.cost) : 0), 0);
}

function bypassedCount(bucket) {
    return bucket.entries.reduce((total, entry) => total + (entry.bypass === true ? 1 : 0), 0);
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

function globalRejection(reason, now, retryAfterMs = 0) {
    globalBucket.lastDeniedAt = now;
    globalBucket.lastDeniedReason = reason;
    return {
        ok: false,
        reason,
        retryAfterMs: Math.max(0, Math.ceil(retryAfterMs)),
        status: null
    };
}

function queueInteractiveReservation(session, input, now) {
    let resolveReady;
    const ready = new Promise((resolve) => {
        resolveReady = resolve;
    });
    globalWaiters.push({ session, input: { ...input }, now, resolve: resolveReady });
    return {
        ok: true,
        bypassed: true,
        queued: true,
        reservation: null,
        ready,
        status: status(session, now)
    };
}

function pumpGlobalWaiters() {
    const global = globalConfig();
    while (globalWaiters.length > 0 && globalBucket.inFlight < global.maxInFlight) {
        const waiter = globalWaiters.shift();
        const result = reserve(waiter.session, {
            ...waiter.input,
            now: Date.now(),
            _grantingQueued: true
        });
        waiter.resolve(result);
    }
}

function reserve(session, input = {}) {
    const id = actorId(session);
    if (!id) return { ok: false, reason: 'missing_bot' };

    const cfg = config();

    const now = Number(input.now || Date.now());
    const bucket = bucketFor(id);
    prune(bucket, now);
    const maxRequests = Math.max(1, Math.floor(number(input.maxRequests, LIMITS.perBotMaxRequests)));
    const promptBudget = Math.max(240, number(input.promptBudget, LIMITS.perBotPromptTokens));
    const completionBudget = Math.max(64, number(input.completionBudget, LIMITS.perBotCompletionTokens));
    const promptTokens = nonNegative(input.estimatedPromptTokens);
    const completionTokens = nonNegative(input.maxCompletionTokens ?? cfg.maxTokens);

    if (input.bypass !== true && budgetCount(bucket) >= maxRequests) {
        const oldest = bucket.entries[0];
        return rejection(bucket, 'inference_budget_requests', now, oldest ? WINDOW_MS - (now - oldest.startedAt) : WINDOW_MS);
    }
    if (input.bypass !== true && budgetSum(bucket, 'promptTokens') + promptTokens > promptBudget) {
        const oldest = bucket.entries[0];
        return rejection(bucket, 'inference_budget_prompt_tokens', now, oldest ? WINDOW_MS - (now - oldest.startedAt) : WINDOW_MS);
    }
    if (input.bypass !== true && budgetSum(bucket, 'completionTokens') + completionTokens > completionBudget) {
        const oldest = bucket.entries[0];
        return rejection(bucket, 'inference_budget_completion_tokens', now, oldest ? WINDOW_MS - (now - oldest.startedAt) : WINDOW_MS);
    }

    const global = globalConfig();
    prune(globalBucket, now);
    if (globalBucket.inFlight >= global.maxInFlight && input.bypass === true && input._grantingQueued !== true) {
        return queueInteractiveReservation(session, input, now);
    }
    if (globalBucket.inFlight >= global.maxInFlight && input._grantingQueued !== true) {
        return globalRejection('inference_budget_global_concurrency', now, 1000);
    }
    if (input.bypass !== true && budgetCount(globalBucket) >= global.maxRequests) {
        const oldest = globalBucket.entries[0];
        return globalRejection(
            'inference_budget_global_requests',
            now,
            oldest ? WINDOW_MS - (now - oldest.startedAt) : WINDOW_MS
        );
    }
    if (input.bypass !== true && budgetSum(globalBucket, 'promptTokens') + promptTokens > global.promptBudget) {
        const oldest = globalBucket.entries[0];
        return globalRejection(
            'inference_budget_global_prompt_tokens',
            now,
            oldest ? WINDOW_MS - (now - oldest.startedAt) : WINDOW_MS
        );
    }
    if (input.bypass !== true && budgetSum(globalBucket, 'completionTokens') + completionTokens > global.completionBudget) {
        const oldest = globalBucket.entries[0];
        return globalRejection(
            'inference_budget_global_completion_tokens',
            now,
            oldest ? WINDOW_MS - (now - oldest.startedAt) : WINDOW_MS
        );
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
        bypass: input.bypass === true,
        event: String(input.event || 'hot_decision').slice(0, 48),
        priority: String(input.priority || 'normal').slice(0, 24),
        globalEntry: null
    };
    bucket.entries.push(reservation);
    reservation.globalEntry = reservation;
    globalBucket.entries.push(reservation);
    globalBucket.inFlight += 1;
    return { ok: true, bypassed: input.bypass === true, reservation, status: status(session, now) };
}

function reserveForBotId(botId, input = {}) {
    return reserve({ characterId: Number(botId) }, input);
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
    if (reservation.globalEntry) globalBucket.inFlight = Math.max(0, globalBucket.inFlight - 1);
    pumpGlobalWaiters();
    return true;
}

function globalStatus(now = Date.now()) {
    const cfg = globalConfig();
    prune(globalBucket, now);
    const promptTokens = sum(globalBucket, 'promptTokens');
    const completionTokens = sum(globalBucket, 'completionTokens');
    const quotaPromptTokens = budgetSum(globalBucket, 'promptTokens');
    const quotaCompletionTokens = budgetSum(globalBucket, 'completionTokens');
    const quotaRequests = budgetCount(globalBucket);
    const oldest = globalBucket.entries[0];
    return {
        enabled: true,
        windowMs: WINDOW_MS,
        inFlight: globalBucket.inFlight,
        maxInFlight: cfg.maxInFlight,
        requests: globalBucket.entries.length,
        maxRequests: cfg.maxRequests,
        promptTokens,
        promptBudget: cfg.promptBudget,
        completionTokens,
        completionBudget: cfg.completionBudget,
        remainingRequests: Math.max(0, cfg.maxRequests - quotaRequests),
        remainingPromptTokens: Math.max(0, cfg.promptBudget - quotaPromptTokens),
        remainingCompletionTokens: Math.max(0, cfg.completionBudget - quotaCompletionTokens),
        nextResetAt: oldest ? oldest.startedAt + WINDOW_MS : null,
        lastDeniedReason: globalBucket.lastDeniedReason || null,
        lastDeniedAt: globalBucket.lastDeniedAt || null,
        queuedRequests: globalWaiters.length
    };
}

function status(session, now = Date.now()) {
    const id = actorId(session);
    if (!id) {
        return {
            enabled: true,
            windowMs: WINDOW_MS,
            requests: 0,
            bypassedRequests: 0,
            maxRequests: LIMITS.perBotMaxRequests,
            promptTokens: 0,
            promptBudget: LIMITS.perBotPromptTokens,
            completionTokens: 0,
            completionBudget: LIMITS.perBotCompletionTokens,
            cost: 0,
            remainingRequests: 0,
            remainingPromptTokens: 0,
            remainingCompletionTokens: 0,
            nextResetAt: null,
            lastDeniedReason: null,
            global: globalStatus(now)
        };
    }

    const bucket = bucketFor(id);
    prune(bucket, now);
    const maxRequests = LIMITS.perBotMaxRequests;
    const promptBudget = LIMITS.perBotPromptTokens;
    const completionBudget = LIMITS.perBotCompletionTokens;
    const promptTokens = sum(bucket, 'promptTokens');
    const completionTokens = sum(bucket, 'completionTokens');
    const quotaPromptTokens = budgetSum(bucket, 'promptTokens');
    const quotaCompletionTokens = budgetSum(bucket, 'completionTokens');
    const quotaRequests = budgetCount(bucket);
    const oldest = bucket.entries[0];
    return {
        enabled: true,
        windowMs: WINDOW_MS,
        requests: bucket.entries.length,
        bypassedRequests: bypassedCount(bucket),
        maxRequests,
        promptTokens,
        promptBudget,
        completionTokens,
        completionBudget,
        cost: knownCost(bucket),
        remainingRequests: Math.max(0, maxRequests - quotaRequests),
        remainingPromptTokens: Math.max(0, promptBudget - quotaPromptTokens),
        remainingCompletionTokens: Math.max(0, completionBudget - quotaCompletionTokens),
        nextResetAt: oldest ? oldest.startedAt + WINDOW_MS : null,
        lastDeniedReason: bucket.lastDeniedReason || null,
        lastDeniedAt: bucket.lastDeniedAt || null,
        global: globalStatus(now)
    };
}

const BotInferenceBudget = {
    WINDOW_MS,
    reserve,
    reserveForBotId,
    settle,
    status,
    snapshot: status,
    globalStatus,
    reset(session = null) {
        if (session) {
            const id = actorId(session);
            if (id) {
                const bucket = buckets.get(id);
                if (bucket) {
                    bucket.entries.forEach((entry) => {
                        if (entry.globalEntry && !entry.settled) {
                            globalBucket.inFlight = Math.max(0, globalBucket.inFlight - 1);
                        }
                        entry.globalEntry = null;
                    });
                }
                globalBucket.entries = globalBucket.entries.filter((entry) => entry.botId !== id);
                buckets.delete(id);
            }
            for (let index = globalWaiters.length - 1; index >= 0; index -= 1) {
                if (actorId(globalWaiters[index].session) === id) {
                    globalWaiters[index].resolve({ ok: false, reason: 'inference_budget_reset' });
                    globalWaiters.splice(index, 1);
                }
            }
            pumpGlobalWaiters();
            return;
        }
        buckets.clear();
        globalBucket.entries = [];
        globalBucket.inFlight = 0;
        globalBucket.lastDeniedAt = 0;
        globalBucket.lastDeniedReason = null;
        while (globalWaiters.length > 0) {
            globalWaiters.shift().resolve({ ok: false, reason: 'inference_budget_reset' });
        }
        reservationSequence = 0;
    },
    bucketCount() { return buckets.size; }
};

module.exports = BotInferenceBudget;
