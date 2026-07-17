const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const Database = invoke('Database');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const BotWarehouse = invoke('GameServer/Bot/Economy/BotWarehouseService');

DataCache.init();

const originals = {
    fetchItems: Database.fetchItems,
    transferInventoryToWarehouse: Database.transferInventoryToWarehouse
};

async function run() {
    const material = { selfId: 1870, name: 'Animal Bone', amount: 20, kind: 'Other.Material', rank: 'none' };
    const trash = { selfId: 1, name: 'Short Sword', amount: 1, kind: 'Weapon.Sword', rank: 'none' };
    const usefulGear = { selfId: 2, name: 'Long Sword', amount: 1, kind: 'Weapon.Sword', rank: 'none' };
    assert.strictEqual(ItemDisposition.isWarehouseCandidate(material), true, 'materials must be kept even when cheap');
    assert.strictEqual(ItemDisposition.isWarehouseCandidate(trash), false, 'cheap no-grade gear remains liquidation trash');
    assert.strictEqual(ItemDisposition.isWarehouseCandidate(usefulGear), true, 'valuable no-grade gear must survive an unsuccessful sale');

    const calls = [];
    Database.fetchItems = () => Promise.resolve([
        { id: 31, selfId: 1870, amount: 20, equipped: false },
        { id: 32, selfId: 2, amount: 1, equipped: false },
        { id: 33, selfId: 94, amount: 1, equipped: false },
        { id: 34, selfId: 94, amount: 1, equipped: false }
    ]);
    Database.transferInventoryToWarehouse = (characterId, item) => {
        calls.push({ characterId, ...item });
        return Promise.resolve({ inventoryAmount: 0, warehouseAmount: item.amount });
    };
    const state = {
        characterId: 55,
        inventory: {
            1870: material,
            1: trash,
            2: usefulGear,
            94: { selfId: 94, name: 'Bec de Corbin', amount: 2, kind: 'Weapon.Pole', rank: 'c' }
        },
        stats: {}
    };
    const result = await BotWarehouse.depositCold(state);
    assert.strictEqual(result.count, 23);
    assert.deepStrictEqual(calls.map((item) => item.selfId).sort((a, b) => a - b), [2, 94, 94, 1870]);
    assert.strictEqual(result.state.inventory['1870'].amount, 0);
    assert.strictEqual(result.state.inventory['2'].amount, 0);
    assert.strictEqual(result.state.inventory['94'].amount, 0, 'duplicate non-stackable gear must be deposited from separate item rows');
    assert.strictEqual(result.state.inventory['1'].amount, 1, 'low-level trash must remain available for NPC liquidation');
    assert.strictEqual(result.state.stats.lastWarehouseDeposit.items.length, 3);

    const liveItems = [
        { id: 41, ...material, fetchId() { return this.id; }, fetchSelfId() { return this.selfId; }, fetchName() { return this.name; }, fetchAmount() { return this.amount; }, fetchKind() { return this.kind; }, fetchRank() { return this.rank; }, fetchEquipped() { return false; }, fetchStackable() { return true; } },
        { id: 42, ...trash, fetchId() { return this.id; }, fetchSelfId() { return this.selfId; }, fetchName() { return this.name; }, fetchAmount() { return this.amount; }, fetchKind() { return this.kind; }, fetchRank() { return this.rank; }, fetchEquipped() { return false; }, fetchStackable() { return false; } }
    ];
    const liveBackpack = { items: liveItems, fetchItems() { return this.items; } };
    const live = await BotWarehouse.depositActor({
        fetchId: () => 56,
        backpack: liveBackpack
    });
    assert.strictEqual(live.count, 20, 'active bots must also deposit valuable leftovers before sell-junk');
    assert.deepStrictEqual(liveBackpack.items.map((item) => item.selfId), [1], 'only junk should remain in the active bot backpack');
    console.log('Bot warehouse checks passed');
}

run().catch((err) => {
    console.error(err);
    process.exitCode = 1;
}).finally(() => {
    Database.fetchItems = originals.fetchItems;
    Database.transferInventoryToWarehouse = originals.transferInventoryToWarehouse;
});
