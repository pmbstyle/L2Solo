'use strict';
// Read-only native policy experiment. Controlled static price, catalog,
// knowledge-off and trip inputs; no DB/server initialization or live replay.
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.resolve(__dirname,'../src');
const modules=new Map(),fixtures=new Map();
function load(name){if(fixtures.has(name))return fixtures.get(name);if(modules.has(name))return modules.get(name);const m={exports:{}};modules.set(name,m.exports);vm.runInNewContext(fs.readFileSync(path.join(root,name+'.js'),'utf8'),{module:m,exports:m.exports,Buffer,Date,Math,utils:{infoWarn:()=>{}},require:n=>load(path.posix.normalize(path.posix.join(path.posix.dirname(name),n))),invoke:n=>load(n)},{filename:name});modules.set(name,m.exports);return m.exports;}
const id=2509,t0=100000000;
fixtures.set('GameServer/DataCache',{items:[{selfId:id,template:{price:15,kind:'Other.Shot',name:'Spiritshot: No Grade'}}]});
fixtures.set('GameServer/Bot/Population/Uptime',{between:(a,b)=>b-a});
fixtures.set('GameServer/Items/C4RecipeItems',{});
fixtures.set('GameServer/Bot/Economy/FirstPrice',{cachedFirstPrice:()=>7});
fixtures.set('GameServer/Bot/Economy/PriceLearning',{knowledgeEnabled:()=>false,errorOf:()=>0});
fixtures.set('GameServer/AfkTrade/BoardIndex',{SELL:1,BUY:3,offerFields:r=>r});
fixtures.set('GameServer/Items/ItemAcquisitionCatalog',{hasSource:()=>true});
fixtures.set('GameServer/Bot/Economy/SpotEconomics',{moneyWeight:()=>0});
fixtures.set('GameServer/Bot/Economy/EconomyDiagnostics',{active:()=>false});
fixtures.set('GameServer/Bot/Economy/OfferOrder',{});
fixtures.set('GameServer/Bot/Economy/CraftProfitPolicy',{});
fixtures.set('GameServer/Bot/Economy/TradeIntent',{npcOwnsPurchase:()=>false});
fixtures.set('GameServer/Bot/Economy/ReadyTradeChoice',{MAX_INSPECTED:20});
fixtures.get('GameServer/DataCache').items.push({selfId:1835,template:{price:15,kind:'Other.Shot',name:'Soulshot: No Grade'}});
const counters=load('GameServer/Bot/Economy/MarketCounters'),beliefs=load('GameServer/Bot/Economy/PriceBelief'),pricing=load('GameServer/Bot/Economy/MarketPricing'),look=load('GameServer/Bot/Economy/BoardLook');
let rivalUnits=1000,revision=1,bids=[];
const rival=()=>({ownerId:99,selfId:id,count:rivalUnits,price:8,enchant:0,town:'Giran',recordId:2,lineId:2,revision});
const board={list:(i,side)=>side===1?[rival()]:bids,first:(i,side)=>side===1?rival():bids[0]||null,itemRevision:()=>revision};
const trader={assertiveness:.5,caution:.5,wait:0};
function context(timestamp=t0){return {characterId:42,timestamp,understanding:.5,marketTrades:{},knowledgeEnabled:false,board,npcOffersFor:()=>[{price:30,town:'Giran'}],travel:()=>0,travelDetails:()=>({known:true,hours:0,fees:0}),trader,hour:1000,adena:10000,moneyPrice:.001,canSell:()=>true,ownStock:{known:true},economy:{worth:()=>0}};}
function line(){return {ownerId:42,recordId:1,lineId:1,selfId:id,storeType:1,count:1000,price:8,enchant:0,custodyPolicy:1,revision:1,fills:0,town:'Giran',pricing:pricing.lineState(id,context(),{price:8,count:1000})};}

