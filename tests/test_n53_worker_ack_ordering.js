const assert = require('node:assert/strict');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
const source = `
const { parentPort, workerData } = require('node:worker_threads');
const { ColdSimulationKernel } = require(workerData.kernelPath);
const complete = ColdSimulationKernel.prototype.completeCommand;
ColdSimulationKernel.prototype.completeCommand = function(result) {
    const accepted = complete.call(this, result);
    const current = this.states.get(result.characterId);
    parentPort.postMessage({ trace: 'retired_ack', accepted, revision: current?.state.simulation?.revision,
        frame: current?.state.stats?.frame, lookEntries: this.lookSeen.size });
    return accepted;
};
require(workerData.workerPath);`;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function check(mode) {
    const epoch = `retired-market-ack-${mode}`, owners = mode === 'pressure' ? 300 : 1;
    const worker = new Worker(source, { eval: true, workerData: { workerEpoch: epoch,
        kernelPath: path.resolve(__dirname, '../src/GameServer/Bot/Population/ColdSimulationKernel.js'),
        workerPath: process.env.N53_WORKER_PATH || path.resolve(__dirname, '../src/GameServer/Bot/Population/ColdSimulationWorker.js') } });
    const received = [];
    let fault;
    worker.on('error', error => { fault = error; });
    worker.on('message', message => received.push(message));
    const send = (type, payload) => worker.postMessage(Protocol.envelope(type, epoch, payload));
    const until = async predicate => {
        const deadline = Date.now() + 10000;
        while (!received.some(predicate)) {
            if (fault) throw fault;
            const failure = received.find(message => message.type === 'fault');
            if (failure) throw Error(JSON.stringify(failure.payload));
            if (Date.now() >= deadline) throw Error(`worker deadline: ${received.map(message => message.type || message.trace).join(',')}`);
            await pause(10);
        }
        return received.find(predicate);
    };
    try {
        await until(message => message.type === 'ready' && message.payload.phase === 'loaded');
        send('catalog_page', { catalog: 'spots', rows: [], done: true });
        send('catalog_page', { catalog: 'npc_offers', rows: [], done: true });
        const now = Date.now(), pricing = { price: 100, seenCounter: 2, seenAt: 0, seenItem: 1, rival: 0, worth: 0, seenFills: 0 };
        const boardRow = p => [7, 'shop', 1, 4242, 'Giran', 1, [[11, 1864, 0, 100, 100, p, 0]], 4];
        const counterRow = deals => ['c:material none', deals, 1, now, 0, 0, null];
        send('table_page', { tables: [
            { name: 'board', from: null, to: 0, full: true, rows: [[7, boardRow(pricing)]], removed: [] },
            { name: 'market', from: null, to: 0, full: true, rows: [['c:material none', counterRow(2)]], removed: [] }
        ] });
        send('init', { config: { loopIntervalMs: 10, maxInFlight: 2 } });
        await until(message => message.type === 'ready' && message.payload.phase === 'running');
        const state = { characterId: 4242, phase: 'cold', activity: 'hunting', level: 30, inventory: {}, stats: { frame: 'old' },
            simulation: { ownerId: 'legacy_main', revision: 0, leaseId: null, leaseUntil: 0 },
            timing: { lastResolvedAt: now, nextResolveAt: now + 600000 } };
        for (let offset = 0; offset < owners; offset += 64) send('snapshot_page', {
            done: offset + 64 >= owners, ack: offset + 64 >= owners,
            rows: Array.from({ length: Math.min(64, owners - offset) }, (_, i) => ({
                state: { ...state, characterId: 4242 + offset + i }, context: {} }))
        });
        await until(message => message.type === 'ready' && message.payload.phase === 'state_loaded');
        if (mode === 'fence') {
            send('fence', { characterId: 4242, deadlineAt: now + 1000 });
            await until(message => message.type === 'fence_ack');
        }
        const fresh = { ...state, stats: { frame: 'fresh' }, simulation: { ...state.simulation, revision: 1 } };
        if (mode === 'snapshot') send('snapshot_page', { done: true, rows: [{ state: fresh, context: {} }] });
        send('table_page', { tables: [
            { name: 'board', from: 0, to: 1, full: false,
                rows: [[7, boardRow({ ...pricing, seenCounter: 3, seenAt: now })]], removed: [] },
            { name: 'market', from: 0, to: 1, full: false,
                rows: [['c:material none', counterRow(4)]], removed: [] }
        ] });
        const retired = { ok: true, characterId: 4242, commandId: 'retired-market-command',
            commandCheckpoint: Protocol.commandCheckpoint(state), marketCommandId: 'retired-market-command',
            marketDeferred: true, state, context: {} };
        send('command_ack', { results: [retired] });
        await until(message => message.trace === 'retired_ack');
        send('command_ack', { results: [retired] });
        await pause(80);
        const receipts = received.filter(message => message.trace === 'retired_ack');
        assert.equal(receipts.length, 2);
        assert(receipts.every(message => message.accepted === false && message.lookEntries === 0));
        if (mode === 'fence') assert(receipts.every(message => message.revision === undefined), 'late retired ACK cannot resurrect fenced state');
        else assert(receipts.every(message => message.revision === (mode === 'snapshot' ? 1 : 0)
            && message.frame === (mode === 'snapshot' ? 'fresh' : 'old')), 'retired ACK cannot replace newer source');
        assert.equal(received.some(message => ['command_request', 'claim_request', 'proposal_batch'].includes(message.type)), false,
            'board-before-ACK and duplicate ACK do not wake owners, including under pressure');
        console.log(`Real worker retired market ACK ordering ${mode}: PASS`);
    } finally { await worker.terminate(); }
}
(async () => { for (const mode of ['deferred', 'fence', 'snapshot', 'pressure']) await check(mode); })()
    .catch(error => { console.error(error); process.exitCode = 1; });
