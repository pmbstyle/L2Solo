const assert = require('assert');
const fs = require('fs');
const path = require('path');
const isolated = require('./helpers/isolatedSocialDatabase')('shot_economy_persistence', path.resolve(__dirname, '..'));
require('./helpers/databaseIsolation');
require('../src/Global');
isolated.assertConfigured(options.default);
process.env.L2NODE_PROGRESSION_RATE = 'x10';
const DB = invoke('Database');
const Cache = invoke('GameServer/DataCache');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Shots = invoke('GameServer/Bot/Economy/ColdShotEconomyService');
const withNativeInput = require('./helpers/nativeEconomyInput');
const nativeReview = state => withNativeInput(state, (accepted, now) => Shots.review(accepted, now));
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const BotMarket = invoke('GameServer/Bot/Economy/BotAfkMarketService');
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const dbPath = isolated.world;
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
    options.default.Database.path = dbPath;
    DB.init(); Cache.init(); // Native World registry starts empty; no session-array replacement.
    // Native PopulationService.init installs this subscription BEFORE Life.init
    // and the first demand publication; this fixture seeds the same sequence.
    invoke('GameServer/Bot/Economy/CraftWorkshopService').init();
    await Life.init();
    // The stock restock spends at most what its wish is worth (E187), so a
    // dry bot keeps change and the stale Soul Ore purchase below can only be
    // refused by its stale state, never by an empty wallet.
    const empty = await bot({ classId: 0, shots: 0, recipe: false, money: 100000 });
    const fallback = await nativeReview(empty);
    assert(fallback.state.adena < empty.adena, 'paid static fallback must debit virtual Adena');
    assert(fallback.state.inventory[1463].amount > 0);
    assert.strictEqual((await balances(empty.characterId)).life.adena, fallback.state.adena);
    // A virtual sync after purchase may never restore the old wallet.
    await DB.syncInventorySummary(empty.characterId, fallback.state.inventory);
    assert.strictEqual((await balances(empty.characterId)).life.adena, fallback.state.adena);
    const stableWallet = fallback.state.adena;
    assert(stableWallet >= 550, 'the stale purchase must be affordable; only its stale state may refuse it');
    await assert.rejects(DB.purchaseNpcInventoryItem(empty.characterId, {
        selfId: 1785, name: 'Soul Ore', amount: 1, unitPrice: 550, coldState: empty
    }), /economy_state_changed/, 'stale economic operations must roll back their physical inventory writes');
    assert.strictEqual((await balances(empty.characterId)).life.adena, stableWallet);

    await demand();
    const tired = await bot({ mp: 0, town: 'Giran' });
    const before = JSON.stringify(await DB.fetchItems(tired.characterId));
    Shots._resetForTests();
    const noMp = await nativeReview(tired);
    assert(!noMp.crafted);
    assert.strictEqual(JSON.stringify(await DB.fetchItems(tired.characterId)), before, 'zero MP cannot trigger a scrap purchase');

    const crafter = await bot({ town: 'Giran' });

    Shots._resetForTests();
    const beforeCraftBag = JSON.stringify(await DB.fetchItems(crafter.characterId));
    const refused = await nativeReview(crafter);
    assert(!refused.crafted, 'the native negative margin does not reach physical crafting');
    assert.strictEqual(JSON.stringify(await DB.fetchItems(crafter.characterId)), beforeCraftBag,
        'the original wallet, MP and materials are not retuned to make a craft profitable');

    // Explicit one-recipe execution unit below. It exercises real merchant,
    // crystallization, craft/CAS and lifecycle SQL; no economic selection or
    // profitable-workshop claim is inferred from this manual transaction.
    const recipe = Recipes.resolveByRecipeId(20);
    const Policy = invoke('GameServer/Bot/Economy/ShotCraftPolicy');
    const Profit = invoke('GameServer/Bot/Economy/CraftProfitPolicy');
    let physicalState = Life.snapshot(crafter.characterId);
    const inputs = await withNativeInput(physicalState, async (accepted, at) => {
        const index = Shots.marketSnapshot(at);
        const route = Policy.crystalRoute(accepted, 'd', 1458,
            recipe.materials.find(item => Number(item.selfId) === 1458).amount, index);
        assert(route && route.source === 'npc', 'the native catalogue supplies the crystallizable gear route');
        const template = index.itemTemplates.get(route.selfId);
        const purchased = await DB.purchaseNpcInventoryItem(accepted.characterId, { selfId: route.selfId,
            name: template.template.name, amount: 1, unitPrice: route.price, stackable: false,
            slot: Number(template.etc.slot || 0), coldState: accepted });
        assert(purchased.ok);
        const afterGear = Life.acceptLifecycleRow(purchased.coldLifeRow);
        assert.strictEqual(afterGear.adena, accepted.adena - route.price);
        const gear = (await DB.fetchItems(afterGear.characterId)).find(item => Number(item.selfId) === route.selfId && !item.equipped);
        const crystals = await DB.crystallizeInventoryItem(afterGear.characterId, { sourceId: gear.id,
            sourceSelfId: route.selfId, crystalId: 1458, crystalAmount: Number(template.etc.cristals),
            crystalName: index.itemTemplates.get(1458).template.name, coldState: afterGear });
        const afterCrystal = Life.acceptLifecycleRow(crystals.coldLifeRow);
        const ore = recipe.materials.find(item => Number(item.selfId) !== 1458);
        const orePrice = Number(index.npcPrice.get(Number(ore.selfId)));
        const purchasedOre = await DB.purchaseNpcInventoryItem(afterCrystal.characterId, { selfId: Number(ore.selfId),
            name: index.itemTemplates.get(Number(ore.selfId)).template.name, amount: Number(ore.amount),
            unitPrice: orePrice, coldState: afterCrystal });
        assert(purchasedOre.ok);
        const afterOre = Life.acceptLifecycleRow(purchasedOre.coldLifeRow);
        assert.strictEqual(afterOre.adena, accepted.adena - route.price - orePrice * ore.amount);
        return afterOre;
    });
    const partial = await balances(crafter.characterId);
    assert(partial.inventory[1458]?.amount > 0, 'a committed crystal purchase survives a later failed craft');
    assert(partial.life.adena < crafter.adena);
    assert.strictEqual(Life.snapshot(crafter.characterId).adena, partial.life.adena);
    const materialRows = Profit.materials(await DB.fetchItems(crafter.characterId), recipe);
    const product = Cache.items.find(item => item.selfId === recipe.productId);
    const execution = { materials: materialRows, coldState: inputs, mp: inputs.vitals.mp - recipe.mpCost,
        product: { selfId: recipe.productId, name: product.template.name, amount: recipe.productCount, stackable: true } };
    DB.craftInventoryItems = async () => { throw new Error('injected craft failure'); };
    await assert.rejects(DB.craftInventoryItems(crafter.characterId, execution), /injected craft failure/);
    DB.craftInventoryItems = originalCraft;
    assert.deepStrictEqual((await balances(crafter.characterId)).inventory, partial.inventory);
    await assert.rejects(DB.craftInventoryItems(crafter.characterId, { ...execution, coldState: crafter }),
        /economy_state_changed/, 'the original pre-purchase checkpoint cannot consume paid inputs');
    assert.deepStrictEqual((await balances(crafter.characterId)).inventory, partial.inventory, 'SQL CAS rollback restores all craft material and product writes');
    const crafted = await DB.craftInventoryItems(crafter.characterId, execution);
    assert(crafted.product?.id > 0);
    const success = { state: Life.acceptLifecycleRow(crafted.coldLifeRow) };
    assert.strictEqual(success.state.inventory[recipe.productId].amount,
        partial.inventory[recipe.productId].amount + recipe.productCount, 'the authored one-batch output is conserved');
    assert.strictEqual(success.state.vitals.mp, inputs.vitals.mp - recipe.mpCost);
    await balances(crafter.characterId);
    // Demand for shots is their deals on the board (group E): buyers took
    // D shots near the crafter's price over the last hour. A shop opens at a
    // market visit in the town the bot chose (group C): here, Giran.
    const MarketCounters = invoke('GameServer/Bot/Economy/MarketCounters');
    const visitAt = 1791000000000;
    for (let deal = 0; deal < 20; deal++) MarketCounters.deal(1463, 90, 500, visitAt - (20 - deal) * 180000, 999999);
    // An explicit physical sell shop is the escrow/trade unit here (E115: a
    // bot's sell_ad settles only through a meeting); it does not assert that
    // the current enchant-funded leaf selected sale.
    const outputRow = (await DB.fetchItems(crafter.characterId)).find(item => Number(item.selfId) === recipe.productId);
    const published = await Afk.publishBot(crafter.characterId, { kind: 'shop', storeType: Afk.SELL,
        title: 'Authored recipe output', town: 'Giran', ...TOWNS.Giran,
        lines: [{ objectId: outputRow.id, selfId: recipe.productId, name: outputRow.name,
            count: recipe.productCount, price: 90, enchant: 0, slot: 0, stackable: true }] });
    assert(published?.lines.some(line => Number(line.selfId) === 1463));
    const buyer = await demand();
    Shots._resetForTests();
    const purchase = await nativeReview(buyer);
    assert(purchase.state.inventory[1463]?.amount > 0);
    await balances(buyer.characterId);
    await balances(crafter.characterId);

    const missingRecipe = await bot({ recipe: false, town: 'Giran' });
    await demand(); Shots._resetForTests();
    const waiting = await nativeReview(missingRecipe);
    assert(!waiting.state.stats.shotRecipeDemand, 'a loss-making recipe route creates no funded recipe demand');
    assert.strictEqual((await DB.fetchCharacterRecipes(missingRecipe.characterId)).length, 0);
    assert(!(await DB.fetchItems(missingRecipe.characterId)).some(row => [1804, 3032, 3953].includes(row.selfId)),
        'neither recipes nor recipe knowledge may appear from procurement');

    // A real scroll in a seller's inventory must be the source of knowledge.
    // The seller has put it on the board (its own sale decides that, group E;
    // a bot without a shop lists nothing from afar, group C).
    const seller = await bot({ classId: 0, recipe: false });
    await DB.setItem(seller.characterId, { selfId: 1804, name: 'Recipe: Soulshot: D-Grade', amount: 1 });
    await Life.syncExternalInventory(seller.characterId, 'test_recipe_drop', seller);
    const scroll = (await DB.fetchItems(seller.characterId)).find(row => row.selfId === 1804);
    const bookRecord = await Afk.publishBot(seller.characterId, { kind: 'shop', storeType: Afk.SELL, title: 'Recipe', town: 'Dion', ...TOWNS.Dion,
        lines: [{ objectId: Number(scroll.id), selfId: 1804, name: scroll.name, count: 1, price: 30000,
            enchant: 0, slot: 0, stackable: false }] });
    const recipeBuyer = await bot({ recipe: false });
    await demand(); Shots._resetForTests();
    const noLearning = await nativeReview(recipeBuyer);
    assert.strictEqual((await DB.fetchCharacterRecipes(recipeBuyer.characterId)).length, 0,
        'an unprofitable policy route does not purchase or invent recipe knowledge');
    const beforeBook = noLearning.state;
    const sellerBeforeBook = await balances(seller.characterId);
    // This historical transfer is an explicit raw SQL settlement fixture.
    // The unchanged negative optional policy above did not publish funding
    // for this purchase; no spending packet or optional admission is invented.
    // Native receipt/eligibility selection is covered by cold-shot/commit tests.
    const bookLine = bookRecord.lines.find(line => Number(line.selfId) === 1804);
    const boughtBook = await DB.buyFromAfkTradeShop(beforeBook.characterId, {
        shopId: bookRecord.id, ownerId: seller.characterId, lineId: bookLine.id,
        amount: 1, expectedPrice: 30000, expectedRevision: bookRecord.revision
    });
    await Afk.settleOwners(boughtBook.settlementOwners);
    const boughtState = await Life.syncExternalInventory(beforeBook.characterId, 'manual_book_settlement',
        Life.cachedState(beforeBook.characterId));
    assert(boughtState, 'the historical physical seller supplies the paid scroll');
    assert.strictEqual(boughtState.adena, beforeBook.adena - 30000);
    const learnedReceipt = await DB.learnColdRecipes(beforeBook.characterId, [recipe], boughtState);
    const learned = invoke('GameServer/Bot/Economy/EconomyCommit').acceptRow(learnedReceipt.coldLifeRow);
    const buyerAfterBook = await balances(recipeBuyer.characterId);
    const sellerAfterBook = await balances(seller.characterId);
    assert.strictEqual(buyerAfterBook.life.adena, beforeBook.adena - 30000);
    assert.strictEqual(sellerAfterBook.life.adena, sellerBeforeBook.life.adena + 30000);
    console.log('PHYSICAL_BOOK_TRADE', JSON.stringify({ buyerBefore: beforeBook.adena,
        buyerAfter: buyerAfterBook.life.adena, sellerBefore: sellerBeforeBook.life.adena,
        sellerAfter: sellerAfterBook.life.adena, learnedRecipes: await DB.fetchCharacterRecipes(recipeBuyer.characterId) }));
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
    console.log('Shot economy: original policy refusal plus explicit authored physical recipe/escrow/CAS/reopen execution passed');
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    DB.craftInventoryItems = originalCraft;
    await Afk._resetForTests();
    await DB.close();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
    fs.rmSync(isolated.directory, { recursive: true, force: true });
});
