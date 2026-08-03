const BotConversationStore = invoke('GameServer/Bot/AI/BotConversationStore');
const OpenRouterGateway = invoke('GameServer/Bot/AI/OpenRouterGateway');
const BotInferenceBudget = invoke('GameServer/Bot/AI/BotInferenceBudget');

const SUMMARY_THRESHOLD_MESSAGES = 24;
const SUMMARY_RECENT_TURNS = BotConversationStore.DEFAULT_RECENT_TURNS;
const SUMMARY_MAX_TOKENS = 220;
const SUMMARY_BACKOFF_BASE_MS = 30 * 1000;
const SUMMARY_BACKOFF_MAX_MS = 10 * 60 * 1000;
const inFlight = new Map();
const failures = new Map();

function pairKey(playerId, botId) {
    return `${Number(playerId)}:${Number(botId)}`;
}

function backoffState(key) {
    const state = failures.get(key);
    if (!state || Number(state.nextRetryAt || 0) <= Date.now()) return null;
    return {
        ok: false,
        reason: 'summary_backoff',
        retryAfterMs: Math.max(1, Number(state.nextRetryAt) - Date.now()),
        failureCount: Number(state.failureCount || 0),
        lastFailure: state.reason || null
    };
}

function recordFailure(key, reason) {
    const previous = failures.get(key) || { failureCount: 0 };
    const failureCount = Number(previous.failureCount || 0) + 1;
    const delay = Math.min(
        SUMMARY_BACKOFF_MAX_MS,
        SUMMARY_BACKOFF_BASE_MS * (2 ** Math.min(8, failureCount - 1))
    );
    failures.set(key, { failureCount, nextRetryAt: Date.now() + delay, reason });
}

function compactMeta(meta) {
    if (!meta || typeof meta !== 'object') return null;
    const result = {};
    ['action', 'reason', 'providerOutcome'].forEach((key) => {
        if (meta[key]) result[key] = meta[key];
    });
    if (meta.serverApplied === true) result.serverApplied = true;
    if (meta.actionResult && typeof meta.actionResult === 'object') {
        result.actionResult = {
            ok: meta.actionResult.ok === true,
            reason: meta.actionResult.reason || null,
            outcome: meta.actionResult.outcome || null,
            effect: meta.actionResult.effect || null
        };
    }
    return Object.keys(result).length ? result : null;
}

function compactTurns(turns) {
    return (turns || []).map((turn) => {
        const compact = {
            id: turn.id,
            role: turn.role,
            channel: turn.channel,
            text: turn.text
        };
        const meta = compactMeta(turn.meta);
        if (meta) compact.meta = meta;
        return compact;
    });
}

function estimateTokens(value) {
    try { return Math.max(1, Math.ceil(JSON.stringify(value).length / 4)); } catch (_) { return 1; }
}

function schema() {
    return {
        name: 'bot_conversation_summary',
        schema: {
            type: 'object',
            properties: {
                summary: { type: 'string' },
                openTopics: { type: 'array', items: { type: 'string' } },
                promises: { type: 'array', items: { type: 'string' } }
            },
            required: ['summary', 'openTopics', 'promises'],
            additionalProperties: false
        }
    };
}

