'use strict';
// A failed craft roll spends its inputs and completes nothing.
// The native multi-batch command consumes exactly the materials; one failed
// roll through ColdWealthCraftService.execute (stubbed roll) yields no product
// and the re-derived need asks for the full batch again. A workshop craft the
// writer refuses spends nothing and is not retried, cold or hot.
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('task4-b5-failed-craft');
require('../src/Global');
fixture.assertConfigured(options.default);
const Database = invoke('Database');
const Data = invoke('GameServer/DataCache');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const Wealth = invoke('GameServer/Bot/Economy/ColdWealthCraftService');
const Commit = require('../src/GameServer/Bot/Economy/EconomyCommit');
const { WishNetwork } = require('../src/GameServer/Bot/Economy/WishNetwork');
const { freeAmount } = require('../src/GameServer/Bot/Economy/WealthCraftDecision');
const Native = require('./helpers/nativeMarketFixture');
const Workshop = require('../src/GameServer/Bot/Economy/CraftWorkshopService');
const Crafting = invoke('GameServer/Bot/Economy/ColdCraftingService');
const Diagnostics = require('../src/GameServer/Bot/Population/PopulationConfig');
const workshopLoc = { locX: 83396, locY: 147904, locZ: -3400 };
Data.init();
const amount = async (id, selfId) => Native.amount(await Database.fetchItems(id), selfId);
const current = async id => Life.acceptLifecycleRow((await Database.execute(['SELECT * FROM bot_life_state WHERE characterId=?', [id]]))[0]);
const uncertain = Object.values(Recipes.loadRecipeItems()).find(row => row.type === 'dwarven' && row.successRate < 100 && row.mpCost > 0);
const product = () => Data.items.find(row => Number(row.selfId) === Number(uncertain.productId));
const productRow = batches => ({ selfId: uncertain.productId, amount: uncertain.productCount * batches,
    stackable: !!product().etc?.stackable, slot: Number(product().etc?.slot || 0) });

// A crafter that knows the recipe, holds `batches` full input sets and the MP for them.
async function crafter(id, batches) {
    const account = `bot_b5_failed_${id}`;
    await Native.character(Database, id, 'Failed' + id, account);
    await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 10000, stackable: true });
    await Database.setSkill({ selfId: 172, name: 'Create Item', level: 9 }, id);
    await Database.setCharacterRecipe(id, uncertain.recipeId, uncertain.type);
    const materials = [];
    for (const m of uncertain.materials) {
        const row = await Database.setItem(id, { selfId: m.selfId, name: 'Failure material', amount: m.amount * batches });
        materials.push({ id: row.insertId, selfId: m.selfId, amount: m.amount * batches });
    }
    const mp = uncertain.mpCost * batches;
    await Life.upsertState({ characterId: id, accountName: account, name: 'Failed' + id, level: 60, exp: 0, sp: 0,
        adena: 10000, phase: 'cold', activity: 'crafting', homeRegion: 'Giran', currentRegion: 'Giran',
        loc: { x: 83000, y: 148000, z: -3400 }, vitals: { hp: 100, maxHp: 100, mp, maxMp: mp },
        stats: { classId: 57, money: [36000, 0, 0, 0] },
        inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)),
        simulation: { revision: 0 }, timing: {}, updatedAt: Date.now() }, 'b5_failed_fixture');
    return materials;
}

// A workshop owner (knows `recipe`, publishes its listing) or a customer holding three input sets.
async function workshopSeed(id, recipe, owner, { phase = 'cold', activity = 'shopping', equipmentPlan = null } = {}) {
    const account = `bot_b5_workshop_${id}`;
    await Native.character(Database, id, 'B5Workshop' + id, account, workshopLoc);
    await Database.execute(['UPDATE characters SET level=70,hp=1000,mp=1000000,maxMp=1000000,race=4,classId=? WHERE id=?', [owner ? 57 : 0, id]]);
    await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 100000000, stackable: true });
    if (owner) await Database.setCharacterRecipe(id, recipe.recipeId, recipe.type);
    else for (const m of recipe.materials) await Database.setItem(id, { selfId: m.selfId, name: 'Material', amount: m.amount * 3 });
    let state = await Life.upsertState({ characterId: id, accountName: account, name: 'B5Workshop' + id, level: 70, exp: 0, sp: 0,
        adena: 100000000, phase, activity, homeRegion: 'Giran', currentRegion: 'Giran', loc: workshopLoc,
        vitals: { hp: 1000, maxHp: 1000, mp: 1000000, maxMp: 1000000 },
        stats: { classId: owner ? 57 : 0, generatedCold: true, money: [36000, 0, 0, 0], ...(equipmentPlan ? { equipmentPlan } : {}) },
        inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)),
        simulation: { revision: 0 }, timing: phase === 'hot' ? { lastHotAt: Date.now() } : {}, updatedAt: Date.now() }, 'b5_workshop_fixture');
    if (owner) state = await Workshop.publishListing(state);
    return state;
}

