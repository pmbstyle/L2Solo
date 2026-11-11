'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs');
require('./helpers/databaseIsolation');
const isolated = require('./helpers/isolatedSocialDatabase')('clan-raid-assessment');
require('../src/Global'); isolated.assertConfigured(options.default);
const Data = invoke('GameServer/DataCache'); Data.init({ validate: false });
const Combat = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Supply = require('../src/GameServer/Bot/Population/RaidSupplyPolicy');
const Forecast = require('../src/GameServer/Bot/Population/RaidCombatAssessment');
const Estimate = require('../src/GameServer/Clan/ClanRaidEstimate');
const Raid = require('../src/GameServer/Clan/ClanRaidPolicy');
const Random = require('../src/GameServer/Bot/Population/OpportunisticRaidPolicy');
const ClanSupply = require('../src/GameServer/Clan/ClanRaidSupply');
const Market = require('../src/GameServer/Bot/Economy/ColdMarketService');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const book = Afk.boardIndex();
const Fixed = require('../src/GameServer/Bot/Economy/FixedShotOffers');
Supply.useMarket(() => ({ board: book, npcOffersFor: id => Fixed.offers(id), tripFrom: () => () => 0 }));
const frozen = require('./fixtures/raid_priority_world.json'), timestamp = Date.now();
const members = frozen.expected.map(id => {
    const row = frozen.members.find(s => s.characterId === id);
    return { ...row, level:id===2006587?50:row.level, characterId: id, classId: row.stats.classId, clanId: 77, partyId: null, party: {},
        phase: 'cold', activity: 'shopping', currentRegion: 'Giran', adena: 100000000,
        loc: { locX:83396,locY:147904,locZ:-3404 },
        stats: { ...row.stats, clanId:77, money:[100000000,0,0,0], coldCombat: { ...row.captured,
            skills: Combat.skillSnapshotsFromRecords(row.skills.map(([selfId,level])=>({selfId,level}))) } },
        inventory: Life.inventorySummaryFromItems(row.items) };
});
const spot = invoke('GameServer/RaidBoss/RaidBossSourceCatalog').findById(`raid:${frozen.bossId}`);

async function main() {
    const before = JSON.stringify(members);
    const random = Random.assessment(members,spot,{timestamp,fundSupplies:true});
    const native = Estimate.estimate(members,spot,new Map(),{timestamp});
    assert(random.ready, JSON.stringify(random.reasons));
    assert(native.assessment.ready, JSON.stringify(native.assessment.reasons));
    for (const key of ['seconds','grossDps','regen','healing','healingRequired'])
        assert.equal(native.assessment[key],random[key],`the same native ${key} serves both raid owners`);
    assert.deepEqual(native.assessment.shotPlans,random.shotPlans);
    assert.equal(JSON.stringify(members),before,'forecast never buffs/refills the actual roster');
    const fit = Raid.assessment({members},spot,null,{timestamp,desiredMembers:9});
    assert(fit.ready,JSON.stringify(fit.raidAssessment || fit));
    assert.equal(fit.damageRoles,6,'equipped dwarves are real DDs in both selection paths');
    const dd=members.find(s=>Raid.raidRole(s)==='damage');
    const weak=structuredClone(dd);
    for(const [id,item] of Object.entries(weak.inventory)) if(item.equipped && [7,14].includes(item.slot)) delete weak.inventory[id];
    const Gear=invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
    const cheapWeapon=Data.items.find(item=>item.etc?.rank==='none' && String(item.template?.kind).startsWith('Weapon.')
        && Gear.suitable(item,weak,Gear.roleFor(weak),'none'));
    assert(cheapWeapon);
    weak.inventory[cheapWeapon.selfId]={selfId:cheapWeapon.selfId,amount:1,equipped:true,slot:cheapWeapon.etc.slot};
    assert(Raid.combatCapable(weak,spot),'low weapon grade is assessed through damage, not rejected by grade');
    const slow=Raid.assessment({members},spot,null,{timestamp,desiredMembers:9,maxFightSeconds:1});
    assert.equal(slow.reason,'raid_fight_too_long');
    const npc=Data.npcs.find(row=>row.selfId===spot.raidBossTemplateId);
    Data.npcs.push({...npc,selfId:9900138,vitals:{...npc.vitals,revHp:1e9}});
    {
        const noDamage=Raid.assessment({members},{...spot,id:'raid:9900138',raidBossTemplateId:9900138},null,{timestamp,desiredMembers:9});
        assert.equal(noDamage.reason,'raid_damage_below_regeneration');
        assert(!noDamage.raidEstimate,'an unwinnable fight never becomes an economic source');
    }
    const prepare=Forecast.prepared;let preparations=0;
    Forecast.prepared=(...args)=>{preparations++;return prepare(...args);};
    try {
        const cache=new Map();
        Estimate.estimate(members,spot,cache,{timestamp});
        Estimate.estimate(members,{...spot,id:'same-native-boss'},cache,{timestamp});
        assert.equal(preparations,1,'a planning job prepares its roster once across targets');
    } finally {Forecast.prepared=prepare;}
    const empty=structuredClone(members);
    for(const s of empty) for(const id of invoke('GameServer/Inventory/ShotStock').SHOT_IDS) delete s.inventory[id];
    const shotId=invoke('GameServer/Inventory/ShotStock').planForState(dd).selfId;
    book.put({id:97301,ownerId:98301,storeType:1,kind:'shop',town:'Giran',
        lines:[{lineId:973010,selfId:shotId,count:100,price:1}]});
    const funded=Raid.assessment({members:empty},spot,null,{timestamp,desiredMembers:9});
    assert(funded.ready,JSON.stringify(funded.raidAssessment || funded));
    assert(funded.raidAssessment.supplies.some(s=>s.reserveCost>s.cost),'cheap public stock retains a full static backup budget');
    const unfunded=structuredClone(empty);
    for(const s of unfunded){s.adena=1;s.stats.money=[1,0,0,0];}
    assert.equal(Raid.assessment({members:unfunded},spot,null,{timestamp,desiredMembers:9}).reason,'raid_consumables_funds');
    assert.equal(Raid.assessment({members:empty},spot,null,{timestamp,desiredMembers:9,fundSupplies:false}).reason,'raid_shot_reserve',
        'physical admission cannot replace inventory with purchasing ability');
    book.remove(97301);
    const { ClanPlanningCoordinator }=require('../src/GameServer/Clan/ClanPlanningCoordinator');
    const worker=new ClanPlanningCoordinator();
    try {
        await worker.withJob(Date.now()+30000,Data,async jobKey=>{
            const input={jobKey,deadlineAt:Date.now()+30000,
                clan:{id:77,level:3,physicalMemberCount:40,state:{mode:'autonomous'},members:empty},
                spots:[spot],prospects:[],previousGoal:null};
            const result=await worker.prepareRaids(input,Data,[spot]);
            assert(result.teams[spot.id]?.actualReady,'real clan worker reads repeatable shot supply');
            assert(result.teams[spot.id].supplies.some(s=>s.missing>0 && s.reserveCost>0));
            const physical=await worker.prepareRaids({...input,fundRaidSupplies:false},Data,[spot]);
            assert(!physical.teams[spot.id],'opening rechecks stock rather than reusing a fundable planning verdict');
        });
    } finally {await worker.shutdown();}
    await physicalSupply();
    console.log('PASS shared raid math, DD grade, duration/regen, native funding, cached preparation and physical clan supply');
}

