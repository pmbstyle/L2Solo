const SendPacket = invoke('Packet/Send');

function partySmallWindowDelete(memberId, name) {
    const packet = new SendPacket(0x51);

    packet
        .writeD(memberId)
        .writeS(name);

    return packet.fetchBuffer();
}

module.exports = partySmallWindowDelete;
