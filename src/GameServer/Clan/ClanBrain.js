const Config = invoke('GameServer/Clan/ClanSimulationConfig');
const ContextAssembler = invoke('GameServer/Clan/ClanContextAssembler');
const OpenRouterGateway = invoke('GameServer/Bot/AI/OpenRouterGateway');
const BotInferenceBudget = invoke('GameServer/Bot/AI/BotInferenceBudget');

const MAX_COMPLETION_TOKENS = 120;
const PENDING_TTL_MS = 30 * 1000;
const RESOLVED_TTL_MS = 5 * 60 * 1000;
const decisions = new Map();

const REASON_CODES = Object.freeze([
    'mandatory_progression',
    'goal_fulfilled',
    'goal_blocked',
    'better_clan_readiness',
    'better_value',
    'fair_distribution',
    'keep_current',
    'deterministic_fallback'
]);

const metrics = {
    requested: 0,
    pending: 0,
    selected: 0,
    fallback: 0,
    disabled: 0,
    budgetDenied: 0,
    invalid: 0,
    failed: 0,
    promptTokensEstimated: 0,
    promptTokensActual: 0,
    completionTokens: 0,
    cost: 0,
    latencyMs: 0,
    latencyMaxMs: 0
};

function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function systemPrompt() {
    return [
        'You manage one Lineage 2 clan and choose exactly one supplied goal candidate.',
        'Use only candidate and route values present in the JSON.',
        'Never invent items, members, NPCs, prices, routes, or goals.',
        'Current state is more authoritative than history.',
        'Keep a progressing goal; replace a blocked or completed goal with an executable useful candidate.',
        'Do not repeat a historically failed route unless its blocker changed.',
        'The server validates and executes the choice.',
        'Return JSON only.'
    ].join(' ');
}

function responseSchema(candidates = []) {
    const candidateIds = candidates.map((candidate) => candidate.id);
    const routes = [...new Set(candidates.map((candidate) => candidate.route?.kind).filter(Boolean))];
    return {
        type: 'object',
        properties: {
            candidateId: { type: 'string', enum: candidateIds },
            route: { type: 'string', enum: routes.length ? routes : ['prepare'] },
            reasonCode: { type: 'string', enum: REASON_CODES }
        },
        required: ['candidateId', 'route', 'reasonCode'],
        additionalProperties: false
    };
}

function fallback(candidateSnapshot, reason = 'deterministic_fallback', extra = {}) {
    const candidate = candidateSnapshot.candidates.find((entry) => (
        entry.id === candidateSnapshot.deterministicCandidateId
    )) || candidateSnapshot.candidates[0] || null;
    metrics.fallback += 1;
    return {
        pending: false,
        source: 'deterministic',
        candidate,
        candidateId: candidate?.id || null,
        route: candidate?.route?.kind || null,
        reasonCode: reason,
        ...extra
    };
}

function prune(now = Date.now()) {
    for (const [key, entry] of decisions) {
        const ttl = entry.state === 'pending' ? PENDING_TTL_MS : RESOLVED_TTL_MS;
        if (now - entry.createdAt > ttl) decisions.delete(key);
    }
}

function configured() {
    const cfg = OpenRouterGateway.config({
        maxTokens: MAX_COMPLETION_TOKENS,
        timeoutMs: 10000,
        reasoningEffort: 'off'
    });
    return Config.llmGoalManagementEnabled !== false && OpenRouterGateway.isConfigured(cfg)
        ? cfg
        : null;
}

function recordUsage(result, estimatedPromptTokens, startedAt) {
    const usage = result?.usage || result?.telemetry?.usage || {};
    metrics.promptTokensEstimated += number(estimatedPromptTokens);
    metrics.promptTokensActual += number(usage.promptTokens);
    metrics.completionTokens += number(usage.completionTokens);
    metrics.cost += number(usage.cost);
    const latency = Date.now() - startedAt;
    metrics.latencyMs += latency;
    metrics.latencyMaxMs = Math.max(metrics.latencyMaxMs, latency);
}

function contextTelemetry(assembled = {}) {
    return {
        estimatedTokens: number(assembled.estimatedTokens),
        buildMs: number(assembled.buildMs),
        truncated: assembled.truncated === true,
        historyEventCount: number(assembled.historyEventCount)
    };
}

