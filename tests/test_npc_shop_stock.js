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

assert(!rows.has(1835), 'ordinary NPC shops must not sell Soulshots');
assert(!rows.has(2509), 'ordinary NPC shops must not sell Spiritshots');
assert.strictEqual(rows.get(17).amount, 0, 'NPC arrow stock should be unlimited in BuyList');
assert.strictEqual(rows.get(1060).amount, 0, 'NPC scroll stock should be unlimited in BuyList');
assert.strictEqual(session.activeNpcShop.prices.has(1835), false, 'removed shots must not leave a purchasable price');

const shopSpiritshots = (npcId) => NpcShopBuyLists.fetchForNpc(npcId)
    .map((entry) => entry.selfId)
    .filter((selfId) => selfId >= 2509 && selfId <= 2514);

for (const npcId of [7004, 7137, 7150, 7519, 7561, 7063, 7254, 7315, 7081, 7180, 7301, 7834, 7839, 8256, 8300]) {
    assert.deepStrictEqual(shopSpiritshots(npcId), [], `ordinary NPC merchant ${npcId} must leave shot supply to crafters and static traders`);
}

const shotStores = [
    ['Pingu', 'Talking Island', 0], ['Kent8', 'Elven Village', 0], ['FakinMachine', 'Dark Elven Village', 0],
    ['Mochito', 'Orc Village', 0], ['DubDub', 'Dwarven Village', 0], ['J3dSanta', 'Gludin', 1],
    ['Musa', 'Gludio', 1], ['Reanimator', 'Dion', 1], ['Squeesh', 'Giran', 2], ['M3tLa', 'Oren', 3],
    ['Petec', "Hunter's Village", 3], ['Original91', 'Heine', 3], ['Lowfiles', 'Aden', 4],
    ['TinWh1skey', 'Goddard', 5], ['Ora', 'Rune', 5]
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

assert(Math.hypot(MerchantStoreConfigs.J3dSanta.locX + 80826, MerchantStoreConfigs.J3dSanta.locY - 149775) < 1000,
    'Gludin shot merchant must be placed inside the town square');

// These stalls were captured beside each town's gatekeeper and checked against
// the loaded geodata. Keeping the Z value on the actual floor prevents private
// stores from being hidden in a building or on another vertical layer.
const accessibleStalls = [
    'Kent8', 'FakinMachine', 'Mochito', 'DubDub', 'StayTun3d', 'BarterKing', 'Puffy', 'NastyDream', 'M3tLa', 'Petec', 'Lowfiles'
];
for (const name of accessibleStalls) {
    const store = MerchantStoreConfigs[name];
    const ground = GeodataEngine.getHeight(store.locX, store.locY, store.locZ);
    assert.strictEqual(store.locZ, ground, `${name} must stand on the visible geodata floor`);
}

// Lisvus C4 fdc7e33a shop 23 sells C/B gemstones at Helvetia; shops
// 21 (Pano), 63 (Harmony), and 65 (Hally) only sell Gemstone D.
const originalPreset = options.default.General.progressionPreset;
const originalRateEnv = process.env.L2NODE_PROGRESSION_RATE;
delete process.env.L2NODE_PROGRESSION_RATE;
try {
    for (const [preset, multiplier] of [['x1', 1], ['x10', 2]]) {
        options.default.General.progressionPreset = preset;
        const gemstonePackets = [];
        const gemstoneSession = {
            activeNpcTalk: { selfId: 7081 },
            actor: { backpack: { fetchTotalAdena: () => 100000 } },
            dataSendToMe: (packet) => gemstonePackets.push(packet)
        };
        BuyShop(gemstoneSession, ['buy-shop', 'npc']);
        const packet = gemstonePackets[0];
        const gemstoneRows = new Map();
        for (let index = 0; index < packet.readInt16LE(9); index++) {
            const offset = 11 + index * rowSize;
            gemstoneRows.set(packet.readInt32LE(offset + 6), {
                amount: packet.readInt32LE(offset + 10),
                price: packet.readInt32LE(offset + 28)
            });
        }
        for (const [selfId, price] of [[2130, 1100], [2131, 3300], [2132, 11000]]) {
            assert.deepStrictEqual(gemstoneRows.get(selfId), { amount: 0, price: price * multiplier },
                `Helvetia must advertise unlimited gemstone ${selfId} at the ${preset} price`);
            assert.strictEqual(gemstoneSession.activeNpcShop.prices.get(selfId), price * multiplier,
                'purchase authorization must use the price advertised in BuyList');
        }
    }
    for (const npcId of [7078, 7254, 7301]) {
        const gemstoneIds = NpcShopBuyLists.fetchForNpc(npcId)
            .map((row) => row.selfId).filter((id) => id >= 2130 && id <= 2134);
        assert.deepStrictEqual(gemstoneIds, [2130], `C4 merchant ${npcId} must only stock Gemstone D`);
    }
} finally {
    options.default.General.progressionPreset = originalPreset;
    if (originalRateEnv === undefined) delete process.env.L2NODE_PROGRESSION_RATE;
    else process.env.L2NODE_PROGRESSION_RATE = originalRateEnv;
}
