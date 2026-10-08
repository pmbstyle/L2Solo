'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-improvements-'));
delete process.env.L2NODE_CONFIG_SHARED_FILE;
process.env.L2NODE_CONFIG_FILE = path.join(directory, 'default.ini');
fs.writeFileSync(process.env.L2NODE_CONFIG_FILE, `[Database]\npath=${directory}/world.sqlite\nhistoryPath=${directory}/history.sqlite\n`);
require('../src/Global');
const DB = invoke('Database'), Data = invoke('GameServer/DataCache');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Policy = invoke('GameServer/Bot/Economy/BotImprovementPolicy');
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Rules = invoke('GameServer/Items/C4EnchantRules');
const SA = invoke('GameServer/Items/C4WeaponSAExchange');
const Henna = invoke('GameServer/Henna/HennaRules');
const Crystals = invoke('GameServer/Bot/Population/ColdSoulCrystal');
const NativeCrystals = invoke('GameServer/Items/SoulCrystalProgression');
const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const location = {locX:83396,locY:147904,locZ:-3400};
let serial = 0;
const cash = {selfId:57,name:'Adena',amount:10000000};
async function seed(items, {classId=0,level=52,activity='hunting',stats={}} = {}) {
    const account = `bot_improvement_${++serial}`;
    await DB.createAccount(account,'fixture');
    const id = Number((await DB.createCharacter(account,{name:`Improver${serial}`,race:0,classId,sex:0,
        face:0,hair:0,hairColor:0,maxHp:3000,maxMp:3000,...location})).insertId);
    await DB.updateCharacterExperience(id,level,Number(Data.experience[level-1] || 0),100000);
    for (const row of [cash,...items]) await DB.setItem(id,{equipped:false,slot:0,enchant:0,...row});
    return Life.upsertState({characterId:id,accountName:account,name:`Improver${serial}`,level,exp:Number(Data.experience[level-1]||0),
        sp:100000,phase:'cold',activity,currentRegion:'Giran',loc:location,adena:cash.amount,
        inventory:Life.inventorySummaryFromItems(await DB.fetchItems(id)),vitals:{hp:3000,maxHp:3000,mp:3000,maxMp:3000},
        stats:{classId,generatedCold:true,coldCombat:Profile.legacySnapshot({stats:{classId},level},[],Date.now()),...stats},timing:{}},'improvement_fixture');
}
const snapshot = async id => ({items:await DB.fetchItems(id),character:await DB.fetchCharacters(`bot_improvement_${serial}`),
    life:await DB.execute(['SELECT * FROM bot_life_state WHERE characterId=?',[id]]),skills:await DB.fetchSkills(id)});
