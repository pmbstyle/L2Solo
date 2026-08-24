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
const adenaAmount = { value: 0 };
const adena = {
    ...item(1002, 57, 0, 1, 'Adena'),
    fetchAmount: () => adenaAmount.value,
    setAmount: (value) => { adenaAmount.value = value; }
};
const packets = [];
const backpack = {
    items: [junk, adena],
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
Database.deleteItem = () => Promise.resolve();
Database.updateItemAmount = () => Promise.resolve();
ServerResponse.userInfo = () => Buffer.from([0x04]);
ServerResponse.speak = () => Buffer.from([0x0a]);

SellJunk(session, ['sell-junk']);

setImmediate(() => {
    try {
        assert.strictEqual(adenaAmount.value, 111614128261, 'sell-junk should preserve the server-side payout');
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
