const SendPacket = invoke('Packet/Send');

function die(id, sweepable = false) {
    const packet = new SendPacket(0x06);

    packet
        .writeD(id)    // Id
        .writeD(0x01)  // Teleport
        .writeD(0x00)  // ?
        .writeD(0x00)  // Castle
        .writeD(0x00)  // HQ
        .writeD(sweepable ? 0x01 : 0x00)  // Sweepable
        .writeD(0x00); // Fixed

    return packet.fetchBuffer();
}

module.exports = die;
