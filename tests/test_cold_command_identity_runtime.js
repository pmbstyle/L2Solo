const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(process.env.N53_GAME_ROOT || path.join(__dirname, '..'));
require(path.join(root, 'src/Global'));
const Protocol = invoke('GameServer/Bot/Population/ColdSimulationProtocol');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const { ColdSimulationCoordinator } = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const row = id => ({ characterId: id, phase: 'cold', activity: 'shopping', updatedAt: 100,
    simulation: { ownerId: 'legacy_main', revision: 0, leaseId: null, leaseUntil: 0 },
    timing: { activityStartedAt: 80, nextResolveAt: 100, lastResolvedAt: 50, lastHotAt: 0 } });
// Construct the expected wire input independently of the proposed new helper,
// so actual current handler positives run before baseline contract failures.
const checkpoint = state => { const cp = Protocol.safetyCheckpoint(state); delete cp.simulationLeaseUntil; return cp; };
const command = (state, kind = 'lifecycle') => ({ characterId: state.characterId, kind,
    commandId: `command:${state.characterId}:1`, commandCheckpoint: checkpoint(state), state: clone(state),
    context: { original: true }, precomputedResult: { patch: {}, events: [], materialize: {}, nextResolveAt: 1000 },
    ...(kind === 'market_review' ? { market: { updates: [], reprices: [], withdrawals: [] } } : {}) });
