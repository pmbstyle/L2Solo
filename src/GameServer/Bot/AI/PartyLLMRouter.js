const OpenRouterGateway = invoke('GameServer/Bot/AI/OpenRouterGateway');
const LangfuseTracing = invoke('GameServer/Bot/AI/LangfuseTracing');

const ROUTER_SCHEMA = {
    name: 'party_chat_route',
    schema: {
        type: 'object',
        properties: {
            route: { type: 'string', enum: ['bot', 'party', 'clarify', 'none'] },
            botId: { type: ['number', 'null'] },
            intent: { type: 'string' },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            reason: { type: 'string' }
        },
        required: ['route', 'botId', 'intent', 'confidence', 'reason'],
        additionalProperties: false
    }
};

const ROUTER_TEMPERATURE = 0.1;
const ROUTER_MAX_TOKENS = 512;

function config() {
    const gateway = OpenRouterGateway.config();
    return {
        ...gateway,
        model: String(gateway.partyRouterModel || '').trim()
    };
}

function enabled() {
    const cfg = config();
    return OpenRouterGateway.isConfigured(cfg);
}

function playerId(session) {
    return session?.actor?.fetchId?.() || null;
}

function channelTurns(state, channel = 'party_chat') {
    return (state?.recentTurns || []).filter((turn) => turn.channel === channel);
}

function candidateCard(candidate, state, channel) {
    const id = candidate?.id ?? null;
    const lastTurn = [...channelTurns(state, channel)]
        .reverse()
        .find((turn) => turn.role === 'bot' && String(turn.botId) === String(id));
    return {
        id,
        name: String(candidate?.name || '').slice(0, 48),
        role: String(candidate?.role || 'dps').slice(0, 24),
        companion: candidate?.companion === true,
        lastSpoke: lastTurn?.text ? String(lastTurn.text).slice(0, 120) : null
    };
}

function normalizeData(data, candidates, group = 'party') {
    let route = ['bot', group, 'clarify', 'none'].includes(data?.route) ? data.route : 'none';
    const reason = String(data?.reason || 'router_decision').slice(0, 240);
    const ambiguitySignal = !/\bnot ambiguous\b/i.test(reason) &&
        /\b(?:ambiguous|ambiguity|clarif(?:y|ication)|specify|which (?:bot|party member|clan member)|addressee)\b/i.test(reason);
    // Small routers occasionally emit route=none while explicitly explaining
    // that the addressee is ambiguous. Preserve the semantic decision rather
    // than silently dropping a turn that the model itself says needs clarity.
    if (route === 'none' && ambiguitySignal) route = 'clarify';
    const requestedId = data?.botId === null || data?.botId === undefined ? null : Number(data.botId);
    const candidate = route === 'bot'
        ? candidates.find((entry) => Number(entry.id) === requestedId) || null
        : null;
    if (route === 'bot' && !candidate) {
        const invalid = {
            ok: false,
            route: 'clarify',
            candidate: null,
            intent: 'unknown',
            confidence: 0,
            reason: 'invalid_bot_id',
            data
        };
        invalid.traceOutput = { ...invalid, candidate: null };
        return invalid;
    }
    const normalized = {
        ok: true,
        route,
        candidate,
        intent: String(data?.intent || 'conversation').slice(0, 80),
        confidence: Math.max(0, Math.min(1, Number(data?.confidence || 0))),
        reason,
        data
    };
    normalized.traceOutput = {
        ok: normalized.ok,
        route: normalized.route,
        candidateId: candidate?.id ?? null,
        intent: normalized.intent,
        confidence: normalized.confidence,
        reason: normalized.reason,
        data: normalized.data
    };
    return normalized;
}

