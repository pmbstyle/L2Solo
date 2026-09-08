const SendPacket = invoke('Packet/Send');

function addShortcut(data) {
    const packet = new SendPacket(0x44);

    packet
        .writeD(data.kind)
        .writeD(data.slot)
        .writeD(data.id);

    if (data.kind === 2) packet.writeD(data.level);
    packet.writeD(data.unknown);

    return packet.fetchBuffer();
}

module.exports = addShortcut;
