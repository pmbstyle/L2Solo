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

    const thin = { ...state, adena: 100000000, inventory: {}, stats: { ...state.stats,
        shotRecipeDemand: { itemId: 1805, recipeId: 21, batches: 8, maxSpend: 1000000,
            inputCash: 150000, amount: 1, at: now } } };
    const thinRecords = noSeller.map(row => row.id === 910930
        ? { ...row, lines: row.lines.map(line => ({ ...line, count: 3808, price: 200 })) } : row);
    const thinBoard = new BoardIndex(); thinRecords.forEach(row => thinBoard.put(row));
    const counters = invoke('GameServer/Bot/Economy/MarketCounters');
    counters.supplyDeal(1464, 200, 'Giran', now - 600000);
    counters.supplyDeal(1464, 200, 'Giran', now - 300000);
    let marketRows; counters.publish({ register: (_name, source) => marketRows = source.allRows(), changed: () => {} });
    const thinInput = { timestamp: now, nativeRoutes: true, recipes: input.recipes,
        tables: [{ name: 'board', from: null, to: 0, full: true, removed: [], rows: thinRecords.map(row => [row.id, rowOf(row)]) },
            { name: 'market', from: null, to: 0, full: true, removed: [], rows: marketRows.map(row => [row[0], row]) }] };
    const thinWants = await probe(thin, thinInput);
    const thinIntent = thinWants.tradeIntents.find(row => row.itemId === 1805);
    assert(thinIntent?.shotRecipeInvestment, `one recipe retains the accepted series value beside 120 ore and eight crystals: ${JSON.stringify({intent:thinIntent,queue:thinWants.queue})}`);
    const thinState = { ...thin, stats: { ...thin.stats, ...thinWants.statsPacket } };
    const Decisions = require('../src/GameServer/Bot/Population/ColdEconomyDecision');
    const thinCard = Decisions.compact(thinWants.decision);
    const thinEconomy = Decisions.view(thinState, thinCard, { board: thinBoard });
    assert(thinIntent.worth < thin.stats.shotRecipeDemand.maxSpend, 'the current graph narrows the old investment ceiling');
    assert.equal(Decisions.preparedCardWorth(thinCard, 1805, thinState, thinEconomy.moneyPrice, .1, true), thinIntent.worth,
        'card pricing preserves the exact certified cap without a second persona error');
    assert.equal(thinEconomy.worth(1805), thinIntent.worth, 'the card economy reads that same exact monetary cap');
    const thinBid = invoke('GameServer/Bot/Economy/BuyAdPolicy').bidFor(thinState, {
        type: 'buy_craft_material', target: { itemId: 1805, amount: 1 }, intent: thinIntent,
        plan: { purpose: 'recipe', valueRate: thinIntent.valueRate }
    }, { economy: thinEconomy, board: thinBoard, town: 'Giran' });
    assert(thinBid, 'the native market can price a missing scroll for the lower-priced C series');
    assert(thinBid.price <= thinIntent.worth && thinBid.price > 10000,
        'the scroll gets a viable price within the series investment');
    const pricing = invoke('GameServer/Bot/Economy/MarketPricing');
    const bidLine = { ...thinBid, recordId: 910950, lineId: 9109500, ownerId: thin.characterId,
        storeType: 3, kind: 'buy_ad', custodyPolicy: 1, town: 'Giran', revision: 1 };
    const look = (state, card = thinCard) => {
        const ctx = pricing.traderContext(state, { economy: thinEconomy, board: thinBoard,
            preparedWorth: id => Decisions.preparedCardWorth(card, id, state, thinEconomy.moneyPrice, state.persona.understanding, true) });
        ctx.reviewReasons = new Map([[bidLine.lineId, 2]]);
        return pricing.look(state, [bidLine], ctx);
    };
    const reviewed = look(thinState);
    assert(!reviewed?.withdrawals?.length, 'the accepted card preserves the recipe bid at the next market review');
    assert(!reviewed?.reprices?.some(row => row.price > thinIntent.worth),
        'market review cannot raise the scroll above its finite investment');
    const short = { ...thinState, adena: thin.stats.shotRecipeDemand.inputCash - 1 };
    const shortLook = look(short); assert(shortLook?.withdrawals?.length, `a spent wallet releases the bid before consuming the series capital: ${JSON.stringify({shortLook,wanted:short.stats.shotRecipeDemand,cap:require('../src/GameServer/Bot/Economy/TradeIntent').shotRecipeCap(short,1805,short.adena)})}`);
    assert.equal(invoke('GameServer/Bot/Economy/BuyAdPolicy').bidFor(short, {
        type: 'buy_craft_material', target: { itemId: 1805, amount: 1 }, intent: thinIntent,
        plan: { purpose: 'recipe', valueRate: thinIntent.valueRate }
    }, { economy: thinEconomy, board: thinBoard, town: 'Giran' }), null,
    'old accepted value cannot spend the physical production capital');
    const supplier = { id: 910960, ownerId: 910961, kind: 'sell_ad', custodyPolicy: 1, storeType: 1,
        town: 'Giran', revision: 1, lines: [{ id: 9109600, lineId: 9109600, selfId: 1805,
            enchant: 0, count: 1, price: thinBid.price }] };
    const point = invoke('GameServer/World/TownRespawn').towns.giran_town;
    const request = { token: 'finite-shot-recipe-bid', actorA: thin.characterId, actorB: supplier.ownerId,
        seqA: 1, seqB: 1, town: 'Giran', point: { locX: point.locX, locY: point.locY, locZ: point.locZ },
        parties: [0, 1].map(() => ({ phase: 'cold', hotAt: 0, revision: 1, sequence: 1,
            route: { fee: 0, scroll: false, method: 'walk', durationMs: 0 } })),
        lines: [{ payer: 0, itemId: 99999991, selfId: 1805, count: 1, price: thinBid.price,
            enchant: 0, adId: supplier.id, adRevision: 1, certificate: null }] };
    const withSupplier = { ...thinInput, tables: thinInput.tables.map(table => table.name === 'board'
        ? { ...table, rows: [...table.rows, [supplier.id, rowOf(supplier)]] } : table) };
    const meeting = await probe(thinState, { ...withSupplier, meetingRequest: request });
    assert.equal(require('../src/GameServer/Bot/Economy/TradeIntent').decode(meeting.request.lines[0].certificate).itemId, 1805,
        'the same native production goal consents when a supplier answers the bid');
    const uncertified = await probe({ ...thin, stats: { ...thin.stats,
        shotRecipeDemand: { ...thin.stats.shotRecipeDemand, inputCash: undefined } } }, thinInput);
    assert(!uncertified.tradeIntents.find(row => row.itemId === 1805)?.shotRecipeInvestment,
        'legacy wants cannot raise prices until native production refreshes their capital certificate');
    const zeroState = { ...thin, stats: { ...thin.stats,
        shotRecipeDemand: { ...thin.stats.shotRecipeDemand, inputCash: 5000000 } } };
    const zeroWants = await probe(zeroState, thinInput);
    const zeroIntent = zeroWants.tradeIntents.find(row => row.itemId === 1805);
    assert.equal(zeroIntent?.worth, 0, 'current series value cannot pay the accepted capital floor');
    const zeroCard = Decisions.compact(zeroWants.decision);
    assert.equal(Decisions.preparedCardWorth(zeroCard, 1805, zeroState, thinEconomy.moneyPrice, .5, true), 0,
        'the compact card retains a confirmed zero instead of reporting unknown worth');
    assert.equal(invoke('GameServer/Bot/Economy/BuyAdPolicy').bidFor({ ...zeroState,
        stats: { ...zeroState.stats, ...zeroWants.statsPacket } }, {
        type: 'buy_craft_material', target: { itemId: 1805, amount: 1 }, intent: zeroIntent,
        plan: { purpose: 'recipe', valueRate: zeroIntent.valueRate }
    }, { economy: thinEconomy, board: thinBoard, town: 'Giran' }), null,
    'a zero investment cannot fall back to the market belief and reopen the bid');
    assert(look(zeroState, zeroCard)?.withdrawals?.length,
        'the next confirmed-zero card withdraws a previously viable recipe bid');
    counters.reset();

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