async function resolveDecision(entry, clan, candidateSnapshot, cfg, options = {}) {
    const startedAt = Date.now();
    let reservation = null;
    let settledUsage = null;
    try {
        const assembled = await (options.assemble || ContextAssembler.assemble)(clan, candidateSnapshot);
        const payload = assembled.context;
        const estimatedPromptTokens = ContextAssembler.estimateTokens({
            messages: [systemPrompt(), payload],
            schema: responseSchema(candidateSnapshot.candidates)
        });
        const admission = BotInferenceBudget.reserveForBotId(clan.leaderId, {
            estimatedPromptTokens,
            maxCompletionTokens: MAX_COMPLETION_TOKENS,
            maxRequests: 2,
            promptBudget: 5000,
            completionBudget: 300,
            event: 'clan_goal',
            priority: 'background'
        });
        if (!admission.ok) {
            metrics.budgetDenied += 1;
            return fallback(candidateSnapshot, admission.reason, {
                contextTelemetry: contextTelemetry(assembled),
                inferenceDenied: true
            });
        }
        reservation = admission.reservation;
        const result = await OpenRouterGateway.request({
            config: cfg,
            circuitKey: 'clan-goal',
            requestId: `clan-goal-${number(clan.id)}-${Date.now()}`,
            sessionId: `autonomous-clan:${number(clan.id)}`,
            source: 'clan_goal_brain',
            botId: number(clan.leaderId),
            messages: [
                { role: 'system', content: systemPrompt() },
                { role: 'user', content: JSON.stringify(payload) }
            ],
            responseSchema: {
                name: 'clan_goal_decision',
                schema: responseSchema(candidateSnapshot.candidates)
            },
            repairSchema: true
        });
        settledUsage = result.usage || null;
        recordUsage(result, estimatedPromptTokens, startedAt);
        if (!result.ok) {
            metrics.failed += 1;
            return fallback(candidateSnapshot, result.reason || result.telemetry?.outcome || 'llm_failed', {
                llmTelemetry: result.telemetry || null,
                contextTelemetry: contextTelemetry(assembled)
            });
        }
        const selected = candidateSnapshot.candidates.find((candidate) => candidate.id === result.data?.candidateId);
        if (!selected || String(selected.route?.kind || '') !== String(result.data?.route || '')) {
            metrics.invalid += 1;
            return fallback(candidateSnapshot, 'invalid_llm_selection', {
                llmTelemetry: result.telemetry || null,
                contextTelemetry: contextTelemetry(assembled)
            });
        }
        metrics.selected += 1;
        return {
            pending: false,
            source: 'llm',
            candidate: selected,
            candidateId: selected.id,
            route: selected.route.kind,
            reasonCode: result.data.reasonCode,
            usage: result.usage || null,
            llmTelemetry: result.telemetry || null,
            contextTelemetry: contextTelemetry(assembled)
        };
    } catch (error) {
        metrics.failed += 1;
        return fallback(candidateSnapshot, 'clan_brain_exception', { error: error.message });
    } finally {
        BotInferenceBudget.settle(reservation, settledUsage);
        const latency = Date.now() - startedAt;
        metrics.latencyMaxMs = Math.max(metrics.latencyMaxMs, latency);
    }
}

function choose(clan, candidateSnapshot, options = {}) {
    prune();
    if (!candidateSnapshot?.candidates?.length) return fallback(candidateSnapshot || { candidates: [] }, 'no_candidates');
    const key = candidateSnapshot.key;
    const existing = decisions.get(key);
    if (existing?.state === 'resolved') return existing.result;
    if (existing?.state === 'pending') {
        metrics.pending += 1;
        return { pending: true, key, reasonCode: 'clan_llm_pending' };
    }
    const cfg = options.config || configured();
    if (!cfg || !candidateSnapshot.decisionNeeded) {
        if (!cfg) metrics.disabled += 1;
        return fallback(candidateSnapshot, candidateSnapshot.decisionNeeded ? 'llm_not_configured' : 'decision_not_needed');
    }

    const entry = {
        key,
        clanId: number(clan.id),
        createdAt: Date.now(),
        state: 'pending',
        result: null,
        promise: null
    };
    decisions.set(key, entry);
    metrics.requested += 1;
    entry.promise = resolveDecision(entry, clan, candidateSnapshot, cfg, options).then((result) => {
        entry.state = 'resolved';
        entry.result = result;
        return result;
    });
    return { pending: true, key, reasonCode: 'clan_llm_pending' };
}

module.exports = {
    MAX_COMPLETION_TOKENS,
    REASON_CODES,
    systemPrompt,
    responseSchema,
    configured,
    choose,
    async waitFor(key) {
        const entry = decisions.get(key);
        if (!entry) return null;
        return entry.promise ? entry.promise : entry.result;
    },
    metrics() {
        return {
            ...metrics,
            pendingEntries: [...decisions.values()].filter((entry) => entry.state === 'pending').length,
            cacheEntries: decisions.size,
            latencyAvgMs: metrics.requested ? metrics.latencyMs / metrics.requested : 0
        };
    },
    reset() {
        decisions.clear();
        Object.keys(metrics).forEach((key) => { metrics[key] = 0; });
    }
};
