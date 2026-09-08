const SendPacket = invoke('Packet/Send');

// C4 SystemMessage packet (opcode 0x64).
function systemMessage(id) {
    const packet = new SendPacket(0x64)
        .writeD(Number(id) || 0)
        .writeD(0);
    return packet.fetchBuffer();
}

// Lisvus SystemMessage.sendString: S1_S2 (614), one TYPE_TEXT (0) argument.
systemMessage.text = function text(message) {
    return new SendPacket(0x64).writeD(614).writeD(1)
        .writeD(0).writeS(String(message)).fetchBuffer();
};

module.exports = systemMessage;
