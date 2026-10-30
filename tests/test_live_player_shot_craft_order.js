'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('live-player-shot-order');
require('../src/Global');
fixture.assertConfigured(options.default);
const fs = require('node:fs');
const DB = invoke('Database'), Data = invoke('GameServer/DataCache'), Life = invoke('GameServer/Bot/Population/BotLifeState');
const World = invoke('GameServer/World/World'), Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Manufacture = invoke('GameServer/Crafting/ManufactureShop'), Wishes = invoke('GameServer/Bot/Economy/WishProviders');
const Shopping = invoke('GameServer/Bot/AI/States/ShoppingState'), Hunting = invoke('GameServer/Bot/AI/States/HuntingState');
const Funding = invoke('GameServer/Bot/Economy/PurchaseFunding');
const DecisionEvents = invoke('GameServer/Bot/AI/DecisionEvents');
const { WishNetwork } = require('../src/GameServer/Bot/Economy/WishNetwork');
const Trip = require('../src/GameServer/Bot/Economy/EconomicTrip');
const { POINT, character, stock, sqlAmount, memoryAmount } = require('./helpers/liveMarketActors');
const restores = [];
function stub(object, key, value) {
    const previous = object[key]; object[key] = value;
    restores.push(() => { object[key] = previous; });
}
function refillContext(state) {
    const routing = Trip.prepare(state);
    let step; do { step = routing.next(); } while (!step.done);
    const context = Economy.forState(state, { spots: [], routeRows: step.value, withNodes: true, rememberContext: false });
    // Isolate the refill need from unrelated equipment upgrades. Public
    // providers, native prices, material stock, route and funding stay real.
    const network = new WishNetwork().build({ ...context.projection, roots: ['stock:shots'],
        actorKey: 'native-shot-refill', inputKey: 'native-shot-refill', remembered: false,
        stockFor: context.stockFor, wallet: state.adena, hourAdena: context.hourAdena,
        survivalReserve: context.survivalReserve, persona: context.persona });
    return { ...context, network, statsPacket: { ...context.statsPacket,
        money: Funding.packetFor(network, context.hourAdena, context.survivalReserve) } };
}
// The decision a near body holds: the worker's build with the fields it
// attaches (DecisionEvents.nearFields), as DecisionEvents.receive keeps it.
const near = context => ({ ...context, ...DecisionEvents.nearFields(context, context.state) });
(async () => {
    Data.init(); DB.init(); World.user = { sessions: [], revision: 0 }; await Life.init();
    const Response = invoke('GameServer/Network/Response');
    for (const key of ['userInfo', 'charInfo', 'sitAndStand']) stub(Response, key, () => Buffer.alloc(1));
    const crafter = await character(false, { race: 4, classId: 57, level: 62 }), customer = await character(true);
    const recipe = invoke('GameServer/Items/C4RecipeItems').resolveByRecipeId(20);
    assert.equal(recipe.productId, 1463); assert.equal(recipe.productCount, 156);
    crafter.actor.recipeBook = [recipe]; crafter.actor.craftLevel = 9;
    await DB.setCharacterRecipe(crafter.actor.fetchId(), recipe.recipeId, recipe.type);
    await DB.execute(['UPDATE characters SET mp=1000 WHERE id=?', [crafter.actor.fetchId()]]);
    crafter.actor.storeType = Manufacture.MANUFACTURE_MANAGE;
    assert(Manufacture.publish(crafter, [{ recipeId: recipe.recipeId, price: 50 }]));
    for (const item of invoke('GameServer/Bot/AI/BotGear').planFor({ classId: 1, level: 30 }).items)
        await stock(customer, item.selfId, item.amount || 1, 0, true, item.slot);
    // Half the shot target held, read from the table the bot hunts by: the refill
    // then needs several whole batches at any table's shot use (the one combat
    // core's tables put a level-30 Warrior's two-hour target under the 2500 once held).
    const heldShots = Math.floor(Economy.basics(customer.coldLifeState).stock('shots').target / 2);
    await stock(customer, 1463, heldShots);
    // Materials for every batch the shot target needs: a refill never exceeds the target, and the
    // material stacks only shorten the bag interval the target is sized on.
    const heldBatches = Math.ceil(Economy.basics(customer.coldLifeState).stock('shots').target / recipe.productCount);
    for (const row of recipe.materials) await stock(customer, row.selfId, row.amount * heldBatches);
    const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
    const equipmentPlan = { status: 'deferred', strategy: 'market', target: { selfId: 852, slot: 1 } };
    let state = customer.coldLifeState;
    state = { ...state, stats: { ...state.stats, equipmentPlan,
        coldCombat: Profile.legacySnapshot(state, Profile.skillRecordsFromTree(1, 30)) } };
    customer.coldLifeState = await Life.upsertState(state, 'native_shot_order');
    const context = refillContext(customer.coldLifeState);
    const leaf = context.network.activity;
    assert.equal(leaf.rootKey, 'stock:shots'); assert.equal(leaf.kind, 'craft');
    assert.equal(leaf.workshop.characterId, crafter.actor.fetchId(), 'native price comparison selects the public player workshop');
    assert(leaf.batches > 1, 'this refill needs several whole native batches');
    assert.equal(Wishes.personalCraftPlan(context.state, context), null, 'stock orders do not replace equipment plans');
    const target = Shopping.stockWorkshopTarget(customer, customer.actor, near(context));
    assert.equal(target?.actorId, crafter.actor.fetchId()); assert.equal(target.interactionDistance, 150);
    assert.equal(target.state.stats.equipmentPlan.outputAmount, heldShots + leaf.amount,
        'the refill target includes shots already held exactly once');
    const closed = { ...context, state: { ...context.state, phase: 'cold' } };
    assert.equal(Shopping.stockWorkshopTarget(customer, customer.actor, near(closed)), null, 'cold bots cannot place remote player orders');
    const expensivePrice = 1000000000;
    Manufacture.shop(crafter.actor).entries[0].price = expensivePrice;
    assert.equal(Shopping.stockWorkshopTarget(customer, customer.actor, near(refillContext(customer.coldLifeState))), null,
        'a costly player fee does not turn visibility into an order');
    Manufacture.shop(crafter.actor).entries[0].price = 50;
    assert.equal(Shopping.stockWorkshopTarget(customer, customer.actor,
        near(refillContext({ ...customer.coldLifeState, adena: 0 }))), null, 'an empty wallet cannot fund the order');
    crafter.actor.mp = 0;
    assert.equal(Shopping.stockWorkshopTarget(customer, customer.actor, near(context)), null, 'a crafter without MP cannot receive the visit');
    crafter.actor.mp = 1000;

    customer.coldLifeState = await Life.upsertState({ ...customer.coldLifeState,
        stats: { ...customer.coldLifeState.stats, ...context.statsPacket } }, 'funded_shot_order');
    const selected = { ...context, state: customer.coldLifeState };
    const moves = [];
    customer.actor.moveTo = move => moves.push(move);
    customer.plan = 'hunting';
    const botAI = { getClosestTown: () => ({ name: 'Giran', x: POINT.locX, y: POINT.locY, z: POINT.locZ }), say() {} };
    const compact = new (require('../src/GameServer/Bot/Population/ColdEconomyDecision').CompactActivity)(leaf);
    customer.heldEconomy = { ...near(selected), network: { ...selected.network, activity: compact } };
    assert.equal(Hunting.startWorkshopOrder(customer, customer.actor, botAI, customer.heldEconomy), true);
    assert.equal(customer.plan, 'shopping'); assert.equal(customer.shoppingServicePhase, 'workshop');
    assert.equal(customer.shoppingTarget.actorId, crafter.actor.fetchId()); assert.equal(moves.length, 1);
    assert.deepEqual(customer.coldLifeState.stats.equipmentPlan, equipmentPlan);
    const cash = await sqlAmount(customer, 57), feeWallet = await sqlAmount(crafter, 57), mp = crafter.actor.mp;
    Shopping.tick(customer, customer.actor, {}, botAI);
    const deadline = Date.now() + 5000;
    while (customer.workshopCrafting && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(customer.workshopCrafting, false, 'the visible shopping tick completes its native craft');
    const batches = leaf.batches, fee = 50 * batches, output = heldShots + recipe.productCount * batches;
    assert.equal(await sqlAmount(customer, 1463), output); assert.equal(memoryAmount(customer, 1463), output);
    assert.equal(await sqlAmount(customer, 57), cash - fee); assert.equal(await sqlAmount(crafter, 57), feeWallet + fee);
    assert.equal(crafter.actor.mp, mp - recipe.mpCost * batches);
    for (const row of recipe.materials) assert.equal(await sqlAmount(customer, row.selfId), row.amount * (heldBatches - batches));
    assert.deepEqual(customer.coldLifeState.stats.equipmentPlan, equipmentPlan, 'the stock visit preserves the separate gear plan');
    assert.equal(customer.shoppingTarget, undefined);

    const input = customer.actor.backpack.fetchItemFromSelfId(recipe.materials[0].selfId);
    await DB.updateItemAmount(customer.actor.fetchId(), input.fetchId(), 0); input.setAmount(0);
    customer.shoppingTarget = target; customer.shoppingServicePhase = 'workshop';
    await Shopping.craftAtWorkshop(customer, customer.actor, target);
    assert.equal(customer.shoppingTarget, undefined, 'lost materials release the held visit instead of wedging its tick');
    assert.equal(customer.shoppingServicePhase, undefined);
    assert.equal(await sqlAmount(customer, 57), cash - fee); assert.equal(await sqlAmount(customer, 1463), output,
        'an invalidated visit never spends again');
    console.log(`PASS native player shot order: price-selected workshop, compact hunting decision, physical shopping tick, ${batches} batches, ${fee} adena, exact stock/material/MP changes and budget refusal`);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    for (const restore of restores.reverse()) restore();
    await DB.close(); fs.rmSync(fixture.directory, { recursive: true, force: true });
});
