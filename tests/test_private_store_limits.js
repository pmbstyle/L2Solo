const assert = require('assert');
require('../src/Global');
const Limits = invoke('GameServer/PrivateStoreLimits');
const Response = invoke('GameServer/Network/Response');
const Store = invoke('GameServer/PrivateStore');
const sellRequest = invoke('GameServer/Network/Request/PrivateStoreListSell');
const buyRequest = invoke('GameServer/Network/Request/PrivateStoreListBuy');
const Send = invoke('Packet/Send');

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
    }
}
console.log('Private store limit and packet checks passed');
