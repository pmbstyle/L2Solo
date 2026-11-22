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
const InventorySummary = invoke('GameServer/Bot/Population/InventorySummary');
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

        // The loss of a worn weapon is priced from the build without it (the
        // chest keeps the bag off the snapshot gear fallback) and with the best
        // spare worn in its place.
        const chest = Data.items.find(row => row.template.kind.startsWith('Armor.') && Number(row.etc.slot) === 10);
        const spareTemplate = Data.items.find(row => row.template.kind === weapon.template.kind
            && Number(row.etc.slot) === Number(weapon.etc.slot) && String(row.etc.rank).toUpperCase() === 'D'
            && row.template.price > 0 && row.template.price < weapon.template.price);
        assert(chest && spareTemplate);
        const worn = [{selfId:weapon.selfId,name:weapon.template.name,amount:1,equipped:true,slot:weapon.etc.slot},
            {selfId:chest.selfId,name:chest.template.name,amount:1,equipped:true,slot:10}];
        const stuckCtx = {hunt:{perHour:1000},price:()=>1000,timestamp:Date.now()};
        state = await seed(worn);
        const held = Policy.instances(state).find(row => row.selfId === weapon.selfId);
        const alone = Policy.stuckCost(state, held, stuckCtx);
        assert(alone > 0, 'losing the only worn weapon has a cost');
        const spared = await seed([...worn, {selfId:spareTemplate.selfId,name:spareTemplate.template.name,amount:1}]);
        const heldSpared = Policy.instances(spared).find(row => row.selfId === weapon.selfId);
        const withSpare = Policy.stuckCost(spared, heldSpared, stuckCtx);
        assert(withSpare > 0 && withSpare < alone, 'a spare worn in its place keeps part of the income');
        console.log('PASS worn weapon loss priced bare and with the best spare worn');

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

        // A far bot's held henna, drawn on its town visit, ends its held step: the bot does not
        // walk back to the symbol maker on its next step with its slots full or the dye spent.
        const Situations = invoke('GameServer/Bot/Situations');
        state=await seed([{selfId:symbol.dyeSelfId,name:'Dye',amount:symbol.dyeAmount*2}],{classId:3,activity:'shopping',
            stats:{decisionSeq:7,activityLeaf:12345,wishDirty:0,woken:0,wishSections:{at:1}}});
        assert(!Situations.woken(state.stats,'build'));
        const hennaCard={riskWeight:1,activity:{activity:'improving',improvement:{kind:'henna',symbolId:symbol.id,riskHours:0}}};
        const drawn=await invoke('GameServer/Bot/Economy/BotImprovementService').reviewCold(state,{decide:()=>hennaCard});
        assert.equal(drawn.changed,true);assert.equal(drawn.state.stats.hennas[0],symbol.id);
        const row=Life.cachedState(state.characterId);
        assert(Situations.woken(row.stats,'build'),'the drawn henna wakes the build: it chooses the step after it');
        assert.equal(drawn.state.simulation.revision,row.simulation.revision,'the visit writes on after the raise');
        console.log('PASS a drawn cold henna ends its held step');

        // A near body whose improvement is done waits for the worker's answer: its next tick,
        // on the card that still names the step, enchants nothing.
        state=await seed([{selfId:weapon.selfId,name:weapon.template.name,amount:1},{selfId:951,name:'Scroll',amount:2}]);
        const nearWeapon=(await DB.fetchItems(state.characterId)).find(row=>row.selfId===weapon.selfId);
        const actor={fetchId:()=>state.characterId,isDead:()=>false,fetchIsOnline:()=>true};
        const body={actor,accountId:state.accountName,nearRaise:{seq:1,names:[{name:'goal_done:goal',payload:null,seq:1}]},
            heldEconomy:{state,statsPacket:{},network:{activity:{activity:'improving',
                improvement:{kind:'enchant',objectId:nearWeapon.id,itemId:weapon.selfId,from:0,scrollId:951}}}}};
        const World=invoke('GameServer/World/World'), registered=World.registeredActorById, record={session:body};
        World.registeredActorById=id=>Number(id)===state.characterId?record:registered.call(World,id);
        try {
            assert.equal(await invoke('GameServer/Bot/Economy/BotImprovementService').reviewHot(body),null);
        } finally { World.registeredActorById=registered; }
        assert.equal((await DB.fetchItems(state.characterId)).find(row=>row.id===nearWeapon.id).enchant,0);
        console.log('PASS a near body does not run its done improvement again before the answer');

        // A near body that cooled while its enchant was written: the committed step ends once
        // on its cold row (the build wakes), so the row does not take the same step again.
        state=await seed([{selfId:weapon.selfId,name:weapon.template.name,amount:1},{selfId:951,name:'Scroll',amount:2}],
            {stats:{decisionSeq:7,activityLeaf:12345,wishDirty:0,woken:0,wishSections:{at:1}}});
        state=await Life.upsertState({...state,phase:'hot'},'fixture_near');
        assert(!Situations.woken(state.stats,'build'));
        const goneWeapon=(await DB.fetchItems(state.characterId)).find(row=>row.selfId===weapon.selfId);
        const gone={actor:{fetchId:()=>state.characterId,isDead:()=>false,fetchIsOnline:()=>true},accountId:state.accountName,
            heldEconomy:{state,statsPacket:{},network:{activity:{activity:'improving',
                improvement:{kind:'enchant',objectId:goneWeapon.id,itemId:weapon.selfId,from:0,scrollId:951}}}}};
        const goneRecord={session:gone}, write=DB.applyBotImprovement;
        World.registeredActorById=id=>Number(id)===state.characterId?goneRecord:registered.call(World,id);
        DB.applyBotImprovement=(...args)=>write.apply(DB,args).then(async result=>{
            goneRecord.retired=true;
            await Life.upsertState({...Life.cachedState(state.characterId),phase:'cold'},'fixture_cooled',{releaseHot:true});
            return result;
        });
        try {
            assert.equal((await invoke('GameServer/Bot/Economy/BotImprovementService').reviewHot(gone)).result,'success');
        } finally { World.registeredActorById=registered; DB.applyBotImprovement=write; }
        assert.equal((await DB.fetchItems(state.characterId)).find(row=>row.id===goneWeapon.id).enchant,1);
        assert(Situations.woken(Life.cachedState(state.characterId).stats,'build'),'the cooled row wakes its build: the step is done');
        assert(!gone.nearRaise,'nothing raised in the gone body\'s bag');
        console.log('PASS a near body gone during its improvement still ends the step on its row');

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
        const stepped=Life.cachedState(state.characterId);
        const stale=await Owner.commitBatch([{revision:stepped.simulation.revision,nextState:stepped,
            proposal:{bagChanged:false,durable:{soulCrystals:[step]}},options:{allowLifecycle:true}}]);
        assert.equal(stale[0].ok,false);
        assert.equal(stale[0].detail,'cold_soul_crystal_projection_changed');
        assert.equal((await DB.fetchItems(state.characterId)).find(row=>row.id===step.objectId).selfId,4629,
            'a stale bag rolls back the native upgrade');
        const committed=await Owner.commitBatch([{revision:stepped.simulation.revision,nextState:{...stepped,inventory:fighter.state.inventory},
            proposal:{...InventorySummary.bagChange(stepped.inventory,fighter.state.inventory),durable:{soulCrystals:[step]}},options:{allowLifecycle:true}}]);
        assert.equal(committed[0].ok,true);state=Life.cachedState(state.characterId);
        assert.equal((await DB.fetchItems(state.characterId)).find(row=>row.id===step.objectId).selfId,4630);
        console.log('PASS actual quest, MP/time/HP Drain Soul and fenced accepted Worker physical commit');

        const Resolver=invoke('GameServer/Bot/Population/BackgroundPartyResolver');
        const Encounter=invoke('GameServer/Bot/Population/ColdPveEncounter');
        const other=await apply(await seed([]),{kind:'crystal_quest',starterId:4629});
        const members=[{...state,party:{partyId:'fixture_sc'},stats:{...state.stats,coldCombat:{...state.stats.coldCombat,skills:[]}}},
            {...other.state,party:{partyId:'fixture_sc'}}];
        const spot={id:'fixture_sc',density:1,avgLevel:40,npcEntries:[{selfId:ruleId,count:1}],mob:{hp:100,damage:1}};
        const at=Date.now(), key=Encounter.key(members,spot,'fixture_sc');
        const pending=Encounter.save(null,key,mob,50,at-12000,{mobReadyAt:5000,readyAt:{},soulCrystalMarks:{}});
        const partyResult=Resolver.resolve({party:{partyId:'fixture_sc',cohesion:1,stats:{pveEncounter:pending}},members,spot,targetNpcId:ruleId,
            elapsedMs:12000,timestamp:at,rng:()=>0});
        assert(partyResult.memberResults.some(row=>row.result.soulCrystals?.length>0),'actual party resolver forwards own crystal outcomes');
        console.log('PASS actual party Drain Soul outcome aggregation');

        const BotCrystal = invoke('GameServer/Bot/Economy/BotSoulCrystal');
        const Improvements = invoke('GameServer/Bot/Economy/BotImprovementService');
        const hammer = SA.recipes.find(row => row.id === '1005:9').sourceId;
        const funding = [10000, .001, 10000, 0, .01, cash.amount, 358];
        state = await seed([{ selfId: hammer, name: 'Big Hammer', amount: 1, equipped: true,
            slot: Data.items.find(row => row.selfId === hammer).etc.slot, enchant: 2 }],
        { activity: 'shopping', stats: { money: funding, activityLeaf: 12345 } });
        const townVisit = { town: 'Giran', startedAt: Date.now(), completed: false };
        state = await Life.upsertState({ ...state, stats: { ...state.stats, townVisit } }, 'fixture_sa_visit');
        assert.equal((await Improvements.reviewColdCrystalVisit(state)).stats.soulCrystalGoal, undefined,
            'the usual errands finish first');
        const kitFact = invoke('GameServer/Bot/Economy/DecisionSections').kit;
        const beforeQuestKit = kitFact(state);
        state = await Improvements.reviewColdCrystalVisit({ ...state, stats: { ...state.stats, townVisit: { ...townVisit, completed: true } } });
        const commitment = state.stats.soulCrystalGoal;
        assert(commitment, 'an ordinary Giran visit starts the quest for the weapon it wears');
        assert.equal(state.stats.townVisit.completed, true, 'adding the quest does not reopen the town visit');
        assert.equal(kitFact(state), beforeQuestKit, 'starting the quest does not invalidate the gear decision');
        state = await Life.upsertState(state, 'fixture_sa_visit_complete');
        assert.equal(state.stats.activityLeaf, 12345, 'the quest does not complete the gear decision');
        const install = SA.recipes.find(row => row.id === commitment[1]);
        const target = SA.costs(install).find(cost => NativeCrystals.catalog.crystals[cost.selfId]).selfId;
        const mobForGoal = { ...mob, selfId: Number(Object.keys(NativeCrystals.catalog.npcs)
            .find(id => NativeCrystals.catalog.npcs[id].maxStage === 10)) };
        const spotPreference = BotCrystal.spotPreference(state);
        const ranked = invoke('GameServer/Bot/AI/SpotSearch').rank;
        const camp = (id, value, npcEntries = []) => ({ spot: { id, npcEntries }, value });
        const farm = camp('farm', 100), crystal = camp('crystal', 98, [mobForGoal]);
        const weak = camp('slow_crystal', 95, [mobForGoal]);
        assert(spotPreference(crystal.spot));
        const pick = candidates => ranked(state, { candidates, sorted: true, value: row => row.value },
            { habit: true, preferred: spotPreference, allowed: row => row !== weak }).pick;
        assert.equal(pick([farm, crystal]), crystal);
        assert.equal(pick([farm, weak]), farm, 'the side activity respects the hunt safety verdict');
        assert.equal(BotCrystal.spotPreference({ ...state, stats: { ...state.stats,
            equipmentPlan: { status: 'active', next: { spotId: 'gear_source' } } } }), null);
        const replacingWeapon = { ...state, stats: { ...state.stats, equipmentPlan: {
            status: 'active', target: { slot: state.inventory[hammer].instances[0].slot }
        } } };
        const blockedFighter = { state: replacingWeapon, vitals: { hp: 3000, mp: 3000, maxMp: 3000 }, cooldowns: {} };
        assert.equal(Crystals.tryCast(blockedFighter, mobForGoal, 50, 1000), false, 'a weapon upgrade takes priority over its SA');
        assert.equal(blockedFighter.vitals.mp, 3000);

        async function drain(roll) {
            const hunting = { state: { ...state }, vitals: { hp: 3000, mp: 3000, maxMp: 3000 },
                cooldowns: {}, readyAt: 0, skillUses: 0 };
            assert(Crystals.tryCast(hunting, mobForGoal, 50, 1000));
            const progress = Crystals.outcome(hunting, mobForGoal, roll, { at: 2200 });
            assert(progress);
            const nextState = await Life.prepareResolve(state, {
                patch: { inventory: hunting.state.inventory },
                soulCrystals: [progress]
            }, { persist: false, projectClassProgression: true });
            assert.equal(nextState.inventory[progress.fromId], undefined, 'normal hunt projection removes the old stage');
            assert.equal(nextState.inventory[progress.toId].instances[0].id, progress.objectId);
            const adopted = await Owner.commitBatch([{ revision: state.simulation.revision,
                nextState,
                proposal: { ...InventorySummary.bagChange(state.inventory, nextState.inventory), durable: { soulCrystals: [progress] } },
                options: { allowLifecycle: true } }]);
            assert.equal(adopted[0].ok, true);
            state = Life.cachedState(state.characterId);
            const physical = (await DB.fetchItems(state.characterId)).filter(row =>
                row.selfId === progress.fromId || row.selfId === progress.toId);
            assert.deepEqual(physical.map(row => [row.id, row.selfId]), [[progress.objectId, progress.toId]]);
        }
        const crystalBag = Life.inventorySummaryFromItems([
            { id: 1, selfId: 4629, amount: 1 },
            { id: 2, selfId: 4662, amount: 1 }
        ]);
        Crystals.applyInventoryStep(crystalBag, { fromId: 4629, toId: 4662, objectId: 1 });
        assert.equal(crystalBag[4662].amount, 2);
        assert.deepEqual(crystalBag[4662].instances.map(row => row.id).sort(), [1, 2],
            'a break preserves both physical objects when the bag already has a broken crystal');
        await drain(.95);
        assert(!BotCrystal.spotPreference(state), 'a broken crystal has no route preference');
        state = await Improvements.reviewColdCrystalVisit(state);
        assert.deepEqual(state.stats.soulCrystalGoal, commitment, 'the next magister visit restarts the same recipe');
        for (let stage = 0; stage < NativeCrystals.catalog.crystals[target].stage; stage++) await drain(0);
        assert.equal(state.inventory[target].amount, 1);
        assert.equal(Crystals.tryCast({ state, vitals: { mp: 3000 }, cooldowns: {} }, mobForGoal, 50, 1000), false,
            'the exact crystal for the recipe is kept for the smith');
        assert.equal(await DB.replaceSoulCrystal(state.characterId, state.inventory[target].instances[0].id, target,
            NativeCrystals.catalog.crystals[target].nextId, 'Overleveled crystal', NativeCrystals.crystalIds, () => true), false,
        'the native award also respects the planned stage');
        assert.equal(BotCrystal.spotPreference(state), null, 'a finished crystal gives no spot preference');
        const reserved = await Improvements.reviewColdCrystalVisit(state);
        assert.equal(reserved.stats.lastImprovement.kind, 'crystal_quest');
        assert.equal(reserved.adena, cash.amount, 'the gemstone cannot borrow from the protected gear budget');
        state = await Life.upsertState({ ...reserved, stats: { ...reserved.stats, money: [10000, .001, 10000, 0] } }, 'fixture_free_sa_budget');
        state = await Improvements.reviewColdCrystalVisit(state);
        assert.equal(state.stats.lastImprovement.kind, 'sa');
        assert.equal(state.stats.soulCrystalGoal, null);
        assert.equal(state.stats.activityLeaf, 12345, 'installation leaves the held gear step in place');
        assert.equal(state.inventory[install.productId].instances[0].id, commitment[0]);
        assert.equal(state.inventory[install.productId].instances[0].enchant, 2);
        assert(state.adena < cash.amount, 'the missing gemstone is bought from a real town NPC');
        const gem = SA.costs(install).find(cost => cost.selfId !== target);
        const matchingFundedRow = [10000, .001, 10000, 0, .01, 300000, gem.selfId];
        assert.deepEqual(invoke('GameServer/Bot/Economy/PurchaseFunding').packetAfterPurchase(matchingFundedRow, 5000,
            { itemId: gem.selfId, side: .001 }), matchingFundedRow, 'a same-item side purchase leaves funded rows intact');
        console.log('PASS normal bot town visit, exact crystal stage, protected gear budget and SA installation');

        const damaged = await Improvements.reviewColdCrystalVisit(await seed([{
            selfId: hammer, name: 'Big Hammer', amount: 1, equipped: true,
            slot: Data.items.find(row => row.selfId === hammer).etc.slot
        }], { activity: 'shopping' }));
        const starter = Crystals.single(damaged), advancedId = NativeCrystals.catalog.crystals[starter.selfId].nextId;
        const advancedName = Data.items.find(row => row.selfId === advancedId).template.name;
        await DB.execute(['UPDATE items SET selfId=?, name=? WHERE id=?', [advancedId, advancedName, starter.id]]);
        await DB.setItem(damaged.characterId, { selfId: starter.selfId, name: starter.name, amount: 1 });
        assert.deepEqual(await DB.repairColdSoulCrystalBags(), { repaired: 1, removed: 1 });
        assert.deepEqual(await DB.repairColdSoulCrystalBags(), { repaired: 0, removed: 0 });
        const savedBag = (await DB.execute(['SELECT inventorySummary FROM bot_life_state WHERE characterId=?',
            [damaged.characterId]]))[0];
        assert.equal(InventorySummary.read(savedBag.inventorySummary)[advancedId].instances[0].id, starter.id);
        assert.deepEqual((await DB.fetchItems(damaged.characterId)).filter(row => NativeCrystals.catalog.crystals[row.selfId])
            .map(row => [row.id,row.selfId]), [[starter.id,advancedId]]);
        console.log('PASS startup repair keeps the original progressed crystal and removes the stale duplicate');

        state=await seed([{selfId:1049,name:'Spellbook: Ice Bolt',amount:1}],{classId:10,level:14});
        const current=Life.cachedState(state.characterId);
        const accepted=await Owner.commitBatch([{revision:current.simulation.revision,nextState:{...current,sp:100000},proposal:{...InventorySummary.bagChange(current.inventory,current.inventory),durable:{classId:10}},options:{allowLifecycle:true}}]);
        assert(accepted[0].ok);state=Life.cachedState(state.characterId);
        assert.equal((await DB.fetchSkills(state.characterId)).length,0,'accepted proposal cannot synthesize tree ranks');
        const paid=await Life.reviewTrainingAfterCommit(state);
        assert((await DB.fetchSkill(state.characterId,1184))[0]?.level>0);assert.equal(paid.sp,100000);
        assert.equal(paid.inventory[1049].amount, 1, 'personal training keeps skill books for NPC sale');
        assert(invoke('GameServer/Bot/Economy/ItemDisposition').saleCandidates(paid).some(row => row.selfId === 1049));
        assert.equal(paid.stats.coldCombat.skillSource,'database');
        assert.deepEqual(paid.stats.coldCombat.skills.map(row=>[row.selfId,row.level]),
            Profile.skillSnapshotsFromRecords(await DB.fetchSkills(state.characterId)).map(row=>[row.selfId,row.level]));
        console.log('PASS accepted Worker SP -> free native skills, books available for sale -> current authoritative kit');
    } finally { await DB.close();fs.rmSync(directory,{recursive:true,force:true}); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
