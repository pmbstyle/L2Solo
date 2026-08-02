const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const LangfuseTracing = invoke('GameServer/Bot/AI/LangfuseTracing');

const DEFAULTS = Object.freeze({
    enabled: false,
    apiKey: '',
    model: 'google/gemini-2.5-flash-lite',
    temperature: 0.35,
    maxTokens: 320,
    timeoutMs: 3500,
    cooldownMs: 45000,
    chatCooldownMs: 0,
    remoteChatCooldownMs: 10000,
    visibilityRadius: 6000,
    maxPromptPrice: 0,
    maxCompletionPrice: 0,
    usageInclude: true,
    requireProviderParameters: true,
    circuitBreakerFailureThreshold: 3,
    circuitBreakerOpenMs: 30000,
    hotBotBudgetEnabled: true,
    hotBotMaxRequestsPerMinute: 6,
    hotBotPromptTokenBudgetPerMinute: 12000,
    hotBotCompletionTokenBudgetPerMinute: 2400,
    debug: false
});

let transport = null;
let requestSequence = 0;
const circuits = new Map();

const metrics = {
    total: 0,
    success: 0,
    fallback: 0,
    timeout: 0,
    providerError: 0,
    schemaError: 0,
    disabled: 0,
    missingApiKey: 0,
    circuitOpen: 0,
    totalLatencyMs: 0,
    last: null
};

