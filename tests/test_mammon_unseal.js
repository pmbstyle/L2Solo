const assert = require('assert');
const fs = require('fs');
const path = require('path');
require('../src/Global');
const Database = invoke('Database');
const Data = invoke('GameServer/DataCache');
const World = invoke('GameServer/World/World');
const Backpack = invoke('GameServer/Actor/Backpack');
const Service = invoke('GameServer/Items/MammonUnsealService');
const Catalog = invoke('GameServer/Items/C4Unseal');
const Mammon = invoke('GameServer/World/GiranMammon');
const Bot = invoke('GameServer/Bot/AI/BotMammonUnseal');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
Data.init();
const folder = fs.mkdtempSync(path.join(process.cwd(),'tmp','test-mammon-'));
options.default.Database.path = path.relative(process.cwd(),path.join(folder,'test.sqlite'));
World.npc = {spawns:[{fetchId:()=>123,fetchSelfId:()=>8126,fetchName:()=> 'Blacksmith of Mammon',
    fetchLocX:()=>Mammon.loc.locX,fetchLocY:()=>Mammon.loc.locY,fetchLocZ:()=>Mammon.loc.locZ}]};
World.user = {sessions:[]};
invoke('GameServer/Actor/Generics').calculateStats = () => {};
invoke('GameServer/Skills/ToggleSkills').syncEquipment = () => {};
invoke('GameServer/Network/Response').charInfo = () => Buffer.alloc(0);
invoke('GameServer/Inventory/ShotStock').purchaseActorRestock = async () => ({});
invoke('GameServer/Inventory/ShotStock').enableAutoShot = () => {};
invoke('GameServer/Bot/AI/BotEventJournal').record = async () => {};
async function run() {
    for (const r of Catalog.recipes) {
        const source = Data.items.find(i=>i.selfId===r.sourceId);
        const target = Data.items.find(i=>i.selfId===r.productId);
        assert(source && target,`missing template ${r.sourceId} -> ${r.productId}`);
        assert(/^Sealed /i.test(source.template.name) || source.etc.rank === 'b');
        assert(!/^Sealed /i.test(target.template.name));
    }
    assert.strictEqual(Data.npcs.filter(i=>i.selfId===8126).length,1);
    assert.strictEqual(Catalog.recipes.length,92);
    assert.strictEqual(Data.items.find(i=>i.selfId===6373).template.kind,'Armor.Chain');
    assert.strictEqual(Data.items.find(i=>i.selfId===6379).template.kind,'Armor.Leather');
    assert.strictEqual(Data.items.find(i=>i.selfId===6383).template.kind,'Armor.Fabric');
    assert.strictEqual(Data.items.find(i=>i.selfId===6377).stats.pDef,290);
    assert.strictEqual(Data.items.find(i=>i.selfId===6383).stats.maxMp,866);
    Database.init();
    await Database.createAccount('bot_mammon','secret');
    await Database.createCharacter('bot_mammon',{name:'MammonTest',race:0,classId:2,maxHp:100,maxMp:100,
        sex:0,face:0,hair:0,hairColor:0,...Mammon.loc});
    const id = Number((await Database.fetchCharacterName('MammonTest'))[0].id);
    await Database.setItem(id,{selfId:5290,name:'Sealed Dark Crystal Gloves',amount:1,enchant:7,slot:9});
    await Database.setItem(id,{selfId:57,name:'Adena',amount:123,slot:0});
    const rows = await Database.fetchItems(id);
    const backpack = new Backpack({items:rows,paperdoll:Object.fromEntries(Array.from({length:16},(_,i)=>[i,{}]))});
    const actor = {backpack,fetchId:()=>id,fetchName:()=> 'MammonTest',fetchLevel:()=>76,fetchClassId:()=>2,
        fetchLocX:()=>Mammon.loc.locX,fetchLocY:()=>Mammon.loc.locY,fetchLocZ:()=>Mammon.loc.locZ,
        isDead:()=>false,state:{fetchCombats:()=>false,fetchHits:()=>false,fetchCasts:()=>false,fetchTowards:()=>false}};
    const session = {actor,accountId:'bot_mammon',plan:'shopping',activeNpcTalk:{selfId:8126,objectId:123},
        dataSendToMe(){},dataSendToOthers(){}};
    const source = backpack.fetchItemFromSelfId(5290);
    invoke('GameServer/World/Generics/NpcTalk')(session,World.npc.spawns[0]);
    actor.fetchLocX=()=>Mammon.loc.locX+1000;
    await assert.rejects(Service.exchange(session,source.fetchId(),5765),/mammon_unavailable/);
    actor.fetchLocX=()=>Mammon.loc.locX;
    await assert.rejects(Service.exchange(session,source.fetchId(),57),/invalid_unseal/);
    await assert.rejects(Database.unsealInventoryItem(id+1,source.fetchId(),5765),/source_changed/);
    const attempts = await Promise.allSettled([Service.exchange(session,source.fetchId(),5765),Service.exchange(session,source.fetchId(),5765)]);
    assert.strictEqual(attempts.filter(r=>r.status==='fulfilled').length,1);
    assert.strictEqual(source.fetchSelfId(),5765);
    assert.strictEqual(source.fetchEnchantLevel(),7);
    await assert.rejects(Service.exchange(session,source.fetchId(),5765),/invalid_unseal/);
    assert.strictEqual(backpack.fetchItemFromSelfId(57).fetchAmount(),123);
    for (const [classId,product] of [[2,5765],[12,5767],[9,5766],[22,5766]]) {
        assert.strictEqual(Bot.recipeFor(5290,{stats:{classId}}).productId,product);
    }
    await Database.setItem(id,{selfId:5291,name:'Sealed Dark Crystal Boots',amount:1,slot:12});
    const bootsRow = (await Database.fetchItems(id)).find(i=>i.selfId===5291);
    backpack.insertItem(bootsRow.id,bootsRow.selfId,bootsRow);
    session.coldLifeState = {characterId:id,phase:'cold',activity:'hunting',level:76,loc:{...Mammon.loc},
        currentRegion:'Giran',stats:{classId:2},inventory:Life.inventorySummaryFromItems(backpack.fetchItems())};
    assert.strictEqual(Bot.plan(session,actor,{name:'Aden'},session.coldLifeState),null);
    const errand = invoke('GameServer/Bot/AI/CompanionEquipmentShopping').planErrand(session,actor,{name:'Giran'});
    assert.strictEqual(errand.kind,'mammon_unseal');
    session.companionShopping = errand;
    const boots = backpack.fetchItemRaw(bootsRow.id);
    const originalUnseal = Database.unsealInventoryItem;
    Database.unsealInventoryItem = (...args) => {
        session.plan = 'following';
        return originalUnseal.apply(Database,args);
    };
    await assert.rejects(Bot.execute(session,actor,errand),/unseal_errand_interrupted/);
    Database.unsealInventoryItem = originalUnseal;
    session.plan = 'shopping';
    assert.strictEqual((await Database.fetchItems(id)).find(i=>i.id===bootsRow.id).selfId,5291);
    boots.setEquipped(true);backpack.equipPaperdoll(12,boots.fetchId(),boots.fetchSelfId());
    await Database.updateItemEquipState(id,boots.fetchId(),true,12);
    await Bot.execute(session,actor,errand);
    assert.strictEqual(boots.fetchSelfId(),5777);
    assert(boots.fetchEquipped(),'bot equips unsealed boots through the native equipment path');
    await Database.setItem(id,{selfId:6674,name:'Sealed Imperial Crusader Breastplate',amount:1,slot:15});
    // A field of Giran's region: the trip reads a Scroll of Escape and pays no
    // gatekeeper (N2); the character's 123 Adena stay untouched.
    const cold = {...session.coldLifeState,inventory:{6674:{selfId:6674,amount:1},736:{selfId:736,amount:1}},
        loc:{locX:90000,locY:148000,locZ:-3400}};
    const trip = Bot.beginTravel(cold,1000);
    assert(trip && trip.stats.travel.arrivalAt===26000);
    // Karma keeps the bot from the Giran trip: any karma above 0 blocks it;
    // none, zero or negative karma does not.
    for (const [karma, blocked] of [[undefined, false], [null, false], [0, false], [-5, false], ['0', false], [NaN, false], [1, true], ['7', true], [45, true]]) {
        assert.strictEqual(!!Bot.beginTravel({...cold,stats:{...cold.stats,karma}},1000), !blocked, `Mammon trip with karma ${karma}`);
    }
    assert.strictEqual(invoke('GameServer/Bot/Population/ColdSimulationKernel').lifecycleKind(cold), 'command');
    assert.strictEqual(invoke('GameServer/Bot/Population/ColdSimulationOwner').eligibility(cold).ok, false);
    assert.strictEqual(Bot.beginTravel({...cold,party:{partyId:'test'}},1000),null);
    assert.strictEqual(Bot.beginTravel({...cold,activity:'shopping'},1000),null,'a shopping bot finishes its market steps first');
    for (const flag of ['supplyErrand','partyMarketReturn','marketStore','pvpEncounter']) {
        assert.strictEqual(Bot.beginTravel({...cold,stats:{...cold.stats,[flag]:{}}},1000),null,`${flag} keeps the bot from the Mammon trip`);
    }
    const travelResolver = invoke('GameServer/Bot/Population/BackgroundResolver');
    const early = travelResolver.resolveSolo({state:trip,timestamp:2000,elapsedMs:1000});
    assert.strictEqual(early.patch.activity,'traveling');
    const arrival = travelResolver.resolveSolo({state:trip,timestamp:26000,elapsedMs:25000});
    assert.strictEqual(arrival.patch.activity,'crafting');
    const arrived = {...trip,...arrival.patch};
    const returning = await Bot.finish(arrived,27000);
    assert.strictEqual(returning.stats.travel.reason,'mammon_unseal_return');
    assert.deepStrictEqual(returning.stats.travel.to,cold.loc);
    assert((await Database.fetchItems(id)).some(i=>i.selfId===6373));
    await Database.close();Database.init();
    const persisted = (await Database.fetchItems(id)).find(i=>i.id===source.fetchId());
    assert.strictEqual(persisted.selfId,5765);
    assert.strictEqual(persisted.enchant,7);
    assert.strictEqual((await Database.fetchItems(id)).find(i=>i.selfId===57).amount,123);
    console.log('Mammon: 92 C4 recipes, ownership/range/replay protection, hot errand, cold travel, free exchange and enchanted SQLite reopen passed');
}
run().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>Database.close());
