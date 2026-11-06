const assert = require('assert');
const fs = require('fs');
const path = require('path');
require('../src/Global');
const Database = invoke('Database');
const Data = invoke('GameServer/DataCache');
const World = invoke('GameServer/World/World');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Backpack = invoke('GameServer/Actor/Backpack');
const Service = invoke('GameServer/Bot/AI/CompanionDualSwordCrafting');
const Shopping = invoke('GameServer/Bot/AI/CompanionEquipmentShopping');
const State = invoke('GameServer/Bot/AI/States/ShoppingState');
const Services = invoke('GameServer/Bot/Economy/TownServiceCatalog');
const Queue = invoke('GameServer/Persistence/CharacterWriteQueue');
const Market = invoke('GameServer/Bot/Economy/MarketOpportunity');
Data.init();
fs.mkdirSync(path.join(process.cwd(),'tmp'),{recursive:true});
const folder = fs.mkdtempSync(path.join(process.cwd(),'tmp','test-companion-dual-'));
options.default.Database.path = path.relative(process.cwd(),path.join(folder,'test.sqlite'));
const town = {name:'Aden',x:150608,y:28510,z:-2247};
const npc = (id,selfId,title) => ({fetchId:()=>id,fetchSelfId:()=>selfId,fetchName:()=>title,
    fetchTitle:()=>title,fetchLocX:()=>town.x,fetchLocY:()=>town.y,fetchLocZ:()=>town.z});
World.npc = {spawns:[npc(100,7846,'Blacksmith'),npc(101,7005,'Warehouse Keeper')]};
World.user = {sessions:[]};
const warehouse = {actorId:101,npcSelfId:7005,name:'Warehouse Keeper',serviceRole:'warehouse',town:'Aden',locX:town.x,locY:town.y,locZ:town.z};
Services.targetFor = () => warehouse;
Market.hotOffers = () => [];
// Keep real inventory, native equip/paperdoll, write queue, warehouse and
// SQLite transactions. Only presentation/stat recalculation/restocking is inert.
invoke('GameServer/Actor/Generics').calculateStats = () => {};
invoke('GameServer/Skills/ToggleSkills').syncEquipment = () => {};
invoke('GameServer/Network/Response').charInfo = () => Buffer.alloc(0);
invoke('GameServer/Inventory/ShotStock').purchaseActorRestock = async () => ({});
invoke('GameServer/Inventory/ShotStock').enableAutoShot = () => {};
invoke('GameServer/Bot/AI/BotEventJournal').record = async () => {};
const prior = {status:'active',strategy:'craft',recipeId:902576,target:{selfId:2576,slot:14},
    combine:{resultId:2576,requirements:[{selfId:73,amount:1},{selfId:75,amount:1}]}};
