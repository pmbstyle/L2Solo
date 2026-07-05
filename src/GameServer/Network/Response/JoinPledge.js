const SendPacket = invoke('Packet/Send');

function joinPledge(clanId) {
    const packet = new SendPacket(0x33);

    packet
        .writeD(clanId);

    return packet.fetchBuffer();
}

module.exports = joinPledge;
