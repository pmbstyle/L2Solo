"use strict";
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(process.env.N53_GAME_ROOT || path.join(__dirname,'..'));
require(path.join(root,'tests/helpers/databaseIsolation'));
assert(path.isAbsolute(root));
const isolated=require(path.join(root,'tests/helpers/isolatedSocialDatabase'))('clan-finance-batch',root);
process.chdir(root);
const sqlite=require('node:sqlite'),Native=sqlite.DatabaseSync;
const allowed=new Set([isolated.world,isolated.history,isolated.world+'.access.sqlite']);
let connection, inside=false, financeActive=false, begins=0, probeHook=null, nativeQueueObserver=null;
const sqlFacts=[], connections=[];let lastNativeError;
sqlite.DatabaseSync=class extends Native {
 constructor(file,settings){assert(path.isAbsolute(file)&&allowed.has(file),'exact own native SQLite paths only');super(file,settings);connections.push(file);if(file===isolated.world&&!connection)connection=this;}
 exec(sql){if(this!==connection)return super.exec(sql);const isBegin=/^BEGIN/.test(sql);if(financeActive&&isBegin)begins++;const value=super.exec(sql);if(isBegin)inside=true;else if(/^(COMMIT|ROLLBACK)/.test(sql))inside=false;return value;}
 prepare(sql){const stmt=super.prepare(sql);if(this!==connection)return stmt;return new Proxy(stmt,{get(target,key){const value=Reflect.get(target,key,target);if(typeof value!=='function')return value;return(...args)=>{if(financeActive){sqlFacts.push({sql:String(sql),method:String(key),inside});if(inside&&['get','all'].includes(String(key)))assert(['SELECT total_changes() AS epoch','PRAGMA data_version'].includes(String(sql)),'only scalar CAS reads inside tx');}try{const result=Reflect.apply(value,target,args);nativeQueueObserver?.(String(sql),String(key));return result;}catch(error){if(financeActive)lastNativeError=error;throw error;}};}});}
};

const realDateNow=Date.now;let clock=1800000000000;Date.now=()=>clock;
require(path.join(root,'src/Global'));isolated.assertConfigured(options.default);
options.default.Database.checkpointIntervalMs=60000;options.default.Database.historyTransferMs=60000;
const Database=invoke('Database'),DataCache=invoke('GameServer/DataCache');
const Life=invoke('GameServer/Bot/Population/BotLifeState'),Context=invoke('GameServer/Clan/ClanEconomyContext');
const Journal=require(path.join(root,'src/EconomyJournal'));
const originalContext=Context.forClan,ids=[77,78,79,80],planned=[];
Context.forClan=function(...args){assert.equal(inside,false);planned.push(args[0].id);const result=Reflect.apply(originalContext,this,args);probeHook?.(args[0].id);return result;};
let foreign,settledHook=null,startHook=null;
const results={role:'portable native correctness regression; fixed clock for deadline controls; no performance acceptance',controls:{}};
// Quiescent real per-clan plans below are the native whole-goal oracle.
const submitBatch=(candidates,hooks)=>Database.planClanHallFinanceBatch(candidates,hooks);
function batch(candidates=ids,deadline=clock+40){const dirty=new Set(candidates),before=[],settled=[];const result=submitBatch(candidates,{deadline,
 before:id=>{dirty.delete(id);before.push(id);startHook?.(id);},
 settled:(id,value)=>{if(value.staleFinance)dirty.add(id);settled.push([id,value]);settledHook?.(id,value);},
 failed:id=>{dirty.add(id);}});return{result,dirty,before,settled};}
