const assert = require('assert');

require('../src/Global');

const SellShop = invoke('GameServer/World/Generics/NpcBypasses/SellShop');
const Sell = invoke('GameServer/Network/Request/Sell');
const Database = invoke('Database');
const ServerResponse = invoke('GameServer/Network/Response');

function item(id, selfId, amount, price, equipped = false) {
    return {
        fetchId: () => id,
        fetchSelfId: () => selfId,
        fetchAmount: () => amount,
        fetchPrice: () => price,
        fetchEquipped: () => equipped,
        fetchClass1: () => 4,
        fetchClass2: () => 5,
        isWearable: () => false
    };
}

const sellable = item(1001, 1539, 12, 40);
const equipped = item(1002, 17, 100, 10, true);
const adena = item(1003, 57, 500, 1);
const packets = [];
const session = {
    activeNpcTalk: { selfId: 7004 },
    actor: {
        backpack: {
            fetchItems: () => [sellable, equipped, adena],
            fetchTotalAdena: () => 500
        }
    },
    dataSendToMe(packet) {
        packets.push(packet);
    }
};

SellShop(session, ['sell-shop']);

assert.strictEqual(packets[0][0], 0x10, 'city merchant sale should open the native C4 SellList window');
assert.strictEqual(packets[1][0], 0x25, 'SellList should terminate the NPC interaction after opening');
assert.strictEqual(packets[0].readInt16LE(9), 1, 'SellList should only offer unequipped non-Adena items');
assert.strictEqual(packets[0].readInt32LE(17), 1539, 'SellList should identify the offered inventory item');
assert.strictEqual(packets[0].readInt32LE(39), 20, 'SellList should show the C4 half-reference sell price');
assert.strictEqual(session.activeNpcSellShop.items.get(1001).price, 20, 'server should retain the offered item and price for request validation');

const amount = { value: 12 };
const adenaAmount = { value: 500 };
const mutableItem = {
    ...item(1001, 1539, amount.value, 40),
    fetchAmount: () => amount.value,
    setAmount: (value) => { amount.value = value; }
};
const mutableAdena = {
    ...item(1003, 57, adenaAmount.value, 1),
    fetchAmount: () => adenaAmount.value,
    setAmount: (value) => { adenaAmount.value = value; }
};
const sellPackets = [];
const sellSession = {
    activeNpcSellShop: { items: new Map([[1001, { selfId: 1539, price: 20 }]]) },
    actor: {
        fetchId: () => 42,
        backpack: {
            items: [mutableItem, mutableAdena],
            fetchItems() { return this.items; },
            fetchItemFromSelfId: (selfId) => selfId === 57 ? mutableAdena : mutableItem,
            fetchTotalAdena: () => adenaAmount.value
        }
    },
    dataSendToMe(packet) { sellPackets.push(packet); }
};
const originalUpdate = Database.updateItemAmount;
const originalUserInfo = ServerResponse.userInfo;
const originalItemsList = ServerResponse.itemsList;
Database.updateItemAmount = () => Promise.resolve();
ServerResponse.userInfo = () => Buffer.from([0x04]);
ServerResponse.itemsList = () => Buffer.from([0x1b]);
const request = Buffer.alloc(21);
request.writeInt32LE(0, 1);
request.writeInt32LE(1, 5);
request.writeInt32LE(1001, 9);
request.writeInt32LE(1539, 13);
request.writeInt32LE(5, 17);

Sell(sellSession, request).then(() => {
    Database.updateItemAmount = originalUpdate;
    ServerResponse.userInfo = originalUserInfo;
    ServerResponse.itemsList = originalItemsList;
    assert.strictEqual(amount.value, 7, 'NPC sale should remove only the amount selected in the native window');
    assert.strictEqual(adenaAmount.value, 600, 'NPC sale should credit the advertised half-reference price');
    assert.strictEqual(sellPackets[0][0], 0x04, 'NPC sale should refresh UserInfo after the transaction');
    assert.strictEqual(sellPackets[2][0], 0x10, 'NPC sale should keep the native SellList open with the remaining items');
}).catch((error) => {
    Database.updateItemAmount = originalUpdate;
    ServerResponse.userInfo = originalUserInfo;
    ServerResponse.itemsList = originalItemsList;
    throw error;
});
