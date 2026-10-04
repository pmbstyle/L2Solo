const assert=require('node:assert/strict');
const shared=require('./knightProfessionHarness');
const {life}=require('./elderProfessionHarness');
const {fate}=require('./darkElfProfessionHarness');
const {createTrialWorld,H,Service,DataCache,withRandom,reloadActor,finishRoute,master}=shared;
const Profession=invoke('GameServer/SecondProfession');
const NpcTalk=invoke('GameServer/World/Generics/NpcTalk');
const Transfer=invoke('GameServer/World/Generics/NpcBypasses/SecondProfession');

async function award(c,q,npc,mark,exp,sp,diamonds=0) {
    const before=await c.world.character(c.id),dd=await c.amount(7562);
    await c.world.talk(c.session,npc);
    assert.deepEqual(await Promise.all([c.event(q,'handin',npc),c.event(q,'handin',npc)]),[true,false]);
    const after=await c.world.character(c.id);
    assert.equal(after.exp-before.exp,exp);assert.equal(after.sp-before.sp,sp);
    assert.equal(await c.amount(7562)-dd,diamonds);assert.equal(await c.amount(mark),1);
    for(const i of c.state(q).quest.questItems) assert.equal(await c.amount(i),0);
    await c.reopen();assert.equal(c.state(q).state,'completed');
    assert.equal(await c.event(q,'handin',npc),false);assert.deepEqual(await c.world.character(c.id),after);
}
async function equip(c,itemId) {
    await reloadActor(c);
    const item=c.session.actor.backpack.fetchItems().find(i=>i.fetchSelfId()===itemId);assert(item);
    c.session.actor.backpack.equipGear(c.session,item);
    await c.session.actor.backpack.updateDatabaseTimer(c.id,[item]);
    await c.reopen();await reloadActor(c);
    assert.equal(c.session.actor.backpack.fetchEquippedWeapon().fetchSelfId(),itemId);
    const other=itemId===3028?229:224;
    await assert.rejects(invoke('GameServer/Quest/QuestStep').apply(Service.stateFor(c.session,Service.quests().find(q=>q.id===other)),{takes:[[itemId,1]]}),/Required quest items missing/);
}
async function seeker(c) {
    await c.level(34);assert.equal(await c.event(213,'start',7106),false);
    await c.level(35);await c.click(213,'start',7106);
    assert.equal(await c.event(213,'handin',7684),false);
    await c.click(213,'handin',7064);
    await c.kill(198,1,.1);assert.equal(await c.amount(2653),0);
    await c.kill(198,2,.099);assert.equal(await c.amount(2653),1);await c.click(213,'handin',7064);
    for(const [mob,item] of [[211,2654],[495,2655],[80,2656],[249,2657]]) {
        await c.kill(mob,1,.25);assert.equal(await c.amount(item),0);await c.kill(mob,2,.249);assert.equal(await c.amount(item),1);
    }
    for(const npc of [7064,7684,7064,7684]) await c.click(213,'handin',npc);
    await c.kill(158,1,.3);assert.equal(await c.amount(2660),0);await c.kill(158,12);assert.equal(await c.amount(2660),10);
    for(const npc of [7684,7715,7526,7715,7064]) await c.click(213,'handin',npc);
    assert.equal(c.cond(213),12);assert.equal(await c.amount(2666),1);
    await c.click(213,'handin',7064);assert.equal(c.cond(213),12);
    await c.reopen();await c.level(36);await c.click(213,'handin',7064);
    for(const mob of [234,270,88,580]) await c.kill(mob,2);
    await c.click(213,'handin',7064);await award(c,213,7106,2673,72126,11000,8);
}
async function scholar(c,reverse=false) {
    await c.level(34);assert.equal(await c.event(214,'start',7461),false);
    await c.level(35);await c.click(214,'start',7461);
    for(const npc of [7070,7608,7071,7608,7609,7608,7609,7608,7071]) await c.click(214,'handin',npc);
    await c.kill(580,1,.5);assert.equal(await c.amount(2687),0);await c.kill(580,7);assert.equal(await c.amount(2687),5);
    for(const npc of [7608,7070,7461,7115]) await c.click(214,'handin',npc);
    await c.kill(68,6);await c.kill(269,6);await c.kill(235,3);
    for(const npc of [7115,7461]) await c.click(214,'handin',npc);
    assert.equal(c.cond(214),16);await c.click(214,'handin',7461);assert.equal(c.cond(214),16);
    await c.reopen();await c.level(36);
    for(const npc of [7461,7610,7111,7609,7111,7230,7316,7611]) await c.click(214,'handin',npc);
    const second=async()=>{for(const npc of [7103,7608,7103])await c.click(214,'handin',npc);};
    const fourth=async()=>{
        await c.click(214,'handin',7458);await c.click(214,'handin',7612);
        for(const [mob,n] of [[201,10],[158,12],[552,5],[567,5]]) await c.kill(mob,n+1);
        await c.click(214,'handin',7612);
    };
    await c.kill(554,1,.3);assert.equal(await c.amount(2708),0);await c.kill(554,2,.299);assert.equal(await c.amount(2708),1);
    await (reverse?fourth():second());await c.reopen();await (reverse?second():fourth());
    await c.click(214,'handin',7610);await award(c,214,7461,2674,80265,30000,8);
}
async function sagittarius(c) {
    await c.level(38);assert.equal(await c.event(224,'start',7702),false);
    await c.level(39);await c.click(224,'start',7702);
    for(const npc of [7626,7653])await c.click(224,'handin',npc);
    await c.kill(79,1,.5);assert.equal(await c.amount(3298),0);await c.kill(90,11);assert.equal(await c.amount(3298),10);
    for(const npc of [7626,7514])await c.click(224,'handin',npc);
    await c.kill(270,1,.6);assert.equal(await c.amount(3299),0);await c.kill(269,11);
    assert.equal(await c.amount(3299),0);assert.equal(await c.amount(3301),1);
    for(const npc of [7514,7626,7717])await c.click(224,'handin',npc);
    for(const mob of [230,563,233,551])await c.kill(mob,2);
    await c.click(224,'handin',7717);await c.click(224,'handin',7626);
    await c.kill(577,122);assert.equal(await c.amount(3306),121);
    assert.equal(H.personalSpawns(c.state(224),5090).length,1);
    await c.kill(5090);assert.equal(await c.amount(3300),0);
    await c.ownedKill(224,5090);assert.equal(c.cond(224),11,'carried bow is insufficient');
    await c.reopen();await c.click(224,'recover',7626);await c.click(224,'recover',7626);
    assert.equal(H.personalSpawns(c.state(224),5090).length,1);
    await equip(c,3028);await c.ownedKill(224,5090);assert.equal(await c.amount(3300),1);
    await award(c,224,7626,3293,54726,20250);
    assert.equal(c.session.questWaypoints?.size||0,0);assert.equal(H.personalSpawns(c.state(224)).length,0);
    assert.equal(await c.amount(17),10,'ordinary arrows survive quest cleanup');
}
async function magus(c,reverse=false) {
    await c.level(39);await c.click(228,'start',7629);
    for(const npc of [7391,7612])await c.click(228,'handin',npc);
    for(const mob of [5095,5096,5097])await c.kill(mob,2);
    await c.click(228,'handin',7629);
    const branches=[[7413,[[234,20]]],[7411,[[5098,5]]],[7412,[[145,20],[176,10],[553,10]]],[7409,[[564,10],[565,10],[566,10]]]];
    if(reverse)branches.reverse();
    for(const [npc] of branches) await c.click(228,'handin',npc);
    for(const [npc,hunts]of branches) {
        assert.equal(await c.event(228,'handin',npc),false);
        for(const [mob,n]of hunts) await c.kill(mob,n+1);
        await c.reopen();await c.click(228,'handin',npc);assert.equal(await c.event(228,'handin',npc),false);
    }
    await award(c,228,7629,2840,139039,40000);
}
async function witchcraft(c,reverse=false) {
    await c.level(39);await c.click(229,'start',7630);await c.click(229,'handin',7098);
    await c.click(229,'handin',7110);
    for(const mob of [557,565,577])await c.kill(mob,21);
    await c.click(229,'handin',7110);await c.click(229,'handin',7476);
    await c.click(229,'handin',7063);await c.kill(5099,2);
    for(const npc of [7314,7435])await c.click(229,'handin',npc);
    await c.kill(5100,4);for(const item of [3320,3321,3322])assert.equal(await c.amount(item),1);
    await c.reopen();await c.click(229,'handin',7630);
    await c.kill(5101);assert.equal(c.cond(229),3);
    H.clearSpawns(c.state(229));await c.reopen();await c.click(229,'recover',7630);await c.click(229,'recover',7630);
    assert.equal(H.personalSpawns(c.state(229),5101).length,1);
    await c.ownedKill(229,5101);await c.click(229,'handin',7630);
    if(!reverse)await c.click(229,'handin',7110);
    for(const npc of [7417,7188])await c.click(229,'handin',npc);
    await c.kill(601,1,.5);assert.equal(await c.amount(3329),0);await c.kill(602,21);
    for(const npc of [7188,7417])await c.click(229,'handin',npc);
    if(reverse)await c.click(229,'handin',7110);
    await c.click(229,'handin',7633);await c.ownedKill(229,5101);assert.equal(c.cond(229),6);
    await c.reopen();await c.click(229,'recover',7633);await equip(c,3029);
    await c.ownedKill(229,5101);assert.equal(c.cond(229),7);
    await award(c,229,7630,3307,139796,40000);
    assert.equal(H.personalSpawns(c.state(229)).length,0);assert.equal(c.session.questWaypoints?.size||0,0);
}
function summon(c) {
    const Npc=invoke('GameServer/Npc/Npc'),d=DataCache.npcs.find(n=>n.selfId==={0:12006,1:12357,2:12070}[c.session.actor.fetchRace()]);assert(d);
    const pet=new Npc(c.runtime.npc.nextId++,{...utils.crushOb(d),locX:0,locY:0,locZ:0,head:0,isSummon:true,ownerId:c.id});
    c.session.actor.summon=pet;c.session.summon=pet;c.runtime.npc.spawns.push(pet);
    c.runtime.user.sessions=[c.session];return pet;
}
async function duelHit(c,pet,npc,lethal=false) {
    invoke('GameServer/Npc/Generics/ReceivedHit')(c.session,pet,npc,lethal?npc.fetchHp()+1:1);
    await c.session.questMutationTail;await npc.soulCrystalReward;
}
async function summoner(c) {
    await c.level(39);await c.click(230,'start',7634);
    // Exercise all five authored lists, including RNG boundaries and drop caps.
    const lists=[[555,577],[600,563],[552,267],[553,192],[89,176]];
    for(let i=0;i<5;i++) {
        await withRandom([i/5],()=>c.click(230,'list',7063));assert.equal(c.state(230).getInt('list'),i+1);
        for(const mob of lists[i])await c.kill(mob,31);
        await c.reopen();await c.click(230,'handin',7063);
        assert.equal(await c.event(230,'handin',7063),false);
    }
    assert.equal(await c.amount(3353),10);
    await reloadActor(c);let pet=summon(c);
    await c.click(230,'duel',7635);let npc=H.personalSpawns(c.state(230),5102)[0];
    // A real player's attack fouls this duel immediately.
    await duelHit(c,c.session.actor,npc);assert.equal(c.state(230).getInt('duel'),0);assert.equal(await c.amount(3362),1);
    await c.click(230,'duel',7635);npc=H.personalSpawns(c.state(230),5102)[0];
    await duelHit(c,pet,npc);assert.equal(c.state(230).getInt('pet'),pet.fetchId());
    // Switching the actual summon is a foul, even though its owner is unchanged.
    pet=summon(c);await duelHit(c,pet,npc);assert.equal(await c.amount(3362),1);
    await c.click(230,'duel',7635);npc=H.personalSpawns(c.state(230),5102)[0];await duelHit(c,pet,npc);
    invoke('GameServer/Actor/Generics/NpcDied')(c.session,npc,pet);await c.session.questMutationTail;
    assert.equal(await c.amount(3363),1,'runtime summon death delivers defeat');
    await c.click(230,'duel',7635);H.clearSpawns(c.state(230));await c.reopen();
    await c.click(230,'forfeit',7635);assert.equal(await c.amount(3353),6,'restart recovery does not refund a spent attempt');
    await reloadActor(c);pet=summon(c);
    for(let i=0;i<6;i++) {
        await c.click(230,'duel',7635+i);npc=H.personalSpawns(c.state(230),5102+i)[0];assert(npc);
        // Real ReceivedHit -> Die -> NpcDied -> QuestService credits a lethal first hit.
        await duelHit(c,pet,npc,true);assert.equal(await c.amount(3364+i*5),1);
        await c.click(230,'handin',7635+i);assert.equal(await c.event(230,'handin',7635+i),false);
    }
    await award(c,230,7634,3336,148409,30000);
    assert.equal(H.personalSpawns(c.state(230)).length,0);assert.equal(c.session.questWaypoints?.size||0,0);
}

