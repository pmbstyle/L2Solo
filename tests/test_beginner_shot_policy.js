'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const Shots = invoke('GameServer/Inventory/ShotStock'), Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Table = invoke('GameServer/Bot/AI/SpotValueTable'), Hunt = invoke('GameServer/Bot/AI/BotHuntEfficiency');
const Cold = invoke('GameServer/Bot/Population/BackgroundResolver'), Profiles = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Life = invoke('GameServer/Bot/Population/BotLifeState'), Belief = invoke('GameServer/Bot/Economy/PriceBelief');
const Database = invoke('Database'), Backpack = invoke('GameServer/Actor/Backpack');
const originals = { income: Hunt.huntIncome, value: Table.value, best: Table.best, prior: Belief.prior,
    npc: Profiles.npcForSpot, fetch: Database.fetchItems, set: Database.setItem, update: Database.updateItemAmount };
(async () => {
try {
    for (const [classId, id, amount] of [[0,5789,600],[18,5789,600],[31,5789,600],[44,5789,600],
        [53,5789,600],[10,5790,300],[25,5790,300],[38,5790,300],[49,5790,300]]) {
        const inserted = [];
        Database.fetchItems = async () => [];
        Database.setItem = async (owner, item) => { inserted.push(item); return { insertId: 10 }; };
        const result = await Shots.ensureStarterStock(123, classId);
        assert.equal(result.plan.selfId, id); assert.equal(result.amount, amount);
        assert.deepEqual(inserted.map(x => [x.selfId,x.amount]), [[id,amount]]);
    }
    const state = { characterId: 77, name: 'Beginner', phase: 'cold', activity: 'hunting', level: 7,
        spotId: 'beginner-policy', adena: 100000, inventory: {
            2369: { selfId: 2369, amount: 1, equipped: true, slot: 7 },
            5789: { selfId: 5789, amount: 600 }, 1835: { selfId: 1835, amount: 100 },
            736: { selfId: 736, amount: 1 } }, stats: { classId: 31, role: 'dps' },
        loc: { locX: 0, locY: 0, locZ: 0 }, timing: {} };
    Table.value = (id, role, level, shots) => ({ exp: shots ? 1000 : 999, shots: 100, potions: 0, deaths: 0 });
    Table.best = (role, level, shots) => Table.value('beginner-policy',role,level,shots);
    Hunt.huntIncome = () => ({ perHour: 1000, expPerHour: 1000, source: 'own', spotId: 'beginner-policy' });
    Belief.prior = () => ({ mu: Math.log(100), K: 1 });
    const policy = Shots.usePolicy(state);
    assert.equal(policy.usePerHour,100); assert.equal(policy.paidUsePerHour,0);
    assert.equal(policy.purchaseUsePerHour,0,'free stock does not justify buying paid replacements');
    const stock = Economy.basics(state,{spots:[],timestamp:1800000000000}).stock('shots');
    assert.equal(stock.itemId,1835,'purchases still target ordinary shots');
    assert.equal(stock.current,700); assert.equal(stock.beginnerCurrent,600);
    assert.equal(stock.missing,0); assert.equal(Shots.keptAmounts(state,{stock:()=>stock})[1835],0);
    assert.equal(Shots.combatPlanForState(state).selfId,5789);
    const empty = structuredClone(state); empty.inventory[5789].amount=0;
    assert.equal(Shots.combatPlanForState(empty).selfId,1835);
    assert.equal(Shots.usePolicy(empty).usePerHour,0);
    const upgraded = structuredClone(state); delete upgraded.inventory[2369];
    upgraded.inventory[129]={selfId:129,amount:1,equipped:true,slot:7};
    assert.equal(Shots.combatPlanForState(upgraded).selfId,1463);
    assert.equal(Shots.beginnerAmount(upgraded),0,'NG beginner remainder cannot fund a D outing');
    let remaining=600;
    const actor = { fetchClassId:()=>31, fetchLevel:()=>7, session:{botSession:true,coldLifeState:state},
        backpack:{ fetchEquippedWeapon:()=>({fetchRank:()=> 'none',fetchSoulshot:()=>1}),
            fetchItemFromSelfId:id=>id===5789?{fetchAmount:()=>remaining}:null }, autoSoulshots:new Set() };
    Shots.enableAutoShot(actor,{stock});
    assert.deepEqual([...actor.autoSoulshots],[5789]);
    assert.equal(Backpack.prototype.fetchAutoShot.call(actor.backpack,actor,'soulshot'),5789);
    // Native solo and party fights consume the beginner stack, lifecycle carries
    // the exact inventory delta and never debits the ordinary stack instead.
    Profiles.npcForSpot=()=>({selfId:456,level:5,maxHp:100000,pAtk:1,pAtkRnd:0,pDef:20,mDef:10,accur:1,evasion:0,critical:0,atkSpd:500});
    const spot={id:'beginner-policy',minLevel:5,maxLevel:5,avgLevel:5,density:1,rewards:{exp:100,sp:1,adenaMin:1,adenaMax:1}};
    const make=()=>{const s=structuredClone(state),p=Profiles.profileFor(s,1800000000000);
        s.vitals={hp:p.maxHp,maxHp:p.maxHp,mp:p.maxMp,maxMp:p.maxMp};return s;};
    for (const party of [false,true]) {
        const s=make(); const outcome=party ? Cold.resolvePartyFight({members:[s],spot,timestamp:1800000000000,rng:()=>.5})
            : Cold.resolveSolo({state:s,spot,timestamp:1800000000000,elapsedMs:12000,rng:()=>.5});
        const actions=party?outcome.members[0].shotActions:outcome.debug.shotActions;
        const inventory=party?outcome.members[0].state.inventory:outcome.patch.inventory;
        assert(actions>0); assert.equal(inventory[5789].amount,600-actions);
        assert.equal(inventory[1835].amount,100);
        if (!party) {
            const projected=await Life.prepareResolve(s,outcome,{persist:false,timestamp:1800000000000,projectClassProgression:true});
            assert.equal(projected.inventory[5789].amount,600-actions);
            assert.equal(projected.inventory[1835].amount,100);
        }
    }
    Table.value = (id, role, level, shots) => ({ exp: shots ? 1000 : 1, shots: 100, potions: 0, deaths: 0 });
    for (const party of [false,true]) {
        const s=make(); s.inventory[5789].amount=2;
        const outcome=party ? Cold.resolvePartyFight({members:[s],spot,timestamp:1800000000000,rng:()=>.5})
            : Cold.resolveSolo({state:s,spot,timestamp:1800000000000,elapsedMs:12000,rng:()=>.5});
        const actions=party?outcome.members[0].shotActions:outcome.debug.shotActions;
        const inventory=party?outcome.members[0].state.inventory:outcome.patch.inventory;
        assert(actions>2, 'fight crosses beginner exhaustion');
        assert.equal(inventory[5789].amount,0);
        assert.equal(inventory[1835].amount,102-actions);
        if (!party) {
            const projected=await Life.prepareResolve(s,outcome,{persist:false,timestamp:1800000000000,projectClassProgression:true});
            assert.equal(projected.inventory[5789].amount,0);
            assert.equal(projected.inventory[1835].amount,102-actions);
        }
    }
    assert.equal(Database.isReady(),false);
    console.log('PASS C4 grants, free use/paid refill, grade, hot/cold solo-party beginner consumption');
} finally { Hunt.huntIncome=originals.income;Table.value=originals.value;Table.best=originals.best;Belief.prior=originals.prior;
    Profiles.npcForSpot=originals.npc;Database.fetchItems=originals.fetch;Database.setItem=originals.set;Database.updateItemAmount=originals.update; }
})().catch(error=>{console.error(error);process.exitCode=1;});