async function apply(state, proposal, rng=()=>0) {
    const result = await DB.applyBotImprovement(state.characterId,proposal,{coldState:state,rng});
    return {result,state:Life.acceptLifecycleRow(result.coldLifeRow,'improvement_fixture')};
}
async function main() {
    try {
        Data.init(); DB.init(); assert(DB.isReady()); await Life.init();
        const weapon = Data.items.find(row => row.template.kind.startsWith('Weapon.') && String(row.etc.rank).toUpperCase()==='C'
            && Number(row.etc.cristals)>0 && row.template.price>0);
        assert(weapon);
        const normal = Rules.resolveScroll(951), blessed = Rules.resolveScroll(6573);
        const cost = Policy.enchantCost({selfId:weapon.selfId,amount:1,slot:weapon.etc.slot},4,6,normal,Rules.DEFAULTS);
        assert.equal(cost.count,1+.68); assert.equal(cost.reach,.68*.68);
        const renewal = Policy.enchantCost({selfId:weapon.selfId,amount:1,slot:weapon.etc.slot},4,6,blessed,Rules.DEFAULTS);
        assert(renewal.count>2); assert.equal(renewal.reach,1);
        for (const grade of ['D','C','B','A','S']) {
            const own = Data.items.find(row=>row.template.kind.startsWith('Weapon.') && String(row.etc.rank).toUpperCase()===grade);
            const scroll = Object.values(invoke('GameServer/Items/C4EnchantScrolls').ENCHANT_SCROLLS)
                .find(row=>row.grade===grade && row.target==='weapon' && row.scrollType==='crystal');
            const chain = Policy.enchantCost({selfId:own.selfId,amount:1,slot:own.etc.slot},4,6,scroll,Rules.DEFAULTS);
            assert.equal(chain.reach,.68*.68,'crystal scrolls retain the same authored normal break rule in every grade');
        }
        console.log('PASS complete enchant chain and blessed renewal');

        let state = await seed([{selfId:weapon.selfId,name:weapon.template.name,amount:1,equipped:true,slot:weapon.etc.slot},
            {selfId:951,name:'Scroll',amount:4},{selfId:6573,name:'Blessed',amount:1}]);
        const item = (await DB.fetchItems(state.characterId)).find(row=>row.selfId===weapon.selfId);
        const before = Profile.profileFor(state);
        let action = await apply(state,{kind:'enchant',objectId:item.id,itemId:item.selfId,from:0,scrollId:951}); state=action.state;
        assert.equal((await DB.fetchItems(state.characterId)).find(row=>row.id===item.id).enchant,1);
        assert(Profile.profileFor(state).pAtk>before.pAtk || Profile.profileFor(state).mAtk>before.mAtk);
        await assert.rejects(DB.applyBotImprovement(state.characterId,{kind:'enchant',objectId:item.id,itemId:item.selfId,from:1,scrollId:6573},
            {coldState:state}),/invalid_bot_enchant/);
        await DB.execute(['UPDATE items SET enchant=4 WHERE id=?',[item.id]]);
        state=await Life.upsertState({...state,inventory:Life.inventorySummaryFromItems(await DB.fetchItems(state.characterId))},'fixture_risky');
        action=await apply(state,{kind:'enchant',objectId:item.id,itemId:item.selfId,from:4,scrollId:6573,lossHours:2},()=>.99);state=action.state;
        assert.equal(action.result.result,'blessed-fail');assert.equal((await DB.fetchItems(state.characterId)).find(row=>row.id===item.id).enchant,0);
        await DB.execute(['UPDATE items SET enchant=4 WHERE id=?',[item.id]]);
        state=await Life.upsertState({...state,inventory:Life.inventorySummaryFromItems(await DB.fetchItems(state.characterId))},'fixture_risky');
        const image=await snapshot(state.characterId);let writes=0;
        await assert.rejects(DB.applyBotImprovement(state.characterId,{kind:'enchant',objectId:item.id,itemId:item.selfId,from:4,scrollId:951},
            {coldState:state,beforeWrite(){if(++writes===3)throw Error('retired_improvement');}}),/retired_improvement/);
        assert.deepEqual(await snapshot(state.characterId),image);
        action=await apply(state,{kind:'enchant',objectId:item.id,itemId:item.selfId,from:4,scrollId:951,lossHours:3},()=>.99);state=action.state;
        assert.equal(action.result.result,'break');assert(!(await DB.fetchItems(state.characterId)).some(row=>row.id===item.id));
        assert(state.inventory[1459].amount>0);assert(state.stats.frustration>=5);
        const coldImage=await snapshot(state.characterId);
        await assert.rejects(DB.applyBotImprovement(state.characterId,{kind:'crystal_quest',starterId:4629}),/improvement_hot_source_changed/);
        assert.deepEqual(await snapshot(state.characterId),coldImage,'hot writer cannot bypass a current cold owner');
        console.log('PASS native enchant supply, real combat bonus, blessed reset, break and guarded rollback');

        state=await seed([{selfId:weapon.selfId,name:weapon.template.name,amount:1,enchant:0},
            {selfId:weapon.selfId,name:weapon.template.name,amount:1,enchant:4}]);
        const Disposition=invoke('GameServer/Bot/Economy/ItemDisposition');
        const candidates=Disposition.saleCandidates(state,{unlimited:true,reserved:{[weapon.selfId]:0}}).filter(row=>row.selfId===weapon.selfId);
        assert.deepEqual(candidates.map(row=>[row.enchant,row.count]).sort((a,b)=>a[0]-b[0]),[[0,1],[4,1]]);
        assert(candidates.every(row=>row.objectIds.length===1 && row.objectId===row.objectIds[0]));
        const Market=invoke('GameServer/Bot/Economy/MarketPricing');
        const context=Market.traderContext(state,{knowledgeEnabled:false});
        assert(Market.beliefFor(weapon.selfId,context,4).mu > Market.beliefFor(weapon.selfId,context,0).mu);
        const index=invoke('GameServer/Bot/Economy/BotImprovementService').Policy;
        const values=index.enchantedPrice({selfId:weapon.selfId,amount:1},4,context.economy);
        assert(values>context.economy.price(weapon.selfId));
        console.log('PASS mixed native instance/enchant sale projection and full-chain enchanted price');

        const recipe=SA.options(7300,undefined,'install').find(row=>row.station==='blacksmith');
        // Read the actual C/B catalogue; the catalogue API is keyed by source weapon.
        const selected=recipe || Data.items.flatMap(row=>SA.options(7300,row.selfId,'install')).find(row=>row.station==='blacksmith');
        assert(selected); const costs=SA.costs(selected);assert(costs.some(row=>[2131,2132].includes(row.selfId)));
        state=await seed([{selfId:selected.sourceId,name:'SA weapon',amount:1,equipped:true,slot:10,enchant:2},...costs.map(row=>({...row,name:'SA material'}))]);
        const source=(await DB.fetchItems(state.characterId)).find(row=>row.selfId===selected.sourceId);
        action=await apply(state,{kind:'sa',npcId:7300,recipeId:selected.id,objectId:source.id,itemId:source.selfId,from:2});
        assert.equal(action.state.inventory[selected.productId].instances[0].id,source.id);
        assert.equal(action.state.inventory[selected.productId].instances[0].enchant,2);
        assert(Profile.profileFor(action.state).effects.some(effect=>effect.category==='equipment_item_skill'));
        for(const row of costs)assert(!action.state.inventory[row.selfId]);
        console.log('PASS C/B SA exact crystal/gem payment, original instance/enchant and native effect');

        const symbol=Henna.availableForClass(3).find(row=>row.STR>0);assert(symbol);
        state=await seed([{selfId:symbol.dyeSelfId,name:'Dye',amount:symbol.dyeAmount}],{classId:3});
        const plain=Profile.profileFor(state);
        action=await apply(state,{kind:'henna',symbolId:symbol.id});
        assert.equal(action.state.stats.hennas[0],symbol.id);assert(!action.state.inventory[symbol.dyeSelfId]);
        assert.equal(action.state.adena,state.adena-symbol.price);assert(Profile.profileFor(action.state).base.str>plain.base.str);
        console.log('PASS paid native class henna and actual cold stat effect');

        state=await seed([],{level:52});
        action=await apply(state,{kind:'crystal_quest',starterId:4629});state=action.state;
        assert.equal(state.stats.soulCrystalQuest,true);assert.equal(state.inventory[4629].amount,1);
        const ruleId=Number(Object.keys(NativeCrystals.catalog.npcs).find(id=>NativeCrystals.catalog.npcs[id].maxStage<=10 && NativeCrystals.catalog.npcs[id].maxStage>=2));
        const mob={selfId:ruleId,maxHp:100,pAtk:1,pDef:1,mDef:1,level:40,atkSpd:253,accur:1,evasion:0};
        const fighter={state:{...state,inventory:{...state.inventory}},vitals:{hp:100,mp:100},profile:{castSpd:333},cooldowns:{},readyAt:0,skillUses:0};
        assert.equal(Crystals.tryCast(fighter,mob,51,1000),false);
        assert.equal(Crystals.tryCast(fighter,mob,50,1000),true);assert.equal(fighter.vitals.mp,74);assert.equal(fighter.readyAt,1200);
        assert.equal(Crystals.outcome(fighter,mob,0,{at:2199}),null);
        const step=Crystals.outcome(fighter,mob,0,{at:2200});assert.equal(step.toId,4630);
        const token=await Owner.claim(state,{allowLifecycle:true});assert.equal(token.ok,true);
        const leased=Life.cachedState(state.characterId);
        const committed=await Owner.commitAndReleaseBatch([{token,nextState:{...leased,inventory:fighter.state.inventory},
            proposal:{baseState:leased,durable:{soulCrystals:[step]}},options:{allowLifecycle:true}}]);
        assert.equal(committed[0].ok,true);state=Life.cachedState(state.characterId);
        assert.equal((await DB.fetchItems(state.characterId)).find(row=>row.id===step.objectId).selfId,4630);
        assert.equal(state.simulation.ownerId,'legacy_main');
        console.log('PASS actual quest, MP/time/HP Drain Soul and fenced accepted Worker physical commit');

        const Resolver=invoke('GameServer/Bot/Population/BackgroundPartyResolver');
        const Encounter=invoke('GameServer/Bot/Population/ColdPveEncounter');
        const other=await apply(await seed([]),{kind:'crystal_quest',starterId:4629});
        const members=[{...state,party:{partyId:'fixture_sc'},stats:{...state.stats,coldCombat:{...state.stats.coldCombat,skills:[]}}},
            {...other.state,party:{partyId:'fixture_sc'}}];
        const spot={id:'fixture_sc',density:1,avgLevel:40,npcEntries:[{selfId:ruleId,count:1}],mob:{hp:100,damage:1}};
        const at=Date.now(), key=Encounter.key(members,spot,ruleId,'fixture_sc');
        const pending=Encounter.save(null,key,mob,50,at,{mobReadyAt:5000,readyAt:{},soulCrystalMarks:{}});
        const partyResult=Resolver.resolve({party:{partyId:'fixture_sc',cohesion:1,stats:{pveEncounter:pending}},members,spot,targetNpcId:ruleId,
            elapsedMs:12000,timestamp:at,rng:()=>0});
        assert(partyResult.memberResults.some(row=>row.result.soulCrystals?.length>0),'actual party resolver forwards own crystal outcomes');
        console.log('PASS actual party Drain Soul outcome aggregation');

        state=await seed([{selfId:1049,name:'Spellbook: Ice Bolt',amount:1}],{classId:10,level:14});
        const paidToken=await Owner.claim(state,{allowLifecycle:true});assert(paidToken.ok);
        const current=Life.cachedState(state.characterId);
        const accepted=await Owner.commitAndReleaseBatch([{token:paidToken,nextState:{...current,sp:100000},proposal:{baseState:current,durable:{classId:10}},options:{allowLifecycle:true}}]);
        assert(accepted[0].ok);state=Life.cachedState(state.characterId);
        assert.equal((await DB.fetchSkills(state.characterId)).length,0,'accepted proposal cannot synthesize tree ranks');
        const paid=await Life.reviewTrainingAfterCommit(state);
        assert((await DB.fetchSkill(state.characterId,1184))[0]?.level>0);assert(paid.sp<100000);assert(!paid.inventory[1049]);
        assert.equal(paid.stats.coldCombat.skillSource,'database');
        assert.deepEqual(paid.stats.coldCombat.skills.map(row=>[row.selfId,row.level]),
            Profile.skillSnapshotsFromRecords(await DB.fetchSkills(state.characterId)).map(row=>[row.selfId,row.level]));
        console.log('PASS accepted Worker SP/book -> real paid native training -> current authoritative kit');
    } finally { await DB.close();fs.rmSync(directory,{recursive:true,force:true}); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
