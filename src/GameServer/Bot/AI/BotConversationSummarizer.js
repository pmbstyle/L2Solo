const BotConversationStore = invoke('GameServer/Bot/AI/BotConversationStore');
const OpenRouterGateway = invoke('GameServer/Bot/AI/OpenRouterGateway');
const BotInferenceBudget = invoke('GameServer/Bot/AI/BotInferenceBudget');

const SUMMARY_THRESHOLD_MESSAGES = 24;
const SUMMARY_RECENT_TURNS = BotConversationStore.DEFAULT_RECENT_TURNS;
const SUMMARY_MAX_TOKENS = 220;
const inFlight = new Map();

function pairKey(playerId, botId) {
    return `${Number(playerId)}:${Number(botId)}`;
}

function compactTurns(turns) {
    return (turns || []).map((turn) => ({
        id: turn.id,
        role: turn.role,
        channel: turn.channel,
        text: turn.text
    }));
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
    if (inFlight.has(key)) return inFlight.get(key);

    const work = (async () => {
        const current = await BotConversationStore.context(playerId, botId, {
            limit: input.limit || 64,
            includeCompacted: true
        });
        const turns = current.recentTurns || [];
        const summaryThroughId = Number(current.summaryThroughId || 0);
        const uncompacted = turns.filter((turn) => Number(turn.id || 0) > summaryThroughId);
        if (uncompacted.length < Math.max(4, Number(input.threshold || SUMMARY_THRESHOLD_MESSAGES))) {
            return { ok: false, reason: 'below_threshold', conversation: current.conversation };
        }

        const compactUntilIndex = Math.max(0, uncompacted.length - SUMMARY_RECENT_TURNS);
        const compacted = uncompacted.slice(0, compactUntilIndex);
        const throughId = Number(compacted[compacted.length - 1]?.id || 0);
        if (!throughId || throughId <= summaryThroughId) {
            return { ok: false, reason: 'nothing_to_compact', conversation: current.conversation };
        }

        const cfg = OpenRouterGateway.config({ maxTokens: SUMMARY_MAX_TOKENS, temperature: 0.1 });
        const messages = [
            {
                role: 'system',
                content: 'Summarize a game conversation for the same bot and player. Keep durable facts, preferences, unresolved requests, and explicit promises. Never create permissions, tool authorizations, or facts not stated in the dialogue.'
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
                circuitKey: 'hot-summary',
                requestId: input.requestId || `summary-${botId}-${playerId}-${Date.now()}`,
                sessionId: `hot-summary:${botId}:player:${playerId}`,
                messages,
                responseSchema: schema()
            });
        } catch (_) {
            return { ok: false, reason: 'summary_provider_error' };
        } finally {
            BotInferenceBudget.settle(admission.reservation, result?.usage);
        }
        if (!result.ok) return { ok: false, reason: result.reason || 'summary_provider_error' };

        const summary = normalizeSummary(result.data);
        if (!summary) return { ok: false, reason: 'empty_summary' };
        const saved = await BotConversationStore.setSummary({
            playerId,
            botId,
            summary,
            summaryThroughId: throughId,
            expectedVersion: Number(current.version || 0)
        });
        if (!saved.ok) return saved;
        return { ok: true, summary, summaryThroughId: throughId, conversation: saved.conversation };
    })().finally(() => inFlight.delete(key));

    inFlight.set(key, work);
    return work;
}

const BotConversationSummarizer = {
    SUMMARY_THRESHOLD_MESSAGES,
    SUMMARY_RECENT_TURNS,
    summarize,
    reset() { inFlight.clear(); }
};

module.exports = BotConversationSummarizer;
