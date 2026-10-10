'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('generated-cold-loadout');
require('../src/Global');
fixture.assertConfigured(options.default);
process.on('exit', () => fs.rmSync(fixture.directory, { recursive: true, force: true }));
const Database = invoke('Database');
const Data = invoke('GameServer/DataCache');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Seeder = invoke('GameServer/Bot/Population/GeneratedColdSeeder');
const Native = require('./helpers/nativeMarketFixture');
Data.init();

async function run() {
    await Database.init();
    for (const classId of [0, 10, 18, 25, 31, 38, 44, 49, 53]) {
        const id = 9600000 + classId;
        await Native.character(Database, id, `Loadout${classId}`, `bot_loadout_${classId}`);
        await Seeder.awardBaseGear(id, classId);
        const physical = await Database.fetchItems(id);
        const declared = Data.newbieItems.find(row => row.classId === classId).items;
        for (const item of declared) {
            const row = physical.find(row => row.selfId === item.selfId);
            assert.equal(!!row.equipped, item.equipped === true,
                `class ${classId}: ${item.name} must retain its declared starter equip flag`);
        }
        assert.equal(physical.filter(row => row.equipped && [7, 14].includes(row.slot)).length, 1,
            `class ${classId}: exactly one starter weapon may be equipped`);
        await Seeder.awardBaseGear(id, classId);
        assert.deepEqual(await Database.fetchItems(id), physical, 'retry must neither duplicate nor re-equip existing gear');
    }

    // Reproduce the old seeder's persisted sword + fists, including individual
    // native item identity/enchant, before lifecycle startup publishes actors.
    const id = 9600044;
    await Database.execute(['UPDATE items SET equipped=1, enchant=CASE WHEN selfId=2368 THEN 2 ELSE enchant END WHERE characterId=? AND selfId IN (2369,2368)', [id]]);
    const before = await Database.fetchItems(id);
    const inventory = Life.inventorySummaryFromItems(before);
    const stats = { classId: 44, role: 'dps', generatedCold: true,
        equipment: Life.equipmentSummaryFromInventory(inventory) };
    await Database.execute([`INSERT INTO bot_life_state
        (characterId,accountName,characterName,level,phase,activity,hp,maxHp,mp,maxMp,inventorySummary,statsJson,updatedAt)
        VALUES (?,?,?,6,'cold','hunting',100,100,100,100,?,?,?)`,
        [id, 'bot_loadout_44', 'Loadout44', JSON.stringify(inventory), JSON.stringify(stats), Date.now()]]);
    assert.equal(before.filter(row => row.equipped && [7,14].includes(row.slot)).length, 2);
    await Life.init();
    const after = await Database.fetchItems(id);
    const worn = after.filter(row => row.equipped && [7,14].includes(row.slot));
    assert.equal(worn.length, 1, 'startup must durably repair the old conflicting weapons');
    assert.equal(worn[0].selfId, 2368, 'Orc Fighter keeps its declared starter fists until a preferred weapon is available');
    const identity = rows => rows.map(({ id, selfId, amount, enchant }) => ({ id,selfId,amount,enchant }));
    assert.deepEqual(identity(after), identity(before), 'repair preserves every item and enchant');
    const state = Life.cachedState(id);
    assert.equal(state.stats.equipment.filter(item => [7,14].includes(item.slot)).length, 1,
        'published cold equipment must agree with physical flags');
    assert.equal(state.inventory[2369].equipped, false, 'spare sword stays in inventory');
    assert.equal(state.inventory[2368].instances[0].enchant, 2);
    const Gear = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
    const improved = Gear.equipInventoryUpgrades(state, { ...state.inventory,
        4: { selfId: 4, amount: 1, slot: 7, equipped: false } });
    assert.equal(improved[4].equipped, true, 'a proper blunt supersedes the temporary starter weapon');
    assert.equal(improved[2368].equipped, false, 'the fists must be removed when a suitable weapon becomes available');
    assert.equal(improved[2369].equipped, false, 'the spare sword must stay unequipped');
    console.log('Generated cold loadout: all starter classes, retries and legacy native repair passed');
}
run().then(() => Database.close()).catch(async error => {
    console.error(error); process.exitCode = 1; await Database.close();
});
