'use strict';
// Task 4 B5 N5: a failed craft roll spends its inputs and completes nothing.
// The native multi-batch command consumes exactly the materials; one failed
// roll through ColdWealthCraftService.execute (stubbed roll) leaves the goal
// active and the re-derived need asks for the full batch again.
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
Data.init();
const amount = async (id, selfId) => Native.amount(await Database.fetchItems(id), selfId);
const current = async id => Life.acceptLifecycleRow((await Database.execute(['SELECT * FROM bot_life_state WHERE characterId=?', [id]]))[0]);
const goalRow = async id => (await Database.execute(['SELECT goalJson, updatedAt FROM bot_goal_state WHERE characterId=?', [id]]))[0];
const uncertain = Object.values(Recipes.loadRecipeItems()).find(row => row.type === 'dwarven' && row.successRate < 100 && row.mpCost > 0);
const product = () => Data.items.find(row => Number(row.selfId) === Number(uncertain.productId));
const productRow = batches => ({ selfId: uncertain.productId, amount: uncertain.productCount * batches,
    stackable: !!product().etc?.stackable, slot: Number(product().etc?.slot || 0) });

// A crafter that knows the recipe, holds `batches` full input sets and the MP for them, with an active goal for the product.
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
        simulation: { ownerId: 'legacy_main', revision: 0 }, timing: {}, updatedAt: Date.now() }, 'b5_failed_fixture');
    const goal = JSON.stringify({ id: 'craft-target', type: 'buy_craft_material', status: 'active',
        target: { itemId: uncertain.productId, amount: uncertain.productCount * batches }, createdAt: 1, reviewedAt: 1 });
    await Database.execute(['INSERT OR REPLACE INTO bot_goal_state (characterId, goalJson, updatedAt) VALUES (?, ?, ?)', [id, goal, 1]]);
    return materials;
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

    // 1. Native command: a failed roll of three batches consumes exactly the inputs and makes no product.
    const materials = await crafter(1, 3);
    const goalBefore = await goalRow(1);
    const step = await Commit.admit(await current(1), Commit.KINDS.craft);
    let draws = 0;
    const failure = await Database.craftInventoryItems(1, { recipeId: uncertain.recipeId, batches: 3, materials,
        product: productRow(3), economyCommand: step.command, random: () => { draws++; return .999999; } });
    Commit.finish(1, step.command);
    assert.equal(failure.success, false);
    assert.equal(draws, 1);
    for (const m of materials) assert.equal(await amount(1, m.selfId), 0, `failed roll consumes input ${m.selfId}`);
    assert.equal(await amount(1, uncertain.productId), 0, 'failed roll makes no product');
    assert.deepEqual(await goalRow(1), goalBefore, 'the native failure leaves the goal row untouched');

    // 2. ColdWealthCraftService.execute with a stubbed failed roll.
    await crafter(2, 1);
    let state = await current(2);
    const ready = need(state);
    assert.equal(ready.activity?.itemId, uncertain.productId, 'with the inputs held the need is the craft itself');
    assert.equal(ready.missing.size, 0);
    const goal2 = await goalRow(2);
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
    assert.deepEqual(await goalRow(2), goal2, 'a failed wealth roll completes no goal');
    assert.equal(JSON.parse((await goalRow(2)).goalJson).status, 'active');
    state = result.state;
    assert.equal(Number(state.inventory?.[uncertain.productId]?.amount || 0), 0, 'the returned state holds no product');
    const again = need(state);
    assert.notEqual(again.activity?.itemId, uncertain.productId, 'no craft without inputs');
    for (const m of uncertain.materials) {
        assert.equal(again.missing.get(`item:${m.selfId}`), Number(m.amount), `need for ${m.selfId} is back to the full batch`);
    }
    assert.equal(Commit.size(), 0);
    console.log('PASS Task 4 B5 failed craft: inputs consumed, no product, goal active, need back to the full batch');
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    Commit.clear();
    await Database.close();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
});
