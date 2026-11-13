'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
const Market = invoke('GameServer/Bot/Economy/MarketCounters');
const Demand = require('../src/GameServer/Bot/Economy/ShotTradeDemand');
const Shots = require('../src/GameServer/Bot/Economy/ColdShotEconomyService');
const Policy = require('../src/GameServer/Bot/Economy/ShotCraftPolicy');
const Codec = require('../src/GameServer/Bot/Economy/RecipeBookCodec');
const probe = require('./helpers/workerEconomyDecision');
const originalBoard = Afk.boardIndex;
Market.useSpots(() => invoke('GameServer/Bot/Population/SpotProfiles').ensure());

function recheckAt(state, craft, timestamp) {
    // The worker and native check compare the same market snapshot. Elapsed
    // wall time under suite load can legitimately invalidate a marginal lot.
    const originalNow = Date.now;
    Date.now = () => timestamp;
    try { return Shots.recheck(state, craft); }
    finally { Date.now = originalNow; }
}

(async () => {
    for (const recipeId of [20, 21, 317]) {
        const recipe = Recipes.resolveByRecipeId(recipeId), timestamp = Date.now(), board = new BoardIndex();
        Afk.boardIndex = () => board;
        const state = { characterId: 910801, accountName: 'bot_pop_shot_batch', name: 'ShotSmith',
            phase: 'cold', activity: 'shopping', currentRegion: 'Giran', homeRegion: 'Giran', level: 80,
            adena: 10000000, vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 },
            inventory: Object.fromEntries(recipe.materials.map(row => [row.selfId,
                { selfId: row.selfId, amount: row.amount * 64, stackable: true }])), updatedAt: timestamp, timing: {},
            loc: { locX: 83396, locY: 147904, locZ: -3400 }, stats: { classId: 57, money: [1000, .001, 0, 0] } };
        state.persona = invoke('GameServer/Bot/AI/BotPersona').generate(state);
        const batches = [];
        const receipts = [{ quantity: 100 }, { quantity: 10000 },
            ...(recipeId === 21 ? [{ quantity: 10000, fixed: true }] : [])];
        for (const { quantity, fixed } of receipts) {
            Market.reset();
            if (fixed) {
                Market.supplyDeal(recipe.productId, quantity, 'Giran', timestamp - 600000);
                Market.supplyDeal(recipe.productId, quantity, 'Giran', timestamp - 300000);
                assert.equal(Market.itemDeals(recipe.productId).deals, 0, 'the producer starts without any peer shot sale');
            } else {
                Market.deal(recipe.productId, 100, quantity, timestamp - 600000, 12, 'Giran', 13);
                Market.deal(recipe.productId, 100, quantity, timestamp - 300000, 14, 'Giran', 15);
            }
            let rows;
            Market.publish({ register: (_name, source) => { rows = source.allRows(); }, changed: () => {} });
            const result = await probe(state, { recipeEarning: true, timestamp,
                recipes: { recipeBook: Codec.pack([recipeId]), knownShotRecipes: [recipeId] },
                tablePages: [{ tables: [
                    { name: 'board', from: null, to: 0, full: true, rows: [], removed: [], last: true },
                    { name: 'market', from: null, to: 0, full: true, rows: rows.map(row => [row[0], row]), removed: [], last: true }
                ] }] });
            const selected = Policy.unpackStep(Policy.packStep(result.selected));
            assert.equal(selected?.craft?.recipeId, recipeId, 'the actual worker chooses the known shot recipe');
            const native = recheckAt(state, selected.craft, timestamp);
            assert(native && native.expectedSold > 0, 'the selected larger quantity passes the native sale and craft recheck');
            assert(native.batches * recipe.mpCost <= state.vitals.mp, 'production remains within actual mana');
            assert(native.expectedSold <= Demand.forecast(recipe.productId, 'Giran', timestamp).applicableUnits,
                'output sales stay bounded by observed demand');
            if (quantity === 10000) {
                assert.equal(recheckAt({ ...state, vitals: { ...state.vitals, mp: recipe.mpCost } }, selected.craft, timestamp), null,
                    'the larger command is refused when its mana is no longer available');
                assert.equal(recheckAt({ ...state, inventory: { ...state.inventory,
                    [recipe.productId]: { selfId: recipe.productId, amount: 1000000, stackable: true } } }, selected.craft, timestamp), null,
                    'existing unsold output prevents another large production batch');
            }
            batches.push(native.batches);
            console.log(JSON.stringify({ recipeId, observedPurchase: quantity, fixed: !!fixed,
                batches: native.batches, output: native.batches * recipe.productCount }));
        }
        assert(batches[1] > batches[0], 'stronger observed demand produces a larger shot batch');
        assert(batches[1] >= 5, 'a stocked crafter can serve large demand beyond one or two recipe batches');
    }
    console.log('PASS shot production scales with public demand through worker, command codec and native recheck');
})().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(() => {
    Afk.boardIndex = originalBoard; Market.reset();
});
