const SendPacket = invoke('Packet/Send');

function showCalculator(selfId) {
    const packet = new SendPacket(0xdc);

    packet
        .writeD(selfId);

    return packet.fetchBuffer();
}

module.exports = showCalculator;