let currentRows;
const oldCached = LifeState.cachedState;
const oldSettle = LifeState.settleWrites;
LifeState.cachedState = id => currentRows.get(Number(id)) || null;
const failures = [];
async function check(name, work) { try { await work(); console.log(`PASS ${name}`); } catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.stack}`); } }
function fixture({ held = false, error = null, kind = 'lifecycle', advance = false } = {}) {
    const coordinator = new ColdSimulationCoordinator(), gate = deferred(), entered = deferred();
    const sent = [], calls = [], contexts = [];
    currentRows = new Map([[1, row(1)], [2, row(2)]]);
    const worker = label => ({ postMessage: message => sent.push({ label, message: clone(message) }) });
    coordinator.worker = worker('A'); coordinator.workerEpoch = 'command:A';
    coordinator.contextIndex = () => { contexts.push('index'); return {}; };
    coordinator.contextFor = state => { contexts.push(state.characterId); return { current: state.updatedAt }; };
    let first = true;
    const operation = async (state, request) => {
        calls.push({ state, request });
        if (held && first) { first = false; entered.resolve(); return gate.promise; }
        if (error) throw error;
        if (advance) currentRows.set(state.characterId, { ...state, updatedAt: state.updatedAt + 1,
            timing: { ...state.timing, nextResolveAt: 1000 } });
        return { ok: true, state: currentRows.get(state.characterId) };
    };
    coordinator.population = { executeWorkerLifecycleCommand: operation };
    let messages = 0;
    const submit = async requests => {
        const worker = coordinator.worker, epoch = coordinator.workerEpoch;
        await coordinator.onMessage(Protocol.envelope('command_request', epoch, { requests }, `message:${++messages}`), worker, epoch);
    };
    return { coordinator, gate, entered, sent, calls, contexts, submit, kind,
        replace() { coordinator.worker = worker('B'); coordinator.workerEpoch = 'command:B'; } };
}
const acknowledgements = h => h.sent.filter(value => value.message.type === 'command_ack');
async function run() {
    for (const kind of ['lifecycle']) {
        await check(`current ${kind} actual handler and original A Protocol reply`, async () => {
            const h = fixture({ kind }), input = command(currentRows.get(1), kind);
            await h.submit([input]); await h.coordinator.commandTail;
            assert.equal(h.calls.length, 1); assert.equal(h.calls[0].request.precomputedResult, input.precomputedResult);
            assert.equal(acknowledgements(h).length, 1); assert.equal(acknowledgements(h)[0].label, 'A');
            assert.equal(Protocol.validateEnvelope(acknowledgements(h)[0].message, 'main', { workerEpoch: 'command:A' }).ok, true);
        });
        await check(`retired ${kind} queued source and awaited reply cannot switch worker`, async () => {
            const h = fixture({ held: true, kind });
            await h.submit([command(currentRows.get(1), kind)]); await h.entered.promise;
            await h.submit([command(currentRows.get(2), kind)]); h.replace();
            h.gate.resolve({ ok: true, state: currentRows.get(1) }); await h.coordinator.commandTail;
            assert.equal(h.calls.length, 1, 'old queued request cannot execute against replacement source');
            assert.equal(h.contexts.length, 0, 'retired reply does not project context');
            assert.equal(acknowledgements(h).length, 0); assert.equal(h.coordinator.commandInflight.size, 0);
        });
    }
    await check('receipt echoes original sent ID/input even when native output checkpoint advances', async () => {
        const h = fixture({ advance: true }), input = command(currentRows.get(1));
        await h.submit([input]); await h.coordinator.commandTail;
        const result = acknowledgements(h)[0].message.payload.results[0];
        assert.equal(result.ok, true); assert.equal(result.state.updatedAt, 101);
        assert.equal(result.commandId, input.commandId); assert.deepEqual(result.commandCheckpoint, input.commandCheckpoint);
        assert.notDeepEqual(checkpoint(result.state), result.commandCheckpoint);
    });
    await check('stale cached checkpoint refuses old computation with correlated current snapshot', async () => {
        const h = fixture(), input = command(currentRows.get(1));
        currentRows.set(1, { ...currentRows.get(1), updatedAt: 200, simulation: { ...currentRows.get(1).simulation, revision: 1 } });
        await h.submit([input]); await h.coordinator.commandTail;
        assert.equal(h.calls.length, 0, 'latest row must not reinterpret precomputed old work');
        const result = acknowledgements(h)[0].message.payload.results[0];
        assert.equal(result.ok, false); assert.equal(result.reason, 'stale_command');
        assert.deepEqual(result.state, currentRows.get(1)); assert.equal(result.commandId, input.commandId);
        assert.deepEqual(result.commandCheckpoint, input.commandCheckpoint);
    });
    await check('deadline-only native renewal retains original command identity', async () => {
        const h = fixture(), input = command(currentRows.get(1));
        currentRows.set(1, { ...currentRows.get(1), simulation: { ...currentRows.get(1).simulation, leaseUntil: 100000 } });
        await h.submit([input]); await h.coordinator.commandTail;
        assert.equal(h.calls.length, 1);
        const result = acknowledgements(h)[0].message.payload.results[0];
        assert.equal(result.commandId, input.commandId); assert.deepEqual(result.commandCheckpoint, input.commandCheckpoint);
    });
    await check('current command error preserves retry and original identity', async () => {
        const h = fixture({ error: Error('current_operation_error') }), input = command(currentRows.get(1));
        await h.submit([input]); await h.coordinator.commandTail;
        const result = acknowledgements(h)[0].message.payload.results[0];
        assert.equal(result.ok, false); assert.equal(result.reason, 'current_operation_error'); assert.equal(result.retryAfterMs, 5000);
        assert.equal(result.commandId, input.commandId); assert.deepEqual(result.commandCheckpoint, input.commandCheckpoint);
        assert.equal(h.coordinator.counters.commandErrors, 1); assert.equal(h.coordinator.commandInflight.size, 0);
    });
    await check('retired command error has no replacement reply or error/context effects', async () => {
        const h = fixture({ held: true }); await h.submit([command(currentRows.get(1))]); await h.entered.promise;
        h.replace(); h.gate.reject(Error('old_operation_error')); await h.coordinator.commandTail;
        assert.equal(acknowledgements(h).length, 0); assert.equal(h.contexts.length, 0);
        assert.equal(h.coordinator.counters.commandErrors, 0); assert.equal(h.coordinator.commandInflight.size, 0);
    });
    await check('malformed sibling is omitted before work while valid original identity proceeds', async () => {
        const h = fixture(), valid = command(currentRows.get(1)), malformed = command(currentRows.get(2));
        delete malformed.commandCheckpoint.updatedAt;
        await h.submit([malformed, valid]); await h.coordinator.commandTail;
        assert.equal(h.calls.length, 1); assert.equal(h.calls[0].request.commandId, valid.commandId);
        const results = acknowledgements(h)[0].message.payload.results;
        assert.equal(results.length, 1); assert.equal(results[0].commandId, valid.commandId);
    });
    await check('missing authoritative cache refuses without restoring request snapshot', async () => {
        const h = fixture(), input = command(currentRows.get(1)); currentRows.delete(1);
        await h.submit([input]); await h.coordinator.commandTail;
        assert.equal(h.calls.length, 0);
        const result = acknowledgements(h)[0].message.payload.results[0];
        assert.equal(result.ok, false); assert.equal(result.state, undefined);
        assert.equal(result.commandId, input.commandId); assert.deepEqual(result.commandCheckpoint, input.commandCheckpoint);
    });
    await check('pending write wait rejection refuses before dispatch with current retry identity', async () => {
        const h = fixture(), input = command(currentRows.get(1));
        LifeState.settleWrites = () => Promise.reject(Error('pending_write_error'));
        try {
            await h.submit([input]); await h.coordinator.commandTail;
            assert.equal(h.calls.length, 0);
            const result = acknowledgements(h)[0].message.payload.results[0];
            assert.equal(result.ok, false); assert.equal(result.reason, 'pending_write_error'); assert.equal(result.retryAfterMs, 5000);
            assert.equal(result.commandId, input.commandId); assert.deepEqual(result.commandCheckpoint, input.commandCheckpoint);
        } finally { LifeState.settleWrites = oldSettle; }
    });
    await check('retired market command is rejected before work or acknowledgement', async () => {
        const h = fixture(), input = command(currentRows.get(1), 'market_review');
        assert.strictEqual(Protocol.commandIdentity(input), null);
        await h.submit([input]); await h.coordinator.commandTail;
        assert.strictEqual(h.calls.length, 0);
        assert(acknowledgements(h).every(row => row.message.payload.results.length === 0));
    });
    if (failures.length) throw Error(`${failures.length} command handler contracts failed`);
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { LifeState.cachedState = oldCached; LifeState.settleWrites = oldSettle; });
