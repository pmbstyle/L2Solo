'use strict';
// Task 4 B5 N1: purchase -> material receipt -> craft -> equip on the real
// native station recipe 198 (Crystal Staff). The bot holds part of the input,
// a stubbed board meeting delivers the rest, the station crafts one staff and
// the bot wears it: one product, equipped, the gear goal closed once.
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
const isolated = require('./helpers/isolatedSocialDatabase')('task4-b5-craft-chain');
require('../src/Global');
isolated.assertConfigured(options.default);
const DataCache = invoke('GameServer/DataCache');
DataCache.init();
const Database = invoke('Database');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Craft = invoke('GameServer/Bot/Economy/ColdCraftingService');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const Market = invoke('GameServer/Bot/Economy/BotAfkMarketService');
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
const restore = [];
function stub(object, key, value) { const prior = object[key]; restore.push(() => object[key] = prior); object[key] = value; }
const nativeItem = selfId => DataCache.items.find(row => Number(row.selfId) === Number(selfId));
const held = (items, selfId) => items.filter(row => Number(row.selfId) === Number(selfId))
    .reduce((sum, row) => sum + Number(row.amount), 0);
const item = (selfId, amount) => ({ selfId, amount, name: nativeItem(selfId)?.template?.name || `Item ${selfId}`,
    equipped: false, slot: 0, enchant: 0 });

