const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
require('../src/Global');
const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const Backpack = invoke('GameServer/Actor/Backpack');
const Service = invoke('GameServer/Quest/QuestService');
const Definitions = require('../src/GameServer/Quest/LowLevelDefinitions');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'l2-c4-definitions-'));
options.default.Database.path = path.join(directory, 'test.sqlite');
process.env.L2NODE_PROGRESSION_RATE = 'x1';
Object.assign(options.default.General, { questExpRate:1,questSpRate:1,questAdenaRate:1 });
async function sessionFor(id) {
    const [row] = await Database.execute(['SELECT * FROM characters WHERE id = ?', [id]]);
    const actor = { ...row, fetchId: () => id, fetchName: () => `Quest${id}`, fetchClanId: () => 0,
        fetchLevel() { return this.level; }, fetchRace() { return this.race; }, fetchClassId() { return this.classId; },
        fetchExp() { return this.exp; }, fetchSp() { return this.sp; }, setExpSp(exp,sp) { this.exp=exp;this.sp=sp; },
        backpack: new Backpack({items:await Database.fetchItems(id), paperdoll:{}}) };
    const session = {actor,dataSendToMe(){}};
    await Service.ensureLoaded(session); return session;
}
const amount = async (id,item) => (await Database.fetchItems(id)).filter(i=>i.selfId===item).reduce((sum,i)=>sum+i.amount,0);
function npcIsSpawned(selfId) {
    const id = Number(selfId);
    return DataCache.npcSpawns.some(group =>
        (group.spawns || []).some(spawn => Number(spawn.selfId) === id)
    );
}
async function main() {
    DataCache.init();
    const seed = new DatabaseSync(options.default.Database.path);
    seed.exec(fs.readFileSync(path.resolve(__dirname,'../database/sql/sqlite.sql'),'utf8'));
    seed.exec("INSERT INTO accounts(username,password) VALUES ('quests','test')");
    for (const d of Definitions) seed.prepare(`INSERT INTO characters(id,username,name,classId,race,level,exp,sp,maxHp,maxMp,hp,mp,sex,face,hair,hairColor,locX,locY,locZ)
        VALUES (?, 'quests', ?, 0, ?, 20, ?, 0, 187, 74, 187, 74, 0, 0, 0, 0, 0, 0, 0)`).run(d.id,`Quest${d.id}`,d.race??0,DataCache.experience[19]);
    seed.close(); Database.init();
    for (const d of Definitions) {
        const quest = Service.quests().find(q=>q.id===d.id);
        let s=await sessionFor(d.id);
        s.activeNpcTalk={selfId:d.startNpc,objectId:1};
        s.actor.level=d.minLevel-1;
        assert.equal(await Service.onEvent(s,{questId:d.id,name:'start'}),false,`Q${d.id} level gate`);
        s.actor.level=20;
        if(d.race!==undefined) {
            s.actor.race=(d.race+1)%5;
            assert.equal(await Service.onEvent(s,{questId:d.id,name:'start'}),false,`Q${d.id} race gate`);
            s.actor.race=d.race;
        }
        if(d.requiredAny) {
            assert.equal(await Service.onEvent(s,{questId:d.id,name:'start'}),false,'prerequisite item gate');
            await Service.giveItem(s,d.requiredAny[0],1);
        }
        await Service.onEvent(s,{questId:d.id,name:'start'});
        let state=s.questStates.get(d.id);
        assert.equal(state.state,'started');
        const objective=d.stages[0];
        const random=Math.random;
        if(d.id===325) {
            const kill=async(npc,roll=0)=>{Math.random=()=>roll;await quest.onKill(state,{fetchSelfId:()=>npc});};
            const talk=npc=>quest.onTalk(state,{fetchSelfId:()=>npc});
            const event=async(npc,name)=>{s.activeNpcTalk={selfId:npc,objectId:1};return Service.onEvent(s,{questId:d.id,name});};
            const reopen=async()=>{await Database.close();Database.init();s=await sessionFor(d.id);state=s.questStates.get(d.id);};
            const bones=async()=>{for(const [npc,roll] of [[35,.01],[35,.1],[35,.2],[42,.4],[35,.5]]) await kill(npc,roll);};
            try {
                await kill(26);assert.equal(await amount(d.id,1350),0,'diagram required before credit');
                assert.equal(await event(7342,'assemble'),false,'assembly before Samed denied');
                await talk(7336);assert.equal(state.getInt('cond'),1);
                await talk(7434);assert.equal(await amount(d.id,1349),1);assert.equal(state.getInt('cond'),2);
                const menu=await talk(7434);
                assert(menu.includes('sell_parts') && menu.includes('sell_skeletons'),'buyer exposes both payment choices');
                assert.equal(await event(7434,'sell_skeletons'),false,'no empty skeleton bonus');
                await bones();
                assert.equal(await event(7434,'assemble'),false,'assembly NPC guard');
                await reopen();const staleAssembly=await sessionFor(d.id);
                Math.random=()=>0;await event(7342,'assemble');
                for(const item of [1353,1354,1355,1356,1357]) assert.equal(await amount(d.id,item),0);
                assert.equal(await amount(d.id,1358),1,'successful assembly');
                await assert.rejects(quest.onEvent(staleAssembly.questStates.get(d.id),'assemble'),/step changed/);
                const staleSale=await sessionFor(d.id);
                await event(7434,'sell_skeletons');assert.equal(await amount(d.id,57),884);
                await assert.rejects(quest.onEvent(staleSale.questStates.get(d.id),'sell_skeletons'),/step changed/);
                assert.equal(await event(7434,'sell_skeletons'),false,'skeleton bonus cannot be replayed');
                for(let n=0;n<10;n++) await kill(26);
                await talk(7434);assert.equal(await amount(d.id,57),884,'opening buyer does not force sale');
                await event(7434,'sell_parts');assert.equal(await amount(d.id,57),1184,'exactly ten pieces receive no bulk bonus');
                await bones();Math.random=()=>0;await event(7342,'assemble');
                for(let n=0;n<10;n++) await kill(26);
                await reopen();const stalePayment=await sessionFor(d.id);
                await event(7434,'sell_parts');
                assert.equal(await amount(d.id,57),3997,'eleven pieces include 1629 bulk and 543 skeleton bonuses');
                await assert.rejects(quest.onEvent(stalePayment.questStates.get(d.id),'sell_parts'),/step changed/);
                await event(7434,'sell_parts');assert.equal(await amount(d.id,57),3997,'empty bulk sale earns nothing');
                await bones();Math.random=()=>.99;await event(7342,'assemble');
                for(const item of [1353,1354,1355,1356,1357,1358]) assert.equal(await amount(d.id,item),0,'failed assembly consumes pieces without reward');
                // Independent species/outcome checks, including both no-drop and guaranteed tables.
                for(const [npc,roll,item] of [[26,.4,1351],[29,.6,1352],[35,.2,1355],[42,.4,1356],[45,.85,1357],
                    [51,.99,1356],[457,.3,1350],[458,.99,1352],[514,.305,1356],[515,.4,1357]]) {
                    const before=await amount(d.id,item);await kill(npc,roll);assert.equal(await amount(d.id,item),before+1);
                }
                const beforeNoDrop=JSON.stringify(await Database.fetchItems(d.id));
                await kill(26,.99);assert.equal(JSON.stringify(await Database.fetchItems(d.id)),beforeNoDrop);
                assert.equal(await event(7336,'quit'),false,'quit payment belongs to Samed');
                await event(7434,'quit');assert.equal(state.state,'created');
                assert.equal(await amount(d.id,57),4171,'quit pays ten mixed pieces once (174)');
                for(const item of d.questItems) assert.equal(await amount(d.id,item),0,'quit clears diagram and all pieces');
                await reopen();assert.equal(await event(7434,'quit'),false,'restart preserves final paid receipt');
                await event(7336,'start');await talk(7434);assert.equal(await amount(d.id,1349),1,'repeatable diagram reset');
                await event(7434,'quit');assert.equal(await amount(d.id,57),4171,'empty quit adds no bonus');
            } finally {Math.random=random;}
            continue;
        }
        if(d.id===292) {
            const kill=async(npc,roll)=>{Math.random=()=>roll;await quest.onKill(state,{fetchSelfId:()=>npc});};
            const talk=npc=>quest.onTalk(state,{fetchSelfId:()=>npc});
            const event=async(npc,name)=>{s.activeNpcTalk={selfId:npc,objectId:1};return Service.onEvent(s,{questId:d.id,name});};
            const reopen=async()=>{await Database.close();Database.init();s=await sessionFor(d.id);state=s.questStates.get(d.id);};
            try {
                await kill(322,.99);assert.equal(await amount(d.id,1483),0,'no-drop outcome');
                await kill(999999,0);assert.equal(await amount(d.id,1483),0,'unrelated kills');
                await kill(322,.45);await kill(324,.45);
                assert.equal(await amount(d.id,1486),2);
                await reopen();
                const beforeConversion=await sessionFor(d.id);
                await kill(327,.45);
                assert.equal(await amount(d.id,1486),0,'three memos consumed together');
                assert.equal(await amount(d.id,1487),1);assert.equal(state.getInt('cond'),2);
                await assert.rejects(quest.onKill(beforeConversion.questStates.get(d.id),{fetchSelfId:()=>322}),/step changed/);
                await kill(322,.45);assert.equal(await amount(d.id,1486),0,'no further memos while holding contract');
                await talk(7532);assert.equal(await amount(d.id,57),0,'Spiron requires normal trophies with contract');
                assert.equal(await event(7532,'sell_contract'),false,'contract buyer NPC guard');
                await reopen();
                const beforeSale=await sessionFor(d.id);
                await event(7533,'sell_contract');
                assert.equal(await amount(d.id,57),1500);assert.equal(state.getInt('cond'),1);
                assert.equal(await amount(d.id,1487),0);
                await assert.rejects(quest.onEvent(beforeSale.questStates.get(d.id),'sell_contract'),/step changed/);
                assert.equal(await event(7533,'sell_contract'),false,'contract cannot be sold twice');
                for(let n=0;n<3;n++) await kill(322,.45);
                for(const npc of [322,323,324,327,528]) await kill(npc,0);
                await talk(7532);
                assert.equal(await amount(d.id,57),2725,'Spiron: 3*12 +36 +33 +1120, no threshold');
                assert.equal(state.getInt('cond'),1);assert.equal(await amount(d.id,1487),0);
                for(let n=0;n<10;n++) await kill(322,0);
                const beforePayment=await sessionFor(d.id);
                await talk(7532);
                assert.equal(await amount(d.id,57),3845,'ten necklaces: 120 plus 1000');
                await assert.rejects(quest.onTalk(beforePayment.questStates.get(d.id),{fetchSelfId:()=>7532}),/step changed/);
                await talk(7532);assert.equal(await amount(d.id,57),3845,'no empty-hand bonus');
                await kill(322,.45);await kill(323,0);
                await event(7532,'quit');assert.equal(state.state,'created');
                for(const item of d.questItems) assert.equal(await amount(d.id,item),0,'quit cleanup');
                await event(7532,'start');assert.equal(state.getInt('cond'),1,'repeatable reset');
            } finally {Math.random=random;}
            continue;
        }
        if(d.id===296) {
            try {
                Math.random=()=>.99;
                await quest.onKill(state,{fetchSelfId:()=>403});
                assert.equal(await amount(d.id,1493),0);assert.equal(await amount(d.id,1494),0);
                Math.random=()=>.2;
                for(let n=0;n<9;n++) await quest.onKill(state,{fetchSelfId:()=>403});
                await quest.onTalk(state,{fetchSelfId:()=>7519});
                assert.equal(await amount(d.id,57),180);
                Math.random=()=>0;
                for(let n=0;n<2;n++) await quest.onKill(state,{fetchSelfId:()=>508});
                assert.equal(await amount(d.id,1494),2,'exclusive rare outcome');
                await Database.close();Database.init();s=await sessionFor(d.id);state=s.questStates.get(d.id);
                const stale=await sessionFor(d.id);
                s.activeNpcTalk={selfId:7548,objectId:1};
                await Service.onEvent(s,{questId:d.id,name:'spin_silk'});
                assert.equal(await amount(d.id,1493),30,'minimum extraction amount');
                assert.equal(await amount(d.id,1494),0);
                await assert.rejects(quest.onEvent(stale.questStates.get(d.id),'spin_silk'),/step changed/);
                await quest.onTalk(state,{fetchSelfId:()=>7519});
                assert.equal(await amount(d.id,57),2780,'extracted silk earns ordinary threshold payout');
                await quest.onKill(state,{fetchSelfId:()=>403});
                Math.random=()=>.999;
                await Service.onEvent(s,{questId:d.id,name:'spin_silk'});
                assert.equal(await amount(d.id,1493),24,'maximum extraction amount');
                await quest.onAbort(state);
                assert.equal(await amount(d.id,1493),0);assert.equal(await amount(d.id,1494),0);
                assert.equal(await amount(d.id,1508),1,'eligibility ring retained');
            } finally {Math.random=random;}
            continue;
        }
        if(d.id===347) {
            try {
                Math.random=()=>0;
                const event=async(npc,name)=>{s.activeNpcTalk={selfId:npc,objectId:1};return Service.onEvent(s,{questId:347,name});};
                assert.equal(await event(7526,'keep_calculator'),false,'reward event before progression denied');
                assert.equal(await event(7533,'balanki'),false,'payment requires Adena');
                await Service.giveItem(s,57,200);
                for(const first of ['balanki','spiron']) {
                    const firstNpc=first==='balanki'?7533:7532;
                    assert.equal(await event(7526,first),false,'wrong NPC cannot select branch');
                    await event(firstNpc,first);
                    assert.equal(state.getInt('cond'),first==='balanki'?2:3);
                    assert.equal(await event(firstNpc,first),false,'same adviser cannot satisfy both consultations');
                    await Database.close();Database.init();s=await sessionFor(d.id);state=s.questStates.get(d.id);
                    await event(first==='balanki'?7532:7533,first==='balanki'?'spiron':'balanki');
                    assert.equal(state.getInt('cond'),4);
                    await quest.onTalk(state,{fetchSelfId:()=>7527});
                    assert.equal(state.getInt('cond'),5);
                    for(let n=0;n<12;n++) await quest.onKill(state,{fetchSelfId:()=>540});
                    assert.equal(await amount(d.id,4286),10);
                    await quest.onTalk(state,{fetchSelfId:()=>7527});
                    assert.equal(await amount(d.id,4285),1);
                    assert.equal(state.getInt('cond'),7);
                    const stale=await sessionFor(d.id);
                    await event(7526,first==='balanki'?'keep_calculator':'sell_calculator');
                    assert.equal(state.state,'created');
                    await assert.rejects(quest.onEvent(stale.questStates.get(d.id),'keep_calculator'),/step changed/);
                    assert.equal(await event(7526,'sell_calculator'),false,'reward cannot be reclaimed');
                    if(first==='balanki') await event(7526,'start');
                }
                assert.equal(await amount(d.id,57),1000,'two exact fees and one cash reward');
                assert.equal(await amount(d.id,4393),1,'one selected calculator reward');
                assert.equal(await amount(d.id,4285),0);
                assert.equal(state.getInt('completions'),2);
            } finally {Math.random=random;}
            continue;
        }
        if(objective.type==='COLLECT') {
            try {
                Math.random=()=>.999;
                if(objective.drops[0].chance<1) await quest.onKill(state,{fetchSelfId:()=>objective.drops[0].npc});
                assert.equal(await amount(d.id,objective.drops[0].item),0);
                Math.random=()=>0;
                for(let n=0;n<9;n++) await quest.onKill(state,{fetchSelfId:()=>objective.drops[0].npc});
                await quest.onTalk(state,{fetchSelfId:()=>d.startNpc});
                const first={259:225,263:180,306:540,316:270,317:360}[d.id];
                assert.equal(await amount(d.id,57),first,'below-threshold unit payout');
                assert.equal(state.state,'started');
                for(let n=0;n<10;n++) {
                    if(n===5) {await Database.close();Database.init();s=await sessionFor(d.id);state=s.questStates.get(d.id);}
                    const drop=objective.drops[n%2];
                    await quest.onKill(state,{fetchSelfId:()=>drop.npc});
                }
                const clone=await sessionFor(d.id);
                await quest.onTalk(state,{fetchSelfId:()=>999999});
                assert.equal(await amount(d.id,57),first);
                await quest.onTalk(state,{fetchSelfId:()=>d.startNpc});
                assert.equal(await amount(d.id,57),first+({259:500,263:1250,306:5600,316:5300,317:3388}[d.id]),'mixed-item threshold payout');
                await assert.rejects(quest.onTalk(clone.questStates.get(d.id),{fetchSelfId:()=>d.startNpc}),/step changed/);
                const before=await amount(d.id,57);
                await quest.onTalk(state,{fetchSelfId:()=>d.startNpc});
                assert.equal(await amount(d.id,57),before,'empty hand-in cannot repeat bonus');
                if(d.id===316) {
                    for(let n=0;n<20;n++) await quest.onKill(state,{fetchSelfId:()=>5020});
                    assert.equal(await amount(d.id,1043),1,'unique boss trophy cap');
                    await quest.onTalk(state,{fetchSelfId:()=>d.startNpc});
                    assert.equal(await amount(d.id,57),before+10000,'boss trophy alone does not earn rat threshold bonus');
                }
                if(d.id===259) {
                    s.activeNpcTalk={selfId:7405,objectId:1};
                    assert.equal(await Service.onEvent(s,{questId:259,name:'potion'}),false,'empty exchange denied');
                    for(let n=0;n<20;n++) await quest.onKill(state,{fetchSelfId:()=>103});
                    s.activeNpcTalk.selfId=7497;
                    assert.equal(await Service.onEvent(s,{questId:259,name:'potion'}),false,'wrong NPC exchange denied');
                    s.activeNpcTalk.selfId=7405;
                    await Service.onEvent(s,{questId:259,name:'potion'});
                    await Service.onEvent(s,{questId:259,name:'arrows'});
                    assert.equal(await amount(d.id,1061),1);assert.equal(await amount(d.id,17),50);
                    assert.equal(await amount(d.id,1495),0);
                    assert.equal(await Service.onEvent(s,{questId:259,name:'arrows'}),false,'exchanges cannot spend the same skins twice');
                }
                await quest.onKill(state,{fetchSelfId:()=>objective.drops[0].npc});
                s.activeNpcTalk={selfId:d.startNpc+1,objectId:1};
                assert.equal(await Service.onEvent(s,{questId:d.id,name:'quit'}),false);
                s.activeNpcTalk.selfId=d.startNpc;
                await Service.onEvent(s,{questId:d.id,name:'quit'});
                assert.equal(state.state,'created');
                assert.equal(await amount(d.id,objective.drops[0].item),0,'quit removes pending quest items');
                assert.equal(state.getInt('cashouts'),d.id===316?3:2);
                await quest.onEvent(state,'start');assert.equal(state.state,'started');
            } finally {Math.random=random;}
            continue;
        }
        if(objective.objectives) {
            try {
                Math.random=()=>0;
                for(const [item,needed] of objective.objectives) {
                    const drop=objective.drops.find(x=>x.item===item);
                    for(let n=0;n<needed+2;n++) await quest.onKill(state,{fetchSelfId:()=>drop.npc});
                    assert.equal(await amount(d.id,item),needed,'independent objective cap');
                    await Database.close();Database.init();s=await sessionFor(d.id);state=s.questStates.get(d.id);
                }
                assert.equal(state.getInt('cond'),2);
                const stale=await sessionFor(d.id);
                await quest.onTalk(state,{fetchSelfId:()=>d.startNpc});
                assert.equal(await amount(d.id,5956),1);
                await assert.rejects(quest.onTalk(stale.questStates.get(d.id),{fetchSelfId:()=>d.startNpc}),/step changed/);
                for(const [item] of objective.objectives) assert.equal(await amount(d.id,item),0);
                assert.equal(state.state,'created');
            } finally {Math.random=random;}
            continue;
        }
        if(objective.type==='KILL_COLLECT') {
        await quest.onKill(state,{fetchSelfId:()=>999999});
        assert.equal(await amount(d.id,objective.item),0);
        try {
            Math.random=()=>.9999;
            if(objective.drops[0].chance<1) {
                await quest.onKill(state,{fetchSelfId:()=>objective.drops[0].npc});
                assert.equal(await amount(d.id,objective.item),0,'failed drop has no mutation');
            }
            Math.random=()=>0;
            await quest.onKill(state,{fetchSelfId:()=>objective.drops[0].npc});
        } finally {Math.random=random;}
        await Database.close(); Database.init();
        s=await sessionFor(d.id);state=s.questStates.get(d.id);
        assert.equal(state.state,'started','collection survives database reopen');
        try {
            Math.random=()=>0;
            for(let n=0;n<objective.count+3;n++) await quest.onKill(state,{fetchSelfId:()=>objective.drops[0].npc});
        } finally {Math.random=random;}
        assert.equal(await amount(d.id,objective.item),objective.count,'bounded collection');
        }
        // Every repeatable definition still needs a real start NPC in the world.
        // This is a datapack/world invariant, not a bot-routing requirement.
        if(d.repeatable)
            assert(npcIsSpawned(d.startNpc), `Q${d.id} start NPC is spawned`);
        for(const stage of d.stages.filter(x=>['TALK','DELIVER'].includes(x.type))) {
            // Talking to the start NPC must not advance a stage that belongs to
            // somebody else. Q362 puts Swan himself in the middle of his own
            // chain, so the probe only applies when the stage is not his.
            if(stage.npc!==d.startNpc) {
                const held=state.getInt('cond');
                await quest.onTalk(state,{fetchSelfId:()=>d.startNpc});
                assert.equal(state.getInt('cond'),held,`Q${d.id} start NPC does not advance another stage`);
            }
            const cond=state.getInt('cond');
            const stale=await sessionFor(d.id);
            await quest.onTalk(state,{fetchSelfId:()=>stage.npc});
            assert.equal(state.getInt('cond'),cond+1);
            await assert.rejects(quest.onTalk(stale.questStates.get(d.id),{fetchSelfId:()=>stage.npc}),/step changed/);
            await Database.close();Database.init();s=await sessionFor(d.id);state=s.questStates.get(d.id);
        }
        const finishNpc=d.stages.at(-1).npc;
        const clone=await sessionFor(d.id);
        const before=(await Database.execute(['SELECT exp,sp FROM characters WHERE id=?',[d.id]]))[0];
        await quest.onTalk(state,{fetchSelfId:()=>d.startNpc+100000});
        assert.equal(state.state,'started','wrong NPC cannot deliver');
        try {
            Math.random=()=>0;
            await quest.onTalk(state,{fetchSelfId:()=>finishNpc});
        } finally {Math.random=random;}
        assert.equal(state.state,d.repeatable?'created':'completed','authored completion policy');
        assert.equal(state.getInt('completions'),1);
        const expectedRewards={151:[[102,1]],155:[[734,1]],156:[[5250,1]],160:[[1060,5]],161:[[57,1000]],258:[[390,1]],261:[[57,1000]],262:[[57,3000]],
            264:[[43,1]],271:[[1507,1]],272:[[57,1500]],277:[[1658,2]],291:[[1502,1]],294:[[1508,1]],295:[[1509,1]],
            297:[[1659,2]],303:[[57,1000]],313:[[57,3500]],319:[[57,3350],[1060,1]],320:[[57,8470]],324:[[57,5810]],341:[[57,3710]]};
        for(const [item,quantity] of expectedRewards[d.id]||[]) assert.equal(await amount(d.id,item),quantity,`Q${d.id} authored reward ${item}`);
        if(d.id===274) {
            assert.equal(await amount(d.id,57),27500,'forty bonus totems paid once with base reward');
            assert.equal(await amount(d.id,1501),0);
            assert.equal(await amount(d.id,1506),1,'prerequisite necklace is retained');
        }
        for(const [item] of d.stages.at(-1).takes||[]) assert.equal(await amount(d.id,item),0);
        const rewards=JSON.stringify(await Database.fetchItems(d.id));
        await assert.rejects(quest.onTalk(clone.questStates.get(d.id),{fetchSelfId:()=>finishNpc}),/step changed/,'stale session cannot duplicate reward');
        await quest.onTalk(state,{fetchSelfId:()=>finishNpc});
        assert.equal(JSON.stringify(await Database.fetchItems(d.id)),rewards);
        const after=(await Database.execute(['SELECT exp,sp FROM characters WHERE id=?',[d.id]]))[0];
        assert.equal(after.exp-before.exp,d.reward.exp||0,'quest EXP commits once');
        assert.equal(after.sp-before.sp,d.reward.sp||0,'quest SP commits once');
        await quest.onEvent(state,'start');
        if(!d.repeatable) {assert.equal(state.state,'completed','one-time quest cannot restart');continue;}
        assert.equal(state.state,'started');
        await quest.onAbort(state);
        assert.equal(state.state,'created');
        assert.equal(state.getInt('completions'),1,'abort preserves completion receipts');
        if([294,295].includes(d.id)) {
            await quest.onEvent(state,'start');
            try {
                Math.random=()=>0;
                for(let n=0;n<objective.count;n++) await quest.onKill(state,{fetchSelfId:()=>objective.drops[0].npc});
                await quest.onTalk(state,{fetchSelfId:()=>d.startNpc});
            } finally {Math.random=random;}
            assert.equal(await amount(d.id,57),2400,'owned ring chooses Adena alternative');
            assert.equal(await amount(d.id,d.id===294?1508:1509),1,'repeat does not duplicate unique ring');
        }
    }
    // Focused multiple-objective test uses known local item templates. Q379
    // itself stays disabled until its five missing templates are restored.
    const multi=require('../src/GameServer/Quest/DeclarativeQuest').create({id:313,name:'Multi-objective fixture',minLevel:1,startNpc:7150,repeatable:true,
        stages:[{type:'KILL_COLLECT',objectives:[[1118,2],[1045,3]],drops:[{npc:509,item:1118,chance:1},{npc:15,item:1045,chance:1}]},
            {type:'COMPLETE',npc:7150,takes:[[1118,2],[1045,3]]}],reward:{items:[[1060,1]]}});
    let multiSession=await sessionFor(313),multiState=multiSession.questStates.get(313);
    await multi.onEvent(multiState,'start');
    for(let n=0;n<5;n++) await multi.onKill(multiState,{fetchSelfId:()=>509});
    assert.equal(multiState.getInt('cond'),1);
    assert.equal(await amount(313,1118),2);
    await multi.onTalk(multiState,{fetchSelfId:()=>7150});
    assert.equal(multiState.state,'started','one objective is insufficient');
    await Database.close();Database.init();multiSession=await sessionFor(313);multiState=multiSession.questStates.get(313);
    for(let n=0;n<5;n++) await multi.onKill(multiState,{fetchSelfId:()=>15});
    assert.equal(await amount(313,1045),3);assert.equal(multiState.getInt('cond'),2);
    await multi.onTalk(multiState,{fetchSelfId:()=>7150});
    assert.equal(multiState.state,'created');assert.equal(await amount(313,1060),1);
    assert.equal(await amount(313,1118),0);assert.equal(await amount(313,1045),0);
    console.log(`${Definitions.length} declarative quests: eligibility, NPC guards, kills, caps, restart, atomic rewards, stale-session rejection and reset passed`);
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{await Database.close();fs.rmSync(directory,{recursive:true,force:true});});
