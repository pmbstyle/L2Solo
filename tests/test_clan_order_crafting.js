const assert = require('assert');
const fs = require('fs');
const http = require('http');
const { once } = require('events');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

require('../src/Global');

const rootDir = path.resolve(__dirname, '..');
const databasePath = path.join(rootDir, 'tmp', 'test-clan-order-crafting.sqlite');
const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const GoalService = invoke('GameServer/Clan/ClanGoalService');
const OrderService = invoke('GameServer/Clan/ClanOrderService');
const PartyService = invoke('GameServer/Clan/ClanPartyService');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const BackgroundPartyState = invoke('GameServer/Bot/Population/BackgroundPartyState');

function removeDatabaseFiles() {
    [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]
        .forEach((file) => fs.rmSync(file, { force: true }));
}

function seedDatabase() {
    removeDatabaseFiles();
    const seed = new DatabaseSync(databasePath);
    seed.exec(fs.readFileSync(path.join(rootDir, 'database', 'sql', 'sqlite.sql'), 'utf8'));
    seed.prepare('INSERT INTO accounts(username, password) VALUES (?, ?)').run('order_player', 'test-only');
    seed.prepare('INSERT INTO accounts(username, password) VALUES (?, ?)').run('bot_pop_order', 'test-only');
    const insertCharacter = seed.prepare(`INSERT INTO characters(
        id, username, name, classId, race, level, maxHp, maxMp,
        sex, face, hair, hairColor, locX, locY, locZ, clanId, clanPrivileges
    ) VALUES (?, ?, ?, ?, 0, ?, 500, 250, 0, 0, 0, 0, 83400, 148600, -3400, 6300001, ?)`);
    insertCharacter.run(5300001, 'order_player', 'OrderLeader', 4, 55, 2047);
    insertCharacter.run(5300002, 'bot_pop_order', 'OrderTank', 4, 52, 0);
    insertCharacter.run(5300003, 'bot_pop_order', 'OrderHealer', 15, 50, 0);
    insertCharacter.run(5300004, 'bot_pop_order', 'OrderBuffer', 17, 51, 0);
    insertCharacter.run(5300005, 'bot_pop_order', 'OrderMage', 22, 53, 0);
    insertCharacter.run(5300006, 'bot_pop_order', 'OrderCrafter', 57, 49, 0);
    seed.prepare('INSERT INTO clans(id, name, level, leaderId) VALUES (6300001, ?, 3, 5300001)').run('OrderClan');
    // A Bounty Hunter outside the clan: Create Item 1, but not a crafter class.
    seed.prepare(`INSERT INTO characters(id, username, name, classId, race, level, maxHp, maxMp,
        sex, face, hair, hairColor, locX, locY, locZ) VALUES (5300007, 'bot_pop_order', 'OrderSpoiler', 55, 4, 60, 500, 250,
        0, 0, 0, 0, 83400, 148600, -3400)`).run();
    const insertLife = seed.prepare(`INSERT INTO bot_life_state(
        characterId, accountName, characterName, level, activity, phase,
        inventorySummary, statsJson, updatedAt
    ) VALUES (?, 'bot_pop_order', ?, ?, 'hunting', 'cold', '{}', ?, 1000)`);
    insertLife.run(5300002, 'OrderTank', 52, JSON.stringify({ generatedCold: true, classId: 4, role: 'tank' }));
    insertLife.run(5300003, 'OrderHealer', 50, JSON.stringify({ generatedCold: true, classId: 15, role: 'healer' }));
    insertLife.run(5300004, 'OrderBuffer', 51, JSON.stringify({ generatedCold: true, classId: 17, role: 'buffer' }));
    insertLife.run(5300005, 'OrderMage', 53, JSON.stringify({ generatedCold: true, classId: 22, role: 'mage' }));
    insertLife.run(5300006, 'OrderCrafter', 49, JSON.stringify({ generatedCold: true, classId: 57, role: 'crafter' }));
    insertLife.run(5300007, 'OrderSpoiler', 60, JSON.stringify({ generatedCold: true, classId: 55, role: 'spoiler' }));
    seed.exec('UPDATE bot_life_state SET hp=500, mp=250, maxHp=500, maxMp=250, locX=83400, locY=148600, locZ=-3400');
    seed.close();
}

async function projection() {
    return GoalService.clanProjectionById(6300001);
}

