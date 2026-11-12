const assert=require('assert');
require('../src/Global');
const World=invoke('GameServer/World/World');
const {registerSessions}=require('./helpers/worldSessions');
const GroundItems=require('../src/GameServer/World/GroundItems');
const Bots=invoke('GameServer/Bot/BotManager');
const Loot=invoke('GameServer/Bot/AI/PartyCompanionService');
const Policy=invoke('GameServer/Bot/AI/PartyCombatLootPolicy');
const Awareness=invoke('GameServer/Bot/AI/PartyAwareness');
const Geo=invoke('GameServer/Geodata/GeodataEngine');
const Automation=invoke('GameServer/Automation');
const NativePickup=invoke('GameServer/World/Generics/PickupItem');
const Data=invoke('GameServer/DataCache');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const sessions=[];
function session(id,x,classId,player=false) {
    const s={accountId:player?'player_loot':`bot_${id}`,plan:'following',dataSendToMe(){},dataSendToMeAndOthers(){}};
    s.actor={session:s,x,hp:100,classId,automation:new Automation(),
        fetchId:()=>id,fetchHead:()=>0,fetchLevel:()=>60,fetchClassId(){return this.classId;},
        fetchLocX(){return this.x;},fetchLocY:()=>0,fetchLocZ:()=>0,
        fetchHp(){return this.hp;},fetchMaxHp:()=>100,fetchMp:()=>100,fetchMaxMp:()=>100,
        fetchIsOnline:()=>true,isDead:()=>false,fetchCollectiveRunSpd:()=>200,
        setLocXYZ(loc){this.x=loc.locX;},backpack:{fetchEquippedWeapon:()=>null},
        state:{hits:player,casts:false,towards:false,pickup:false,
            fetchHits(){return this.hits;},fetchCasts(){return this.casts;},fetchTowards(){return this.towards;},
            setTowards(v){this.towards=v;},fetchSeated:()=>false,fetchPickinUp(){return this.pickup;},setPickinUp(v){this.pickup=v;}}
    };
    sessions.push(s);return s;
}
const leader=session(2400001,0,5,true),support=session(2400002,-300,30),fighter=session(2400003,-380,5);
for(const s of [support,fighter]) Object.assign(s,{partyCompanion:true,followPlayerSession:leader,partyCombatLootReadyAt:Date.now()});
registerSessions(sessions);Bots.sessions=[support,fighter];World.items={spawns:[],byLeader:new Map()};
const enemy={x:800,y:0,z:0,hostile:true,targetId:leader.actor.fetchId(),attacking:true,range:40,skills:[],
    fetchId:()=>3400001,fetchAttackable:()=>true,isDead:()=>false,
    fetchHostile(){return this.hostile;},fetchDestId(){return this.targetId;},fetchStateAttack(){return this.attacking;},
    fetchCombatAttackRange(){return this.range;},fetchCombatSkills(){return this.skills;},
    fetchSkillCastRange:skill=>skill.fetchDistance(),
    fetchLocX(){return this.x;},fetchLocY(){return this.y;},fetchLocZ(){return this.z;}};
World.npc={spawns:[enemy]};
World.fetchNpcsInRadius=(x,y,r)=>(World.npc.spawns || []).filter(n=>Math.hypot(n.fetchLocX()-x,n.fetchLocY()-y)<=r);
World.fetchItem=async id=>World.items.spawns.find(i=>i.fetchId()===id);
World.pickupItem=NativePickup.bind(World);
Geo.hasLineOfSight=()=>true;
Data.fetchItemFromSelfId=(id,cb)=>cb({selfId:id,template:{name:'Adena'},etc:{stackable:true}});
const purchases=[];
World.purchaseItem=(s,id,amount)=>purchases.push([s.actor.fetchId(),id,amount]);
let itemId=4400000;
function drop(x=-400) {
    const id=++itemId;
    return {model:{partyLootLeaderId:leader.actor.fetchId()},fetchId:()=>id,fetchSelfId:()=>57,fetchAmount:()=>12,
        fetchLocX:()=>x,fetchLocY:()=>0,fetchLocZ:()=>0};
}
function ready(){support.partyCombatLootReadyAt=Date.now();Awareness.invalidateThreatProjection(leader);}
function allowed(item=drop()){return Policy.allowed(support,leader,item,sessions);}

