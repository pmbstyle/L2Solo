const assert = require('assert');
const path = require('path');
const { Worker } = require('worker_threads');
const root = process.env.N53_GAME_ROOT || path.resolve(__dirname, '..');
const Protocol = require(root + '/src/GameServer/Bot/Population/ColdSimulationProtocol');
const { ColdSimulationKernel } = require(root + '/src/GameServer/Bot/Population/ColdSimulationKernel');
const BoardReviewEvents = require(root + '/src/GameServer/Bot/Economy/BoardReviewEvents');
const failures = [];
async function check(name, work) {
    try { await work(); console.log(`${name}: pass`); }
    catch (error) { failures.push(name); console.error(`${name}: FAIL ${error.stack}`); }
}
const born = 1000000, period = 1800000;
function full(id, revision = 1) {
    return { state: { characterId: id, phase: 'cold', activity: 'hunting', inventory: {}, stats: {},
        simulation: { ownerId: 'legacy_main', revision, leaseId: null, leaseUntil: 0 }, updatedAt: born,
        timing: { activityStartedAt: born, nextResolveAt: born + 10 * period, lastResolvedAt: born, lastHotAt: 0 } },
    context: { spot: { id: 'presence' } } };
}
function flat(entry) {
    const state = entry.state, timing = state.timing;
    return { characterId: state.characterId, phase: state.phase, activity: state.activity,
        simulationOwner: state.simulation.ownerId, simulationRevision: state.simulation.revision,
        simulationLeaseId: state.simulation.leaseId, simulationLeaseUntil: state.simulation.leaseUntil,
        activityStartedAt: timing.activityStartedAt, nextResolveAt: timing.nextResolveAt,
        lastResolvedAt: timing.lastResolvedAt, lastHotAt: timing.lastHotAt, updatedAt: state.updatedAt };
}