function prompt(input, cards, channel) {
    return {
        message: String(input.text || '').slice(0, 500),
        channel,
        ...(channel === 'clan_chat' ? { player: { id: playerId(input.playerSession), name: input.playerSession?.actor?.fetchName?.() || '' } } : {}),
        selectedBotId: input.selectedBotId ?? null,
        inFlightBotId: input.dialogueState?.inFlightBotId ?? null,
        lastDeliveredBotId: input.dialogueState?.lastDeliveredBotId ?? null,
        [channel === 'clan_chat' ? 'recentClanTurns' : 'recentPartyTurns']: channelTurns(input.dialogueState, channel).slice(-6).map((turn) => ({
            role: turn.role,
            botId: turn.botId,
            ...(turn.name ? { name: turn.name } : {}),
            text: String(turn.text || '').slice(0, 160)
        })),
        candidates: cards
    };
}

async function route(input = {}) {
    const cfg = config();
    if (!OpenRouterGateway.isConfigured(cfg)) {
        return { ok: false, route: 'none', candidate: null, reason: 'disabled', telemetry: null };
    }

    const candidates = Array.isArray(input.candidates) ? input.candidates : [];
    if (candidates.length === 0) {
        return { ok: false, route: 'none', candidate: null, reason: 'no_candidates', telemetry: null };
    }

    const group = input.channel === 'clan_chat' ? 'clan' : 'party';
    const channel = `${group}_chat`;
    const responseSchema = group === 'clan' ? {
        name: 'clan_chat_route',
        schema: { ...ROUTER_SCHEMA.schema, properties: {
            ...ROUTER_SCHEMA.schema.properties,
            route: { type: 'string', enum: ['bot', 'clan', 'clarify', 'none'] }
        } }
    } : ROUTER_SCHEMA;
    const userPayload = prompt(input, candidates.map((candidate) => candidateCard(candidate, input.dialogueState, channel)), channel);
    const botId = playerId(input.playerSession);
    const metadata = {
        event: `${group}_chat_route`,
        source: `${group}_router`,
        channel,
        playerId: botId,
        candidateCount: candidates.length,
        model: cfg.model,
        sessionId: `${group}-chat:${botId || 'unknown'}`
    };

    return LangfuseTracing.withObservation(
        `${group}.router.generation`,
        userPayload,
        metadata,
        async () => {
            const result = await OpenRouterGateway.request({
                config: {
                    ...cfg,
                    model: cfg.model,
                    reasoningEffort: 'low',
                    temperature: ROUTER_TEMPERATURE,
                    maxTokens: ROUTER_MAX_TOKENS,
                    timeoutMs: group === 'clan' ? 60000 : 0
                },
                requestId: `${group}-router:${botId || 'unknown'}:${Date.now()}`,
                sessionId: `${group}-router:${botId || 'unknown'}`,
                circuitKey: `${group}-router`,
                source: `${group}_router`,
                playerId: botId,
                interactive: false,
                messages: [
                    {
                        role: 'system',
                        content: [
                            `You are a strict ${group}-chat router for an online game.`,
                            'Choose at most one current candidate bot; never invent IDs.',
                            `Use route=${group} only when the message is genuinely for the whole ${group}.`,
                            'Use clarify when a human should clarify an ambiguous addressee.',
                            'Never use none merely because the addressee is ambiguous; use clarify.',
                            'Use none only for messages that genuinely need no bot response.',
                            'For example, "who should answer this?" is clarify, not none.',
                            'Return only the required JSON object. Do not call tools and do not roleplay.'
                        ].join(' ')
                    },
                    { role: 'user', content: JSON.stringify(userPayload) }
                ],
                responseSchema,
                repairSchema: true
            });

            if (!result?.ok) {
                return {
                    ok: false,
                    route: 'none',
                    candidate: null,
                    reason: result?.reason || 'router_provider_error',
                    telemetry: result?.telemetry || null
                };
            }

            return {
                ...normalizeData(result.data, candidates, group),
                telemetry: result.telemetry || null,
                usage: result.usage || null
            };
        },
        'chain'
    );
}

module.exports = {
    ROUTER_MAX_TOKENS,
    ROUTER_SCHEMA,
    ROUTER_TEMPERATURE,
    config,
    enabled,
    route
};
