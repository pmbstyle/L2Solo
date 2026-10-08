'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('unknown-recipe-native');
require('../src/Global');
fixture.assertConfigured(options.default);
const Database = invoke('Database'), Data = invoke('GameServer/DataCache');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const Service = invoke('GameServer/Bot/Economy/ColdWealthCraftService');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const Native = require('./helpers/nativeMarketFixture');
Data.init();
async function seed(id, money) {
    const account = 'bot_recipe_native_' + id;
    await Native.character(Database, id, 'RecipeNative' + id, account);
    await Database.execute(['UPDATE characters SET classId=57,level=60,maxMp=1000,mp=1000 WHERE id=?', [id]]);
    await Database.setSkill({ selfId: 172, name: 'Create Item', level: 9 }, id);
    await Database.setItem(id, { selfId: 57, name: 'Adena', amount: money, stackable: true });
    await Life.upsertState({ characterId: id, accountName: account, name: 'RecipeNative' + id, level: 60,
        exp: 0, sp: 0, adena: money, phase: 'cold', activity: 'shopping', homeRegion: 'Giran', currentRegion: 'Giran',
        loc: { locX: 83396, locY: 147904, locZ: -3400 }, vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 },
        stats: { classId: 57, money: [1000, .001, 0, 0] }, inventory: { 57: { selfId: 57, amount: money } },
        simulation: { ownerId: 'legacy_main', revision: 0 }, timing: {}, updatedAt: Date.now() }, 'recipe_fixture');
}
(async () => {
    Database.init(); invoke('GameServer/World/World').user = { sessions: [], revision: 0 };
    await seed(1, 1000000); await seed(2, 1000000); await seed(3, 1000000);
    const recipe = Recipes.resolveByRecipeId(79);
    // The producer already wears stronger armour; a useful personal upgrade
    // must retain its existing protection instead of being sold by this test.
    const armour = Data.items.find(item => String(item.etc?.rank) === 's' && Number(item.etc?.slot) === 10);
    assert(armour);
    await Database.setItem(1, { selfId: armour.selfId, name: armour.template.name, amount: 1, equipped: true, slot: 10 });
    for (const row of recipe.materials) await Database.setItem(1, { selfId: row.selfId, name: 'Material', amount: row.amount });
    const scroll = await Database.setItem(2, { selfId: recipe.recipeItemId, name: 'Recipe', amount: 2, stackable: true });
    const ask = await Database.createAfkTradeShop(2, { storeType: 1, kind: 'shop', town: 'Giran', title: 'Recipe',
        lines: [{ objectId: scroll.insertId, selfId: recipe.recipeItemId, name: 'Recipe', count: 2, price: 10, stackable: true }] });
    const bid = await Database.createAfkTradeShop(3, { storeType: 3, kind: 'shop', town: 'Giran', title: 'D gear',
        lines: [{ selfId: recipe.productId, name: 'D gear', count: 1, price: 1000000 }] });
    Afk.refreshRecord(ask.shop); Afk.refreshRecord(bid.shop);
    let state = await Life.refreshInventory(Life.cachedState(1));
    const board = Afk.boardIndex(), offer = board.list(recipe.recipeItemId, 1)[0], buyer = board.list(recipe.productId, 3)[0];
    const step = { recipeId: recipe.recipeId, batches: 1, scroll: [offer.lineId, offer.revision],
        exit: [buyer.recordId, buyer.lineId, buyer.price, buyer.revision] };
    const opportunity = Service.recheck(state, step, await Database.fetchCharacterRecipes(1));
    assert(opportunity?.learning);
    const before = Native.amount(await Database.fetchItems(1), 57);
    const result = await Service.execute(state, opportunity);
    assert(result.crafted, result.reason); assert(result.sold, result.reason);
    assert.equal(result.spent, 10); assert.equal(result.revenue, 1000000);
    assert((await Database.fetchCharacterRecipes(1)).some(row => row.recipeId === recipe.recipeId));
    assert.equal(Native.amount(await Database.fetchItems(1), recipe.recipeItemId), 0, 'learning consumed exactly the purchased scroll');
    assert.equal(Native.amount(await Database.fetchItems(1), 57), before - 10 + 1000000, 'actual purse paid recipe once and received actual gear sale');
    assert.equal(Native.amount(await Database.fetchItems(3), recipe.productId), recipe.productCount);
    state = result.state;
    assert((await Service.acquireRecipe(state, opportunity)).ready);
    assert.equal(Native.amount(await Database.fetchItems(1), 57), before - 10 + 1000000, 'learned recipe re-entry cannot charge again');
    console.log('PASS native SQLite ordinary recipe purchase→learning→craft→sale, physical stock/purse and no duplicate acquisition');
})().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(async () => {
    await Database.close(); fs.rmSync(fixture.directory, { recursive: true, force: true });
});
