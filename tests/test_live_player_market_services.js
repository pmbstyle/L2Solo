'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('live-player-services');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
require('../src/Global');
fixture.assertConfigured(options.default);
const DB = invoke('Database'), Data = invoke('GameServer/DataCache'), World = invoke('GameServer/World/World');
const Life = invoke('GameServer/Bot/Population/BotLifeState'), Trade = invoke('GameServer/Bot/TradeService');
const Market = invoke('GameServer/Bot/Economy/MarketOpportunity'), PrivateStore = invoke('GameServer/PrivateStore');
const Workshops = invoke('GameServer/Bot/Economy/CraftWorkshopService');
const Manufacture = invoke('GameServer/Crafting/ManufactureShop'), Shopping = invoke('GameServer/Bot/AI/States/ShoppingState');
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const Commit = invoke('GameServer/Bot/Economy/EconomyCommit');
const Response = invoke('GameServer/Network/Response');
const { POINT, character, stock, sqlAmount, memoryAmount } = require('./helpers/liveMarketActors');
const restores = [];
const stub = (object, key, value) => { const old = object[key]; object[key] = value; restores.push(() => { object[key] = old; }); };
// Routing assertions exercise the ordinary economic choice, not its rare
// exploratory alternatives. Keep the native valuation and weighted choice,
// but hold the roll away from the exploratory tails as the clock changes.
stub(invoke('GameServer/Bot/AI/TendencyRoll'), 'roll', () => 0.5);
for (const name of ['userInfo', 'charInfo', 'sitAndStand']) stub(Response, name, () => Buffer.alloc(1));
function buyOrder(owner, selfId, count, price, enchant = 0) {
    owner.actor.storeType = 4;
    assert.equal(PrivateStore.publishBuy(owner, [{ selfId, count, price, enchant }]), true);
    return owner.actor.store;
}
const amounts = async (session, item) => [await sqlAmount(session, 57), await sqlAmount(session, item),
    memoryAmount(session, 57), memoryAmount(session, item)];
async function saveHot(session, recipe, price = 100) {
    const previous = session.coldLifeState;
    session.coldLifeState = await Life.upsertState({ ...previous, phase: 'hot', accountName: session.accountId,
        stats: { ...previous.stats, money: [77000, 1e-5, 1000, 0, 4e-5, 100000, recipe.productId],
            equipmentPlan: { status: 'active', strategy: 'craft', recipeId: recipe.recipeId,
                target: { selfId: recipe.productId, slot: 0 }, outputAmount: recipe.productCount, valueRate: 4e-5,
                craftProviders: { [recipe.recipeId]: { workshop: true, characterId: crafter.actor.fetchId(), price } } } },
        timing: { lastHotAt: Date.now() } }, 'live_workshop_fixture');
    assert(session.coldLifeState && Life.hotRow(session.actor.fetchId()));
}
let crafter;

