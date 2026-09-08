const assert = require('assert');
require('../src/Global');
const Database = invoke('Database');
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const Response = invoke('GameServer/Network/Response');

(async () => {
    const sent = [];
    const session = { accountId: 'player', actor: { fetchId: () => 123, fetchLocX: () => 0, fetchLocY: () => 0 }, dataSendToMe: packet => sent.push(packet) };
    const savedFetch = Database.fetchAfkTradeNotifications;
    const savedMark = Database.markAfkTradeNotificationsDelivered;
    let pending = [
        { id: 1, kind: 'sale', itemName: 'Varnish', amount: 2, totalPrice: 22 },
        { id: 2, kind: 'purchase', itemName: 'Iron Ore', amount: 3, totalPrice: 15 }
    ];
    Database.fetchAfkTradeNotifications = async () => pending;
    Database.markAfkTradeNotificationsDelivered = async (ownerId, ids) => {
        assert.strictEqual(ownerId, 123);
        assert.deepStrictEqual(ids, [1, 2]);
        pending = [];
    };
    try {
        assert.strictEqual(await AfkTrade.deliverNotifications(session), 2);
        assert.deepStrictEqual(sent.map(packet => packet[0]), [0x64, 0x64, 0x98]);
        assert(sent[0].toString('utf16le', 13).includes('[AFK SALE] Sold 2x Varnish for 22 Adena.'));
        assert(sent[1].toString('utf16le', 13).includes('[AFK BUY] Bought 3x Iron Ore for 15 Adena.'));
        assert(sent[2].toString('utf16le', 5).includes('ItemSound.quest_itemget'));
        sent.length = 0;
        assert.strictEqual(await AfkTrade.deliverNotifications(session), 0);
        assert.deepStrictEqual(sent, [], 'already delivered backlog produces neither messages nor sounds');
        assert.strictEqual(await AfkTrade.begin(session, AfkTrade.SELL), false);
        assert.deepStrictEqual(sent.map(packet => packet[0]), [0x64], 'command rejection is a silent system notice');
        assert(sent[0].toString('utf16le', 13).includes('peace zone'));
    } finally {
        Database.fetchAfkTradeNotifications = savedFetch;
        Database.markAfkTradeNotificationsDelivered = savedMark;
    }
    const plain = Response.systemMessage(10);
    assert.strictEqual(plain.readInt32LE(1), 10);
    assert.strictEqual(plain.readInt32LE(5), 0, 'existing no-argument system messages keep their layout');
    console.log('AFK trade notification checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