const PROFILES={
    6:[4,0,[[283,1],[86,1],[239,2]]],33:[32,2,[[33,1],[289,1],[239,2]]],
    8:[7,0,[[30,3],[263,3],[221,1]]],23:[22,1,[[30,3],[263,3],[123,1]]],36:[35,2,[[30,3],[263,3],[122,1]]],
    9:[7,0,[[19,3],[101,6],[131,1]]],24:[22,1,[[19,3],[101,6],[123,1]]],37:[35,2,[[19,3],[101,6],[122,1]]],
    12:[11,0,[[1230,2],[1171,2],[239,2]]],13:[11,0,[[1234,2],[1154,1],[1262,1]]],14:[11,0,[[1276,1],[1279,1],[1262,1]]],
    27:[26,1,[[1235,2],[1265,1],[239,2]]],28:[26,1,[[1277,1],[1280,1],[1262,1]]],
    40:[39,2,[[1239,2],[1267,1],[239,2]]],41:[39,2,[[1278,1],[1281,1],[1262,1]]]
};
async function runRoute(target) {
    const [classId,race,ranks]=PROFILES[target],route=Profession.routes.find(r=>r.classId===target);
    const c=await createTrialWorld(route.name.toLowerCase().replaceAll(' ','-'),184000+target,[],{classId,race,level:34});
    try {
        for(const q of route.quests) {
            if(q===212) await shared.duty(c);
            else if(q===213) await seeker(c);
            else if(q===214) await scholar(c,race!==0);
            else if(q===217) await shared.trust(c);
            else if(q===218) await life(c);
            else if(q===219) await fate(c);
            else if(q===224) await sagittarius(c);
            else if(q===225) {await c.level(39);await require('./searcherProfessionHarness').searcher(c);}
            else if(q===228) await magus(c,race!==0);
            else if(q===229) await witchcraft(c,race!==0);
            else if(q===230) await summoner(c);
            else throw Error('unhandled trial '+q);
        }
        await c.level(39);await reloadActor(c);
        for(const npc of route.npcs) {
            NpcTalk(c.session,master(c,npc));await c.session.questMutationTail;await new Promise(r=>setImmediate(r));
            assert.match(c.world.page(c.session),/second-profession/);assert(Profession.render(c.session));
            assert(c.world.page(c.session).includes(`Become a ${route.name}`));
        }
        master(c,route.npcs[0]);assert.equal((await Transfer(c.session,['second-profession',String(target===6?33:6)])).ok,false);
        await c.reopen();await c.level(39);await finishRoute(c,target,ranks);
        console.log(`${route.name}: full C4 trials, real NPC dialogues, persisted proofs, personal encounters, atomic three-mark transfer and class skills passed`);
    } finally {await c.close();}
}
module.exports={runRoute,seeker,scholar,sagittarius,magus,witchcraft,summoner,equip,award};
