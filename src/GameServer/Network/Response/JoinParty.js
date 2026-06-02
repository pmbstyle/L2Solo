const SendPacket = invoke('Packet/Send');

function joinParty(response) {
    const packet = new SendPacket(0x3a);

    packet
        .writeD(response); // 1 = success, 0 = fail

    return packet.fetchBuffer();
}

module.exports = joinParty;
