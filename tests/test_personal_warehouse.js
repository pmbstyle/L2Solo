const assert = require('assert');

require('../src/Global');

const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const Item = invoke('GameServer/Item/Item');
const Warehouse = invoke('GameServer/Warehouse/PersonalWarehouse');
const World = invoke('GameServer/World/World');
const ServerResponse = invoke('GameServer/Network/Response');
const GameOpcodes = invoke('GameServer/Network/Opcodes');
const GameRequest = invoke('GameServer/Network/Request');

DataCache.items = [{
    selfId: 1000, name: 'Warehouse Test Item', kind: 'Other', stackable: true,
    class1: 4, class2: 5, mass: 1, price: 100
}];

function item(id, amount) {
    return new Item(id, { ...DataCache.items[0], amount, equipped: false, slot: 0 });
}

const packetItem = item(77, 12);
const depositList = ServerResponse.wareHouseDepositList([packetItem], 345);
const withdrawList = ServerResponse.wareHouseWithdrawalList([packetItem], 345);
assert.strictEqual(depositList[0], 0x41, 'C4 warehouse deposit list must use opcode 0x41');
assert.strictEqual(withdrawList[0], 0x42, 'C4 warehouse withdrawal list must use opcode 0x42');
assert.strictEqual(depositList.readInt16LE(1), 1, 'warehouse list must identify the private warehouse type');
assert.strictEqual(depositList.readInt32LE(3), 345, 'warehouse list must include current Adena');
assert.strictEqual(depositList.readInt32LE(11), 77, 'warehouse deposit rows must retain the inventory object id');
assert.strictEqual(GameOpcodes.table[0x31], GameRequest.warehouseDeposit, 'C4 warehouse deposit request must be wired');
assert.strictEqual(GameOpcodes.table[0x32], GameRequest.warehouseWithdraw, 'C4 warehouse withdrawal request must be wired');

const original = {
    fetchWarehouseItems: Database.fetchWarehouseItems,
    transferInventoryToWarehouse: Database.transferInventoryToWarehouse,
    transferWarehouseToInventory: Database.transferWarehouseToInventory
};

const persistedWarehouse = [];
const calls = [];
Database.fetchWarehouseItems = () => Promise.resolve(persistedWarehouse.map((row) => ({ ...row })));
Database.transferInventoryToWarehouse = (_characterId, row) => {
    calls.push('warehouse-insert');
    const saved = { ...row, id: 500 + persistedWarehouse.length };
    persistedWarehouse.push(saved);
    calls.push('inventory-delete');
    return Promise.resolve({ warehouseId: saved.id, warehouseAmount: row.amount, inventoryAmount: 0 });
};
Database.transferWarehouseToInventory = (_characterId, row) => {
    calls.push('inventory-insert');
    const source = persistedWarehouse.find((entry) => entry.id === row.id);
    persistedWarehouse.splice(persistedWarehouse.indexOf(source), 1);
    calls.push('warehouse-delete');
    return Promise.resolve({ inventoryId: 42, inventoryAmount: row.amount, warehouseAmount: 0, petData: source.petData });
};

const source = item(10, 7);
const session = {
    activeNpcTalk: { title: 'Warehouse Keeper', objectId: 7005001, selfId: 7005 },
    actor: {
        fetchId: () => 123,
        fetchLocX: () => 0,
        fetchLocY: () => 0,
        backpack: {
            items: [source],
            fetchItems() { return this.items; }
        }
    }
};

World.npc = { spawns: [] };
World.npc.spawns.push({
    fetchId: () => 7005001,
    fetchSelfId: () => 7005,
    fetchTitle: () => 'Warehouse Keeper',
    fetchLocX: () => 0,
    fetchLocY: () => 0
});

Warehouse.deposit(session, [{ objectId: 10, amount: 7 }]).then(async () => {
    assert.deepStrictEqual(calls, ['warehouse-insert', 'inventory-delete'], 'deposit must persist warehouse before removing the inventory item');
    assert.strictEqual(session.actor.backpack.items.length, 0, 'deposit should remove transferred inventory items only after persistence');
    assert.strictEqual(persistedWarehouse[0].amount, 7, 'deposit must persist the warehouse amount immediately');

    calls.length = 0;
    await Warehouse.withdraw(session, [{ objectId: 500, amount: 7 }]);
    assert.deepStrictEqual(calls, ['inventory-insert', 'warehouse-delete'], 'withdraw must persist destination inventory before deleting warehouse state');
    assert.strictEqual(persistedWarehouse.length, 0, 'withdraw must persist warehouse removal immediately');
    assert.strictEqual(session.actor.backpack.items[0].fetchAmount(), 7, 'withdraw should materialize the stored item in inventory');

    session.activeNpcTalk.objectId = 999999;
    await assert.rejects(
        Warehouse.deposit(session, [{ objectId: 42, amount: 1 }]),
        /warehouse NPC/,
        'warehouse requests must remain bound to a warehouse NPC'
    );
}).finally(() => {
    Object.assign(Database, original);
}).catch((error) => {
    Object.assign(Database, original);
    throw error;
});
