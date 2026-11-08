'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
process.env.L2NODE_CONFIG_FILE = 'config/default.ini';
process.env.L2NODE_PROGRESSION_RATE = 'x50';
delete process.env.L2NODE_SHARED_CONFIG_FILE;
require('../src/Global');
const Data = invoke('GameServer/DataCache');
Data.init();
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const Templates = invoke('GameServer/Item/ItemTemplateIndex');
const Configs = invoke('GameServer/Bot/MerchantStoreConfigs');
const Source = invoke('GameServer/Bot/Population/ColdOccupationSources');
const Shots = invoke('GameServer/Bot/Economy/ColdShotEconomyService');
const Codec = require('../src/GameServer/Bot/Economy/RecipeBookCodec');
const { BoardIndex, rowOf } = require('../src/GameServer/AfkTrade/BoardIndex');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const Market = invoke('GameServer/Bot/Economy/MarketCounters');
const probe = require('./helpers/workerEconomyDecision');
const originalBoard = Afk.boardIndex;

(async () => {
    Source.initialise();
    for (const [name, store] of Object.entries(Configs)) {
        assert(store.items.length > 0, `${name} has an actual assortment`);
        if (store.storeType !== 3) continue;
        for (const line of store.items) {
            const item = Templates.find(Data.items, line.selfId);
            if (item?.template?.kind !== 'Other.Material') continue;
            assert.equal(Recipes.resolveByProductId(line.selfId), null,
                `${name} cannot provide guaranteed demand for ${item.template.name}`);
        }
    }
    for (const id of [1864, 1865, 1866, 1867, 1868, 1869, 1870, 1871, 1872, 1873, 1874, 1875]) {
        assert(Source.fixedBuyerOffersFor(id).length > 0, `raw material ${id} retains permanent buyers`);
    }
    for (const recipe of Recipes.nativeSource().rows) {
        if (Templates.find(Data.items, recipe.productId)?.template?.kind !== 'Other.Material') continue;
        assert.equal(Source.fixedBuyerOffersFor(recipe.productId).length, 0,
            `the worker has no permanent exit for crafted material ${recipe.productId}`);
    }
    const timestamp = Date.now(), board = new BoardIndex();
    Afk.boardIndex = () => board;
    Market.reset();
    const material = Recipes.resolveByRecipeId(35), shot = Recipes.resolveByRecipeId(20);
    const state = { characterId: 910820, accountName: 'bot_pop_raw_buyers', name: 'MarketSmith',
        phase: 'cold', activity: 'shopping', currentRegion: 'Giran', homeRegion: 'Giran', level: 35,
        adena: 10000000, vitals: { hp: 1000, maxHp: 1000, mp: 380, maxMp: 380 },
        inventory: Object.fromEntries(material.materials.map(row => [row.selfId,
            { selfId: row.selfId, amount: row.amount * 19, stackable: true }])),
        updatedAt: timestamp, timing: {}, loc: { locX: 83396, locY: 147904, locZ: -3400 },
        stats: { classId: 56, money: [500000, .000002, 0, 0] } };
    for (const row of shot.materials) state.inventory[row.selfId] = {
        selfId: row.selfId, amount: row.amount * 9, stackable: true };
    state.inventory[shot.recipeItemId] = { selfId: shot.recipeItemId, amount: 1, stackable: true };
    state.persona = invoke('GameServer/Bot/AI/BotPersona').generate(state);
    const buyer = { id: 910821, ownerId: 910822, storeType: 3, kind: 'shop', custodyPolicy: 0,
        town: 'Giran', revision: 1, escrowAdena: 500000,
        lines: [{ id: 9108210, lineId: 9108210, selfId: shot.productId, count: 1000, price: 500, enchant: 0 }] };
    const materialBuyer = { ...buyer, id: 910823, ownerId: 910824, escrowAdena: 19000000,
        lines: [{ id: 9108230, lineId: 9108230, selfId: material.productId, count: 19, price: 1000000, enchant: 0 }] };
    const records = new Map([buyer, materialBuyer].map(record => [record.id, record]));
    const options = () => ({ timestamp, recipeEarning: true,
        recipes: { recipeBook: Codec.pack([material.recipeId]), knownShotRecipes: [] },
        boardRows: [...board.records.keys()].map(id => [id, rowOf(records.get(id))]) });
    board.put(buyer);
    const selected = (await probe(state, options())).selected;
    assert.equal(selected?.recipeTarget, shot.recipeId,
        'an Artisan invests in its held shot recipe instead of manufacturing materials for permanent buyers');
    const checked = Shots.recheck(state, selected.recipeRoute);
    assert(checked && checked.profit > 0 && checked.expectedSold > 0,
        'the selected shot production passes the native executor recheck with actual positive profit');
    board.remove(buyer.id);
    assert.equal((await probe(state, options())).selected, null,
        'without actual demand the crafter does not learn a recipe or manufacture unsold output');
    board.put(materialBuyer);
    assert.equal((await probe(state, options())).selected?.wealth?.recipeId, material.recipeId,
        'a real profitable material order still supports ordinary production');
    console.log('PASS raw material liquidity, shot recipe investment, absent demand and actual material orders');
})().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(() => {
    Afk.boardIndex = originalBoard;
    Market.reset();
});
