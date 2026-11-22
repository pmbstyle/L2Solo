const assert = require('assert');
require('../src/Global');
const Limits = invoke('GameServer/PrivateStoreLimits');
const Response = invoke('GameServer/Network/Response');
const Store = invoke('GameServer/PrivateStore');
const sellRequest = invoke('GameServer/Network/Request/PrivateStoreListSell');
const buyRequest = invoke('GameServer/Network/Request/PrivateStoreListBuy');
const Send = invoke('Packet/Send');
const DataCache = invoke('GameServer/DataCache');

const originalItems = DataCache.items;
const referenceItem = { fetchId: () => 1, fetchSelfId: () => 700001, fetchPrice: () => 55,
    isWearable: () => false, fetchClass2: () => 0 };
const referencePacket = () => Response.privateStoreListBuy({ fetchId: () => 2 },
    [{ item: referenceItem, amount: 1, price: 2 }], 20);
try {
    DataCache.items = undefined;
    assert.strictEqual(referencePacket().readInt32LE(27), 55, 'an absent optional catalog keeps the item-price fallback');
    DataCache.items = [{ selfId: 700001, template: { price: 10 } }, { selfId: '700001', template: { price: 99 } }];
    assert.strictEqual(referencePacket().readInt32LE(27), 10, 'reference prices keep numeric FIRST');
    DataCache.items = [null];
    assert.throws(referencePacket, TypeError, 'malformed optional catalog rows retain find errors');
    DataCache.items = Array(1);
    assert.throws(referencePacket, TypeError, 'the optional numeric find still visits sparse holes');
} finally {
    DataCache.items = originalItems;
}

// A bot's race is its class's (the class templates).
DataCache.init();
for (const [race, sell, buy] of [[0, 3, 4], [1, 3, 4], [2, 3, 4], [3, 3, 4], [4, 4, 5]]) {
    for (const level of [0, 3, 8]) {
        const actor = { fetchRace: () => race, fetchId: () => 1, fetchName: () => 'Trader',
            skillset: { fetchSkill: id => id === 1370 ? { fetchLevel: () => level } : null } };
        assert.strictEqual(Limits.forActor(actor, 1), sell + level);
        assert.strictEqual(Limits.forActor(actor, 3), buy + level);
        const packet = Response.exStorageMaxCount(actor);
        assert.strictEqual(packet.length, 40, '31-byte payload uses the standard transport padding');
        assert.strictEqual(packet[0], 0xfe);
        assert.strictEqual(packet.readUInt16LE(1), 0x2e);
        assert.strictEqual(packet.readInt32LE(15), sell + level);
        assert.strictEqual(packet.readInt32LE(19), buy + level);
        for (const [type, limit, request, name] of [[1, sell + level, sellRequest, 'publishSell'], [3, buy + level, buyRequest, 'publishBuy']]) {
            let published = 0;
            const original = Store[name];
            Store[name] = () => { published += 1; return true; };
            try {
                const sent = [];
                const session = { actor, dataSendToMe: packet => sent.push(packet) };
                for (const count of [limit, limit + 1]) {
                    const requestPacket = new Send(type === 1 ? 0x9f : 0xb2);
                    if (type === 1) requestPacket.writeD(0);
                    requestPacket.writeD(count);
                    for (let row = 0; row < count; row += 1) {
                        requestPacket.writeD(100 + row);
                        if (type === 3) requestPacket.writeH(0).writeH(0);
                        requestPacket.writeD(1).writeD(1);
                    }
                    request(session, requestPacket.fetchBuffer());
                }
                assert.strictEqual(published, 1, 'only the allowed row count reaches publishing');
                const notice = sent.find(packet => packet[0] === 0x64);
                assert(notice, 'overflow sends a system message');
                assert.strictEqual(notice.readInt32LE(1), 614);
                assert.strictEqual(notice.readInt32LE(5), 1);
                assert.strictEqual(notice.readInt32LE(9), 0);
                assert(notice.toString('utf16le', 13).includes(`1 to ${limit} item slots.`));
                assert(!sent.some(packet => packet[0] === 0x4a), 'overflow does not send overhead speech');
            } finally { Store[name] = original; }
        }
        // A bot's shop holds the same lines, read from its state: its class's race and
        // the Expand Trade level its kit learned.
        const classId = { 0: 0, 1: 18, 2: 31, 3: 44, 4: 53 }[race];
        const bot = { characterId: 9000 + race, level: 40, stats: { classId,
            coldCombat: { skillSource: 'database', skills: level ? [{ selfId: 1370, level }] : [] } } };
        assert.strictEqual(Limits.forState(bot, 1), sell + level, `a bot of race ${race} sells on the player's lines`);
        assert.strictEqual(Limits.forState(bot, 3), buy + level, `a bot of race ${race} buys on the player's lines`);
    }
}
console.log('Private store limit and packet checks passed');