const assert=require('node:assert/strict');
fixtures.delete('GameServer/AfkTrade/BoardIndex');const {BoardIndex}=load('GameServer/AfkTrade/BoardIndex');
const b=new BoardIndex(),seen=new look.SeenLines(),state={characterId:42,stats:{},inventory:{}};
b.setOwnerChangeObserver((previous,next,index)=>look.consumeOwnProjection(seen,previous,next,index,42));
function put(owner,price,pricing=null,item=id){b.put({id:owner===42?1:owner,ownerId:owner,storeType:1,custodyPolicy:1,revision:price,town:'Giran',lines:[{lineId:owner===42?1:owner,selfId:item,count:1000,price,...(pricing?{pricing}:{})}]});}
put(99,8);put(42,8,line().pricing);const ctx={...context(),board:b};
let builds=0;const prior=beliefs.prior;beliefs.prior=(...args)=>{builds++;return prior(...args)};
function review(){return look.review(state,b.ownerLines(42),ctx,seen);}
review();builds=0;review();assert.equal(builds,0,'unchanged native item inputs');
put(100,30,null,1835);counters.deal(1835,30,1000,t0+1000,100,'Giran',101);review();
assert.equal(counters.counterOf(id),counters.counterOf(1835));assert.equal(builds,0,'same-group foreign listing and deal');
// Reset deal evidence to reproduce the exact original8->12->11 control.
counters.reset();put(99,12);const changed=review();assert.equal(changed.reprices[0].price,11);
const move=changed.reprices[0];put(42,move.price,move.pricing);builds=0;review();assert.equal(builds,0,'native own projection consumes its own change only');
// An external change during the simulated commit must not be swallowed.
put(99,20);const pending=review();assert(pending?.reprices.length);
put(99,30);const accepted=pending.reprices[0];put(42,accepted.price,accepted.pricing);builds=0;review();assert(builds>0,'external change before own delivery survives');
// Exact-item deal evidence still respects the existing attention choice.
builds=0;const oldMove=counters.moveOf;counters.moveOf=()=>0;
counters.deal(id,8,1000,t0+2000,99,'Giran',100);review();assert.equal(builds,0,'zero-value exact-item attention is declined');
review();assert.equal(builds,0,'declined exact event cannot reroll');counters.moveOf=oldMove;
// Same-price native metadata is not an acknowledgment of another proposal.
const actual=b.ownerLines(42)[0];b.put({id:1,ownerId:42,storeType:1,custodyPolicy:1,revision:Number(actual.revision)+1,
    lines:[{lineId:1,selfId:id,count:1000,price:actual.price,pricing:{...actual.pricing,rival:1,sigma:.1}}]});
builds=0;review();assert(builds>0,'same-price accepted pricing/revision remains an own event');
// One own acknowledgment leaves unchanged siblings in the same record quiet.
const siblings=new BoardIndex(),siblingSeen=new look.SeenLines();
siblings.setOwnerChangeObserver((previous,next,index)=>look.consumeOwnProjection(siblingSeen,previous,next,index,42));
const siblingRows=[{lineId:501,selfId:id,count:1000,price:8,pricing:line().pricing},
    {lineId:502,selfId:1835,count:1000,price:8,pricing:line().pricing}];
