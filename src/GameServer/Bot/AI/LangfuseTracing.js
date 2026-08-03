const fs = require('fs');
const path = require('path');

let sdk = null;
let processor = null;
let tracing = null;
let initialized = false;
let initError = null;
let envCache = { filename: null, values: {} };
let otelContext = null;
let rootContext = null;

function bool(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function text(value, max = 240) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function parseEnvFile(filename) {
    if (!filename) return {};
    if (envCache.filename === String(filename)) return envCache.values;
    try {
        const absolute = path.resolve(String(filename));
        if (!fs.existsSync(absolute)) {
            envCache = { filename: String(filename), values: {} };
            return envCache.values;
        }
        const values = Object.fromEntries(fs.readFileSync(absolute, 'utf8')
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line && !line.startsWith('#'))
            .map((line) => {
                const index = line.indexOf('=');
                if (index < 1) return null;
                const key = line.slice(0, index).trim();
                let value = line.slice(index + 1).trim();
                if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
                    value = value.slice(1, -1);
                }
                return [key, value];
            })
            .filter(Boolean));
        envCache = { filename: String(filename), values };
        return values;
    } catch (_) {
        return {};
    }
}

function config(overrides = {}) {
    const option = options.default.Langfuse || {};
    const fileEnv = parseEnvFile(option.envFile);
    const value = (key, fallback = '') => process.env[key] || fileEnv[key] || fallback;
    const source = {
        enabled: bool(process.env.LANGFUSE_ENABLED || option.enabled, false),
        envFile: String(option.envFile || ''),
        baseUrl: value('LANGFUSE_BASE_URL', option.baseUrl || 'http://localhost:3000'),
        publicKey: value('LANGFUSE_PUBLIC_KEY') || value('LANGFUSE_INIT_PROJECT_PUBLIC_KEY'),
        secretKey: value('LANGFUSE_SECRET_KEY') || value('LANGFUSE_INIT_PROJECT_SECRET_KEY'),
        environment: value('LANGFUSE_TRACING_ENVIRONMENT', 'development'),
        release: value('LANGFUSE_RELEASE', utils.buildNumber?.() || 'nodel2'),
        serviceName: text(process.env.OTEL_SERVICE_NAME || fileEnv.OTEL_SERVICE_NAME || 'nodel2', 80),
        flushAt: 1,
        flushInterval: 1,
        capturePayloads: bool(process.env.LANGFUSE_CAPTURE_PAYLOADS || option.capturePayloads, true),
        debug: bool(option.debug, false)
    };
    return {
        ...source,
        ...overrides,
        enabled: bool(overrides.enabled, source.enabled),
        baseUrl: overrides.baseUrl || source.baseUrl,
        publicKey: overrides.publicKey || source.publicKey,
        secretKey: overrides.secretKey || source.secretKey,
        capturePayloads: bool(overrides.capturePayloads, source.capturePayloads)
    };
}

function serializable(value, limit = 24000) {
    try {
        const raw = JSON.stringify(value ?? null);
        return raw.length > limit ? `${raw.slice(0, limit)}…` : value;
    } catch (_) {
        return text(value, limit);
    }
}

function observationInput(value, cfg) {
    if (cfg.capturePayloads) return serializable(value);
    return { captured: false, type: typeof value };
}

function observationOutput(value, cfg) {
    if (cfg.capturePayloads) return serializable(value);
    return { captured: false, type: typeof value };
}

function observationStatus(value) {
    const telemetry = value?.llmTelemetry || value?.telemetry || {};
    const outcome = String(
        value?.traceOutcome || value?.outcome || value?.reason || telemetry.outcome || ''
    ).toLowerCase();
    const reason = String(value?.actionResult?.reason || '').toLowerCase();

    if (outcome === 'stale_world_state' || reason === 'stale_world_state') {
        return {
            level: 'WARNING',
            statusMessage: text(value?.reason || reason || outcome || 'action_rejected', 240)
        };
    }
    if (value?.ok === false || [
        'schema_error', 'output_truncated', 'provider_error', 'timeout', 'circuit_open', 'missing_api_key',
        'disabled', 'transport_error'
    ].includes(outcome)) {
        return {
            level: 'ERROR',
            statusMessage: text(value?.reason || telemetry.statusMessage || outcome || 'failed', 240)
        };
    }
    if (value?.applied === false || value?.actionResult?.ok === false) {
        return {
            level: 'WARNING',
            statusMessage: text(value?.reason || reason || outcome || 'action_rejected', 240)
        };
    }
    return {};
}

function traceOutput(value) {
    return value?.traceOutput === undefined ? value : value.traceOutput;
}

function updateObservation(observation, attributes) {
    if (typeof observation?.update === 'function') observation.update(attributes);
}

