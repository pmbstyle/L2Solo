const assert = require('assert');

require('../src/Global');

const NpcVisibility = invoke('GameServer/World/NpcVisibility');

function npcInfo(id) {
    const packet = Buffer.alloc(5);
    packet[0] = 0x16;
    packet.writeInt32LE(id, 1);
    return packet;
}

function session(online = true) {
    return {
        actor: { fetchIsOnline: () => online },
        sent: [],
        dataSendToMe(packet) {
            this.sent.push(packet);
            NpcVisibility.trackNpcPacket(this, packet);
        }
    };
}

const oldNpcId = 1016465;
const newNpcId = 1016466;
const killer = session();
const sawOldNpc = session();
const neverSawNpc = session();
const offlineViewer = session(false);

NpcVisibility.trackNpcPacket(sawOldNpc, npcInfo(oldNpcId));
NpcVisibility.trackNpcPacket(offlineViewer, npcInfo(oldNpcId));

const delivered = NpcVisibility.deleteKnownNpc({
    user: { sessions: [killer, sawOldNpc, neverSawNpc, offlineViewer] }
}, killer, oldNpcId, {
    deleteOb: (id) => {
        const packet = Buffer.alloc(5);
        packet[0] = 0x12;
        packet.writeInt32LE(id, 1);
        return packet;
    }
});

assert.strictEqual(delivered, 2, 'the killer and every online viewer of the old object must receive DeleteObject');
assert.strictEqual(killer.sent.length, 1, 'the killer must retain the previous direct cleanup behavior');
assert.strictEqual(sawOldNpc.sent.length, 1, 'a viewer outside the corpse radius must still lose the stale NPC object');
assert.strictEqual(neverSawNpc.sent.length, 0, 'clients that never received NpcInfo must not receive unrelated deletes');
assert.strictEqual(offlineViewer.sent.length, 0, 'offline clients must not receive packets');
assert.strictEqual(sawOldNpc.knownNpcIds.has(oldNpcId), false, 'DeleteObject must remove the stale id from the known-object set');

NpcVisibility.trackNpcPacket(sawOldNpc, npcInfo(newNpcId));
assert.strictEqual(sawOldNpc.knownNpcIds.has(newNpcId), true, 'the respawned object must be tracked under its new World ID');

console.log('NPC known-object lifecycle regression checks passed');
