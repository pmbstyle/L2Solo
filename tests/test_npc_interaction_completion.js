const assert = require('assert');

require('../src/Global');

const NpcTalk = invoke('GameServer/World/Generics/NpcTalk');
const NpcTalkResponse = invoke('GameServer/World/Generics/NpcTalkResponse');

const packets = [];
const session = {
    dataSendToMe(packet) {
        packets.push(packet);
    }
};
const npc = {
    fetchSelfId: () => 7004,
    fetchId: () => 123456,
    fetchName: () => 'Test Quest NPC'
};

NpcTalk(session, npc);

assert.strictEqual(packets[0][0], 0x0f, 'NPC interaction should open an HTML window');
assert.strictEqual(packets[1][0], 0x25, 'NPC interaction should terminate with ActionFailed so the selected NPC cannot leave movement blocked');

const bypassPackets = [];
NpcTalkResponse({
    dataSendToMe(packet) {
        bypassPackets.push(packet);
    }
}, { link: 'html 7004' });

assert.strictEqual(bypassPackets[0][0], 0x0f, 'NPC HTML bypass should open its requested page');
assert.strictEqual(bypassPackets[1][0], 0x25, 'NPC HTML bypass should also terminate the interaction');