(async () => {
    Data.init(); DB.init(); World.user = { sessions: [], revision: 0 }; await Life.init();
    const player = await character(), seller = await character(true), rival = await character(true);
    const source = await stock(seller, 1864, 10);
    const otherSource = await stock(rival, 1864, 10);
    // Run the town tick through buyer selection, pausing at the navigation
    // boundary. Other purchase plans are irrelevant to this sale visit.
    const tickRestores = restores.length;
    stub(invoke('GameServer/Bot/Economy/BotImprovementService'), 'chosen', () => null);
    stub(invoke('GameServer/Bot/Economy/WishProviders'), 'personalCraftPlan', () => null);
    stub(invoke('GameServer/Bot/AI/TownNpcApproach'), 'plan', () => ({ ready: false }));
    stub(invoke('GameServer/Bot/AI/CompanionNavigationRecovery'), 'move', () => ({ status: 'started' }));
    const selectCounter = () => {
        seller.shoppingTarget = undefined;
        seller.shoppingLiveBuyerChecked = undefined;
        seller.shoppingEquipmentPlanChecked = true;
        seller.shoppingWarehouseDone = true;
        Shopping.tick(seller, seller.actor, {}, { getClosestTown: () => ({ name: 'Giran' }), say() {} });
        return seller.shoppingTarget;
    };
    try {
        const unchanged = [await amounts(player, 1864), await amounts(seller, 1864)];
        assert(selectCounter()?.npcSelfId > 0, 'without player buy stores a normal shopping tick continues to the town merchant');
        buyOrder(player, 1864, 5, 1);
        assert(selectCounter()?.npcSelfId > 0, 'an unattractive player bid also leaves the ordinary merchant route available');
        buyOrder(player, 1864, 5, 10000);
        const counter = selectCounter();
        assert.equal(counter?.actorId, player.actor.fetchId(), 'the town tick selects a profitable live player buy store');
        assert.equal(counter.liveBuyer, true);
        assert.equal(counter.sale[1864], 5);
        assert.deepEqual([await amounts(player, 1864), await amounts(seller, 1864)], unchanged,
            'choosing a counter moves no money or items before arrival');
    } finally {
        while (restores.length > tickRestores) restores.pop()();
        seller.shoppingTarget = undefined;
        seller.shoppingLiveBuyerChecked = undefined;
    }
    let store = buyOrder(player, 1864, 5, 10000);
    const selected = Trade.findAfkBuyerForActor(seller.actor, { name: 'Giran' }, seller.coldLifeState);
    assert.equal(selected?.offer.sourceId, player.actor.fetchId(), 'native disposition selects the profitable public player bid');
    assert.equal(selected.offer.sourceType, 'private_buy_store');
    assert.equal(selected.sale[1864], 5);
    assert(!Trade.findAfkBuyerForActor(seller.actor, { name: 'Dion' }, seller.coldLifeState), 'a normal buy store is local');
    store.items[0].price = 1;
    assert(!Trade.findAfkBuyerForActor(seller.actor, { name: 'Giran' }, seller.coldLifeState), 'native disposition rejects a poor buy quote');
    store.items[0].price = 10000;
    const beforePlayer = await amounts(player, 1864), beforeSeller = await amounts(seller, 1864);
    seller.shoppingTarget = { ...Market.offerTarget(selected.offer), sale: selected.sale };
    // The visit's NPC junk sale of what the buyer left is not this sale's subject.
    const junkFile = require.resolve('../src/GameServer/World/Generics/NpcBypasses/SellJunk');
    require(junkFile); stub(require.cache[junkFile], 'exports', () => Promise.resolve());
    let continued = 0; stub(Shopping, 'scheduleRestock', () => { continued++; });
    await Shopping.sellAndRestock(seller, seller.actor, {}, { say() {} });
    assert.equal(continued, 1);
    assert.deepEqual(await amounts(player, 1864), [beforePlayer[0] - 50000, 5, beforePlayer[2] - 50000, 5]);
    assert.deepEqual(await amounts(seller, 1864), [beforeSeller[0] + 50000, 5, beforeSeller[2] + 50000, 5]);
    assert.equal(player.actor.storeType, 0);
    store = buyOrder(player, 1864, 5, 10000);
    const race = await Promise.allSettled([[seller, source], [rival, otherSource]].map(([session, id]) =>
        Trade.sellToStore(session.actor, store, 1864, 5, { objectId: id, expectedUnitPrice: 10000 })));
    assert.equal(race.filter(row => row.status === 'fulfilled').length, 1, 'the finite buy order fills once');
    assert.equal(await sqlAmount(player, 1864), 10);
    const actualSeller = memoryAmount(seller, 1864) ? seller : rival;
    const actualSource = actualSeller.actor.backpack.fetchItemFromSelfId(1864);
    store = buyOrder(player, 1864, 3, 10000);
    const frozen = [await amounts(player, 1864), await amounts(actualSeller, 1864)];
    const nativeBuy = DB.buyFromLivePrivateStore;
    DB.buyFromLivePrivateStore = (id, details) => { store.items[0].price++; return nativeBuy(id, details); };
    try { await assert.rejects(Trade.sellToStore(actualSeller.actor, store, 1864, 1,
        { objectId: actualSource.fetchId(), expectedUnitPrice: 10000 }), /private_store_changed/); }
    finally { DB.buyFromLivePrivateStore = nativeBuy; store.items[0].price = 10000; }
    assert.deepEqual([await amounts(player, 1864), await amounts(actualSeller, 1864)], frozen);
    player.actor.storeType = 0;
    await assert.rejects(Trade.sellToStore(actualSeller.actor, store, 1864, 1, { objectId: actualSource.fetchId() }), /private_store_changed/);
    player.actor.storeType = 3;
    actualSeller.actor.point.locX += 1000;
    await assert.rejects(Trade.sellToStore(actualSeller.actor, store, 1864, 1, { objectId: actualSource.fetchId() }), /private_store_changed/);
    actualSeller.actor.point = { ...POINT };
    const cash = player.actor.backpack.fetchItemFromSelfId(57);
    await DB.updateItemAmount(player.actor.fetchId(), cash.fetchId(), 1); cash.setAmount(1);
    assert.equal(Trade.findAfkBuyerForActor(actualSeller.actor, { name: 'Giran' }, actualSeller.coldLifeState), null,
        'a player with no money cannot attract a bot seller');
    await assert.rejects(Trade.sellToStore(actualSeller.actor, store, 1864, 1, { objectId: actualSource.fetchId() }), /not_enough_adena/);
    assert.equal(await sqlAmount(player, 1864), 10, 'budget refusal moves no goods');

    // Real player manufacture, public lookup, native bot command and SQLite settlement.
    crafter = await character(false, { race: 4, classId: 57, level: 62 });
    const customer = await character(true);
    const recipe = Recipes.resolveByRecipeId(1);
    crafter.actor.craftLevel = 9;
    crafter.actor.recipeBook = [recipe];
    await DB.setCharacterRecipe(crafter.actor.fetchId(), recipe.recipeId, recipe.type);
    await DB.execute(['UPDATE characters SET mp=1000 WHERE id=?', [crafter.actor.fetchId()]]);
    for (const row of recipe.materials) await stock(customer, row.selfId, row.amount * 4);
    crafter.actor.storeType = Manufacture.MANUFACTURE_MANAGE;
    assert.equal(Manufacture.publish(crafter, [{ recipeId: recipe.recipeId, price: 100 }]), true);
    await saveHot(customer, recipe);
    const row = [...Workshops.publicForRecipe(recipe.recipeId, customer.coldLifeState)].find(entry => entry.playerWorkshop);
    assert.equal(row?.characterId, crafter.actor.fetchId()); assert.equal(row.price, 100);
    assert(![...Workshops.publicForRecipe(recipe.recipeId, { ...customer.coldLifeState, phase: 'cold' })].some(entry => entry.playerWorkshop),
        'cold bots cannot settle a live player order remotely');
    const target = Shopping.workshopTarget(customer, customer.actor);
    assert.equal(target?.actorId, crafter.actor.fetchId()); assert.equal(target.interactionDistance, 150);
    const mp = crafter.actor.fetchMp(), wallet = await sqlAmount(customer, 57), feeWallet = await sqlAmount(crafter, 57);
    const admit = Commit.admit; let header;
    Commit.admit = async (...args) => { const result = await admit(...args); header = result.command; return result; };
    const made = await Workshops.craft(crafter.actor.fetchId(), recipe.recipeId, customer.actor.fetchId(),
        { expectedPrice: 100, batches: 1, funding: { r: 4e-5 }, random: () => 0 });
    Commit.admit = admit;
    assert.equal(made.committed, true); assert.equal(made.success, true);
    assert.equal(await sqlAmount(customer, recipe.productId), recipe.productCount);
    assert.equal(memoryAmount(customer, recipe.productId), recipe.productCount);
    assert.equal(await sqlAmount(customer, 57), wallet - 100); assert.equal(await sqlAmount(crafter, 57), feeWallet + 100);
    assert.equal(memoryAmount(customer, 57), wallet - 100); assert.equal(memoryAmount(crafter, 57), feeWallet + 100);
    assert.equal(crafter.actor.fetchMp(), mp - recipe.mpCost);
    const [durableMp] = await DB.execute(['SELECT mp FROM characters WHERE id=?', [crafter.actor.fetchId()]]);
    assert.equal(durableMp.mp, mp - recipe.mpCost);
    for (const row of recipe.materials) assert.equal(await sqlAmount(customer, row.selfId), row.amount * 3);
    const twice = await Workshops.craft(crafter.actor.fetchId(), recipe.recipeId, customer.actor.fetchId(),
        { expectedPrice: 100, batches: 2, funding: { r: 4e-5 }, random: () => 0 });
    assert.equal(twice.units, recipe.productCount * 2);
    assert.equal(await sqlAmount(customer, recipe.productId), recipe.productCount * 3);
    assert.equal(await sqlAmount(customer, 57), wallet - 300);
    assert.equal(crafter.actor.fetchMp(), mp - recipe.mpCost * 3);
    for (const row of recipe.materials) assert.equal(await sqlAmount(customer, row.selfId), row.amount);
    const digest = Workshops.publicRecipeDigest(recipe.productId);
    Manufacture.shop(crafter.actor).entries[0].price = 101;
    assert.equal([...Workshops.publicForRecipe(recipe.recipeId, customer.coldLifeState)].find(entry => entry.playerWorkshop)?.price, 101,
        'a hot customer reads the repriced player workshop');
    assert.equal(Workshops.publicRecipeDigest(recipe.productId), digest,
        'a player workshop stays out of the bot digest the worker mirrors (meeting proofs stay current)');
    await assert.rejects(Workshops.craft(crafter.actor.fetchId(), recipe.recipeId, customer.actor.fetchId(),
        { expectedPrice: 100, funding: { r: 4e-5 } }), /workshop price changed/);
    Manufacture.shop(crafter.actor).entries[0].price = 100;
    const currentMp = crafter.actor.mp;
    crafter.actor.mp = 0;
    assert(!Workshops.lookup(crafter.actor.fetchId(), recipe.recipeId, customer.coldLifeState), 'a player without MP is not an available workshop');
    crafter.actor.mp = currentMp;
    customer.actor.point.locX += 1000;
    await assert.rejects(Workshops.craft(crafter.actor.fetchId(), recipe.recipeId, customer.actor.fetchId(),
        { expectedPrice: 100, funding: { r: 4e-5 } }), /player_workshop_unavailable/);
    customer.actor.point = { ...POINT };
    customer.coldLifeState.stats.money = [77000, 1, 1000000, 0];
    const frozenCraft = [await amounts(customer, recipe.productId), await amounts(crafter, recipe.productId), crafter.actor.mp];
    await assert.rejects(Workshops.craft(crafter.actor.fetchId(), recipe.recipeId, customer.actor.fetchId(),
        { expectedPrice: 100, funding: { r: 1e-9 } }), error => {
        assert.equal(error.economyCommand, undefined, 'a refused live craft must not enter a replay loop');
        return /player_workshop_unavailable/.test(error.message);
    });
    assert.deepEqual([await amounts(customer, recipe.productId), await amounts(crafter, recipe.productId), crafter.actor.mp], frozenCraft);
    crafter.actor.storeType = 0;
    assert(!Workshops.find(recipe.recipeId, customer.coldLifeState), 'closing manufacture removes the public recipe');

    // Replay the most recent completed native identity even after the owner
    // closed shop. A replay must consume neither another fee nor materials.
    // A pending refused command intentionally has no completion to replay;
    // exercise a fresh actual completion and retain its original header.
    crafter.actor.storeType = Manufacture.MANUFACTURE;
    await saveHot(customer, recipe);
    Commit.admit = async (...args) => { const result = await admit(...args); header = result.command; return result; };
    const last = await Workshops.craft(crafter.actor.fetchId(), recipe.recipeId, customer.actor.fetchId(),
        { expectedPrice: 100, funding: { r: 4e-5 }, random: () => 0 });
    Commit.admit = admit;
    assert.equal(last.success, true);
    crafter.actor.storeType = 0;
    const completed = [await amounts(customer, recipe.productId), await amounts(crafter, recipe.productId), crafter.actor.mp];
    const replay = await Workshops.craft(crafter.actor.fetchId(), recipe.recipeId, customer.actor.fetchId(), { original: header });
    assert.equal(replay.replayed, true);
    assert.deepEqual([await amounts(customer, recipe.productId), await amounts(crafter, recipe.productId), crafter.actor.mp], completed);

    // Drive the visible workshop executor, rather than stopping at its target.
    const nextCustomer = await character(true);
    for (const row of recipe.materials) await stock(nextCustomer, row.selfId, row.amount);
    crafter.actor.storeType = Manufacture.MANUFACTURE;
    await saveHot(nextCustomer, recipe);
    const visibleTarget = Shopping.workshopTarget(nextCustomer, nextCustomer.actor);
    await Shopping.craftAtWorkshop(nextCustomer, nextCustomer.actor, visibleTarget);
    assert.equal(await sqlAmount(nextCustomer, recipe.productId), recipe.productCount);
    assert.equal(nextCustomer.workshopOriginal, undefined);
    assert.equal(nextCustomer.shoppingTarget, undefined);

    const rollbackCustomer = await character(true);
    for (const row of recipe.materials) await stock(rollbackCustomer, row.selfId, row.amount);
    await saveHot(rollbackCustomer, recipe);
    const stableCraft = [await amounts(rollbackCustomer, recipe.productId), await amounts(crafter, recipe.productId), crafter.actor.mp];
    const control = new DatabaseSync(fixture.world);
    try {
        control.exec(`CREATE TRIGGER reject_player_craft_fee BEFORE UPDATE OF amount ON items
            WHEN NEW.characterId=${crafter.actor.fetchId()} AND NEW.selfId=57
            BEGIN SELECT RAISE(ABORT,'injected_craft_credit_failure'); END`);
        await assert.rejects(Workshops.craft(crafter.actor.fetchId(), recipe.recipeId, rollbackCustomer.actor.fetchId(),
            { expectedPrice: 100, funding: { r: 4e-5 }, random: () => 0 }), /player_workshop_unavailable/);
        assert.deepEqual([await amounts(rollbackCustomer, recipe.productId), await amounts(crafter, recipe.productId), crafter.actor.mp], stableCraft);
        for (const row of recipe.materials) assert.equal(await sqlAmount(rollbackCustomer, row.selfId), row.amount);
        control.exec('DROP TRIGGER reject_player_craft_fee');
    } finally { control.close(); }
    const nativeCraft = DB.craftForCustomer;
    DB.craftForCustomer = (owner, buyer, details) => {
        Manufacture.shop(crafter.actor).entries[0].price = 101;
        return nativeCraft(owner, buyer, details);
    };
    try {
        await assert.rejects(Workshops.craft(crafter.actor.fetchId(), recipe.recipeId, rollbackCustomer.actor.fetchId(),
            { expectedPrice: 100, funding: { r: 4e-5 }, random: () => 0 }), /player_workshop_unavailable/);
    } finally { DB.craftForCustomer = nativeCraft; Manufacture.shop(crafter.actor).entries[0].price = 100; }
    assert.deepEqual([await amounts(rollbackCustomer, recipe.productId), await amounts(crafter, recipe.productId), crafter.actor.mp], stableCraft,
        'native transaction revalidates the public price after asynchronous admission');

    // A real authored 60% recipe charges the fee and MP on a failed roll,
    // consumes its materials, and gives no product.
    const uncertain = Object.values(Recipes.loadRecipeItems()).find(entry => entry.successRate === 60 && entry.type === 'dwarven');
    assert(uncertain);
    const unlucky = await character(true);
    for (const row of uncertain.materials) await stock(unlucky, row.selfId, row.amount);
    crafter.actor.recipeBook.push(uncertain);
    await DB.setCharacterRecipe(crafter.actor.fetchId(), uncertain.recipeId, uncertain.type);
    crafter.actor.storeType = Manufacture.MANUFACTURE_MANAGE;
    assert(Manufacture.publish(crafter, [{ recipeId: uncertain.recipeId, price: 10 }]));
    await saveHot(unlucky, uncertain, 10);
    const oldMp = crafter.actor.mp, oldFee = await sqlAmount(crafter, 57), oldCash = await sqlAmount(unlucky, 57);
    let rolls = 0;
    const failed = await Workshops.craft(crafter.actor.fetchId(), uncertain.recipeId, unlucky.actor.fetchId(),
        { expectedPrice: 10, funding: { r: 4e-5 }, random: () => { rolls++; return .99; } });
    assert.equal(failed.committed, true); assert.equal(failed.success, false); assert.equal(rolls, 1);
    assert.equal(await sqlAmount(unlucky, uncertain.productId), 0);
    assert.equal(await sqlAmount(unlucky, 57), oldCash - 10); assert.equal(await sqlAmount(crafter, 57), oldFee + 10);
    assert.equal(crafter.actor.mp, oldMp - uncertain.mpCost);
    for (const row of uncertain.materials) assert.equal(await sqlAmount(unlucky, row.selfId), 0);
    console.log('PASS player services: profitable local buy orders, budget/race/stale guards, native player workshop discovery, paid craft, MP/material conservation and refusal');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    for (const restore of restores.reverse()) restore();
    await DB.close(); fs.rmSync(fixture.directory, { recursive: true, force: true });
});
