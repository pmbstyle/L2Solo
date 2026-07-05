const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const BuyShop = invoke('GameServer/World/Generics/NpcBypasses/BuyShop');

DataCache.items = require('../data/Items/Others/others.json');

let buyListPacket = null;
const session = {
    activeNpcTalk: { selfId: 7004 },
    actor: {
        backpack: {
            fetchTotalAdena: () => 100000
        }
    },
    dataSendToMe(packet) {
        buyListPacket = packet;
    }
};

BuyShop(session, ['buy-shop', 'npc']);

assert.ok(buyListPacket, 'NPC shop should send a BuyList packet');
assert.strictEqual(buyListPacket[0], 0x11, 'NPC shop should send the C4 BuyList opcode');

const rowSize = 32;
const rowCount = buyListPacket.readInt16LE(9);
const rows = new Map();

for (let i = 0; i < rowCount; i++) {
    const offset = 11 + (i * rowSize);
    rows.set(buyListPacket.readInt32LE(offset + 6), {
        amount: buyListPacket.readInt32LE(offset + 10),
        price: buyListPacket.readInt32LE(offset + 28)
    });
}

assert.strictEqual(rows.get(1835).amount, 0, 'NPC Soulshot stock should be unlimited in BuyList');
assert.strictEqual(rows.get(2509).amount, 0, 'NPC Spiritshot stock should be unlimited in BuyList');
assert.strictEqual(rows.get(17).amount, 0, 'NPC arrow stock should be unlimited in BuyList');
assert.strictEqual(rows.get(1060).amount, 0, 'NPC scroll stock should be unlimited in BuyList');
assert.strictEqual(rows.get(1835).price, 8, 'NPC shop should preserve audited per-NPC prices');
