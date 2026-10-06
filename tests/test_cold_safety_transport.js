'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const transportPath = process.env.COLD_SAFETY_TRANSPORT_PATH
    || path.join(__dirname, '../src/GameServer/Bot/Population/ColdSafetyTransport.js');
const Protocol = require(path.join(path.dirname(transportPath), 'ColdSimulationProtocol'));
const epoch = 'transport-fixture-epoch';
const checkpoint = characterId => ({ characterId, phase: 'cold', activity: 'hunting',
    simulationOwner: 'legacy_main', simulationRevision: 1, simulationLeaseId: null,
    simulationLeaseUntil: 0, activityStartedAt: 100, nextResolveAt: 900000,
    lastResolvedAt: 0, lastHotAt: 0, updatedAt: 1000 });
const safety = (stateRepairs = 0, boardRepairs = 0, coverageRepairs = 0) =>
    ({ stateRepairs, boardRepairs, coverageRepairs });

function legacyControls() {
    const valid = Protocol.envelope('snapshot_page', epoch, { rows: [] }, 'legacy-control');
    assert.strictEqual(Protocol.validateEnvelope(valid, 'main', { workerEpoch: epoch }).ok, true);
    const ready = Protocol.envelope('ready', epoch, { kind: 'state_loaded', characterId: 1 }, 'legacy-ack');
    assert.strictEqual(Protocol.validateEnvelope(ready, 'worker', { workerEpoch: epoch }).ok, true);
    assert.strictEqual(Protocol.validateEnvelope({ ...valid, version: 900 }, 'main').ok, false);
    assert.strictEqual(Protocol.validateEnvelope({ ...valid, payload: { rows: Array(65).fill({}) } }, 'main').ok, false);
    assert.strictEqual(Protocol.validateEnvelope(valid, 'main', { workerEpoch: 'old' }).ok, false);
    console.log('Actual legacy Protocol direction/batch/version/epoch controls PASS');
}

let ColdSafetyTransport;
function fixture(postMode = null) {
    const worker = new EventEmitter();
    const sent = [];
    const totals = [];
    let timestamp = 1000;
    let current = true;
    const options = { worker, epoch, timeoutMs: 50, now: () => timestamp,
        isCurrent(actualWorker, actualEpoch) {
            assert.strictEqual(actualWorker, worker);
            assert.strictEqual(actualEpoch, epoch);
            return current;
        },
        onTotals: (actualEpoch, value) => totals.push({ epoch: actualEpoch, value }),
        post(type, payload, msgId) {
            const message = Protocol.envelope(type, epoch, payload, msgId);
            assert.strictEqual(Protocol.validateEnvelope(message, 'main', { workerEpoch: epoch }).ok, true,
                'post uses actual allowed wire/schema');
            sent.push(message);
            return postMode ? postMode(message, worker) : message.msgId;
        } };
    const transport = new ColdSafetyTransport(options);
    return { worker, sent, totals, options, transport, setCurrent(value) { current = value; },
        advance(ms) { timestamp += ms; }, now: () => timestamp,
        ack(message = sent.at(-1), payload = receipts(message)) {
            worker.emit('message', Protocol.envelope(message.type.replace('_request', '_ack'), epoch, payload, message.msgId));
        } };
}

function receipts(message, totals = safety()) {
    return { results: message.payload.rows.map(row => {
        const cp = row.checkpoint || row;
        if (message.type === 'worker_presence_request') return { characterId: cp.characterId, checkpoint: { ...cp },
            observedCheckpoint: null, workerVersion: 0, normal: { status: 'uncovered', reason: 'absent' },
            board: { status: 'deferred', reason: 'absent', coverageVersion: 0 } };
        return { characterId: cp.characterId, edgeId: row.edgeId, kind: row.kind, status: 'accepted', reason: 'repaired',
            checkpoint: { ...cp }, observedCheckpoint: { ...cp }, workerVersion: 1, boardCoverageVersion: 1 };
    }), safety: totals };
}

function constructorGuards() {
    const worker = new EventEmitter();
    const valid = { worker, epoch, post: () => true, isCurrent: () => true, onTotals: () => {},
        now: () => 1000, timeoutMs: 50 };
    for (const override of [{ worker: {} }, { epoch: '' }, { epoch: 'e'.repeat(161) }, { post: null },
        { isCurrent: false }, { onTotals: {} }, { now: null }, { timeoutMs: 0 }, { timeoutMs: NaN }, { timeoutMs: '50' }]) {
        assert.throws(() => new ColdSafetyTransport({ ...valid, ...override }));
        assert.strictEqual(worker.listenerCount('message'), 0, 'invalid providers attach no partial listener');
    }
    const transport = new ColdSafetyTransport(valid);
    assert.strictEqual(worker.listenerCount('message'), 1);
    transport.dispose();
    transport.dispose();
    assert.strictEqual(worker.listenerCount('message'), 0);
    console.log('Required providers validated before one listener / idempotent disposal PASS');
}