(async () => {
    await check('physical schedule loss is repaired once; healthy and partial-party work are preserved', () => {
        let now = born;
        const kernel = new ColdSimulationKernel({ now: () => now, resolveSolo: () => ({}) });
        for (let id = 1; id <= 200; id++) kernel.upsert(full(id));
        const lost = kernel.heap.values.find(entry => entry.characterId === 73 && entry.kind !== 'alarm');
        const healthy = kernel.scheduleTokens.get(74);
        assert(kernel.heap.remove(lost)); assert(kernel.scheduleTokens.has(73));
        kernel.claiming.add(75); kernel.scheduleTokens.delete(75);
        kernel.inFlight.set(76, { grant: { leaseId: 'busy' } }); kernel.scheduleTokens.delete(76);
        kernel.partyRuns.set('partial', { grants: new Map([[77, { leaseId: 'partial' }]]) });
        kernel.scheduleTokens.delete(77);
        kernel.pause();
        for (const name of ['entries', 'values', 'keys', Symbol.iterator]) kernel.states[name] = () => {
            throw new Error('all-state scan forbidden');
        };
        for (let id = 1; id <= 200; id++) if (![73, 75, 76, 77].includes(id)) {
            Object.defineProperty(kernel.states.get(id).state, 'inventory', {
                get() { throw new Error('healthy classification forbidden'); }
            });
        }
        now += period; kernel.tick();
        while (kernel.safetyStartedAt !== null) kernel.tick();
        const replacement = kernel.scheduleTokens.get(73);
        assert.notStrictEqual(replacement.token, lost.scheduleToken);
        assert(kernel.heap.positions.has(replacement.heapEntry));
        assert.strictEqual(kernel.stats.orphanRecoveries, 1);
        assert.strictEqual(kernel.scheduleTokens.get(74), healthy);
        assert.strictEqual(kernel.scheduleTokens.has(75), false);
        assert.strictEqual(kernel.scheduleTokens.has(76), false);
        assert.strictEqual(kernel.scheduleTokens.has(77), false);
        now += period; kernel.tick(); while (kernel.safetyStartedAt !== null) kernel.tick();
        assert.strictEqual(kernel.stats.orphanRecoveries, 1);
    });

    await check('board counter coverage API is absent', () => {
        const queue = new BoardReviewEvents({ board: { ownerLines: () => [] } });
        assert.strictEqual(queue.counterChanged, undefined);
        assert.strictEqual(queue.coverageVersion, undefined);
        assert.strictEqual(queue.edgeOf, undefined);
    });
    await check('checkpoint preserves all native timing/identity and refuses unsafe values', () => {
        assert.deepStrictEqual(Protocol.safetyCheckpoint(full(1).state), flat(full(1)));
        assert(Protocol.sameSafetyCheckpoint(flat(full(1)), Protocol.safetyCheckpoint(full(1).state)));
        assert(!Protocol.sameSafetyCheckpoint(flat(full(1)), { ...flat(full(1)), nextResolveAt: 3 }));
        assert.strictEqual(Protocol.safetyCheckpoint({ ...flat(full(1)), simulationRevision: Infinity }), null);
        assert.strictEqual(Protocol.safetyCheckpoint({ ...flat(full(1)), characterId: true }), null);
    });
    await check('actual Protocol refuses malformed receipts and scalar totals', () => {
        const result = { characterId: 1, checkpoint: flat(full(1)), observedCheckpoint: flat(full(1)), workerVersion: 1,
            normal: { status: 'covered', reason: 'normal_schedule' } };
        const safety = { stateRepairs: 0, coverageRepairs: 0 };
        const message = Protocol.envelope('worker_presence_ack', 'validation', { results: [result], safety }, 'receipt');
        assert(Protocol.validateEnvelope(message, 'worker').ok);
        result.normal.status = 'pretend'; assert(!Protocol.validateEnvelope(message, 'worker').ok);
        result.normal.status = 'covered'; safety.stateRepairs = -1; assert(!Protocol.validateEnvelope(message, 'worker').ok);
    });

    const epoch = 'presence-canonical';
    const workerPath = root + '/src/GameServer/Bot/Population/ColdSimulationWorker.js';
    // Load the actual source; only an observation oracle is appended. No copied runtime or fake protocol handler.
    const source = String.raw`
const fs = require('fs'), path = require('path'), Module = require('module');
const { parentPort, workerData } = require('worker_threads');
const loaded = new Module(workerData.workerPath, module);
loaded.filename = workerData.workerPath; loaded.paths = Module._nodeModulePaths(path.dirname(workerData.workerPath));
loaded._compile(fs.readFileSync(workerData.workerPath, 'utf8') + '\nmodule.exports.poisonGlobalRead = () => { kernel.snapshot = () => { throw Error("global_snapshot_forbidden"); }; for (const name of ["entries","values","keys",Symbol.iterator]) kernel.states[name] = () => { throw Error("global_state_iterator_forbidden"); }; for(let id=2;id<=64;id++) Object.defineProperty(kernel.states.get(id).state,"inventory",{get(){throw Error("healthy_classification_forbidden");}}); }; module.exports.observe = () => ({ states: kernel.states.size, forbidden: forbiddenLoaded.length }); module.exports.control = (op,id) => { if(op==="key")return MarketCounters.counterOf(1864); if(op==="partial") { const requestId="fixture_partial_request",purpose={kind:"party",partyId:"fixture_partial",memberIds:[id,id+1000]};kernel.partyRuns.set(purpose.partyId,{purpose,grants:new Map(),members:[kernel.states.get(id).state]});kernel.claiming.add(id);kernel.claimStartedAt.set(id,Date.now());const alarmToken=kernel.armAlarm("claim_ack",id,Date.now()+5000,{stamp:requestId,characterId:id,operational:true});kernel.claimAttempts.set(id,{requestId,alarmToken});kernel.onClaimAck({grants:[{characterId:id,ownerId:"cold_simulation_owner",revision:2,leaseId:"accepted_partial",leaseUntil:Date.now()+30000,purpose}]},requestId);return {normal:kernel.hasNormalCoverage(id),busy:kernel.busy(id),accepted:kernel.hasAcceptedPartyGrant(id)}; } if(op==="restore_partial") {kernel.partyRuns.delete("fixture_partial");kernel.ensureScheduled(id);} };', workerData.workerPath);
const post = parentPort.postMessage.bind(parentPort);
parentPort.postMessage = message => {
  post(message);
  if (message.type === 'ready' && message.payload.phase === 'snapshots_loaded') loaded.exports.poisonGlobalRead();
  if (message.type === 'worker_presence_ack' || message.type === 'worker_repair_ack') post({ oracle: true, msgId: message.msgId, ...loaded.exports.observe() });
};
parentPort.on('message', message => { if(message.nativeControl) post({nativeControlAck:message.requestId,value:loaded.exports.control(message.nativeControl,message.characterId)}); });`;
    const worker = new Worker(source, { eval: true, workerData: { workerPath, workerEpoch: epoch } });
    const messages = []; let fault;
    worker.on('message', message => messages.push(message)); worker.on('error', error => { fault = error; });
    async function wait(predicate) {
        const until = Date.now() + 10000;
        while (!messages.some(predicate)) {
            if (fault) throw fault;
            if (Date.now() > until) throw new Error('bounded Worker reply timeout');
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        return messages.find(predicate);
    }
    let sequence = 0;
    const send = (type, payload, msgId) => worker.postMessage(Protocol.envelope(type, epoch, payload, msgId));
    async function rpc(type, payload, expected) {
        const msgId = `${type}:${++sequence}`;
        send(type, payload, msgId);
        const message = await wait(message => message.msgId === msgId
            || (message.type === 'fault' && message.payload.msgId === msgId));
        assert.strictEqual(message.type, expected, JSON.stringify(message));
        assert.strictEqual(message.workerEpoch, epoch); assert.strictEqual(message.msgId, msgId);
        assert(!('states' in message.payload));
        const oracle = await wait(message => message.oracle && message.msgId === msgId);
        assert.strictEqual(oracle.forbidden, 0);
        return message.payload;
    }
    async function control(nativeControl, characterId = 1) {
        const requestId = `control:${++sequence}`;
        worker.postMessage({ nativeControl, characterId, requestId });
        return (await wait(message => message.nativeControlAck === requestId)).value;
    }
    try {
        await wait(message => message.type === 'ready' && message.payload.phase === 'loaded');
        send('init', { config: { loopIntervalMs: 100000, heartbeatMs: 100000 } }, 'init');
        await wait(message => message.type === 'ready' && message.payload.phase === 'running');
        await check('initial catalog readiness defers compact absent rows', async () => {
            const response = await rpc('worker_presence_request', { rows: [flat(full(99))] }, 'worker_presence_ack');
            assert.strictEqual(response.results[0].normal.status, 'deferred');
            assert.strictEqual(response.safety.stateRepairs, 0);
        });
        send('snapshot_page', { rows: Array.from({ length: 64 }, (_, index) => full(index + 1)), initial: true, done: true }, 'initial');
        await wait(message => message.type === 'ready' && message.payload.phase === 'snapshots_loaded');
        await check('actual bounded healthy presence uses compact ACK and no all-state snapshot', async () => {
            const response = await rpc('worker_presence_request', {
                rows: Array.from({ length: 64 }, (_, index) => flat(full(index + 1)))
            }, 'worker_presence_ack');
            assert.strictEqual(response.results.length, 64);
            for (const result of response.results) assert.strictEqual(result.normal.status, 'covered');
            assert.deepStrictEqual(response.safety, { stateRepairs: 0, coverageRepairs: 0 });
        });
        await check('native absent full projection accepts once; replay/fence tuple/projection gaps refuse', async () => {
            const entry = full(99), checkpoint = flat(entry);
            const probe = await rpc('worker_presence_request', { rows: [checkpoint] }, 'worker_presence_ack');
            assert.strictEqual(probe.results[0].normal.status, 'uncovered');
            const repair = { edgeId: 'lost-state-99', kind: 'state', checkpoint,
                expectedWorkerVersion: probe.results[0].workerVersion, entry };
            const accepted = await rpc('worker_repair_request', { rows: [repair] }, 'worker_repair_ack');
            assert.strictEqual(accepted.results[0].status, 'accepted'); assert.strictEqual(accepted.safety.stateRepairs, 1);
            const replay = await rpc('worker_repair_request', { rows: [repair] }, 'worker_repair_ack');
            assert.notStrictEqual(replay.results[0].status, 'accepted'); assert.strictEqual(replay.safety.stateRepairs, 1);
            const missing = { edgeId: 'missing-projection', kind: 'state', checkpoint: flat(full(100)), expectedWorkerVersion: 0 };
            const unavailable = await rpc('worker_repair_request', { rows: [missing] }, 'worker_repair_ack');
            assert.strictEqual(unavailable.results[0].status, 'deferred'); assert.strictEqual(unavailable.safety.stateRepairs, 1);
            send('fence', { characterId: 99 }, 'fence-99');
            await wait(message => message.type === 'fence_ack' && message.msgId === 'fence-99');
            const fenced = await rpc('worker_repair_request', { rows: [repair] }, 'worker_repair_ack');
            assert.strictEqual(fenced.results[0].status, 'stale'); assert.strictEqual(fenced.safety.stateRepairs, 1);
        });
        await check('active native lease and malformed batch cannot seed compact state', async () => {
            const leased = { ...flat(full(101)), simulationLeaseId: 'native-lease', simulationLeaseUntil: Date.now() + 100000 };
            const response = await rpc('worker_presence_request', { rows: [leased] }, 'worker_presence_ack');
            assert.strictEqual(response.results[0].normal.status, 'deferred');
            const id = 'invalid-batch';
            send('worker_repair_request', { rows: [
                { kind: 'state', edgeId: 'valid-first', checkpoint: flat(full(102)), expectedWorkerVersion: 0, entry: full(102) },
                { kind: 'state', edgeId: 'invalid-last', checkpoint: { ...flat(full(103)), characterId: 0 }, expectedWorkerVersion: 0, entry: full(103) }
            ] }, id);
            const invalid = await wait(message => message.type === 'fault' && message.payload.msgId === id);
            assert.strictEqual(invalid.payload.reason, 'invalid_safety_row');
            const unchanged = await rpc('worker_presence_request', { rows: [flat(full(102))] }, 'worker_presence_ack');
            assert.strictEqual(unchanged.results[0].normal.status, 'uncovered'); assert.strictEqual(unchanged.safety.stateRepairs, 1);
        });
        await check('a moved counter never creates board presence or repair', async () => {
            const key = await control('key');
            const record = [1, 'sell_ad', 1, 1, 'Giran', 1, [[1, 1864, 0, 1, 100,
                { price: 100, seenCounter: 0, seenItem: 0, rival: 0, worth: 0, seenFills: 0 }, 0]], 1];
            send('table_page', { tables: [
                { name: 'board', full: 1, to: 1, last: 1, rows: [[1, record]] },
                { name: 'market', full: 1, to: 1, last: 1, rows: [[`c:${key}`, [`c:${key}`, 10, 0, born, 1, 1, null]]] }
            ] }, 'board-full');
            const probe = await rpc('worker_presence_request', { rows: [flat(full(1))] }, 'worker_presence_ack');
            assert.strictEqual(probe.results[0].board, undefined);
            assert.strictEqual(probe.safety.boardRepairs, undefined);
            const requestId = 'retired-board-repair';
            send('worker_repair_request', { rows: [{ edgeId: requestId, kind: 'board', checkpoint: flat(full(1)),
                expectedWorkerVersion: probe.results[0].workerVersion, expectedBoardCoverageVersion: 0 }] }, requestId);
            const rejected = await wait(message => message.type === 'fault' && message.payload.msgId === requestId);
            assert.strictEqual(rejected.payload.reason, 'invalid_safety_row');
        });
        await check('accepted partial-party alias and current tuple changes defer native repair', async () => {
            const alias = await control('partial');
            assert.deepStrictEqual(alias, { normal: true, busy: false, accepted: true });
            const partial = await rpc('worker_presence_request', { rows: [flat(full(1))] }, 'worker_presence_ack');
            assert.strictEqual(partial.results[0].board, undefined);
            assert.strictEqual(partial.results[0].normal.status, 'covered');
            await control('restore_partial');
            const changed = { ...flat(full(1)), nextResolveAt: 1 };
            const mismatch = await rpc('worker_presence_request', { rows: [changed] }, 'worker_presence_ack');
            assert.strictEqual(mismatch.results[0].normal.reason, 'checkpoint_changed');
        });
    } finally { await worker.terminate(); }
    if (failures.length) { console.error(`${failures.length} failed groups`); process.exitCode = 1; }
})().catch(error => { console.error(error); process.exitCode = 1; });
