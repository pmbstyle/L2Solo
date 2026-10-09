'use strict';
// Native ColdMarketService + TradeMeetingService, declared offline adapters.
// No game DB, worker or server is opened. This proves a control-flow defect,
// not the historical inputs of a specific live attempt.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const root=require('node:path').resolve(__dirname,'..');
const Service=require(root+'/src/GameServer/AfkTrade/TradeMeetingService');
let listener,current,prepared,writes=[];
let goal={type:'upgrade_gear',status:'active',target:{itemId:48,itemName:'Short Gloves'},plan:{marketTown:'Elven Village'}};
const offer={sourceType:'afk_bot_store',selfId:48,price:75,store:{shopId:770},town:'Elven Village'};
const dependencies={
 'Database':{recoverTradeMeetings:async()=>[],fetchTradeMeetingByToken:async()=>null},
 'GameServer/World/World':{registeredActorById:()=>null,subscribeUserChanges:()=>()=>{}},
 'GameServer/Bot/Population/BotLifeState':{
 cachedState:()=>current,hotRow:()=>null,marketPurchaseBlocker:()=>null,
 subscribeChanges:fn=>{listener=fn;return()=>{};},
 upsertState:async(next,reason)=>{writes.push(reason);current={...next,simulation:{...next.simulation,revision:next.simulation.revision+1}};listener({characterId:current.characterId});return current;}
 },
 'GameServer/Bot/Economy/MarketOpportunity':{bestOffer:()=>offer,botCanBuy:()=>true,fixedStoreOffers:()=>[],npcOffersAll:()=>[]},
 'GameServer/Bot/Economy/PurchaseFunding':{budget:()=>1000,spendable:()=>1000,nativeTerms:()=>({})},
 'GameServer/Bot/Goals/GoalState':{snapshot:()=>({current:goal})},
 'GameServer/Bot/Economy/ColdMarketTradeChat':{maybeAnnounceWanted:state=>({state,announced:false})},
 'GameServer/Bot/Goals/GoalExecutor':{finishMarketVisit:state=>({...state,activity:'hunting'})},
 'GameServer/AfkTrade/AfkTradeService':{
 subscribeBoardChanges:()=>()=>{},boardIndex:()=>({}),offerOf:()=>offer,
 buyFromShop:async()=>{
  const party={phase:'cold',revision:0,sequence:1,needRevision:0,ownerId:'legacy_main',leaseId:null,hotAt:0,route:{fee:0,scroll:false,method:'walk',durationMs:0}};
  prepared=Service.stage({token:'offline-pending',actorA:1,actorB:2,seqA:1,seqB:1,town:'Elven Village',point:{locX:0,locY:0,locZ:0},parties:[party,{...party}],lines:[{payer:0,itemId:100,selfId:48,count:1,price:75}]});
  return {pending:true,preparationId:prepared,purchased:false,state:current};
 }
 }
};
global.invoke=name=>dependencies[name]||{};
const diagnostics={active:()=>false,enabled:()=>false};
const sandbox={module:{exports:{}},invoke:global.invoke,utils:{infoWarn:()=>{}},Date,Promise,console,
 require:name=>name==='./EconomyDiagnostics'?diagnostics:name==='../Population/CombinedErrandPolicy'?{pending:state=>state.stats?.marketErrand?[state.stats.marketErrand]:[],ERRAND_MS:1}:name==='./OfferOrder'?{farmingOrigin:()=>null,tripCost:()=>()=>0}:name==='./OfferQuery'?{cheapestTown:(_board,_id,opts)=>({town:'Elven Village',units:opts.amount,cost:75*opts.amount,spendBudget:1000,lines:[{line:offer,count:opts.amount,price:75}]})}:{}
};
vm.runInNewContext(fs.readFileSync(root+'/src/GameServer/Bot/Economy/ColdMarketService.js','utf8'),sandbox,{filename:'ColdMarketService.js'});
(async()=>{
 current={characterId:1,name:'OfflineBuyer',phase:'cold',activity:'shopping',level:13,adena:1000,currentRegion:'Elven Village',stats:{},timing:{},simulation:{revision:0,ownerId:'legacy_main'}};
 await Service.init();
 const result=await sandbox.module.exports.tryPurchase(current,goal);
 assert.deepEqual(writes,[], 'preparing a trade must not write a failure or return state');
 assert.equal(Service.counters().preparations,1);
 assert.equal(result.pending,true); assert.equal(result.state.activity,'shopping'); assert.equal(result.state.stats.marketRetryAfter,undefined);
 assert.equal(Service.hasPreparation(1),true); assert.equal(Service.hasPreparation(2),true); assert.equal(Service.hasPreparation(3),false); Service.discard(prepared); assert.equal(Service.hasPreparation(1),false);

 goal={type:'buy_craft_material',status:'active',target:{itemId:48,amount:1},plan:{marketTown:'Elven Village',r:1}};
 let next=await sandbox.module.exports.tryPurchase(current,goal);
 assert.equal(next.pending,true); assert.deepEqual(writes,[]); Service.discard(prepared);
 current={...current,stats:{marketErrand:{selfId:48,amount:1,town:'Elven Village',r:1}}};
 next=await sandbox.module.exports.tryPurchase(current,{type:'market_errand'});
 assert.equal(next.pending,true); assert.deepEqual(writes,[]); assert.equal(current.stats.marketErrand.amount,1); Service.discard(prepared);

 dependencies.Database.fetchWarehouseItems=async()=>[];
 dependencies['GameServer/Bot/Economy/ColdSafeEnchantService']={enchantSafe:async state=>({state})};
 dependencies['GameServer/Bot/Population/BotLifeState'].learnCraftableRecipes=async state=>state;
 dependencies['GameServer/Bot/Economy/ItemDisposition']={saleCandidates:()=>[{selfId:48,count:1}]};
 dependencies['GameServer/Bot/AI/TownPathfinder']={towns:[{name:'Elven Village'}]};
 dependencies['GameServer/Bot/Economy/BotAfkMarketService']={saleDecision:()=>({answers:[{selfId:48}],npc:[],listings:[]})};
 dependencies['GameServer/Bot/Economy/ColdMarketBuyStoreService']={sellToBestBuyer:async state=>{
  await dependencies['GameServer/AfkTrade/AfkTradeService'].buyFromShop();
  return {state,pending:true,sold:false};
 }};
 // Any unintended NPC sale/deposit/progress throws because no such writer is supplied.
 const listingSandbox={module:{exports:{}},invoke:global.invoke,Date,Promise,require:()=>({})};
 vm.runInNewContext(fs.readFileSync(root+'/src/GameServer/Bot/Economy/ColdMarketListingService.js','utf8'),listingSandbox);
 next=await listingSandbox.module.exports.open(current);
 assert.equal(next.pending,true); assert.deepEqual(writes,[]); assert(Service.hasPreparation(1)); Service.discard(prepared);
 console.log('PASS native pending gear/material/errand purchases and sale preserve consent without retry, NPC liquidation or warehouse write');
 Service.reset();
})().catch(error=>{Service.reset();console.error(error);process.exitCode=1;});
