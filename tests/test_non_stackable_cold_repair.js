'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('cold-stack-repair');
require('../src/Global');
fixture.assertConfigured(options.default);
const Database = invoke('Database'), Data = invoke('GameServer/DataCache');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Summary = invoke('GameServer/Bot/Population/InventorySummary');
const Native = require('./helpers/nativeMarketFixture');

(async () => {
    Data.init(); Database.init();
    try {
        await Native.character(Database, 9402, 'ColdRepair', 'bot_cold_repair');
        const original = await Database.setItem(9402, { selfId: 19, name: 'Small Shield', amount: 3, enchant: 4, slot: 8 });
        const inventory = Life.inventorySummaryFromItems(await Database.fetchItems(9402));
        // The cold state can already own loot not yet materialized in SQLite.
        inventory['19'].amount = 5;
        inventory['19'].instances.push({ id: null, amount: 1, enchant: 0, equipped: false, slot: 0 },
            { id: null, amount: 1, enchant: 0, equipped: false, slot: 0 });
        inventory['1864'] = { selfId: 1864, amount: 47, stackable: true };
        inventory['57'] = { selfId: 57, amount: 1234, stackable: true };
        await Native.character(Database, 9403, 'CanonicalRepair', 'bot_canonical_repair');
        await Database.setItem(9403, { selfId: 19, name: 'Small Shield', amount: 3, enchant: 6, slot: 8 });
        const canonical = Summary.canonicalize(Life.inventorySummaryFromItems(await Database.fetchItems(9403)));
        canonical['19'].amount = 4;
        canonical['19'].instances.push({ id: null, amount: 1, enchant: 2, equipped: false, slot: 0 });
        await Database.execute([`INSERT INTO bot_life_state(characterId,accountName,characterName,level,activity,phase,
            inventorySummary,statsJson,updatedAt) VALUES (9403,'bot_canonical_repair','CanonicalRepair',1,'hunting','cold',?,
            '{"classId":0,"role":"dps"}',1)`, [Summary.saved(canonical)]]);
        await Database.execute([`INSERT INTO bot_life_state(characterId,accountName,characterName,level,activity,phase,
            inventorySummary,statsJson,updatedAt) VALUES (9402,'bot_cold_repair','ColdRepair',1,'hunting','cold',?,
            '{"classId":0,"role":"dps"}',1)`, [Summary.saved(inventory)]]);
        await Native.character(Database, 9405, 'CountOnlyRepair', 'bot_count_only_repair');
        const countOnlyObject = await Database.setItem(9405, { selfId: 19, name: 'Small Shield', amount: 3, enchant: 5, slot: 0 });
        // The live loot bug left no instance list or stackability at all.
        await Database.execute([`INSERT INTO bot_life_state(characterId,accountName,characterName,level,activity,phase,
            inventorySummary,statsJson,updatedAt) VALUES (9405,'bot_count_only_repair','CountOnlyRepair',1,'hunting','cold',?,
            '{"classId":0,"role":"dps"}',1)`, [Summary.saved({ 19: { selfId: 19, name: 'Small Shield', amount: 4 } })]]);
        await Native.character(Database, 9406, 'MixedCountRepair', 'bot_mixed_count_repair');
        const mixedStack = await Database.setItem(9406, { selfId: 19, name: 'Small Shield', amount: 3, enchant: 5, slot: 0 });
        const mixedSingle = await Database.setItem(9406,
            { selfId: 19, name: 'Small Shield', amount: 1, enchant: 7, equipped: true, slot: 8 });
        await Database.execute([`INSERT INTO bot_life_state(characterId,accountName,characterName,level,activity,phase,
            inventorySummary,statsJson,updatedAt) VALUES (9406,'bot_mixed_count_repair','MixedCountRepair',1,'hunting','cold',?,
            '{"classId":0,"role":"dps"}',1)`, [Summary.saved({ 19: { selfId: 19, name: 'Small Shield', amount: 5 } })]]);
        const before = (await Database.execute(['SELECT * FROM bot_life_state WHERE characterId=9402']))[0];
        await Database.execute([`CREATE TRIGGER fail_repair_snapshot BEFORE UPDATE OF inventorySummary ON bot_life_state
            WHEN NEW.characterId=9402 BEGIN SELECT RAISE(ABORT,'fixture snapshot failure'); END`]);
        await assert.rejects(Database.splitNonStackableItems([19]), /fixture snapshot failure/);
        assert.deepEqual((await Database.fetchItems(9402)).map(row => [row.id, row.amount, row.enchant]),
            [[Number(original.insertId), 3, 4]], 'a snapshot failure rolls back every physical copy');
        await Database.execute(['DROP TRIGGER fail_repair_snapshot']);
        assert.deepEqual(await Database.splitNonStackableItems([19]), { rowsSplit: 4, copiesCreated: 8 });
        const physicalIds = (await Database.fetchItems(9402)).map(row => row.id);
        const repaired = (await Database.execute(['SELECT * FROM bot_life_state WHERE characterId=9402']))[0];
        const summary = Summary.read(repaired.inventorySummary);
        assert.equal(repaired.simulationRevision, before.simulationRevision + 1);
        assert.equal(repaired.inventoryRevision, before.inventoryRevision + 1);
        assert.equal(summary['19'].amount, 5, 'pending copies survive the repair');
        assert.deepEqual(summary['19'].instances.map(item => item.enchant), [4, 4, 4, 0, 0]);
        assert.deepEqual(summary['19'].instances.slice(0, 3).map(item => item.id), physicalIds);
        assert.deepEqual(summary['1864'], inventory['1864']);
        assert.deepEqual(summary['57'], inventory['57'], 'unmaterialized Adena must stay untouched');
        await Life.init();
        const state = await Life.findByCharacterId(9402);
        await Database.syncInventorySummary(9402, state.inventory);
        const shields = (await Database.fetchItems(9402)).filter(row => row.selfId === 19);
        assert.deepEqual(shields.map(row => row.enchant).sort(), [0, 0, 4, 4, 4], 'load and cold sync retain every enchant');
        assert(physicalIds.every(id => shields.some(row => row.id === id)), 'the repaired physical identities survive cold sync');
        const canonicalPhysicalIds = (await Database.fetchItems(9403)).map(row => row.id);
        const canonicalState = await Life.findByCharacterId(9403);
        assert.deepEqual(canonicalState.inventory['19'].instances.map(item => item.enchant), [6, 6, 6, 2],
            'canonical placeholders inherit physical enchants while a true pending enchanted copy survives');
        await Database.syncInventorySummary(9403, canonicalState.inventory);
        const canonicalShields = (await Database.fetchItems(9403)).filter(row => row.selfId === 19);
        assert.deepEqual(canonicalShields.map(row => row.enchant).sort(), [2, 6, 6, 6]);
        assert(canonicalPhysicalIds.every(id => canonicalShields.some(row => row.id === id)));
        const countOnlyPhysicalIds = (await Database.fetchItems(9405)).map(row => row.id);
        const countOnlyState = await Life.findByCharacterId(9405);
        assert.equal(countOnlyState.inventory['19'].stackable, false);
        assert.deepEqual(countOnlyState.inventory['19'].instances.map(item => item.enchant), [5, 5, 5, 0]);
        assert.equal(countOnlyState.inventory['19'].instances[0].id, Number(countOnlyObject.insertId));
        await Database.syncInventorySummary(9405, countOnlyState.inventory);
        const countOnlyShields = (await Database.fetchItems(9405)).filter(row => row.selfId === 19);
        assert.deepEqual(countOnlyShields.map(row => row.enchant).sort(), [0, 5, 5, 5]);
        assert(countOnlyShields.every(row => row.amount === 1));
        assert(countOnlyPhysicalIds.every(id => countOnlyShields.some(row => row.id === id)),
            'a count-only legacy snapshot cannot merge the repaired rows or replace their identities');
        const mixedIds = (await Database.fetchItems(9406)).map(row => row.id);
        const mixedState = await Life.findByCharacterId(9406);
        assert.deepEqual(mixedState.inventory['19'].instances.map(item => item.enchant).sort(), [0, 5, 5, 5, 7],
            'count-only repair also binds untouched single copies before adding pending loot');
        assert.equal(mixedState.inventory['19'].equipped, true);
        assert.deepEqual(mixedState.inventory['19'].equippedSlots, [8]);
        await Database.syncInventorySummary(9406, mixedState.inventory);
        const mixedShields = (await Database.fetchItems(9406)).filter(row => row.selfId === 19);
        assert.deepEqual(mixedShields.map(row => row.enchant).sort(), [0, 5, 5, 5, 7]);
        assert(mixedIds.every(id => mixedShields.some(row => row.id === id)), 'every pre-existing physical ID survives');
        assert.equal(mixedShields.find(row => row.id === Number(mixedStack.insertId)).enchant, 5);
        const worn = mixedShields.find(row => row.id === Number(mixedSingle.insertId));
        assert.equal(worn.enchant, 7);
        assert.equal(worn.equipped, 1);
        assert.equal(worn.slot, 8);
        assert.deepEqual(await Database.splitNonStackableItems([19]), { rowsSplit: 0, copiesCreated: 0 });
        // Two Crafted Daggers are two copies: a bag entry without slot or stack hints never
        // merges them into one unwearable stack (stackability is the item's).
        await Native.character(Database, 9404, 'TwoDaggers', 'bot_two_daggers');
        for (let copy = 0; copy < 2; copy++) await Database.setItem(9404, { selfId: 220, name: 'Crafted Dagger', amount: 1 });
        await Database.syncInventorySummary(9404, { 220: { selfId: 220, amount: 2 } });
        assert.deepEqual((await Database.fetchItems(9404)).filter(row => row.selfId === 220).map(row => row.amount), [1, 1],
            'a bare entry keeps one row per dagger');
        // A Rogue drawn to Hawkeye wears its dagger until it owns a bow: a second dagger looted
        // in a far round adds a copy and leaves the worn one on.
        const Progression = invoke('GameServer/Bot/BotClassProgression');
        let rogue = 9410;
        while (Progression.futureClass(7, rogue) !== 9) rogue++;
        await Native.character(Database, rogue, 'LootedDagger', 'bot_looted_dagger');
        await Database.execute(['UPDATE characters SET classId = 7, level = 32 WHERE id = ?', [rogue]]);
        await Database.setItem(rogue, { selfId: 220, name: 'Crafted Dagger', amount: 1, equipped: true, slot: 7 });
        await Database.execute([`INSERT INTO bot_life_state(characterId,accountName,characterName,level,activity,phase,
            inventorySummary,statsJson,updatedAt) VALUES (?,'bot_looted_dagger','LootedDagger',32,'hunting','cold',?,?,1)`,
        [rogue, Summary.saved(Life.inventorySummaryFromItems(await Database.fetchItems(rogue))),
            JSON.stringify({ classId: 7, classProgressionClassId: 7, classProgressionLevel: 32 })]]);
        const hunter = await Life.findByCharacterId(rogue);
        const looted = await Life.prepareResolve(hunter, { patch: {}, events: [], debug: {}, nextResolveAt: Date.now() + 60000,
            materialize: { exp: 0, sp: 0, adena: 0, items: [{ selfId: 220, name: 'Crafted Dagger', amount: 1, kind: 'Weapon.Knife',
                rank: 'd', stackable: false }] } }, { timestamp: Date.now(), persist: false, projectClassProgression: true });
        await Database.syncInventorySummary(rogue, looted.inventory);
        assert.deepEqual((await Database.fetchItems(rogue)).filter(row => row.selfId === 220)
            .map(row => [row.amount, row.equipped, row.slot]), [[1, 1, 7], [1, 0, 0]], 'the worn dagger stays worn after a looted copy');
        console.log('PASS cold stack repair: atomic projection, virtual loot, revisions, IDs and enchant survive hydration');
    } finally {
        await Database.close(); fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
