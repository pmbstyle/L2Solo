process.env.BOT_DEVELOPER_DIAGNOSTICS = 'true'; // This fixture inspects optional developer metrics.
const assert = require('assert');

require('../src/Global');

const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
const { collectionPages, collectionPagesWithBytes, PAGE_BYTES } = require('../src/GameServer/Bot/Population/ColdMessagePages');
const { ColdSimulationCoordinator } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');

// The counted size is the UTF-8 length of the value's JSON, so every page limit
// is checked against what the wire carries, without building the text.
const wire = (value) => Buffer.byteLength(JSON.stringify(value));
class Point { constructor() { this.x = 1; this.y = [2, 'z']; } }
const inherited = Object.create({ hidden: 1 });
inherited.own = 'own';
const quirky = Object.create(null);
Object.assign(quirky, { '"key"\n': 'q', 7: 7 });
const exact = [
    'plain', '', 'quote " back \\ slash /', 'tab\tline\nfeed\rbell\u0007nul\u0000\u001f\u007f', 'мир', 'Поляна🌲',
    '  ', 'lone \ud83d high', 'lone \ude00 low', 'pair 😀 end', 'x'.repeat(5000) + '🙂',
    0, -0, 7, -7, 9, 10, 99999, 100000, 1e15, 1e20, 1e21 - 2 ** 17, 1e21, -1e21, 2 ** 53 + 2, 0.1, -1.5e-7,
    1 / 3, 123.456, NaN, Infinity, -Infinity, Number.MIN_VALUE, Number.MAX_VALUE, true, false, null,
    [], {}, [undefined, () => 1, Symbol('s'), null], { a: undefined, b: () => 1, c: Symbol('s'), d: 1 }, [1, , 3], // eslint-disable-line no-sparse-arrays
    { 22: { selfId: 22, name: 'Leather Shirt', instances: [{ id: 4003347, amount: 1, equipped: true }] }, 57: { amount: 12345 } },
    new Date(1793742199937), { at: new Date(0) }, { toJSON: () => ({ replaced: 'yes' }) }, { toJSON: 5, other: 1 },
    [{ toJSON(key) { return `key:${key}`; } }], { field: { toJSON(key) { return key; } } }, new Map([[1, 2]]), new Set([1]),
    Uint8Array.from([1, 200, 3]), new Point(), inherited, quirky, Object.assign([1, 2], { extra: 3 }),
    new Number(5), new String('boxed'), new Boolean(false), Object.assign([1], { toJSON: () => 'array' }),
    JSON.parse(JSON.stringify(Array.from({ length: 100 }, () => 0).reduce((deep) => ({ deep }), { leaf: 'ä' }))),
    // A toJSON result is not passed to toJSON again; only Array.isArray values
    // with the Array prototype are arrays; a callable with a toJSON is called.
    { toJSON() { return this; } }, { a: { toJSON() { return this; }, b: 1 } }, { toJSON: () => new Date(0) },
    { toJSON: () => ({ toJSON: () => 'x', a: 1 }) }, new (class { constructor() { this.v = 1; } toJSON() { return this; } })(),
    Object.setPrototypeOf([1, 2], null), Object.assign(Object.create(Array.prototype), { a: 1 }),
    Object.assign(Object.create(Array.prototype), { length: 2 }), new Proxy([1, 2], { getPrototypeOf: () => Object.prototype }),
    { f: Object.assign(function () {}, { toJSON() { return 1; } }) }, [class { static toJSON() { return 'A'; } }]
];
for (const value of exact) {
    assert.strictEqual(Protocol.byteLength(value), wire(value), `size of ${String(JSON.stringify(value)).slice(0, 80)}`);
}
const cycle = { name: 'loop' };
cycle.self = { back: cycle };
for (const value of [undefined, () => 1, Symbol('s'), 1n, { big: 1n }, [1n], cycle]) {
    assert.strictEqual(Protocol.byteLength(value), Infinity, 'a value JSON cannot carry measures as too large');
}

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