(async () => {
    const recipe = invoke('GameServer/Items/C4RecipeItems').resolveByRecipeId(198);
    const inputs = new Map();
    for (const m of recipe.materials) inputs.set(Number(m.selfId), (inputs.get(Number(m.selfId)) || 0) + Number(m.amount));
    const gemstoneId = [...inputs.keys()].find(id => /^Gemstone(?:\s|:)/i.test(nativeItem(id)?.template?.name || ''));
    const station = Craft.stationForRecipe(recipe.recipeId);
    assert(gemstoneId && station, 'recipe 198 needs gemstones and has a native station');
    async function seed(accountName, name, classId, level, rows, stats = {}) {
        await Database.createAccount(accountName, 'fixture');
        const race = Number(DataCache.classTemplates.find(row => Number(row.classId) === classId)?.template?.race || 0);
        const id = Number((await Database.createCharacter(accountName, { name, race, classId, sex: 0,
            face: 0, hair: 0, hairColor: 0, maxHp: 1000, maxMp: 1000, ...station.loc })).insertId);
        await Database.execute(['UPDATE characters SET level=?, exp=?, hp=1000, mp=1000 WHERE id=?',
            [level, Number(DataCache.experience[level - 1]), id]]);
        for (const row of rows) await Database.setItem(id, row);
        return Life.upsertState({ characterId: id, accountName, name, phase: 'cold', activity: 'crafting',
            level, exp: Number(DataCache.experience[level - 1]), loc: { ...station.loc }, currentRegion: 'Giran',
            adena: held(rows, 57), inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)),
            vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 },
            stats: { classId, generatedCold: true, money: [36000, 0, 0, 0], ...stats }, timing: {} }, 'b5_chain_fixture');
    }
    try {
        await Database.init();
        await Life.init();
        await seed(Craft.crafterAccount(station), 'ChainStation', 57, 70, [item(57, 1000000)],
            { craftStationId: station.id, generatedIndex: 10000 });
        const owned = inputs.get(gemstoneId) - 2, bought = 2;
        const staffSlot = Number(nativeItem(recipe.productId)?.etc?.slot || 0);
        assert(staffSlot > 0, 'the staff has a native paperdoll slot');
        let customer = await seed('bot_b5_chain', 'ChainCustomer', 10, 40,
            [item(57, 1000000), ...[...inputs].map(([id, amount]) => item(id, id === gemstoneId ? owned : amount))], {
                equipmentPlan: { status: 'ready_to_craft', strategy: 'craft', recipeId: recipe.recipeId,
                    target: { selfId: recipe.productId, slot: staffSlot } } });
        const id = customer.characterId;
        const notReady = await Craft.craft(customer, () => 0);
        assert.equal(notReady.crafted, false, 'part of the gemstones is not a craft');
        assert.equal(notReady.reason, 'not_ready');

        // Purchase: the card's take on a board line; the stubbed meeting puts the units in the bag.
        const board = new BoardIndex();
        board.put({ id: 77, ownerId: 99, kind: 'sell_ad', custodyPolicy: 1, revision: 4, storeType: Afk.SELL ?? 1,
            town: 'Giran', lines: [{ lineId: 78, selfId: gemstoneId, count: bought, price: 500 }] });
        stub(Afk, 'boardIndex', () => board);
        stub(Afk, 'offerOf', () => ({ store: { afkTrade: true, conditional: true, storeType: Afk.SELL ?? 1, shopId: 77,
            items: [{ selfId: gemstoneId, count: bought, price: 500, afkTradeLineId: 78 }] } }));
        let meetings = 0;
        stub(Afk, 'buyFromShop', async (owner, _store, selfId, count) => {
            meetings++;
            const row = (await Database.fetchItems(owner)).find(r => Number(r.selfId) === Number(selfId));
            await Database.updateItemAmount(owner, row.id, Number(row.amount) + Number(count));
            return { ok: true, meetingId: 5 };
        });
        const take = { take: [Afk.SELL ?? 1, gemstoneId, bought, 77, 78, 4, 500] };
        const prepared = Life.cachedState(id);
        await Market.executePlan(prepared, take);
        assert.equal(meetings, 1, 'the card buys the missing gemstones once');
        assert.equal(held(await Database.fetchItems(id), gemstoneId), inputs.get(gemstoneId));

        // Receipt: the life state reads the delivered units; the same card cannot buy again.
        customer = await Life.upsertState({ ...Life.cachedState(id), activity: 'crafting',
            inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)) }, 'b5_chain_receipt');
        assert.equal(customer.inventory[gemstoneId].amount, inputs.get(gemstoneId));
        assert.equal((await Market.executePlan(customer, take, { preparedState: prepared })).buyPending, true);
        assert.equal(meetings, 1, 'received units never buy twice');

        // Craft and equip.
        const result = await Craft.craft(customer, () => 0);
        assert.equal(result.crafted, true, result.reason);
        assert.equal(result.batchCount, 1);
        const settled = await Life.upsertState(result.state, 'b5_chain_settled');
        const items = await Database.fetchItems(id);
        for (const [selfId] of inputs) assert.equal(held(items, selfId), 0, `input ${selfId} consumed`);
        assert.equal(held(items, recipe.productId), recipe.productCount, 'exactly one staff');
        const staff = items.filter(row => Number(row.selfId) === recipe.productId);
        assert.equal(staff.length, 1);
        assert.equal(Number(staff[0].equipped), 1, 'the crafted staff is worn (physical row)');
        assert.equal(settled.inventory[recipe.productId].equippedCount, 1, 'the cold summary wears one staff');
        assert.equal(settled.stats.equipment.filter(row => Number(row.selfId) === recipe.productId).length, 1);
        assert.equal(settled.stats.equipmentPlan, undefined, 'the gear goal is completed by the equipped staff');

        // Completed once: a second look crafts nothing and buys nothing.
        const again = await Craft.craft({ ...settled, activity: 'crafting' }, () => 0);
        assert.equal(again.crafted, false);
        assert.equal(held(await Database.fetchItems(id), recipe.productId), recipe.productCount, 'still one staff');
        assert.equal(meetings, 1);
        console.log('PASS Task 4 B5 craft chain: partial stock + one bought line -> receipt -> one staff crafted, equipped, goal closed once');
    } finally {
        for (const fn of restore.reverse()) fn();
        await Database.close();
        require('node:fs').rmSync(isolated.directory, { recursive: true, force: true });
    }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
