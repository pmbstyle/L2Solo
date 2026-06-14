const SendPacket = invoke('Packet/Send');

function tradeDone(result) {
    const packet = new SendPacket(0x22);

    packet.writeD(result ? 1 : 0);
    return packet.fetchBuffer();
}

module.exports = tradeDone;
