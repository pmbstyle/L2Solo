const SendPacket = invoke('Packet/Send');

function askJoinPledge(requestorId, clanName) {
    const packet = new SendPacket(0x32);

    packet
        .writeD(requestorId)
        .writeS(clanName);

    return packet.fetchBuffer();
}

module.exports = askJoinPledge;
