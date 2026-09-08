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
const questItem = { ...item(1004, 1160, 13, 0), fetchKind: () => 'Other.Quest' };
const questClassItem = { ...item(1005, 7573, 1, 0), fetchClass2: () => 3 };
const petLocked = { ...item(1006, 2375, 1, 100), fetchPetLocked: () => true };
const packets = [];
const session = {
    activeNpcTalk: { selfId: 7004 },
    actor: {
        backpack: {
            fetchItems: () => [sellable, equipped, adena, questItem, questClassItem, petLocked],
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
for (const protectedItem of [questItem, questClassItem, petLocked]) {
    assert(!session.activeNpcSellShop.items.has(protectedItem.fetchId()), 'protected items must not enter the server offer snapshot');
}

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
            items: [mutableItem, mutableAdena, questItem, questClassItem, petLocked],
            fetchItems() { return this.items; },
            fetchItemFromSelfId: (selfId) => selfId === 57 ? mutableAdena : mutableItem,
            fetchTotalAdena: () => adenaAmount.value
        }
    },
    dataSendToMe(packet) { sellPackets.push(packet); }
};
const originalUpdate = Database.updateItemAmount;
const originalDelete = Database.deleteItem;
const originalUserInfo = ServerResponse.userInfo;
const originalItemsList = ServerResponse.itemsList;
const writes = [];
Database.updateItemAmount = async (...args) => { writes.push(['update', ...args]); };
Database.deleteItem = async (...args) => { writes.push(['delete', ...args]); };
ServerResponse.userInfo = () => Buffer.from([0x04]);
ServerResponse.itemsList = () => Buffer.from([0x1b]);
const request = Buffer.alloc(21);
request.writeInt32LE(0, 1);
request.writeInt32LE(1, 5);
request.writeInt32LE(1001, 9);
request.writeInt32LE(1539, 13);
request.writeInt32LE(5, 17);

Sell(sellSession, request).then(async () => {
    assert.strictEqual(amount.value, 7, 'NPC sale should remove only the amount selected in the native window');
    assert.strictEqual(adenaAmount.value, 600, 'NPC sale should credit the advertised half-reference price');
    assert.strictEqual(sellPackets[0][0], 0x04, 'NPC sale should refresh UserInfo after the transaction');
    assert.strictEqual(sellPackets[2][0], 0x10, 'NPC sale should keep the native SellList open with the remaining items');
    assert.strictEqual(sellPackets[2].readInt16LE(9), 1, 'refreshed offers must still exclude quest and pet-locked items');
    for (const protectedItem of [questItem, questClassItem, petLocked]) {
        // Simulate an offer retained from before the fix, plus a forged packet.
        sellSession.activeNpcSellShop.items.set(protectedItem.fetchId(), { selfId: protectedItem.fetchSelfId(), price: 1 });
        const forged = Buffer.from(request);
        forged.writeInt32LE(protectedItem.fetchId(), 9);
        forged.writeInt32LE(protectedItem.fetchSelfId(), 13);
        forged.writeInt32LE(protectedItem.fetchAmount(), 17);
        const beforeWrites = writes.length;
        await Sell(sellSession, forged);
        assert.strictEqual(writes.length, beforeWrites, 'rejected sales must not write items or Adena');
        assert(sellSession.actor.backpack.items.includes(protectedItem), 'rejected sales must retain the inventory item');
        assert.strictEqual(adenaAmount.value, 600, 'quest items must never pay the one-Adena minimum');
        assert(!sellSession.activeNpcSellShop.items.has(protectedItem.fetchId()), 'refresh must remove a stale protected offer');
    }
    console.log('NPC sell offers, normal payout and forged quest-item sale rejection passed');
}).catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => {
    Database.updateItemAmount = originalUpdate;
    Database.deleteItem = originalDelete;
    ServerResponse.userInfo = originalUserInfo;
    ServerResponse.itemsList = originalItemsList;
});
