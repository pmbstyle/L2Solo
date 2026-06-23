const SendPacket = invoke('Packet/Send');

function askForTeamUp(name, distribution) {
    const packet = new SendPacket(0x39);

    packet
        .writeS(name)
        .writeD(distribution);

    return packet.fetchBuffer();
}

module.exports = askForTeamUp;
