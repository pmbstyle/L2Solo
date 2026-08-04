const assert = require('assert');

require('../src/Global');

const OpenRouterGateway = invoke('GameServer/Bot/AI/OpenRouterGateway');
const LangfuseTracing = invoke('GameServer/Bot/AI/LangfuseTracing');

const originalOpenRouter = options.default.OpenRouter;
const originalLangfuse = options.default.Langfuse;

try {
    assert.strictEqual(OpenRouterGateway.DEFAULTS.model, 'openai/gpt-5.6-luna');
    assert.strictEqual(OpenRouterGateway.DEFAULTS.reasoningEffort, 'low');
    assert.strictEqual(OpenRouterGateway.DEFAULTS.temperature, 0.35);
    assert.strictEqual(OpenRouterGateway.DEFAULTS.partyRouterModel, '');

    options.default.OpenRouter = {
        enabled: true,
        apiKey: 'config-test-key',
        model: 'test/config-model',
        temperature: 0.7,
        reasoningEffort: 'off',
        maxConcurrentRequests: 7,
        debug: true,

        // Removed keys must not silently remain user-facing overrides.
        maxTokens: 1,
        timeoutMs: 1,
        backgroundInferenceEnabled: true,
        hotBotGlobalMaxInFlight: 1
    };
    const openRouter = OpenRouterGateway.config();
    assert.strictEqual(openRouter.enabled, true);
    assert.strictEqual(openRouter.model, 'test/config-model');
    assert.strictEqual(openRouter.temperature, 0.7);
    assert.strictEqual(openRouter.reasoningEffort, 'off');
    assert.strictEqual(openRouter.maxConcurrentRequests, 7);
    assert.strictEqual(openRouter.partyRouterModel, '', 'party routing remains deterministic unless explicitly configured');
    assert.strictEqual(openRouter.maxTokens, 320, 'completion safety belongs to internal policy');
    assert.strictEqual(openRouter.timeoutMs, 3500, 'provider timeout belongs to internal policy');
    assert.strictEqual(openRouter.backgroundInferenceEnabled, undefined);
    assert.strictEqual(openRouter.hotBotGlobalMaxInFlight, undefined);

    options.default.Langfuse = {
        enabled: true,
        envFile: '',
        baseUrl: 'http://127.0.0.1:3333',
        capturePayloads: false,
        debug: true,
        captureInput: true,
        captureOutput: true,
        flushAt: 99
    };
    const langfuse = LangfuseTracing.config();
    assert.strictEqual(langfuse.enabled, true);
    assert.strictEqual(langfuse.baseUrl, 'http://127.0.0.1:3333');
    assert.strictEqual(langfuse.capturePayloads, false);
    assert.strictEqual(langfuse.captureInput, undefined);
    assert.strictEqual(langfuse.captureOutput, undefined);
    assert.strictEqual(langfuse.flushAt, 1, 'dev trace flushing belongs to internal policy');

    console.log('AI config surface checks passed');
} finally {
    options.default.OpenRouter = originalOpenRouter;
    options.default.Langfuse = originalLangfuse;
}