function normalizeSummary(data) {
    if (!data || typeof data !== 'object') return '';
    const summary = String(data.summary || '').replace(/\s+/g, ' ').trim();
    const openTopics = Array.isArray(data.openTopics)
        ? data.openTopics.map((value) => String(value || '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 4)
        : [];
    const promises = Array.isArray(data.promises)
        ? data.promises.map((value) => String(value || '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 4)
        : [];
    if (!summary && openTopics.length === 0 && promises.length === 0) return '';
    const sections = [summary || 'No stable facts recorded.'];
    if (openTopics.length) sections.push(`Open topics: ${openTopics.join('; ')}`);
    if (promises.length) sections.push(`Promises: ${promises.join('; ')}`);
    return sections.join(' ').slice(0, 1500);
}

async function summarize(input = {}) {
    const playerId = Number(input.playerId || 0);
    const botId = Number(input.botId || 0);
    if (!playerId || !botId) return { ok: false, reason: 'invalid_pair' };
    const key = pairKey(playerId, botId);
    const blocked = backoffState(key);
    if (blocked) return blocked;
    if (inFlight.has(key)) return inFlight.get(key);

    const work = (async () => {
        const current = await BotConversationStore.context(playerId, botId, {
            limit: input.limit || 64,
            includeCompacted: true
        });
        const turns = current.recentTurns || [];
        const summaryThroughId = Number(current.summaryThroughId || 0);
        const summaryThroughOrdinal = Number(current.summaryThroughOrdinal || 0);
        const uncompacted = turns.filter((turn) => (
            Number(turn.turnOrdinal || turn.id || 0) > summaryThroughOrdinal && turn.compacted !== true
        ));
        if (uncompacted.length < Math.max(4, Number(input.threshold || SUMMARY_THRESHOLD_MESSAGES))) {
            return { ok: false, reason: 'below_threshold', conversation: current.conversation };
        }

        let compactUntilIndex = Math.max(0, uncompacted.length - SUMMARY_RECENT_TURNS);
        while (compactUntilIndex > 0 && compactUntilIndex < uncompacted.length &&
            Number(uncompacted[compactUntilIndex - 1].turnOrdinal || 0) ===
            Number(uncompacted[compactUntilIndex].turnOrdinal || 0)) {
            compactUntilIndex -= 1;
        }
        const compacted = uncompacted.slice(0, compactUntilIndex);
        const throughId = Number(compacted[compacted.length - 1]?.id || 0);
        const throughOrdinal = Number(compacted[compacted.length - 1]?.turnOrdinal || 0);
        if ((!throughId && !throughOrdinal) ||
            (throughOrdinal > 0 ? throughOrdinal <= summaryThroughOrdinal : throughId <= summaryThroughId)) {
            return { ok: false, reason: 'nothing_to_compact', conversation: current.conversation };
        }

        const cfg = OpenRouterGateway.config({ maxTokens: SUMMARY_MAX_TOKENS, temperature: 0.1 });
        const messages = [
            {
                role: 'system',
                content: 'Summarize a game conversation for the same bot and player. Keep durable facts, preferences, unresolved requests, and explicit promises. Treat action metadata as authoritative: only an action with serverApplied=true or actionResult.ok=true happened; an LLM proposal, refusal, fallback, or failed action did not happen. A pending action means a server-side request or native window is active, not that the final transfer or effect completed. Never create permissions, tool authorizations, or facts not stated in the dialogue.'
            },
            { role: 'user', content: JSON.stringify({ previousSummary: current.summary || '', turns: compactTurns(compacted) }) }
        ];
        const admission = BotInferenceBudget.reserveForBotId(botId, {
            event: 'conversation_summary',
            estimatedPromptTokens: estimateTokens({ messages, responseSchema: schema() }),
            maxCompletionTokens: cfg.maxTokens
        });
        if (!admission.ok) return { ok: false, reason: admission.reason, retryAfterMs: admission.retryAfterMs };

        let result = null;
        try {
            result = await OpenRouterGateway.request({
                config: cfg,
                circuitKey: `conversation-summary:${botId}:${playerId}`,
                circuitBreaker: false,
                timeoutMs: 0,
                requestId: input.requestId || `summary-${botId}-${playerId}-${Date.now()}`,
                sessionId: `hot-summary:${botId}:player:${playerId}`,
                source: 'conversation_summary',
                botId,
                playerId,
                messages,
                responseSchema: schema()
            });
        } catch (_) {
            recordFailure(key, 'summary_provider_error');
            return { ok: false, reason: 'summary_provider_error' };
        } finally {
            BotInferenceBudget.settle(admission.reservation, result?.usage);
        }
        if (!result.ok) {
            const reason = result.reason || 'summary_provider_error';
            recordFailure(key, reason);
            return { ok: false, reason };
        }

        const summary = normalizeSummary(result.data);
        if (!summary) {
            recordFailure(key, 'empty_summary');
            return { ok: false, reason: 'empty_summary' };
        }
        const saved = await BotConversationStore.setSummary({
            playerId,
            botId,
            summary,
            summaryThroughId: throughId,
            summaryThroughOrdinal: throughOrdinal,
            expectedVersion: Number(current.version || 0)
        });
        if (!saved.ok) {
            recordFailure(key, saved.reason || 'summary_store_error');
            return saved;
        }
        failures.delete(key);
        return {
            ok: true,
            summary,
            summaryThroughId: throughId,
            summaryThroughOrdinal: throughOrdinal,
            conversation: saved.conversation
        };
    })().finally(() => inFlight.delete(key));

    inFlight.set(key, work);
    return work;
}

const BotConversationSummarizer = {
    SUMMARY_THRESHOLD_MESSAGES,
    SUMMARY_RECENT_TURNS,
    summarize,
    reset() { inFlight.clear(); failures.clear(); }
};

module.exports = BotConversationSummarizer;
