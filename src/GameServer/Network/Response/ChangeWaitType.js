const SendPacket = invoke('Packet/Send');

function changeWaitType(actor, waitType) {
    const packet = new SendPacket(0x2f);

    packet
        .writeD(actor.fetchId())
        .writeD(waitType)
        .writeD(actor.fetchLocX())
        .writeD(actor.fetchLocY())
        .writeD(actor.fetchLocZ());

    return packet.fetchBuffer();
}

module.exports = changeWaitType;
