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
const Codec = require('../src/GameServer/Bot/Economy/RecipeBookCodec');
const probe = require('./helpers/workerEconomyDecision');
const originalBoard = Afk.boardIndex;

(async () => {
    const now = Date.now(), board = new BoardIndex(), records = [];
    const state = { characterId: 910901, accountName: 'bot_pop_backed_production', name: 'BackedSmith',
        phase: 'cold', activity: 'shopping', currentRegion: 'Giran', homeRegion: 'Giran', level: 49,
        adena: 1000000, vitals: { hp: 1000, maxHp: 1000, mp: 140, maxMp: 1000 }, inventory: {},
        updatedAt: now, timing: {}, loc: { locX: 83396, locY: 147904, locZ: -3400 },
        stats: { classId: 57, money: [1000, .001, 0, 0] } };
    state.persona = invoke('GameServer/Bot/AI/BotPersona').generate(state);
    const record = (id, side, custody, lines) => ({ id, ownerId: id + 100, storeType: side,
        kind: custody ? 'buy_ad' : 'shop', custodyPolicy: custody, town: 'Giran', revision: 1,
        status: 'active', lines: lines.map((line, at) => ({ id: id * 10 + at, lineId: id * 10 + at, enchant: 0, ...line })) });
    for (let i = 0; i < 40; i++) records.push(record(911000 + i, 3, 1,
        [{ selfId: 1464, count: 1, price: 1000000000 + i }]));
    const buyer = record(912000, 3, 0, [{ selfId: 1464, count: 962, price: 500 }]);
    const supplier = record(912001, 1, 0, [
        { selfId: 1805, count: 1, price: 30000 }, { selfId: 2495, count: 1, price: 121162 },
        { selfId: 1785, count: 30, price: 1 }]);
    records.push(buyer, supplier);
    for (const row of records) board.put(row);
    Afk.boardIndex = () => board;
    const options = { timestamp: now, recipeEarning: true,
        recipes: { recipeBook: Codec.pack([20]), knownShotRecipes: [20] },
        boardRows: records.map(row => [row.id, rowOf(row)]) };
    const decision = await probe(state, options);
    assert.equal(decision.selected?.recipeTarget, 21,
        'native worker discovers a C-shot investment behind forty unfunded higher bids');
    const selected = Policy.unpackStep(Policy.packStep(decision.selected)).recipeRoute;
    assert.equal(selected.exit[1], buyer.lines[0].id, 'compact command retains the selected backed buyer');
    const candidate = Shots.recheck(state, selected);
    assert(candidate, 'native executor resolves the same bounded buyer view');
    assert.equal(candidate.batches, 2);
    assert.equal(candidate.expectedSold, 952);
    assert.equal(candidate.exit.conditional, false);
    assert.equal(candidate.gear.selfId, 2495);
    assert.equal(candidate.basket.residualValue, 51 * 1500);
    board.put(record(913000, 3, 1, [{ selfId: 1464, count: 1, price: 2000000000 }]));
    assert(Shots.recheck(state, selected), 'more unfunded ads cannot push the selected shop out of view');
    assert.equal(Shots.recheck({ ...state, adena: 0 }, selected), null, 'a stale funded plan cannot spend an empty wallet');
    board.put({ ...buyer, revision: 2, lines: [{ ...buyer.lines[0], price: 1 }] });
    assert.equal(Shots.recheck(state, selected), null, 'buyer repricing invalidates the old command');
    board.put(buyer);
    board.remove(buyer.id);
    assert.equal(Shots.recheck(state, selected), null, 'a closed shop cannot support old production');
    const missingBuyer = await probe(state, { ...options,
        boardRows: records.filter(row => row.id !== buyer.id).map(row => [row.id, rowOf(row)]) });
    assert.equal(missingBuyer.selected, null, 'unfunded high prices alone do not create a profitable C factory');
    const Market = require('../src/GameServer/Bot/Economy/ColdMarketService');
    const ore = board.records.get(supplier.id).find(line => line.selfId === 1785);
    const sourcePlan = { selfId: 1785, town: 'Giran', cost: 30, landed: 30, npc: 0,
        lines: [{ line: ore, count: 30, price: 1 }] };
    const inputTerms = { sourcePlan, npc: false, money: 30, maxPrice: 1, quoteDepth: 5, refreshSource: true };
    const afterShield = { ...supplier, revision: 2, lines: supplier.lines.filter(line => line.selfId !== 2495) };
    board.put(afterShield);
    const refreshed = Market.planPurchase(state, 1785, 30, inputTerms);
    assert(refreshed?.whole, 'an earlier shield purchase does not strand the remaining ore in the same shop');
    assert.equal(refreshed.lines[0].line.revision, 2);
    assert.equal(Market.planPurchase(state, 1785, 30, { ...inputTerms, refreshSource: false }).lines[0].line.revision, 1,
        'other callers keep strict source-plan authority unless they opt into a fresh read');
    board.put({ ...afterShield, revision: 3, lines: afterShield.lines.map(line =>
        line.selfId === 1785 ? { ...line, price: 2 } : line) });
    assert.equal(Market.planPurchase(state, 1785, 30, inputTerms), null, 'refresh cannot accept a different price');
    board.put({ ...afterShield, revision: 4, custodyPolicy: 1, kind: 'sell_ad' });
    assert.equal(Market.planPurchase(state, 1785, 30, inputTerms), null, 'refresh cannot replace physical escrow with future supply');
    board.put(afterShield);
    assert.equal(Market.planPurchase(state, 1785, 30, { ...inputTerms, money: 0 }), null,
        'the refreshed input still requires current cash');
    board.remove(supplier.id);
    assert.equal(Market.planPurchase(state, 1785, 30, inputTerms), null, 'closed suppliers cannot be refreshed');
    board.clear();
    const equipmentRecipe = invoke('GameServer/Items/C4RecipeItems').resolveByRecipeId(79);
    const equipmentRows = [];
    for (let i = 0; i < 20; i++) equipmentRows.push(record(914000 + i, 3, 1,
        [{ selfId: equipmentRecipe.productId, count: 1, price: 1000000000 + i }]));
    const equipmentBuyer = record(915000, 3, 0,
        [{ selfId: equipmentRecipe.productId, count: 1, price: 900000000 }]);
    equipmentRows.push(equipmentBuyer, record(915001, 1, 0,
        equipmentRecipe.materials.map(row => ({ selfId: row.selfId, count: row.amount, price: 1 }))));
    for (const row of equipmentRows) board.put(row);
    const equipmentDecision = await probe(state, { ...options,
        recipes: { recipeBook: Codec.pack([79]) }, boardRows: equipmentRows.map(row => [row.id, rowOf(row)]) });
    const equipmentStep = Policy.unpackStep(Policy.packStep(equipmentDecision.selected)).wealth;
    assert.equal(equipmentStep?.recipeId, 79, 'the shared backed view also serves ordinary equipment production');
    assert.equal(equipmentStep.exit[1], equipmentBuyer.lines[0].id);
    assert(require('../src/GameServer/Bot/Economy/ColdWealthCraftService').recheck(state, equipmentStep, [{ recipeId: 79 }]),
        'the ordinary craft executor resolves the compact backed buyer too');
    console.log('PASS native backed C production discovery, compact authority, funding and buyer invalidation');
})().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(() => { Afk.boardIndex = originalBoard; });
