const SendPacket = invoke('Packet/Send');

function moveToPawn(src, dst, distance) {
    const packet = new SendPacket(0x60);

    packet
        .writeD(src.fetchId())
        .writeD(dst.fetchId())
        .writeD(distance)
        .writeD(src.fetchLocX())
        .writeD(src.fetchLocY())
        .writeD(src.fetchLocZ())
        .writeD(dst.fetchLocX())
        .writeD(dst.fetchLocY())
        .writeD(dst.fetchLocZ());

    return packet.fetchBuffer();
}

module.exports = moveToPawn;
