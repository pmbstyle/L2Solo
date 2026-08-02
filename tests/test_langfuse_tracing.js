const assert = require('assert');

require('../src/Global');

const LangfuseTracing = invoke('GameServer/Bot/AI/LangfuseTracing');

function main() {
    assert.deepStrictEqual(
        LangfuseTracing.observationStatus({ ok: false, reason: 'schema_error' }),
        { level: 'ERROR', statusMessage: 'schema_error' }
    );
    assert.deepStrictEqual(
        LangfuseTracing.observationStatus({ ok: true, applied: false, reason: 'stale_world_state' }),
        { level: 'WARNING', statusMessage: 'stale_world_state' }
    );
    assert.deepStrictEqual(
        LangfuseTracing.observationStatus({ ok: true, applied: true, reason: 'say' }),
        {}
    );
    assert.deepStrictEqual(
        LangfuseTracing.observationStatus({ outcome: 'provider_error' }),
        { level: 'ERROR', statusMessage: 'provider_error' }
    );
    console.log('Langfuse tracing checks passed');
}

try {
    main();
} catch (error) {
    console.error(error);
    process.exitCode = 1;
}