// The need for one product batch, derived from the bot's stock the way EconomyContext.stockFor reads it.
function need(state) {
    const keys = uncertain.materials.map(m => ({ key: `item:${m.selfId}`, amount: Number(m.amount) }));
    const nodes = [
        { key: 'power:b5', need: 'power', valueHours: 100, object: { itemId: uncertain.productId },
            paths: [{ requirements: [{ key: `item:${uncertain.productId}`, amount: uncertain.productCount }] }] },
        { key: `item:${uncertain.productId}`, price: 100000, paths: [{ kind: 'craft', activity: 'crafting', costHours: .1,
            itemId: uncertain.productId, productCount: uncertain.productCount, recipeId: uncertain.recipeId,
            grossRequirements: keys, requirements: keys }] },
        ...uncertain.materials.map(m => ({ key: `item:${m.selfId}`, price: 2, paths: [{ kind: 'buy', activity: 'shopping',
            price: 2, itemId: Number(m.selfId), executable: true, quoted: true, availableUnits: 1000 }] }))];
    const result = new WishNetwork().build({ actorKey: `b5-${state.characterId}`, inputKey: `b5-${Date.now()}-${Math.random()}`,
        nodes, roots: ['power:b5'], wallet: 10000, hourAdena: 100, persona: { traits: { commitment: 0 } }, remembered: false,
        stockFor: id => ({ owned: freeAmount(state, state.inventory?.[id] || {}), incoming: Math.max(0, Number(state.acceptedIncoming?.[id] || 0)) }) });
    const attempt = result.plans.get('power:b5').requirements[0].plan;
    return { activity: result.activity, missing: new Map(attempt.requirements.map(row => [row.key, row.amount])) };
}

