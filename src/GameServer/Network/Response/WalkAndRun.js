const SendPacket = invoke('Packet/Send');

function walkAndRun(creatureId, movement) {
    const packet = new SendPacket(0x2e);

    packet
        .writeD(creatureId)
        .writeD(movement)
        .writeD(0x00); // Unknown legacy tail.

    const buffer = packet.fetchBuffer();
    buffer.__packetTrace = `actor=${creatureId}:running=${movement ? 1 : 0}`;
    return buffer;
}

module.exports = walkAndRun;
