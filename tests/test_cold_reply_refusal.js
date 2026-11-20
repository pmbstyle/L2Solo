// A worker fault that names a request ends that request's waiter on main at once,
// as its timeout would; a fault that names nothing known changes no waiter.
const assert = require('assert');

require('../src/Global');

const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
const { ColdSimulationCoordinator } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');

function coordinator(payloadFor) {
    const c = new ColdSimulationCoordinator();
    c.workerEpoch = 'reply-refusal';
    c.ready = true;
    c.worker = { terminate: async () => {}, postMessage(message) {
        if (message.type !== 'fence') return;
        setImmediate(() => c.onMessage(Protocol.envelope('fault', message.workerEpoch, payloadFor(message)), c.worker, c.workerEpoch));
    } };
    return c;
}

async function timed(c, characterId, timeoutMs) {
    const started = Date.now();
    const result = await c.fenceBot(characterId, timeoutMs);
    return { result, elapsed: Date.now() - started };
}

(async () => {
    // The worker's own validator refused the reply: the fence ends with that reason, not at its timeout.
    let c = coordinator(message => ({ reason: 'out_fence_ack_message_too_large', bytes: 300000, msgId: message.msgId }));
    let run = await timed(c, 9001, 3000);
    assert.strictEqual(run.result.ok, false);
    assert.strictEqual(run.result.reason, 'out_fence_ack_message_too_large');
    assert(run.elapsed < 1000, `fence ended at once, took ${run.elapsed} ms`);
    assert.strictEqual(c.failures.protocolFaults, 1);

    // The worker refused the request itself (the shape of its arrival refusal).
    c = coordinator(message => ({ reason: 'invalid_payload', msgId: message.msgId }));
    run = await timed(c, 9001, 3000);
    assert.strictEqual(run.result.reason, 'invalid_payload');
    assert(run.elapsed < 1000, `refused request ended at once, took ${run.elapsed} ms`);

    // A fault naming no request, or an unknown one, leaves the waiter to its timeout; each is still counted.
    for (const msgId of [null, 'unknown-request']) {
        c = coordinator(() => ({ reason: 'invalid_payload', msgId }));
        run = await timed(c, 9002, 100);
        assert.strictEqual(run.result.reason, 'cold_worker_fence_timeout');
        assert.strictEqual(c.failures.protocolFaults, 1);
    }
    console.log('test_cold_reply_refusal: PASS');
    process.exit(process.exitCode || 0);
})().catch(error => { console.error(error); process.exit(1); });