function bool(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function num(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function config(overrides = {}) {
    const optn = options.default.OpenRouter || {};
    const source = {
        ...DEFAULTS,
        enabled: bool(optn.enabled, DEFAULTS.enabled),
        apiKey: process.env.OPENROUTER_API_KEY || optn.apiKey || DEFAULTS.apiKey,
        model: process.env.OPENROUTER_MODEL || optn.model || DEFAULTS.model,
        temperature: num(optn.temperature, DEFAULTS.temperature),
        maxTokens: num(optn.maxTokens, DEFAULTS.maxTokens),
        timeoutMs: num(optn.timeoutMs, DEFAULTS.timeoutMs),
        cooldownMs: num(optn.cooldownMs, DEFAULTS.cooldownMs),
        chatCooldownMs: num(optn.chatCooldownMs, DEFAULTS.chatCooldownMs),
        remoteChatCooldownMs: num(optn.remoteChatCooldownMs, DEFAULTS.remoteChatCooldownMs),
        visibilityRadius: num(optn.visibilityRadius, DEFAULTS.visibilityRadius),
        maxPromptPrice: num(optn.maxPromptPrice, DEFAULTS.maxPromptPrice),
        maxCompletionPrice: num(optn.maxCompletionPrice, DEFAULTS.maxCompletionPrice),
        usageInclude: bool(optn.usageInclude, DEFAULTS.usageInclude),
        requireProviderParameters: bool(optn.requireProviderParameters, DEFAULTS.requireProviderParameters),
        circuitBreakerFailureThreshold: num(
            optn.circuitBreakerFailureThreshold,
            DEFAULTS.circuitBreakerFailureThreshold
        ),
        circuitBreakerOpenMs: num(optn.circuitBreakerOpenMs, DEFAULTS.circuitBreakerOpenMs),
        hotBotBudgetEnabled: bool(optn.hotBotBudgetEnabled, DEFAULTS.hotBotBudgetEnabled),
        hotBotMaxRequestsPerMinute: num(optn.hotBotMaxRequestsPerMinute, DEFAULTS.hotBotMaxRequestsPerMinute),
        hotBotPromptTokenBudgetPerMinute: num(optn.hotBotPromptTokenBudgetPerMinute, DEFAULTS.hotBotPromptTokenBudgetPerMinute),
        hotBotCompletionTokenBudgetPerMinute: num(optn.hotBotCompletionTokenBudgetPerMinute, DEFAULTS.hotBotCompletionTokenBudgetPerMinute),
        debug: bool(optn.debug, DEFAULTS.debug)
    };

    return {
        ...source,
        ...overrides,
        enabled: bool(overrides.enabled, source.enabled),
        apiKey: overrides.apiKey !== undefined ? String(overrides.apiKey || '') : source.apiKey,
        model: overrides.model || source.model,
        temperature: num(overrides.temperature, source.temperature),
        maxTokens: num(overrides.maxTokens, source.maxTokens),
        timeoutMs: num(overrides.timeoutMs, source.timeoutMs),
        maxPromptPrice: num(overrides.maxPromptPrice, source.maxPromptPrice),
        maxCompletionPrice: num(overrides.maxCompletionPrice, source.maxCompletionPrice),
        usageInclude: bool(overrides.usageInclude, source.usageInclude),
        requireProviderParameters: bool(
            overrides.requireProviderParameters,
            source.requireProviderParameters
        ),
        circuitBreakerFailureThreshold: Math.max(
            1,
            num(overrides.circuitBreakerFailureThreshold, source.circuitBreakerFailureThreshold)
        ),
        circuitBreakerOpenMs: Math.max(0, num(overrides.circuitBreakerOpenMs, source.circuitBreakerOpenMs)),
        hotBotBudgetEnabled: bool(overrides.hotBotBudgetEnabled, source.hotBotBudgetEnabled),
        hotBotMaxRequestsPerMinute: Math.max(1, num(overrides.hotBotMaxRequestsPerMinute, source.hotBotMaxRequestsPerMinute)),
        hotBotPromptTokenBudgetPerMinute: Math.max(240, num(overrides.hotBotPromptTokenBudgetPerMinute, source.hotBotPromptTokenBudgetPerMinute)),
        hotBotCompletionTokenBudgetPerMinute: Math.max(64, num(overrides.hotBotCompletionTokenBudgetPerMinute, source.hotBotCompletionTokenBudgetPerMinute)),
        debug: bool(overrides.debug, source.debug)
    };
}

function requestId(value) {
    if (value) return String(value).slice(0, 128);
    requestSequence += 1;
    return `or-${Date.now()}-${requestSequence}`;
}

function sessionId(value) {
    if (!value) return null;
    return String(value).slice(0, 256);
}

function providerOptions(cfg, extra = {}) {
    const provider = { ...extra };
    if (cfg.requireProviderParameters) provider.require_parameters = true;

    if (cfg.maxPromptPrice > 0 || cfg.maxCompletionPrice > 0) {
        provider.max_price = {
            ...(provider.max_price || {})
        };
        if (cfg.maxPromptPrice > 0) provider.max_price.prompt = cfg.maxPromptPrice;
        if (cfg.maxCompletionPrice > 0) provider.max_price.completion = cfg.maxCompletionPrice;
    }

    return Object.keys(provider).length > 0 ? provider : null;
}

function circuitState(key = 'default') {
    if (!circuits.has(key)) circuits.set(key, { failureStreak: 0, openedAt: 0 });
    return circuits.get(key);
}

function circuitIsOpen(cfg, key = 'default', now = Date.now()) {
    const state = circuitState(key);
    if (!state.openedAt) return false;
    if (now - state.openedAt >= cfg.circuitBreakerOpenMs) {
        state.openedAt = 0;
        state.failureStreak = 0;
        return false;
    }
    return true;
}

function recordMetric(outcome, latencyMs, meta = {}) {
    metrics.total += 1;
    if (outcome === 'success') metrics.success += 1;
    else metrics.fallback += 1;
    if (outcome === 'timeout') metrics.timeout += 1;
    if (outcome === 'provider_error') metrics.providerError += 1;
    if (outcome === 'schema_error') metrics.schemaError += 1;
    if (outcome === 'disabled') metrics.disabled += 1;
    if (outcome === 'missing_api_key') metrics.missingApiKey += 1;
    if (outcome === 'circuit_open') metrics.circuitOpen += 1;
    metrics.totalLatencyMs += Number(latencyMs || 0);
    metrics.last = {
        outcome,
        latencyMs: Number(latencyMs || 0),
        requestId: meta.requestId || null,
        model: meta.model || null,
        at: Date.now()
    };
}

function telemetry(request, cfg, outcome, startedAt, extra = {}) {
    return {
        requestId: request.requestId,
        sessionId: request.sessionId || null,
        circuitKey: request.circuitKey,
        model: cfg.model,
        outcome,
        latencyMs: Date.now() - startedAt,
        status: extra.status || null,
        usage: extra.usage || null,
        finishReason: extra.finishReason || null,
        providerRequestId: extra.providerRequestId || null,
        rawContent: extra.rawContent || null,
        responsePreview: extra.responsePreview || null
    };
}

function complete(request, cfg, outcome, startedAt, extra = {}) {
    const meta = telemetry(request, cfg, outcome, startedAt, extra);
    recordMetric(outcome, meta.latencyMs, meta);
    if (typeof request.onTelemetry === 'function') {
        try {
            request.onTelemetry(meta);
        } catch (err) {
            if (cfg.debug) utils.infoWarn('OpenRouter', 'telemetry callback failed: %s', err.message);
        }
    }

    return {
        ok: outcome === 'success',
        reason: outcome,
        data: extra.data || null,
        usage: extra.usage || null,
        telemetry: meta,
        status: extra.status || null
    };
}

function markFailure(cfg, key = 'default') {
    const state = circuitState(key);
    state.failureStreak += 1;
    if (state.failureStreak >= cfg.circuitBreakerFailureThreshold) {
        state.openedAt = Date.now();
    }
}

function markSuccess(key = 'default') {
    const state = circuitState(key);
    state.failureStreak = 0;
    state.openedAt = 0;
}

function normalizeUsage(usage) {
    if (!usage || typeof usage !== 'object') return null;
    return {
        promptTokens: Number(usage.prompt_tokens || 0),
        completionTokens: Number(usage.completion_tokens || 0),
        totalTokens: Number(usage.total_tokens || 0),
        cachedPromptTokens: Number(usage.prompt_tokens_details?.cached_tokens || 0),
        cacheWriteTokens: Number(usage.prompt_tokens_details?.cache_write_tokens || 0),
        cost: Number.isFinite(Number(usage.cost)) ? Number(usage.cost) : null
    };
}

function parseContent(content) {
    if (content && typeof content === 'object') return content;
    if (typeof content !== 'string' || !content.trim()) return null;
    return JSON.parse(content);
}

function validateContent(data, responseSchema) {
    if (!responseSchema?.schema) return null;
    try {
        const Validator = require('jsonschema').Validator;
        const validation = new Validator().validate(data, responseSchema.schema);
        if (validation.valid) return null;
        return validation.errors
            .slice(0, 4)
            .map((error) => `${error.property || 'response'}:${error.message}`)
            .join('; ')
            .slice(0, 480);
    } catch (error) {
        return `validator_error:${error.message}`.slice(0, 480);
    }
}

async function requestUntraced(spec = {}) {
    const cfg = config({
        ...(spec.config || {}),
        ...(spec.timeoutMs !== undefined ? { timeoutMs: spec.timeoutMs } : {})
    });
    const requestData = {
        ...spec,
        requestId: requestId(spec.requestId),
        sessionId: sessionId(spec.sessionId),
        circuitKey: String(spec.circuitKey || 'default').slice(0, 64)
    };
    const startedAt = Date.now();

    if (!cfg.enabled) return complete(requestData, cfg, 'disabled', startedAt);
    if (!cfg.apiKey) return complete(requestData, cfg, 'missing_api_key', startedAt);
    if (requestData.circuitBreaker !== false && circuitIsOpen(cfg, requestData.circuitKey)) {
        return complete(requestData, cfg, 'circuit_open', startedAt);
    }

    const fetcher = transport || global.fetch;
    if (typeof fetcher !== 'function') return complete(requestData, cfg, 'provider_error', startedAt);

    const controller = new AbortController();
    const timeout = cfg.timeoutMs > 0
        ? setTimeout(() => controller.abort(), Math.max(1, cfg.timeoutMs))
        : null;
    const body = {
        model: cfg.model,
        messages: Array.isArray(requestData.messages) ? requestData.messages : [],
        temperature: cfg.temperature,
        max_tokens: cfg.maxTokens
    };

    if (requestData.responseSchema) {
        body.response_format = {
            type: 'json_schema',
            json_schema: {
                name: requestData.responseSchema.name,
                strict: true,
                schema: requestData.responseSchema.schema
            }
        };
    }

    if (requestData.sessionId) body.session_id = requestData.sessionId;
    if (cfg.usageInclude) body.usage = { include: true };

    const provider = providerOptions(cfg, requestData.provider);
    if (provider) body.provider = provider;

    try {
        const response = await fetcher(requestData.url || OPENROUTER_URL, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${cfg.apiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': requestData.referer || 'http://localhost',
                'X-OpenRouter-Title': requestData.title || 'L2Node Bots'
            },
            body: JSON.stringify(body),
            signal: controller.signal
        });

        if (!response?.ok) {
            markFailure(cfg, requestData.circuitKey);
            return complete(requestData, cfg, 'provider_error', startedAt, {
                status: Number(response?.status || 0) || null,
                responsePreview: String(response?.statusText || '').slice(0, 240)
            });
        }

        const json = await response.json();
        const choice = json.choices?.[0] || {};
        const content = choice.message?.content;
        const finishReason = choice.finish_reason || null;
        const rawContent = typeof content === 'string' ? content.slice(0, 12000) : null;
        let data;
        try {
            data = parseContent(content);
        } catch (_) {
            markFailure(cfg, requestData.circuitKey);
            return complete(requestData, cfg, 'schema_error', startedAt, {
                usage: normalizeUsage(json.usage),
                finishReason,
                providerRequestId: json.id || null,
                rawContent,
                responsePreview: finishReason === 'length' ? 'provider_output_truncated' : null
            });
        }

        if (!data) {
            markFailure(cfg, requestData.circuitKey);
            return complete(requestData, cfg, 'schema_error', startedAt, {
                usage: normalizeUsage(json.usage),
                finishReason,
                providerRequestId: json.id || null,
                rawContent
            });
        }

        const validationError = validateContent(data, requestData.responseSchema);
        if (validationError) {
            markFailure(cfg, requestData.circuitKey);
            return complete(requestData, cfg, 'schema_error', startedAt, {
                usage: normalizeUsage(json.usage),
                finishReason,
                providerRequestId: json.id || null,
                rawContent,
                responsePreview: validationError
            });
        }

        markSuccess(requestData.circuitKey);
        return complete(requestData, cfg, 'success', startedAt, {
            data,
            usage: normalizeUsage(json.usage),
            finishReason,
            providerRequestId: json.id || null,
            rawContent
        });
    } catch (err) {
        const outcome = err?.name === 'AbortError' ? 'timeout' : 'provider_error';
        markFailure(cfg, requestData.circuitKey);
        return complete(requestData, cfg, outcome, startedAt);
    } finally {
        if (timeout) clearTimeout(timeout);
    }
}

async function request(spec = {}) {
    const input = {
        messages: spec.messages || [],
        responseSchema: spec.responseSchema?.name || null,
        model: spec.config?.model || config().model
    };
    const metadata = {
        requestId: spec.requestId || null,
        sessionId: spec.sessionId || null,
        circuitKey: spec.circuitKey || null,
        source: spec.source || 'openrouter',
        model: spec.config?.model || config().model,
        botId: spec.botId || null,
        playerId: spec.playerId || null,
        turnId: spec.turnId || null
    };
    return LangfuseTracing.withObservation(
        'openrouter.generation',
        input,
        metadata,
        async (observation) => {
            const result = await requestUntraced(spec);
            if (observation && result?.telemetry) {
                const usage = result.usage || result.telemetry.usage || {};
                observation.update({
                    model: result.telemetry.model || null,
                    modelParameters: {
                        temperature: Number((spec.config || {}).temperature ?? config().temperature),
                        max_tokens: Number((spec.config || {}).maxTokens ?? config().maxTokens)
                    },
                    usageDetails: {
                        input: Number(usage.promptTokens || 0),
                        output: Number(usage.completionTokens || 0),
                        total: Number(usage.totalTokens || 0)
                    },
                    costDetails: Number.isFinite(Number(usage.cost)) ? { total: Number(usage.cost) } : undefined,
                    metadata: {
                        outcome: result.telemetry.outcome,
                        status: result.telemetry.status,
                        finishReason: result.telemetry.finishReason
                    }
                });
                result.telemetry.traceId = observation.traceId || LangfuseTracing.activeTraceId();
                result.telemetry.observationId = observation.id || null;
            }
            return result;
        },
        'generation'
    );
}

const OpenRouterGateway = {
    OPENROUTER_URL,
    DEFAULTS,
    config,
    request,

    setTransport(nextTransport) {
        transport = typeof nextTransport === 'function' ? nextTransport : null;
    },

    resetTransport() {
        transport = null;
    },

    resetCircuit() {
        circuits.clear();
    },

    metrics() {
        return {
            ...metrics,
            averageLatencyMs: metrics.total > 0 ? metrics.totalLatencyMs / metrics.total : 0,
            circuits: Object.fromEntries([...circuits.entries()].map(([key, state]) => [key, { ...state }])),
            failureStreak: [...circuits.values()].reduce((sum, state) => sum + state.failureStreak, 0),
            circuitOpenedAt: [...circuits.values()].find((state) => state.openedAt)?.openedAt || 0
        };
    },

    resetMetrics() {
        Object.keys(metrics).forEach((key) => {
            if (key === 'last') metrics[key] = null;
            else metrics[key] = 0;
        });
    }
};

module.exports = OpenRouterGateway;
