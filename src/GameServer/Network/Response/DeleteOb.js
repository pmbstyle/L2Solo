const SendPacket = invoke('Packet/Send');

function deleteOb(id) {
    const packet = new SendPacket(0x12);

    packet
        .writeD(id)
        .writeD(0x00); // C4 DeleteObject c2 field

    return packet.fetchBuffer();
}

module.exports = deleteOb;
