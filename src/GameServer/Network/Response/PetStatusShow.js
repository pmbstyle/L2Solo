const SendPacket = invoke('Packet/Send');

function petStatusShow(summonType = 1) {
    const packet = new SendPacket(0xb0);

    packet.writeD(summonType);

    return packet.fetchBuffer();
}

module.exports = petStatusShow;
