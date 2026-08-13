const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const Database = invoke('Database');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const BotWarehouse = invoke('GameServer/Bot/Economy/BotWarehouseService');
const TradeService = invoke('GameServer/Bot/TradeService');
const SellJunk = invoke('GameServer/World/Generics/NpcBypasses/SellJunk');
const ServerResponse = invoke('GameServer/Network/Response');

DataCache.init();

const originals = {
    fetchItems: Database.fetchItems,
    transferInventoryToWarehouse: Database.transferInventoryToWarehouse,
    deleteItem: Database.deleteItem,
    updateItemAmount: Database.updateItemAmount,
    itemsList: ServerResponse.itemsList,
    userInfo: ServerResponse.userInfo,
    speak: ServerResponse.speak
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

    const liveItem = (id, item, equipped = false) => ({
        id,
        ...item,
        equipped,
        fetchId() { return this.id; },
        fetchSelfId() { return this.selfId; },
        fetchName() { return this.name; },
        fetchAmount() { return this.amount; },
        fetchKind() { return this.kind; },
        fetchRank() { return this.rank; },
        fetchEquipped() { return this.equipped; },
        fetchStackable() { return this.stackable; }
    });
    const saber = { selfId: 123, name: 'Saber', amount: 1, kind: 'Weapon.Sword', rank: 'd', stackable: false };
    const liveItems = [
        liveItem(41, { ...material, stackable: true }),
        liveItem(42, { ...trash, stackable: false }),
        liveItem(43, saber, true),
        liveItem(44, saber),
        liveItem(45, saber)
    ];
    const liveBackpack = { items: liveItems, fetchItems() { return this.items; } };
    const liveState = {
        stats: {
            equipmentPlan: {
                status: 'ready_to_craft',
                strategy: 'craft',
                combine: { requirements: [{ selfId: 123, amount: 2 }] }
            }
        }
    };
    const liveActor = {
        fetchId: () => 56,
        backpack: liveBackpack
    };
    const preview = TradeService.previewSaleToStore(liveActor, {
        storeType: 3,
        items: [{ selfId: 123, count: 3, price: 1000 }]
    }, { state: liveState });
    assert.strictEqual(preview.itemCount, 1, 'hot private-store sales must expose only swords beyond the active combination reserve');

    const live = await BotWarehouse.depositActor(liveActor, liveState);
    assert.strictEqual(live.count, 21, 'active bots must deposit ordinary leftovers and only surplus combination components');
    assert.deepStrictEqual(liveBackpack.items.map((item) => item.selfId), [1, 123, 123],
        'the equipped and reserved source swords must survive hot warehouse handling');

    const adena = liveItem(50, { selfId: 57, name: 'Adena', amount: 100, stackable: true });
    adena.setAmount = (amount) => { adena.amount = amount; };
    const junkBackpack = {
        items: [
            liveItem(51, { ...trash, stackable: false, fetchPrice: () => 10 }),
            liveItem(52, saber, true),
            liveItem(53, saber),
            adena
        ],
        fetchItems() { return this.items; },
        stackableExists: () => Promise.resolve(adena)
    };
    Database.deleteItem = () => Promise.resolve();
    Database.updateItemAmount = () => Promise.resolve();
    ServerResponse.itemsList = ServerResponse.userInfo = ServerResponse.speak = () => Buffer.alloc(0);
    SellJunk({
        actor: { fetchId: () => 57, backpack: junkBackpack },
        coldLifeState: liveState,
        dataSendToMe() {}
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepStrictEqual(junkBackpack.items.map((item) => item.id), [52, 53, 50],
        'sell-junk must remove only sold object rows and retain the reserved source sword');
    console.log('Bot warehouse checks passed');
}

run().catch((err) => {
    console.error(err);
    process.exitCode = 1;
}).finally(() => {
    Database.fetchItems = originals.fetchItems;
    Database.transferInventoryToWarehouse = originals.transferInventoryToWarehouse;
    Database.deleteItem = originals.deleteItem;
    Database.updateItemAmount = originals.updateItemAmount;
    ServerResponse.itemsList = originals.itemsList;
    ServerResponse.userInfo = originals.userInfo;
    ServerResponse.speak = originals.speak;
});
