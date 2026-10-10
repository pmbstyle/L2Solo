process.env.BOT_DEVELOPER_DIAGNOSTICS = 'true'; // This fixture inspects optional developer metrics.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const gameRoot = process.env.N53_GAME_ROOT || path.resolve(__dirname, '..');
require(path.join(gameRoot, 'src/Global'));
const Database = invoke('Database');
const Data = invoke('GameServer/DataCache');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Skillset = invoke('GameServer/Actor/Skillset');
const Progression = invoke('GameServer/Bot/BotClassProgression');
const Population = invoke('GameServer/Bot/Population/PopulationService');
const Protocol = invoke('GameServer/Bot/Population/ColdSimulationProtocol');
const { ColdSimulationCoordinator } = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const { WorkerCommandAdmissionRefusal } = require(path.join(gameRoot, 'src/GameServer/Bot/Population/WorkerCommandAdmission'));
const clone = value => JSON.parse(JSON.stringify(value));
const realImmediate = setImmediate;
const turn = () => new Promise(done => realImmediate(done));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function wait(promise, label) {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('timeout: '+label)), 3000); })]); }
    finally { clearTimeout(timer); }
}
let directory, serial = 0;
const failures = [];
function facts(id) {
    const db = new DatabaseSync(options.default.Database.path, { readOnly:true });
    try {
        const result = {};
        for (const table of ['bot_life_state','characters','skills','items','warehouse_items','afk_trade_shops','afk_trade_lines']) {
            result[table] = clone(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
        }
        result.cache = clone(Life.cachedState(id)); return result;
    } finally { db.close(); }
}
async function seed() {
    const account=`bot_skill_admission_${++serial}`;
    await Database.createAccount(account,'fixture');
    const id=Number((await Database.createCharacter(account,{name:`SkillAdmission${serial}`,race:0,classId:0,
        sex:0,face:0,hair:0,hairColor:0,maxHp:100,maxMp:100,locX:83000,locY:148000,locZ:-3400})).insertId);
    const level=7,time=Date.now();
    await Database.updateCharacterExperience(id,level,Number(Data.experience[level-1])+1,100000);
    assert(await Life.upsertState({characterId:id,accountName:account,name:`SkillAdmission${serial}`,level,
        exp:Number(Data.experience[level-1])+1,sp:100000,adena:0,inventory:{},phase:'cold',activity:'resting',
        loc:{locX:83000,locY:148000,locZ:-3400},vitals:{hp:85,maxHp:100,mp:70,maxMp:100},
        timing:{lastResolvedAt:time-45000,nextResolveAt:time+30000},
        stats:{classId:0,classProgressionLevel:0,classProgressionClassId:0,restUntil:time+30000}},'skill_admission_seed'));
    return id;
}
const skill = level => ({selfId:3,name:'Power Strike',passive:false,level});
const write = (method,id,level,bag) => method==='insert'
    ? Database.setSkill(skill(level),id,bag) : Database.updateSkillLevel(id,3,level,bag);
async function manualParity() {
    const id=await seed(),book=new Skillset();
    await book.awardSkills(id,0,7);
    const trained=(await Database.fetchSkills(id)).map(row=>[row.selfId,row.level]).sort((a,b)=>a[0]-b[0]);
    assert.equal(trained.length,9);assert.equal(book.fetchSkills().length,9);
    await Progression.reconcile({characterId:id,classId:0,level:7});
    assert.deepEqual((await Database.fetchSkills(id)).map(row=>[row.selfId,row.level]).sort((a,b)=>a[0]-b[0]),trained);
    await Database.setSkill(skill(10),id);
    await book.awardSkills(id,0,7);
    assert.equal((await Database.fetchSkill(id,3))[0].level,10,'ancestor reconciliation never downgrades trained rank');
    const tree=Data.skillTree.find(entry=>entry.classId===0),original=tree.skills;
    try {
        tree.skills=[{selfId:999999,name:'Unknown fixture skill',levels:[{pLevel:1,level:1}]},
            {selfId:3,name:'Undefined fixture rank',levels:[{pLevel:1,level:0}]}];
        const before=facts(id);await book.awardSkills(id,0,7);assert.deepEqual(facts(id),before);
        tree.skills=[];await book.awardSkills(id,0,7);assert.deepEqual(facts(id),before);
    } finally { tree.skills=original; }
}
async function nativeDomain(method) {
    const id=await seed();await Database.setSkill(skill(1),id);
    let calls=0,thenCalls=0;const unhandled=[],listener=error=>unhandled.push(error);
    process.on('unhandledRejection',listener);
    try {
        const label=method==='insert'?'skill:upsert':'skill:level',metrics=Database.stats();
        const result=await write(method,id,2,{beforeWrite(){calls++;}});
        assert.equal(calls,1);assert.equal(result.affectedRows,1);assert.equal(typeof result.insertId,'number');
        assert.deepEqual(Object.keys(result).sort(),['affectedRows','insertId']);
        const completed=Database.stats();
        assert.equal(completed.operations[label].count,Number(metrics.operations[label]?.count||0)+1);
        assert.equal(completed.writes,metrics.writes+1);assert.equal(completed.reads,metrics.reads);
        assert.equal((await Database.fetchSkill(id,3))[0].level,2,'same proposal is a genuine native mutation');
        await Database.updateSkillLevel(id,3,1);const before=facts(id);
        const accessor=Object.defineProperty({},'beforeWrite',{get(){throw Error('must_not_evaluate_accessor');}});
        const invalid=[null,[],{beforeWrite:undefined},{beforeWrite:null},{beforeWrite:0},accessor,
            Object.create({beforeWrite(){throw Error('must_not_adopt_inherited');}}),
            {beforeWrite:()=>null},{beforeWrite:()=>0},{beforeWrite:()=>({})},
            {beforeWrite:async()=>undefined},{beforeWrite:()=>Promise.reject(Error('native_rejected_guard'))},
            {beforeWrite:()=>Promise.reject(new WorkerCommandAdmissionRefusal('stale_command'))},
            {beforeWrite:()=>Object.defineProperty({},'then',{get(){thenCalls++;throw Error('must_not_read_then');}})}];
        for(let index=0;index<invalid.length;index++){
            await assert.rejects(write(method,id,2,invalid[index]),error=>error instanceof TypeError,`strict callback ${method}:${index}`);
            assert.deepEqual(facts(id),before,'invalid callback cannot apply the real rank mutation');
        }
        for(const error of [Object.assign(Error('plain_same_code'),{code:'BOT_WORKER_COMMAND_ADMISSION_REFUSED'}),
            new WorkerCommandAdmissionRefusal('stale_command')]){
            await assert.rejects(write(method,id,2,{beforeWrite(){throw error;}}),found=>found===error);
            assert.deepEqual(facts(id),before);
        }
        const captureError=Error('original_skill_descriptor_failure');
        const reflectionJob=write(method,id,2,new Proxy({},{getOwnPropertyDescriptor(){throw captureError;}}));
        await assert.rejects(reflectionJob,error=>error===captureError);assert.deepEqual(facts(id),before);
        await turn();assert.deepEqual(unhandled,[]);assert.equal(thenCalls,0);
        assert.equal((await write(method,id,2)).affectedRows,1,'manual later queue work survives refusal');
    } finally { process.removeListener('unhandledRejection',listener); }
}
async function queuedApi(method,mode) {
    const id=await seed();await Database.setSkill(skill(1),id);
    const entered=deferred(),gate=deferred();let armed=true,calls=0,active=true;
    const bag=mode==='invalid_replaced'?{beforeWrite:undefined}:{beforeWrite(){calls++;if(!active)throw new WorkerCommandAdmissionRefusal('stale_command');}};
    global.setImmediate=(callback,...args)=>{
        if(armed&&new Error().stack.includes('yieldToEventLoop')){
            armed=false;entered.resolve();return realImmediate(async()=>{await gate.promise;callback(...args);});
        }
        return realImmediate(callback,...args);
    };
    let job,control;
    try {
        control=Database.cooperatively(()=>Database.execute(['SELECT 1 AS native_skill_queue',[],{onTiming(){
            const end=Date.now()+2;while(Date.now()<end){ /* Reach the existing cooperative yield. */ }
        }}],'skill:control-read'),1);
        // cooperatively starts its work in a microtask. Wait for the actual
        // read yield before appending the write, rather than overtaking it.
        await wait(entered.promise,'actual queued skill read barrier');
        job=write(method,id,2,bag);const outcome=job.then(value=>({value}),error=>({error}));
        const before=facts(id);
        assert.equal(before.skills.find(row=>row.characterId===id&&row.selfId===3).level,1);
        if(mode==='stale')active=false;
        if(mode==='replaced')bag.beforeWrite=()=>{throw Error('must_not_adopt_replacement');};
        if(mode==='invalid_replaced')bag.beforeWrite=()=>undefined;
        gate.resolve();await control;const result=await outcome;
        if(mode==='current'||mode==='replaced'){
            assert.equal(result.value?.affectedRows,1);assert.equal(calls,1);
            assert.equal((await Database.fetchSkill(id,3))[0].level,2);
        } else {
            assert(result.error instanceof (mode==='stale'?WorkerCommandAdmissionRefusal:TypeError));
            assert.deepEqual(facts(id),before);assert.equal(calls,mode==='stale'?1:0);
        }
    } finally {
        gate.resolve();await control?.catch(()=>null);await job?.catch(()=>null);global.setImmediate=realImmediate;
    }
}
async function outwardErrors(stage) {
    const id=await seed(),error=stage==='brand'?new WorkerCommandAdmissionRefusal('stale_command'):Error(`injected_${stage}`);
    const unhandled=[],listener=found=>unhandled.push(found);
    const fetchSkill=Database.fetchSkill,fetchSkills=Database.fetchSkills;
    const fetchTree=Data.fetchSkillTreeFromClassId;
    let timer;process.on('unhandledRejection',listener);
    try {
        if(stage==='write_update')await Database.setSkill(skill(1),id);
        if(stage==='read')Database.fetchSkill=async function(...args){const rows=await fetchSkill.apply(this,args);if(args[0]===id)throw error;return rows;};
        if(stage==='populate')Database.fetchSkills=async function(...args){const rows=await fetchSkills.apply(this,args);if(args[0]===id)throw error;return rows;};
        if(stage==='callback')Data.fetchSkillTreeFromClassId=function(classId,callback){
            return fetchTree.call(this,classId,tree=>callback(Object.defineProperty(tree,'skills',{get(){throw error;}})));
        };
        const bag=['write','write_update','brand'].includes(stage)?{beforeWrite(){throw error;}}:undefined;
        const promise=Progression.reconcile({characterId:id,classId:0,level:7},bag);
        const outcome=await Promise.race([promise.then(value=>({value}),found=>({error:found})),
            new Promise(done=>{timer=setTimeout(()=>done({pending:true}),250);})]);
        assert.equal(outcome.error,error,'all native read/write/populate failures reject outward, without stranded wrapper');
        await turn();assert.deepEqual(unhandled,[]);
        if(stage==='write_update')assert.equal((await fetchSkill.call(Database,id,3))[0].level,1,'failed rank promotion preserves the native old rank');
        else if(stage!=='populate')assert.equal((await fetchSkills.call(Database,id)).length,0,'before-write failure has no prior skills');
        else assert.equal((await fetchSkills.call(Database,id)).length,9,'populate failure is after admitted skills, not rollback');
    } finally {clearTimeout(timer);Database.fetchSkill=fetchSkill;Database.fetchSkills=fetchSkills;Data.fetchSkillTreeFromClassId=fetchTree;process.removeListener('unhandledRejection',listener);}
}
async function producerCapture(kind) {
    const id=await seed(),entered=deferred(),gate=deferred(),fetchSkill=Database.fetchSkill;
    let reads=0,calls=0;const bag={beforeWrite(){calls++;}};
    Database.fetchSkill=async function(...args){const rows=await fetchSkill.apply(this,args);
        if(args[0]===id&&++reads===1){entered.resolve();await gate.promise;}return rows;};
    let job;
    try {
        job=kind==='award'?new Skillset().awardSkills(id,0,7,bag):Progression.reconcile({characterId:id,classId:0,level:7},bag);
        await wait(entered.promise,'real skill read before producer options mutation');
        assert.equal(facts(id).skills.filter(row=>row.characterId===id).length,0);
        bag.beforeWrite=()=>{throw Error('must_not_adopt_late_producer_options');};
        gate.resolve();await job;
        if(kind==='award')assert.equal(calls,9);else assert(calls>=9,'paid learning retains the captured callback at every native write');
        assert.equal((await Database.fetchSkills(id)).length,9);
    } finally {gate.resolve();await job?.catch(()=>null);Database.fetchSkill=fetchSkill;}
}
async function workerQueue(mode) {
    const id=await seed(),state=Life.snapshot(id),time=Date.now();
    const request={kind:'lifecycle',characterId:id,commandId:`skill:${serial}`,commandCheckpoint:Protocol.commandCheckpoint(state),
        state,context:{},precomputedResult:{patch:{activity:'resting',vitals:{...state.vitals,hp:90},stats:{restUntil:time+60000}},
            events:[],materialize:{exp:0,sp:0,adena:0,items:[]},nextResolveAt:time+60000}};
    const c=new ColdSimulationCoordinator(),sent=[],entered=deferred(),gate=deferred(),queued=deferred(),stopEntered=deferred(),stopGate=deferred();
    c.ready=true;c.workerEpoch=`skill:${serial}`;
    const worker=label=>({postMessage(message){sent.push({label,message:clone(message)});
        if(message.type==='fence')realImmediate(()=>c.onMessage(Protocol.envelope('fence_ack',message.workerEpoch,
            {characterId:id,proposal:null,token:null},message.msgId),c.worker,c.workerEpoch));
        if(message.type==='shutdown')realImmediate(()=>c.onMessage(Protocol.envelope('drained',message.workerEpoch,
            {ok:true},message.msgId),c.worker,c.workerEpoch));
    },terminate:async()=>{}});
    c.worker=worker('A');const originalWorker=c.worker,originalEpoch=c.workerEpoch;
    let admission,reads=0,control,stop;
    // Forward the actual gateway's real options. No Life/Skillset call or
    // native writer gets an artificial admission/result from this observer.
    c.population={executeWorkerLifecycleCommand(...args){admission=args[2]?.workerAdmission;
        return Population.executeWorkerLifecycleCommand(...args);}};
    c.contextIndex=()=>({});c.contextFor=()=>({});
    const fetchSkill=Database.fetchSkill,learnBotSkill=Database.learnBotSkill;
    Database.learnBotSkill=function(...args){if(args[0]===id)queued.resolve();return learnBotSkill.apply(this,args);};
    Database.fetchSkill=async function(...args){
        const rows=await fetchSkill.apply(this,args);
        if(args[0]===id&&++reads===1){
            assert.equal(admission?.check(),null,'current native INNER entry admitted the real origin');
            let armed=true;
            global.setImmediate=(callback,...values)=>{
                if(armed&&new Error().stack.includes('yieldToEventLoop')){
                    armed=false;entered.resolve();return realImmediate(async()=>{await gate.promise;callback(...values);});
                }
                return realImmediate(callback,...values);
            };
            control=Database.cooperatively(()=>Database.execute(['SELECT 1 AS real_worker_skill_queue',[],{onTiming(){
                const end=Date.now()+2;while(Date.now()<end){ /* Reach the existing cooperative yield. */ }
            }}],'skill:worker-control-read'),1);
        }
        return rows;
    };
    try {
        await c.onMessage(Protocol.envelope('command_request',originalEpoch,{requests:[request]},`skill-message:${serial}`),originalWorker,originalEpoch);
        await wait(entered.promise,'native Worker skill queue');await wait(queued.promise,'first real setSkill queued');
        assert(c.commandInflight.has(id));assert.equal(admission.check(),null);
        assert.equal(facts(id).skills.filter(row=>row.characterId===id).length,0);
        if(mode==='replace'){c.worker=worker('B');c.workerEpoch='skill:replacement';}
        if(mode==='stop'){c.started=true;c.competitionActions.stop=async()=>{stopEntered.resolve();await stopGate.promise;};
            stop=c.stop();await wait(stopEntered.promise,'actual stop wait');assert(c.stopping);}
        if(mode==='fence'){assert.equal((await c.fenceBot(id,10)).ok,true);assert(c.fencedBots.has(id));}
        if(mode==='changed'){
            const db=new DatabaseSync(options.default.Database.path);
            try{db.prepare('UPDATE bot_life_state SET updatedAt=? WHERE characterId=?').run(Date.now()+1000,id);
                Life.acceptLifecycleRow(db.prepare('SELECT * FROM bot_life_state WHERE characterId=?').get(id));}
            finally{db.close();}
            assert(!Protocol.sameCommandCheckpoint(request.commandCheckpoint,Life.cachedState(id)));
        }
        const before=facts(id);gate.resolve();await control;await c.commandTail;
        const after=facts(id),acks=sent.filter(row=>row.message.type==='command_ack');
        console.log(JSON.stringify({mode,skillsBefore:before.skills.filter(row=>row.characterId===id).length,
            skillsAfter:after.skills.filter(row=>row.characterId===id).length,
            changed:Object.keys(before).filter(key=>JSON.stringify(before[key])!==JSON.stringify(after[key])),
            receipts:acks.map(row=>[row.label,row.message.payload.results[0]?.reason])}));
        assert.equal(c.commandInflight.size,0);
        if(mode==='current'){
            assert.equal(after.skills.filter(row=>row.characterId===id).length,9);
            assert.equal(after.characters.find(row=>row.id===id).hp,90);assert.equal(acks.length,1);
            assert.equal(acks[0].label,'A');assert.equal(acks[0].message.payload.results[0].ok,true);
            assert.deepEqual(acks[0].message.payload.results[0].commandCheckpoint,request.commandCheckpoint);
        }else{
            assert.deepEqual(after,before,'retired source cannot execute the FIRST queued skill SQL or later ROW/physical writers');
            if(mode==='replace')assert.equal(acks.length,0);
            else{assert.equal(acks.length,1);const result=acks[0].message.payload.results[0];assert.equal(result.ok,false);
                assert.equal(result.reason,mode==='stop'?'coordinator_stopping':mode==='fence'?'hot_handoff_fenced':'stale_command');
                assert.equal(result.retryAfterMs,1000);assert.deepEqual(result.commandCheckpoint,request.commandCheckpoint);}
        }
    }finally{gate.resolve();await control?.catch(()=>null);await c.commandTail.catch(()=>null);
        Database.fetchSkill=fetchSkill;Database.learnBotSkill=learnBotSkill;global.setImmediate=realImmediate;stopGate.resolve();if(stop)await stop;}
}
async function check(name,work){try{await work();console.log('PASS',name);}catch(error){failures.push(name);console.error('FAIL',name,error.stack);}}
(async()=>{
    directory=fs.mkdtempSync(path.join(process.cwd(),'tmp','skill-write-native-'));
    options.default.Database.path=path.join(directory,'world.sqlite');options.default.Database.historyPath=path.join(directory,'history.sqlite');
    Database.init();assert(Database.isReady());Data.init();await Life.init();console.log('source',gameRoot);
    await check('manual native book / ancestor no-downgrade / unknown-rank-empty skips',manualParity);
    for(const method of ['insert','update']){
        await check(`native strict callback domain ${method}`,()=>nativeDomain(method));
        for(const mode of ['current','replaced','invalid_replaced','stale'])await check(`actual skill queue ${method}:${mode}`,()=>queuedApi(method,mode));
    }
    for(const stage of ['read','write','write_update','brand','populate','callback'])await check(`outward rejection ${stage}`,()=>outwardErrors(stage));
    for(const kind of ['award','reconcile'])await check(`producer method-time options capture ${kind}`,()=>producerCapture(kind));
    if(!process.argv.includes('--api-only'))for(const mode of ['current','replace','stop','fence','changed']){
        await check(`actual integrated Worker first skill ${mode}`,()=>workerQueue(mode));
    }
    if(failures.length)throw Error('skill admission contracts failed: '+failures.join(', '));
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
    await Database.close();if(directory)fs.rmSync(directory,{recursive:true,force:true});
});