(async()=>{try{
 DataCache.init();Database.init();assert(Database.isReady());await Database.initClanHalls(clock);
 const lots=await Database.execute(['SELECT id FROM clan_halls ORDER BY id LIMIT 4']);
 for(let i=0;i<ids.length;i++){
  const clanId=ids[i],account='bot_finance_batch_'+clanId;await Database.createAccount(account,'fixture');
  const id=Number((await Database.createCharacter(account,{name:'FinanceBatch'+clanId,race:0,classId:1,maxHp:100,maxMp:100,sex:0,face:0,hair:0,hairColor:0,locX:0,locY:0,locZ:0})).insertId);
  await Database.execute(['UPDATE characters SET level=40,clanId=? WHERE id=?',[clanId,id]]);
  await Database.execute(["INSERT INTO clans(id,name,level,leaderId) VALUES(?,?,3,?)",[clanId,'FinanceBatch'+clanId,id]]);
  await Database.execute(["INSERT INTO clan_simulation_clans(clanId,mode,stateJson,createdAt,updatedAt) VALUES(?,'autonomous','{}',1,1)",[clanId]]);
  await Database.execute(["INSERT INTO bot_life_state(characterId,accountName,characterName,level,phase,activity,statsJson,inventorySummary,updatedAt) VALUES(?,?,?,40,'cold','hunting',?,'{}',1)",[id,account,'FinanceBatch'+clanId,JSON.stringify({classId:1,clanId})]]);
  await Database.execute(["INSERT INTO clan_warehouse_items(clanId,selfId,name,kind,amount,reservedAmount) VALUES(?,57,'Adena','Other.Currency',100,0)",[clanId]]);
  await Database.execute(['UPDATE clan_halls SET ownerId=? WHERE id=?',[clanId,lots[i].id]]);
  const[row]=await Database.execute(['SELECT * FROM bot_life_state WHERE characterId=?',[id]]);Life.acceptLifecycleRow(row);
 }
 await Database.execute(['CREATE TABLE finance_queue_probe(id INTEGER PRIMARY KEY,n INTEGER)']);await Database.execute(['INSERT INTO finance_queue_probe VALUES(1,0)']);
 Journal.attachMissing(connection);financeActive=true;
 const expected=[];for(const id of ids)expected.push({id,result:await Database.planClanHallFinance(id,clock)});
 planned.length=0;let stats=Database.stats();const pending=Database.execute(['UPDATE finance_queue_probe SET n=n+1 WHERE id=1']);
 const clean=batch();await pending;const receipt=await clean.result;
 assert.deepEqual(receipt,expected,'full native goal values/order must equal quiescent sequential calls');assert.deepEqual(planned,ids);assert.deepEqual([...clean.dirty],[]);
 assert.equal(Database.stats().operations['clan-hall:plan'].count-stats.operations['clan-hall:plan'].count,1,'one actual queued batch admission');
 assert.equal(Database.stats().transactions-stats.transactions,4,'four independent native commits');results.controls.clean={receipt,planned:[...planned],queueAdmissions:1,transactions:4};
 // A native preceding UPDATE owns the queue while this admitted request is
 // pending. Observe its real completed SQL call and mutate caller inputs there;
 // no queue/API replacement, synthetic job or substituted SQL result is used.
 planned.length=0;const callerIds=[...ids],admittedDirty=new Set(ids),admissionCallbacks=[];let mutationBoundary;
 const callerHooks={deadline:clock+40,before:id=>{admittedDirty.delete(id);admissionCallbacks.push(['before',id]);},
  settled:(id,result)=>{if(result.staleFinance)admittedDirty.add(id);admissionCallbacks.push(['settled',id]);},
  failed:id=>{admittedDirty.add(id);admissionCallbacks.push(['failed',id]);}};
 const poison=()=>{throw Error('mutated_caller_hook_must_not_run');};
 nativeQueueObserver=(sql,method)=>{if(sql!=='UPDATE finance_queue_probe SET n=n+11 WHERE id=1'||method!=='run')return;nativeQueueObserver=null;
  mutationBoundary={pending:Database.stats().pending,nativeMarker:connection.prepare('SELECT n FROM finance_queue_probe WHERE id=1').get().n};
  assert(mutationBoundary.pending>=2,'native UPDATE and admitted finance batch are both pending at the actual queue boundary');
  callerIds.splice(1,3,80,79,78,77,81);callerHooks.deadline=clock-1;callerHooks.before=callerHooks.settled=callerHooks.failed=poison;};
 const heldQueue=Database.execute(['UPDATE finance_queue_probe SET n=n+11 WHERE id=1']);const mutationRequest=submitBatch(callerIds,callerHooks);
 await heldQueue;const immutableReceipt=await mutationRequest;
 assert.deepEqual(immutableReceipt,expected,'only original bounded ordered IDs may execute after caller mutation');assert.deepEqual(planned,ids);
 assert.equal(callerIds.length,6);assert.equal(admissionCallbacks.length,8);assert.deepEqual([...admittedDirty],[]);
 results.controls.heldNativeQueueInputMutation={mutationBoundary,callerArrayLength:callerIds.length,admittedIds:[...ids],
  nativeGoalParity:true,deadlineAndCallbacksCaptured:true,extraAndReorderedClansNotAdmitted:true};
 let future;const observed=[];probeHook=id=>{observed.push(connection.prepare('SELECT n FROM finance_queue_probe WHERE id=1').get().n);if(id===77)future=Database.execute(['UPDATE finance_queue_probe SET n=n+1000 WHERE id=1']);};const noInterleave=batch();await noInterleave.result;probeHook=null;await future;
 assert(observed.every(n=>n===observed[0]));results.controls.noWriterInterleave={observed};
 foreign=new Native(isolated.world);probeHook=id=>{if(id===78)foreign.prepare('UPDATE finance_queue_probe SET n=n+1 WHERE id=1').run();};const external=batch();await external.result;probeHook=null;
 assert.equal(external.settled[1][1].staleFinance,true);assert.equal(external.settled[2][1].ok,true,'later clan re-reads fresh epochs rather than using an upfront stamp');assert.deepEqual([...external.dirty],[78]);results.controls.externalStale={settled:external.settled,dirty:[...external.dirty]};
 clock++;settledHook=id=>{if(id===77)clock+=40;};const expired=batch();await expired.result;settledHook=null;
 assert.deepEqual(expired.before,[77]);assert.deepEqual([...expired.dirty],[78,79,80]);results.controls.deadline={before:expired.before,dirty:[...expired.dirty]};
 startHook=()=>{clock+=41;};const grandfathered=batch([77],clock+40);await grandfathered.result;startHook=null;assert.deepEqual(grandfathered.before,[77]);assert.equal(grandfathered.settled.length,1);results.controls.firstRequestAdmission={syntheticClockExpiryAfterAdmission:true,firstCompleted:true,notElapsedTimeEvidence:true};
 const admission=batch([77],clock+40);admission.dirty.add(77);await admission.result;assert(admission.dirty.has(77),'a wakeup after first admission survives queued planning');results.controls.firstWakeDuringWait={dirty:[...admission.dirty]};
 const unknown=Error('native_unknown_batch_prepare');probeHook=id=>{if(id===78)throw unknown;};const failed=batch();let caught;try{await failed.result;}catch(error){caught=error;}probeHook=null;
 assert.equal(caught,unknown);assert.deepEqual(failed.before,[77,78]);assert.deepEqual([...failed.dirty],[79,80,78]);results.controls.unknownPrepare={exactIdentity:true,before:failed.before,dirty:[...failed.dirty]};
 const callbackError=Error('native_unknown_after_commit');const beforeFailures=Database.stats().failures;settledHook=()=>{throw callbackError;};const afterCommit=batch();try{await afterCommit.result;}catch(error){assert.equal(error,callbackError);}settledHook=null;
 assert.equal(Database.stats().failures,beforeFailures,'postcommit continuation is not reclassified as SQL queue failure');assert.deepEqual([...afterCommit.dirty],[78,79,80,77]);results.controls.afterCommitIdentity={exactIdentity:true,queueFailureDelta:0,dirty:[...afterCommit.dirty]};
 settledHook=()=>{throw 0;};const falsy=batch([77]);let falsyCaught=false;try{await falsy.result;}catch(error){falsyCaught=true;assert.equal(error,0);}settledHook=null;assert(falsyCaught);results.controls.falsyAfterCommit={exactPrimitiveIdentity:true};
 await Database.execute([`CREATE TRIGGER batch_first_commit AFTER UPDATE ON clan_hall_finances WHEN NEW.clanId=77 BEGIN UPDATE clan_warehouse_items SET amount=amount+7 WHERE clanId=77 AND selfId=57; END`]);
 await Database.execute([`CREATE TRIGGER batch_second_failure AFTER UPDATE ON clan_hall_finances WHEN NEW.clanId=78 BEGIN UPDATE finance_queue_probe SET n=n+100 WHERE id=1; SELECT json_extract('invalid_fixture_json', '$.x'); END`]);
 const amountsBefore=connection.prepare('SELECT amount FROM clan_warehouse_items WHERE clanId=77 AND selfId=57').get().amount;
 const markerBefore=connection.prepare('SELECT n FROM finance_queue_probe WHERE id=1').get().n;
 const journalBefore=Journal.snapshot().filter(r=>r.operation==='clan-hall:plan'&&r.store==='clan_warehouse'&&r.selfId===57).reduce((sum,r)=>sum+r.delta,0);
 const failsBefore=Database.stats().failures;const originalRows=connection.prepare('SELECT clanId,stateJson FROM clan_hall_finances ORDER BY clanId').all();clock++;
 const partial=batch();let nativeError;try{await partial.result;}catch(error){nativeError=error;}
 assert(nativeError);assert.equal(nativeError,lastNativeError);assert.equal(nativeError.errcode,1);assert.equal(Database.stats().failures-failsBefore,1);
 assert.equal(connection.prepare('SELECT amount FROM clan_warehouse_items WHERE clanId=77 AND selfId=57').get().amount,amountsBefore+7);
 assert.equal(connection.prepare('SELECT n FROM finance_queue_probe WHERE id=1').get().n,markerBefore);
 const rows=connection.prepare('SELECT clanId,stateJson FROM clan_hall_finances ORDER BY clanId').all();assert.notEqual(rows[0].stateJson,originalRows[0].stateJson);assert.deepEqual(rows.slice(1),originalRows.slice(1));
 const journalAfter=Journal.snapshot().filter(r=>r.operation==='clan-hall:plan'&&r.store==='clan_warehouse'&&r.selfId===57).reduce((sum,r)=>sum+r.delta,0);assert.equal(journalAfter-journalBefore,7,'later rollback must retain first durable child journal');assert.deepEqual([...partial.dirty],[79,80,78]);
 results.controls.partialNativeFailure={exactIdentity:true,failedCountDelta:1,firstCommitDurable:true,firstJournalDelta:7,secondRolledBack:true,laterUnprocessed:true,dirty:[...partial.dirty]};
 await assert.rejects(Database.planClanHallFinanceBatch([...ids,81],{deadline:clock+40}),/prepared_transaction_batch_bound/);
 await assert.rejects(Database.planClanHallFinanceBatch(ids,{deadline:Infinity}),/prepared_transaction_deadline_required/);
 await assert.rejects(Database.planClanHallFinanceBatch(ids,{deadline:clock+41}),/prepared_transaction_deadline_bound/);
 const asyncCallback=Database.planClanHallFinanceBatch([77],{deadline:clock+40,before:()=>Promise.resolve()});await assert.rejects(asyncCallback,/prepared_transaction_hook_must_be_synchronous/);
 await Database.close();const refused=batch([77]);await assert.rejects(refused.result,/SQLite shutdown is in progress/);assert.deepEqual([...refused.dirty],[77]);results.controls.queueRefusedBeforeEntry={dirtyRestored:true};
 results.status='NATIVE_BATCH_CONTROLS_PASS';
 }finally{financeActive=false;Context.forClan=originalContext;foreign?.close();await Database.close();results.sqlFacts=sqlFacts;results.connections=connections;fs.rmSync(isolated.directory,{recursive:true,force:true});assert(!fs.existsSync(isolated.directory),'own UUID fixture cleanup after awaited close');results.cleanup={directory:isolated.directory,removed:true};Date.now=realDateNow;if(process.env.PROBE_OUTPUT)fs.writeFileSync(process.env.PROBE_OUTPUT,JSON.stringify(results,null,2)+'\n');}
})().then(()=>console.log(results.status)).catch(error=>{console.error(error);process.exitCode=1;});
