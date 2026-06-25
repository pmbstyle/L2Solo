const assert = require('assert');

require('../src/Global');

const BotAI = invoke('GameServer/Bot/BotAI');
const BotChatText = invoke('GameServer/Bot/AI/BotChatText');
const ReceivePacket = invoke('Packet/Receive');

function actor(name, id = 2000001) {
    return {
        fetchId: () => id,
        fetchName: () => name
    };
}

function speakText(buffer) {
    const packet = new ReceivePacket(buffer);
    packet
        .readD()
        .readD()
        .readS()
        .readS();
    return {
        actorId: packet.data[0],
        kind: packet.data[1],
        name: packet.data[2],
        text: packet.data[3]
    };
}

const equipmentReply = 'I have a Staff of Sentinel, Feriotic Tunic, Feriotic Stockings, Leather Cap, Short Gloves, Cotton Shoes, two Earrings of Strength, a Necklace of Knowledge, and two Rings of Anguish.';
const chunks = BotChatText.splitForTell(equipmentReply);

assert.ok(chunks.length > 1, 'long equipment replies should be split into multiple chat lines');
assert.ok(chunks.length <= BotChatText.DEFAULT_MAX_LINES, 'chat splitter should cap line count');
assert.ok(chunks.every((line) => line.length <= BotChatText.DEFAULT_LINE_LIMIT), 'each chat line should fit the safe tell limit');
assert.ok(!chunks.some((line) => /\bof$/.test(line)), 'chat splitter should avoid awkward mid-item breaks when punctuation is available');

const sourceSession = {
    actor: actor('Merek', 2000002)
};
const targetSession = {
    packets: [],
    dataSendToMe(packet) {
        this.packets.push(packet);
    }
};

BotAI.tell(sourceSession, targetSession, equipmentReply);

assert.strictEqual(targetSession.packets.length, chunks.length, 'BotAI.tell should send one packet per split line');
const decoded = targetSession.packets.map(speakText);
assert.ok(decoded.every((packet) => packet.kind === 2), 'split bot replies should remain private tells');
assert.ok(decoded.every((packet) => packet.name === 'Merek'), 'split bot replies should preserve the bot speaker name');
assert.deepStrictEqual(decoded.map((packet) => packet.text), chunks);

console.log('Bot chat text checks passed');
