'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
process.env.L2NODE_CONFIG_FILE = 'config/default.ini';
require('../src/Global');
require('./helpers/progressionRate').useRate('x50');
invoke('GameServer/DataCache').init({ validate: false });
const Horizon = require('../src/GameServer/Bot/Economy/ShotProductionHorizon');
const Policy = require('../src/GameServer/Bot/Economy/ShotCraftPolicy');
const Shots = require('../src/GameServer/Bot/Economy/ColdShotEconomyService');
const Funding = require('../src/GameServer/Bot/Economy/ShotProductionFunding');
const Basket = require('../src/GameServer/Bot/Economy/WealthCraftPolicy');
const Codec = require('../src/GameServer/Bot/Economy/RecipeBookCodec');
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const { BoardIndex, rowOf } = require('../src/GameServer/AfkTrade/BoardIndex');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const probe = require('./helpers/workerEconomyDecision');
const originalBoard = Afk.boardIndex;

(async () => {
    const recipe = Recipes.resolveByRecipeId(21), now = Date.now();
    const state = { characterId: 910902, name: 'SeriesSmith', accountName: 'bot_pop_series',
        level: 49, phase: 'cold', activity: 'shopping', currentRegion: 'Giran',
        adena: 1000000, vitals: { hp: 1000, maxHp: 1000, mp: 80, maxMp: 500 },
        loc: { locX: 83396, locY: 147904, locZ: -3400 }, timing: {},
        inventory: Object.fromEntries([[1458,100],[1459,100],[1785,10000]].map(([selfId,amount]) =>
            [selfId,{ selfId,amount,stackable:true }])), stats: { classId: 57, money: [1000,.001,0,0] } };
    state.persona = invoke('GameServer/Bot/AI/BotPersona').generate(state);
    const records = [
        { id: 910920, ownerId: 910921, kind: 'shop', custodyPolicy: 0, storeType: 3, town: 'Giran', revision: 1,
            lines: [{ id: 9109200, lineId: 9109200, selfId: 1463, count: 312, price: 2000, enchant: 0 }] },
        { id: 910930, ownerId: 910931, kind: 'shop', custodyPolicy: 0, storeType: 3, town: 'Giran', revision: 1,
            lines: [{ id: 9109300, lineId: 9109300, selfId: 1464, count: 4760, price: 1000, enchant: 0 }] },
        { id: 910940, ownerId: 910941, kind: 'shop', custodyPolicy: 0, storeType: 1, town: 'Giran', revision: 1,
            lines: [{ id: 9109400, lineId: 9109400, selfId: 1805, count: 1, price: 50000, enchant: 0 }] }
    ];
    const board = new BoardIndex(); records.forEach(row => board.put(row)); Afk.boardIndex = () => board;
    const input = { timestamp: now, recipeEarning: true, recipes: { recipeBook: Codec.pack([20]), knownShotRecipes: [20] },
        boardRows: records.map(row => [row.id,rowOf(row)]) };
    const d = Shots.craftCandidate(state, Recipes.resolveByRecipeId(20), Shots.marketSnapshot(now));
    const c = Shots.craftCandidate(state, recipe, Shots.marketSnapshot(now));
    assert(d.valueHours > c.valueHours, 'today\'s MP alone favours the known D recipe');
    const picked = Policy.unpackStep(Policy.packStep((await probe(state,input)).selected));
    assert.equal(picked.recipeTarget,21,'the larger finite C series pays for learning and beats the saturated D orders');
    assert(picked.recipeRoute.horizonBatches > picked.recipeRoute.batches);
    assert.equal(picked.recipeRoute.batches,1,'the physical next command still fits the actual MP');
    const first = Shots.recheck(state,picked.recipeRoute), series = Shots.recheckSeries(state,first,picked.recipeRoute);
    assert(first && series,'native rechecks admit both today\'s command and its bounded projection');
    assert(series.expectedSold <= 4760,'one public order is counted once over the whole series');
    assert(series.horizon.readyHours <= Horizon.HOURS);
    const cost = Funding.recipePaths(state,recipe,{ route:series,acquisition:{available:true,price:50000},context:series.context });
    assert.equal(cost.best.kind,'acquire');
    assert.equal(cost.best.valueHours,series.valueHours-50,'the scroll is charged once over all future commands');
    assert.equal(state.vitals.mp,80,'the projection never grants live MP');
    assert.equal(Shots.recheckSeries(state,first,{...picked.recipeRoute,horizonBatches:65}),null);
    assert.equal(Shots.recheckSeries(state,first,{...picked.recipeRoute,horizonBatches:1.5}),null);
    const smallDemand = records.map(row => row.id === 910930
        ? {...row,lines:row.lines.map(line=>({...line,count:476}))} : row);
    const saturated = Policy.unpackStep(Policy.packStep((await probe(state,{...input,
        boardRows:smallDemand.map(row=>[row.id,rowOf(row)])})).selected));
    assert.equal(saturated.craft?.recipeId,20,'one C order cannot be multiplied into future customers');
    const poor = Policy.unpackStep(Policy.packStep((await probe({...state,adena:49999},input)).selected));
    assert.notEqual(poor?.recipeTarget,21,'future earnings cannot replace the cash to buy the scroll');
    const noSeller = records.filter(row => row.id !== 910940);
    const sought = Policy.unpackStep(Policy.packStep((await probe(state,{...input,
        boardRows:noSeller.map(row=>[row.id,rowOf(row)])})).selected));
    assert.equal(sought.recipeTarget,21,'a native recipe source supports a finite procurement target without a seller');
    const waiting = { ...state, stats: { ...state.stats, shotRecipeDemand: { itemId:1805,recipeId:21,
        batches:sought.recipeRoute.horizonBatches,maxSpend:100000,amount:1,at:now } } };
    const wants = await probe(waiting,{timestamp:now,nativeRoutes:true,recipes:input.recipes,
        boardRows:noSeller.map(row=>[row.id,rowOf(row)])});
    assert(wants.tradeIntents.some(row=>row.itemId===1805),
        `the accepted series exposes a recipe bid to suppliers: ${JSON.stringify(wants.queue)}`);
    const emptySupply = new BoardIndex(); noSeller.forEach(row => emptySupply.put(row));
    const intent = wants.tradeIntents.find(row => row.itemId === 1805);
    const bidState = { ...waiting, stats: { ...waiting.stats, ...wants.statsPacket } };
    const economy = invoke('GameServer/Bot/Population/ColdEconomyDecision').view(bidState,
        require('../src/GameServer/Bot/Population/ColdEconomyDecision').compact(wants.decision),
        { board: emptySupply });
    const bid = invoke('GameServer/Bot/Economy/BuyAdPolicy').bidFor(bidState, {
        type: 'buy_craft_material', target: { itemId: 1805, amount: 1 }, intent,
        plan: { purpose: 'recipe', valueRate: intent.valueRate }
    }, { economy, board: emptySupply, town: 'Giran' });
    assert(bid, `the native bid policy can publish the funded missing-scroll request: ${JSON.stringify({intent,money:bidState.stats.money,moneyPrice:economy.moneyPrice,cap:waiting.stats.shotRecipeDemand.maxSpend})}`);
    assert.equal(bid.count, 1);
    assert(bid.price <= waiting.stats.shotRecipeDemand.maxSpend, 'the public bid retains the finite investment cap');

    const trip = () => 100; trip.details = () => ({known:true,hours:.01,fees:100});
    const raw = { recipe:{mpCost:10,productCount:100,successRate:100},batches:6,hours:.11,valueHours:10,
        basket:{actualCashFees:100,cost:1100,extraMp:0,purchases:[{selfId:1459,town:'Heine'},{selfId:1785,town:'Giran'}]},
        exit:{type:'listing',town:'Giran'}, valuation:{valueHours:10,cashNow:1100,cycleHours:.11},
        margin:{netCash:10000,labour:100,profit:10000} };
    const firstTrip = {batches:2,crystalId:1459,gear:{source:'afk'},exit:raw.exit};
    const projected = Horizon.value(raw,{vitals:{mp:20,maxMp:20}}, firstTrip,
        {mpPerHour:1000,moneyPrice:.001,trip});
    assert.equal(projected.horizon.cycles,3);
    assert.equal(projected.horizon.extraFees,200,'repeat ore and sale share one town; gear is not bought again');
    assert.equal(projected.horizon.extraHours,.02);
    assert(Math.abs(projected.valueHours - 9.78) < 1e-10);
    const crystalTrips = Horizon.value(raw,{vitals:{mp:20,maxMp:20}},
        {...firstTrip,gear:{source:'crystals'}},{mpPerHour:1000,moneyPrice:.001,trip});
    assert.equal(crystalTrips.horizon.extraFees,400,'ready crystals require a new purchase trip on every command');
    assert.equal(crystalTrips.horizon.extraHours,.04);
    assert.equal(Horizon.value({...raw,batches:1},state,firstTrip,{}),null,
        'a projection cannot replace the physical next command with a smaller batch');
    assert.equal(Horizon.value({...raw,exit:{...raw.exit,town:'Dion'}},state,firstTrip,{}),null,
        'future income must retain the next command\'s public sales channel');
    assert.equal(Horizon.projectState(state,recipe,{mpPerHour:0}),null);
    assert.equal(Horizon.projectState({...state,vitals:{...state.vitals,mp:recipe.mpCost-1}},recipe,{mpPerHour:6000}),null,
        'a future series cannot execute a first command without enough current MP');
    const personalSeries = {...state,inventory:{1464:{selfId:1464,amount:476}},stats:{...state.stats,
        shotCraft:{series:{recipeId:21,batches:6,at:now,ownReserve:2038,exit:[11,101,100,1]}}}};
    const demandBoard = {list:()=>[{recordId:11,lineId:101,ownerId:9999,count:1000,price:100}],ownerLines:()=>[]};
    assert.equal(Horizon.retainedBatches(personalSeries,demandBoard,now),6,
        'the remaining kit covers personal replenishment and public sales without treating private stock as sale output');
    assert.equal(Horizon.retainedBatches(personalSeries,{...demandBoard,list:()=>[]},now),4,
        'with public demand withdrawn only the missing personal stock retains materials');
    assert.equal(Horizon.retainedBatches(personalSeries,{...demandBoard,
        ownerLines:()=>[{storeType:1,custodyPolicy:0,selfId:1464,count:1000}]},now),4,
        'posted commercial output offsets public sales, not the private stock shortfall');
    console.log('PASS shot horizon: finite D/C demand, one scroll, MP recovery, repeated trips, upfront cash and native rechecks');
})().catch(error=>{console.error(error.stack);process.exitCode=1;}).finally(()=>{Afk.boardIndex=originalBoard;});
