const assert = require('node:assert/strict');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const gameRoot = process.env.N53_GAME_ROOT || path.resolve(__dirname, '..');
const moduleRoot = path.join(gameRoot, 'src/GameServer/Bot/Population');
const { ColdSimulationKernel } = require(path.join(moduleRoot, 'ColdSimulationKernel'));
const Protocol = require(path.join(moduleRoot, 'ColdSimulationProtocol'));

let now = 1000000;
function state(id, revision = 0, frame = 'old') {
    return { characterId: id, phase: 'cold', activity: 'shopping', inventory: {}, stats: { frame },
        simulation: { ownerId: 'legacy_main', revision, leaseId: null, leaseUntil: 0 },
        timing: { activityStartedAt: now - 60000, lastResolvedAt: now - 60000,
            nextResolveAt: now, lastHotAt: 0 }, updatedAt: now };
}
const result = () => ({ patch: {}, materialize: { exp: 0, sp: 0, adena: 0, items: [] },
    events: [], nextResolveAt: now + 60000 });
function deferred() {
    let resolve, reject;
    const promise = new Promise((a, b) => { resolve = a; reject = b; });
    return { promise, resolve, reject };
}
function fixture({ hold = false, planHold = false, reject = false, send = true } = {}) {
    const gate = deferred(), entered = deferred(), messages = [], started = [], planned = [];
    let first = true, planFirst = true;
    const kernel = new ColdSimulationKernel({ now: () => now,
        ...(planHold ? { planLifecycle: ({ state: current }) => {
            planned.push(current.stats.frame);
            if (planFirst) { planFirst = false; entered.resolve(); return gate.promise; }
            return null;
        } } : {}),
        resolveSolo: ({ state: current }) => {
            started.push({ id: current.characterId, frame: current.stats.frame });
            if (hold && first) { first = false; entered.resolve(); return gate.promise; }
            if (reject) throw new Error('current_error');
            return result();
        }, emit: (type, payload) => { messages.push({ type, payload }); return send; }
    });
    return { kernel, gate, entered, messages, started, planned };
}
const requests = h => h.messages.filter(m => m.type === 'command_request').flatMap(m => m.payload.requests);
const receipt = (request, extra = {}) => ({ ok: true, characterId: request.characterId,
    commandId: request.commandId, commandCheckpoint: request.commandCheckpoint,
    state: request.state, context: request.context, ...extra });
async function issue(h, input = state(1)) {
    h.kernel.upsert({ state: input, context: { source: 'original' } });
    h.kernel.tick();
    await h.kernel.resolveChain;
    assert.equal(requests(h).length, 1, 'one current accepted source emits one request');
    return requests(h)[0];
}
const failures = [];
async function check(name, body) {
    try { await body(); console.log(`${name}: PASS`); }
    catch (error) { failures.push(name); console.error(`${name}: FAIL ${error.stack}`); }
}

