process.env.BOT_DEVELOPER_DIAGNOSTICS = 'true'; // Fixture inspects optional developer counters.
const assert = require('node:assert/strict');
const { ColdSimulationKernel } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
let now=1000000;
const kernel=new ColdSimulationKernel({now:()=>now,resolveSolo:()=>({})});
for(let id=1;id<=200;id++)kernel.upsert({state:{characterId:id,phase:'cold',activity:'hunting',inventory:{},stats:{},timing:{nextResolveAt:now+3600000}},context:{spot:{id:'field'}}});
kernel.pause();
const lost=kernel.scheduleTokens.get(73);assert(kernel.heap.remove(lost.heapEntry));
for(let i=0;i<4;i++){now+=1800000;kernel.tick();}
assert.equal(kernel.hasNormalCoverage(73),false,'the worker does not start a second sweep');
assert.equal(kernel.recoverOrphanedSchedules,undefined);
assert.equal(kernel.orphanSweepIntervalMs,undefined);
assert.equal(kernel.states.safetyNodes,undefined);
assert.equal(kernel.states.startSafetyCycle,undefined);
assert.equal(kernel.states.inspectSafetyPage,undefined);
assert.equal([...kernel.alarms.values()].filter(entry=>entry.alarmKind==='worker_safety').length,0);
assert.throws(()=>kernel.armAlarm('worker_safety',0,now,{stamp:'retired',characterId:0,operational:true}),/unsupported_alarm/);
assert.equal(kernel.ensureScheduled(73),true,'the main sweep can restore a named orphan');
assert.equal(kernel.ensureScheduled(73),false,'healthy nodes do not count as repairs');
kernel.shutdown();
console.log('Retired worker safety cycle/list/alarms stay absent; addressed repair remains:PASS');