async function synchronousAndPhases() {
    const f = fixture((message, worker) => {
        worker.emit('message', Protocol.envelope(message.type.replace('_request', '_ack'), epoch,
            receipts(message, safety(1, 2, 3)), message.msgId));
        return true;
    });
    try {
        const p = await f.transport.request('presence', [checkpoint(1)]);
        assert.strictEqual(p.ok, true, 'synchronous ACK sees correlation installed before post');
        assert.strictEqual(p.results.length, 1);
        const r = await f.transport.request('repair', [{ edgeId: 'stable-edge', kind: 'board', checkpoint: checkpoint(1),
            expectedWorkerVersion: 1, expectedBoardCoverageVersion: 0 }]);
        assert.strictEqual(r.ok, true);
        assert.notStrictEqual(f.sent[0].msgId, f.sent[1].msgId, 'each request/phase has a fresh transport ID');
        assert.strictEqual(f.sent[1].payload.rows[0].edgeId, 'stable-edge');
        assert.strictEqual(f.totals.length, 2);
        assert(f.totals.every(entry => entry.epoch === epoch));
        f.ack(f.sent[0]);
        assert.strictEqual(f.totals.length, 2, 'duplicate settled receipt does not re-forward totals');
    } finally { f.transport.dispose(); }
    console.log('Synchronous ACK / distinct phase IDs / matched cumulative totals PASS');
}

async function boundedAndCorrelation() {
    const f = fixture();
    try {
        for (const [kind, rows] of [['other', []], ['presence', {}], ['presence', Array.from({ length: 65 }, (_, i) => checkpoint(i + 1))],
            ['presence', [checkpoint(1), checkpoint(1)]], ['presence', [{ ...checkpoint(1), simulationRevision: -1 }]],
            ['repair', [{ edgeId: 'oversize', kind: 'state', checkpoint: checkpoint(1), expectedWorkerVersion: 0,
                entry: { state: {}, context: { payload: 'x'.repeat(Protocol.MAX_MESSAGE_BYTES) } } }]]]) {
            assert.strictEqual((await f.transport.request(kind, rows)).ok, false);
        }
        assert.strictEqual(f.sent.length, 0, 'invalid/oversize/duplicate rows and oversize bytes are not posted');
        const pending = f.transport.request('presence', Array.from({ length: 64 }, (_, i) => checkpoint(i + 1)));
        let settled = false;
        pending.then(() => { settled = true; });
        assert.strictEqual((await f.transport.request('presence', [checkpoint(100)])).reason, 'busy');
        const sent = f.sent[0];
        f.worker.emit('message', Protocol.envelope('ready', epoch, { kind: 'state_loaded' }, sent.msgId));
        f.worker.emit('message', Protocol.envelope('worker_presence_ack', 'old-epoch', receipts(sent), sent.msgId));
        f.worker.emit('message', Protocol.envelope('worker_presence_ack', epoch, receipts(sent), 'unknown-id'));
        await Promise.resolve();
        assert.strictEqual(settled, false, 'unmatched kind/id/epoch cannot consume the exact pending phase');
        assert.strictEqual(f.totals.length, 0);
        f.ack(sent);
        assert.strictEqual((await pending).ok, true);
        assert.strictEqual(f.totals.length, 1);
    } finally { f.transport.dispose(); }
    console.log('Bounded64 / one pending / exact kind-id-epoch correlation PASS');
}

async function actualPostReturnAndCapturedInput() {
    const f = fixture();
    try {
        const input = checkpoint(1);
        let pending = f.transport.request('presence', [input]);
        let settled = false;
        pending.then(() => { settled = true; });
        await Promise.resolve();
        assert.strictEqual(settled, false, 'actual Coordinator.post exact msgId return waits for matching asynchronous ACK');
        const delivered = receipts(f.sent[0]);
        input.updatedAt++;
        f.ack(f.sent[0], delivered);
        assert.strictEqual((await pending).ok, true, 'correlation captures the originally sent checkpoint');
        assert.strictEqual(f.totals.length, 1);
        pending = f.transport.request('presence', [checkpoint(2)]);
        f.advance(50);
        f.ack();
        assert.strictEqual((await pending).reason, 'timeout', 'expired ACK is refused even before the next pulse');
        assert.strictEqual(f.totals.length, 1);
    } finally { f.transport.dispose(); }
    console.log('Actual msgId producer return / captured checkpoint / late ACK without pulse PASS');
}

