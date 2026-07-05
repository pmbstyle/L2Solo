const SendPacket = invoke('Packet/Send');

function pledgeInfo(clan) {
    const packet = new SendPacket(0x83);

    packet
        .writeD(Number(clan?.id || 0))
        .writeS(String(clan?.name || ''))
        .writeS(String(clan?.allyName || ''));

    const buffer = packet.fetchBuffer();
    buffer.__packetTrace = `clan=${Number(clan?.id || 0)}:${String(clan?.name || '')}`;
    return buffer;
}

module.exports = pledgeInfo;
