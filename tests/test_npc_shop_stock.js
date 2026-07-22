const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const BuyShop = invoke('GameServer/World/Generics/NpcBypasses/BuyShop');
const NpcShopBuyLists = invoke('GameServer/World/Generics/NpcShopBuyLists');

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

const spiritshotsThrough = {
    starter: [2509, 2510, 2511, 2512, 2513, 2514],
    d: [2509, 2510],
    c: [2509, 2510, 2511],
    b: [2509, 2510, 2511, 2512],
    a: [2509, 2510, 2511, 2512, 2513],
    s: [2509, 2510, 2511, 2512, 2513, 2514]
};
const shopSpiritshots = (npcId) => NpcShopBuyLists.fetchForNpc(npcId)
    .map((entry) => entry.selfId)
    .filter((selfId) => selfId >= 2509 && selfId <= 2514);

for (const npcId of [7004, 7137, 7150, 7519, 7561]) {
    assert.deepStrictEqual(shopSpiritshots(npcId), spiritshotsThrough.starter, `starter merchant ${npcId} must stock every Spiritshot grade`);
}
for (const npcId of [7063, 7254, 7315]) {
    assert.deepStrictEqual(shopSpiritshots(npcId), spiritshotsThrough.d, `D-grade city merchant ${npcId} must stock Spiritshot D`);
}
const laraRows = NpcShopBuyLists.fetchForNpc(7063).map((entry) => entry.selfId);
assert.strictEqual(laraRows.indexOf(2510), laraRows.indexOf(3947) + 1,
    'D Spiritshot must appear immediately after the no-grade shot rows, before ordinary supplies');
assert.deepStrictEqual(shopSpiritshots(7081), spiritshotsThrough.c, 'Giran must stock Spiritshot C');
for (const npcId of [7180, 7301, 7834]) {
    assert.deepStrictEqual(shopSpiritshots(npcId), spiritshotsThrough.b, `B-grade city merchant ${npcId} must stock Spiritshot B`);
}
assert.deepStrictEqual(shopSpiritshots(7839), spiritshotsThrough.a, 'Aden must stock Spiritshot A');
for (const npcId of [8256, 8300]) {
    assert.deepStrictEqual(shopSpiritshots(npcId), spiritshotsThrough.s, `late-town merchant ${npcId} must stock Spiritshot S`);
}
