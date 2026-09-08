const assert = require('assert');

require('../src/Global');

const SellJunk = invoke('GameServer/World/Generics/NpcBypasses/SellJunk');
const Database = invoke('Database');
const ServerResponse = invoke('GameServer/Network/Response');

function item(id, selfId, amount, price, name) {
    return {
        fetchId: () => id,
        fetchSelfId: () => selfId,
        fetchAmount: () => amount,
        fetchPrice: () => price,
        fetchName: () => name,
        fetchEquipped: () => false,
        fetchClass1: () => 4,
        fetchClass2: () => 5,
        fetchSlot: () => 0
    };
}

const junk = item(1001, 1539, 1, 223228256522, 'Corrupt-value Junk');
const questItem = { ...item(1003, 1160, 13, 0, 'Dark Bezoar'), fetchKind: () => 'Other.Quest', fetchClass2: () => 3 };
const questClassItem = { ...item(1004, 7573, 1, 0, 'Roselyn\'s Note'), fetchClass2: () => 3 };
const adenaAmount = { value: 0 };
const adena = {
    ...item(1002, 57, 0, 1, 'Adena'),
    fetchAmount: () => adenaAmount.value,
    setAmount: (value) => { adenaAmount.value = value; }
};
const packets = [];
const backpack = {
    items: [junk, adena, questItem, questClassItem],
    stackableExists: () => Promise.resolve(adena),
    fetchItems() { return this.items; }
};
const session = {
    actor: {
        fetchId: () => 42,
        backpack
    },
    dataSendToMe(packet) { packets.push(packet); }
};

const originalDelete = Database.deleteItem;
const originalUpdate = Database.updateItemAmount;
const originalUserInfo = ServerResponse.userInfo;
const originalSpeak = ServerResponse.speak;
const deleted = [];
Database.deleteItem = async (characterId, objectId) => { deleted.push(objectId); };
Database.updateItemAmount = () => Promise.resolve();
ServerResponse.userInfo = () => Buffer.from([0x04]);
ServerResponse.speak = () => Buffer.from([0x0a]);

SellJunk(session, ['sell-junk']);

setImmediate(() => {
    try {
        assert.strictEqual(adenaAmount.value, 111614128261, 'sell-junk should preserve the server-side payout');
        assert.deepStrictEqual(deleted, [1001], 'bulk sale must not delete quest items from persistence');
        assert(backpack.items.includes(questItem) && backpack.items.includes(questClassItem), 'bulk sale must retain all quest items');
        assert.strictEqual(packets[0][0], 0x1b, 'sell-junk should refresh ItemsList after the sale');
        assert.strictEqual(packets[0].readUInt32LE(15), 0xffffffff,
            'sell-junk must not crash while displaying an oversized Adena stack');
        console.log('sell-junk packet bound checks passed');
    } catch (error) {
        console.error(error);
        process.exitCode = 1;
    } finally {
        Database.deleteItem = originalDelete;
        Database.updateItemAmount = originalUpdate;
        ServerResponse.userInfo = originalUserInfo;
        ServerResponse.speak = originalSpeak;
    }
});
