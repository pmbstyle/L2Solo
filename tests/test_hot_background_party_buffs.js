const assert = require('assert');
require('../src/Global');
const Hot = invoke('GameServer/Bot/AI/HotBackgroundParty');
const Planner = invoke('GameServer/Bot/AI/BotSupportPlanner');
const Parties = invoke('GameServer/Bot/Population/BackgroundPartyState');
const World = invoke('GameServer/World/World');
const State = invoke('GameServer/Model/State');
const Store = invoke('GameServer/Effects/EffectStore');
const Tactics = invoke('GameServer/Bot/AI/BotPvpTactics');
const Awareness = invoke('GameServer/Bot/AI/PartyAwareness');
const Revival = invoke('GameServer/Bot/AI/PartyRevivalService');
const saved = [];
function patch(o,k,v) { const old=o[k]; saved.push(()=>o[k]=old); o[k]=v; }
function skill(id,level,effect,stats) { return { fetchSelfId:()=>id, fetchLevel:()=>level, fetchName:()=>effect,
    fetchPassive:()=>false, fetchConsumedMp:()=>5, fetchTargetKind:()=> 'friendly', fetchDistance:()=>600,
    fetchCalculatedHitTime:()=>2000, fetchSemantic:()=>({effectType:'buff',target:'friendly',effect,stats}) }; }
function member(id, classId, skills=[]) {
    const state=new State();
    const actor={state,x:0,mp:100,fetchId:()=>id,fetchName:()=>`buff_${id}`,fetchClassId:()=>classId,
        fetchLocX(){return this.x;},fetchLocY:()=>0,fetchLocZ:()=>0,fetchHead:()=>0,
        fetchIsOnline:()=>true,isDead:()=>state.fetchDead(), fetchHp:()=>100,fetchMaxHp:()=>100,
        fetchMp(){return this.mp;},fetchMaxMp:()=>100,canUseSkill:()=>true,skillset:{fetchSkills:()=>skills},
        select(){},unselect(){},automation:{abortAll(){},replenishVitals(){}},moveTo(){throw Error('Unexpected regroup');}};
    const s={actor,hotBackgroundPartyId:'buffs',dataSendToOthers(){}};actor.session=s;return s;
}
try {
    const shield=skill(1040,3,'shield',{pDefMul:1.15});
    const weaker=skill(1040,1,'shield',{pDefMul:1.08});
    const empower=skill(1059,1,'empower',{mAtkMul:1.2});
    const leader=member(2000100,0), buffer=member(2000101,17,[shield,empower]), mage=member(2000102,25,[weaker]);
    const group=[leader,buffer,mage];
    patch(Parties,'find',()=>({partyId:'buffs',status:'hot',leaderId:2000100,memberIds:group.map(s=>s.actor.fetchId()),stats:{}}));
    patch(World,'user',{sessions:group});patch(World,'fetchNpcsInRadius',()=>[]);
    let incoming=null, danger=false, healed=false;
    patch(Awareness,'npcThreateningActor',()=>incoming);
    patch(Revival,'partyCombatInProgress',()=>danger);
    patch(Tactics,'support',()=>healed);
    const casts=[]; let defer=false;
    const Generics={skillExec(s,a,data){
        const k=a.skillset.fetchSkills().find(k=>k.fetchSelfId()===data.selfId);
        const target=group.find(m=>m.actor.fetchId()===data.id).actor;
        casts.push({s,a,k,target});
        if(!defer){assert(Planner.beginSupportCast(s,a,target,k));a.state.setCasts(true);}
    }};
    const AI={executeCombat(){}};
    const tick=s=>Hot.tick(s,s.actor,Generics,AI);
    const land=()=>{const {s,a,k,target}=casts.at(-1), sem=k.fetchSemantic();
        Store.apply(target,{key:sem.effect,id:k.fetchSelfId(),level:k.fetchLevel(),type:'buff',stats:sem.stats,durationMs:1200000});
        a.state.setCasts(false);Planner.finishSupportCast(s,a,k);
        assert.strictEqual(s.lastSupportOutcome.outcome,'landed');};
    tick(leader);assert.strictEqual(leader.lastDecision.action,'party_wait_buffs');
    tick(buffer);assert.strictEqual(casts.length,1);assert.strictEqual(casts[0].k,shield);
    tick(buffer);tick(mage);tick(leader);assert.strictEqual(casts.length,1,'cast and group aura ownership prevent duplicate/overwriting actions');
    land();
    for(let i=0;i<10;i++){const before=casts.length;group.forEach(tick);if(casts.length===before)break;land();}
    assert.strictEqual(casts.length,5,'three shields and Empower for the two casters only');
    assert(!Store.list(leader.actor).some(e=>e.key==='empower'),'physical member must not receive a caster buff');
    const completed=casts.length;group.forEach(tick);assert.strictEqual(casts.length,completed,'fresh effects do not trigger rebuff');
    let testNow=Date.now()+6000;
    patch(Date,'now',()=>testNow);
    Store.remove(leader.actor,'shield');
    healed=true;tick(buffer);assert.strictEqual(casts.length,completed,'healing owns the action before routine buffs');healed=false;
    danger=true;tick(buffer);assert.strictEqual(casts.length,completed,'party combat blocks preparation');danger=false;
    buffer.actor.mp=20;mage.actor.mp=20;group.forEach(tick);assert.strictEqual(casts.length,completed,'low MP cannot be spent on a routine buff');
    buffer.actor.mp=100;mage.actor.mp=100;testNow+=1000;
    defer=true;tick(buffer);assert.strictEqual(casts.length,completed+1,'missing effect is refreshed with the learned stronger skill');
    buffer.actor.x=800;tick(buffer);assert.strictEqual(buffer.lastDecision.action,'party_buff_approach','native approach survives the ordinary regroup threshold');
    buffer.actor.x=0;
    incoming={fetchId:()=>3000200,fetchKind:()=> 'Monster',fetchLocX:()=>100,fetchLocY:()=>0,fetchLocZ:()=>0,isDead:()=>false};
    tick(buffer);assert.strictEqual(buffer.pendingSupportCast,undefined,'an incoming attacker cancels pending preparation');
    console.log('Hot party buffs: shared planning, native reservations, effect completion, role utility, MP, healing, defense and approach passed');
} finally { saved.reverse().forEach(fn=>fn()); }
