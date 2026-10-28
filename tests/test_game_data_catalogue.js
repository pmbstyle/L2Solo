'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const isolated = require('./helpers/isolatedSocialDatabase')('game-data-catalogue');
require('../src/Global');
isolated.assertConfigured(options.default);
const DataCache = invoke('GameServer/DataCache');
const NativeRecipes = require('../src/GameServer/Items/C4RecipeItems');
const { native } = require('../src/GameServer/Knowledge/GameDataCatalogue');
const { createExportedCatalogue } = require('../src/GameServer/Knowledge/ExportedCatalogueAdapter');
const { revisionOf } = require('../src/GameServer/Knowledge/CatalogueRevision');
const c = native();

try {
    // Public optional readers must agree with capabilities, without an implicit
    // recipe CSV load. Empty known selections differ from absent selections.
    assert.equal(NativeRecipes.loadedSource(), null);
    const readFile = fs.readFileSync;
    let recipeReads = 0;
    fs.readFileSync = function(file, ...args) {
        if (String(file).endsWith(NativeRecipes.RECIPE_DATA_PATH)) recipeReads++;
        return readFile.call(this, file, ...args);
    };
    try {
        assert.equal(c.capabilities().recipes, false);
        assert.equal(c.recipe(1), null);
        assert.equal(c.recipesForProduct(17), null);
        assert.equal(c.ingredientsForRecipe(1), null);
        assert.equal(c.recipesUsing(1864), null);
        assert.equal(c.sourcesForItem(1864, { kind: 'drops' }), null);
        assert.equal(c.selectedSourcesForItem(1864), null);
        assert.equal(c.selectedSourcesForItem(1864, []), null);
        assert.equal(c.selectedNpcSpots(1), null);
        assert.deepEqual(c.selectedNpcSpots(1, []), []);
        assert.equal(c.potentialSpawnData(), null);
        assert.equal(c.spawnsForNpc(1), null);
        assert.equal(c.raidBossDefinitions(), null);
        assert.equal(c.rewardForNpc(1), null);
        assert.equal(c.dwarvenRecipesForItems(), null);
        assert.equal(c.npcTownOffers(), null);
        assert.equal(c.spotNpcWeights(null, 1), null);
        assert.equal(recipeReads, 0);
    } finally { fs.readFileSync = readFile; }

    DataCache.init();
    // Cold workers replace live-world invoke services. Native catalogue
    // queries still read the same pure static owners without those services.
    const cataloguePath = require.resolve('../src/GameServer/Knowledge/GameDataCatalogue');
    const savedCatalogue = require.cache[cataloguePath], originalInvoke = global.invoke;
    try {
        global.invoke = name => {
            if (name === 'GameServer/World/Generics/NpcShopBuyLists') return { allEntries: () => [] };
            if (name === 'GameServer/World/TownRespawn') throw Error('live world service is unavailable');
            return originalInvoke(name);
        };
        delete require.cache[cataloguePath];
        const workerCatalogue = require(cataloguePath).native();
        const offers = workerCatalogue.npcTownOffers();
        assert(offers && offers.itemCount > 0, 'native town stock uses the pure owner under worker service restrictions');
    } finally {
        global.invoke = originalInvoke;
        require.cache[cataloguePath] = savedCatalogue;
    }
    const loadedItems = DataCache.items;
    try {
        DataCache.items = undefined;
        assert.equal(c.dwarvenRecipesForItems(), null, 'recipe stock cannot declare missing product data empty');
        DataCache.items = [];
        assert.deepEqual(c.dwarvenRecipesForItems(), [], 'known empty product data has known empty recipe stock');
    } finally { DataCache.items = loadedItems; }
    const A = [{ id: 'A', npcEntries: [{ selfId: 1, count: 2 }] }];
    const B = [{ id: 'B', npcEntries: [{ selfId: 1, count: 3 }] }];
    const plannerMap = c.sourceIndexFor(A);
    assert.equal(c.selectedSpotNpcs('B', B).totalCount, 3);
    assert.equal(c.sourceIndexFor(A), plannerMap, 'reverse spot query cannot evict planner source view');
    assert.equal(c.selectedNpcSpots(1, B)[0].count, 3);
    assert.equal(c.sourceIndexFor(A), plannerMap, 'forward topology query cannot evict planner source view');

    const expected = DataCache.npcRewards.filter(reward => (reward.rewards || [])
        .some(group => (group.items || []).some(item => Number(item.selfId) === 1864)));
    const raw = c.sourcesForItem(1864, { kind: 'drops' });
    assert.equal(expected.length, 176); // 156 before the Mobius spawns' Lisvus templates (T43), 175 before T48's minions
    assert.deepEqual(raw.map(row => row.reward), expected, 'all declared drop rewards, in source order');
    assert.equal(c.sourcesForItem(1864, { kind: 'drop', spots: B }), raw, 'raw sources ignore selected spots');
    assert.equal(c.sourceIndexFor(A), plannerMap, 'raw reverse does not replace selected index');
    assert.equal(c.selectedSourcesForItem(1864, A).length, 2);
    assert.deepEqual(c.selectedSourcesForItem(1864, []), []);
    assert.deepEqual(c.sourcesForItem(-1, { kind: 'drops' }), []);
    const raid = DataCache.npcRewards.find(reward => Number(reward.selfId) === 10372);
    const raidItem = raid.rewards[0].items[0].selfId;
    assert(c.sourcesForItem(raidItem, { kind: 'drops' }).some(row => row.reward === raid), 'raw knowledge retains protected raid rewards');
    assert.equal(c.ingredientsForRecipe(1).find(row => row.selfId === 1864).quantity, 4);

    const first = { selfId: 1, total: 2, period: 'day', coords: [{ locX: 1 }, { locX: 2 }] };
    const second = { selfId: 1, total: 3, period: 'night', coords: [] };
    const groups = [{ selfId: 'group', bounds: [{ minZ: -4, maxZ: -2 }], spawns: [first, second] },
        { selfId: 'group', spawns: [{ selfId: 1, total: 0 }, { selfId: 2, total: 1 }] }];
    DataCache.npcSpawns = groups;
    const definitions = c.spawnsForNpc(1);
    assert.deepEqual(definitions.map(row => row.definition), [first, second, groups[1].spawns[0]]);
    assert.equal(definitions[0].group, groups[0]);
    assert.equal(c.spawnsForNpc(1), definitions, 'warm NPC definition lookup reuses its index rows');
    assert.equal(c.spawn('group'), groups[0], 'native spawn group lookup retains first-match IDs');
    assert.equal(c.potentialSpawnData().revision, c.datasetInfo().potentialSpawns.revision);
    assert.equal(first.total, 2, 'per-coordinate total remains raw, not multiplied into live occupancy');
    const oldRevision = c.potentialSpawnData().revision;
    DataCache.npcSpawns = groups.slice();
    assert.notEqual(c.spawnsForNpc(1), definitions);
    assert.notEqual(c.potentialSpawnData().revision, oldRevision);
    assert.deepEqual(c.spawnsForNpc(999999), []);
    const growing = [];
    const beforeGrowth = revisionOf(growing);
    growing.push(groups[0]);
    assert.notEqual(revisionOf(growing), beforeGrowth);

    const drops = [{ id: 1 }], spoils = [], exportedSpawns = [{ id: 'E' }];
    const data = { itemById: new Map([[1864, { sources: { drops, spoils } }]]),
        mobById: new Map([[1, { spawnIds: ['E'] }]]), spawnById: new Map([['E', exportedSpawns[0]]]),
        spawns: exportedSpawns, manifest: { generatedAt: 'fixture-export' } };
    const e = createExportedCatalogue(data, { nativeCatalogue: c });
    assert.equal(e.capabilities({ spots: A }).selectedSources, true);
    assert.equal(e.sourceIndexFor(A), plannerMap, 'injected export returns the existing native Map');
    const relation = e.relations('item', 1864, { spots: A });
    assert.equal(relation.sources.origin, 'exported');
    assert.equal(relation.sources.revision, 'fixture-export');
    assert.equal(relation.sources.drops, drops);
    assert.equal(relation.recipes.origin, 'native');
    assert.equal(typeof relation.recipes.revision, 'number');
    assert.equal(relation.selectedSources.origin, 'native');
    assert.equal(e.relations('npc', 1, { spots: A }).selectedSpots.origin, 'native');
    assert.equal(e.relations('npc', 1).potentialSpawns.origin, 'exported');
    assert.deepEqual(e.spawnsForNpc(1), exportedSpawns);
    const onlyExport = createExportedCatalogue(data);
    assert.equal(onlyExport.sourceIndexFor(A), null);
    assert.equal(onlyExport.selectedSourcesForItem(1864, A), null);
    assert.equal(onlyExport.relations('item', 1864).recipes.origin, null);

    // Source labels and data readers must agree when a caller fills its array
    // in place. Check visible new sources/metadata, not just cache internals.
    const growingSpots = A.slice();
    assert.equal(c.selectedSourcesForItem(1864, growingSpots).length, 2);
    growingSpots.push(B[0]);
    assert.equal(c.selectedSourcesForItem(1864, growingSpots).length, 4);
    DataCache.npcRewards = DataCache.npcRewards.slice();
    DataCache.npcs = DataCache.npcs.slice();
    const appended = { selfId: 999997, template: { name: 'new NPC' },
        rewards: [{ overall: 100, items: [{ selfId: 999995, min: 1, max: 1, chance: 100 }] }], spoils: [] };
    assert.deepEqual(c.sourcesForItem(999995, { kind: 'drops' }), []);
    const beforeAppend = c.datasetInfo().sources.revision;
    DataCache.npcRewards.push(appended);
    assert.equal(c.sourcesForItem(999995, { kind: 'drops' })[0].reward, appended);
    assert.notEqual(c.datasetInfo().sources.revision, beforeAppend);
    const newSpots = [{ id: 'new', npcEntries: [{ selfId: 999997, count: 1 }] }];
    assert.equal(c.selectedSourcesForItem(999995, newSpots)[0].npcLevel, 0);
    DataCache.npcs.push({ selfId: 999997, template: { name: 'new NPC', kind: 'Monster', level: 11 } });
    assert.equal(c.selectedSourcesForItem(999995, newSpots)[0].npcLevel, 11, 'new NPC template metadata revises selected sources');
    assert.equal(invoke('Database').isReady(), false);
    console.log(JSON.stringify({ rawDropNpcCount: raw.length, plannerMapPreserved: true,
        missingRecipeCsvReads: recipeReads, npcDefinitions: definitions.length, mixedOrigins: 'native/exported', appendConsistent: true }));
    console.log('test_game_data_catalogue PASS');
} finally { fs.rmSync(isolated.directory, { recursive: true, force: true }); }
