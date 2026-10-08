'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('economy-native');
require('../src/Global');
const Database = invoke('Database');
const Data = invoke('GameServer/DataCache');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const Commit = require('../src/GameServer/Bot/Economy/EconomyCommit');
const Native = require('./helpers/nativeMarketFixture');
Data.init();
fixture.assertConfigured(options.default);
const amount = async (id, selfId) => Native.amount(await Database.fetchItems(id), selfId);
async function row(id) { return (await Database.execute(['SELECT * FROM bot_life_state WHERE characterId=?', [id]]))[0]; }
async function current(id) { return Life.acceptLifecycleRow(await row(id)); }
async function step(id, kind, original = null) { return Commit.admit(await current(id), kind, original); }
async function seed(id, account) {
    await Native.character(Database, id, 'Native' + id, account);
    await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 10000, stackable: true });
    await Life.upsertState({ characterId: id, accountName: account, name: 'Native' + id, level: 60,
        exp: 0, sp: 0, adena: 10000, phase: 'cold', activity: 'shopping', homeRegion: 'Giran', currentRegion: 'Giran',
        loc: { x: 83000, y: 148000, z: -3400 }, vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
        stats: { classId: 57, money: [36000, 0, 0, 0] },
        inventory: { 57: { selfId: 57, amount: 10000 } }, simulation: { ownerId: 'legacy_main', revision: 0 },
        timing: {}, updatedAt: Date.now() }, 'native_fixture');
}
async function run() {
    Database.init();
    await seed(1, 'bot_e2_buyer');
    await seed(2, 'bot_e2_seller');
    const recipe = Recipes.resolveByRecipeId(25);
    assert(recipe && recipe.type === 'dwarven' && recipe.successRate === 100);
    await Database.setSkill({ selfId: 172, name: 'Create Item', level: 9 }, 1);
    await Database.setCharacterRecipe(1, recipe.recipeId, recipe.type);
    const materials = [];
    for (const material of recipe.materials) {
        const inserted = await Database.setItem(1, { selfId: material.selfId, name: 'Material', amount: material.amount * 2 });
        materials.push({ id: inserted.insertId, selfId: material.selfId, amount: material.amount });
    }
    const admitted = await step(1, Commit.KINDS.craft);
    const command = admitted.command;
    const args = { materials, product: { selfId: recipe.productId, name: 'Product', amount: recipe.productCount, stackable: true },
        mp: 0, recipeId: recipe.recipeId, economyCommand: command, coldState: admitted.state };
    const crafted = await Database.craftInventoryItems(1, args);
    Commit.finish(1, command);
    assert.equal(crafted.success, true);
    assert.equal(Number(crafted.mp), 100 - recipe.mpCost);
    assert.equal(await amount(1, recipe.productId), recipe.productCount);
    await Database.close();
    Database.init();
    const beforeHot = await current(1);
    const hot = await Life.upsertState({ ...beforeHot, phase: 'hot', timing: { ...beforeHot.timing, lastHotAt: Date.now() } }, 'receipt_handoff');
    assert.equal(Commit.acceptRow(crafted.coldLifeRow).phase, 'hot', 'a delayed committed row cannot undo the newer hot owner');
    assert.equal(Life.cachedState(1).phase, 'hot');
    await assert.rejects(Database.craftInventoryItems(1, args), /owner_changed/);
    const hotRetry = await Commit.admit(hot, Commit.KINDS.craft, command);
    const recoveredCraft = await Database.craftInventoryItems(1, { ...args, materials: [], product: null, economyCommand: hotRetry.command });
    Commit.finish(1, hotRetry.command);
    assert(recoveredCraft.replayed && recoveredCraft.success, 'restart and newly admitted owner return the saved completion');
    await Life.upsertState({ ...(await current(1)), phase: 'cold' }, 'receipt_return', { releaseHot: true });
    const replayAdmission = await step(1, Commit.KINDS.craft, command);
    const replayed = await Database.craftInventoryItems(1, { ...args, materials: [], product: null, economyCommand: replayAdmission.command });
    Commit.finish(1, replayAdmission.command);
    assert(replayed.replayed && replayed.success);
    assert.equal(replayed.mp, crafted.mp);
    assert.equal(await amount(1, recipe.productId), recipe.productCount, 'lost reply cannot mint another product');
    for (const material of recipe.materials) assert.equal(await amount(1, material.selfId), material.amount, 'lost reply cannot consume again');
    const receipt = JSON.parse((await row(1)).statsJson).economyCommit;
    assert(Commit.valid(receipt));
    assert(Buffer.byteLength(JSON.stringify(receipt)) <= 384);
    // Generic writers preserve the DB-owned leaf even when their snapshot
    // omits it or attempts to forge a newer result.
    const stale = await current(1);
    await Life.upsertState({ ...stale, stats: { ...stale.stats, economyCommit: [999, 1, 'fabricated'] } }, 'stale_receipt');
    assert.deepEqual(JSON.parse((await row(1)).statsJson).economyCommit, receipt);
    const wrong = Commit.header(require('node:crypto').randomUUID(), Commit.KINDS.craft, command[2], Commit.authority(await current(1)));
    await assert.rejects(Database.craftInventoryItems(1, { ...args, economyCommand: wrong }), /intent_changed/);
    const npc = await step(1, Commit.KINDS.npcBuy);
    const bought = await Database.purchaseNpcInventoryItem(1, { selfId: 1864, amount: 3, unitPrice: 10,
        economyCommand: npc.command, coldState: npc.state, funding: { r: 1 } });
    Commit.finish(1, npc.command);
    assert.equal(bought.spent, 30);
    const beforeReplayMoney = await amount(1, 57);
    const npcRetry = await step(1, Commit.KINDS.npcBuy, npc.command);
    const boughtAgain = await Database.purchaseNpcInventoryItem(1, { selfId: 1864, amount: 3, unitPrice: 10,
        economyCommand: npcRetry.command, funding: { r: 1 } });
    Commit.finish(1, npcRetry.command);
    assert(boughtAgain.replayed);
    assert.equal(await amount(1, 57), beforeReplayMoney);
    assert.equal(await amount(1, 1864), 3);
    const stock = await Database.setItem(2, { selfId: 1870, name: 'Coal', amount: 4 });
    const shop = await Database.createAfkTradeShop(2, { storeType: 1, kind: 'shop', town: 'Giran', title: 'Coal',
        lines: [{ objectId: stock.insertId, selfId: 1870, name: 'Coal', count: 4, price: 25, stackable: true }] });
    const afk = await step(1, Commit.KINDS.afkBuy);
    const purchaseArgs = { shopId: shop.shop.id, ownerId: 2, lineId: shop.shop.lines[0].id, amount: 4,
        expectedPrice: 25, expectedRevision: 1, economyCommand: afk.command, funding: { r: 1 } };
    const publicBuy = await Database.buyFromAfkTradeShop(1, purchaseArgs);
    Commit.finish(1, afk.command);
    assert.equal(publicBuy.amount, 4);
    const afterPublicBuy = await amount(1, 57);
    const afterSeller = await amount(2, 57);
    const retryAfk = await step(1, Commit.KINDS.afkBuy, afk.command);
    const savedBuy = await Database.buyFromAfkTradeShop(1, { ...purchaseArgs, economyCommand: retryAfk.command });
    Commit.finish(1, retryAfk.command);
    assert(savedBuy.replayed, 'completion replay works after the full fill deleted its shop/line');
    assert.equal(await amount(1, 57), afterPublicBuy);
    assert.equal(await amount(2, 57), afterSeller);
    assert.equal(await amount(1, 1870), 4);
    assert.equal(savedBuy.eventId, publicBuy.eventId);
    const publicBid = await Database.createAfkTradeShop(2, { storeType: 3, kind: 'shop', town: 'Giran', title: 'Buy coal',
        lines: [{ selfId: 1870, name: 'Coal', count: 3, price: 20, stackable: true }] });
    const selling = await step(1, Commit.KINDS.afkSell);
    const item = (await Database.fetchItems(1)).find(entry => entry.selfId === 1870);
    const saleArgs = { shopId: publicBid.shop.id, ownerId: 2, lineId: publicBid.shop.lines[0].id,
        objectId: item.id, amount: 2, expectedRevision: 1, expectedPrice: 20, economyCommand: selling.command };
    const publicSale = await Database.sellToAfkTradeShop(1, saleArgs);
    Commit.finish(1, selling.command);
    assert.equal(publicSale.amount, 2);
    assert.equal(publicSale.shop.escrowAdena, 20);
    const retrySale = await step(1, Commit.KINDS.afkSell, selling.command);
    const savedSale = await Database.sellToAfkTradeShop(1, { ...saleArgs, economyCommand: retrySale.command });
    Commit.finish(1, retrySale.command);
    assert(savedSale.replayed);
    assert.equal(await amount(1, 1870), 2);
    await Database.settleBoardOwner(2);
    assert.equal(await amount(2, 1870), 2);
    const beforeRefund = await amount(2, 57);
    await Database.closeAfkTradeShop(2);
    assert.equal(await amount(2, 57), beforeRefund + 20, 'partial order returns exactly its remaining escrow');
    assert.equal(JSON.parse((await row(2)).statsJson).economyCommit, undefined, 'passive fills never replace seller/buyer optional receipt');
    await Database.setSkill({ selfId: 172, name: 'Create Item', level: 9 }, 2);
    await Database.setItem(2, { selfId: recipe.recipeItemId, name: 'Recipe', amount: 2 });
    const learn = await step(2, Commit.KINDS.learn);
    const learned = await Database.learnColdRecipes(2, [recipe], learn.state, { economyCommand: learn.command });
    Commit.finish(2, learn.command);
    assert.equal(learned.learned.length, 1);
    assert.equal(await amount(2, recipe.recipeItemId), 1);
    const learnRetry = await step(2, Commit.KINDS.learn, learn.command);
    const learningReplay = await Database.learnColdRecipes(2, [recipe], null, { economyCommand: learnRetry.command });
    Commit.finish(2, learnRetry.command);
    assert(learningReplay.replayed);
    assert.equal(await amount(2, recipe.recipeItemId), 1, 'learning retry cannot consume another scroll');
    assert.equal((await Database.fetchCharacterRecipes(2)).filter(row => row.recipeId === recipe.recipeId).length, 1);
    const uncertain = Object.values(Recipes.loadRecipeItems()).find(row => row.type === 'dwarven' && row.successRate < 100 && row.mpCost > 0);
    assert(uncertain, 'native catalog supplies a probabilistic recipe');
    await Database.setCharacterRecipe(2, uncertain.recipeId, uncertain.type);
    const failedState = await current(2);
    await Life.upsertState({ ...failedState, vitals: { ...failedState.vitals, mp: uncertain.mpCost * 3, maxMp: uncertain.mpCost * 3 } }, 'failure_inputs');
    const failureMaterials = [];
    for (const material of uncertain.materials) {
        const result = await Database.setItem(2, { selfId: material.selfId, name: 'Failure material', amount: material.amount * 3 });
        failureMaterials.push({ id: result.insertId, selfId: material.selfId, amount: material.amount * 3 });
    }
    const product = Data.items.find(row => Number(row.selfId) === Number(uncertain.productId));
    const beforeOutput = await amount(2, uncertain.productId);
    const failing = await step(2, Commit.KINDS.craft);
    let draws = 0;
    const failedArgs = { recipeId: uncertain.recipeId, batches: 3, materials: failureMaterials,
        product: { selfId: uncertain.productId, amount: uncertain.productCount * 3,
            stackable: !!product.etc?.stackable, slot: Number(product.etc?.slot || 0) },
        economyCommand: failing.command, random: () => { draws++; return .999999; } };
    const failure = await Database.craftInventoryItems(2, failedArgs);
    Commit.finish(2, failing.command);
    assert.equal(failure.success, false);
    assert.equal(draws, 1, 'one native multi-batch command has one outcome draw');
    assert.equal(failure.mp, 0);
    assert.equal(await amount(2, uncertain.productId), beforeOutput);
    const failedRetry = await step(2, Commit.KINDS.craft, failing.command);
    const replayFailure = await Database.craftInventoryItems(2, { ...failedArgs, economyCommand: failedRetry.command });
    Commit.finish(2, failedRetry.command);
    assert(replayFailure.replayed && !replayFailure.success);
    assert.equal(draws, 1, 'retry must keep the saved failure, never draw again');
    // A pending intent without a commit survives restart, but recovery never
    // recreates its old arguments. Replan a different native step from stock.
    const pending = await step(1, Commit.KINDS.npcBuy);
    Commit.finish(1, pending.command);
    const recovered = await step(1, Commit.KINDS.npcBuy);
    assert.equal(recovered.recovered, 'pending_aborted');
    assert.notEqual(recovered.command[0], pending.command[0]);
    await assert.rejects(Database.purchaseNpcInventoryItem(1, { selfId: 1864, amount: 1, unitPrice: 1,
        economyCommand: pending.command, funding: { r: 1 } }), /intent_changed/);
    const moved = await current(1);
    await Life.upsertState({ ...moved, phase: 'hot', timing: { ...moved.timing, lastHotAt: Date.now() } }, 'hot_transfer');
    await assert.rejects(Database.purchaseNpcInventoryItem(1, { selfId: 1864, amount: 1, unitPrice: 1,
        economyCommand: recovered.command, funding: { r: 1 } }), /owner_changed/);
    Commit.finish(1, recovered.command);
    assert.equal(Commit.size(), 0);
    console.log('Native economy completion: craft/MP, NPC, closed AFK fill replay, partial refunds, protected leaf and handoff passed');
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    Commit.clear();
    await Database.close();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
});
