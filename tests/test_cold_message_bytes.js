const assert = require('assert');

require('../src/Global');

const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
const { collectionPages, collectionPagesWithBytes, PAGE_BYTES } = require('../src/GameServer/Bot/Population/ColdMessagePages');
const { ColdSimulationCoordinator } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');

// A BigInt cannot be serialised, so a message carrying one only validates
// when the caller supplies its size instead of the protocol measuring it.
const unmeasurable = Protocol.envelope('drained', 'epoch', { marker: 1n });
assert.strictEqual(Protocol.validateEnvelope(unmeasurable, 'worker', { workerEpoch: 'epoch' }).reason, 'message_too_large');
assert.deepStrictEqual(Protocol.validateEnvelope(unmeasurable, 'worker', { workerEpoch: 'epoch', bytes: 1234 }), { ok: true, bytes: 1234 });
assert.strictEqual(Protocol.validateEnvelope(unmeasurable, 'worker', {
    workerEpoch: 'epoch', bytes: Protocol.MAX_MESSAGE_BYTES + 1
}).reason, 'message_too_large', 'a supplied size still enforces the message limit');
for (const bytes of [undefined, null, -1, NaN, '12']) {
    assert.strictEqual(Protocol.validateEnvelope(unmeasurable, 'worker', { workerEpoch: 'epoch', bytes }).reason,
        'message_too_large', `an unusable size (${String(bytes)}) falls back to measuring`);
}

// Page sizes counted while paging bound the final envelope, including a
// message ID generated at send time.
const rows = Array.from({ length: 130 }, (_, id) => ({ id, text: 'мир🙂'.repeat(900) }));
const sized = collectionPagesWithBytes('snapshot_page', 'test-epoch', { rows }, null);
assert.deepStrictEqual(sized.map((page) => page.payload), collectionPages('snapshot_page', 'test-epoch', { rows }, null));
assert(sized.length > 1, 'the fixture must span several pages');
for (const page of sized) {
    const actual = Protocol.byteLength(Protocol.envelope('snapshot_page', 'test-epoch', page.payload));
    assert(page.bytes >= actual, `counted ${page.bytes} must cover actual ${actual}`);
    assert(page.bytes <= PAGE_BYTES);
}

// The coordinator stamps the validated size on outgoing messages and trusts
// the size a worker stamped on incoming ones.
const posted = [];
const coordinator = new ColdSimulationCoordinator();
coordinator.worker = { postMessage: (message) => posted.push(message) };
coordinator.workerEpoch = 'test-epoch';

assert(coordinator.post('pause', { reason: 'test' }));
assert.strictEqual(posted[0].bytes, Protocol.byteLength({ ...posted[0], bytes: undefined }));
assert(coordinator.post('snapshot_page', { rows: [], done: false, initial: false }, null, 4321));
assert.strictEqual(posted[1].bytes, 4321);
assert.strictEqual(coordinator.counters.bytesOut, posted[0].bytes + 4321);

assert.strictEqual(coordinator.postCollections('claim_ack', { grants: rows.slice(0, 3), rejected: [] }), 1);
const claimAck = posted[2];
assert(claimAck.bytes >= Protocol.byteLength({ ...claimAck, bytes: undefined }),
    'a paged message carries its counted size');

(async () => {
    const incoming = Protocol.envelope('drained', 'test-epoch', { marker: 1n });
    incoming.bytes = 999;
    await coordinator.onMessage(incoming);
    assert.strictEqual(coordinator.counters.messagesIn, 1, 'a stamped message is accepted without re-serialising it');
    assert.strictEqual(coordinator.counters.bytesIn, 999);

    const unstamped = Protocol.envelope('drained', 'test-epoch', { marker: 1n });
    await coordinator.onMessage(unstamped);
    assert.strictEqual(coordinator.counters.messagesIn, 1, 'an unstamped message is still measured');
    assert.strictEqual(coordinator.counters.invalidReasons.in_message_too_large, 1);

    console.log('cold message size stamping tests passed');
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