function init(overrides = {}) {
    if (initialized) return status();
    const cfg = config(overrides);
    if (!cfg.enabled) return status();
    if (!cfg.publicKey || !cfg.secretKey) {
        initError = 'missing_credentials';
        if (cfg.debug) utils.infoWarn('Langfuse', 'enabled but credentials are missing');
        return status();
    }

    try {
        const { NodeSDK } = require('@opentelemetry/sdk-node');
        const { LangfuseSpanProcessor } = require('@langfuse/otel');
        const api = require('@opentelemetry/api');
        otelContext = api.context;
        rootContext = api.ROOT_CONTEXT;
        tracing = require('@langfuse/tracing');
        processor = new LangfuseSpanProcessor({
            publicKey: cfg.publicKey,
            secretKey: cfg.secretKey,
            baseUrl: cfg.baseUrl,
            flushAt: cfg.flushAt,
            flushInterval: cfg.flushInterval,
            environment: cfg.environment,
            release: cfg.release,
            exportMode: 'batched'
        });
        sdk = new NodeSDK({
            serviceName: cfg.serviceName,
            spanProcessors: [processor]
        });
        sdk.start();
        initialized = true;
        if (cfg.debug) utils.infoSuccess('Langfuse', 'tracing enabled at %s', cfg.baseUrl);
    } catch (error) {
        initError = text(error.message, 240);
        initialized = false;
        if (cfg.debug) utils.infoWarn('Langfuse', 'initialization failed: %s', initError);
    }
    return status();
}

function status() {
    const cfg = config();
    return {
        configured: !!(cfg.publicKey && cfg.secretKey),
        enabled: cfg.enabled,
        initialized,
        baseUrl: cfg.baseUrl,
        error: initError
    };
}

function withObservation(name, input, metadata, work, asType = 'span') {
    const cfg = config();
    if (!initialized || !tracing?.startActiveObservation) return work(null);
    return tracing.startActiveObservation(String(name), async (observation) => {
        try {
            tracing.propagateAttributes?.({
                userId: text(metadata?.playerId, 200) || undefined,
                sessionId: text(metadata?.sessionId || metadata?.turnId, 200) || undefined,
                traceName: text(name, 200),
                metadata: Object.fromEntries(Object.entries(metadata || {})
                    .filter(([, value]) => value !== undefined && value !== null)
                    .map(([key, value]) => [key, text(value, 200)]))
            });
        } catch (_) {
            // Propagation is auxiliary; an invalid dimension must never block a turn.
        }
        updateObservation(observation, { input: observationInput(input, cfg), metadata: serializable(metadata || {}) });
        try {
            const result = await work(observation);
            updateObservation(observation, {
                output: observationOutput(traceOutput(result), cfg),
                ...observationStatus(result)
            });
            return result;
        } catch (error) {
            updateObservation(observation, {
                level: 'ERROR',
                statusMessage: text(error.message, 240),
                output: observationOutput({ error: error.message }, cfg)
            });
            throw error;
        }
    }, { asType, endOnExit: true });
}

function withRootObservation(name, input, metadata, work, asType = 'span') {
    if (!otelContext?.with || !rootContext) return withObservation(name, input, metadata, work, asType);
    return otelContext.with(rootContext, () => withObservation(name, input, metadata, work, asType));
}

function startObservation(name, input, metadata, asType = 'span') {
    if (!initialized || !tracing?.startObservation) return null;
    const cfg = config();
    try {
        const observation = tracing.startObservation(String(name), {
            input: observationInput(input, cfg),
            metadata: serializable(metadata || {})
        }, { asType });
        return {
            update(value = {}) {
                updateObservation(observation, {
                    ...value,
                    output: value.output === undefined ? undefined : observationOutput(value.output, cfg)
                });
            },
            end(value, status = {}) {
                const attributes = {};
                if (value !== undefined) attributes.output = observationOutput(value, cfg);
                if (status.level) attributes.level = status.level;
                if (status.statusMessage) attributes.statusMessage = text(status.statusMessage, 240);
                if (Object.keys(attributes).length > 0) observation.update(attributes);
                observation.end();
            },
            traceId: observation.traceId,
            id: observation.id
        };
    } catch (_) {
        return null;
    }
}

function activeTraceId() {
    try { return tracing?.getActiveTraceId?.() || null; } catch (_) { return null; }
}

async function shutdown() {
    if (!sdk) return;
    try { await sdk.shutdown(); } catch (error) {
        if (config().debug) utils.infoWarn('Langfuse', 'shutdown failed: %s', error.message);
    } finally {
        sdk = null;
        processor = null;
        initialized = false;
    }
}

module.exports = {
    config,
    init,
    status,
    withObservation,
    withRootObservation,
    startObservation,
    observationStatus,
    activeTraceId,
    shutdown
};
