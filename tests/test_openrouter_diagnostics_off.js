'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const Gateway = invoke('GameServer/Bot/AI/OpenRouterGateway');
const cfg = { enabled: true, apiKey: 'fixture', apiUrl: Gateway.OPENROUTER_URL, model: 'fixture', timeoutMs: 1000 };
const spec = { config: cfg, requestId: 'fixture-operation', sessionId: 'fixture-session', circuitBreaker: false,
    messages: [{ role: 'user', content: 'fixture' }] };
async function run() {
    const originalNow = Date.now;
    let clocks = 0;
    Gateway.setTransport(async () => ({ ok: true, json: async () => ({
        choices: [{ message: { content: '{"reply":"hello"}' } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
    }) }));
    try {
        Config.developerDiagnostics = false;
        Date.now = () => { clocks++; return 100; };
        const off = await Gateway.request(spec);
        assert.equal(clocks, 0, 'success with explicit identity needs no diagnostic clocks');
        assert.equal(off.telemetry.requestId, spec.requestId);
        assert.equal(off.telemetry.latencyMs, undefined); assert.equal(off.telemetry.rawContent, undefined);
        assert.equal(off.usage.totalTokens, 5); assert.deepEqual(Gateway.metrics(), { enabled: false });
        Config.developerDiagnostics = true;
        const on = await Gateway.request(spec);
        assert.deepEqual(on.data, off.data); assert.deepEqual(on.usage, off.usage);
        assert.equal(clocks, 3, 'start, duration and diagnostic record timestamp only on');
        assert.equal(on.telemetry.rawContent, '{"reply":"hello"}');
        assert.equal(on.telemetry.latencyMs, 0);
    } finally { Date.now = originalNow; Gateway.resetTransport(); Gateway.resetMetrics(); }
    console.log('OpenRouter diagnostics: no off clocks/raw copy/metric snapshot; identity, usage and output preserved');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
