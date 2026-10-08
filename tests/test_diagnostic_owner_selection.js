'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
require('../src/Global');
const Config = require('../src/GameServer/Bot/Population/PopulationConfig');
const Diagnostics = require('../src/GameServer/Bot/Economy/EconomyDiagnostics');
const { ColdSimulationCoordinator } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');
const on = () => ({ developerDiagnostics: true, economyDiagnostics: true, economyDiagnosticsBotIds: '' });
const main = Diagnostics.create({ config: on(), thread: 'main' });
const worker = Diagnostics.create({ config: on(), thread: 'worker' });
for (let id = 128; id <= 1088; id += 64) assert.equal(worker.enabled(id), false);
const updates = [];
main.followSelection(ids => { updates.push(ids); worker.useSelection(ids); });
for (let id = 64; id <= 1024; id += 64) main.enabled(id);
assert.equal(updates.length, 16);
assert.equal(worker.ownerIds(), main.ownerIds());
assert.equal(worker.enabled(1088), false);
assert.equal(main.accept([JSON.stringify({ owner: 1088 })]), 0, 'import cannot enrol another owner');
for (const value of ['', 'NaN', '-1', '0,64', '1.5', '1'.repeat(513), Array.from({length:17}, (_,i)=>i+1).join(',')])
    assert.equal(worker.useSelection(value), false);
const off = Diagnostics.create({ config: { developerDiagnostics: false, economyDiagnostics: true },
    now() { throw Error('off clock'); } });
assert.equal(off.ownerIds(), '0');
assert.equal(off.useSelection({ toString() { throw Error('off conversion'); } }), false);

const root = path.resolve(__dirname, '../src/GameServer/Bot/Population');
const wrapper = `const {parentPort,workerData}=require('node:worker_threads');
require(workerData.workerPath);
const d=require(workerData.diagnosticPath);
parentPort.on('message',m=>{
 if(m.type==='init'||m.type==='economy_diagnostics_selection') {
  for(const owner of [64,128,1088]) if(d.enabled(owner)) d.push({owner,phase:'selection_probe',reason:'native'});
  parentPort.postMessage({type:'selection_probe',selection:d.ownerIds()});
 }
});`;
(async () => {
    Object.assign(Config, on()); Diagnostics.stop();
    const c = new ColdSimulationCoordinator();
    c.sendPlanningCatalog = () => {};
    c.attachTableChannel = () => {};
    c.sendSnapshots = async () => true;
    c.contextFor = () => ({});
    let generation = 0;
    async function run(expectedInitial, exercise) {
        const epoch = 'selection-' + ++generation;
        const w = new Worker(wrapper, { eval: true, workerData: { workerEpoch: epoch, developerDiagnostics: true,
            workerPath: path.join(root, 'ColdSimulationWorker.js'), diagnosticPath: path.join(root, '../Economy/EconomyDiagnostics.js') },
            env: { ...process.env, L2NODE_CONFIG_FILE: 'config/default.ini' } });
        c.worker=w;c.workerEpoch=epoch;c.stopping=false;
        let resolveProbe, rejectProbe;
        let next = new Promise((r,j)=>{resolveProbe=r;rejectProbe=j;});
        const timer=setTimeout(()=>rejectProbe(Error('native selection timeout')),20000);
        const probes=[];
        w.on('error', error=>rejectProbe(error));
        w.on('message', message=>{
            if(message.type==='selection_probe') {
                probes.push(message.selection);resolveProbe(message.selection);return;
            }
            if(message.type==='fault') { rejectProbe(Error(JSON.stringify(message.payload)));return; }
            c.onMessage(message,w,epoch).catch(rejectProbe);
        });
        const probeAfter = async action => {
            next=new Promise((r,j)=>{resolveProbe=r;rejectProbe=j;});action();return next;
        };
        try {
            assert.equal(await next,expectedInitial);
            if(exercise) {
                assert.equal(await probeAfter(()=>c.snapshotEntry({characterId:64},{})),'64', 'birth through actual snapshot updates native worker');
                assert.equal(await probeAfter(()=>w.postMessage({type:'economy_diagnostics_selection',epoch:'old',ownerIds:'128'})),'64');
                assert.equal(await probeAfter(()=>w.postMessage({type:'economy_diagnostics_selection',epoch,ownerIds:'1'.repeat(513)})),'64');
                assert.equal(await probeAfter(()=>c.snapshotEntry({characterId:128},{})),'64,128');
            }
            assert.equal(Diagnostics.ownerIds(), expectedInitial==='0'?'64,128':expectedInitial);
        } finally {
            clearTimeout(timer);c.stopDiagnosticSelection?.();c.stopDiagnosticSelection=null;
            await w.terminate();c.worker=null;
        }
    }
    await run('0',true);
    await run('64,128',false);
    assert.equal(Diagnostics.stats().drops?.admission || 0,0);
    Config.economyDiagnosticsBotIds='1088';
    assert.equal(c.workerConfig().economyDiagnosticsBotIds,'1088');
    Config.developerDiagnostics=false;
    assert.equal(c.workerConfig().economyDiagnosticsBotIds,undefined);
    Diagnostics.stop();
    console.log('Shared main selection: encounter order, empty world/birth, native worker transport, restart, stale/invalid control, explicit IDs and off guards passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
