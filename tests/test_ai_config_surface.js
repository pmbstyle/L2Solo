const assert = require('assert');

require('../src/Global');

const OpenRouterGateway = invoke('GameServer/Bot/AI/OpenRouterGateway');
const LangfuseTracing = invoke('GameServer/Bot/AI/LangfuseTracing');

const originalOpenRouter = options.default.OpenRouter;
const originalAI = options.default.AI;
const originalLangfuse = options.default.Langfuse;

try {
    assert.strictEqual(OpenRouterGateway.DEFAULTS.model, '');
    assert.strictEqual(OpenRouterGateway.DEFAULTS.reasoningEffort, 'off');
    assert.strictEqual(OpenRouterGateway.DEFAULTS.temperature, null);
    assert.strictEqual(OpenRouterGateway.DEFAULTS.partyRouterModel, '');
    assert.strictEqual(OpenRouterGateway.DEFAULTS.apiUrl, OpenRouterGateway.OPENROUTER_URL);

    // Do not let a developer-local [AI] section change the OpenRouter fixture.
    options.default.AI = undefined;
    options.default.OpenRouter = {
        enabled: true,
        apiKey: 'config-test-key',
        model: 'test/config-model',
        temperature: 0.7,
        reasoningEffort: 'off',
        completionLimitParam: 'max_tokens',
        strictSchema: true,
        providerOrder: 'OpenAI, Anthropic',
        providerSort: 'price',
        allowFallbacks: false,
        requireParameters: false,
        maxConcurrentRequests: 7,
        debug: true,

        // Removed keys must not silently remain user-facing overrides.
        maxTokens: 1,
        timeoutMs: 1,
        backgroundInferenceEnabled: true,
        negotiationEnabled: true,
        hotBotGlobalMaxInFlight: 1
    };
    const openRouter = OpenRouterGateway.config();
    assert.strictEqual(openRouter.enabled, true);
    assert.strictEqual(openRouter.model, 'test/config-model');
    assert.strictEqual(openRouter.temperature, 0.7);
    assert.strictEqual(openRouter.reasoningEffort, 'off');
    assert.strictEqual(openRouter.completionLimitParam, 'max_tokens');
    assert.strictEqual(openRouter.strictSchema, true);
    assert.deepStrictEqual(openRouter.providerOrder, ['OpenAI', 'Anthropic']);
    assert.strictEqual(openRouter.providerSort, 'price');
    assert.strictEqual(openRouter.allowFallbacks, false);
    assert.strictEqual(openRouter.requireParameters, false);
    assert.strictEqual(openRouter.maxConcurrentRequests, 7);
    assert.strictEqual(openRouter.partyRouterModel, 'test/config-model', 'party routing reuses the configured model by default');
    assert.strictEqual(openRouter.maxTokens, 320, 'completion safety belongs to internal policy');
    assert.strictEqual(openRouter.timeoutMs, 3500, 'provider timeout belongs to internal policy');
    assert.strictEqual(openRouter.backgroundInferenceEnabled, undefined);
    assert.strictEqual(openRouter.negotiationEnabled, undefined);
    assert.strictEqual(openRouter.hotBotGlobalMaxInFlight, undefined);

    options.default.AI = {
        enabled: true,
        apiUrl: 'http://127.0.0.1:1234/v1/chat/completions',
        apiKey: '',
        model: 'local-model'
    };
    const local = OpenRouterGateway.config();
    assert.strictEqual(local.provider, 'openai-compatible');
    assert.strictEqual(local.apiUrl, 'http://127.0.0.1:1234/v1/chat/completions');
    assert.strictEqual(local.model, 'local-model');
    assert.strictEqual(local.temperature, null);
    assert.strictEqual(local.completionLimitParam, 'max_tokens');
    assert.strictEqual(local.strictSchema, false);
    assert.strictEqual(local.reasoningEffort, 'off', 'custom providers should disable optional thinking by default');
    assert.strictEqual(local.partyRouterModel, 'local-model', 'a custom provider should reuse its model for party routing by default');
    assert.strictEqual(OpenRouterGateway.isConfigured(local), true, 'local OpenAI-compatible endpoints may omit an API key');

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
    options.default.AI = originalAI;
    options.default.Langfuse = originalLangfuse;
}
