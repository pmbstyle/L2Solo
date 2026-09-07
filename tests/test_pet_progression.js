const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
require('../src/Global');
const DataCache = invoke('GameServer/DataCache');
const Database = invoke('Database');
const Backpack = invoke('GameServer/Actor/Backpack');
const World = invoke('GameServer/World/World');
const Q = invoke('GameServer/Quest/QuestService');
const Rules = invoke('GameServer/Pets/PetRules');
const Runtime = invoke('GameServer/Pets/PetRuntime');
const Inventory = invoke('GameServer/Pets/PetInventory');
const Control = invoke('GameServer/Npc/SummonControl');
const Mount = invoke('GameServer/Pets/PetMount');
const Response = invoke('GameServer/Network/Response');
const LittleWing = invoke('GameServer/Quest/quests/Q420_LittleWing');
const Evolution = invoke('GameServer/Quest/quests/Q421_LittleWingsBigAdventure');
const temp = fs.mkdtempSync(path.join(process.cwd(), 'tmp', 'pet-progression-'));
let read, session;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function sessionFor(backpack, skill, options = {}) {
    let hp = 100;
    let mp = options.mp ?? 100;
    let casts = false;
    let destId = options.destId;
    const loc = {
        locX: options.locX ?? 1000,
        locY: options.locY ?? 2000,
        locZ: options.locZ ?? -50
    };
    const actor = {
        backpack,
        skillset: { fetchSkill: () => skill },
        summon: options.summon || null,
        fetchId: () => 2000001,
        fetchName: () => 'Summoner',
        fetchTitle: () => '',
        fetchRace: () => 0,
        fetchSex: () => 0,
        fetchClassId: () => 0,
        fetchLevel: () => 65,
        fetchExp: () => 0,
        fetchSp: () => 0,
        fetchStr: () => 40,
        fetchDex: () => 30,
        fetchCon: () => 43,
        fetchInt: () => 21,
        fetchWit: () => 11,
        fetchMen: () => 25,
        fetchLocX: () => loc.locX,
        fetchLocY: () => loc.locY,
        fetchLocZ: () => loc.locZ,
        setLocXYZ(coords) {
            loc.locX = coords.locX;
            loc.locY = coords.locY;
            loc.locZ = coords.locZ;
        },
        fetchHead: () => 0,
        fetchRadius: () => 10,
        fetchDestId: () => destId,
        clearDestId() { destId = undefined; },
        setDestId(value) { destId = value; },
        fetchIsOnline: () => true,
        fetchMp: () => mp,
        setMp(value) { mp = value; },
        fetchMaxMp: () => 100,
        fetchCp: () => 0,
        fetchMaxCp: () => 0,
        fetchMaxLoad: () => 1000,
        fetchCollectivePAtk: () => 1,
        fetchCollectivePDef: () => 1,
        fetchCollectiveEvasion: () => 1,
        fetchCollectiveAccur: () => 1,
        fetchCollectiveCritical: () => 1,
        fetchCollectiveMAtk: () => 1,
        fetchCollectiveMDef: () => 1,
        fetchPvpFlag: () => 0,
        fetchKarma: () => 0,
        fetchCollectiveRunSpd: () => 1,
        fetchCollectiveWalkSpd: () => 1,
        fetchSwim: () => 0,
        fetchAtkSpdMultiplier: () => 1,
        fetchSize: () => 1,
        fetchHair: () => 0,
        fetchHairColor: () => 0,
        fetchFace: () => 0,
        fetchIsGM: () => 0,
        fetchPrivateStoreType: () => 0,
        fetchIsCrafter: () => 0,
        fetchPk: () => 0,
        fetchPvp: () => 0,
        fetchRecRemain: () => 0,
        fetchEvalScore: () => 0,
        fetchHp: () => hp,
        setHp(value) { hp = value; },
        fetchMaxHp: () => 100,
        fetchCollectiveCastSpd: () => 333,
        fetchCollectiveAtkSpd: () => 333,
        statusUpdateVitals() {},
        isDead: () => false,
        automation: { replenishVitals() {}, abortAll() {} },
        state: {
            fetchDead: () => false,
            fetchHits: () => false,
            fetchSeated: () => false,
            fetchWalkin: () => false,
            fetchCombats: () => false,
            fetchStateInvisible: () => false,
            setHits() {},
            setCasts(value) { casts = value; },
            fetchCasts: () => casts
        }
    };

    return {
        actor,
        packets: [],
        dataSendToMe(packet) {
            this.packets.push(packet);
        },
        dataSendToMeAndOthers(packet) {
            this.packets.push(packet);
        }
    };
}
async function main() {
    DataCache.init();
    const dbPath = path.join(temp, 'world.sqlite');
    const seed = new DatabaseSync(dbPath);
    seed.exec(fs.readFileSync('database/sql/sqlite.sql', 'utf8'));
    seed.exec("INSERT INTO accounts(username,password) VALUES ('progression_test','test'); INSERT INTO characters(id,username,name,classId,race,level,maxHp,maxMp,sex,face,hair,hairColor,locX,locY,locZ) VALUES (2000001,'progression_test','PetOwner',0,0,65,100,100,0,0,0,0,0,0,0)");
    seed.close();
    options.default.Database.path = dbPath;
    Database.init(); read = new DatabaseSync(dbPath);
    session = sessionFor(new Backpack({ items: [], paperdoll: Array.from({length:16},()=>({})) }));
    const actor = session.actor, pack = actor.backpack;
    actor.session = session;
    World.user = { sessions: [session] };
    World.npc = { spawns: [], grid: {}, nextId: 9000001 };
    const count = id => pack.fetchItems().filter(item => item.fetchSelfId() === id).reduce((sum,item)=>sum+item.fetchAmount(),0);
    const event = (id,npc,name) => { session.activeNpcTalk = { selfId: npc, objectId: 1000001 }; return Q.onEvent(session,{questId:id,name}); };
    const state = id => session.questStates.get(id);
    const abort = id => { const packet=Buffer.alloc(5); packet[0]=0x64; packet.writeUInt32LE(id,1); return invoke('GameServer/Network/Request/QuestAbort')(session,packet); };
    const petQuestData=require('../data/Pets/c4-quest-npcs.json');
    for(const id of [919,920,921]) {
        const rewards=petQuestData.rewards.find(row=>row.selfId===id);
        assert(rewards.rewards.some(group=>group.items.some(item=>item.selfId===57)) && rewards.spoils.length,'quest monsters retain normal drops and spoil');
        for(const group of [...rewards.rewards,...rewards.spoils]) for(const item of group.items) assert(DataCache.items.some(row=>row.selfId===item.selfId),`loot item ${item.selfId} exists`);
    }
    const kill = id => Q.onKill(session, { fetchSelfId: () => id });
    async function random(value, fn) { const previous = Math.random; Math.random = () => value; try { return await fn(); } finally { Math.random = previous; } }
    async function summon(itemId) {
        const collar = pack.fetchItems().find(item=>item.fetchSelfId()===itemId);
        pack.spawnPetFromItem(session,{itemObjectId:collar.fetchId(),npcId:Rules.TYPES[itemId].npcId});
        assert(actor.pet, `summon ${itemId}`); await actor.pet.persistTail;
        return actor.pet;
    }
    async function dismiss() {
        const pet = actor.pet;
        if (pet) { Control.unsummon(session,actor,pet); await pet.teardownTail; }
    }
    // Every dragon branch, both stone recipes, three random hatchling types.
    for (let n=0;n<LittleWing.dragons.length;n++) {
        const dragon = LittleWing.dragons[n], deluxe = n===1 || n===2;
        assert(await event(420,7829,'start'));
        assert.strictEqual(state(420).getInt('cond'),1);
        await event(420,7829,'deluxe');
        assert.strictEqual(state(420).getInt('cond'),1,'recipe only at Cronos');
        await event(420,7610,deluxe?'deluxe':'normal');
        await event(420,7608,'craft');
        assert.strictEqual(state(420).getInt('cond'),2,'no free materials');
        for (const [id,amount] of LittleWing.materials(deluxe)) if (![3820,3818,3819].includes(id)) await Q.giveItem(session,id,amount);
        await random(.3,()=>kill(231));
        assert.strictEqual(count(3820),0,'30 percent back skin chance');
        const previousRate = process.env.L2NODE_PROGRESSION_RATE;
        process.env.L2NODE_PROGRESSION_RATE = 'x50';
        try { await random(.29,()=>kill(231)); } finally {
            if(previousRate===undefined) delete process.env.L2NODE_PROGRESSION_RATE; else process.env.L2NODE_PROGRESSION_RATE=previousRate;
        }
        assert.strictEqual(count(3820),1,'authored drop quantity ignores server rates');
        const skins = deluxe?20:10;
        await random(0,async()=>{for(let i=0;i<skins+2;i++) await kill(231);});
        assert.strictEqual(count(3820),skins);
        if(n===0) {
            read.exec("CREATE TRIGGER reject_stone BEFORE INSERT ON items WHEN NEW.selfId = 3816 BEGIN SELECT RAISE(ABORT,'stone rollback'); END");
            await assert.rejects(event(420,7608,'craft'),/stone rollback/);
            assert.strictEqual(count(3820),skins); assert.strictEqual(state(420).getInt('cond'),2);
            assert.strictEqual(read.prepare('SELECT amount FROM items WHERE selfId=3820').get().amount,skins);
            read.exec('DROP TRIGGER reject_stone');
        }
        await event(420,7608,'craft');
        assert.strictEqual(count(3820),0);
        assert.strictEqual(count(deluxe?3817:3816),1);
        await event(420,7610,'cronos'); await event(420,7711,'byron'); await event(420,7747,'fairy');
        assert.strictEqual(count(3821),1);
        await event(420,dragon.npc,`dragon_${dragon.npc}`);
        await random(.5,()=>kill(dragon.mob));
        assert.strictEqual(count(dragon.egg),0,'50 percent egg chance');
        await random(0,async()=>{for(let i=0;i<22;i++) await kill(dragon.mob);});
        assert.strictEqual(count(dragon.egg),20);
        await event(420,dragon.npc,`eggs_${dragon.npc}`);
        assert.strictEqual(count(dragon.egg),1,'twenty rescued eggs become one gifted egg');
        const type = n%3, before = count(3500+type);
        await random((type+.1)/3,()=>event(420,7747,deluxe?'dust':'hatch'));
        assert.strictEqual(count(3500+type),before+1);
        assert.strictEqual(count(dragon.egg),0);
        assert.strictEqual(state(420).isStarted(),false);
        await event(420,7747,'hatch'); assert.strictEqual(count(3500+type),before+1,'reward replay rejected');
    }
    assert(count(3912)===1 && count(4038)===100,'both fairy dust rewards exercised');
    // Losing a deluxe stone really resets the route.
    await event(420,7829,'start'); await event(420,7610,'deluxe');
    for(const [id,amount] of LittleWing.materials(true)) if(id!==3819) await Q.giveItem(session,id,amount);
    await event(420,7608,'craft'); await kill(589);
    assert.strictEqual(count(3817),0); assert.strictEqual(state(420).getInt('cond'),1);
    await event(420,7610,'normal'); assert.strictEqual(count(3818),1);
    await abort(420); assert.strictEqual(count(3818),0); assert.strictEqual(state(420).isStarted(),false);

    for(const [type,npcId] of [[3500,12311],[3501,12312],[3502,12313]]) {
        const pet = await summon(type);
        assert.strictEqual(pet.fetchLevel(),35);
        const collarId = pet.fetchPetControlItemObjectId();
        const wantedLevel = type===3500?65:55;
        pet.petData.exp=Rules.stats(npcId,wantedLevel).exp+123;
        pet.petData.level=wantedLevel; pet.petData.name=`Wing${type}`; pet.model.name=pet.petData.name;
        pet.petData.sp=77; Runtime.applyStats(pet);
        pet.setCurrentFeed(pet.fetchMaxFeed()); await Runtime.persist(pet);
        await event(421,7610,'start'); assert.strictEqual(state(421).getInt('controlId'),collarId);
        await event(421,7747,'leaves'); assert.strictEqual(count(4325),4);
        if(type===3500) {
            await abort(421); assert.strictEqual(count(4325),0); assert.strictEqual(state(421).isStarted(),false);
            await event(421,7610,'start'); await event(421,7747,'leaves');
            await Q.takeItem(session,4325,4);
            await event(421,7747,'leaves'); assert.strictEqual(count(4325),4,'Mymyu replaces lost leaves and restarts tree progress');
        }
        const tree = id => ({ fetchSelfId:()=>id,state:{fetchDead:()=>false} });
        await random(0,()=>Q.onAttack(session,tree(5185),actor,10));
        assert.strictEqual(count(4325),4,'owner attacks cannot feed hatchling');
        pet.model.level=54;
        await random(0,()=>Q.onAttack(session,tree(5185),pet,10));
        assert.strictEqual(count(4325),4,'hatchling level 55 required');
        pet.model.level=wantedLevel;
        await random(.03,()=>Q.onAttack(session,tree(5185),pet,10));
        assert.strictEqual(count(4325),4,'tree acceptance chance is three percent');
        const fakePet = Object.create(pet); actor.pet=fakePet;
        await random(0,()=>Q.onAttack(session,tree(5185),pet,10)); actor.pet=pet;
        assert.strictEqual(count(4325),4,'attack must be from active hatchling');
        await random(0,async()=>{
            for(const id of Evolution.trees) { await Q.onAttack(session,tree(id),pet,10); await Q.onAttack(session,tree(id),pet,10); }
        });
        assert.strictEqual(count(4325),0); assert.strictEqual(state(421).getInt('trees'),15);
        if(type===3500) {
            await Inventory.transfer(session,pack.fetchItemFromSelfId(3912).fetchId(),1,'deposit');
            const armor = Inventory.items(pet).find(item=>item.fetchSelfId()===3912);
            await Inventory.use(session,armor.fetchId());
            assert(Inventory.items(pet).find(item=>item.fetchId()===armor.fetchId()).fetchEquipped());
            read.exec("CREATE TRIGGER reject_pet_save BEFORE UPDATE OF petData ON items WHEN OLD.selfId = 3500 BEGIN SELECT RAISE(ABORT,'save rollback'); END");
            await assert.rejects(event(421,7747,'evolve'),/save rollback/);
            assert.strictEqual(actor.pet,pet); assert.strictEqual(pet.evolving,false,'failed save releases evolution lock');
            read.exec('DROP TRIGGER reject_pet_save');
            read.exec("CREATE TRIGGER reject_evolution BEFORE UPDATE OF selfId ON items WHEN NEW.selfId = 4422 BEGIN SELECT RAISE(ABORT,'evolution rollback'); END");
            await assert.rejects(event(421,7747,'evolve'),/evolution rollback/);
            assert.strictEqual(pack.fetchItemRaw(collarId).fetchSelfId(),3500);
            assert(actor.pet, 'failed evolution restores the original pet');
            read.exec('DROP TRIGGER reject_evolution');
        }
        const old = actor.pet, original = {...old.petData};
        await event(421,7747,'evolve');
        assert.strictEqual(actor.pet,null);
        const bugle = pack.fetchItemRaw(collarId);
        assert.strictEqual(bugle.fetchSelfId(),type-3500+4422);
        const saved = JSON.parse(read.prepare('SELECT petData FROM items WHERE id=?').get(collarId).petData);
        assert.strictEqual(saved.name,original.name); assert.strictEqual(saved.exp,original.exp); assert.strictEqual(saved.sp,77);
        assert.strictEqual(saved.level,wantedLevel); assert.strictEqual(saved.hp,Rules.stats(saved.npcId,wantedLevel).maxHp);
        assert.strictEqual(saved.currentFeed,Rules.stats(saved.npcId,wantedLevel).maxFeed);
        assert(saved.inventory.every(row=>!row.equipped),'hatchling gear unequipped without loss');
        assert.strictEqual(saved.inventory.length,original.inventory.length);
        await assert.rejects(Database.evolveHatchling(actor.fetchId(),collarId),/not ready/);
    }
    const treeTemplate=DataCache.npcs.find(npc=>npc.selfId===5185);
    const treeNpc=new (invoke('GameServer/Npc/Npc'))(World.npc.nextId++,{...utils.crushOb(treeTemplate),locX:actor.fetchLocX(),locY:actor.fetchLocY(),locZ:actor.fetchLocZ()});
    const guardians=invoke('GameServer/Pets/FairyTrees').onDeath(session,actor,treeNpc);
    assert.strictEqual(guardians.length,20,'destroying a fairy tree summons twenty guardians');
    assert(guardians.every(npc=>npc.fetchSelfId()===5189 && npc.questSpawn.timer));
    for(const guardian of guardians) World.despawnQuestNpc(guardian,session);
    treeNpc.destructor(session);
    console.log('All five hatchling quests and all three strider evolutions passed');

    let strider = await summon(4422);
    const model = invoke('GameServer/Model/Actor');
    const originalLevel=actor.fetchLevel;
    strider.setCurrentFeed(strider.fetchMaxFeed()*.54); assert.strictEqual(Mount.mount(session,actor),false);
    strider.setCurrentFeed(strider.fetchMaxFeed());
    const mountPacketStart = session.packets.length;
    const nearbyPackets = [];
    session.dataSendToOthers = packet => nearbyPackets.push(packet);
    assert(Mount.mount(session,actor));
    assert(session.packets.slice(mountPacketStart).some(packet => packet[0] === 0x04), 'rider receives full UserInfo');
    assert(!session.packets.slice(mountPacketStart).some(packet => packet[0] === 0x03), 'CharInfo must not reset the rider HUD');
    assert(nearbyPackets.some(packet => packet[0] === 0x03), 'nearby players receive mounted CharInfo');
    assert(!World.npc.spawns.includes(strider));
    const ride=session.packets.findLast(packet=>packet[0]===0x86);
    assert.strictEqual(ride.readInt32LE(5),1); assert.strictEqual(ride.readInt32LE(9),1); assert.strictEqual(ride.readInt32LE(13),1012526);
    for(const [gap,attack,speed] of [[5,1,1],[6,.5,1],[9,.35,1],[10,.3,.5]]) {
        actor.fetchLevel=()=>strider.fetchLevel()-gap;
        assert(Math.abs(Mount.stats(actor).pAtk-strider.fetchPAtk()*attack)<.0001);
        assert.strictEqual(Mount.stats(actor).run,strider.fetchCollectiveRunSpd()*speed);
        assert.strictEqual(model.prototype.fetchCollectivePAtk.call(actor),Mount.stats(actor).pAtk);
    }
    actor.fetchLevel=originalLevel;
    const exp=strider.fetchExp(); assert.strictEqual(Runtime.award(strider,1000),false); assert.strictEqual(strider.fetchExp(),exp);
    await Q.giveItem(session,5168,2);
    strider.setCurrentFeed(strider.fetchMaxFeed()*.3);
    await Runtime.feedTick(strider);
    assert(strider.fetchCurrentFeed()>strider.fetchMaxFeed()*.3); assert.strictEqual(count(5168),1,'mounted strider eats from owner inventory');

    // Teleport entry point: same persistent pet, repeated request, stop order and mounted travel.
    const Teleport = invoke('GameServer/Actor/Generics/TeleportTo');
    const Generics = invoke('GameServer/Actor/Generics');
    const originalUpdate=Generics.updatePosition;
    Generics.updatePosition=(s,a,coords)=>a.setLocXYZ(coords);
    session.accountId='bot_travel_test'; // No unrelated party-companion work in this fixture.
    async function teleport(coords) { assert(Teleport(session,actor,coords)); await wait(1050); }
    try {
        await teleport({locX:100000,locY:100000,locZ:100});
        assert.strictEqual(actor.pet,strider); assert.strictEqual(strider.fetchLocX(),100000); assert(!World.npc.spawns.includes(strider));
        assert(Mount.dismount(session,actor,true)); await strider.teardownTail;
        assert.strictEqual(actor.pet,null); assert(!pack.fetchItemRaw(strider.fetchPetControlItemObjectId()).petInUse);
        strider=await summon(4422);
        assert(strider.followOwner);
        Teleport(session,actor,{locX:150000,locY:100000,locZ:200});
        await wait(20);
        await teleport({locX:-150000,locY:-100000,locZ:-300});
        assert.strictEqual(actor.pet,strider); assert.strictEqual(strider.fetchLocX(),-150000); assert(strider.followOwner);
        assert.strictEqual(World.npc.spawns.filter(npc=>npc===strider).length,1);
        assert.strictEqual(Object.values(World.npc.grid).flat().filter(npc=>npc===strider).length,1,'one spatial index at destination');
        Control.stop(session,strider);
        await teleport({locX:0,locY:0,locZ:0}); assert.strictEqual(strider.followOwner,false,'hold order survives teleport');
        Runtime.die(strider); const deadline=strider.petData.deadUntil;
        await teleport({locX:40000,locY:40000,locZ:0});
        assert.strictEqual(actor.pet,strider); assert(strider.state.fetchDead()); assert.strictEqual(strider.petData.deadUntil,deadline);
        assert.strictEqual(strider.fetchLocX(),40000);
        await dismiss();
        const resummoned = await summon(4422);
        assert(resummoned.state.fetchDead(),'corpse persistence after teleport and recall'); await dismiss();
    } finally { Generics.updatePosition=originalUpdate; }
    console.log('Mounted stats, food, native Ride packet and teleport lifecycle passed');

    // Real owner healing through Npc.castSkill and the ordinary skill engine.
    await Q.giveItem(session,6649,1);
    const baby=await summon(6649);
    const AI=invoke('GameServer/Pets/BabyPetAI');
    clearInterval(baby.timer.babyHeal);
    actor.setHp(10); baby.setMp(baby.fetchMaxMp());
    const beforeMp=baby.fetchMp();
    assert(AI.tick(baby,()=>0));
    await wait(5500);
    assert(actor.fetchHp()>10,'baby heal must actually land on owner');
    assert(baby.fetchMp()<beforeMp,'baby spends MP');
    actor.setHp(10); assert.strictEqual(AI.tick(baby,()=>0),false,'strong heal on reuse');
    baby.skillReuseUntil.clear();
    baby.ownerTeleport=true; assert.strictEqual(AI.tick(baby,()=>0),false); baby.ownerTeleport=false;
    actor.setHp(100); assert.strictEqual(AI.tick(baby,()=>0),false,'no unnecessary healing');
    actor.setHp(60); baby.setMp(baby.fetchMaxMp());
    assert(AI.tick(baby,()=>0)); await wait(5500); assert(actor.fetchHp()>60,'weak heal lands');
    await dismiss();
    assert.strictEqual(read.prepare('PRAGMA quick_check').get().quick_check,'ok');
    console.log('Baby healing, MP and reuse passed; SQLite quick_check ok');
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
    for(const npc of [...(World.npc?.spawns||[])]) npc.destructor?.(session);
    session?.actor?.pet?.destructor(session);
    await Database.close(); read?.close(); fs.rmSync(temp,{recursive:true,force:true});
});
