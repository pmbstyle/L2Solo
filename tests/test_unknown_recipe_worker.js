'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const Codec = require('../src/GameServer/Bot/Economy/RecipeBookCodec');
const { rowOf } = require('../src/GameServer/AfkTrade/BoardIndex');
const probe = require('./helpers/workerEconomyDecision');
const recipe = Recipes.resolveByRecipeId(79);
const state = { characterId: 910001, accountName: 'bot_pop_recipe_test', name: 'RecipeSmith', phase: 'cold',
    activity: 'shopping', currentRegion: 'Giran', homeRegion: 'Giran', level: 60, adena: 1000000,
    vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 }, inventory: {}, updatedAt: Date.now(), timing: {},
    loc: { locX: 83396, locY: 147904, locZ: -3400 }, stats: { classId: 57, workshop: { entries: [] }, money: [1000, .001, 0, 0] } };
let id = 910100;
const records = [];
function record(selfId, side, price, count) {
    const key = id++;
    records.push([key, rowOf({ id: key, ownerId: key + 100, storeType: side, kind: 'shop', status: 'active',
        town: 'Giran', revision: 1, lines: [{ id: key * 10, selfId, count, price, enchant: 0 }] })]);
}
record(recipe.productId, 3, 100000, 1); record(recipe.recipeItemId, 1, 10, 1);
for (const row of recipe.materials) record(row.selfId, 1, 1, row.amount);
const pages = rows => [{ tables: [{ name: 'board', from: null, to: 0, full: true, rows, removed: [], last: true },
    { name: 'market', from: null, to: 0, full: true, rows: [], removed: [], last: true }] }];
(async () => {
    const result = await probe(state, { recipeEarning: true, context: { recipeBook: Codec.pack([]) }, tablePages: pages(records) });
    assert.equal(result.selected?.wealth?.recipeId, recipe.recipeId, 'actual worker empty-book search selects offered profitable D recipe');
    assert.deepEqual(result.selected.wealth.scroll, [9101010, 1], 'worker preserves selected public scroll authority');
    const withoutScroll = records.filter(([key]) => key !== 910101);
    const known = await probe(state, { recipeEarning: true, context: { recipeBook: Codec.pack([recipe.recipeId]) }, tablePages: pages(withoutScroll) });
    assert.equal(known.selected?.wealth?.recipeId, recipe.recipeId, 'full book is authoritative even with an empty public portfolio');
    assert(!known.selected.wealth.scroll, 'learned scroll is not bought twice');
    console.log('PASS actual worker unknown recipe admission, empty book, selected source and uncapped knowledge');
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
