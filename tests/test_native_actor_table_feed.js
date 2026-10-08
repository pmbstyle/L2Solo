'use strict';
process.env.BOT_DEVELOPER_DIAGNOSTICS = 'true'; // Fixture inspects optional developer counters.
const assert = require('node:assert/strict');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
require('../src/Global');
const { ColdTableChannel } = invoke('GameServer/Bot/Population/ColdTableChannel');
const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator').ColdSimulationCoordinator;
const Protocol = invoke('GameServer/Bot/Population/ColdSimulationProtocol');
const channel = new ColdTableChannel(), ordinary = [[1,{value:1}]], delivered = [];
channel.register('fixture', { key: row => row[0], allRows: () => ordinary, eventDriven: true });
const coordinator = new Coordinator({ tableChannel: channel });
coordinator.workerEpoch = 'no-actor-reader'; coordinator.worker = { postMessage(message) { delivered.push(message); } };
coordinator.attachTableChannel();
assert.equal(channel.tables.has('actors'), false);
assert.equal(channel.actorRecipient, null);
channel.detach(coordinator);
const source = `
const { parentPort, workerData } = require('node:worker_threads');
require(workerData.workerPath);
const Runtime = require(workerData.runtimePath);
parentPort.on('message', message => { if(message.type !== 'worker_presence_request') return;
    let unknown = false;
    try { Runtime.index.sourceSize('actor'); } catch (error) { unknown = error.code === 'CHARACTER_ACTOR_VIEW_UNKNOWN'; }
    parentPort.postMessage({ trace: 'no-actor-reader', unknown, actorFacts: Runtime.index.sourceViews.actor.size });
});`;
(async () => {
    const epoch = 'unattached-actor-worker';
    const worker = new Worker(source, { eval: true, workerData: { workerEpoch: epoch,
        workerPath: path.resolve(__dirname, '../src/GameServer/Bot/Population/ColdSimulationWorker.js'),
        runtimePath: path.resolve(__dirname, '../src/GameServer/World/CharacterLocationRuntime.js') } });
    const messages = []; let failure;
    worker.on('message', message => messages.push(message)); worker.on('error', error => { failure=error; });
    const until = async predicate => {
        const deadline = Date.now()+10000;
        while(!messages.some(predicate)) { if(failure)throw failure; if(Date.now()>deadline)throw Error('worker deadline'); await new Promise(resolve=>setTimeout(resolve,10)); }
        return messages.find(predicate);
    };
    const send = (type,payload) => worker.postMessage(Protocol.envelope(type,epoch,payload));
    try {
        await until(message => message.type==='ready' && message.payload.phase==='loaded');
        send('init',{config:{developerDiagnostics:true}}); await until(message => message.type==='ready' && message.payload.phase==='running');
        send('worker_presence_request',{rows:[]});
        const trace = await until(message => message.trace==='no-actor-reader');
        assert.equal(trace.unknown,true); assert.equal(trace.actorFacts,0);
        assert.equal(messages.some(message => message.type==='table_resync'),false);
        console.log('Production coordinator and actual worker have no actor stream/store; actor view stays unknown: PASS');
    } finally { await worker.terminate(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
