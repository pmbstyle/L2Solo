const SendPacket = invoke('Packet/Send');

function pledgeCrest(crestId, data) {
    const bytes = Buffer.from(data || []);
    const packet = new SendPacket(0x6c);

    packet
        .writeD(Number(crestId) || 0)
        .writeD(bytes.length)
        .writeB(bytes);

    const buffer = packet.fetchBuffer();
    if (invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics === true && process.env.L2NODE_PACKET_TRACE !== '0') buffer.__packetTrace = `crest=${Number(crestId) || 0}:bytes=${bytes.length}`;
    return buffer;
}

module.exports = pledgeCrest;
