const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const BuyShop = invoke('GameServer/World/Generics/NpcBypasses/BuyShop');
const NpcShopBuyLists = invoke('GameServer/World/Generics/NpcShopBuyLists');
const MerchantStoreConfigs = invoke('GameServer/Bot/MerchantStoreConfigs');

DataCache.items = require('../data/Items/Others/others.json');

const packets = [];
const session = {
    activeNpcTalk: { selfId: 7004 },
    actor: {
        backpack: {
            fetchTotalAdena: () => 100000
        }
    },
    dataSendToMe(packet) {
        packets.push(packet);
    }
};

BuyShop(session, ['buy-shop', 'npc']);

const buyListPacket = packets[0];
assert.ok(buyListPacket, 'NPC shop should send a BuyList packet');
assert.strictEqual(buyListPacket[0], 0x11, 'NPC shop should send the C4 BuyList opcode');
assert.strictEqual(packets[1][0], 0x25, 'NPC shop should finish the interaction with ActionFailed so closing it does not block movement');

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

const shopSpiritshots = (npcId) => NpcShopBuyLists.fetchForNpc(npcId)
    .map((entry) => entry.selfId)
    .filter((selfId) => selfId >= 2509 && selfId <= 2514);

for (const npcId of [7004, 7137, 7150, 7519, 7561, 7063, 7254, 7315, 7081, 7180, 7301, 7834, 7839, 8256, 8300]) {
    assert.deepStrictEqual(shopSpiritshots(npcId), [2509], `ordinary NPC merchant ${npcId} must only retain its no-grade Spiritshot`);
}

const spiritshotStores = [
    ['Tia', 'Talking Island', 5], ['Elya', 'Elven Village', 5], ['Dena', 'Dark Elven Village', 5],
    ['Orik', 'Orc Village', 5], ['Bran', 'Dwarven Village', 5], ['Rolf', 'Gludin', 1],
    ['Sila', 'Gludio', 1], ['Tara', 'Dion', 1], ['Eris', 'Giran', 2], ['Sera', 'Oren', 3],
    ['Nora', "Hunter's Village", 3], ['Lina', 'Heine', 3], ['Mila', 'Aden', 4],
    ['Sven', 'Goddard', 5], ['Runa', 'Rune', 5]
];
const spiritshotIds = [2509, 2510, 2511, 2512, 2513, 2514];
for (const [name, town, grade] of spiritshotStores) {
    const store = MerchantStoreConfigs[name];
    assert.ok(store, `${town} must have a dedicated Spiritshot merchant`);
    assert.strictEqual(store.storeType, 1, `${name} must be a selling private store`);
    assert.strictEqual(store.town, town, `${name} must be placed in ${town}`);
    assert.deepStrictEqual(store.items.map((item) => item.selfId), spiritshotIds.slice(0, grade + 1), `${name} must stock Spiritshots through its town grade`);
    store.items.forEach((item) => {
        assert.strictEqual(item.priceRate, 1, `${name} must use the standard Spiritshot price`);
        assert.strictEqual(item.count, 999999, `${name} must have a practical unlimited Spiritshot stock`);
    });
}
