const SendPacket = invoke('Packet/Send');

function stopMove(id, data) {
    const packet = new SendPacket(0x47);

    packet
        .writeD(id)
        .writeD(data.locX)
        .writeD(data.locY)
        .writeD(data.locZ)
        .writeD(data.head);

    const buffer = packet.fetchBuffer();
    buffer.__packetTrace = `actor=${id}:at=${data.locX},${data.locY},${data.locZ}:head=${data.head}`;
    return buffer;
}

module.exports = stopMove;