async function malformedReceipts() {
    const f = fixture();
    try {
        const mutations = [
            payload => { payload.results.pop(); },
            payload => { payload.results[1] = { ...payload.results[0] }; },
            payload => { payload.results[0].characterId = 99; },
            payload => { payload.results[0].checkpoint.updatedAt++; },
            payload => { payload.safety.stateRepairs = '1'; },
            payload => { payload.results[0].normal.status = 'pretend'; }
        ];
        for (const mutate of mutations) {
            const pending = f.transport.request('presence', [checkpoint(1), checkpoint(2)]);
            const payload = receipts(f.sent.at(-1));
            mutate(payload);
            f.ack(f.sent.at(-1), payload);
            assert.strictEqual((await pending).ok, false, 'a malformed matched ACK refuses the whole receipt batch');
            assert.strictEqual(f.totals.length, 0);
        }
        for (const mutate of [payload => { payload.results[0].edgeId = 'other-edge'; },
            payload => { payload.results[0].kind = 'state'; }]) {
            const pending = f.transport.request('repair', [{ edgeId: 'expected-edge', kind: 'board',
                checkpoint: checkpoint(1), expectedWorkerVersion: 1, expectedBoardCoverageVersion: 0 }]);
            const payload = receipts(f.sent.at(-1));
            mutate(payload);
            f.ack(f.sent.at(-1), payload);
            assert.strictEqual((await pending).ok, false, 'repair edge and kind must match requested identity');
            assert.strictEqual(f.totals.length, 0);
        }
    } finally { f.transport.dispose(); }
    console.log('Actual Protocol and whole-batch exact receipt/edge/checkpoint refusal PASS');
}

async function deadlinesAndLifecycle() {
    const f = fixture();
    const transport2 = new ColdSafetyTransport({ ...f.options, post: () => true });
    try {
        let pending = f.transport.request('presence', [checkpoint(1)]);
        f.advance(49);
        f.transport.pulse(f.now());
        assert.strictEqual(f.totals.length, 0);
        f.advance(1);
        f.transport.pulse(f.now());
        assert.strictEqual((await pending).reason, 'timeout');
        f.ack();
        assert.strictEqual(f.totals.length, 0, 'late timed-out ACK does not forward totals');
        pending = f.transport.request('presence', [checkpoint(1)]);
        f.setCurrent(false);
        f.ack();
        assert.strictEqual((await pending).ok, false);
        assert.strictEqual((await f.transport.request('presence', [checkpoint(2)])).ok, false);
        assert.strictEqual(f.totals.length, 0, 'replaced/stopped exact attachment refuses ACK');
        f.setCurrent(true);
        pending = f.transport.request('presence', [checkpoint(1)]);
        f.transport.dispose();
        assert.strictEqual((await pending).reason, 'disposed');
        assert.strictEqual((await f.transport.request('presence', [])).reason, 'disposed');
        assert.strictEqual(f.worker.listenerCount('message'), 1, 'disposal removes only its captured listener');
        f.ack();
        assert.strictEqual(f.totals.length, 0);
    } finally { f.transport.dispose(); transport2.dispose(); }
    assert.strictEqual(f.worker.listenerCount('message'), 0);
    console.log('Pulse-only deadline / late ACK / replacement / exact disposal PASS');
}

async function postAndCallbackFailures() {
    for (const post of [() => false, () => 'unknown-message-id', () => { throw Error('generated post refusal'); }]) {
        const f = fixture(post);
        try {
            assert.strictEqual((await f.transport.request('presence', [checkpoint(1)])).ok, false);
            f.ack();
            assert.strictEqual(f.totals.length, 0);
        } finally { f.transport.dispose(); }
    }
    const f = fixture();
    f.transport.dispose();
    let calls = 0;
    const transport = new ColdSafetyTransport({ ...f.options, onTotals() { calls++; throw Error('generated accounting failure'); } });
    try {
        const pending = transport.request('presence', [checkpoint(1)]);
        assert.doesNotThrow(() => f.ack(), 'accounting exception cannot escape the shared raw Worker emitter');
        assert.strictEqual((await pending).ok, false);
        assert.strictEqual(calls, 1);
    } finally { transport.dispose(); }
    console.log('Post refusal/exception and accounting callback isolation PASS');
}

(async () => {
    legacyControls();
    assert(fs.existsSync(transportPath), 'feature absent: bounded ColdSafetyTransport API must exist');
    ColdSafetyTransport = require(transportPath);
    constructorGuards();
    const request = Protocol.envelope('worker_presence_request', epoch, { rows: [checkpoint(1)] }, 'wire-control');
    assert.strictEqual(Protocol.validateEnvelope(request, 'main', { workerEpoch: epoch }).ok, true,
        'feature absent: actual safety presence wire is registered and validated');
    const originalTimers = { setInterval: global.setInterval, setTimeout: global.setTimeout };
    global.setInterval = global.setTimeout = () => { throw Error('transport must not create a timer'); };
    try {
        await synchronousAndPhases();
        await actualPostReturnAndCapturedInput();
        await boundedAndCorrelation();
        await malformedReceipts();
        await deadlinesAndLifecycle();
        await postAndCallbackFailures();
    } finally { Object.assign(global, originalTimers); }
    assert.strictEqual(Object.keys(require.cache).some(file => /[\\/]src[\\/]Database\.js$/.test(file)), false);
    console.log('ColdSafetyTransport: PASS; no timers/DB/Global/worker process');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