async function main() {
    seedDatabase();
    options.default.Database.path = path.relative(rootDir, databasePath);
    Database.init(); DataCache.init(); await LifeState.init(); await BackgroundPartyState.init();
    const Recipes = invoke('GameServer/Items/C4RecipeItems');
    const Cold = invoke('GameServer/Bot/Economy/ColdCraftingService');
    const CraftOrders = invoke('GameServer/Clan/ClanOrderCrafting');
    const members = [5300002, 5300003, 5300006];
    const stock = async (selfId, amount) => {
        const item = DataCache.items.find(item => Number(item.selfId) === selfId);
        await Database.execute([`INSERT INTO clan_warehouse_items
            (clanId,selfId,name,kind,amount,createdAt,updatedAt) VALUES (6300001,?,?,?,?,1,1)`,
        [selfId, item.template.name, item.template.kind, amount]]);
    };
    const travelAndCraft = async (customerId, random = () => 0) => {
        let customer = await LifeState.findByCharacterId(customerId);
        if (customer.activity === 'traveling' && customer.stats.travel) {
            customer = await LifeState.upsertState({ ...customer, loc: customer.stats.travel.to,
                activity: customer.stats.travel.arrivalActivity, stats: { ...customer.stats, travel: null } }, 'test_return_arrival');
        }
        const travel = Cold.beginTravel(customer);
        assert(travel, 'a staged manual order must use native travel to its dwarf');
        assert.strictEqual(travel.stats.travel.arrivalActivity, 'crafting');
        customer = await LifeState.upsertState({ ...travel, loc: travel.stats.travel.to, activity: 'crafting',
            stats: { ...travel.stats, travel: null } }, 'test_craft_arrival');
        const result = await Cold.craft(customer, random);
        await LifeState.upsertState(result.state, 'test_craft_completed');
        return result;
    };
    try {
        await Database.syncPlayerManagedClan(6300001);
        const newGoalServer = http.createServer(invoke('WorldObserver/WorldObserverServer').route);
        newGoalServer.listen(0, '127.0.0.1'); await once(newGoalServer, 'listening');
        try {
            assert.strictEqual(await OrderService.current(6300001), null);
            const preview = await fetch(`http://127.0.0.1:${newGoalServer.address().port}/observer/api/clan/6300001/craft-preview`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ itemId: 439, amount: 1, memberIds: members })
            });
            assert.strictEqual(preview.status, 200, 'a new craft goal must preview without an existing manual order or orderId');
            assert.strictEqual((await preview.json()).ok, true);
            assert.strictEqual(await OrderService.current(6300001), null, 'previewing a new goal must not create an order');
        } finally { await new Promise(resolve => newGoalServer.close(resolve)); }
        const invalid = await OrderService.create(await projection(), { itemId: 1419, amount: 1, strategy: 'craft', memberIds: members });
        assert.strictEqual(invalid.code, 'clan_craft_recipe_unavailable');
        const recipe = Recipes.resolveByProductId(1879);
        const noDwarf = await OrderService.create(await projection(), { itemId: 1879, amount: 2, strategy: 'craft', memberIds: [5300002] });
        assert.strictEqual(noDwarf.goal.plan.reasonCode, 'clan_craft_crafter_unavailable');
        assert.strictEqual(noDwarf.order.status, 'blocked');
        const [queued] = await Database.execute(["SELECT actionType FROM clan_actions WHERE clanId = 6300001 AND status = 'pending'", []]);
        assert.strictEqual(queued.actionType, 'goal_plan', 'blocked crafts must be reviewed when roster or stock changes');
        const spoilerPlan = await CraftOrders.planFor({ id: 0, itemId: 1879, memberIds: [5300002, 5300007] },
            { id: 6300001, state: { memberIds: [] } }, 2, { source: null });
        assert.strictEqual(spoilerPlan.craft.crafterName, null, 'a spoiler with Create Item is not a clan crafter');
        assert.strictEqual(spoilerPlan.reasonCode, 'clan_craft_crafter_unavailable');

        await stock(1870, 6); await stock(1871, 6); await stock(recipe.recipeItemId, 1);
        const created = await OrderService.create(await projection(), { itemId: 1879, amount: 2, strategy: 'craft', memberIds: members });
        assert.strictEqual(created.goal.plan.kind, 'craft');
        assert.strictEqual(created.goal.plan.craft.learned, false);
        assert.strictEqual(created.goal.goalKey, `player-order:${created.order.id}:craft`);
        const Observer = invoke('WorldObserver/WorldObserverServer');
        const server = http.createServer(Observer.route);
        server.listen(0, '127.0.0.1'); await once(server, 'listening');
        const url = `http://127.0.0.1:${server.address().port}/observer/api/clan/6300001/craft-preview`;
        try {
            const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ itemId: 1879, amount: 2, orderId: created.order.id, memberIds: members }) });
            assert.strictEqual(response.status, 200);
            const preview = await response.json();
            assert.strictEqual(preview.plan.craft.crafterName, 'OrderCrafter');
            assert(!preview.plan.craft.nativePlan, 'the preview must expose player-facing facts only');
            assert.strictEqual((await OrderService.current(6300001)).revision, created.order.revision, 'previewing cannot change an order');
            assert.strictEqual((await Database.fetchCharacterRecipes(5300006)).length, 0, 'previewing cannot learn recipes');
            assert.strictEqual((await fetch(url)).status, 405);
        } finally { await new Promise(resolve => server.close(resolve)); }

        // Worker-owned carriers must materialize their virtual inputs before
        // switching to the existing main-thread crafting lifecycle.
        await Database.execute([`UPDATE bot_life_state SET simulationOwner = 'cold_simulation_owner',
            simulationRevision = simulationRevision + 1, inventorySummary = ? WHERE characterId = ?`,
        [JSON.stringify({ 1870: { selfId: 1870, name: 'Coal', amount: 3, stackable: true } }), created.goal.plan.craft.customerId]]);
        const assigned = await OrderService.resolveClan(await projection());
        assert.strictEqual(assigned.assignment.ok, true);
        const customerId = assigned.goal.plan.craft.customerId;
        assert.strictEqual((await LifeState.findByCharacterId(customerId)).simulation.ownerId, 'legacy_main');
        const first = await travelAndCraft(customerId);
        assert.strictEqual(first.crafted, true, first.error || first.reason);
        assert((await Database.fetchCharacterRecipes(5300006)).some(row => row.recipeId === recipe.recipeId), 'the actual clan dwarf must learn the scroll');
        assert.strictEqual((await Database.fetchClanWarehouseItems(6300001)).find(row => row.selfId === 1879).amount, 1);
        assert(!(await Database.fetchItems(customerId)).some(row => row.selfId === 1879), 'manual output must stay in the shared warehouse');
        let progress = await OrderService.syncProgress(await projection());
        assert.strictEqual(progress.goal.progress, 1);
        assert.strictEqual(progress.order.status, 'active');
        await OrderService.resolveClan(await projection());
        const staged = await LifeState.findByCharacterId(customerId);
        const paused = await OrderService.transition(await projection(), 'pause', { revision: (await OrderService.current(6300001)).revision });
        const before = (await Database.fetchItems(customerId)).map(row => [row.selfId, row.amount]);
        const rejected = await Cold.craft({ ...staged, activity: 'crafting', loc: first.state.loc });
        assert.strictEqual(rejected.crafted, false, 'a stale cold tick must not craft a paused order');
        assert.match(rejected.error, /order changed/);
        assert.deepStrictEqual((await Database.fetchItems(customerId)).map(row => [row.selfId, row.amount]), before, 'rejected crafts cannot consume inputs');
        await OrderService.transition(await projection(), 'resume', { revision: paused.order.revision });
        await OrderService.resolveClan(await projection());
        const second = await travelAndCraft(customerId);
        assert.strictEqual(second.crafted, true, second.error || second.reason);
        for (const material of recipe.materials) await Database.setItem(customerId, {
            selfId: material.selfId, name: 'Extra input', amount: material.amount, stackable: true, slot: 0 });
        await LifeState.upsertState(await LifeState.refreshInventory(await LifeState.findByCharacterId(customerId)), 'test_extra_inputs');
        const extra = await travelAndCraft(customerId);
        assert.strictEqual(extra.crafted, false);
        assert.match(extra.error, /quantity already reached/, 'the quantity cap must hold even before the next progress review');
        await stock(1870, 3); await stock(1871, 3);
        const beforeExtra = await OrderService.resolveClan(await projection());
        assert.strictEqual(beforeExtra.order.status, 'completed', 'acquired target stock must close the order before another assignment');
        progress = await OrderService.syncProgress(await projection());
        assert.strictEqual(progress.code, 'clan_order_not_active');

        // A recipe tree uses real intermediate crafts before creating output.
        const target = Recipes.resolveByProductId(1884);
        assert(target.materials.some(material => CraftOrders.recipesForItem(material.selfId).length));
        const Policy = invoke('GameServer/Clan/ClanCraftingPolicy');
        for (const [selfId, amount] of Policy.requirements(target)) {
            if (!CraftOrders.recipesForItem(selfId).length) await stock(selfId, amount);
        }
        const root = await OrderService.create(await projection(), { itemId: 1884, amount: 1, strategy: 'craft', memberIds: members }, { source: null });
        // Unknown component recipes correctly request their learning scrolls.
        for (const material of root.goal.plan.craft.materials) {
            if (Recipes.resolve(material.selfId) && material.missing) await stock(material.selfId, material.missing);
        }
        await OrderService.resolveClan(await projection(), { source: null });
        for (let attempt = 0; attempt < 8; attempt++) {
            const current = await OrderService.current(6300001);
            if (!current) break;
            const resolved = await OrderService.resolveClan(await projection(), { source: null });
            assert.strictEqual(resolved.goal.plan.kind, 'craft', JSON.stringify(resolved.goal.plan.craft.materials));
            assert.strictEqual(resolved.assignment.ok, true);
            const result = await travelAndCraft(resolved.goal.plan.craft.customerId);
            assert.strictEqual(result.crafted, true, result.error || result.reason);
            await OrderService.syncProgress(await projection());
        }
        assert.strictEqual(await OrderService.current(6300001), null);
        assert((await Database.fetchClanWarehouseItems(6300001)).some(row => row.selfId === 1884 && row.amount > 0));

        // This native resource recipe has a real 25% success chance. Failure
        // spends inputs and MP without inventing output or progress.
        const chanceRecipe = Recipes.resolveByProductId(3846);
        const dwarf = await LifeState.findByCharacterId(5300006);
        await LifeState.upsertState({ ...dwarf, vitals: { ...dwarf.vitals, mp: 1000, maxMp: 1000 } }, 'test_crafter_rested');
        await Database.setCharacterRecipe(5300006, chanceRecipe.recipeId, chanceRecipe.type);
        for (const material of chanceRecipe.materials) await stock(material.selfId, material.amount * 2);
        const chanceOrder = await OrderService.create(await projection(), { itemId: 3846, amount: 2, strategy: 'craft', memberIds: members });
        assert.strictEqual(chanceOrder.goal.plan.craft.successRate, 25);
        await OrderService.resolveClan(await projection());
        const failed = await travelAndCraft(chanceOrder.goal.plan.craft.customerId, () => 0.99);
        assert.strictEqual(failed.reason, 'craft_failed');
        assert(!(await Database.fetchClanWarehouseItems(6300001)).some(row => row.selfId === 3846));
        const failureProgress = await OrderService.syncProgress(await projection());
        assert.strictEqual(failureProgress.goal.progress, 0);
        await OrderService.resolveClan(await projection());
        const stale = await LifeState.findByCharacterId(chanceOrder.goal.plan.craft.customerId);
        const changed = await OrderService.edit(await projection(), chanceOrder.order.id, {
            revision: (await OrderService.current(6300001)).revision, amount: 3 });
        assert.strictEqual(changed.ok, true);
        const staleCraft = await Cold.craft({ ...stale, activity: 'crafting' });
        assert.strictEqual(staleCraft.crafted, false);
        assert.match(staleCraft.error, /order changed/);
        await OrderService.resolveClan(await projection());
        const success = await travelAndCraft(chanceOrder.goal.plan.craft.customerId);
        assert.strictEqual(success.crafted, true, success.error || success.reason);
        assert.strictEqual((await OrderService.syncProgress(await projection())).goal.progress, 1);

        // Missing raw inputs produce a material-farming plan, never a route to
        // farm the final requested item or buy it as a shortcut.
        const next = await OrderService.create(await projection(), { itemId: 1881, amount: 20, strategy: 'craft', memberIds: members }, {
            source: { npcId: 20101, npcName: 'Material source', npcLevel: 40, spotId: 'test-materials' } });
        assert.strictEqual(next.goal.plan.kind, 'farm');
        assert.strictEqual(next.goal.plan.craft.stage, 'resources');
        assert.strictEqual(next.goal.target.itemId, 1881);
        assert.strictEqual(next.goal.plan.sourceId, 20101);
        assert.notStrictEqual(next.goal.plan.craft.nextItemName, next.order.itemName);

        const armorRecipe = Recipes.resolveByProductId(439);
        for (const material of armorRecipe.materials) {
            if (!Policy.isSupplement(material.selfId)) await stock(material.selfId, material.amount);
        }
        await stock(armorRecipe.recipeItemId, 1);
        const armor = await OrderService.create(await projection(), { itemId: 439, amount: 1, strategy: 'craft', memberIds: members });
        assert.strictEqual(armor.goal.plan.kind, 'craft');
        await OrderService.resolveClan(await projection());
        const madeArmor = await travelAndCraft(armor.goal.plan.craft.customerId);
        assert.strictEqual(madeArmor.crafted, true, madeArmor.error || madeArmor.reason);
        assert((await Database.fetchClanWarehouseItems(6300001)).some(row => row.selfId === 439), 'crafted equipment enters the warehouse first');
        const issued = await OrderService.syncProgress(await projection());
        assert.strictEqual(issued.order.status, 'completed');
        assert.strictEqual(issued.goal.progress, 1, 'equipment progress counts a real issued item');
        const deliveries = await Database.fetchPlayerManagedClanOrderDeliveries({ clanId: 6300001, orderId: armor.order.id, itemId: 439 });
        assert.strictEqual(deliveries.length, 1);
        assert((await Database.fetchItems(deliveries[0].characterId)).some(row => row.selfId === 439 && row.equipped), 'the compatible recipient must equip the crafted armor');
        console.log('Manual clan crafting checks passed');
    } finally { await Database.close(); removeDatabaseFiles(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
