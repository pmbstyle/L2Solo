'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
process.env.L2NODE_CONFIG_FILE = 'config/default.ini';
process.env.L2NODE_PROGRESSION_RATE = 'x1';
delete process.env.L2NODE_SHARED_CONFIG_FILE;
require('../src/Global');
invoke('GameServer/DataCache').init();
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const { BoardIndex, rowOf } = require('../src/GameServer/AfkTrade/BoardIndex');
const Policy = require('../src/GameServer/Bot/Economy/ShotCraftPolicy');
const Shots = require('../src/GameServer/Bot/Economy/ColdShotEconomyService');
const Codec = require('../src/GameServer/Bot/Economy/RecipeBookCodec');
const Market = invoke('GameServer/Bot/Economy/MarketCounters');
const probe = require('./helpers/workerEconomyDecision');
const originalBoard = Afk.boardIndex;

(async () => {
    Market.reset();
    const recipe = Recipes.resolveByRecipeId(21), timestamp = Date.now();
    const state = { characterId: 910851, accountName: 'bot_pop_crystal_residual', name: 'CrystalSmith',
        phase: 'cold', activity: 'shopping', currentRegion: 'Giran', homeRegion: 'Giran', level: 49,
        adena: 1000000, vitals: { hp: 1000, maxHp: 1000, mp: recipe.mpCost, maxMp: 1000 },
        inventory: {}, updatedAt: timestamp, timing: {},
        loc: { locX: 83396, locY: 147904, locZ: -3400 }, stats: { classId: 57, money: [1000, .001, 0, 0] } };
    state.persona = invoke('GameServer/Bot/AI/BotPersona').generate(state);
    const board = new BoardIndex(), records = [
        { id: 910860, ownerId: 910861, storeType: 3, kind: 'shop', custodyPolicy: 0,
            town: 'Giran', status: 'active', revision: 1,
            lines: [{ lineId: 9108600, selfId: recipe.productId, count: recipe.productCount, price: 500 }] },
        { id: 910870, ownerId: 910871, storeType: 1, kind: 'shop', custodyPolicy: 0,
            town: 'Giran', status: 'active', revision: 1, lines: [
                { lineId: 9108700, selfId: recipe.recipeItemId, count: 1, price: 30000 },
                { lineId: 9108701, selfId: 2495, count: 1, price: 121162 },
                { lineId: 9108702, selfId: 1785, count: 15, price: 1 } ] }
    ];
    for (const record of records) {
        for (const line of record.lines) line.id = line.lineId;
        board.put(record);
    }
    Afk.boardIndex = () => board;
    const input = { timestamp, recipeEarning: true, recipes: { recipeBook: Codec.pack([20]), knownShotRecipes: [20] },
        boardRows: records.map(record => [record.id, rowOf(record)]) };
    const result = await probe(state, input);
    const selected = Policy.unpackStep(Policy.packStep(result.selected));
    assert.equal(selected?.recipeTarget, 21, 'the actual worker can bootstrap C shots without held crystals or prior sales');
    const route = Shots.recheck(state, selected.recipeRoute);
    assert(route, 'the selected route passes the native executor recheck');
    assert.equal(route.batches, 1);
    assert.equal(route.gear.selfId, 2495);
    assert.equal(route.gear.crystals, 53);
    assert.equal(route.basket.cashCost, 121162 + 15, 'the whole physical shield and ore must still be funded');
    assert.equal(route.basket.residualValue, 52 * 1500, 'only unused crystals retain their NPC liquidation value');
    assert(route.profit > 30000, 'the finite production route covers its one-time recipe purchase');
    assert.equal(Market.itemDeals(recipe.productId).deals, 0, 'valuation invents no shot trade history');
    assert.equal(Shots.recheck({ ...state, adena: route.basket.cashCost - 1 }, selected.recipeRoute), null,
        'retained crystals cannot pay the up-front input purchase');
    board.remove(910860);
    assert.equal(Shots.recheck(state, selected.recipeRoute), null, 'the selected shot buyer must still exist');
    board.put(records[0]);
    const crystals = { id: 910880, ownerId: 910881, storeType: 1, kind: 'shop', custodyPolicy: 0,
        town: 'Giran', status: 'active', revision: 1,
        lines: [{ id: 9108800, lineId: 9108800, selfId: 1459, count: 1, price: 1000 }] };
    board.put(crystals);
    const direct = await probe(state, { ...input, boardRows: [...records, crystals].map(record => [record.id, rowOf(record)]) });
    const directRoute = Shots.recheck(state, Policy.unpackStep(Policy.packStep(direct.selected)).recipeRoute);
    assert(directRoute);
    assert.equal(directRoute.gear.source, 'crystals');
    assert.equal(directRoute.basket.residualValue, 0, 'an exact crystal purchase produces no surplus to value');
    const cheapGear = { ...records[1], revision: 2, lines: records[1].lines.map(line =>
        line.selfId === 2495 ? { ...line, price: 1000 } : line) };
    const competition = { ...crystals, id: 910890, ownerId: 910891,
        lines: [{ id: 9108900, selfId: recipe.productId, count: recipe.productCount, price: 1 }] };
    const noOutput = await probe(state, { ...input,
        boardRows: [records[0], cheapGear, competition].map(record => [record.id, rowOf(record)]) });
    assert.equal(noOutput.selected, null,
        'profitable leftover crystals do not justify shot production whose entire output has no sale or use');
    console.log('PASS native C-shot bootstrap values unused crystals without reducing funding or inventing demand');
})().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(() => {
    Afk.boardIndex = originalBoard;
    Market.reset();
});
