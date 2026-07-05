const SendPacket = invoke('Packet/Send');

function pledgeCrest(crestId, data) {
    const bytes = Buffer.from(data || []);
    const packet = new SendPacket(0x6c);

    packet
        .writeD(Number(crestId) || 0)
        .writeD(bytes.length)
        .writeB(bytes);

    const buffer = packet.fetchBuffer();
    buffer.__packetTrace = `crest=${Number(crestId) || 0}:bytes=${bytes.length}`;
    return buffer;
}

module.exports = pledgeCrest;