async function run() {
    assert(uncertain, 'native catalog supplies a probabilistic dwarven recipe');
    Database.init();
    await Life.init();
    Workshop.init();

    // 1. Native command: a failed roll of three batches consumes exactly the inputs and makes no product.
    const materials = await crafter(1, 3);
    const step = await Commit.admit(await current(1), Commit.KINDS.craft);
    let draws = 0;
    const failure = await Database.craftInventoryItems(1, { recipeId: uncertain.recipeId, batches: 3, materials,
        product: productRow(3), economyCommand: step.command, random: () => { draws++; return .999999; } });
    Commit.finish(1, step.command);
    assert.equal(failure.success, false);
    assert.equal(draws, 1);
    for (const m of materials) assert.equal(await amount(1, m.selfId), 0, `failed roll consumes input ${m.selfId}`);
    assert.equal(await amount(1, uncertain.productId), 0, 'failed roll makes no product');

    // 2. ColdWealthCraftService.execute with a stubbed failed roll.
    await crafter(2, 1);
    let state = await current(2);
    const ready = need(state);
    assert.equal(ready.activity?.itemId, uncertain.productId, 'with the inputs held the need is the craft itself');
    assert.equal(ready.missing.size, 0);
    const nativeCraft = Database.craftInventoryItems;
    let rolls = 0;
    Database.craftInventoryItems = (id, args) => nativeCraft.call(Database, id, { ...args, random: () => { rolls++; return .999999; } });
    let result;
    try {
        result = await Wealth.execute(state, { recipe: uncertain, batches: 1, template: product(), r: 1, expectedProfit: 1,
            exit: { type: 'static', town: 'Giran', price: 1, count: 1, buyerName: 'Fixture' },
            basket: { cost: 0, purchases: [], owned: uncertain.materials.map(m => ({ selfId: m.selfId, count: m.amount })) } },
        { stillPrepared: () => true });
    } finally { Database.craftInventoryItems = nativeCraft; }
    assert.equal(result.crafted, false);
    assert.equal(result.reason, 'failed_roll');
    assert.equal(rolls, 1, 'one roll');
    for (const m of uncertain.materials) assert.equal(await amount(2, m.selfId), 0, `execute's failed roll consumes ${m.selfId}`);
    assert.equal(await amount(2, uncertain.productId), 0);
    state = result.state;
    assert.equal(Number(state.inventory?.[uncertain.productId]?.amount || 0), 0, 'the returned state holds no product');
    const again = need(state);
    assert.notEqual(again.activity?.itemId, uncertain.productId, 'no craft without inputs');
    for (const m of uncertain.materials) {
        assert.equal(again.missing.get(`item:${m.selfId}`), Number(m.amount), `need for ${m.selfId} is back to the full batch`);
    }
    assert.equal(Commit.size(), 0);

    // 3. A workshop craft the writer refuses (another writer took the customer's material between the read
    // and the write): rolled back, nothing spent, so it is one refused job and no failed one, cold and hot.
    // Neither caller tries the refused command again through its original token.
    Diagnostics.developerDiagnostics = true;
    const workshopRecipe = Recipes.resolveByRecipeId(1);
    const jobs = () => ({ ...Database.stats().operations['craft:customer'] });
    // The first craftForCustomer of `act` finds one input gone before it writes.
    async function refusedWrite(act) {
        const native = Database.craftForCustomer, before = jobs();
        let first = true;
        Database.craftForCustomer = async (...args) => {
            if (first) {
                first = false;
                const m = args[2].materials[0];
                await Database.execute(['UPDATE items SET amount = 0 WHERE id = ?', [m.id]]);
            }
            return native.apply(Database, args);
        };
        let outcome;
        try { outcome = await act(); } finally { Database.craftForCustomer = native; }
        const after = jobs();
        assert.equal(after.refusals - (before.refusals || 0), 1, 'one refused workshop job');
        assert.equal(after.failures - (before.failures || 0), 0, 'no failed workshop job');
        return outcome;
    }
    const plan = owner => ({ strategy: 'craft', status: 'ready_to_craft', recipeId: workshopRecipe.recipeId,
        amount: workshopRecipe.productCount, valueRate: 1, target: { selfId: workshopRecipe.productId },
        craftProviders: { [workshopRecipe.recipeId]: { workshop: true, characterId: owner.characterId,
            revision: owner.simulation.revision, known: true,
            price: owner.stats.workshop.entries.find(row => row.recipeId === workshopRecipe.recipeId).price } } });
    const coldOwner = await workshopSeed(10, workshopRecipe, true);
    const coldBuyer = await workshopSeed(11, workshopRecipe, false, { activity: 'crafting', equipmentPlan: plan(coldOwner) });
    const coldAdena = await amount(coldBuyer.characterId, 57);
    const refusedCold = await refusedWrite(() => Crafting.craft(coldBuyer, () => 0));
    assert.equal(refusedCold.crafted, false);
    assert.equal(refusedCold.error, 'economy_material_protected');
    assert.equal(await amount(coldBuyer.characterId, 57), coldAdena, 'the refused cold craft charges no fee');
    assert.equal(await amount(coldBuyer.characterId, workshopRecipe.productId), 0);

    const Shopping = invoke('GameServer/Bot/AI/States/ShoppingState');
    const hotOwner = await workshopSeed(12, workshopRecipe, true);
    const hotBuyer = await workshopSeed(13, workshopRecipe, false, { phase: 'hot', equipmentPlan: plan(hotOwner) });
    const wrap = row => ({ ...row, fetchId() { return this.id; }, fetchSelfId() { return this.selfId; },
        fetchAmount() { return this.amount; }, fetchEquipped() { return false; }, setAmount(value) { this.amount = value; } });
    const bag = { items: (await Database.fetchItems(hotBuyer.characterId)).map(wrap), fetchItems() { return this.items; },
        insertItem(id, selfId, row) { this.items.push(wrap({ ...row, id, selfId })); } };
    const actor = { backpack: bag, fetchId: () => hotBuyer.characterId, fetchIsOnline: () => true, fetchName: () => 'B5Hot' };
    const session = { actor, coldLifeState: hotBuyer };
    const selected = Shopping.workshopTarget(session, actor);
    assert(selected?.station.workshop, 'the visible bot goes to its personal workshop provider');
    const hotAdena = await amount(hotBuyer.characterId, 57);
    await refusedWrite(() => Shopping.craftAtWorkshop(session, actor, selected));
    assert.equal(session.workshopOriginal, undefined, 'a refused hot craft keeps no command to recover');
    assert.equal(await amount(hotBuyer.characterId, 57), hotAdena, 'the refused hot craft charges no fee');
    assert.equal(await amount(hotBuyer.characterId, workshopRecipe.productId), 0);
    assert.equal(Commit.size(), 0);
    console.log('PASS Task 4 B5 failed craft: inputs consumed, no product, need back to the full batch; a refused workshop craft is not recovered');
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    Commit.clear();
    await Database.close();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
});
