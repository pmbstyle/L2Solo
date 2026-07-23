const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const BuyShop = invoke('GameServer/World/Generics/NpcBypasses/BuyShop');
const NpcShopBuyLists = invoke('GameServer/World/Generics/NpcShopBuyLists');
const MerchantStoreConfigs = invoke('GameServer/Bot/MerchantStoreConfigs');
const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');

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

const shotStores = [
    ['Tia', 'Talking Island', 0], ['Elya', 'Elven Village', 0], ['Dena', 'Dark Elven Village', 0],
    ['Orik', 'Orc Village', 0], ['Bran', 'Dwarven Village', 0], ['Rolf', 'Gludin', 1],
    ['Sila', 'Gludio', 1], ['Tara', 'Dion', 1], ['Eris', 'Giran', 2], ['Sera', 'Oren', 3],
    ['Nora', "Hunter's Village", 3], ['Lina', 'Heine', 3], ['Mila', 'Aden', 4],
    ['Sven', 'Goddard', 5], ['Runa', 'Rune', 5]
];
const shotIdsByGrade = [
    [1835, 2509, 3947], [1463, 2510, 3948], [1464, 2511, 3949],
    [1465, 2512, 3950], [1466, 2513, 3951], [1467, 2514, 3952]
];
for (const [name, town, grade] of shotStores) {
    const store = MerchantStoreConfigs[name];
    assert.ok(store, `${town} must have a dedicated shot merchant`);
    assert.strictEqual(store.storeType, 1, `${name} must be a selling private store`);
    assert.strictEqual(store.town, town, `${name} must be placed in ${town}`);
    assert.deepStrictEqual(store.items.map((item) => item.selfId), shotIdsByGrade[grade], `${name} must stock every shot type at its town grade only`);
    store.items.forEach((item) => {
        assert.strictEqual(item.priceRate, 1, `${name} must use the standard shot price`);
        assert.strictEqual(item.count, 999999, `${name} must have a practical unlimited shot stock`);
    });
}

assert(Math.hypot(MerchantStoreConfigs.Rolf.locX + 80826, MerchantStoreConfigs.Rolf.locY - 149775) < 1000,
    'Gludin shot merchant must be placed inside the town square');

// These stalls were captured beside each town's gatekeeper and checked against
// the loaded geodata. Keeping the Z value on the actual floor prevents private
// stores from being hidden in a building or on another vertical layer.
const accessibleStalls = [
    'Elya', 'Dena', 'Orik', 'Bran', 'Iris', 'Helga', 'Oskar', 'Selin', 'Sera', 'Nora', 'Mila'
];
for (const name of accessibleStalls) {
    const store = MerchantStoreConfigs[name];
    const ground = GeodataEngine.getHeight(store.locX, store.locY, store.locZ);
    assert.strictEqual(store.locZ, ground, `${name} must stand on the visible geodata floor`);
}