// The result alone used to fit the 550-byte estimate, while the live epoch
// and generated message ID made the complete meeting packet exceed 768.
const meetingEpoch = 'cold-worker:41311:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const row = { kind: 'meeting', characterId: 2007221, commandId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    pageIndex: -1, ok: false, reason: 'trade_meeting_purchase_price_changed', priceEvidence: { padding: 'x'.repeat(335) } };
const tooLarge = Protocol.envelope('command_ack', meetingEpoch, { results: [row] });
assert(Protocol.byteLength(row) <= 550 && Protocol.byteLength(tooLarge) > 768);
assert.strictEqual(Protocol.validateEnvelope(tooLarge, 'worker', { workerEpoch: meetingEpoch }).reason, 'invalid_meeting_command');
const fallback = { source: 'current' };
const compact = Protocol.fitMeetingAck(tooLarge, fallback);
assert.deepStrictEqual(compact.payload.results[0].priceEvidence, fallback);
assert(Protocol.validateEnvelope(compact, 'worker', { workerEpoch: meetingEpoch }).ok);
const plain = Protocol.fitMeetingAck(tooLarge, { padding: 'x'.repeat(1000) });
assert.strictEqual(plain.payload.results[0].priceEvidence, undefined);
assert.strictEqual(plain.payload.results[0].reason, row.reason);
assert(Protocol.validateEnvelope(plain, 'worker', { workerEpoch: meetingEpoch }).ok);
assert.strictEqual(Protocol.fitMeetingAck(compact), compact, 'a fitting proof remains unchanged');
assert.strictEqual(tooLarge.payload.results[0], row, 'fitting does not mutate the prepared result');

// Page sizes counted while paging bound the final envelope, including a
// message ID generated at send time.
const rows = Array.from({ length: 130 }, (_, id) => ({ id, text: 'мир🙂'.repeat(900) }));
const sized = collectionPagesWithBytes('snapshot_page', 'test-epoch', { rows }, null);
assert.deepStrictEqual(sized.map((page) => page.payload), collectionPages('snapshot_page', 'test-epoch', { rows }, null));
assert(sized.length > 1, 'the fixture must span several pages');
for (const page of sized) {
    const actual = wire(Protocol.envelope('snapshot_page', 'test-epoch', page.payload));
    assert(page.bytes >= actual, `counted ${page.bytes} must cover actual ${actual}`);
    assert(page.bytes <= PAGE_BYTES);
}
// Bot-state rows (~19 KB, a bag keyed by item ids) split by bytes before the
// row cap, and every page's wire JSON stays within the page budget.
const stateRow = (id) => ({ state: { characterId: id, name: `Бот${id}`, loc: { locX: -71000 + id, locY: 258000, locZ: -3100 },
    stats: { coldCombat: { version: 7, skills: Array.from({ length: 40 }, (_, s) => ({ selfId: 100 + s, level: 1 + s % 9,
        passive: s % 3 === 0, power: s * 1.25, reuse: 13000, hitTime: 1080 })) }, wishFocus: { score: id / 7, spotId: `spot_${id}` } },
    inventory: Object.fromEntries(Array.from({ length: 60 }, (_, item) => [100 + item * 37, { selfId: 100 + item * 37,
        name: 'Leather Shirt', amount: 1 + item, equipped: item % 5 === 0, instances: [{ id: 4000000 + id * 100 + item, amount: 1, enchant: 0 }] }])) } });
const stateRows = Array.from({ length: 64 }, (_, id) => stateRow(id + 1));
const statePages = collectionPagesWithBytes('commit_ack', 'test-epoch', { results: stateRows }, null);
assert(statePages.length > 1 && statePages.every(page => page.payload.results.length < Protocol.MAX_BATCH),
    'state rows fill a page by bytes before the row cap');
assert.deepStrictEqual(statePages.flatMap(page => page.payload.results), stateRows, 'every state row is sent once, in order');
for (const page of statePages) {
    const actual = wire(Protocol.envelope('commit_ack', 'test-epoch', page.payload));
    assert(actual <= page.bytes && page.bytes <= PAGE_BYTES, `state page ${actual} within counted ${page.bytes} and the budget`);
}

// The coordinator stamps the validated size on outgoing messages and trusts
// the size a worker stamped on incoming ones.
const posted = [];
const coordinator = new ColdSimulationCoordinator();
coordinator.worker = { postMessage: (message) => posted.push(message) };
coordinator.workerEpoch = 'test-epoch';
coordinator.ready = true;

assert(coordinator.post('pause', { reason: 'test' }));
assert.strictEqual(posted[0].bytes, Protocol.byteLength({ ...posted[0], bytes: undefined }));
assert(coordinator.post('snapshot_page', { rows: [], done: false, initial: false }, null, 4321));
assert.strictEqual(posted[1].bytes, 4321);
assert.strictEqual(coordinator.counters.bytesOut, posted[0].bytes + 4321);

assert.strictEqual(coordinator.postCollections('command_ack', { results: rows.slice(0, 3) }), 1);
const pagedAck = posted[2];
assert(pagedAck.bytes >= Protocol.byteLength({ ...pagedAck, bytes: undefined }),
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