let serial = 0;
async function actorCase({stored = true, second = true} = {}) {
    const account = `bot_dual_${++serial}`;
    await Database.createAccount(account,'secret');
    await Database.createCharacter(account,{name:`CompanionDual${serial}`,race:2,classId:34,maxHp:100,maxMp:100,sex:0,face:0,hair:0,hairColor:0,locX:town.x,locY:town.y,locZ:town.z});
    const id = Number((await Database.fetchCharacterName(`CompanionDual${serial}`))[0].id);
    await Database.setItem(id,{selfId:73,name:'Shamshir',amount:1,equipped:true,slot:7});
    await Database.setItem(id,{selfId:57,name:'Adena',amount:18000000,slot:0});
    if (second) {
        await Database.setItem(id,{selfId:75,name:'Caliburs',amount:1,slot:0});
        if (stored) {
            const blade = (await Database.fetchItems(id)).find(i=>i.selfId===75);
            await Database.transferInventoryToWarehouse(id,{...blade,stackable:false});
        }
    }
    const items = await Database.fetchItems(id);
    const paperdoll = Object.fromEntries(Array.from({length:16},(_,i)=>[i,{}]));
    const backpack = new Backpack({id,items,paperdoll});
    for (const item of backpack.fetchItems()) if(item.fetchEquipped()) backpack.equipPaperdoll(item.fetchSlot(),item.fetchId(),item.fetchSelfId());
    const bot = {backpack,fetchId:()=>id,fetchName:()=>`CompanionDual${serial}`,fetchLevel:()=>64,fetchClassId:()=>34,
        fetchLocX:()=>town.x,fetchLocY:()=>town.y,fetchLocZ:()=>town.z,isDead:()=>false,
        state:{fetchCombats:()=>false,fetchHits:()=>false,fetchCasts:()=>false,fetchTowards:()=>false}};
    const session = {accountId:account,actor:bot,partyCompanion:true,plan:'shopping',
        dataSendToMe(){},dataSendToOthers(){},coldLifeState:{characterId:id,level:64,stats:{classId:34,equipmentPlan:structuredClone(prior)},
            inventory:Life.inventorySummaryFromItems(backpack.fetchItems())}};
    return {bot,session,id};
}
async function run() {
    Database.init();
    const {bot,session,id} = await actorCase();
    await Service.refreshWarehouse(session,bot);
    session.partyCompanion=false;
    assert.deepStrictEqual(Service.plan(session,bot,town,session.coldLifeState),{handled:false},'autonomous market visits keep their existing planner');
    session.partyCompanion=true;
    let errand = Shopping.planErrand(session,bot,town);
    assert.strictEqual(errand.kind,'dual_component_withdrawal');
    assert.strictEqual(session.coldLifeState.stats.equipmentPlan.target.selfId,2576,'ready B objective survives level-64 A-grade replanning');
    assert.strictEqual(Shopping.planErrand(session,bot,{name:'Giran'}),null,'no cross-town departure from the leader');
    session.companionShopping=errand;
    let restocks=0;
    State.scheduleRestock=()=>{restocks++;};
    const ai={getClosestTown:()=>town};
    await State.sellAndRestock(session,bot,{},ai);
    assert.strictEqual((await Database.fetchWarehouseItems(id)).length,0);
    assert(bot.backpack.fetchItemFromSelfId(75),'native withdrawal updates the live backpack');
    assert.strictEqual(session.companionShopping.kind,'dual_sword_combine','shopping continues directly to the smith');
    assert.strictEqual(restocks,0);
    errand=session.companionShopping;
    await Promise.all([Service.execute(session,bot,errand),Service.execute(session,bot,errand)]);
    assert.strictEqual(bot.backpack.fetchTotalWeaponKind(),'Weapon.Dual');
    assert.strictEqual(bot.backpack.fetchPaperdollId(7),undefined,'consumed equipped sword is removed from paperdoll');
    assert.strictEqual(session.coldLifeState.stats.equipmentPlan.status,'complete');
    await Queue.flushCharacter(id);
    let rows=await Database.fetchItems(id);
    assert.strictEqual(rows.filter(i=>[73,75].includes(i.selfId)).length,0);
    assert.strictEqual(rows.filter(i=>i.selfId===2576).length,1,'overlapping callbacks do not combine twice');
    assert.strictEqual(rows.find(i=>i.selfId===2576).equipped,1);
    assert.strictEqual(rows.find(i=>i.selfId===57).amount,18000000,'existing bot combination fee policy is preserved');
    await Service.execute(session,bot,errand);
    assert.strictEqual((await Database.fetchItems(id)).filter(i=>i.selfId===2576).length,1,'completed-result retry is idempotent');
    await State.sellAndRestock(session,bot,{},ai);
    assert.strictEqual(restocks,1,'completed smith errand uses normal restock/return-to-leader continuation');
    session.coldLifeState.stats.equipmentPlan=structuredClone(prior);
    assert.strictEqual(Shopping.planErrand(session,bot,{name:'Giran'}),null,'equipped persisted result completes a stale objective without returning to the smith');
    assert.strictEqual(session.coldLifeState.stats.equipmentPlan.status,'complete');

    const missing = await actorCase({second:false});
    missing.session.companionShopping={kind:'dual_sword_combine',recipeId:902576,target:{actorId:100,npcSelfId:7846}};
    await assert.rejects(Service.execute(missing.session,missing.bot,missing.session.companionShopping),/ingredient changed/);
    assert((await Database.fetchItems(missing.id)).some(i=>i.selfId===73),'failed transaction keeps source sword');
    assert.strictEqual(missing.bot.backpack.fetchTotalWeaponKind(),'Weapon.Sword');
    await State.sellAndRestock(missing.session,missing.bot,{},ai);
    // The failed step is raised (goal_failed, the held step dropped): no gear errand until the worker answers it.
    const Events=invoke('GameServer/Bot/AI/DecisionEvents');
    assert(Events.failureWaits(missing.session)||Number(Events.statsFor(missing.session).activityLeaf)===0,'failed combination raises its failed step instead of repeating each visit tick');

    const interrupted = await actorCase({stored:false});
    interrupted.session.companionShopping={kind:'dual_sword_combine',recipeId:902576,target:{actorId:100,npcSelfId:7846}};
    interrupted.bot.fetchLocX=()=>town.x+1000;
    await assert.rejects(Service.execute(interrupted.session,interrupted.bot,interrupted.session.companionShopping),/npc_unavailable/);
    interrupted.bot.fetchLocX=()=>town.x;
    interrupted.bot.fetchClassId=()=>9;
    await assert.rejects(Service.execute(interrupted.session,interrupted.bot,interrupted.session.companionShopping),/recipe_changed/);
    interrupted.bot.fetchClassId=()=>34;
    const original=Database.combineInventoryItems;
    Database.combineInventoryItems=(id,args)=>{interrupted.session.plan='following';return original.call(Database,id,args);};
    await assert.rejects(Service.execute(interrupted.session,interrupted.bot,interrupted.session.companionShopping),/interrupted/);
    Database.combineInventoryItems=original;
    assert.strictEqual((await Database.fetchItems(interrupted.id)).filter(i=>[73,75].includes(i.selfId)).length,2,'interruption is checked inside commit before consuming inputs');
    await Database.close();Database.init();
    rows=await Database.fetchItems(id);
    assert.strictEqual(rows.filter(i=>i.selfId===2576).length,1);
    assert.strictEqual(rows.find(i=>i.selfId===2576).equipped,1,'result and equipment persist across SQLite reopen');
    assert.strictEqual((await Database.fetchWarehouseItems(id)).length,0);
    console.log('Companion dual crafting: warehouse → smith → native equip, prior goal, interrupted/failed/duplicate execution and SQLite reopen passed');
}
run().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>Database.close());
