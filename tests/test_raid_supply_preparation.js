'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('raid-supplies');
require('../src/Global'); fixture.assertConfigured(options.default);
// The author's fixed shot merchant sells shots here (off by default since T116).
invoke('GameServer/Bot/Population/PopulationConfig').staticShotsDisabled = false;
process.on('exit', () => fs.rmSync(fixture.directory, { recursive: true, force: true }));
const Data = invoke('GameServer/DataCache'); Data.init({ validate: false });
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Combat = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Policy = require('../src/GameServer/Bot/Population/OpportunisticRaidPolicy');
const Supply = require('../src/GameServer/Bot/Population/RaidSupplyPolicy');
const Funding = require('../src/GameServer/Bot/Economy/PurchaseFunding');
const { RaidSupplyPreparation } = require('../src/GameServer/Bot/Population/RaidSupplyPreparation');
const { lifecycleKind } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
const Catalog = invoke('GameServer/RaidBoss/RaidBossSourceCatalog');
const at = Date.now();
function member(id, classId, level, weapon, healer = false) {
    const gear = [weapon, 40, 45, 50, ...(healer ? [432, 465] : [347, 376, 625])];
    const slot = [7, 12, 6, 9, 10, 11, 8];
    const items = gear.map((selfId, i) => ({ selfId, amount: 1, equipped: 1,
        slot: [93, 178, 291].includes(selfId) ? 14 : slot[i], name: Data.items.find(t => t.selfId === selfId).template.name }));
    [114, 114, 118, 876, 876].forEach((selfId, i) => items.push({ selfId, amount: 1, equipped: 1,
        slot: i + 1, name: Data.items.find(t => t.selfId === selfId).template.name }));
    items.push({ selfId: weapon === 3 ? 1835 : 1463, amount: 2500, slot: 0, equipped: 0 });
    const s = { characterId: id, name: `adventurer_${id}`, accountName: `bot_${id}`, level, classId,
        adena: 100000, phase: 'cold', activity: 'hunting', party: { partyId: null }, updatedAt: at,
        stats: { classId, coldCombat: { classId, skills: Combat.skillsFor({ classId, level }) } },
        inventory: Life.inventorySummaryFromItems(items) };
    const p = Combat.profileFor(s); s.vitals = { hp: p.maxHp, maxHp: p.maxHp, mp: p.maxMp, maxMp: p.maxMp };
    return s;
}

