const assert = require('assert');
const fs = require('fs');
const path = require('path');
require('../src/Global');
process.env.L2NODE_PROGRESSION_RATE = 'x10';
const DB = invoke('Database');
const Cache = invoke('GameServer/DataCache');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Shots = invoke('GameServer/Bot/Economy/ColdShotEconomyService');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const BotMarket = invoke('GameServer/Bot/Economy/BotAfkMarketService');
const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const dbPath = path.join(process.cwd(), 'tmp', 'test-shot-economy-persistence.sqlite');
const originalCraft = DB.craftInventoryItems;
let sequence = 0;
// Every purchase is made in its seller's town (group C): a shot buyer shops in
// Dion, where the merchant sells D shots; a crafter in Giran, where the NPC
// sells its scrap and ore cheapest.
const TOWNS = { Dion: { locX: 15631, locY: 142885, locZ: -2704 }, Giran: { locX: 83396, locY: 147904, locZ: -3400 } };
async function bot({ classId = 57, mp = 1000, shots = 1000, recipe = true, money = 1000000, town = 'Dion' } = {}) {
    const name = `Economy${++sequence}`;
    const accountName = `bot_economy_${sequence}`;
    await DB.createAccount(accountName, 'test');
    const characterId = Number((await DB.createCharacter(accountName, { name, race: 4, classId,
        maxHp: 1000, maxMp: 1000, sex: 0, face: 0, hair: 0, hairColor: 0,
        locX: 81100, locY: 148000, locZ: -3466 })).insertId);
    for (const item of [{ selfId: 57, amount: money }, { selfId: 129, amount: 1, equipped: true, slot: 7 },
        ...(shots ? [{ selfId: 1463, amount: shots }] : [])]) {
        await DB.setItem(characterId, { ...item, name: Cache.items.find(t => t.selfId === item.selfId).template.name });
    }
    if (recipe) await DB.setCharacterRecipe(characterId, 20, 'dwarven');
    await DB.setSkill({ selfId: 248, name: 'Crystallize', level: 3, passive: true }, characterId);
    return Life.upsertState({ characterId, accountName, name, phase: 'cold', activity: 'shopping',
        classId, level: 60, adena: money, currentRegion: town,
        inventory: Life.inventorySummaryFromItems(await DB.fetchItems(characterId)),
        vitals: { hp: 1000, maxHp: 1000, mp, maxMp: 1000 },
        loc: { ...TOWNS[town] },
        persona: { primaryDrive: 'adventure' }, stats: { classId, generatedCold: true } }, 'economy_test');
}
async function balances(id) {
    const rows = await DB.fetchItems(id);
    const [life] = await DB.execute(['SELECT * FROM bot_life_state WHERE characterId = ?', [id]]);
    const inventory = JSON.parse(life.inventorySummary);
    const physical = Life.inventorySummaryFromItems(rows);
    assert.strictEqual(Number(life.adena), Number(physical[57]?.amount || 0));
    for (const itemId of new Set([...Object.keys(inventory), ...Object.keys(physical)])) {
        assert.strictEqual(Number(inventory[itemId]?.amount || 0), Number(physical[itemId]?.amount || 0), `item ${itemId}`);
    }
    return { inventory, physical, life };
}
async function demand() {
    const buyer = await bot({ classId: 0, shots: 0, recipe: false });
    return Life.upsertState({ ...buyer, stats: { ...buyer.stats,
        shotDemand: { itemId: 1463, amount: 3000, maxSpend: 300000, at: Date.now() } } }, 'shot_demand_test');
}
async function run() {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
    options.default.Database.path = path.relative(process.cwd(), dbPath);
    DB.init(); Cache.init(); invoke('GameServer/World/World').user = { sessions: [], revision: 0 };
    await Life.init();
    const empty = await bot({ classId: 0, shots: 0, recipe: false, money: 100000 });
    const fallback = await Coordinator.withEconomyState(empty, state => Shots.review(state));
    assert(fallback.state.adena < empty.adena, 'paid static fallback must debit virtual Adena');
    assert(fallback.state.inventory[1463].amount > 0);
    assert.strictEqual((await balances(empty.characterId)).life.adena, fallback.state.adena);
    // A virtual sync after purchase may never restore the old wallet.
    await DB.syncInventorySummary(empty.characterId, fallback.state.inventory);
    assert.strictEqual((await balances(empty.characterId)).life.adena, fallback.state.adena);
    const stableWallet = fallback.state.adena;
    await assert.rejects(DB.purchaseNpcInventoryItem(empty.characterId, {
        selfId: 1785, name: 'Soul Ore', amount: 1, unitPrice: 550, coldState: empty
    }), /economy_state_changed/, 'stale economic operations must roll back their physical inventory writes');
    assert.strictEqual((await balances(empty.characterId)).life.adena, stableWallet);

    await demand();
    const tired = await bot({ mp: 0, town: 'Giran' });
    const before = JSON.stringify(await DB.fetchItems(tired.characterId));
    Shots._resetForTests();
    const noMp = await Coordinator.withEconomyState(tired, state => Shots.review(state));
    assert(!noMp.crafted);
    assert.strictEqual(JSON.stringify(await DB.fetchItems(tired.characterId)), before, 'zero MP cannot trigger a scrap purchase');

    const crafter = await bot({ town: 'Giran' });
    Shots._resetForTests();
    DB.craftInventoryItems = async () => { throw new Error('injected craft failure'); };
    const failed = await Coordinator.withEconomyState(crafter, state => Shots.review(state));
    DB.craftInventoryItems = originalCraft;
    assert.strictEqual(failed.reason, 'error');
    const partial = await balances(crafter.characterId);
    assert(partial.inventory[1458]?.amount > 0, 'a committed crystal purchase survives a later failed craft');
    assert(partial.life.adena < crafter.adena);
    assert.strictEqual(Life.snapshot(crafter.characterId).adena, partial.life.adena);

    // The next review uses the already acquired inputs, with no invented recipe.
    Shots._resetForTests();
    const success = await Coordinator.withEconomyState(Life.snapshot(crafter.characterId), state => Shots.review(state));
    assert(success.crafted, JSON.stringify(success));
    assert(success.state.stats.shotCraft.amount > 0);
    await balances(crafter.characterId);
    const goal = { type: 'sell_inventory', status: 'active', plan: { expectedBenefit: 'market_sale_inventory' } };
    const listing = await BotMarket.reconcile(success.state, goal);
    assert(listing.shop?.lines.some(line => Number(line.selfId) === 1463), 'crafted shots must be listed for real funded demand');
    const buyer = await demand();
    Shots._resetForTests();
    const purchase = await Coordinator.withEconomyState(buyer, state => Shots.review(state));
    assert(purchase.state.inventory[1463]?.amount > 0);
    await balances(buyer.characterId);
    await balances(crafter.characterId);

    const missingRecipe = await bot({ recipe: false, town: 'Giran' });
    await demand(); Shots._resetForTests();
    const waiting = await Coordinator.withEconomyState(missingRecipe, state => Shots.review(state));
    assert(waiting.state.stats.shotRecipeDemand, 'missing scroll creates market demand');
    assert.strictEqual((await DB.fetchCharacterRecipes(missingRecipe.characterId)).length, 0);
    assert(!(await DB.fetchItems(missingRecipe.characterId)).some(row => [1804, 3032, 3953].includes(row.selfId)),
        'neither recipes nor recipe knowledge may appear from procurement');

    // A real scroll in a seller's inventory must be the source of knowledge.
    const seller = await bot({ classId: 0, recipe: false });
    await DB.setItem(seller.characterId, { selfId: 1804, name: 'Recipe: Soulshot: D-Grade', amount: 1 });
    await Life.syncExternalInventory(seller.characterId, 'test_recipe_drop', seller);
    const recipeBuyer = await bot({ recipe: false });
    await demand(); Shots._resetForTests();
    const learned = await Coordinator.withEconomyState(recipeBuyer, state => Shots.review(state));
    assert((await DB.fetchCharacterRecipes(recipeBuyer.characterId)).some(row => row.recipeId === 20), JSON.stringify(learned));
    const sellerCopies = (await DB.fetchItems(seller.characterId)).filter(row => row.selfId === 1804).reduce((n, row) => n + row.amount, 0);
    assert.strictEqual(sellerCopies, 0);
    assert.strictEqual((await DB.fetchItems(recipeBuyer.characterId)).filter(row => row.selfId === 1804).reduce((n, row) => n + row.amount, 0), 0);
    for (const id of [1804, 3032, 3953]) {
        assert(Cache.npcRewards.some(npc => [...(npc.rewards || []), ...(npc.spoils || [])]
            .some(group => (group.items || []).some(item => item.selfId === id))), `recipe ${id} has a natural source`);
    }
    const final = await balances(crafter.characterId);
    await DB.close(); DB.init();
    assert.deepStrictEqual((await balances(crafter.characterId)).inventory, final.inventory, 'economic state survives SQLite reopen');
    console.log('Shot economy: durable money/materials, zero MP, failed craft, market sale, natural recipe and reopen passed');
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    DB.craftInventoryItems = originalCraft;
    await Afk._resetForTests();
    await DB.close();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
});
