const ServerResponse = invoke('GameServer/Network/Response');
const NpcObjectIndex = require('./NpcObjectIndex');

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

function sendNpcMotionAfterInfo(session, packet) {
    if (packet?.[0] !== NPC_INFO_OPCODE || packet.length < 25
        || typeof session?.dataSendToMe !== 'function') return false;
    const npc = NpcObjectIndex.find(invoke('GameServer/World/World'), objectId(packet));
    // Only an NPC that ever moved has a walk: a resting one keeps no automation (Npc).
    const move = npc?.builtAutomation?.()?.moveInterpolation;
    if (!move || move.actor !== npc || npc.state?.fetchTowards?.() !== 'wander'
        || npc.state.fetchDead() || npc.state.fetchCombats()
        || Date.now() - move.startedAt >= move.duration) return false;

    // NpcInfo creates/refreshes the client object but carries no destination.
    // Resume the existing walk only for this recipient, after its snapshot
    // was written. Use that exact snapshot origin, not the original start or
    // a newer interpolation position. No new route, geo query or timer.
    session.dataSendToMe(ServerResponse.moveToLocation(npc.fetchId(), {
        from: { locX: packet.readInt32LE(13), locY: packet.readInt32LE(17), locZ: packet.readInt32LE(21) },
        to: move.to
    }));
    return true;
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
    recipients.forEach((session) => {
        try {
            session.dataSendToMe(packet);
        }
        catch (error) {
            utils.infoWarn('NpcVisibility', 'failed to send DeleteObject for NPC %d: %s', npcId, error.message);
        }
    });
    return recipients.size;
}

module.exports = {
    deleteKnownNpc,
    npcRemovalRecipients,
    trackNpcPacket,
    sendNpcMotionAfterInfo
};
