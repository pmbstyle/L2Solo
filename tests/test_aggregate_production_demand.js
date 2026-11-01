'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
process.env.L2NODE_CONFIG_FILE = 'config/default.ini';
process.env.L2NODE_PROGRESSION_RATE = 'x1';
delete process.env.L2NODE_SHARED_CONFIG_FILE;
require('../src/Global');
invoke('GameServer/DataCache').init();
const { BoardIndex, rowOf } = require('../src/GameServer/AfkTrade/BoardIndex');
const Policy = require('../src/GameServer/Bot/Economy/ShotCraftPolicy');
const Shots = require('../src/GameServer/Bot/Economy/ColdShotEconomyService');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const Market = invoke('GameServer/Bot/Economy/MarketCounters');
const Codec = require('../src/GameServer/Bot/Economy/RecipeBookCodec');
const Demand = require('../src/GameServer/Bot/Economy/MarketDemand');
const Price = require('../src/GameServer/Bot/Economy/PriceDecision');
const probe = require('./helpers/workerEconomyDecision');
const originalBoard = Afk.boardIndex;

(async () => {
    Market.reset();
    const timestamp = Date.now(), board = new BoardIndex();
    const state = { characterId: 916001, accountName: 'bot_pop_aggregate_production', name: 'AggregateSmith',
        phase: 'cold', activity: 'shopping', currentRegion: 'Giran', homeRegion: 'Giran', level: 49,
        adena: 2000000, vitals: { hp: 1000, maxHp: 1000, mp: 420, maxMp: 1000 }, inventory: {},
        updatedAt: timestamp, timing: {}, loc: { locX: 83396, locY: 147904, locZ: -3400 },
        stats: { classId: 57, money: [1000, .001, 0, 0] } };
    state.persona = invoke('GameServer/Bot/AI/BotPersona').generate(state);
    const record = (id, owner, side, lines, custody = 1) => ({ id, ownerId: owner, storeType: side,
        kind: custody ? 'buy_ad' : 'shop', custodyPolicy: custody, town: 'Giran', revision: 1,
        lines: lines.map((line, at) => ({ id: id * 10 + at, lineId: id * 10 + at, enchant: 0, ...line })) });
    const buyers = Array.from({ length: 40 }, (_, at) => record(917000 + at, 918000 + at, 3,
        [{ selfId: 1464, count: 1000, price: 700 }]));
    const supplier = record(919000, 919001, 1, [{ selfId: 1805, count: 1, price: 30000 },
        { selfId: 2495, count: 1, price: 121162 }, { selfId: 1785, count: 100, price: 1 }], 0);
    const rows = [...buyers, supplier];
    rows.forEach(row => board.put(row)); Afk.boardIndex = () => board;
    const options = { timestamp, recipeEarning: true, recipes: { recipeBook: Codec.pack([20]), knownShotRecipes: [20] },
        boardRows: rows.map(row => [row.id, rowOf(row)]) };
    assert.equal(Market.itemDeals(1464).deals, 0);
    const selected = (await probe(state, options)).selected;
    assert.equal(selected?.recipeTarget, 21, 'actual worker invests in C production using several unbacked buyers');
    const packed = Policy.packStep(selected), step = Policy.unpackStep(packed).recipeRoute;
    assert(Buffer.byteLength(JSON.stringify(packed))
        <= require('../src/GameServer/Bot/Population/ColdEconomyDecision').MAX_SHOT_PAYLOAD_BYTES,
        'the public demand hash fits the existing command budget without sending its price curve');
    assert.equal(step.exit[0], -3, 'compact command identifies public interest separately from trade history');
    const candidate = Shots.recheck(state, step);
    assert(candidate, 'native executor reads the same aggregate evidence and price curve');
    assert(candidate.batches > 1 && candidate.batches * 70 <= state.vitals.mp);
    assert.equal(candidate.exit.type, 'listing');
    assert.equal(candidate.exit.forecast.origin, 'public_buy_interest');
    assert.equal(candidate.exit.forecast.guaranteed, false);
    assert.equal(candidate.repeatable, false);
    assert(!Number.isFinite(candidate.incomePerHour), 'public interest never becomes perpetual income');
    assert(candidate.expectedSold <= candidate.exit.willingUnits);
    assert.equal(Market.itemDeals(1464).deals, 0, 'the planner invents no completed sales');
    const Pricing = require('../src/GameServer/Bot/Economy/MarketPricing');
    const trip = () => 0; trip.details = () => ({ known: true, hours: 0, fees: 0 });
    const saleContext = Pricing.traderContext(state, { board, timestamp, tripCost: trip,
        economy: { hourAdena: 1000, moneyPrice: .001, persona: state.persona, worth: () => 0 } });
    const stock = { selfId: 1464, count: candidate.batches * 476, enchant: 0 };
    const publication = Pricing.disposition(stock, saleContext, { town: 'Giran', rollKey: ['aggregate-output'] });
    assert.equal(publication.action, 'list', 'ordinary publication values the produced lot using the same public demand');
    assert.equal(publication.priced.market.demand.origin, 'public_buy_interest');
    let townDecision;
    const town = require('../src/GameServer/Bot/Economy/MarketTownPolicy').shopTown(state,
        [{ ...stock, price: publication.priced.ask.price }], { context: saleContext, timestamp,
            onDecision: value => { townDecision = value; } });
    assert.equal(town, 'Giran');
    assert.equal(townDecision.reason, 'supported_item_forecast', 'the sale town has actual aggregate support');
    assert.equal(Shots.recheck({ ...state, adena: 0 }, step), null, 'projected sales cannot fund the input cash');
    assert.equal(Shots.recheck({ ...state, inventory: { 1464: { selfId: 1464, amount: 100000 } } }, step), null,
        'unsold own output is counted before another production lot');
    const revised = { ...buyers[0], revision: 2, lines: [{ ...buyers[0].lines[0], count: 1 }] };
    board.put(revised);
    assert(Shots.recheck(state, step), 'an unrelated buyer update cannot cancel a lot the fresh demand still supports');
    board.put(buyers[0]);
    buyers.forEach(row => board.put({ ...row, revision: 2,
        lines: row.lines.map(line => ({ ...line, price: 1 })) }));
    assert.equal(Shots.recheck(state, step), null, 'fresh demand below a profitable ask cannot support the old lot');
    buyers.forEach(row => board.put(row));
    const rival = record(919002, 919003, 1, [{ selfId: 1464, count: 100000, price: 1 }], 0);
    board.put(rival);
    assert.equal(Shots.recheck(state, step), null, 'cheaper physical supply competes for the same buyers');
    board.remove(rival.id);
    buyers.forEach(row => board.remove(row.id));
    assert.equal(Shots.recheck(state, step), null, 'withdrawn ads cannot finance a stale factory');
    const duplicates = buyers.map(row => ({ ...row, ownerId: buyers[0].ownerId }));
    const duplicatePlan = await probe(state, { ...options,
        boardRows: [...duplicates, supplier].map(row => [row.id, rowOf(row)]) });
    assert.equal(duplicatePlan.selected, null, 'forty copies of one buyer are not forty customers');
    // The aggregate exit is shared by ordinary dwarven production too.
    board.clear();
    const equipment = invoke('GameServer/Items/C4RecipeItems').resolveByRecipeId(79);
    const gearBuyers = buyers.map(row => ({ ...row,
        lines: row.lines.map(line => ({ ...line, selfId: equipment.productId, count: 1, price: 900000 })) }));
    const gearSupplier = record(922000, 922001, 1, equipment.materials.map(row =>
        ({ selfId: row.selfId, count: row.amount * 3, price: 1 })), 0);
    const gearRows = [...gearBuyers, gearSupplier]; gearRows.forEach(row => board.put(row));
    const gearDecision = await probe(state, { ...options, recipes: { recipeBook: Codec.pack([79]) },
        boardRows: gearRows.map(row => [row.id, rowOf(row)]) });
    const gearStep = Policy.unpackStep(Policy.packStep(gearDecision.selected)).wealth;
    assert.equal(gearStep?.recipeId, 79);
    assert.equal(gearStep.exit[0], -3);
    assert(gearStep.batches > 1, 'several equipment buyers support a bounded multi-batch production lot');
    const Wealth = require('../src/GameServer/Bot/Economy/ColdWealthCraftService');
    assert(Wealth.recheck(state, gearStep, [{ recipeId: 79 }]), 'ordinary executor accepts the aggregate exit');
    gearBuyers.forEach(row => board.remove(row.id));
    assert.equal(Wealth.recheck(state, gearStep, [{ recipeId: 79 }]), null);
    board.clear();
    const protectedState = { ...state, inventory: { [equipment.productId]: {
        selfId: equipment.productId, amount: 2, equippedCount: 1, reservedAmount: 1 } } };
    const limitedBuyers = gearBuyers.slice(0, 2).map(row => ({ ...row, custodyPolicy: 0, kind: 'shop' }));
    const protectedRows = [...limitedBuyers, gearSupplier]; protectedRows.forEach(row => board.put(row));
    const protectedDecision = await probe(protectedState, { ...options, recipes: { recipeBook: Codec.pack([79]) },
        boardRows: protectedRows.map(row => [row.id, rowOf(row)]) });
    const protectedStep = Policy.unpackStep(Policy.packStep(protectedDecision.selected)).wealth;
    assert.equal(protectedStep?.exit[0], -3);
    assert.equal(protectedStep.batches, 1, 'one free item leaves one buyer for a newly produced item');
    const protectedCandidate = Wealth.recheck(protectedState, protectedStep, [{ recipeId: 79 }]);
    assert(protectedCandidate, 'main and worker exclude equipped/protected output from unsold stock');
    assert.equal(protectedCandidate.expectedSold, 1);
    assert.equal(Wealth.recheck({ ...protectedState, inventory: { [equipment.productId]: {
        selfId: equipment.productId, amount: 2 } } }, protectedStep, [{ recipeId: 79 }]), null,
    'two genuinely free items already fill both buyers before a new lot');
    // History and today's requests may describe the same customers. At one
    // price they remain alternative finite forecasts, never summed.
    board.clear();
    [record(920001, 921001, 3, [{ selfId: 1464, count: 80, price: 700 }], 0),
        record(920002, 921002, 3, [{ selfId: 1464, count: 80, price: 700 }], 0)].forEach(row => board.put(row));
    const Flow = require('../src/GameServer/Bot/Economy/MarketTradeDemand');
    Flow.deal(1464, 100, 'Giran', timestamp); Flow.deal(1464, 100, 'Giran', timestamp);
    const demand = Demand.forecast(1464, 'Giran', { board, ownerId: state.characterId, timestamp });
    assert.equal(demand.alternatives.length, 2);
    const market = Price.marketFor(1464, { board, town: 'Giran', timestamp, demand, units: 1000 });
    const belief = { mu: Math.log(700), K: 1 }, trader = Price.traderOf(state.persona);
    const alternatives = Price.demandAtPrice(belief, market, trader, 500);
    assert.equal(alternatives.length, 2);
    assert.equal(Math.max(...alternatives.map(row => row.willingUnits)), 160);
    assert(Price.chooseAsk(belief, market, trader, ['no-double-count']).sold <= 160);
    console.log('PASS aggregate C startup, native command, finite uncertainty, deduplication, supply and stale-demand checks');
})().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(() => {
    Afk.boardIndex = originalBoard; Market.reset();
});
