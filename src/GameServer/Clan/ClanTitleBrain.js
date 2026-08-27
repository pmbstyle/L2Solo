const Config = invoke('GameServer/Clan/ClanSimulationConfig');
const ContextAssembler = invoke('GameServer/Clan/ClanContextAssembler');
const OpenRouterGateway = invoke('GameServer/Bot/AI/OpenRouterGateway');
const BotInferenceBudget = invoke('GameServer/Bot/AI/BotInferenceBudget');

const MAX_COMPLETION_TOKENS = 700;
const PENDING_TTL_MS = 30 * 1000;
const RESOLVED_TTL_MS = 5 * 60 * 1000;
const decisions = new Map();

const metrics = {
    requested: 0,
    pending: 0,
    selected: 0,
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
        'You assign short in-world English clan titles to Lineage 2 clan members.',
        'Assign every requested member exactly once using only supplied character IDs.',
        'Use leader status, class, role, clan identity, current goal, history, and existing titles for flavor.',
        'Prefer distinctive timeless titles, not temporary level ranks or generic class names.',
        'Keep each title between 2 and 24 ASCII characters; the hard server limit is 32.',
        'Do not use emojis, profanity, player names, duplicate titles, or invented facts.',
        'The server validates and applies the titles. Return JSON only.'
    ].join(' ');
}

function completionTokenLimit(memberCount) {
    return Math.min(MAX_COMPLETION_TOKENS, Math.max(120, 60 + Math.max(1, number(memberCount)) * 28));
}

function responseSchema(memberIds = []) {
    return {
        type: 'object',
        properties: {
            assignments: {
                type: 'array',
                minItems: memberIds.length,
                maxItems: memberIds.length,
                items: {
                    type: 'object',
                    properties: {
                        characterId: { type: 'integer', enum: memberIds },
                        title: { type: 'string', minLength: 2, maxLength: 32 }
                    },
                    required: ['characterId', 'title'],
                    additionalProperties: false
                }
            }
        },
        required: ['assignments'],
        additionalProperties: false
    };
}

function configured() {
    const cfg = OpenRouterGateway.config({
        maxTokens: MAX_COMPLETION_TOKENS,
        timeoutMs: 10000,
        reasoningEffort: 'off'
    });
    return Config.llmTitleManagementEnabled !== false && OpenRouterGateway.isConfigured(cfg)
        ? cfg
        : null;
}

function prune(now = Date.now()) {
    for (const [key, entry] of decisions) {
        const ttl = entry.state === 'pending' ? PENDING_TTL_MS : RESOLVED_TTL_MS;
        if (now - entry.createdAt > ttl) decisions.delete(key);
    }
}

async function resolveDecision(entry, clan, snapshot, cfg) {
    const startedAt = Date.now();
    let reservation = null;
    let settledUsage = null;
    try {
        const memberIds = snapshot.missingMemberIds;
        const maxCompletionTokens = completionTokenLimit(memberIds.length);
        const estimatedPromptTokens = ContextAssembler.estimateTokens({
            messages: [systemPrompt(), snapshot.context],
            schema: responseSchema(memberIds)
        });
        metrics.promptTokensEstimated += estimatedPromptTokens;
        const admission = BotInferenceBudget.reserveForBotId(clan.leaderId, {
            estimatedPromptTokens,
            maxCompletionTokens,
            maxRequests: 2,
            promptBudget: 3500,
            completionBudget: 1500,
            event: 'clan_titles',
            priority: 'background'
        });
        if (!admission.ok) {
            metrics.budgetDenied += 1;
            return { ok: false, retryable: true, code: admission.reason, inferenceDenied: true };
        }
        reservation = admission.reservation;
        const result = await OpenRouterGateway.request({
            config: { ...cfg, maxTokens: maxCompletionTokens },
            circuitKey: 'clan-titles',
            requestId: `clan-titles-${number(clan.id)}-${Date.now()}`,
            sessionId: `autonomous-clan:${number(clan.id)}`,
            source: 'clan_title_brain',
            botId: number(clan.leaderId),
            messages: [
                { role: 'system', content: systemPrompt() },
                { role: 'user', content: JSON.stringify(snapshot.context) }
            ],
            responseSchema: {
                name: 'clan_title_assignments',
                schema: responseSchema(memberIds)
            },
            repairSchema: true
        });
        settledUsage = result.usage || null;
        const usage = result.usage || result.telemetry?.usage || {};
        metrics.promptTokensActual += number(usage.promptTokens);
        metrics.completionTokens += number(usage.completionTokens);
        metrics.cost += number(usage.cost);
        if (!result.ok) {
            metrics.failed += 1;
            return { ok: false, retryable: true, code: result.reason || result.telemetry?.outcome || 'llm_failed' };
        }
        metrics.selected += 1;
        return {
            ok: true,
            source: 'llm',
            assignments: result.data?.assignments || [],
            usage: result.usage || null,
            telemetry: result.telemetry || null,
            estimatedPromptTokens
        };
    } catch (error) {
        metrics.failed += 1;
        return { ok: false, retryable: true, code: 'clan_title_brain_exception', error: error.message };
    } finally {
        BotInferenceBudget.settle(reservation, settledUsage);
        const latency = Date.now() - startedAt;
        metrics.latencyMs += latency;
        metrics.latencyMaxMs = Math.max(metrics.latencyMaxMs, latency);
    }
}

function choose(clan, snapshot, options = {}) {
    prune();
    const existing = decisions.get(snapshot.key);
    if (existing?.state === 'resolved') return existing.result;
    if (existing?.state === 'pending') {
        metrics.pending += 1;
        return { pending: true, key: snapshot.key, code: 'clan_title_llm_pending' };
    }
    const cfg = options.config || configured();
    if (!cfg) {
        metrics.disabled += 1;
        return { pending: false, ok: false, retryable: false, code: 'llm_titles_not_configured' };
    }
    const entry = {
        key: snapshot.key,
        createdAt: Date.now(),
        state: 'pending',
        result: null,
        promise: null
    };
    decisions.set(snapshot.key, entry);
    metrics.requested += 1;
    entry.promise = resolveDecision(entry, clan, snapshot, cfg).then((result) => {
        entry.state = 'resolved';
        entry.result = result;
        if (!result.ok) metrics.invalid += result.code === 'invalid_clan_titles' ? 1 : 0;
        return result;
    });
    return { pending: true, key: snapshot.key, code: 'clan_title_llm_pending' };
}

module.exports = {
    MAX_COMPLETION_TOKENS,
    completionTokenLimit,
    systemPrompt,
    responseSchema,
    configured,
    choose,
    async waitFor(key) {
        const entry = decisions.get(key);
        if (!entry) return null;
        return entry.promise || entry.result;
    },
    forget(key) {
        decisions.delete(String(key || ''));
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
