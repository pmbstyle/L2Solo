const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
require('./helpers/databaseIsolation');
const { DatabaseSync } = require('node:sqlite');
const isolated = require('./helpers/isolatedSocialDatabase')('clan-production-physical');
require('../src/Global');
isolated.assertConfigured(options.default);
const Cache = invoke('GameServer/DataCache');
Cache.init();
const Database = invoke('Database');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Policy = invoke('GameServer/Clan/ClanCraftingPolicy');
const Warehouse = invoke('GameServer/Clan/ClanWarehouseService');
const WarehousePolicy = invoke('GameServer/Clan/ClanWarehousePolicy');
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const Equipment = invoke('GameServer/Clan/ClanEquipmentService');
const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const Craft = invoke('GameServer/Bot/Economy/ColdCraftingService');
const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const root = path.resolve(__dirname, '..');
const dbPath = isolated.world;
const ids = [4910001, 4910002, 4910003];
const cleanup = () => [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].forEach(file => fs.rmSync(file, { force: true }));
const query = (sql, args = []) => Database.execute([sql, args]);

async function main() {
    cleanup();
    const seed = new DatabaseSync(dbPath);
    seed.exec(fs.readFileSync(path.join(root, 'database/sql/sqlite.sql'), 'utf8'));
    seed.prepare('INSERT INTO accounts(username,password) VALUES (?,?)').run('bot_production_test', 'test');
    for (const [index, id] of ids.entries()) {
        const classId = index === 1 ? 57 : 4;
        seed.prepare(`INSERT INTO characters(id,username,name,classId,race,level,maxHp,maxMp,
            sex,face,hair,hairColor,locX,locY,locZ) VALUES (?,'bot_production_test',?,?,0,62,1000,1000,0,0,0,0,100,100,0)`)
            .run(id, `Production${index}`, classId);
        seed.prepare(`INSERT INTO bot_life_state(characterId,accountName,characterName,level,activity,phase,
            locX,locY,locZ,hp,mp,maxHp,maxMp,inventorySummary,statsJson,updatedAt)
            VALUES (?,'bot_production_test',?,62,'hunting','cold',100,100,0,1000,1000,1000,1000,'{}',?,1)`)
            .run(id, `Production${index}`, JSON.stringify({ classId, generatedCold: true }));
    }
    seed.close();
    Database.init();
    await Life.init();
    try {
        const created = await Database.createAutonomousClan({ name: 'ProductionClan', leaderId: ids[0], memberIds: ids,
            founderQuorum: 3, maxBotClans: 40, maxBotMemberShare: 1, stateJson: { level: 0 } });
        assert(created.ok);
        const clanId = created.clanId;
        const projection = () => invoke('GameServer/Clan/ClanGoalService').clanProjectionById(clanId);
        const add = async (id, selfId, amount) => {
            await Database.setItem(id, { selfId, name: Cache.items.find(item => Number(item.selfId) === selfId)?.template?.name || 'Ingredient', amount, stackable: true, slot: 0 });
        };
        assert(Policy.isResource(1864));
        assert(Policy.isResource(5552));
        assert(!Policy.isResource(1896));
        assert(!Policy.isResource(1458));
        const items = [{ id: 1, selfId: 1864, amount: 20 }, { id: 2, selfId: 2005, amount: 5 }];
        assert.deepEqual(WarehousePolicy.depositCandidates({}, items, []).map(item => item.selfId), [1864]);
        assert.equal(WarehousePolicy.depositCandidates({}, items, [], { demand: { 2005: 2 } })[1].amount, 2);
        assert.equal(WarehousePolicy.depositCandidates({}, items, [{ selfId: 2005, amount: 2 }], { demand: { 2005: 2 } }).length, 1);
        const scrolls = [{ id: 3, selfId: 1786, amount: 5 }];
        assert.equal(WarehousePolicy.depositCandidates({}, scrolls, [], { demand: { 1786: 2 } })[0].amount, 2);
        const personal = { clanId, level: 62, stats: { equipmentPlan: { strategy: 'craft', status: 'active',
            recipeId: 2, materials: [{ selfId: 1869, amount: 18 }] } }, inventory: { 1869: { selfId: 1869, amount: 50 } } };
        assert(Policy.isPersonalCraft(personal));
        assert(!Craft.beginTravel(personal));
        assert.equal(Disposition.saleCandidates(personal).length, 0);
        assert.equal(Planner.finalizePlan(personal, null, personal.stats.equipmentPlan).strategy, 'none');

        // ARCH-NOTE: Shared raw inputs are allocated once. The approved
        // physical-input rule includes crystals and gemstones in full demand.
        const chain = Recipes.resolveByProductId(1880);
        const rootRecipe = { recipeId: 999999, materials: [
            { selfId: 1880, amount: 2 }, { selfId: 1458, amount: 99 }, { selfId: 2130, amount: 7 }
        ] };
        const requirements = Policy.requirements(rootRecipe, { 1880: { selfId: 1880, amount: 1 } });
        assert.equal(requirements.get(1880), 2);
        assert.equal(requirements.get(1458), 99);
        assert.equal(requirements.get(2130), 7);
        for (const material of chain.materials) assert(requirements.get(material.selfId) >= material.amount);
        const partial = { 1458: { selfId: 1458, amount: 98 }, 2130: { selfId: 2130, amount: 6 } };
        const held = structuredClone(partial);
        assert.deepEqual(Policy.warehouseMaterials({ materials: rootRecipe.materials }, partial, [
            { selfId: 1458, amount: 5, reservedAmount: 3 }, { selfId: 2130, amount: 2 }
        ]), [{ selfId: 1458, amount: 1 }, { selfId: 2130, amount: 1 }],
        'the clan must withdraw the physical missing crystal and gemstone units without spending reservations');
        assert.deepEqual(partial, held, 'planning must not grant or consume any owned input');
        const pooled = Policy.stockInventory({}, [{ selfId: 1869, kind: 'Other.Material', amount: 20, reservedAmount: 3 }]);
        assert.equal(pooled[1869].amount, 17);

        // Level zero and level four both collect resources. Party membership and
        // worker ownership must survive an atomic, revision-fenced deposit.
        await add(ids[2], 1864, 20);
        await add(ids[2], 2005, 5);
        let clan = await projection();
        assert((await Warehouse.resolveClan(clan, { batchSize: 8 })).deposited > 0);
        assert.equal((await Database.fetchClanWarehouseItems(clanId)).find(row => row.selfId === 1864).amount, 20);
        assert.equal((await Database.fetchItems(ids[2])).find(row => row.selfId === 2005).amount, 5);
        await query('UPDATE clans SET level = 4 WHERE id = ?', [clanId]);
        await add(ids[2], 1870, 30);
        await query("UPDATE bot_life_state SET partyId = 'production-party' WHERE characterId = ?", [ids[2]]);
        clan = await projection();
        assert((await Warehouse.resolveClan(clan, { batchSize: 8 })).deposited > 0);
        const [partyState] = await query('SELECT partyId,simulationRevision FROM bot_life_state WHERE characterId = ?', [ids[2]]);
        assert.equal(partyState.partyId, 'production-party');
        assert(partyState.simulationRevision > 0);
        const coal = (await Database.fetchClanWarehouseItems(clanId)).find(row => row.selfId === 1870);
        assert.equal(coal.amount, 30);

        // Worker-owned virtual inventory is materialized before collection;
        // stale revisions cannot replay a deposit or lose unmaterialized units.
        await query(`UPDATE bot_life_state SET partyId = NULL, simulationOwner = 'cold_simulation_owner',
            inventorySummary = ? WHERE characterId = ?`, [JSON.stringify({ 1864: { selfId: 1864, name: 'Stem', amount: 37, stackable: true } }), ids[2]]);
        clan = await projection();
        await Warehouse.resolveClan(clan, { batchSize: 8 });
        assert.equal((await Database.fetchClanWarehouseItems(clanId)).find(row => row.selfId === 1864).amount, 57);
        const [workerState] = await query('SELECT simulationOwner,inventorySummary FROM bot_life_state WHERE characterId = ?', [ids[2]]);
        assert.equal(workerState.simulationOwner, 'cold_simulation_owner');
        assert.equal(JSON.parse(workerState.inventorySummary)[1864].amount, 0);
        await Warehouse.resolveClan(clan, { batchSize: 8 });
        assert.equal((await Database.fetchClanWarehouseItems(clanId)).find(row => row.selfId === 1864).amount, 57);
        await query("UPDATE bot_life_state SET simulationOwner = 'legacy_main' WHERE characterId = ?", [ids[2]]);

        // The visible bot uses its real backpack and the native warehouse transaction.
        await add(ids[2], 1865, 11);
        await query("UPDATE bot_life_state SET phase = 'hot', partyId = NULL WHERE characterId = ?", [ids[2]]);
        const Item = invoke('GameServer/Item/Item');
        const manager = invoke('GameServer/Bot/BotManager');
        const findSession = manager.findSessionById;
        const hotItems = (await Database.fetchItems(ids[2])).map(row => new Item(row.id, { ...row, kind: 'Other.Material' }));
        const hotSession = { actor: { fetchClanId: () => clanId, backpack: { items: hotItems, fetchItems() { return this.items; } } } };
        manager.findSessionById = id => Number(id) === ids[2] ? hotSession : null;
        try {
            await Warehouse.resolveClan(await projection(), { batchSize: 8 });
            assert.equal((await Database.fetchClanWarehouseItems(clanId)).find(row => row.selfId === 1865).amount, 11);
            assert(!hotSession.actor.backpack.items.some(item => item.fetchSelfId() === 1865));
            assert(hotSession.actor.backpack.items.some(item => item.fetchSelfId() === 2005), 'unrequested pieces stay in the backpack');
        } finally { manager.findSessionById = findSession; }
        await query("UPDATE bot_life_state SET phase = 'cold' WHERE characterId = ?", [ids[2]]);

        // A real clan crafter unlocks a recipe outside the public catalogue.
        await query("UPDATE bot_life_state SET partyId = NULL WHERE characterId = ?", [ids[2]]);
        await query("UPDATE bot_life_state SET simulationOwner = 'cold_simulation_owner', inventorySummary = ? WHERE characterId = ?",
            [JSON.stringify({ 1870: { selfId: 1870, amount: 19, name: 'Coal', stackable: true } }), ids[1]]);
        Life.acceptClanCraftState((await query('SELECT * FROM bot_life_state WHERE characterId = ?', [ids[1]]))[0]);
        clan = await projection();
        const capabilities = await Equipment.craftingOptions(clan);
        assert(capabilities.craftProviders[2]);
        assert.equal(capabilities.craftProviders[2].known, false);
        const recipe = Recipes.resolveByRecipeId(2);
        for (const material of recipe.materials) await add(ids[0], material.selfId, material.amount);
        await add(ids[0], recipe.recipeItemId, 1);
        let customer = await Life.findByCharacterId(ids[0]);
        customer = await Life.refreshInventory(customer);
        customer = await Life.upsertState({ ...customer, activity: 'crafting', stats: { ...customer.stats, clanId,
            equipmentPlan: { status: 'ready_to_craft', strategy: 'craft', recipeId: 2, target: { selfId: 3, slot: 7 },
                clanGoal: { clanId, goalKey: 'production-test', beneficiaryId: ids[0] },
                craftProviders: { 2: capabilities.craftProviders[2] } } } }, 'clan_equipment_goal');
        const beforeMp = (await Life.findByCharacterId(ids[1])).vitals.mp;
        const beforeItems = await Database.fetchItems(ids[0]);
        const amountFor = (rows, selfId) => rows.filter(row => Number(row.selfId) === Number(selfId))
            .reduce((total, row) => total + Number(row.amount), 0);
        const result = await Craft.craft(customer, () => 0);
        assert(result.crafted, JSON.stringify(result));
        assert((await Database.fetchCharacterRecipes(ids[1])).some(row => Number(row.recipeId) === 2));
        assert(!(await Database.fetchItems(ids[0])).some(row => Number(row.selfId) === recipe.recipeItemId && row.amount > 0));
        assert((await Database.fetchItems(ids[0])).some(row => Number(row.selfId) === 3 && row.amount === 1));
        const afterItems = await Database.fetchItems(ids[0]);
        for (const material of recipe.materials) {
            assert.equal(amountFor(beforeItems, material.selfId) - amountFor(afterItems, material.selfId), material.amount,
                `native clan manufacture consumes exactly the authored input ${material.selfId}`);
        }
        assert.equal((await Life.findByCharacterId(ids[1])).vitals.mp, beforeMp - recipe.mpCost);
        assert.equal((await Life.findByCharacterId(ids[1])).inventory[1870].amount, 19, 'crafting must preserve unmaterialized crafter loot');
        assert.equal(await Life.upsertState(customer, 'stale_pre_craft'), null, 'stale lifecycle writes must not restore spent ingredients');
        // An old snapshot cannot spend the same ingredients or MP a second time.
        const repeated = await Craft.craft(customer, () => 0);
        assert(!repeated.crafted);
        assert.equal((await Database.fetchItems(ids[0])).find(row => Number(row.selfId) === 3).amount, 1);
        console.log('Clan production: pooling, selective parts, all levels, party transfers, recipe learning and native clan manufacture passed');
    } finally { await Database.close(); cleanup(); fs.rmSync(isolated.directory, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
