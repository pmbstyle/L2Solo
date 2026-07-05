const SendPacket = invoke('Packet/Send');

function managePledgePower(privileges) {
    const packet = new SendPacket(0x30);

    packet
        .writeD(0)
        .writeD(0)
        .writeD(Number(privileges) || 0);

    return packet.fetchBuffer();
}

module.exports = managePledgePower;