(async()=>{
    try {
        ready();assert(allowed(),'idle support may collect a safe nearby drop while its leader fights');
        for(const classId of [17,30,43,52]){support.actor.classId=classId;assert(allowed(),`idle support class ${classId}`);}
        support.actor.classId=30;
        assert.strictEqual(Policy.allowed(fighter,leader,drop(),sessions),false,'combat roles do not abandon their job for loot');
        support.partyCombatLootReadyAt=0;assert.strictEqual(allowed(),false,'support decisions must grant the free tick first');ready();
        support.actor.state.casts=true;assert.strictEqual(allowed(),false);support.actor.state.casts=false;
        support.pendingSupportApproach={};assert.strictEqual(allowed(),false);support.pendingSupportApproach=null;
        leader.actor.hp=60;assert.strictEqual(allowed(),false,'party healing outranks loot');leader.actor.hp=100;
        support.actor.hp=60;assert.strictEqual(allowed(),false,'hurt support cannot start looting');support.actor.hp=100;
        assert.strictEqual(allowed(drop(-650)),false,'combat loot stays near the party');
        const hazard={...enemy,fetchId:()=>3400002,x:-350,y:599,attacking:false,fetchDestId:()=>undefined};
        World.npc.spawns.push(hazard);assert.strictEqual(allowed(),false,'path clearance catches aggro even when both endpoints clear 600 units');
        hazard.hostile=false;assert(allowed(),'a peaceful idle NPC is not an aggro hazard');
        World.npc.spawns.pop();

        enemy.x=0;ready();
        assert(allowed(),'a mob fighting the nearby party tank does not reserve the full aggro radius');
        enemy.attacking=false;assert.strictEqual(allowed(),false,'a stale tank target is not active protection');enemy.attacking=true;
        enemy.targetId=support.actor.fetchId();assert.strictEqual(allowed(),false,'a mob attacking support keeps full clearance');
        enemy.targetId=999999;assert.strictEqual(allowed(),false,'an unrelated tank does not protect this party');
        enemy.targetId=leader.actor.fetchId();leader.actor.classId=2;
        assert.strictEqual(allowed(),false,'a non-tank leader does not qualify');leader.actor.classId=5;
        enemy.targetId=fighter.actor.fetchId();fighter.actor.x=0;
        assert(allowed(),'a companion tank provides the same protection as a player tank');
        fighter.actor.x=-380;enemy.targetId=leader.actor.fetchId();
        enemy.x=200;assert.strictEqual(allowed(),false,'a mob still approaching the tank is not held in place');enemy.x=0;
        assert.strictEqual(allowed(drop(-100)),false,'the pickup endpoint must stay outside melee reach plus margin');
        support.actor.x=-200;assert.strictEqual(allowed(drop(200)),false,'the whole route must avoid the mob, even with safe endpoints');support.actor.x=-300;
        enemy.range=400;assert.strictEqual(allowed(),false,'ranged attacks retain their actual reach');enemy.range=40;
        enemy.skills=[{fetchTargetKind:()=> 'enemy',fetchDistance:()=>0,fetchSemantic:()=>({sourceTarget:'aura',radius:250})}];
        assert.strictEqual(allowed(),false,'aura radius is part of the danger zone');
        enemy.skills=[{fetchTargetKind:()=> 'enemy',fetchDistance:()=>200,fetchSemantic:()=>({sourceTarget:'area',radius:100})}];
        assert.strictEqual(allowed(),false,'ranged splash includes cast range and effect radius');enemy.skills=[];
        enemy.model={raidBoss:true};assert.strictEqual(allowed(),false,'raid mobs do not get the tank exception');delete enemy.model;

        // A fighter owns an old queue; combat reconciliation transfers it to
        // the idle support and executes actual native movement and awarding.
        const item=drop();GroundItems.put(World.items,item);fighter.partyGroundPickupQueue=[{id:item.fetchId()}];
        leader.lastGroundLootScanAt=0;ready();Loot.reconcileGroundLoot(support);
        assert.strictEqual(support.partyGroundPickupInProgress,true);
        assert.deepStrictEqual(fighter.partyGroundPickupQueue,[]);
        await wait(300);
        assert(support.actor.x< -300 && support.actor.x> -400,'pickup moves physically during the ongoing fight');
        assert.deepStrictEqual(purchases,[],'no award before arrival');
        await wait(850);
        assert.strictEqual(World.items.spawns.length,0);
        assert.strictEqual(purchases.reduce((sum,p)=>sum+p[2],0),12,'native party distribution conserves the drop');
        assert.strictEqual(purchases.length,3,'party Adena distribution still includes all three members');

        support.actor.x=-300;const unsafe=drop(-500);GroundItems.put(World.items,unsafe);ready();
        Loot.queueRandomGroundPickup(leader,unsafe);await wait(300);
        enemy.targetId=support.actor.fetchId();ready();
        assert.strictEqual(Loot.startQueuedGroundPickup(support),false,'losing tank aggro interrupts the live pickup');
        const stoppedAt=support.actor.x;await wait(1100);
        assert.strictEqual(support.actor.x,stoppedAt,'cancelled pickup cannot continue its movement timer');
        assert(World.items.spawns.includes(unsafe),'interruption leaves the item on the ground');
        assert.strictEqual(purchases.length,3);
        enemy.targetId=leader.actor.fetchId();ready();

        support.actor.x=-300;support.partyGroundPickupQueue=[];World.items={spawns:[],byLeader:new Map()};
        const addedAggro=drop(-500);GroundItems.put(World.items,addedAggro);ready();
        Loot.queueRandomGroundPickup(leader,addedAggro);await wait(300);
        hazard.hostile=true;hazard.y=0;World.npc.spawns.push(hazard);
        assert.strictEqual(Loot.startQueuedGroundPickup(support),false,'a free aggressive add still interrupts native pickup');
        await wait(1100);
        assert(World.items.spawns.includes(addedAggro));assert.strictEqual(purchases.length,3);
        World.npc.spawns.pop();

        // Arrival must re-check urgent support even when no AI tick runs
        // after the emergency appears. There is no post-arrival award delay.
        support.actor.x=-300;support.partyGroundPickupQueue=[];World.items={spawns:[],byLeader:new Map()};
        const late=drop(-400);GroundItems.put(World.items,late);ready();Loot.queueRandomGroundPickup(leader,late);
        await wait(120);leader.actor.hp=40;await wait(550);
        assert(World.items.spawns.includes(late),'new emergency before arrival prevents pickup without an AI tick');
        assert.strictEqual(purchases.length,3);
        assert.strictEqual(support.actor.state.pickup,false,'aborted award releases pickup state');

        // Mid-fight a tree (one closed geodata cell, x -352..-337) stands between
        // the nearer idle support and the drop; a second idle support farther
        // away has a clear line. The farther one collects, the nearer one stays.
        leader.actor.hp=100;support.actor.x=-300;support.partyGroundPickupQueue=[];
        World.items={spawns:[],byLeader:new Map()};purchases.length=0;
        const second=session(2400004,-520,30);
        Object.assign(second,{partyCompanion:true,followPlayerSession:leader,partyCombatLootReadyAt:Date.now()});
        registerSessions(sessions);Bots.sessions=[support,fighter,second];
        const openCells=Geo.getCellData;
        Geo.getCellData=(x,y,z)=>({z,nswe:(x>>4)===-22 && (y>>4)===0?0:15});
        try {
            const shaded=drop(-400);GroundItems.put(World.items,shaded);ready();second.partyCombatLootReadyAt=Date.now();
            Loot.queueRandomGroundPickup(leader,shaded);
            await wait(900);
            assert.strictEqual(second.actor.x,-420,'the support with a clear line runs to the drop during the fight');
            assert.strictEqual(World.items.spawns.length,0,'and collects it');
            assert.strictEqual(support.actor.x,-300,'the support behind the tree does not run into it');
        } finally {Geo.getCellData=openCells;}
        console.log('Party combat loot: tank protection, attack/skill clearance, priorities, native movement/distribution, reassignment and interruption passed');
    } finally {sessions.forEach(s=>s.actor.automation.abortAll(s.actor,{notifyClient:false}));}
})().catch(error=>{console.error(error);process.exitCode=1;});
