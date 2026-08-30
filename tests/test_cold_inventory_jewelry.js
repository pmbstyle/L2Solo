const assert = require('assert');
const fs = require('fs');
const path = require('path');

require('../src/Global');

const Database = invoke('Database');
const BotLifeState = invoke('GameServer/Bot/Population/BotLifeState');
const databasePath = path.join(process.cwd(), 'tmp', 'test-cold-inventory-jewelry.sqlite');

fs.rmSync(databasePath, { force: true });
options.default.Database.path = path.relative(process.cwd(), databasePath);
Database.init();

(async () => {
    await Database.createAccount('cold_jewelry', 'secret');
    await Database.createCharacter('cold_jewelry', {
        name: 'ColdJewelryProbe', race: 0, classId: 0, maxHp: 50, maxMp: 25,
        sex: 0, face: 0, hair: 0, hairColor: 0, locX: 0, locY: 0, locZ: 0
    });
    const character = (await Database.fetchCharacters('cold_jewelry'))[0];

    await Database.syncInventorySummary(character.id, {
        114: {
            selfId: 114,
            name: 'Apprentice Earring',
            amount: 2,
            equipped: true,
            equippedCount: 2,
            equippedSlots: [1, 2],
            stackable: false,
            slot: 1
        }
    });
    const paired = (await Database.fetchItems(character.id)).filter((item) => Number(item.selfId) === 114);
    assert.strictEqual(paired.length, 2, 'a cold pair must materialize as two physical non-stackable rows');
    assert(paired.every((item) => Number(item.amount) === 1));
    assert.deepStrictEqual(paired.filter((item) => Number(item.equipped) === 1).map((item) => Number(item.slot)).sort(), [1, 2]);

    const variedEnchantSummary = BotLifeState.inventorySummaryFromItems([
        {
            fetchId: () => paired[0].id,
            fetchSelfId: () => 114,
            fetchName: () => 'Apprentice Earring',
            fetchAmount: () => 1,
            fetchEnchantLevel: () => 3,
            fetchEquipped: () => true,
            fetchSlot: () => 1,
            fetchStackable: () => false
        },
        {
            fetchId: () => paired[1].id,
            fetchSelfId: () => 114,
            fetchName: () => 'Apprentice Earring',
            fetchAmount: () => 1,
            fetchEnchantLevel: () => 7,
            fetchEquipped: () => true,
            fetchSlot: () => 2,
            fetchStackable: () => false
        }
    ]);
    assert.deepStrictEqual(
        variedEnchantSummary['114'].instances.map((instance) => [instance.id, instance.enchant, instance.slot]),
        [[paired[0].id, 3, 1], [paired[1].id, 7, 2]],
        'cold inventory summaries must retain each non-stackable item identity and enchant'
    );
    await Database.syncInventorySummary(character.id, variedEnchantSummary);
    const variedRows = (await Database.fetchItems(character.id)).filter((item) => Number(item.selfId) === 114);
    assert.strictEqual(Number(variedRows.find((item) => Number(item.id) === Number(paired[0].id)).enchant), 3,
        'cold inventory sync must keep the first physical item enchant on its persistent row');
    assert.strictEqual(Number(variedRows.find((item) => Number(item.id) === Number(paired[1].id)).enchant), 7,
        'cold inventory sync must keep the second physical item enchant on its persistent row');

    await Database.syncInventorySummary(character.id, {
        114: {
            selfId: 114,
            name: 'Apprentice Earring',
            amount: 3,
            equipped: true,
            equippedCount: 2,
            equippedSlots: [1, 2],
            stackable: false,
            slot: 1
        }
    });
    const surplus = (await Database.fetchItems(character.id)).filter((item) => Number(item.selfId) === 114);
    assert.strictEqual(surplus.length, 3, 'unequipped duplicate jewellery must remain a separate physical row');
    assert.strictEqual(surplus.filter((item) => Number(item.equipped) === 1).length, 2);
    assert.strictEqual(surplus.filter((item) => Number(item.equipped) === 0).length, 1);
    assert.strictEqual(Number(surplus.find((item) => Number(item.equipped) === 0).slot), 0,
        'unequipped physical rows must persist with an empty paperdoll slot');

    await Database.syncInventorySummary(character.id, {
        114: {
            selfId: 114,
            name: 'Apprentice Earring',
            amount: 1,
            equipped: true,
            equippedCount: 1,
            equippedSlots: [2],
            stackable: false,
            slot: 1
        }
    });
    const reduced = (await Database.fetchItems(character.id)).filter((item) => Number(item.selfId) === 114);
    assert.strictEqual(reduced.length, 1, 'shrinking the cold count must delete obsolete physical duplicates');
    assert.strictEqual(Number(reduced[0].equipped), 1);
    assert.strictEqual(Number(reduced[0].slot), 2);

    const sword = await Database.setItem(character.id, {
        selfId: 1,
        name: 'Short Sword',
        amount: 1,
        enchant: 4,
        equipped: false,
        slot: 0,
        petData: { hunger: 42 }
    });
    const swordSource = (await Database.fetchItems(character.id)).find((item) => Number(item.id) === Number(sword.insertId));
    const deposited = await Database.transferInventoryToWarehouse(character.id, {
        id: sword.insertId,
        selfId: 1,
        name: 'Short Sword',
        amount: 1,
        enchant: 99,
        stackable: false,
        petData: swordSource.petData
    });
    assert.strictEqual(deposited.enchant, 4, 'warehouse deposit must return the persisted source enchant');
    const depositedRow = (await Database.fetchWarehouseItems(character.id)).find((item) => Number(item.id) === Number(deposited.warehouseId));
    assert.strictEqual(Number(depositedRow.enchant), 4, 'warehouse deposit must persist the source enchant instead of a stale caller value');
    assert.strictEqual(depositedRow.petData, JSON.stringify({ hunger: 42 }),
        'warehouse deposit must preserve an already-serialized pet payload without adding an escaping layer');

    const withdrawn = await Database.transferWarehouseToInventory(character.id, {
        id: deposited.warehouseId,
        selfId: 1,
        name: 'Short Sword',
        amount: 1,
        enchant: 99,
        stackable: false
    });
    assert.strictEqual(withdrawn.enchant, 4, 'warehouse withdraw must return the persisted source enchant');
    const restoredSword = (await Database.fetchItems(character.id)).find((item) => Number(item.id) === Number(withdrawn.inventoryId));
    assert.strictEqual(Number(restoredSword.enchant), 4, 'warehouse withdraw must persist the source enchant instead of a stale caller value');
    assert.strictEqual(restoredSword.petData, JSON.stringify({ hunger: 42 }));

    const redeposited = await Database.transferInventoryToWarehouse(character.id, {
        id: restoredSword.id,
        selfId: restoredSword.selfId,
        name: restoredSword.name,
        amount: 1,
        stackable: false,
        petData: restoredSword.petData
    });
    const redepositedRow = (await Database.fetchWarehouseItems(character.id)).find((item) => Number(item.id) === Number(redeposited.warehouseId));
    assert.strictEqual(redepositedRow.petData, JSON.stringify({ hunger: 42 }),
        'repeated inventory and warehouse round trips must keep pet metadata size stable');

    console.log('Cold inventory paired-jewellery checks passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
