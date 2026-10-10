'use strict';
// E212 G1: a Giran station is a public workshop for bots as for the player:
// its own station list at the station fee, the customer brings materials,
// the station keeps its MP (infrastructure) and sells nothing itself.
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
const isolated = require('./helpers/isolatedSocialDatabase')('station-workshop');
require('../src/Global');
isolated.assertConfigured(options.default);
const DataCache = invoke('GameServer/DataCache');
DataCache.init();
const Database = invoke('Database');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Shops = invoke('GameServer/Bot/Economy/CraftShopService');
const Crafting = invoke('GameServer/Bot/Economy/ColdCraftingService');
const Workshop = invoke('GameServer/Bot/Economy/CraftWorkshopService');

(async () => {
    const recipe = invoke('GameServer/Items/C4RecipeItems').resolveByRecipeId(198);
    const station = Shops.CraftStations.find(row => row.id === 'c_weapons_entry');
    assert(recipe && station.recipeIds.includes(198), 'the C entry station lists the Crystal Staff');
    const item = (selfId, amount) => ({ selfId, amount, name: DataCache.items.find(row => row.selfId === selfId)?.template?.name || `Item ${selfId}`,
        equipped: false, slot: 0, enchant: 0 });
    async function seed(accountName, name, classId, level, rows, stats = {}) {
        await Database.createAccount(accountName, 'fixture');
        const race = Number(DataCache.classTemplates.find(row => Number(row.classId) === classId)?.template?.race || 0);
        const id = Number((await Database.createCharacter(accountName, { name, race, classId, sex: 0,
            face: 0, hair: 0, hairColor: 0, maxHp: 1000, maxMp: 1000, ...station.loc })).insertId);
        await Database.execute(['UPDATE characters SET level=?, exp=?, hp=1000, mp=1000 WHERE id=?',
            [level, Number(DataCache.experience[level - 1]), id]]);
        for (const row of rows) await Database.setItem(id, row);
        return Life.upsertState({ characterId: id, accountName, name, phase: 'cold', activity: 'crafting',
            level, loc: { ...station.loc }, currentRegion: 'Giran',
            adena: rows.find(row => row.selfId === 57)?.amount || 0,
            inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)),
            vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 },
            stats: { classId, generatedCold: true, money: [36000, 0, 0, 0], ...stats }, timing: {} }, 'station_workshop_fixture');
    }
    try {
        await Database.init();
        await Life.init();
        // An ordinary generated bot's index is its creation time: never a station.
        assert.equal(Shops.isStationService({ stats: { generatedIndex: 1791543604756 } }), false, 'an ordinary dwarf is no station');
        assert.equal(Shops.isStationService({ stats: { generatedIndex: 10005 } }), true, 'a reserved slot is a station');
        assert.equal(Shops.isStationService({ accountName: 'bot_craft_03', stats: {} }), true, 'a station account is a station');
        let owner = await seed(Crafting.crafterAccount(station), 'StationEntryC', 57, 70, [item(57, 1000)],
            { craftStationId: station.id, generatedIndex: 10000 });
        const profile = Shops.profileFor(owner);
        await Shops.ensureRecipes(owner.characterId, profile);
        owner = await Workshop.review(Life.cachedState(owner.characterId));
        assert.deepEqual(owner.stats.workshop.entries.map(row => [row.recipeId, row.price]),
            profile.entries.map(row => [row.recipeId, row.price]), 'the station publishes its own list at the station fee');
        const fee = profile.entries.find(row => row.recipeId === 198).price;
        assert.equal(fee, Shops.productPrice(recipe));
        const revision = owner.simulation?.revision;
        assert.strictEqual(await Workshop.review(owner), owner, 'an unchanged station list writes no row');
        assert.equal(Life.cachedState(owner.characterId).simulation?.revision, revision);

        const inputs = new Map();
        for (const row of recipe.materials) inputs.set(Number(row.selfId), (inputs.get(Number(row.selfId)) || 0) + Number(row.amount));
        let customer = await seed('bot_station_customer', 'StationCustomer', 10, 45,
            [item(57, 1000000), ...[...inputs].map(([id, amount]) => item(id, amount))]);
        const rows = Workshop.publicForRecipe(198, customer);
        assert(rows.some(row => row.characterId === owner.characterId && row.price === fee && row.capacityBatches >= 1),
            'a buyer finds the station through the public workshop index');
        const found = Workshop.find(198, customer);
        assert.equal(found.characterId, owner.characterId);
        assert.equal(Workshop.publicForRecipe(Shops.CraftStations.find(row => row.id === 'b_heavy').recipeIds[0], customer)
            .some(row => row.characterId === owner.characterId), false, 'a station lists only its own recipes');

        customer = await Life.upsertState({ ...customer, stats: { ...customer.stats, equipmentPlan: { status: 'ready_to_craft',
            strategy: 'craft', recipeId: 198, target: { selfId: recipe.productId },
            craftProviders: { 198: { workshop: true, characterId: owner.characterId, price: fee, known: true } } } } }, 'station_plan');
        const chosen = Crafting.stationForRecipe(198, customer);
        assert.equal(chosen.workshop, true);
        assert.equal(chosen.characterId, owner.characterId);
        const result = await Crafting.craft(customer, () => 0);
        assert.equal(result.crafted, true, result.reason);
        const customerItems = await Database.fetchItems(customer.characterId);
        const ownerItems = await Database.fetchItems(owner.characterId);
        const held = (list, id) => list.filter(row => row.selfId === id).reduce((sum, row) => sum + row.amount, 0);
        assert.equal(held(customerItems, recipe.productId), recipe.productCount, 'the customer receives the product');
        for (const id of inputs.keys()) assert.equal(held(customerItems, id), 0, 'the customer\'s materials are spent');
        assert.equal(held(customerItems, 57), 1000000 - fee);
        assert.equal(held(ownerItems, 57), 1000 + fee, 'the station is paid its fee');
        const [physical] = await Database.execute(['SELECT mp FROM characters WHERE id=?', [owner.characterId]]);
        const [life] = await Database.execute(['SELECT mp, statsJson FROM bot_life_state WHERE characterId=?', [owner.characterId]]);
        assert.equal(physical.mp, 1000, 'a station spends no MP');
        assert.equal(life.mp, 1000);
        assert.equal(JSON.parse(life.statsJson).workshop.entries.find(row => row.recipeId === 198).fills, 1);
        assert.equal(held(ownerItems, recipe.productId), 0, 'the station holds no goods');
        const after = Life.cachedState(owner.characterId);
        assert.strictEqual(await Workshop.review(after), after, 'fills and earnings do not republish the station');
        console.log('PASS station workshop: published list, public index, paid craft, MP kept', JSON.stringify({ fee }));
    } finally {
        await Database.close();
        require('node:fs').rmSync(isolated.directory, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
