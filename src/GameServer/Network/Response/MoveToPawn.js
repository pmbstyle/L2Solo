const SendPacket = invoke('Packet/Send');

function moveToPawn(src, dst, distance, from = null) {
    const packet = new SendPacket(0x60);

    packet
        .writeD(src.fetchId())
        .writeD(dst.fetchId())
        .writeD(distance)
        .writeD(from?.locX ?? src.fetchLocX())
        .writeD(from?.locY ?? src.fetchLocY())
        .writeD(from?.locZ ?? src.fetchLocZ())
        .writeD(dst.fetchLocX())
        .writeD(dst.fetchLocY())
        .writeD(dst.fetchLocZ());

    const buffer = packet.fetchBuffer();
    if (typeof src.fetchClassId === 'function') buffer.__movingActor = src;
    return buffer;
}

module.exports = moveToPawn;
