'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const gameRoot = path.resolve(process.env.N53_GAME_ROOT || path.join(__dirname, '..'));
require(path.join(gameRoot, 'src/Global'));
invoke('GameServer/DataCache').init();
const Protocol = invoke('GameServer/Bot/Population/ColdSimulationProtocol');
const { LifecycleSafetySweep, INTERVAL_MS } = invoke('GameServer/Bot/Population/LifecycleSafetySweep');
const Registry = invoke('GameServer/Bot/Population/BackgroundJobRegistry');
const Metrics = invoke('GameServer/Bot/Population/PopulationMetrics');
const source = String.raw`
const fs=require('node:fs'), Module=require('node:module'), path=require('node:path');
const {parentPort,workerData}=require('node:worker_threads');
const loaded=new Module(workerData.workerPath,module);loaded.filename=workerData.workerPath;loaded.paths=Module._nodeModulePaths(path.dirname(workerData.workerPath));
loaded._compile(fs.readFileSync(workerData.workerPath,'utf8')+'\nmodule.exports.lose=()=>{for(const id of [3,64,100]){const token=kernel.scheduleTokens.get(id);kernel.heap.remove(token.heapEntry);}return {states:kernel.states.size,safetyNodes:kernel.states.safetyNodes!==undefined,ownSweep:typeof kernel.recoverOrphanedSchedules};};',workerData.workerPath);
parentPort.on('message',message=>{if(message.lose)parentPort.postMessage({trace:'lost',...loaded.exports.lose()});});`;
(async()=>{
    const epoch='main-single-safety-sweep', worker=new Worker(source,{eval:true,workerData:{workerEpoch:epoch,
        workerPath:path.join(gameRoot,'src/GameServer/Bot/Population/ColdSimulationWorker.js')}});
    const messages=[];let error,now=Date.now();
    worker.on('error',value=>{error=value;});
    worker.on('message',message=>messages.push(message));
    const until=async predicate=>{const deadline=Date.now()+10000;while(!messages.some(predicate)){if(error)throw error;if(Date.now()>deadline)throw Error('worker deadline');await new Promise(resolve=>setTimeout(resolve,10));}return messages.find(predicate);};
    const send=(type,payload,msgId)=>worker.postMessage(Protocol.envelope(type,epoch,payload,msgId));
    const entries=Array.from({length:100},(_,i)=>({state:{characterId:i+1,phase:'cold',activity:'hunting',inventory:{},stats:{},updatedAt:now,
        simulation:{ownerId:'legacy_main',revision:1,leaseId:null,leaseUntil:0},
        timing:{activityStartedAt:now,lastResolvedAt:now,nextResolveAt:now+3*INTERVAL_MS,lastHotAt:0}},context:{spot:{id:'safety-fixture'}}}));
    const Transport=invoke('GameServer/Bot/Population/ColdSafetyTransport');
    const transport=new Transport({worker,epoch,post:(type,payload,msgId)=>{send(type,payload,msgId);return true;},
        isCurrent:()=>true,onTotals:(epoch,totals)=>Metrics.recordColdSafetyTotals(epoch,totals),now:()=>Date.now(),timeoutMs:10000});
    const rows=entries.map(entry=>Protocol.safetyCheckpoint(entry.state)), current={worker,epoch,ready:true};
    const registry=Registry.create({now:()=>now,setInterval:()=>({unref(){}}),clearInterval(){}});registry.start(now);
    const totals=()=>[Metrics.counters.coldSafetyStateRepairs,Metrics.counters.coldSafetyQueueRepairs,Metrics.counters.coldSafetyOrphanRepairs];
    const sweep=new LifecycleSafetySweep({now:()=>now,active:()=>true,cachedState:id=>entries[id-1]?.state,
        readPage:async cursor=>{const page=rows.filter(row=>row.characterId>cursor.afterId).slice(0,64);return{rows:page,cursor:{afterId:page.at(-1)?.characterId||100},done:page.length<64};},
        readCurrent:async checkpoint=>rows[checkpoint.characterId-1],admit:()=>({}),complete(){},onError:err=>{error=err;},
        repairTotals:totals,onFinished:deltas=>{Metrics.lastSafetyRepairs=deltas;},
        cold:{current:()=>current,excluded:()=>false,canRepair:()=>true,projection:()=>{throw Error('healthy orphan must not project a full bot');},poll:timestamp=>transport.pulse(Date.now()),cancel:()=>transport.dispose(),
            request:async(kind,selected)=>{const reply=await transport.request(kind,selected);if(!reply.ok)throw Error('transport:'+reply.reason);return reply;}}});
    try{
        await until(message=>message.type==='ready'&&message.payload.phase==='loaded');
        send('init',{config:{loopIntervalMs:100000}});await until(message=>message.type==='ready'&&message.payload.phase==='running');
        send('snapshot_page',{rows:entries.slice(0,64),initial:true});send('snapshot_page',{rows:entries.slice(64),initial:true,done:true});
        await until(message=>message.type==='ready'&&message.payload.phase==='snapshots_loaded');
        worker.postMessage({lose:true});const lost=await until(message=>message.trace==='lost');
        assert.equal(lost.states,100);assert.equal(lost.safetyNodes,false);assert.equal(lost.ownSweep,'undefined');
        Metrics.beginColdSafetyEpoch(epoch);assert(sweep.start(registry));now+=INTERVAL_MS;
        const deadline=Date.now()+10000;
        while(sweep.metrics.completedCycles<1){if(error)throw error;sweep.pulse(now);await new Promise(resolve=>setTimeout(resolve,1));if(Date.now()>deadline)throw Error('sweep deadline');}
        assert.deepEqual(Metrics.lastSafetyRepairs,[0,0,3]);
        const repairs=messages.filter(message=>message.type==='worker_repair_ack');
        assert.equal(repairs.flatMap(message=>message.payload.results).length,3);
        assert(repairs.every(message=>message.payload.results.every(result=>result.kind==='orphan'&&result.status==='accepted')));
        assert.equal(messages.at(-1).type==='fault',false);
        const summary=invoke('GameServer/Bot/Population/PopulationStatus').summary();
        assert(summary.line.includes('safetyRepairs=0/0/3'));
        console.log('One main sweep:100 real worker states,3 physical orphans,3 addressed repairs,no projection,safetyRepairs=0/0/3:PASS');
    }finally{sweep.stop();registry.stop();await worker.terminate();}
})().catch(error=>{console.error(error);process.exitCode=1;});