async function workerControl() {
    const workerPath = path.join(moduleRoot, 'ColdSimulationWorker.js');
    const source = `
const { parentPort, workerData } = require('node:worker_threads');
const { ColdSimulationKernel } = require(workerData.kernelPath);
const complete = ColdSimulationKernel.prototype.completeCommand;
ColdSimulationKernel.prototype.completeCommand = function(value) {
    const accepted = complete.call(this, value);
    const entry = this.states.get(value.characterId);
    parentPort.postMessage({ trace: 'completion', id: value.commandId, accepted,
        busy: this.commanding.has(value.characterId), context: entry?.context,
        revision: entry?.state.simulation?.revision, frame: entry?.state.stats?.frame });
    return accepted;
};
require(workerData.workerPath);
const Queue = require(workerData.queuePath);
const rearm = Queue.prototype.rearm;
Queue.prototype.rearm = function(id, ...args) {
    parentPort.postMessage({ trace: 'board_rearm', id }); return rearm.call(this, id, ...args);
};
invoke('GameServer/Bot/AI/GearPlanSelection').selectAcquisitionPlan = () => ({
    acquisitionPlan: { status: 'active', strategy: 'farm', partyNeed: 'solo_ok', next: {} },
    replanContext: {}, reusablePartyRequest: false, excludedSpotIds: new Set(),
    economy: { statsPacket: {}, network: {} }
});
invoke('GameServer/Bot/Population/PartyRequestPlanner').partyRequestForPlan = () => null;
invoke('GameServer/Bot/Population/BackgroundResolver').resolveSolo = ({ timestamp }) => ({
    patch: {}, events: [], materialize: { exp: 0, sp: 0, adena: 0, items: [] }, nextResolveAt: timestamp + 60000
});
`;
    const epoch = 'command-lifetime-native-worker';
    const worker = new Worker(source, { eval: true, workerData: { workerPath, workerEpoch: epoch,
        kernelPath: path.join(moduleRoot, 'ColdSimulationKernel'),
        queuePath: path.join(gameRoot, 'src/GameServer/Bot/Economy/BoardReviewEvents') } });
    const received = [];
    let fault;
    worker.on('message', message => received.push(message));
    worker.on('error', error => { fault = error; });
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    const until = async predicate => {
        const deadline = Date.now() + 10000;
        while (!received.some(predicate)) {
            if (fault) throw fault;
            const failure = received.find(m => m.type === 'fault');
            if (failure) throw Error(JSON.stringify(failure.payload));
            if (Date.now() > deadline) throw Error('actual worker deadline');
            await pause(10);
        }
        return received.find(predicate);
    };
    const send = (type, payload) => worker.postMessage(Protocol.envelope(type, epoch, payload));
    try {
        await until(m => m.type === 'ready' && m.payload.phase === 'loaded');
        send('catalog_page', { catalog: 'spots', rows: [], done: true });
        send('catalog_page', { catalog: 'npc_offers', rows: [], done: true });
        send('init', { config: { loopIntervalMs: 10 } });
        await until(m => m.type === 'ready' && m.payload.phase === 'running');
        const old = state(444);
        old.activity = 'shopping';
        old.timing.nextResolveAt = Date.now() - 1000;
        send('snapshot_page', { ack: true, done: true, rows: [{ state: old, context: { source: 'old' } }] });
        const first = (await until(m => m.type === 'command_request')).payload.requests[0];
        assert(first.precomputedResult, 'actual current Worker source produces its own command');
        send('fence', { characterId: 444, deadlineAt: Date.now() + 1000 });
        await until(m => m.type === 'fence_ack');
        const fresh = { ...old, stats: { frame: 'fresh' }, simulation: { ...old.simulation, revision: 1 } };
        send('snapshot_page', { ack: true, done: true, rows: [{ state: fresh, context: { source: 'fresh' } }] });
        const second = (await until(m => m.type === 'command_request' && m.payload.requests[0] !== first
            && m.payload.requests[0].state.stats.frame === 'fresh')).payload.requests[0];
        send('pause', {});
        await pause(40);
        const prior = received.length;
        send('command_ack', { results: [receipt(first)] });
        await pause(60);
        const effects = received.slice(prior);
        assert.equal(effects.filter(m => m.trace === 'board_rearm').length, 0,
            'unadmitted old receipt has no board effects');
        const oldCompletion = effects.find(m => m.trace === 'completion');
        {
            assert(oldCompletion, 'valid old wire is checked by the actual handler');
            assert.equal(oldCompletion.accepted, false);
            assert.equal(oldCompletion.busy, true);
            assert.equal(oldCompletion.frame, 'fresh');
            assert.equal(oldCompletion.context.source, 'fresh');
        }
        const markerStart = received.length;
        send('command_ack', { results: [receipt(second, { commandId: 'wrong-command-id' })] });
        await pause(60);
        assert(received.slice(markerStart).filter(m => m.trace === 'completion').every(m => !m.accepted && m.busy),
            'wrong lifecycle command id cannot consume the current command slot');
        send('command_ack', { results: [{ ...receipt(second), commandCheckpoint: {} },
            receipt(second, { state: state(99) }), receipt(second)] });
        const completed = await until(m => m.trace === 'completion' && m.id === second.commandId && m.accepted === true);
        assert.equal(completed.busy, false, 'matching current receipt frees its current slot');
        assert.equal(completed.context.source, 'fresh');
        const after = received.length;
        send('command_ack', { results: [receipt(second)] });
        await pause(60);
        assert.equal(received.slice(after).filter(m => m.trace === 'board_rearm').length, 0,
            'duplicate accepted receipt does not repeat board effects');
        assert.equal(received.some(m => m.type === 'claim_request' || m.type === 'proposal_batch'), false);
    } finally { await worker.terminate(); }
}

