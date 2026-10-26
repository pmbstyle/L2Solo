'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('craft-station-saved-upgrade');
require('../src/Global');
fixture.assertConfigured(options.default);

const Data = invoke('GameServer/DataCache'); Data.init();
const Database = invoke('Database');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Seeder = invoke('GameServer/Bot/Population/GeneratedColdSeeder');
const Shops = invoke('GameServer/Bot/Economy/CraftShopService');

async function run() {
    await Database.init(); await Life.init();
    const oldIds = new Map();
    const oldLoc = { locX: 1, locY: 2, locZ: 3 };
    // A summary-only stack: the bag names shots the crafter holds no item row for.
    const phantomShots = { 1835: { selfId: 1835, name: 'Soulshot: No Grade', amount: 1000 } };
    const persistedBag = async (characterId) => Life.normalizeInventoryStackability(JSON.parse((await Database.execute([
        'SELECT inventorySummary FROM bot_life_state WHERE characterId = ?', [characterId]]))[0].inventorySummary));
    const physicalBag = async (characterId) => Life.normalizeInventoryStackability(
        Life.inventorySummaryFromItems(await Database.fetchItems(characterId)));
    for (let slot = 0; slot < 32; slot++) {
        const accountName = `bot_craft_${String(slot + 1).padStart(2, '0')}`;
        const name = `OldCraft${String(slot + 1).padStart(2, '0')}`;
        await Database.createAccount(accountName, 'fixture');
        const characterId = Number((await Database.createCharacter(accountName, { name, classId: 57,
            race: 4, sex: 0, face: 0, hair: 0, hairColor: 0, maxHp: 1000, maxMp: 1000,
            ...oldLoc })).insertId);
        oldIds.set(accountName, characterId);
        await Life.upsertState({ characterId, accountName, name, level: 70, exp: Data.experience[69],
            phase: 'cold', activity: 'crafting', currentRegion: 'Giran', loc: oldLoc,
            vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 }, inventory: slot === 0 ? phantomShots : {}, timing: {},
            stats: { classId: 57, generatedCold: true, generatedIndex: 10000 + slot,
                craftStationId: 'd_heavy', craftShop: { stationId: 'd_heavy', title: 'Old station',
                    loc: oldLoc, entries: [{ recipeId: 79, price: 1 }] } } }, 'old_craft_station_fixture');
    }

    assert.equal(Shops.CraftStations.length, 35);
    const seeded = await Seeder.ensureCraftServices();
    assert.deepEqual(seeded, { created: 3, seeded: 3 }, 'only the appended services are new');
    for (let slot = 0; slot < 35; slot++) {
        const accountName = `bot_craft_${String(slot + 1).padStart(2, '0')}`;
        const [character] = await Database.fetchCharacters(accountName);
        assert(character, `service ${slot + 1} exists`);
        if (slot < 32) assert.equal(Number(character.id), oldIds.get(accountName), 'old account keeps its character');
        const state = await Life.findByCharacterId(character.id);
        const station = Shops.CraftStations[slot];
        assert.equal(state.stats.craftStationId, station.id, `service ${slot + 1} keeps its slot identity`);
        assert.equal(state.stats.craftShop.stationId, station.id);
        assert.deepEqual(state.loc, station.loc, `service ${slot + 1} moves to the current Giran stall`);
        assert.deepEqual(state.stats.craftShop.loc, station.loc);
        assert.deepEqual(state.stats.craftShop.entries.map(row => row.recipeId),
            Shops.profileFor(state).entries.map(row => row.recipeId), 'saved service publishes the current recipes');
        assert.deepEqual(await persistedBag(character.id), await physicalBag(character.id),
            `service ${slot + 1} persists the bag its item rows hold`);
    }

    // A crafter already at its current stall: the bag alone moves the row.
    const firstId = oldIds.get('bot_craft_01');
    const settled = await Life.findByCharacterId(firstId);
    await Life.upsertState({ ...settled, inventory: { ...settled.inventory, ...phantomShots } }, 'phantom_fixture');
    assert.equal((await persistedBag(firstId))[1835]?.amount, 1000, 'fixture stores the summary-only stack');
    await Seeder.ensureCraftServices();
    assert.deepEqual(await persistedBag(firstId), await physicalBag(firstId), 'the seed pass drops the summary-only stack');

    // Another writer (a craft, a sale) moves the row while the pass reads the
    // item rows: its vitals and stats stand; the next pass heals the bag.
    const before = await Life.findByCharacterId(firstId);
    await Life.upsertState({ ...before, inventory: { ...before.inventory, ...phantomShots } }, 'phantom_fixture');
    const fetchItems = Database.fetchItems;
    Database.fetchItems = async (characterId, ...rest) => {
        if (Number(characterId) === firstId && rest[0] === 'generated_craft_service') {
            Database.fetchItems = fetchItems;
            const current = Life.cachedState(firstId);
            await Life.upsertState({ ...current, vitals: { ...current.vitals, hp: 400 },
                stats: { ...current.stats, frustration: 3 } }, 'competing_writer_fixture');
        }
        return fetchItems.call(Database, characterId, ...rest);
    };
    await Seeder.ensureCraftServices();
    Database.fetchItems = fetchItems;
    const [moved] = await Database.execute(['SELECT hp, statsJson FROM bot_life_state WHERE characterId = ?', [firstId]]);
    assert.equal(Number(moved.hp), 400, 'the pass keeps the vitals another writer saved meanwhile');
    assert.equal(JSON.parse(moved.statsJson).frustration, 3, 'the pass keeps the stats another writer saved meanwhile');
    await Seeder.ensureCraftServices();
    assert.deepEqual(await persistedBag(firstId), await physicalBag(firstId), 'the next pass drops the summary-only stack');
    console.log('PASS saved craft stations: 32 account identities refreshed, 3 appended services created');
}

run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    await Database.close(); fs.rmSync(fixture.directory, { recursive: true, force: true });
});