async function physicalSupply() {
    const DB=invoke('Database'),Native=require('./helpers/nativeMarketFixture');
    await DB.init();
    await Native.character(DB,97901,'ClanRaidSupply','bot_clan_supply');
    await DB.execute(['INSERT INTO clans(id,name,leaderId) VALUES(77,\'SupplyClan\',97901)',[]]);
    await DB.updateCharacterClan(97901,77,0,0,0);
    await DB.setItem(97901,{selfId:57,name:'Adena',amount:1000000});
    const objective={clanId:77,clanGoalKey:'clan-supply',sourceKind:'raid',spotId:spot.id,status:'open',priority:'required',
        fullRoster:{generation:'clan-supply-one',memberIds:[97901]}};
    const target={id:97901,selfId:1464,target:100},price=Fixed.offers(1464).find(s=>s.town==='Giran').price;
    let state=await Life.upsertState({...members[3],characterId:97901,name:'ClanRaidSupply',accountName:'bot_clan_supply',
        activity:'party_wait',spotId:spot.id,adena:1000000,inventory:Life.inventorySummaryFromItems(await DB.fetchItems(97901)),
        stats:{...members[3].stats,money:[1000000,0,0,0],clanPartyObjective:objective}},'clan_supply_fixture');
    book.put({id:97302,ownerId:98302,storeType:1,kind:'shop',town:'Giran',
        lines:[{lineId:973020,selfId:1464,count:100,price:1}]});
    const nativeMarket={...Market,planPurchase:(s,id,n,o)=>Market.planPurchase(s,id,n,{...o,cost:()=>0})};
    const order=ClanSupply.reserve(state,objective,target,nativeMarket,new Map());
    assert(order.ok);
    assert.equal(order.marker.supply.cashNeeded,100*price);
    state=await Life.upsertState({...state,stats:{...state.stats,raidSupplyPreparation:order.marker}},'clan_supply_reserved');
    assert(Supply.held(state));
    const Formation=require('../src/GameServer/Bot/Population/RequiredPartyFormation');
    assert(!Formation.eligible(state),'a pending supply order cannot join an unfinished roster');
    assert.equal(Supply.held({...state,stats:{...state.stats,clanPartyObjective:null}}),null,'goal rotation revokes purchasing authority');
    const departed=await ClanSupply.advance(state,Life,nativeMarket);
    const errand=require('../src/GameServer/Bot/Population/CombinedErrandPolicy').pending(departed)[0];
    assert(errand && errand.raidPreparationId===order.marker.id);
    assert.equal(errand.money,100*price);
    book.remove(97302); // Any buyer can exhaust the public stack during travel.
    const arrived=await Life.upsertState({...departed,activity:'shopping',currentRegion:'Giran',
        stats:{...departed.stats,travel:null}},'clan_supply_arrived');
    const bought=await Market.tryPurchase(arrived);
    assert(bought.purchased,JSON.stringify(bought));
    assert.equal(Native.amount(await DB.fetchItems(97901),1464),100);
    assert.equal(Native.amount(await DB.fetchItems(97901),57),1000000-100*price);
    const complete=await ClanSupply.advance({...bought.state,activity:'party_wait',
        stats:{...bought.state.stats,travel:null,marketReturn:null}},Life,nativeMarket);
    assert.equal(complete.stats.raidSupplyPreparation,null,'a physically supplied member returns to clan assembly');
    assert(Formation.eligible(complete),JSON.stringify({message:'formation after procurement',phase:complete.phase,
        activity:complete.activity,party:complete.party,partyId:complete.partyId,
        objective:complete.stats.clanPartyObjective,request:complete.stats.partyRequest,equipment:complete.stats.equipmentPlan}));
    assert.equal(Supply.purchaseBudget(complete,{itemId:1464,raidPreparationId:order.marker.id}),0,'completed order cannot debit twice');
    await DB.close();
}

main().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
    await invoke('Database').close();fs.rmSync(isolated.directory,{recursive:true,force:true});
});
