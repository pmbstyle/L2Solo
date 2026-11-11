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
// These lifecycle fixtures isolate procurement from geography.
Supply.useMarket(() => ({ board: invoke('GameServer/AfkTrade/AfkTradeService').boardIndex(),
    npcOffersFor: id => invoke('GameServer/Bot/Economy/FixedShotOffers').offers(id), tripFrom: () => () => 0 }));
const Funding = require('../src/GameServer/Bot/Economy/PurchaseFunding');
const { RaidSupplyPreparation } = require('../src/GameServer/Bot/Population/RaidSupplyPreparation');
const { lifecycleKind, ColdSimulationKernel } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
const { stepElapsedMs } = require('../src/GameServer/Bot/Population/ColdSoloWindow');
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
        market:{planPurchase:(_s,_id,n)=>({units:n,npc:n,cost:n*10,npcPrice:10,town:'Dion'}),tripFrom:()=>()=>0,
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
    // Parked, the bot waits for main's preparation, not a 30 s step: its own end is
    // the reservation's expiry; a write of main (its party, cancel, errand trip) wakes it.
    assert.equal(hold.nextResolveAt,plan.expiresAt,'a parked reservation holds to its expiry');
    const inTown=invoke('GameServer/Bot/Population/BackgroundResolver').resolveSolo({state:{...parked,activity:'shopping'},spot,timestamp:at});
    assert.equal(inTown.nextResolveAt,at+30000,'in town the purchase command keeps its retry');
    const waiting={...await Life.prepareResolve({...parked,timing:{lastResolvedAt:at-60000}},hold,
        {timestamp:at,persist:false,projectClassProgression:true}),simulation:{revision:1}};
    const kernel=new ColdSimulationKernel({now:()=>at+60000,resolveSolo:()=>null});
    kernel.upsert({state:waiting});
    assert.deepEqual(kernel.dueCandidates(at+60000,4),[],'no step while the reservation waits');
    const cancelled={...waiting,activity:'hunting',stats:{...waiting.stats,raidSupplyPreparation:null},
        timing:{...waiting.timing,nextResolveAt:at+61000},simulation:{revision:2}};
    kernel.upsert({state:cancelled});
    assert.deepEqual(kernel.dueCandidates(at+61000,4).map(c=>c.characterId),[4],'main\'s cancel wakes it on its due');
    assert.equal(stepElapsedMs(cancelled,at+61000),1000,'the minute it waited is not hunted');
    const expired=new ColdSimulationKernel({now:()=>plan.expiresAt,resolveSolo:()=>null});
    expired.upsert({state:waiting});
    assert.deepEqual(expired.dueCandidates(plan.expiresAt,4).map(c=>c.characterId),[4],'a missed write still ends at the expiry');
    const resumed=invoke('GameServer/Bot/Population/BackgroundResolver').resolveSolo({state:waiting,spot,timestamp:plan.expiresAt});
    assert.notEqual(resumed.debug.reason,'raid_supply_preparing','an expired reservation releases the bot');
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
            lines: [{ price: 5, count: cheap, line: { recordId: 9998, lineId: 1, selfId: supply.selfId, price: 5, count: cheap, ownerId: 9998 } },
                { price: 15, count: expensive, line: { recordId: 9999, lineId: 2, selfId: supply.selfId, price: 15, count: expensive, ownerId: 9999 } }] };
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
    // A finite cheap stack is shared by two DDs, then the configured seller
    // fills their different remainders. Forecast and reservation must agree.
    {
        const group = structuredClone(members);
        group[4].inventory[1463].amount = 1;
        group.forEach(s => { s.currentRegion='Dion'; s.adena=1000000; s.stats.money=[1000000,0,0,0]; });
        const allocationBook = new BoardIndex();
        AfkTrade.boardIndex = () => allocationBook;
        const fixed = id => invoke('GameServer/Bot/Economy/FixedShotOffers').offers(id).filter(s => s.town==='Dion');
        Supply.useMarket(() => ({ board:allocationBook,npcOffersFor:fixed,tripFrom:()=>()=>0 }));
        try {
            const initial = Policy.assessment(group,spot,{timestamp:at,fundSupplies:true});
            const needs = initial.supplies.filter(s => s.missing > 0);
            assert(initial.ready && needs.length===2);
            for (const count of [100,needs[0].missing+50]) {
                allocationBook.put({id:9810,ownerId:9910,storeType:1,kind:'shop',town:'Dion',revision:1,
                    lines:[{lineId:98100,selfId:1463,count,price:1}]});
                const unchanged = JSON.stringify([...allocationBook.records]);
                const fit = Policy.assessment(group,spot,{timestamp:at,fundSupplies:true});
                assert(fit.ready,JSON.stringify(fit.reasons));
                const states = new Map(group.map(s => [s.characterId,structuredClone(s)])), quoted=[];
                const preparation = new RaidSupplyPreparation({...dependencies,
                    life:{...dependencies.life,cachedState:id=>states.get(id),
                        upsertState:async s=>{states.set(s.characterId,s);return s;}},
                    market:{tripFrom:()=>{throw Error('the quote already contains its route cost');},planPurchase:(s,item,n,terms)=>{
                        const q=Market.planPurchase(s,item,n,{...terms,towns:['Dion'],cost:()=>0});
                        quoted.push(q);return q;
                    }} });
                const plan = await preparation.reserve(group,{...objective,assessment:fit},at);
                assert(plan,'an allocated public stack plus static remainder reserves all nine');
                assert.equal(quoted.length,2);
                assert.equal(quoted.reduce((n,q)=>n+q.lines.reduce((m,l)=>m+l.count,0),0),count,
                    'each public unit is allocated only once across all DDs');
                assert.equal(quoted.reduce((n,q)=>n+q.npc,0),needs.reduce((n,s)=>n+s.missing,0)-count);
                assert.equal(quoted[1].lines.reduce((n,l)=>n+l.count,0),Math.max(0,count-needs[0].missing),
                    'the next DD can still use the unallocated part of the same stack');
                assert(quoted.flatMap(q=>q.lines).every(l=>l.line.count===count),
                    'stock validation retains the seller original quantity');
                for (let i=0;i<needs.length;i++) {
                    const expected=fit.supplies.find(s=>s.id===needs[i].id);
                    assert.equal(quoted[i].cost,expected.cost,'forecast and reservation price the same allocation');
                    const marker=states.get(needs[i].id).stats.raidSupplyPreparation;
                    assert.equal(marker.supply.cashNeeded,expected.reserveCost);
                    assert.equal(marker.supply.priceCap,quoted[i].npcPrice,
                        'even a completely cheap quote keeps access to its static reserve');
                }
                assert.equal(JSON.stringify([...allocationBook.records]),unchanged,'quotes never consume public stock');
                const first=states.get(needs[0].id),later=states.get(needs[1].id);
                const arrivalQuote=s=>Market.planPurchase(s,1463,
                    s.stats.raidSupplyPreparation.supply.target-Number(s.inventory[1463].amount),{
                        purpose:'raid_supply',raidPreparationId:plan.id,towns:['Dion'],cost:()=>0,
                        maxPrice:s.stats.raidSupplyPreparation.supply.priceCap,money:Supply.cash(s),currentFunding:true });
                const early=arrivalQuote(later);
                assert(early && early.units===needs[1].missing,'a later DD may arrive before the first');
                allocationBook.remove(9810); // Any buyer, including someone outside the party, can take it.
                const after=arrivalQuote(first);
                assert(after && after.npc===needs[0].missing,
                    'the first DD can buy its entire missing stock after anyone takes the public stack');
                first.adena=1;
                assert.equal(arrivalQuote(first),null,'arrival rechecks the current wallet before using the reserve');
                preparation.stop();
            }
            allocationBook.put({id:9810,ownerId:9910,storeType:1,kind:'shop',town:'Dion',revision:1,
                lines:[{lineId:98100,selfId:1463,count:100000,price:1}]});
            const poor=structuredClone(group);
            poor[3].adena=needs[0].missing+1;poor[3].stats.money=[poor[3].adena,0,0,0];
            const poorFit=Policy.assessment(poor,spot,{timestamp:at,fundSupplies:true});
            assert(poorFit.reasons.includes('raid_consumables_funds'),
                'a cheap public offer cannot justify a trip when its backup is unaffordable');
            assert(poorFit.supplies.find(s=>s.id===poor[3].characterId).cost<Supply.cash(poor[3]));
            // Claimed cheap heads must not hide later stock behind quote depth,
            // and changing an allocation must invalidate amount-table reuse.
            const Query = require('../src/GameServer/Bot/Economy/OfferQuery'), deepBook=new BoardIndex(), claimed=new Map();
            for (let i=1;i<=6;i++) {
                deepBook.put({id:i,ownerId:9000+i,storeType:1,kind:'shop',town:'Dion',
                    lines:[{lineId:i,selfId:1463,count:10,price:i}]});
                if (i<6) claimed.set(`${i}:${i}`,10);
            }
            const terms={claimed,quoteDepth:1};
            assert.equal(Query.cheapestTown(deepBook,1463,{...terms,amount:10}).lines[0].line.lineId,6);
            const table=Query.townTable(deepBook,1463,terms);
            assert.equal(Query.cheapestIn(table,10).units,10);
            claimed.set('6:6',10);
            assert.equal(Query.cheapestIn(table,10),null,'a changed local allocation cannot reuse a previous fill');
        } finally {
            AfkTrade.boardIndex=nativeBoard;
            Supply.useMarket(() => ({board:AfkTrade.boardIndex(),npcOffersFor:id=>
                invoke('GameServer/Bot/Economy/FixedShotOffers').offers(id),tripFrom:()=>()=>0}));
        }
    }
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
    // Configured C shots have no ordinary NPC seller. A reserved raid uses
    // the same actual quote in assessment, acquisition and physical debit.
    const fixedC = invoke('GameServer/Bot/Economy/FixedShotOffers').offers(1464).find(s => s.town==='Giran');
    assert(fixedC && fixedC.price > 0);
    await Native.character(DB,9752,'RaidSupply9752','bot_raid_supply_c');
    const wallet=1000000,quantity=100;
    await DB.setItem(9752,{selfId:57,name:'Adena',amount:wallet});
    const reserveBook=AfkTrade.boardIndex();
    reserveBook.put({id:9820,ownerId:9920,storeType:1,kind:'shop',town:'Giran',
        lines:[{lineId:98200,selfId:1464,count:quantity,price:1}]});
    const beforeC={...state,currentRegion:'Giran',adena:wallet,inventory:{},stats:{...state.stats,money:[wallet,0,0,0]}};
    const cheapC=Supply.quote(beforeC,1464,quantity,{timestamp:at});
    const budgetC=Supply.quoteBudget(cheapC,quantity);
    assert.equal(cheapC.cost,quantity);
    assert.equal(budgetC.cashNeeded,quantity*fixedC.price);
    const markerC={id:'fixed-c',expiresAt:at+600000,supply:{selfId:1464,target:quantity,...budgetC}};
    const buyerC=await Life.upsertState({...state,characterId:9752,name:'RaidSupply9752',accountName:'bot_raid_supply_c',
        currentRegion:'Giran',adena:wallet,activity:'shopping',
        inventory:Life.inventorySummaryFromItems(await DB.fetchItems(9752)),
        stats:{...state.stats,money:[wallet,.001,1000,77,.1,wallet,999],raidSupplyPreparation:markerC}},'raid_static_c_fixture');
    const quotedC=Supply.supplies([buyerC],[{id:9752,selfId:1464,required:quantity,stock:0}],at)[0];
    assert.equal(quotedC.available,quantity);
    assert.equal(quotedC.price,1);
    assert.equal(quotedC.reserveCost,quantity*fixedC.price);
    const departedC=await Market.acquire({...buyerC,activity:'party_wait',
        loc:{locX:83396,locY:147904,locZ:-3404}},1464,quantity,
        {purpose:'raid_supply',raidPreparationId:markerC.id,towns:['Giran'],
            maxPrice:markerC.supply.priceCap,money:Supply.cash(buyerC),cost:()=>0,persist:false});
    const errandC=require('../src/GameServer/Bot/Population/CombinedErrandPolicy').pending(departedC.state)
        .find(e=>e.purpose==='raid_supply');
    assert(errandC,'departure saves its native supply errand');
    assert.equal(departedC.plan.cost,quantity,'departure still selects the cheaper public stack');
    assert.equal(errandC.money,quantity*fixedC.price,'saved authority funds a full reserve despite the cheap departure quote');
    assert.equal(errandC.maxPrice,fixedC.price);
    reserveBook.remove(9820); // A public buyer exhausted it while this DD travelled.
    reserveBook.put({id:9821,ownerId:9921,storeType:1,kind:'shop',town:'Dion',
        lines:[{lineId:98210,selfId:1464,count:quantity,price:1}]});
    const list=reserveBook.list;let bookReads=0,routeReads=0;
    reserveBook.list=function(...args){bookReads++;return list.apply(this,args);};
    let reserveTown;
    try {
        reserveTown=Market.planPurchase(buyerC,1464,quantity,{purpose:'raid_supply',money:Supply.cash(buyerC),
            cost:()=>{routeReads++;return 0;}});
    } finally {reserveBook.list=list;}
    assert.equal(reserveTown.town,'Giran','a raid destination retains a reserve when a cheaper town has none');
    assert.equal(bookReads,1,'a reserve quote reads only the selected item/town index');
    assert.equal(routeReads,2,'only the existing reachability and quote route lookups are needed');
    assert.equal(Market.planPurchase(buyerC,1464,quantity,{money:wallet,cost:()=>0}).town,'Dion',
        'ordinary purchasing keeps its existing town choice');
    reserveBook.remove(9821);
    const arrivedC=await Life.upsertState({...departedC.state,activity:'shopping',currentRegion:'Giran',
        stats:{...departedC.state.stats,travel:null}},'raid_static_c_arrival');
    const boughtC=await Market.tryPurchase(arrivedC);
    assert(boughtC.purchased,JSON.stringify(boughtC));
    assert.equal(Native.amount(await DB.fetchItems(9752),1464),quantity);
    assert.equal(Native.amount(await DB.fetchItems(9752),57),wallet-quantity*fixedC.price);
    assert.equal(Supply.purchaseBudget(boughtC.state,{itemId:1464,raidPreparationId:markerC.id},at),0,
        'a completed configured target cannot authorize a second debit');
    await DB.close();
    {
    // The production configuration has no NPC graded-shot supply. Real
    // backed quantities, mixed prices and the route must fund the forecast.
    invoke('GameServer/Bot/Population/PopulationConfig').staticShotsDisabled = true;
    const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
    const board = new BoardIndex();
    Supply.useMarket(() => ({ board,
        npcOffersFor: id => invoke('GameServer/Bot/Economy/MarketOpportunity').npcOffersAll(id),
        tripFrom: () => () => 25 }));
    const stock = (id, count, price, conditional = false, ownerId = 90000 + id, selfId = 1463) => board.put({
        id, ownerId, storeType: 1, kind: conditional ? 'sell_ad' : 'shop', custodyPolicy: conditional ? 1 : 0,
        town: 'Dion', revision: 1, lines: [{ lineId: id, selfId, count, price, enchant: 0 }] });
    stock(90001, 100000, 1, true);
    stock(90002, 100000, 1, false, members[3].characterId);
    stock(90003, 500, 10);
    stock(90004, supply.missing - 500, 20);
    const backedFit = Policy.assessment(members, spot, { timestamp: at, fundSupplies: true });
    assert(backedFit.ready, JSON.stringify(backedFit.reasons));
    const real = backedFit.supplies.find(s => s.missing > 0);
    assert.equal(real.available, supply.missing);
    assert.equal(real.price, 20);
    assert.equal(real.cost, 500 * 10 + (supply.missing - 500) * 20 + 25);
    const Priority = require('../src/GameServer/Bot/Population/RaidRosterPriority');
    const rich = members[3], poor = { ...rich, adena: 1, stats: { ...rich.stats, money: [0,0,0,0] } };
    assert(Priority.facts(rich, 'damage').score > Priority.facts(poor, 'damage').score,
        'an affordable backed market replenishment improves DD ranking with NPC shots disabled');
    const poorGroup = members.map(s => s === rich ? poor : s);
    assert(Policy.assessment(poorGroup, spot, { timestamp: at, fundSupplies: true }).reasons.includes('raid_consumables_funds'));
    stock(90004, supply.missing - 501, 20);
    const unavailable = Policy.assessment(members, spot, { timestamp: at, fundSupplies: true });
    assert(unavailable.reasons.includes('raid_supplies_unavailable'));
    assert(!unavailable.reasons.includes('raid_consumables_funds'), 'absent supply is not poverty');
    const twoBuyers = structuredClone(members); twoBuyers[4].inventory[1463].amount = 1;
    board.remove(90002); // No roster member owns a public supply for this check.
    stock(90004, supply.missing - 500, 20);
    const beforeBook = JSON.stringify([...board.records]);
    const shared = Policy.assessment(twoBuyers, spot, { timestamp: at, fundSupplies: true });
    assert(shared.reasons.includes('raid_supplies_unavailable'), 'the same seller stock cannot fund two members');
    assert.equal(shared.supplies.reduce((n,s) => n + s.available, 0), supply.missing);
    assert.equal(JSON.stringify([...board.records]), beforeBook, 'forecast allocation never consumes real seller stock');
    stock(90005, 1000, 200, false, 99999, 1464);
    const cQuote = Supply.quote(rich, 1464, 1000, { timestamp: at, money: 300000 });
    assert.equal(cQuote.units, 1000);
    assert.equal(cQuote.landed, 200025, 'C shots use backed public prices and a finite route');
    Supply.useMarket(() => ({ board, npcOffersFor: () => [], tripFrom: () => () => Infinity }));
    assert.equal(Supply.quote(rich, 1464, 1000), null, 'unreachable stock is unavailable');
    }
    console.log('Raid supply preparation, recovery, native funding and physical wallet checks passed');
}
run().catch(e=>{console.error(e);process.exitCode=1;});
