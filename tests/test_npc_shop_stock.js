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
    ['Talking Island', 0], ['Elven Village', 0], ['Dark Elven Village', 0],
    ['Orc Village', 0], ['Dwarven Village', 0], ['Gludin', 1],
    ['Gludio', 1], ['Dion', 1], ['Giran', 2], ['Oren', 3],
    ["Hunter's Village", 3], ['Heine', 3], ['Aden', 4],
    ['Goddard', 5], ['Rune', 5]
];
const shotIdsByGrade = [
    [1835, 2509, 3947], [1463, 2510, 3948], [1464, 2511, 3949],
    [1465, 2512, 3950], [1466, 2513, 3951], [1467, 2514, 3952]
];
const shotStoreFor = (town, grade) => {
    const expectedIds = shotIdsByGrade[grade];
    const matches = Object.values(MerchantStoreConfigs).filter((store) =>
        store.town === town
        && store.storeType === 1
        && store.items.length === expectedIds.length
        && store.items.every((item, index) => item.selfId === expectedIds[index])
    );
    assert.strictEqual(matches.length, 1, `${town} must have one dedicated shot merchant`);
    return matches[0];
};

for (const [town, grade] of shotStores) {
    const store = shotStoreFor(town, grade);
    assert.deepStrictEqual(store.items.map((item) => item.selfId), shotIdsByGrade[grade], `${town} must stock every shot type at its town grade only`);
    store.items.forEach((item) => {
        assert.strictEqual(item.priceRate, 1, `${town} must use the standard shot price`);
        assert.strictEqual(item.count, 999999, `${town} must have a practical unlimited shot stock`);
    });
}

const gludinShotStore = shotStoreFor('Gludin', 1);
assert(Math.hypot(gludinShotStore.locX + 80826, gludinShotStore.locY - 149775) < 1000,
    'Gludin shot merchant must be placed inside the town square');

const accessibleShotTowns = [
    'Elven Village', 'Dark Elven Village', 'Orc Village', 'Dwarven Village',
    'Oren', "Hunter's Village", 'Aden'
];
for (const town of accessibleShotTowns) {
    const grade = shotStores.find(([storeTown]) => storeTown === town)[1];
    const store = shotStoreFor(town, grade);
    const ground = GeodataEngine.getHeight(store.locX, store.locY, store.locZ);
    assert.strictEqual(store.locZ, ground, `${town} shot merchant must stand on the visible geodata floor`);
}