(async () => {
    await check('current source and matching completion restore the consumed normal edge', async () => {
        const h = fixture(), request = await issue(h);
        assert.equal(h.kernel.commanding.has(1), true);
        assert.equal(h.kernel.hasNormalCoverage(1), false);
        h.kernel.completeCommand(receipt(request));
        assert.equal(h.kernel.commanding.has(1), false);
        assert.equal(h.kernel.hasNormalCoverage(1), true);
        const projected = fixture(), input = await issue(projected, state(15));
        assert.equal(projected.kernel.completeCommand(receipt(input, { context: { source: 'main-next' } })), true);
        assert.equal(projected.kernel.states.get(15).context.source, 'main-next',
            'legitimate next context applies when original source was not refreshed');
    });
    await check('queued command retains its origin instead of adopting a replacement', async () => {
        const h = fixture({ hold: true }); h.kernel.upsert(state(1)); h.kernel.upsert(state(2)); h.kernel.tick();
        await h.entered.promise; h.kernel.fence(2); now++; h.kernel.upsert(state(2, 1, 'fresh')); h.kernel.tick();
        h.gate.resolve(result()); await h.kernel.resolveChain;
        assert.deepEqual(h.started.map(s => [s.id, s.frame]), [[1, 'old'], [2, 'fresh']]);
    });
    await check('retired planner cannot enter the resolver after its real await', async () => {
        const h = fixture({ planHold: true }); h.kernel.upsert(state(3)); h.kernel.tick();
        await h.entered.promise; h.kernel.fence(3); now++; h.kernel.upsert(state(3, 1, 'fresh')); h.kernel.tick();
        h.gate.resolve(null); await h.kernel.resolveChain;
        assert.deepEqual(h.started.map(s => s.frame), ['fresh']);
    });
    for (const reject of [false, true]) await check(`retired awaited ${reject ? 'catch' : 'success'} is inert`, async () => {
        const h = fixture({ hold: true }); h.kernel.upsert(state(4)); h.kernel.tick(); await h.entered.promise;
        h.kernel.fence(4); now++; h.kernel.upsert(state(4, 1, 'fresh')); h.kernel.tick();
        const active = h.kernel.commandStartedAt.get(4);
        if (reject) h.gate.reject(Error('old_error')); else h.gate.resolve(result());
        await h.kernel.resolveChain;
        assert.deepEqual(requests(h).map(r => r.state.stats.frame), ['fresh']);
        assert.equal(h.kernel.commanding.has(4), true);
        assert.equal(h.kernel.commandStartedAt.get(4), active);
        assert.equal(h.kernel.stats.errors, 0, 'retired failure does not count as current failure');
    });
    await check('old receipt and replay cannot clear a newly sent command', async () => {
        const h = fixture(), first = await issue(h, state(5));
        h.kernel.fence(5); now++; h.kernel.upsert(state(5, 1, 'fresh')); h.kernel.tick(); await h.kernel.resolveChain;
        const second = requests(h)[1], active = h.kernel.commandStartedAt.get(5);
        assert.equal(h.kernel.completeCommand(receipt(first)), false);
        assert.equal(h.kernel.commandStartedAt.get(5), active);
        assert.equal(h.kernel.hasNormalCoverage(5), false);
        assert.equal(h.kernel.completeCommand(receipt(second)), true);
        const token = h.kernel.scheduleTokens.get(5);
        assert.equal(h.kernel.completeCommand(receipt(second)), false);
        assert.equal(h.kernel.scheduleTokens.get(5), token);
    });
    await check('unsent, wrong id and changed input receipts are refused', async () => {
        const h = fixture({ hold: true }); h.kernel.upsert(state(6)); h.kernel.tick(); await h.entered.promise;
        const active = h.kernel.commandStartedAt.get(6);
        assert.equal(h.kernel.completeCommand({ characterId: 6, commandId: active.commandId,
            commandCheckpoint: active.checkpoint, state: state(6) }), false);
        h.gate.resolve(result()); await h.kernel.resolveChain;
        const request = requests(h)[0];
        assert.equal(h.kernel.completeCommand(receipt(request, { commandId: 'unsent' })), false);
        assert.equal(h.kernel.completeCommand(receipt(request, { commandCheckpoint: {
            ...request.commandCheckpoint, nextResolveAt: now + 1 } })), false);
        assert.equal(h.kernel.commanding.has(6), true);
        assert.equal(h.kernel.completeCommand(receipt(request)), true);
    });
    await check('same checkpoint context and mutable lease deadline preserve queued origin', async () => {
        const h = fixture({ hold: true }); h.kernel.upsert(state(7)); h.kernel.tick(); await h.entered.promise;
        const active = h.kernel.commandStartedAt.get(7), current = h.kernel.states.get(7).state;
        h.kernel.upsert({ state: { ...current, simulation: { ...current.simulation, leaseUntil: now + 30000 } },
            context: { source: 'refreshed' } });
        assert.equal(h.kernel.commandStartedAt.get(7), active);
        const beforeVersion = h.kernel.states.get(7).version;
        h.kernel.upsert({ state: h.kernel.states.get(7).state,
            context: { source: 'refreshed', isPartyLeader: true, party: { nextResolveAt: now + 20000 } } });
        assert(h.kernel.states.get(7).version > beforeVersion, 'actual context changes scheduling version');
        assert.equal(h.kernel.commandStartedAt.get(7), active, 'same CP retains original attempt object');
        h.gate.resolve(result()); await h.kernel.resolveChain;
        assert.equal(requests(h).length, 1);
        assert.equal(h.kernel.completeCommand(receipt(requests(h)[0])), true);
        assert.equal(h.kernel.states.get(7).context.source, 'refreshed', 'ACK preserves latest context');
        assert.equal(h.kernel.states.get(7).state.simulation.leaseUntil, now + 30000);
    });
    await check('sent catalog-before-ACK advance keeps receipt but never rolls latest state back', async () => {
        const h = fixture(), request = await issue(h, state(8));
        const advanced = { ...request.state, activity: 'traveling', updatedAt: now + 100,
            timing: { ...request.state.timing, nextResolveAt: now + 60000 } };
        h.kernel.upsert({ state: advanced, context: { source: 'native-catalog' } });
        assert.equal(h.kernel.commanding.has(8), true);
        assert.equal(h.kernel.completeCommand(receipt(request)), true);
        assert.equal(h.kernel.states.get(8).state, advanced);
        assert.equal(h.kernel.states.get(8).context.source, 'native-catalog');
        assert.equal(h.kernel.hasNormalCoverage(8), true);
    });
    await check('unsent same-cold reroute retires the old computation and admits the fresh source', async () => {
        const h = fixture({ hold: true }); h.kernel.upsert(state(9)); h.kernel.tick(); await h.entered.promise;
        h.kernel.upsert({ state: { ...state(9), updatedAt: now + 1, stats: { frame: 'rerouted' } }, context: {} });
        h.kernel.tick(); h.gate.resolve(result()); await h.kernel.resolveChain;
        assert.deepEqual(requests(h).map(r => r.state.stats.frame), ['rerouted']);
    });
    await check('current error, rejected receipt and send refusal retain normal retries', async () => {
        const error = fixture({ reject: true }); error.kernel.upsert(state(10)); error.kernel.tick(); await error.kernel.resolveChain;
        assert.equal(error.kernel.stats.errors, 1); assert.equal(error.kernel.commanding.size, 0);
        assert.equal(error.kernel.scheduleTokens.get(10).dueAt, now + 5000);
        const h = fixture(), request = await issue(h, state(11));
        assert.equal(h.kernel.completeCommand(receipt(request, { ok: false, retryAfterMs: 30000 })), true);
        assert.equal(h.kernel.scheduleTokens.get(11).dueAt, now + 30000);
        const refused = fixture({ send: false }); refused.kernel.upsert(state(12)); refused.kernel.tick(); await refused.kernel.resolveChain;
        assert.equal(refused.kernel.commanding.size, 0);
        assert.equal(refused.kernel.scheduleTokens.get(12).dueAt, now + 5000);
    });
    await check('hot, removal and shutdown retire receipts and pending callbacks', async () => {
        for (const mode of ['hot', 'remove', 'shutdown']) {
            const h = fixture(), request = await issue(h, state(13));
            if (mode === 'hot') h.kernel.upsert({ state: { ...request.state, phase: 'hot' } });
            else if (mode === 'remove') h.kernel.remove(13);
            else await h.kernel.shutdown();
            assert.equal(h.kernel.commanding.has(13), false, mode);
            assert.equal(h.kernel.completeCommand(receipt(request)), false, mode);
        }
    });
    await check('strict original typed checkpoint wire and native defaults', async () => {
        const h = fixture(), request = await issue(h, state(14));
        const checkpoint = Protocol.commandCheckpoint(request.state);
        assert.equal(Object.keys(checkpoint).length, 11);
        assert.equal('simulationLeaseUntil' in checkpoint, false);
        assert.deepEqual(request.commandCheckpoint, checkpoint);
        for (const [type, field, direction, value] of [['command_request', 'requests', 'worker', request],
            ['command_ack', 'results', 'main', receipt(request)]]) {
            const validate = row => Protocol.commandIdentity(row);
            assert(validate(value));
            for (const malformed of [{ ...value, commandId: undefined }, { ...value, commandId: 1 },
                { ...value, commandCheckpoint: { ...checkpoint, updatedAt: '1000000' } },
                { ...value, commandCheckpoint: { ...checkpoint, characterId: 15 } },
                { ...value, commandCheckpoint: { ...checkpoint, phase: 'hot' } }]) assert.equal(validate(malformed), null);
            const missing = { ...checkpoint }; delete missing.lastHotAt;
            assert.equal(validate({ ...value, commandCheckpoint: missing }), null);
            assert.equal(Protocol.validateEnvelope(Protocol.envelope(type, 'epoch', { [field]: [
                { ...value, commandCheckpoint: missing }, value] }), direction).ok, true,
            'identity admission is per entry, so malformed sibling cannot poison healthy commands');
        }
        const raw = { characterId: 14, phase: 'cold', activity: 'shopping' };
        assert.equal(Protocol.commandCheckpoint(raw).simulationOwner, 'legacy_main');
        assert.equal(Protocol.commandCheckpoint({ ...raw, updatedAt: NaN }), null);
        assert.equal(Protocol.sameCommandCheckpoint(request.state, { ...request.state,
            simulation: { ...request.state.simulation, leaseUntil: now + 10000 } }), true);
        assert.equal(h.kernel.completeCommand(receipt(request, { state: state(99) })), false,
            'output identity cannot write an unrelated retained row');
        assert.equal(h.kernel.states.has(99), false);
        const capacity = fixture(); capacity.kernel.maxInFlight = 1;
        capacity.kernel.upsert(state(20)); capacity.kernel.upsert(state(21));
        assert(capacity.kernel.beginCommand(20));
        assert.equal(capacity.kernel.beginCommand(21), null, 'helper enforces existing aggregate capacity');
    });
    await check('actual Worker lifecycle stale and duplicate receipt have no board/context effects', () => workerControl());
    await check('retired board review command has no admission', () => {
        const h = fixture(); h.kernel.upsert(state(14));
        assert.equal(h.kernel.beginCommand(14, 'market_review'), null);
    });
    if (failures.length) { console.error(`${failures.length} command lifetime groups failed`); process.exitCode = 1; }
    else console.log('N53 command lifetime: 15 groups passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
