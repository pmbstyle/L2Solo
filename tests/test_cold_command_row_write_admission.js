const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const gameRoot = process.env.N53_GAME_ROOT || path.resolve(__dirname, '..');
require(path.join(gameRoot, 'tests/helpers/databaseIsolation'));
const isolated = require(path.join(gameRoot, 'tests/helpers/isolatedSocialDatabase'))('command-row-write-admission-profile', gameRoot);
const { DatabaseSync } = require('node:sqlite');
require(path.join(gameRoot, 'src/Global'));
isolated.assertConfigured(options.default);
const Database = invoke('Database');
const Data = invoke('GameServer/DataCache');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Population = invoke('GameServer/Bot/Population/PopulationService');
const Protocol = invoke('GameServer/Bot/Population/ColdSimulationProtocol');
const { ColdSimulationCoordinator } = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const { WorkerCommandAdmissionRefusal } = require(path.join(gameRoot, 'src/GameServer/Bot/Population/WorkerCommandAdmission'));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const clone = value => JSON.parse(JSON.stringify(value));
const realImmediate = setImmediate;
const turn = () => new Promise(done => realImmediate(done));
async function wait(promise, label) {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('timeout: '+label)), 3000); })]); }
    finally { clearTimeout(timer); }
}
let directory = isolated.directory, serial = 0, savedStatement;
const failures = [];
function facts(id) {
    // Own generated DB only. An independent readonly connection observes the
    // real queryTail held before SQL without queueing behind that tail itself.
    const db = new DatabaseSync(options.default.Database.path, { readOnly: true });
    try {
        const result = {};
        for (const table of ['bot_life_state','characters','skills','items','warehouse_items','afk_trade_shops','afk_trade_lines']) {
            result[table] = clone(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
        }
        result.cache = clone(Life.cachedState(id)); return result;
    } finally { db.close(); }
}
const preparedSkills = new Map();
async function prepareNativeProfile(id) {
    const input = Life.snapshot(id);
    const before = facts(id);
    assert.equal(before.characters.find(row => row.id === id).level, 7);
    assert.equal(before.characters.find(row => row.id === id).exp, input.exp);
    assert.equal(before.characters.find(row => row.id === id).sp, 120);
    assert.equal(input.sp, 120);
    const beforeWrite = Database.createColdTrainingGuard(input, () => {
        assert.equal(Life.cachedState(id), input);
    });
    const training = await invoke('GameServer/Bot/BotClassProgression').reconcile({
        characterId: id, classId: 0, level: 7, seed: id,
    }, { beforeWrite });
    // Authored class0 order: Power Strike ranks1/2 cost50 each; remaining20
    // cannot buy rank3. Lucky/CommonCraft/CreateCommon each cost0 at level7.
    assert.equal(training.spentSp, 100);
    assert.equal(training.learnedCount, 5);
    assert.deepEqual(training.consumedBooks, []);
    assert.deepEqual(training.transitions, []);
    const row = await Database.publishColdTraining(id, training, { beforeWrite });
    const accepted = Life.acceptNewerLifecycleRow(row);
    assert.equal(accepted, Life.cachedState(id));
    assert.equal(accepted.level, 7); assert.equal(accepted.exp, input.exp);
    assert.equal(accepted.sp, 20); assert.equal(accepted.stats.classId, 0);
    assert.equal(invoke('GameServer/Skills/SkillBookCatalog').needsTraining(accepted), false);
    const after = facts(id), skills = after.skills.filter(skill => skill.characterId === id);
    assert.deepEqual(skills.map(skill => [skill.selfId, skill.level]).sort((a, b) => a[0] - b[0]),
        [[3, 2], [194, 1], [1320, 1], [1322, 1]]);
    assert.equal(after.characters.find(character => character.id === id).sp, accepted.sp);
    for (const table of ['items', 'warehouse_items', 'afk_trade_shops', 'afk_trade_lines'])
        assert.deepEqual(after[table], before[table], 'native profile preparation never changes physical items/trade');
    assert(!Protocol.sameCommandCheckpoint(Protocol.commandCheckpoint(input), accepted), 'publishColdTraining legitimately rebases the checkpoint');
    preparedSkills.set(id, clone(skills));
    console.log('NATIVE_PRETRAIN', JSON.stringify({ id, allocatedSp: 120, training, physicalSp: accepted.sp,
        skills, checkpointBefore: Protocol.commandCheckpoint(input), checkpointAfter: Protocol.commandCheckpoint(accepted) }));
}

async function seed() {
    const account = `bot_postentry_${++serial}`;
    await Database.createAccount(account, 'fixture');
    const id = Number((await Database.createCharacter(account, { name: `PostEntry${serial}`, race: 0,
        classId: 0, sex: 0, face: 0, hair: 0, hairColor: 0, maxHp: 100, maxMp: 100,
        locX: 83000, locY: 148000, locZ: -3400 })).insertId);
    await Database.setItem(id, { selfId:57, name:'Adena', amount:1000, equipped:false, enchant:0, slot:0 });
    const level = 7, time = Date.now();
    assert(await Life.upsertState({ characterId:id, accountName:account, name:`PostEntry${serial}`,
        phase:'cold', activity:'resting', level, exp:Number(Data.experience[level-1])+1, sp:120, adena:1000,
        inventory:Life.inventorySummaryFromItems(await Database.fetchItems(id)),
        loc:{ locX:83000, locY:148000, locZ:-3400 }, vitals:{hp:85,maxHp:100,mp:70,maxMp:100},
        timing:{lastResolvedAt:time-45000,nextResolveAt:time+30000},
        stats:{classId:0,classProgressionLevel:level,
            classProgressionClassId:0,restUntil:time+30000} }, 'postentry_seed'));
    await prepareNativeProfile(id);
    return id;
}
function requestFor(state) {
    return { kind:'lifecycle',characterId:state.characterId,commandId:`row-write:${serial}`,
        commandCheckpoint:Protocol.commandCheckpoint(state),state,context:{},
        precomputedResult:{patch:{activity:'resting',vitals:{...state.vitals,hp:90},stats:{restUntil:Date.now()+60000}},
            events:[],materialize:{exp:0,sp:0,adena:0,items:[]},nextResolveAt:Date.now()+60000} };
}
async function queued(mode) {
    const id=await seed(), state=Life.snapshot(id), request=requestFor(state);
    const gate=deferred(),entered=deferred(),saveQueued=deferred(),stopEntered=deferred(),stopGate=deferred();
    const c=new ColdSimulationCoordinator(),sent=[];
    c.ready=true;c.workerEpoch=`row-write:${serial}`;
    const worker=label=>({postMessage(message){
        sent.push({label,message:clone(message)});
        if(message.type==='fence') realImmediate(()=>c.onMessage(Protocol.envelope('fence_ack',message.workerEpoch,
            {characterId:id,proposal:null,token:null},message.msgId),c.worker,c.workerEpoch));
        if(message.type==='shutdown') realImmediate(()=>c.onMessage(Protocol.envelope('drained',message.workerEpoch,
            {ok:true},message.msgId),c.worker,c.workerEpoch));
    },terminate:async()=>{}});
    c.worker=worker('A');const originalWorker=c.worker,originalEpoch=c.workerEpoch;
    let admission,prepareCalls=0,nativeBarrier,stop,dbOptions;
    c.population={executeWorkerLifecycleCommand(...args){admission=args[2]?.workerAdmission;return Population.executeWorkerLifecycleCommand(...args);}};
    c.contextIndex=()=>({});c.contextFor=()=>({});
    const prepare=Life.prepareResolve,save=Database.saveBotLifeState;
    Database.saveBotLifeState=function(...args){
        savedStatement=clone(args[0]);dbOptions=args[1];
        if(mode==='ordinary_error') args[1]={beforeWrite(){const error=new Error('ordinary_before_write');error.code='BOT_WORKER_COMMAND_ADMISSION_REFUSED';throw error;}};
        if(mode==='brand_error') args[1]={beforeWrite(){throw new WorkerCommandAdmissionRefusal('stale_command');}};
        if(mode==='invalid_replaced') {args[1]={beforeWrite:undefined};dbOptions=args[1];}
        saveQueued.resolve();return save.apply(this,args);
    };
    Life.prepareResolve=function(...args){
        prepareCalls++;assert.equal(admission?.check(),null,'the actual INNER source was admitted before this queued first writer');
        let armed=true;
        global.setImmediate=(callback,...values)=>{
            if(armed&&new Error().stack.includes('yieldToEventLoop')){
                armed=false;entered.resolve();return realImmediate(async()=>{await gate.promise;callback(...values);});
            }
            return realImmediate(callback,...values);
        };
        nativeBarrier=Database.cooperatively(()=>Database.execute(['SELECT 1 AS actual_queue_control',[],{onTiming(){
            const end=Date.now()+2;while(Date.now()<end){ /* Reach the existing 1ms cooperative yield. */ }
        }}],'row-write:control-read'),1);
        return prepare.apply(this,args);
    };
    try {
        await c.onMessage(Protocol.envelope('command_request',originalEpoch,{requests:[request]},`row-message:${serial}`),originalWorker,originalEpoch);
        await wait(entered.promise,'actual queryTail yield');await wait(saveQueued.promise,'actual first row SQL queued');
        assert.equal(prepareCalls,1);assert(c.commandInflight.has(id));assert.equal(admission.check(),null);
        const initial=facts(id);
        assert.equal(initial.characters.find(row=>row.id===id).hp,85);assert.equal(initial.bot_life_state.find(row=>row.characterId===id).hp,85);
        assert.deepEqual(initial.skills.filter(row=>row.characterId===id),preparedSkills.get(id),
            'prepared native skill facts are unchanged before this row-only writer');
        if(mode==='replace'){c.worker=worker('B');c.workerEpoch='row-write:replacement';}
        if(mode==='changed'){
            // Native durable/cache checkpoint change against the SAME own DB;
            // the queued connection cannot be used until its actual tail resumes.
            const db=new DatabaseSync(options.default.Database.path);
            try {db.prepare('UPDATE bot_life_state SET updatedAt=? WHERE characterId=?').run(Date.now()+1000,id);
                Life.acceptLifecycleRow(db.prepare('SELECT * FROM bot_life_state WHERE characterId=?').get(id));}
            finally{db.close();}
            assert(!Protocol.sameCommandCheckpoint(request.commandCheckpoint,Life.cachedState(id)));
        }
        if(mode==='fence'){const result=await c.fenceBot(id,10);assert.equal(result.ok,true);assert(c.fencedBots.has(id));}
        if(mode==='stop'){c.started=true;c.competitionActions.stop=async()=>{stopEntered.resolve();await stopGate.promise;};
            stop=c.stop();await wait(stopEntered.promise,'actual stop adjacent wait');assert(c.stopping);assert.equal(c.worker,originalWorker);}
        if(mode==='callback_replaced'){assert(dbOptions);dbOptions.beforeWrite=()=>{throw Error('must_not_adopt_new_callback');};}
        if(mode==='invalid_replaced') dbOptions.beforeWrite=()=>undefined;
        const before=facts(id);gate.resolve();await nativeBarrier;await c.commandTail;
        const after=facts(id),receipts=sent.filter(row=>row.message.type==='command_ack');
        console.log(JSON.stringify({mode,prepareCalls,hpBefore:before.characters.find(row=>row.id===id).hp,
            hpAfter:after.characters.find(row=>row.id===id).hp,
            changed:Object.keys(before).filter(key=>JSON.stringify(before[key])!==JSON.stringify(after[key])),
            receipts:receipts.map(row=>[row.label,row.message.payload.results[0]?.reason])}));
        assert.equal(c.commandInflight.size,0);
        if(mode==='current'||mode==='callback_replaced'){
            assert.equal(after.characters.find(row=>row.id===id).hp,90);assert.equal(receipts.length,1);
            assert.equal(receipts[0].label,'A');assert.equal(receipts[0].message.payload.results[0].ok,true);
            assert.deepEqual(receipts[0].message.payload.results[0].commandCheckpoint,request.commandCheckpoint);
            assert(!Protocol.sameCommandCheckpoint(request.commandCheckpoint,after.cache),
                'planned output timing is legitimate progression, not the original admission input');
        } else {
            assert.deepEqual(after,before,'refusal before the first queued row preserves all native/cache facts');
            if(mode==='replace')assert.equal(receipts.length,0);
            else {assert.equal(receipts.length,1);const result=receipts[0].message.payload.results[0];assert.equal(result.ok,false);
                assert.deepEqual(result.commandCheckpoint,request.commandCheckpoint);
                assert.equal(result.reason,mode==='stop'?'coordinator_stopping':mode==='fence'?'hot_handoff_fenced'
                    :mode==='ordinary_error'||mode==='invalid_replaced'?'apply_failed':'stale_command');
                if(mode==='brand_error')assert.equal(result.retryAfterMs,1000);}
        }
    } finally {
        gate.resolve();await nativeBarrier?.catch(()=>null);await c.commandTail.catch(()=>null);
        global.setImmediate=realImmediate;Life.prepareResolve=prepare;Database.saveBotLifeState=save;
        stopGate.resolve();if(stop)await stop;
    }
}
async function manualAndPolicy() {
    const id=await seed(),state=Life.snapshot(id),request=requestFor(state);
    assert.equal((await Population.executeWorkerLifecycleCommand(state,request)).ok,true);
    const actual=Life.snapshot(id);
    await Database.execute(['INSERT INTO bot_market_counts(characterId,counter,deals) VALUES(?,?,9)', [id, 'material none']]);
    Life.acceptMarketTrades(id, { 'material none': 9 });
    // Stale cached stats never replace DB-owned counts, even in manual saves.
    assert.equal((await Population.executeWorkerLifecycleCommand(actual,requestFor(actual))).ok,true);
    const stats=JSON.parse(facts(id).bot_life_state.find(row=>row.characterId===id).statsJson);
    assert.equal(stats.marketTrades,undefined);assert.deepEqual(Life.cachedState(id).marketTrades,{'material none':9});
    assert.equal((await Database.execute(['SELECT deals FROM bot_market_counts WHERE characterId=? AND counter=?', [id, 'material none']]))[0].deals,9);
    const owner=await seed(),old=Life.snapshot(owner);
    assert.equal((await Owner.claimBatch([old],{allowLifecycle:true,leaseMs:120000})).grants.length,1);
    const claimed=facts(owner),result=await Population.executeWorkerLifecycleCommand(old,requestFor(old));
    assert.equal(result.ok,false);assert.equal(result.reason,'apply_failed');assert.deepEqual(facts(owner),claimed);
    const versioned=await seed(),stale=Life.snapshot(versioned);
    await Database.execute(["UPDATE bot_life_state SET statsJson=json_set(statsJson,'$.clanInventoryRevision',1) WHERE characterId=?",[versioned]]);
    const before=facts(versioned),rejected=await Population.executeWorkerLifecycleCommand(stale,requestFor(stale));
    assert.equal(rejected.ok,false);assert.equal(rejected.reason,'apply_failed');assert.deepEqual(facts(versioned),before);
    const projected=await seed(),projectState=Life.snapshot(projected),projectBefore=facts(projected);
    const output=await Life.prepareResolve(projectState,requestFor(projectState).precomputedResult,
        {persist:false,projectClassProgression:true,workerAdmission:undefined});
    assert.equal(output.vitals.hp,90);assert.deepEqual(facts(projected),projectBefore,
        'persist:false remains a projection with no row admission or native/cache write');
    const released=await seed(),cold=Life.snapshot(released);
    assert(await Life.upsertState({...cold,phase:'hot'},'manual_hot'));
    const hotBefore=facts(released);
    assert.equal(await Life.upsertState({...cold,adena:999},'manual_stale_cold'),null);
    assert.deepEqual(facts(released),hotBefore,'manual cold save still cannot replace a hot row');
    assert.equal((await Life.upsertState(cold,'manual_release_hot',{releaseHot:true})).phase,'cold');
}
async function callbackDomain() {
    assert(savedStatement);const id=Number(savedStatement[1][0]),unhandled=[];
    const onUnhandled=error=>unhandled.push(error);process.on('unhandledRejection',onUnhandled);
    let called=0,thenCalls=0;
    try {
        assert.equal((await Database.saveBotLifeState(savedStatement)).affectedRows,1);
        assert.equal((await Database.saveBotLifeState(savedStatement,undefined)).affectedRows,1);
        // All refusals propose a real row change, so SQL-before-throw cannot
        // hide behind an idempotent rewrite of the already persisted row.
        const proposal=clone(savedStatement);
        proposal[1][19]=94; // hp in the captured, unmodified lifecycle INSERT
        assert.notEqual(facts(id).bot_life_state.find(row=>row.characterId===id).hp,94);
        assert.equal((await Database.saveBotLifeState(proposal,{beforeWrite(){called++;}})).affectedRows,1);assert.equal(called,1);
        assert.equal(facts(id).bot_life_state.find(row=>row.characterId===id).hp,94,
            'the exact malformed-domain proposal really mutates with a synchronous void admission');
        assert.equal((await Database.saveBotLifeState(savedStatement)).affectedRows,1);
        const before=facts(id);
        const accessor=Object.defineProperty({},'beforeWrite',{get(){throw Error('must_not_evaluate_accessor');}});
        const inherited=Object.create({beforeWrite(){throw Error('must_not_adopt_inherited');}});
        const invalid=[null,[],1,()=>undefined,{beforeWrite:undefined},{beforeWrite:null},{beforeWrite:1},accessor,inherited,
            {beforeWrite:()=>null},{beforeWrite:()=>true},{beforeWrite:()=>0},{beforeWrite:()=>({})},
            {beforeWrite:async()=>undefined},{beforeWrite:()=>Promise.reject(Error('native_rejected_guard'))},
            {beforeWrite:()=>Promise.reject(new WorkerCommandAdmissionRefusal('stale_command'))},
            {beforeWrite:()=>({then(){thenCalls++;}})},
            {beforeWrite:()=>Object.defineProperty({},'then',{get(){thenCalls++;throw Error('must_not_read_then');}})}];
        for(let index=0;index<invalid.length;index++){
            await assert.rejects(Database.saveBotLifeState(proposal,invalid[index]),error=>error instanceof TypeError,
                `malformed callback ${index} rejects in the normal queue`);
            assert.deepEqual(facts(id),before,`malformed callback ${index} writes no SQL/cache facts`);
        }
        await turn();assert.deepEqual(unhandled,[]);assert.equal(thenCalls,0,'arbitrary thenable is never executed');
        const ordinary=Object.assign(new Error('plain_same_code'),{code:'BOT_WORKER_COMMAND_ADMISSION_REFUSED'});
        const branded=new WorkerCommandAdmissionRefusal('stale_command');
        for(const error of [ordinary,branded])await assert.rejects(Database.saveBotLifeState(proposal,{beforeWrite(){throw error;}}),found=>found===error);
        const metadataError=new Error('original_descriptor_failure');
        const proxy=new Proxy({},{getOwnPropertyDescriptor(){throw metadataError;}});
        // Capture errors reject through the one existing queue, rather than
        // throwing synchronously or retrying metadata against a later bag.
        const metadataJob=Database.saveBotLifeState(proposal,proxy);
        await assert.rejects(metadataJob,error=>error===metadataError);
        assert.deepEqual(facts(id),before);assert.equal((await Database.saveBotLifeState(proposal)).affectedRows,1,'a later valid native job survives queued refusal');
        assert.equal(facts(id).bot_life_state.find(row=>row.characterId===id).hp,94);
    } finally{process.removeListener('unhandledRejection',onUnhandled);}
}
async function check(name,work){try{await work();console.log(`PASS ${name}`);}catch(error){failures.push(name);console.error(`FAIL ${name}: ${error.stack}`);}}
(async()=>{
    Database.init();assert(Database.isReady());Data.init();await Life.init();
    console.log('source',gameRoot);
    for(const mode of ['current','replace','stop','fence','changed','callback_replaced','invalid_replaced','ordinary_error','brand_error']) {
        await check(`actual queued first row ${mode}`,()=>queued(mode));
    }
    await check('manual omitted / marketTrades / owner and version / projection / releaseHot guards',manualAndPolicy);
    await check('native callback presence/type/return/error domain and queue cleanup',callbackDomain);
    if(failures.length)throw Error('native queued ROW contracts failed: '+failures.join(', '));
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
    await Database.close();if(directory)fs.rmSync(directory,{recursive:true,force:true});
});
