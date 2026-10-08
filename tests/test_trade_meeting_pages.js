'use strict';
const assert = require('node:assert/strict');
const Codec = require('../src/GameServer/AfkTrade/TradeMeetingCodec');
const Native = require('../src/GameServer/AfkTrade/TradeMeeting');
const Service = require('../src/GameServer/AfkTrade/TradeMeetingService');
const small = Native.projectIncoming({ 1867: 6 });
assert.deepEqual(small, { acceptedIncoming: { 1867: 6 } });
const wide = Native.projectIncoming({ 1867: Number.MAX_SAFE_INTEGER, 1870: Number.MAX_SAFE_INTEGER });
assert(Buffer.byteLength(JSON.stringify({ tradeMeeting: [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER], ...wide })) <= 128);
const large = Native.projectIncoming(Object.fromEntries(Array.from({ length: 5 }, (_, index) => [1860 + index, Number.MAX_SAFE_INTEGER])));
assert.deepEqual(large, { acceptedIncoming: null, incomingPending: true }, 'overflow is unknown input with a pending owner, never truncated stock');
assert(Buffer.byteLength(JSON.stringify({ tradeMeeting: [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER], ...large })) <= 128);
const MAX = Number.MAX_SAFE_INTEGER;
function request(n) {
    return { token: String(n).padEnd(80, 't'), actorA: 2*n+1, actorB: 2*n+2, seqA: MAX-1, seqB: MAX-1,
        town: 'x'.repeat(48), point: { locX: Number.MAX_VALUE, locY: -Number.MAX_VALUE, locZ: Number.MAX_VALUE },
        parties: [0,1].map(() => ({ revision: MAX, sequence: MAX-1, needRevision: MAX,
            phase: 'cold', ownerId: 'o'.repeat(80), leaseId: 'l'.repeat(80), hotAt: MAX,
            route: { fee: MAX, scroll: true, method: 'm'.repeat(140), durationMs: Number.MAX_VALUE } })),
        lines: Array.from({length:5}, (_,i) => ({ payer: i%2, itemId: MAX-i, selfId: MAX-i,
            enchant: MAX, count: 1, price: MAX, adId: MAX, adRevision: MAX,
            needAdId: MAX, needAdRevision: MAX,
            certificate: [MAX-i,1,MAX,1,MAX,MAX,MAX,Number.MAX_VALUE,Number.MAX_VALUE] })) };
}

const source = Native.canonical(request(0)), frames = Codec.pages(source);
assert(frames.length <= 4);
assert(frames.every(frame => Buffer.byteLength(JSON.stringify(frame)) <= 768));
assert.deepEqual(Codec.fromPages([...frames].reverse()), source);
assert.deepEqual(Codec.fromPages([...frames, frames[0]]), source, 'identical page retry has no second effect');
assert.throws(() => Codec.fromPages(frames.slice(1)), /incomplete/);
const changed = frames.map(frame => [...frame]); changed[0][4] += 'x';
assert.throws(() => Codec.fromPages([...frames, changed[0]]), /consent_changed|pages/);
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
for (const type of ['command_request', 'command_ack']) {
    const makeEnvelope = frame => Protocol.envelope(type, 'e'.repeat(80), {
        [type === 'command_request' ? 'requests' : 'results']: [{ kind: 'meeting', characterId: MAX, frame }]
    }, 'm'.repeat(160));
    const transported = Codec.commandPages(source, makeEnvelope);
    assert(transported.length <= 4);
    assert(transported.every(frame => Protocol.byteLength(makeEnvelope(frame)) <= 768),
        'the actual protocol envelope, including widest epoch/message identity, fits');
    assert.deepEqual(Codec.fromPages(transported), source);
    assert.deepEqual(Codec.fromPages([...transported].reverse().concat([transported[0]])), source);
    assert.throws(() => Codec.commandPages(source, frame => ({ frame, impossible: 'x'.repeat(768) })), /backpressure/);
    const excessive = require('node:zlib').deflateRawSync(Buffer.alloc(Codec.MAX_RAW_BYTES + 1, 65)).toString('base64');
    assert.throws(() => Codec.fromPages([[2, source.token, 0, 1, excessive]]), /larger than|too large|buffer/i,
        'compressed input cannot expand past one bounded basket');
    console.log(type, 'envelope pages:', transported.map(frame => Protocol.byteLength(makeEnvelope(frame))));
}
const refs = [];
try {
    for (let n = 0; n < 16; n++) refs.push(Service.stage(request(n)));
    assert.equal(Service.counters().pages, 64);
    assert(Service.counters().bytes <= 64 * 768);
    const before = Service.counters();
    assert.equal(Service.stage(request(0)), refs[0]);
    assert.deepEqual(Service.counters(), before, 'retry at full pressure consumes no page');
    assert.throws(() => Service.stage(request(16)), /backpressure/);
} finally { Service.reset(); }
assert.equal(Service.counters().pages, 0);
console.log('Meeting frames:', frames.map(frame => Buffer.byteLength(JSON.stringify(frame))), 'exact round trip, duplicates, refusal and global release passed');
