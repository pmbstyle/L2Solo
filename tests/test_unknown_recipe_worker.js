'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const Codec = require('../src/GameServer/Bot/Economy/RecipeBookCodec');
const { rowOf } = require('../src/GameServer/AfkTrade/BoardIndex');
const probe = require('./helpers/workerEconomyDecision');
const Craft = require('../src/GameServer/Bot/Economy/WealthCraftPolicy');
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
    const result = await probe(state, { recipeEarning: true, recipes: { recipeBook: Codec.pack([]) }, tablePages: pages(records) });
    assert.equal(result.selected?.wealth?.recipeId, recipe.recipeId, 'actual worker empty-book search selects offered profitable D recipe');
    assert.deepEqual(result.selected.wealth.scroll, [9101010, 1], 'worker preserves selected public scroll authority');
    const withoutScroll = records.filter(([key]) => key !== 910101);
    const known = await probe(state, { recipeEarning: true, recipes: { recipeBook: Codec.pack([recipe.recipeId]) }, tablePages: pages(withoutScroll) });
    assert.equal(known.selected?.wealth?.recipeId, recipe.recipeId, 'full book is authoritative even with an empty public portfolio');
    assert(!known.selected.wealth.scroll, 'learned scroll is not bought twice');
    // The planner's answer per mode stands while what it reads holds: an ask of
    // another mode keeps the route rows; an action serves its step's clock only.
    const level = invoke('GameServer/Bot/Economy/CraftEligibility').craftLevelFor(state);
    const baseMp = Array.from({ length: 300 }, (_, k) => 1000 - k).find(mp => Craft.sameCraftMp(level, mp, mp + 1));
    const band = Craft.craftMpBand(level, baseMp), insideMp = baseMp + 1, outsideMp = band[3] ? band[2] + 1 : band[2];
    assert(baseMp && Number.isFinite(outsideMp), 'fixture: an MP band wider than one point');
    const crafter = { ...state, vitals: { ...state.vitals, mp: baseMp } };
    const reuse = await probe(crafter, { recipes: { recipeBook: Codec.pack([recipe.recipeId]) }, tablePages: pages(withoutScroll),
        plannerReuse: {} });
    assert.deepEqual(reuse.first, { wish: 1, action: 1 }, 'one build per mode; the step\'s second action ask joins');
    assert.deepEqual(reuse.actionAgain, reuse.action);
    assert.deepEqual(reuse.kept, { wish: 1, action: 2 },
        'the resent row keeps the rows; a finished action serves its step only');
    assert.deepEqual(reuse.keptRows, reuse.rows);
    assert.deepEqual(reuse.keptAction, reuse.action, 'the resent row gives the same action');
    // The held card's craft is prepared again only out of the band.
    const craftMp = await probe(crafter, { recipes: { recipeBook: Codec.pack([recipe.recipeId]) }, tablePages: pages(withoutScroll),
        craftMp: [[baseMp, baseMp], [baseMp, insideMp], [baseMp, outsideMp]] });
    assert.deepEqual(craftMp.out, [{ asked: [], kept: true }, { asked: [], kept: true }, { asked: ['action'], kept: false }],
        'an MP inside the band keeps the card\'s craft; out of it the action is asked');
    assert.equal(reuse.flight, 1, 'a build in flight goes on across main\'s resend of the same row');
    assert.deepEqual(reuse.echoed, reuse.flown);
    assert.equal(reuse.walkedBuilt, 1, 'the route rows are built anew when the bot\'s point moves');
    assert.equal(reuse.walkedRows.length, reuse.rows.length);
    console.log('PASS actual worker unknown recipe admission, empty book, selected source, uncapped knowledge and planner answers per mode');
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
