const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
require('../src/Global');
const EnterWorld = invoke('GameServer/Actor/Generics/EnterWorld');
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Store = invoke('GameServer/Effects/EffectStore');
const Ticker = invoke('GameServer/Effects/EffectTicker');
const Planner = invoke('GameServer/Bot/AI/BotSupportPlanner');
const Generics = invoke('GameServer/Actor/Generics');
const Data = invoke('GameServer/DataCache');
const ConsoleText = invoke('GameServer/ConsoleText');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l2-effect-handoff-'));
const dbPath = path.join(dir, 'handoff.sqlite');
const saved = [], actors = [];
function patch(o,k,v) { const old=o[k]; saved.push(()=>o[k]=old); o[k]=v; }
function actor(legacy = []) {
    const a = { model:{effects:JSON.stringify(legacy)}, hp:115, mp:40,
        fetchId:()=>2000123, fetchName:()=> 'Handoff', fetchLevel:()=>20,
        fetchHp(){return this.hp;},setHp(v){this.hp=v;},fetchMp(){return this.mp;},setMp(v){this.mp=v;},
        fetchMaxHp(){return this.maxHp||100;},fetchMaxMp:()=>100,setIsOnline(){},
        fetchClassId:()=>17,skillset:{fetchSkills:()=>[],populateForActor:()=>Promise.resolve()},
        automation:{setRevHp(){},setRevMp(){},replenishVitals(){}}, state:{fetchDead:()=>false} };
    actors.push(a); return a;
}
function durableRoundTrip(a, timestamp) {
    let db = new DatabaseSync(dbPath);
    try {
        db.exec('CREATE TABLE IF NOT EXISTS life (id INTEGER PRIMARY KEY, statsJson TEXT)');
        db.prepare('INSERT OR REPLACE INTO life VALUES (1, ?)').run(JSON.stringify({coldCombat:Profile.capture(a,timestamp)}));
    } finally { db.close(); }
    db = new DatabaseSync(dbPath);
    try { return {stats:JSON.parse(db.prepare('SELECT statsJson FROM life WHERE id=1').get().statsJson)}; }
    finally { db.close(); }
}
async function enter(a, coldLifeState) {
    const s={actor:a,populationStaging:true,coldLifeState,packets:[],dataSendToMe(){},dataSendToOthers(p){this.packets.push(p);}};a.session=s;
    await EnterWorld(s,a);
}
(async()=>{
 try {
    let clock=Date.now();patch(Date,'now',()=>clock);
    patch(Data,'revitalize',{hp:{20:1},mp:{20:1}});
    patch(ConsoleText,'transmit',()=>{});
    patch(Generics,'calculateStats',(_s,a)=>{a.maxHp=Store.list(a).some(e=>e.key==='bless_the_body')?120:100;});
    const first=actor();
    const shield={key:'shield',id:1040,level:3,type:'buff',stats:{pDefMul:1.15},expiresAt:clock+120000};
    const body={key:'bless_the_body',id:1045,level:1,type:'buff',stats:{maxHpMul:1.2},expiresAt:clock+60000};
    Store.apply(first,shield);Store.apply(first,body);
    let cold=durableRoundTrip(first,clock);
    clock+=20000;
    const second=actor([{key:'might',id:1068,type:'buff',expiresAt:clock+100000}]);
    await enter(second,cold);
    assert.deepStrictEqual(Store.list(second).map(e=>e.key).sort(),['bless_the_body','shield']);
    assert.strictEqual(second.hp,115,'restore effects before calculating HP caps');
    assert.strictEqual(Store.list(second).find(e=>e.key==='shield').expiresAt,shield.expiresAt);
    assert.strictEqual(Planner.needsSkill(second,{fetchSelfId:()=>1040,fetchLevel:()=>3,fetchBuffTime:()=>1200000,
        fetchSemantic:()=>({effect:'shield',effectType:'buff',stats:{pDefMul:1.15}})}),true,
        'a nearly expiring buff remains legitimately due for refresh');
    cold=durableRoundTrip(second,clock);
    clock+=45000;
    const third=actor();await enter(third,cold);
    assert.deepStrictEqual(Store.list(third).map(e=>e.key),['shield'],'expired max-HP buff must not return');
    assert.strictEqual(third.hp,100,'expired HP modifier no longer raises the cap');
    assert.strictEqual(Store.list(third)[0].expiresAt,shield.expiresAt,'repeated activation must not reset duration');
    assert.strictEqual(third.effectExpiryTimers.shield._idleTimeout,shield.expiresAt-clock+25,'native expiry timer uses remaining time');
    cold=durableRoundTrip(third,clock);clock=shield.expiresAt+1;
    const expired=actor([body]);await enter(expired,cold);
    assert.deepStrictEqual(Store.list(expired),[]);
    const stale={...shield,expiresAt:clock+1200000};
    const empty=actor([stale]);await enter(empty,{stats:{coldCombat:{effects:[]}}});
    assert.deepStrictEqual(Store.list(empty),[],'an explicitly empty cold snapshot suppresses stale character buffs');
    const fresh=actor();await enter(fresh,{stats:{coldCombat:{effects:[stale]}}});
    assert.strictEqual(Planner.needsSkill(fresh,{fetchSelfId:()=>1040,fetchLevel:()=>3,fetchBuffTime:()=>1200000,
        fetchSemantic:()=>({effect:'shield',effectType:'buff',stats:{pDefMul:1.15}})}),false,'restored fresh buff does not request a rebuff');
    const legacy=actor([stale]);await enter(legacy,{stats:{}});
    assert.strictEqual(Store.list(legacy).length,1,'legacy bots without a cold effect snapshot retain the existing fallback');
    const player=actor([stale]);await enter(player,undefined);
    assert.strictEqual(Store.list(player).length,1,'ordinary player login keeps character effects');
    const wounded=actor();wounded.fetchCp=()=>35;
    const cpState={level:20,stats:{coldCombat:Profile.capture(wounded,clock)}};
    const cpArrival=actor();cpArrival.setCp=value=>cpArrival.cp=value;cpArrival.fetchMaxCp=()=>200;
    await enter(cpArrival,cpState);
    assert.strictEqual(cpArrival.cp,Math.min(200,Profile.profileFor(cpState,clock).cp),
        'native enter-world restores cold CP instead of granting a fresh shield');
    const Response=invoke('GameServer/Network/Response');
    patch(Response,'charInfo',a=>({flag:a.fetchPvpFlag()}));
    patch(Response,'userInfo',()=>({}));patch(Response,'relationChanged',()=>({}));
    const flagged=actor();flagged.flag=0;flagged.setPvpFlag=v=>{flagged.flag=v;};flagged.fetchPvpFlag=()=>flagged.flag;
    flagged.skillReuseUntil=new Map();
    const flagUntil=clock+7500;
    await enter(flagged,{stats:{coldCombat:{effects:[],cooldowns:{99:clock+5000}},coldPvp:{flagUntil}}});
    assert.strictEqual(flagged.session.packets.find(p=>p.flag!==undefined).flag,1,'first native CharInfo already has the PvP flag');
    assert.strictEqual(flagged.session.pvpFlagUntil,flagUntil,'restore absolute flag deadline');
    assert.strictEqual(flagged.skillReuseUntil.get(99),clock+5000,'restore native skill reuse');
    clearTimeout(flagged.session.pvpFlagTimer);
    clock=flagUntil+1;
    const white=actor();white.flag=0;white.setPvpFlag=v=>{white.flag=v;};white.fetchPvpFlag=()=>white.flag;
    await enter(white,{stats:{coldCombat:{effects:[]},coldPvp:{flagUntil}}});
    assert.strictEqual(white.flag,0,'an expired flag is not revived by a handoff');
    console.log('Hot/cold effect handoff: SQLite close/reopen, native enter-world restoration, expiry, HP caps and rebuff planning passed');
 } finally {
    actors.forEach(a=>Ticker.clearAll(a));saved.reverse().forEach(fn=>fn());
    fs.unlinkSync(dbPath);fs.rmdirSync(dir);
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
