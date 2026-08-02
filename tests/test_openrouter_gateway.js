const assert = require('assert');

require('../src/Global');

const OpenRouterGateway = invoke('GameServer/Bot/AI/OpenRouterGateway');

function response(body, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body
    };
}

const baseConfig = {
    enabled: true,
    apiKey: 'test-key',
    model: 'test/model',
    timeoutMs: 1000,
    circuitBreakerFailureThreshold: 3,
    circuitBreakerOpenMs: 5000
};

const schema = {
    name: 'gateway_test',
    schema: {
        type: 'object',
        properties: { reply: { type: 'string' } },
        required: ['reply'],
        additionalProperties: false
    }
};

async function main() {
    try {
    OpenRouterGateway.resetMetrics();
    OpenRouterGateway.resetCircuit();

    let captured;
    OpenRouterGateway.setTransport(async (_url, init) => {
        captured = {
            headers: init.headers,
            body: JSON.parse(init.body)
        };
        return response({
            choices: [{ message: { content: JSON.stringify({ reply: 'hello' }) } }],
            usage: {
                prompt_tokens: 10,
                completion_tokens: 3,
                total_tokens: 13,
                prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 5 },
                cost: 0.01
            }
        });
    });

    const success = await OpenRouterGateway.request({
        config: baseConfig,
        requestId: 'gateway-success',
        sessionId: 'hot-bot:1:player:2',
        messages: [{ role: 'user', content: 'hello' }],
        responseSchema: schema
    });

    assert.strictEqual(success.ok, true);
    assert.deepStrictEqual(success.data, { reply: 'hello' });
    assert.deepStrictEqual(success.usage, {
        promptTokens: 10,
        completionTokens: 3,
        totalTokens: 13,
        cachedPromptTokens: 4,
        cacheWriteTokens: 5,
        cost: 0.01
    });
    assert.strictEqual(success.telemetry.requestId, 'gateway-success');
    assert.strictEqual(success.telemetry.sessionId, 'hot-bot:1:player:2');
    assert.strictEqual(captured.headers.Authorization, 'Bearer test-key');
    assert.strictEqual(captured.body.session_id, 'hot-bot:1:player:2');
    assert.deepStrictEqual(captured.body.usage, { include: true });
    assert.strictEqual(captured.body.provider.require_parameters, true);
    assert.strictEqual(captured.body.response_format.type, 'json_schema');
    assert.strictEqual(captured.body.response_format.json_schema.strict, true);
    assert.deepStrictEqual(captured.body.response_format.json_schema.schema, schema.schema);

    OpenRouterGateway.resetCircuit();
    OpenRouterGateway.setTransport(async () => response({ error: { message: 'unavailable' } }, 503));
    for (let index = 0; index < 3; index += 1) {
        const failed = await OpenRouterGateway.request({ config: baseConfig, requestId: `failure-${index}` });
        assert.strictEqual(failed.ok, false);
        assert.strictEqual(failed.reason, 'provider_error');
    }
    const circuitOpen = await OpenRouterGateway.request({ config: baseConfig, requestId: 'failure-circuit' });
    assert.strictEqual(circuitOpen.reason, 'circuit_open');

    OpenRouterGateway.resetCircuit();
    OpenRouterGateway.setTransport(async () => response({ error: { message: 'hot unavailable' } }, 503));
    for (let index = 0; index < 3; index += 1) {
        await OpenRouterGateway.request({
            config: { ...baseConfig, circuitBreakerFailureThreshold: 3 },
            circuitKey: 'hot',
            requestId: `hot-failure-${index}`,
            messages: []
        });
    }
    OpenRouterGateway.setTransport(async () => response({
        choices: [{ message: { content: JSON.stringify({ reply: 'cold is still available' }) } }]
    }));
    const coldScope = await OpenRouterGateway.request({
        config: baseConfig,
        circuitKey: 'cold',
        requestId: 'cold-scope',
        messages: []
    });
    assert.strictEqual(coldScope.ok, true, 'hot failures must not change cold chat circuit behavior');

    OpenRouterGateway.resetCircuit();
    OpenRouterGateway.setTransport(async () => response({
        choices: [{ message: { content: JSON.stringify({ reply: 'no usage' }) } }]
    }));
    const noUsage = await OpenRouterGateway.request({ config: baseConfig, requestId: 'missing-usage' });
    assert.strictEqual(noUsage.ok, true);
    assert.strictEqual(noUsage.usage, null, 'missing provider usage must remain an explicit null');
    assert.strictEqual(noUsage.telemetry.usage, null);

    OpenRouterGateway.resetCircuit();
    OpenRouterGateway.setTransport((_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
            const error = new Error('aborted by timeout');
            error.name = 'AbortError';
            reject(error);
        }, { once: true });
    }));
    const timedOut = await OpenRouterGateway.request({
        config: { ...baseConfig, timeoutMs: 5, circuitBreakerFailureThreshold: 10 },
        requestId: 'timeout'
    });
    assert.strictEqual(timedOut.reason, 'timeout');

    OpenRouterGateway.resetCircuit();
    let interactiveSignalAborted = false;
    OpenRouterGateway.setTransport(async (_url, init) => {
        init.signal.addEventListener('abort', () => { interactiveSignalAborted = true; }, { once: true });
        await new Promise((resolve) => setTimeout(resolve, 20));
        return response({ choices: [{ message: { content: JSON.stringify({ reply: 'no artificial timeout' }) } }] });
    });
    const interactive = await OpenRouterGateway.request({
        config: { ...baseConfig, timeoutMs: 0 },
        circuitKey: 'interactive-bot:1:player:2',
        circuitBreaker: false,
        requestId: 'interactive-no-timeout'
    });
    assert.strictEqual(interactive.ok, true, 'interactive chat must wait for the provider instead of timing out locally');
    assert.strictEqual(interactiveSignalAborted, false, 'interactive chat must not abort the provider request');

    OpenRouterGateway.resetCircuit();
    OpenRouterGateway.setTransport(async () => response({ error: { message: 'background failure' } }, 503));
    for (let index = 0; index < 3; index += 1) {
        await OpenRouterGateway.request({ config: baseConfig, circuitKey: 'background', requestId: `background-failure-${index}` });
    }
    OpenRouterGateway.setTransport(async () => response({ choices: [{ message: { content: JSON.stringify({ reply: 'interactive recovered' }) } }] }));
    const circuitBypass = await OpenRouterGateway.request({
        config: baseConfig,
        circuitKey: 'background',
        circuitBreaker: false,
        requestId: 'interactive-circuit-bypass'
    });
    assert.strictEqual(circuitBypass.ok, true, 'interactive chat must not inherit a background circuit breaker');

    OpenRouterGateway.resetCircuit();
    OpenRouterGateway.setTransport(async () => response({
        choices: [{ message: { content: '{not-json' } }]
    }));
    const invalid = await OpenRouterGateway.request({ config: baseConfig, requestId: 'schema-error' });
    assert.strictEqual(invalid.reason, 'schema_error');

    OpenRouterGateway.setTransport(async () => {
        throw new Error('transport should not be called');
    });
    const disabled = await OpenRouterGateway.request({
        config: { ...baseConfig, enabled: false },
        requestId: 'disabled'
    });
    assert.strictEqual(disabled.reason, 'disabled');
    const missingKey = await OpenRouterGateway.request({
        config: { ...baseConfig, apiKey: '' },
        requestId: 'missing-key'
    });
    assert.strictEqual(missingKey.reason, 'missing_api_key');

    const metrics = OpenRouterGateway.metrics();
    assert.ok(metrics.success >= 1);
    assert.ok(metrics.timeout >= 1);
    assert.ok(metrics.providerError >= 3);
    assert.ok(metrics.schemaError >= 1);
    assert.ok(metrics.circuitOpen >= 1);

    console.log('OpenRouter gateway checks passed');
    } finally {
        OpenRouterGateway.resetTransport();
        OpenRouterGateway.resetCircuit();
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
