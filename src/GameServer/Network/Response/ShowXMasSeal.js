const SendPacket = invoke('Packet/Send');

function showXMasSeal(selfId) {
    const packet = new SendPacket(0xf2);

    packet
        .writeD(selfId);

    return packet.fetchBuffer();
}

module.exports = showXMasSeal;
