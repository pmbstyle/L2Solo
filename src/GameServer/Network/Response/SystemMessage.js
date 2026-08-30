const SendPacket = invoke('Packet/Send');

// C4 SystemMessage packet (opcode 0x64). The simple arena notices only use
// an integer message id and therefore carry no typed substitution arguments.
function systemMessage(id) {
    const packet = new SendPacket(0x64)
        .writeD(Number(id) || 0)
        .writeD(0);
    return packet.fetchBuffer();
}

module.exports = systemMessage;
