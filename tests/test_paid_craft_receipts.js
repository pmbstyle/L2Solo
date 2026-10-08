'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('paid-craft-receipts');
require('../src/Global');
const Database = invoke('Database');
const Data = invoke('GameServer/DataCache');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Workshop = require('../src/GameServer/Bot/Economy/CraftWorkshopService');
const Commit = require('../src/GameServer/Bot/Economy/EconomyCommit');
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const Profit = require('../src/GameServer/Bot/Economy/CraftProfitPolicy');
Data.init(); fixture.assertConfigured(options.default);
let serial = 0;
const loc = { locX: 83396, locY: 147904, locZ: -3400 };
async function seed(recipe, crafter = false, copies = 3) {
    const account = `bot_paid_receipt_${++serial}`;
    await Database.createAccount(account, 'fixture');
    const id = Number((await Database.createCharacter(account, { name: `PaidReceipt${serial}`, race: 4,
        classId: crafter ? 57 : 0, sex: 0, face: 0, hair: 0, hairColor: 0,
        maxHp: 1000, maxMp: 1000000, ...loc })).insertId);
    await Database.execute(['UPDATE characters SET level=70,hp=1000,mp=1000000 WHERE id=?', [id]]);
    await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 100000000, equipped: false });
    if (crafter) await Database.setCharacterRecipe(id, recipe.recipeId, recipe.type);
    else for (const [selfId, amount] of Profit.requirements(recipe)) {
        await Database.setItem(id, { selfId, name: 'Material', amount: amount * copies, equipped: false });
    }
    let state = await Life.upsertState({ characterId: id, accountName: account, name: `PaidReceipt${serial}`,
        level: 70, phase: 'cold', activity: 'shopping', loc, currentRegion: 'Giran', adena: 100000000,
        inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)),
        vitals: { hp: 1000, maxHp: 1000, mp: 1000000, maxMp: 1000000 },
        stats: { classId: crafter ? 57 : 0, generatedCold: true, money: [36000, 0, 0, 0] }, timing: {} }, 'receipt_fixture');
    if (crafter) state = await Workshop.review(state);
    return state;
}
async function image(ids) {
    return Promise.all(ids.map(async id => ({ items: await Database.fetchItems(id),
        character: (await Database.execute(['SELECT * FROM characters WHERE id=?', [id]]))[0],
        life: (await Database.execute(['SELECT * FROM bot_life_state WHERE characterId=?', [id]]))[0] })));
}
const count = (rows, id) => rows.filter(row => Number(row.selfId) === id).reduce((n, row) => n + Number(row.amount), 0);
async function run() {
    await Database.init(); await Life.init(); Workshop.init();
    const successRecipe = Recipes.resolveByRecipeId(1);
    const owner = await seed(successRecipe, true), buyer = await seed(successRecipe);
    const before = await image([owner.characterId, buyer.characterId]);
    const native = Database.craftForCustomer;
    let calls = 0, command;
    Database.craftForCustomer = async (...args) => {
        calls++;
        command = args[2].economyCommand;
        await native(...args);
        throw Error('lost_delivery');
    };
    try {
        await assert.rejects(Workshop.craft(owner.characterId, successRecipe.recipeId, buyer.characterId), error => {
            assert.equal(error.message, 'lost_delivery');
            assert.equal(error.economyCommand, command);
            return true;
        });
    } finally { Database.craftForCustomer = native; }
    assert.equal(calls, 1); assert.equal(Commit.size(), 0);
    const committed = await image([owner.characterId, buyer.characterId]);
    for (const [id, amount] of Profit.requirements(successRecipe)) {
        assert.equal(count(committed[1].items, id), amount * 2, 'leftover stock could fund another attempt');
    }
    assert.equal(count(committed[1].items, successRecipe.productId), successRecipe.productCount);
    const fee = count(before[1].items, 57) - count(committed[1].items, 57);
    assert(fee > 0); assert.equal(count(committed[0].items, 57) - count(before[0].items, 57), fee);
    assert.equal(Number(committed[0].character.mp), Number(before[0].character.mp) - successRecipe.mpCost);
    // Restart and remove the current public quote. Original completion wins
    // before the no-longer-valid quote/material/MP checks.
    await Database.close(); await Database.init(); await Life.init();
    const ownerState = await Life.findByCharacterId(owner.characterId);
    await Life.upsertState({ ...ownerState, stats: { ...ownerState.stats, workshop: null } }, 'quote_removed');
    const frozen = await image([owner.characterId, buyer.characterId]);
    const recovered = await Workshop.craft(owner.characterId, successRecipe.recipeId, buyer.characterId,
        { original: command, expectedPrice: 1, random: () => { throw Error('replay_roll'); } });
    assert(recovered.replayed && recovered.success);
    assert.equal(recovered.spent, fee);
    assert.deepEqual(await image([owner.characterId, buyer.characterId]), frozen);
    const hotOwner = await seed(successRecipe, true), hotBuyer = await seed(successRecipe);
    const hot = await Life.upsertState({ ...hotBuyer, phase: 'hot', timing: { lastHotAt: Date.now() } }, 'hot_customer');
    const hotResult = await Workshop.craft(hotOwner.characterId, successRecipe.recipeId, hot.characterId);
    assert.equal(hotResult.success, true);
    assert.equal(hotResult.customerState.phase, 'hot');
    assert.equal(count(await Database.fetchItems(hot.characterId), successRecipe.productId), successRecipe.productCount);
    const hotCold = await Life.upsertState({ ...Life.cachedState(hot.characterId), phase: 'cold' },
        'customer_handoff', { releaseHot: true });
    const hotReceipt = hotCold.stats.economyCommit;
    const hotOriginal = Commit.header(hotReceipt[2], hotReceipt[3], hotReceipt[0] - 1, Commit.authority(hotCold));
    const handoffBefore = await image([hotOwner.characterId, hot.characterId]);
    const handoffReplay = await Workshop.craft(hotOwner.characterId, successRecipe.recipeId, hot.characterId,
        { original: hotOriginal });
    assert(handoffReplay.replayed); assert.equal(handoffReplay.customerState.phase, 'cold');
    assert.deepEqual(await image([hotOwner.characterId, hot.characterId]), handoffBefore);
    const failedRecipe = Object.values(Recipes.loadRecipeItems()).find(recipe => recipe.type === 'dwarven'
        && recipe.successRate < 100 && recipe.successRate > 0 && recipe.level <= 9);
    assert(failedRecipe, 'authored probabilistic recipe exists');
    const failingOwner = await seed(failedRecipe, true), failingBuyer = await seed(failedRecipe);
    let rolls = 0;
    const failedBefore = await image([failingOwner.characterId, failingBuyer.characterId]);
    const attempt = await Commit.admit(failingBuyer, Commit.KINDS.craft);
    const quote = Workshop.quote(failingOwner, attempt.state, failedRecipe.recipeId);
    const template = Data.items.find(item => Number(item.selfId) === Number(failedRecipe.productId));
    const failed = await Database.craftForCustomer(failingOwner.characterId, failingBuyer.characterId, {
        economyCommand: attempt.command, materials: Profit.materials(await Database.fetchItems(failingBuyer.characterId), failedRecipe),
        product: { selfId: failedRecipe.productId, amount: failedRecipe.productCount, name: template.template.name,
            stackable: !!template.etc?.stackable, slot: Number(template.etc?.slot || 0) },
        price: quote.price, funding: { r: 1 }, random: () => { rolls++; return 0.999999; },
        workshop: { recipeId: failedRecipe.recipeId, batches: 1, entryPrice: quote.entryPrice, fee: quote.price,
            crafterRevision: failingOwner.simulation.revision, customerRevision: attempt.state.simulation.revision }
    });
    Commit.finish(failingBuyer.characterId, attempt.command);
    assert.equal(failed.success, false); assert.equal(failed.units, 0); assert.equal(rolls, 1);
    const failedAfter = await image([failingOwner.characterId, failingBuyer.characterId]);
    assert.equal(count(failedAfter[1].items, failedRecipe.productId), 0);
    for (const [id, amount] of Profit.requirements(failedRecipe)) {
        assert.equal(count(failedBefore[1].items, id) - count(failedAfter[1].items, id), amount);
    }
    const retry = await Commit.admit(Commit.acceptRow(failed.customerState), Commit.KINDS.craft, attempt.command);
    const sameFailure = await Database.craftForCustomer(failingOwner.characterId, failingBuyer.characterId,
        { economyCommand: retry.command, random: () => { rolls++; return 0; } });
    Commit.finish(failingBuyer.characterId, retry.command);
    assert(sameFailure.replayed && sameFailure.success === false);
    assert.equal(rolls, 1); assert.deepEqual(await image([failingOwner.characterId, failingBuyer.characterId]), failedAfter);
    console.log('PASS paid attempt lost reply/restart/removed quote and single native failure roll/payment');
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    await Database.close(); require('node:fs').rmSync(fixture.directory, { recursive: true, force: true });
});
