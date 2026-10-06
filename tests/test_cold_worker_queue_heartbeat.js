const assert = require('node:assert/strict');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
const workerPath = path.resolve(__dirname, '../src/GameServer/Bot/Population/ColdSimulationWorker.js');
const epoch = 'queue-heartbeat-canonical';
const source = String.raw`
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const {parentPort,workerData}=require('node:worker_threads');
const loaded=new Module(workerData.workerPath,module);
loaded.filename=workerData.workerPath;
loaded.paths=Module._nodeModulePaths(path.dirname(workerData.workerPath));
const extra='\nlet observation={detailedCalls:0,retainedIterations:0}; module.exports.prepareOracle=()=>{Config.coldCompetitionObserveEnabled=false;}; module.exports.guardOracle=()=>{kernel.pause(); const detailed=kernel.snapshot.bind(kernel),values=kernel.states.values.bind(kernel.states); kernel.snapshot=()=>{observation.detailedCalls++;return detailed();}; kernel.states.values=()=>{observation.retainedIterations++;return values();};}; module.exports.observeOracle=()=>({...observation,states:kernel.states.size,heap:kernel.heap.size,competitionReady});';
loaded._compile(fs.readFileSync(workerData.workerPath,'utf8')+extra,workerData.workerPath);
loaded.exports.prepareOracle();
const post=parentPort.postMessage.bind(parentPort);
parentPort.postMessage=message=>{
  if(message.type==='ready'&&message.payload.phase==='running')loaded.exports.guardOracle();
  post(message);
  if((message.type==='ready'&&['state_loaded','snapshots_loaded'].includes(message.payload.phase))||message.type==='heartbeat'||message.type==='drained')post({oracle:true,forType:message.type,forPhase:message.payload.phase,msgId:message.msgId,...loaded.exports.observeOracle()});
};`;
const worker = new Worker(source, { eval: true, workerData: { workerPath, workerEpoch: epoch } });
const messages = [];
let fault;
worker.on('message', message => messages.push(message));
worker.on('error', error => { fault = error; });
async function wait(predicate) {
    const until = Date.now() + 15000;
    while (!messages.some(predicate)) {
        if (fault) throw fault;
        const reported = messages.find(message => message.type === 'fault');
        if (reported) throw new Error(JSON.stringify(reported));
        if (Date.now() >= until) throw new Error('bounded actual Worker transport timeout');
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    return messages.find(predicate);
}
function send(type, payload, msgId) {
    const message = Protocol.envelope(type, epoch, payload, msgId);
    assert(Protocol.validateEnvelope(message, 'main', { workerEpoch: epoch }).ok);
    worker.postMessage(message);
}
function row(id) {
    const now = Date.now();
    return { state: { characterId: id, phase: 'cold', activity: 'resting',
        loc: { locX: 10, locY: 20, locZ: 0 }, stats: { restUntil: now + 600000 }, inventory: {},
        timing: { lastResolvedAt: now, nextResolveAt: now + 600000 },
        simulation: { ownerId: 'legacy_main', revision: 0, leaseId: null, leaseUntil: 0 } }, context: {} };
}
(async () => {
    try {
        const loaded = await wait(message => message.type === 'ready' && message.payload.phase === 'loaded');
        assert.equal(loaded.payload.forbiddenDependencies, 0);
        send('init', { config: { heartbeatMs: 250, loopIntervalMs: 20, maxInFlight: 8 } }, 'initialize');
        const running = await wait(message => message.type === 'ready' && message.msgId === 'initialize');
        assert(Protocol.validateEnvelope(running, 'worker', { workerEpoch: epoch }).ok);
        assert.equal(running.payload.phase, 'running');
        console.log('Actual Worker init and real Protocol positive: PASS');
        const firstRow = row(1);
        send('snapshot_page', { rows: [firstRow], ack: true }, 'state-first');
        const first = await wait(message => message.type === 'ready' && message.msgId === 'state-first');
        assert.equal(first.payload.states, 1); assert.equal(first.payload.paused, true);
        send('snapshot_page', { rows: Array.from({ length: 64 }, (_, index) => row(index + 2)), initial: true, done: true }, 'bootstrap-complete');
        const complete = await wait(message => message.type === 'ready' && message.msgId === 'bootstrap-complete');
        assert.equal(complete.payload.phase, 'snapshots_loaded'); assert.equal(complete.payload.states, 65);
        const heartbeat = await wait(message => message.type === 'heartbeat' && message.payload.states === 65);
        assert.equal(heartbeat.payload.paused, true); assert.equal(heartbeat.payload.competition, null);
        send('shutdown', {}, 'stop');
        const drained = await wait(message => message.type === 'drained' && message.msgId === 'stop');
        assert.equal(drained.payload.states, 65); assert.equal(drained.payload.stopping, true);
        const observed = await wait(message => message.oracle && message.msgId === 'stop');
        console.log(JSON.stringify({ positive: 'actual ready/bootstrap/heartbeat/drained preserve states and pause', observed }));
        for (const message of [first, complete, heartbeat, drained]) {
            assert(Protocol.validateEnvelope(message, 'worker', { workerEpoch: epoch }).ok);
            for (const name of ['due', 'dueAgeMs', 'dueFences']) assert.equal(Object.hasOwn(message.payload, name), false, `${message.type}/${message.payload.phase || ''} legacy ${name}`);
            assert(message.payload.queueHead, 'routine transport has truthful raw queue metadata');
            assert.deepEqual(message.payload.queueHead, { kind: 'normal',
                dueAt: firstRow.state.timing.nextResolveAt, overdue: false, ageMs: 0, current: true });
        }
        assert.equal(observed.detailedCalls, 0);
        assert.equal(observed.retainedIterations, 0);
        console.log('Actual routine Worker transport has zero detailed snapshots/retained iteration: PASS');
    } finally { await worker.terminate(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
