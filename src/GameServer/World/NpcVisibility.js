const ServerResponse = invoke('GameServer/Network/Response');

const NPC_INFO_OPCODE = 0x16;
const DELETE_OBJECT_OPCODE = 0x12;

function objectId(packet) {
    if (!packet || packet.length < 5 || typeof packet.readInt32LE !== 'function') {
        return null;
    }

    return packet.readInt32LE(1);
}

function trackNpcPacket(session, packet) {
    const id = objectId(packet);
    if (!session || id === null) return;

    if (packet[0] === NPC_INFO_OPCODE) {
        session.knownNpcIds ||= new Set();
        session.knownNpcIds.add(id);
    }
    else if (packet[0] === DELETE_OBJECT_OPCODE) {
        session.knownNpcIds?.delete(id);
    }
}

function npcRemovalRecipients(world, sourceSession, npcId) {
    const recipients = new Set();

    if (typeof sourceSession?.dataSendToMe === 'function') {
        recipients.add(sourceSession);
    }

    (world.user?.sessions || []).forEach((session) => {
        if (
            session?.actor?.fetchIsOnline?.() === true &&
            typeof session.dataSendToMe === 'function' &&
            session.knownNpcIds?.has(npcId)
        ) {
            recipients.add(session);
        }
    });

    return recipients;
}

function deleteKnownNpc(world, sourceSession, npcId, response = ServerResponse) {
    const packet = response.deleteOb(npcId);
    const recipients = npcRemovalRecipients(world, sourceSession, npcId);
    recipients.forEach((session) => session.dataSendToMe(packet));
    return recipients.size;
}

module.exports = {
    deleteKnownNpc,
    npcRemovalRecipients,
    trackNpcPacket
};
