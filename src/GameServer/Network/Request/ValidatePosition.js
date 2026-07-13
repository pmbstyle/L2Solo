const ReceivePacket = invoke('Packet/Receive');
const EffectRestrictions = invoke('GameServer/Effects/EffectRestrictions');

function validatePosition(session, buffer) {
    const packet = new ReceivePacket(buffer);

    packet
        .readD()  // X
        .readD()  // Y
        .readD()  // Z
        .readD()  // Head
        .readD(); // Vehicle Id

    return consume(session, {
        locX: packet.data[0],
        locY: packet.data[1],
        locZ: packet.data[2],
        head: packet.data[3],
    });
}

function consume(session, data) {
    if (!EffectRestrictions.canMove(session.actor)) {
        EffectRestrictions.stopMovement(session, session.actor);
        EffectRestrictions.reject(session);
        return false;
    }
    session.actor.updatePosition(data);
    return true;
}

module.exports = validatePosition;
