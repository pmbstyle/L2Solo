const assert = require('assert');
const fs = require('fs');
const path = require('path');

require('../src/Global');

const Database = invoke('Database');
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

    console.log('Cold inventory paired-jewellery checks passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