async function run() {
    const members = [member(1,32,28,3),member(2,42,28,178,true),member(3,29,28,178,true),
        ...Array.from({length:6},(_,i)=>member(4+i,56,28,168))];
    members[3].inventory[1463].amount = 1;
    const spot = Catalog.findById('raid:10366');
    const fit = Policy.assessment(members,spot,{timestamp:at,fundSupplies:true});
    assert(fit.ready, JSON.stringify(fit));
    const supply = fit.supplies.find(s=>s.missing>0);
    const states = new Map(members.map(s=>[s.characterId,structuredClone(s)]));
    let purchases=0,formed=0,assessments=0;
    const dependencies = {
        life: {cachedState:id=>states.get(id), populationSeedStates:()=>[...states.values()],
            upsertState:async s=>{states.set(s.characterId,s);return s;}},
        coordinator:{fenceBot:async()=>({ok:true}),notifyState:()=>{}},
        memory:{assess:()=>({ready:true,disposition:'neutral',effective:{hostility:0}})},
        market:{planPurchase:(_s,_id,n)=>({units:n,cost:n*10,npcPrice:10,town:'Dion'}),tripFrom:()=>()=>0,
            acquire:async(s,item,n,terms)=>{purchases++;assert.equal(terms.raidPreparationId,s.stats.raidSupplyPreparation.id);
                assert.equal(n,supply.missing);states.set(s.characterId,{...s,activity:'traveling',stats:{...s.stats,travel:{}}});
                return {traveling:true,plan:{town:'Dion'}};}},
        catalog:Catalog, bossFree:()=>true,
        assess:async ss=>{assessments++;return Policy.assessment(ss,spot,{timestamp:at});},
        form:async ss=>{formed++;assert(ss.every(s=>!s.stats.travel));return {partyId:'ready'};}
    };
    let prep = new RaidSupplyPreparation(dependencies);
    const objective = {sourceKind:'raid',opportunisticRaid:true,sourceLevel:23,raidBossTemplateId:10366,
        spotId:spot.id,assessment:fit,expiresAt:at+2700000};
    const plan = await prep.reserve(members,objective,at);
    assert(plan && states.size===9);
    assert([...states.values()].every(s=>!Policy.available(s,at)),'reservations exclude unrelated recruitment');
    const parked=states.get(4);
    assert.equal(lifecycleKind(parked),'resolver');
    const hold=invoke('GameServer/Bot/Population/BackgroundResolver').resolveSolo({state:parked,spot,timestamp:at});
    assert.equal(hold.debug.fights,0);assert.equal(hold.materialize.exp,0);
    await prep.maintain(at); assert.equal(purchases,1);assert.equal(formed,0);
    await prep.maintain(at+1000);assert.equal(formed,0,'cannot form during purchase travel');
    prep.stop(); prep = new RaidSupplyPreparation(dependencies);await prep.start();
    assert.equal(prep.snapshot().length,1,'complete reservations recover after a restart');
    const buyer=states.get(4);
    states.set(4,{...buyer,activity:'party_wait',inventory:{...buyer.inventory,1463:{...buyer.inventory[1463],amount:supply.target}},
        stats:{...buyer.stats,travel:null}});
    await prep.maintain(at+2000);assert.equal(formed,1);assert.equal(assessments,1);
    assert.equal(prep.snapshot().length,0);
    // A partial durable group releases every remaining reservation on recovery.
    states.delete(9);prep = new RaidSupplyPreparation(dependencies);await prep.start();
    assert.equal(prep.snapshot().length,0);assert([...states.values()].every(s=>!Supply.held(s)));

    const marker={id:'funded',expiresAt:at+600000,supply:{selfId:2509,target:100,priceCap:18}};
    const funded={adena:5000,inventory:{},stats:{money:[5000,.001,1000,77,.1,4000,999],raidSupplyPreparation:marker}};
    assert.equal(Funding.spendable(funded),0,'personal wish still protects its normal budget');
    assert.equal(Funding.spendable(funded,0,{itemId:2509,raidPreparationId:'funded'}),1800);
    assert.equal(Supply.purchaseBudget(funded,{itemId:736,raidPreparationId:'funded'},at),0);
    assert.equal(Supply.purchaseBudget(funded,{itemId:2509,raidPreparationId:'stale'},at),0);
    assert.equal(Supply.purchaseBudget(funded,{itemId:2509,raidPreparationId:'funded'},at+600001),0);
    assert.equal(Supply.purchaseBudget({...funded,adena:1100},{itemId:2509,raidPreparationId:'funded'},at),100);
    assert.equal(Funding.nativeTerms({raidPreparationId:'funded'},2509).raidPreparationId,'funded');

    const Market = invoke('GameServer/Bot/Economy/ColdMarketService');
    const quote = { selfId: 2509, town: 'Dion', cost: 10, landed: 10, npc: 0,
        lines: [{ price: 1, count: 10, line: { selfId: 2509, price: 1, count: 10, ownerId: 9999, conditional: true } }] };
    assert.equal(Market.planPurchase(funded,2509,10,{purpose:'raid_supply',sourcePlan:quote,npc:false}),null,
        'an ordinary wish meeting cannot consume a reserved raid supply request');
    const backed = structuredClone(quote); backed.lines[0].line.conditional = false;
    assert.equal(Market.planPurchase(funded,2509,10,{purpose:'raid_supply',sourcePlan:backed,npc:false}).units,10,
        'backed public shops remain valid raid suppliers');

    // The affordable quote mixes two backed prices. Its highest unit price
    // is a debit ceiling, not the price of every unit in the order.
    async function mixedPurchase(change = () => {}) {
        const group = structuredClone(members);
        const buyer = group.find(s => s.characterId === supply.id);
        buyer.adena = supply.missing * 11;
        buyer.stats.money = [buyer.adena,.001,Math.floor(supply.missing / 2),0];
        const fit = Policy.assessment(group,spot,{timestamp:at,fundSupplies:true});
        assert(fit.ready, JSON.stringify(fit));
        const cheap = Math.floor(supply.missing / 2), expensive = supply.missing - cheap;
        const cost = cheap * 5 + expensive * 15;
        let source = { selfId: supply.selfId, town: 'Dion', cost, landed: cost, npc: 0,
            lines: [{ price: 5, count: cheap, line: { selfId: supply.selfId, price: 5, count: cheap, ownerId: 9998 } },
                { price: 15, count: expensive, line: { selfId: supply.selfId, price: 15, count: expensive, ownerId: 9999 } }] };
        const states = new Map(group.map(s => [s.characterId, s]));
        let calls = 0, quotes = 0;
        const preparation = new RaidSupplyPreparation({ ...dependencies,
            life: { ...dependencies.life, cachedState: id => states.get(id),
                upsertState: async s => { states.set(s.characterId,s); return s; } },
            market: { tripFrom: () => () => source.landed - source.cost,
                planPurchase: (s,item,n,terms) => {
                    quotes++; return Market.planPurchase(s,item,n,{ ...terms, sourcePlan:source, npc:false });
                },
                acquire: async (s,item,n,terms) => {
                    calls++;
                    assert.equal(terms.maxPrice,15);
                    assert.equal(terms.raidPreparationId,s.stats.raidSupplyPreparation.id);
                    const plan = Market.planPurchase(s,item,n,{ ...terms, sourcePlan:source, npc:false, currentFunding:true });
                    if (!plan) return { plan:null };
                    assert(plan.cost + Math.max(0,source.landed-source.cost) <= Supply.cash(s));
                    states.set(s.characterId,{...s,activity:'traveling',stats:{...s.stats,travel:{}}});
                    return { traveling:true,plan };
                } } });
        const plan = await preparation.reserve(group,{...objective,assessment:fit},at);
        assert(plan, 'a real combat assessment and affordable mixed quote reserve all nine');
        assert.equal(quotes,1,'reservation prices only the member who needs stock');
        assert(cost <= Supply.cash(buyer) && Supply.cash(buyer) < supply.missing * 15,
            'the wallet funds the actual quote but cannot buy the whole order at its maximum price');
        await change({ states, buyer, setSource: value => { source = value; }, source, preparation });
        await preparation.maintain(at);
        assert.equal(quotes,1,'preparation leaves fresh market pricing to acquire without a second market scan');
        preparation.stop();
        return { preparation, states, calls };
    }
    const mixed = await mixedPurchase();
    assert.equal(mixed.calls,1,'an affordable mixed-price purchase reaches the native acquisition path');
    assert.equal(mixed.preparation.snapshot().length,1,'mixed prices do not cancel the reserved nine');
    assert.equal(mixed.states.get(supply.id).activity,'traveling');
    // Exercise the ordinary board query too: source-plan callers already
    // require a whole quote, while an unrestricted town query can be partial.
    const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
    const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
    const board = new BoardIndex(), nativeBoard = AfkTrade.boardIndex;
    const cheap = Math.floor(supply.missing / 2), expensive = supply.missing - cheap;
    for (const [i,count,price] of [[1,cheap,5],[2,expensive,15]]) board.put({ id:9800+i, ownerId:9900+i,
        storeType:AfkTrade.SELL,kind:'shop',town:'Dion',revision:1,
        lines:[{lineId:98000+i,selfId:supply.selfId,count,price}] });
    AfkTrade.boardIndex = () => board;
    try {
        const traveling = mixed.states.get(supply.id);
        const buyer = { ...traveling, activity:'party_wait', stats:{...traveling.stats,travel:null} }, cash = Supply.cash(buyer);
        const terms = { purpose:'raid_supply',raidPreparationId:buyer.stats.raidSupplyPreparation.id,
            money:cash,maxPrice:15,towns:['Dion'],npc:false,currentFunding:true,cost:()=>0 };
        const whole = Market.planPurchase(buyer,supply.selfId,supply.missing,terms);
        assert(whole,JSON.stringify({cash,budget:Supply.purchaseBudget(buyer,{itemId:supply.selfId,raidPreparationId:terms.raidPreparationId}),
            lines:board.list(supply.selfId,AfkTrade.SELL,'Dion')}));
        assert.equal(whole.units,supply.missing); assert.equal(whole.cost,cheap*5+expensive*15);
        assert.equal(whole.lines.length,2,'the ordinary town query preserves the mixed executable quote');
        assert.equal(Market.planPurchase(buyer,supply.selfId,supply.missing,{...terms,money:whole.cost-1}),null,
            'the ordinary town query rejects an unaffordable partial fill');
        assert.equal(Market.planPurchase(buyer,supply.selfId,supply.missing,{...terms,maxPrice:5}),null,
            'stock below the price cap must fill the whole raid target');
        assert.equal(Market.planPurchase(buyer,supply.selfId,supply.missing,{...terms,cost:()=>cash}),null,
            'the ordinary town query also checks round-trip funding');
        assert.equal(Market.planPurchase(buyer,supply.selfId,supply.missing,{...terms,purpose:'shots',money:whole.cost-1})?.whole,false,
            'ordinary personal restocking retains its existing partial-purchase behavior');
    } finally { AfkTrade.boardIndex = nativeBoard; }
    const short = await mixedPurchase(({ states,buyer }) => { states.get(buyer.characterId).adena = 1; });
    assert.equal(short.preparation.snapshot().length,0,'a real funding shortage still cancels preparation');
    assert([...short.states.values()].every(s=>!Supply.held(s)),'failed funding releases all nine');
    const changedWallet = await mixedPurchase(({ states,buyer,preparation }) => {
        preparation.coordinator = { ...preparation.coordinator, fenceBot:async id => {
            if (id === buyer.characterId) states.set(id,{...states.get(id),adena:1});
            return {ok:true};
        } };
    });
    assert.equal(changedWallet.preparation.snapshot().length,0,'acquisition re-reads money after fencing the buyer');
    const delivered = await mixedPurchase(({ states,buyer,preparation }) => {
        preparation.coordinator = { ...preparation.coordinator, fenceBot:async id => {
            if (id === buyer.characterId) {
                const latest = states.get(id);
                states.set(id,{...latest,inventory:{...latest.inventory,
                    [supply.selfId]:{...latest.inventory[supply.selfId],amount:supply.target}}});
            }
            return {ok:true};
        } };
    });
    assert.equal(delivered.calls,0,'stock delivered while fencing cannot trigger a redundant purchase');
    assert.equal(delivered.preparation.snapshot().length,1,'a completed stock target keeps its valid reservation');
    const sold = await mixedPurchase(({ source,setSource }) => {
        const partial = structuredClone(source); partial.lines.pop(); setSource(partial);
    });
    assert.equal(sold.preparation.snapshot().length,0,'sold-out stock cannot start a partial raid supply trip');
    const costlyTrip = await mixedPurchase(({ source,setSource,buyer }) => {
        setSource({...source,landed:source.cost + buyer.adena});
    });
    assert.equal(costlyTrip.preparation.snapshot().length,0,'a changed route must still fit the real wallet');
    const repriced = await mixedPurchase(({ source,setSource }) => {
        const dearer = structuredClone(source); dearer.lines[1].price = dearer.lines[1].line.price = 16;
        setSource(dearer);
    });
    assert.equal(repriced.preparation.snapshot().length,0,'a changed source cannot exceed the admitted unit price');

    // The real native writer must carry the same authority and debit physical money.
    const DB=invoke('Database'), Native=require('./helpers/nativeMarketFixture');
    const Basket=require('../src/GameServer/Bot/Economy/NpcPurchaseBasket');
    await DB.init();
    await Native.character(DB,9751,'RaidSupply9751','bot_raid_supply');
    await DB.setItem(9751,{selfId:57,name:'Adena',amount:5000});
    let state=await Life.upsertState({...funded,characterId:9751,name:'RaidSupply9751',accountName:'bot_raid_supply',
        phase:'cold',activity:'shopping',level:26,currentRegion:'Dion',loc:{x:0,y:0,z:0},timing:{},
        vitals:{hp:100,maxHp:100,mp:100,maxMp:100},
        inventory:Life.inventorySummaryFromItems(await DB.fetchItems(9751))},'raid_supply_fixture');
    const seller=Basket.sellerFor(2509,'Dion',18);
    const line={selfId:2509,amount:100,unitPrice:18,funding:{itemId:2509,raidPreparationId:'funded'}};
    const bought=await Basket.purchase(state,{seller,lines:[line]});assert(bought.ok);
    assert.equal(Native.amount(await DB.fetchItems(9751),57),3200);
    assert.equal(Native.amount(await DB.fetchItems(9751),2509),100);
    state=bought.state;
    await assert.rejects(Basket.purchase(state,{seller,lines:[{...line,amount:1}]}),/funding_changed/,
        'a completed target grants no second purchase');
    assert.equal(Native.amount(await DB.fetchItems(9751),57),3200);
    await DB.close();
    console.log('Raid supply preparation, recovery, native funding and physical wallet checks passed');
}
run().catch(e=>{console.error(e);process.exitCode=1;});