const siblingPut=(rev,rows)=>siblings.put({id:500,ownerId:42,storeType:1,custodyPolicy:1,revision:rev,lines:rows});
siblingPut(1,siblingRows);
const savedLook=pricing.look;let siblingCalls=0;
pricing.look=(s,rows)=>{siblingCalls+=rows.length;return {reprices:[{...rows[0],price:9,pricing:{...rows[0].pricing,price:9}}]};};
look.review(state,siblings.ownerLines(42),{...ctx,board:siblings},siblingSeen);
const updatedSiblings=[{...siblingRows[0],price:9,pricing:{...siblingRows[0].pricing,price:9}},siblingRows[1]];
siblingPut(2,updatedSiblings);siblingCalls=0;
look.review(state,siblings.ownerLines(42),{...ctx,board:siblings},siblingSeen);
assert.equal(siblingCalls,0,'own reprice leaves unchanged native sibling quiet');
siblingPut(3,updatedSiblings);
look.review(state,siblings.ownerLines(42),{...ctx,board:siblings},siblingSeen);
assert.equal(siblingCalls,0,'identical native republish stays quiet');
for(const [revision,extra] of [[4,{town:'Aden'}],[5,{town:'Aden',custodyPolicy:0}]]) {
    siblings.put({id:500,ownerId:42,storeType:1,custodyPolicy:1,revision,lines:updatedSiblings,...extra});
    siblingCalls=0;look.review(state,siblings.ownerLines(42),{...ctx,board:siblings},siblingSeen);
    assert(siblingCalls>0,'changed native town/custody remains a review event');
}
pricing.look=savedLook;
// A full native14-line book retains all baselines across cursor continuation.
const book=new BoardIndex(),cache=new look.SeenLines();
for(let n=1;n<=14;n++)book.put({id:n,ownerId:42,storeType:1,custodyPolicy:1,revision:1,lines:[{lineId:n,selfId:id,count:1000,price:8,pricing:line().pricing}]});
const heldPricing=pricing.look;let evaluations=[];pricing.look=(s,ls)=>{evaluations.push(ls.length);return null};
for(let n=0;n<5;n++)look.review(state,book.ownerLines(42),{...ctx,board:book},cache);
assert.deepEqual(evaluations,[8,6]);assert.equal(cache.size,14);assert.equal(cache.byteLength,4352);
pricing.look=heldPricing;
// Known0, clear and instance replacement are distinct numeric source facts.
const out=new Float64Array(4),empty=new BoardIndex();empty.writeItemRevision(id,out);assert.equal(out[3],0);
const start=[...out];empty.clear();empty.writeItemRevision(id,out);assert.notDeepEqual([...out],start);
const other=new BoardIndex();other.writeItemRevision(id,out);assert.notEqual(out[0],start[0]);
empty.itemChanges.set(id,Number.MAX_SAFE_INTEGER);const untouched=empty.itemRevision(1835);empty.itemChanged(id);empty.writeItemRevision(id,out);assert.equal(out[2],1);assert.equal(out[3],1);assert.equal(empty.itemRevision(1835),untouched);
const before=empty.itemRevision(id);empty.itemChanged(id);assert.notEqual(empty.itemRevision(id),before);
empty.itemChanges.set(id,{generation:Number.MAX_SAFE_INTEGER,changes:Number.MAX_SAFE_INTEGER});assert.throws(()=>empty.put({id:5,ownerId:1,storeType:1,lines:[{lineId:5,selfId:id,count:1,price:1}]}),/exhausted/);assert.equal(empty.size,0,'overflow fails before partial index mutation');
// Dirty prepared inputs follow remembered identity when an owner row vanishes.
const buyBook=new BoardIndex(),buySeen=new look.SeenLines(),reads=new Map();let prepared=100;
for(let n=1;n<=14;n++)buyBook.put({id:n,ownerId:42,storeType:3,revision:1,lines:[{lineId:n,selfId:3000+n,count:1000,price:8,pricing:{...line().pricing,worth:100}}]});
const buyCtx={...ctx,board:buyBook,preparedBuffer:new ArrayBuffer(8),preparedWorth:i=>{reads.set(i,(reads.get(i)||0)+1);return prepared;}};
pricing.look=()=>null;
look.review(state,buyBook.ownerLines(42),buyCtx,buySeen);look.review(state,buyBook.ownerLines(42),buyCtx,buySeen);
look.review(state,buyBook.ownerLines(42),buyCtx,buySeen);assert.equal([...reads.values()].reduce((a,b)=>a+b,0),14,'hot unchanged compact inputs are reused');
prepared=200;buyCtx.preparedBuffer=new ArrayBuffer(8);buySeen.cursor=0;look.review(state,buyBook.ownerLines(42),buyCtx,buySeen);buyBook.remove(1);
for(let n=0;n<3;n++)look.review(state,buyBook.ownerLines(42),buyCtx,buySeen);
for(let n=2;n<=14;n++)assert.equal(reads.get(3000+n),2,'replacement preparation reaches every surviving identity');
// Cold scalar dependencies reuse the same preparation without its function closure.
const coldSeen=new look.SeenLines(),coldRows=buyBook.ownerLines(42).slice(0,1);let worthReads=0,scalar=200;
const coldCtx={...ctx,board:buyBook,preparedValue:()=>scalar,preparedWorth:()=>{worthReads++;return scalar;}};
look.review(state,coldRows,coldCtx,coldSeen);look.review(state,coldRows,coldCtx,coldSeen);assert.equal(worthReads,1);
scalar=300;look.review(state,coldRows,coldCtx,coldSeen);assert.equal(worthReads,2,'actual changed cold need is refreshed');
pricing.look=heldPricing;
console.log('PASS native item-only signal,8->12->11, zero repeat/self feedback, attention rejection, interleaved commit/metadata,14 baselines, prepared deletion/cold reuse, clear/replacement/local rollover');
