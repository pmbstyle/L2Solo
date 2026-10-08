'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Database = invoke('Database');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Market = invoke('GameServer/Bot/Economy/ColdMarketService');
const Service = invoke('GameServer/Bot/Economy/ColdWealthCraftService');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const Shots = invoke('GameServer/Bot/Economy/ShotCraftPolicy');
const recipe = Recipes.resolveByRecipeId(79), board = Afk.boardIndex();
const state = { characterId: 900003, phase: 'cold', activity: 'shopping', currentRegion: 'Giran', level: 60,
    adena: 1000000, vitals: { mp: 1000 }, inventory: {}, loc: { locX: 83396, locY: 147904, locZ: -3400 },
    stats: { classId: 57, money: [1000, .001, 0, 0] } };
let book = [], buys = 0, learns = 0, travel = false, refuseLearning = false;
const originals = { book: Database.fetchCharacterRecipes, acquire: Market.acquire, learn: Life.learnCraftableRecipes };
function row(id, selfId, storeType, price, count) {
    board.put({ id, ownerId: id + 1, kind: 'shop', storeType, status: 'active', town: 'Giran', revision: 1,
        locX: 0, locY: 0, locZ: 0, appearance: {}, lines: [{ lineId: id * 10, selfId, count, price, enchant: 0 }] });
}
row(980001, recipe.productId, 3, 100000, 3);
row(980002, recipe.recipeItemId, 1, 10, 1);
let id = 980003;
for (const material of recipe.materials) row(id++, material.selfId, 1, 1, material.amount * 3);
const scroll = board.list(recipe.recipeItemId, 1)[0], buyer = board.list(recipe.productId, 3)[0];
const step = { recipeId: recipe.recipeId, batches: 1, exit: [buyer.recordId, buyer.lineId, buyer.price, buyer.revision],
    scroll: [scroll.lineId, scroll.revision] };
const packed = Shots.packStep({ wealth: step });
assert(Buffer.byteLength(JSON.stringify(packed)) <= 128);
assert.deepEqual(Shots.unpackStep(packed).wealth.scroll, step.scroll);
assert.deepEqual(Shots.unpackStep(Shots.packStep({ wealth: { recipeId: recipe.recipeId, batches: 1, scroll: [-1] } })),
    { wealth: { recipeId: recipe.recipeId, batches: 1, scroll: [-1] } });
const opportunity = Service.recheck(state, Shots.unpackStep(packed).wealth, []);
assert(opportunity?.learning, 'native recheck supports a funded unknown recipe');
assert.equal(Service.recheck(state, { ...step, scroll: [scroll.lineId, scroll.revision + 1] }, []), null,
    'changed scroll authority rejects before spending');
assert(!Service.recheck(state, { ...step, scroll: [-1] }, []), 'absent owned scroll is unavailable');
assert(Service.recheck(state, step, [{ recipeId: recipe.recipeId }])?.learning === false,
    'authoritative knowledge avoids duplicate acquisition');
Database.fetchCharacterRecipes = async () => book;
Market.acquire = async (current, itemId, amount, terms) => {
    buys++; assert.equal(itemId, recipe.recipeItemId); assert.equal(amount, 1); assert.equal(terms.npc, false);
    assert.equal(terms.sourcePlan.cost, 10);
    if (travel) return { state: { ...current, activity: 'traveling', stats: { ...current.stats, marketErrand: { town: 'Giran' } } }, traveling: true, spent: 0 };
    return { state: { ...current, adena: current.adena - 10, inventory: { [itemId]: { selfId: itemId, amount: 1 } } }, spent: 10, bought: true };
};
Life.learnCraftableRecipes = async (current, { recipeIds }) => {
    learns++; assert.deepEqual(recipeIds, [recipe.recipeId]);
    if (!refuseLearning) book = [{ recipeId: recipe.recipeId }];
    return { ...current, inventory: {} };
};
(async () => {
    const result = await Service.acquireRecipe(state, opportunity);
    assert(result.ready); assert.equal(result.spent, 10); assert.equal(buys, 1); assert.equal(learns, 1);
    assert((await Service.acquireRecipe(result.state, opportunity)).ready);
    assert.equal(buys, 1, 'learned recipe is never repurchased on re-entry'); assert.equal(learns, 1);
    book = []; travel = true;
    const moving = await Service.acquireRecipe(state, opportunity);
    assert(!moving.ready); assert.equal(moving.reason, 'buying_trip'); assert.equal(learns, 1, 'travelling cannot learn or craft');
    travel = false; refuseLearning = true;
    const refused = await Service.acquireRecipe(state, opportunity);
    assert(!refused.ready); assert.equal(refused.reason, 'recipe_not_learned', 'absence from authoritative book blocks production');
    book = []; refuseLearning = false;
    const owned = await Service.acquireRecipe({ ...state, inventory: { [recipe.recipeItemId]: { selfId: recipe.recipeItemId, amount: 1 } } }, opportunity);
    assert(owned.ready); assert.equal(buys, 3, 'owned scroll learned without another purchase');
    console.log('PASS ordinary native recipe recheck, exact source, compact step, purchase/learn ordering, travel and re-entry');
})().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(() => {
    Database.fetchCharacterRecipes = originals.book; Market.acquire = originals.acquire; Life.learnCraftableRecipes = originals.learn;
});
